//! Deepgram Live streaming STT over WebSocket (#31/#32).
//!
//! This is an alternative to the batch REST pipeline (record → WAV → POST):
//! it opens a `wss://api.deepgram.com/v1/listen` connection, streams the raw
//! system-audio PCM to it continuously, and forwards interim + final
//! transcripts back to the UI as they arrive. Deepgram's server-side
//! endpointing decides turn boundaries, so the local energy VAD is NOT used in
//! this mode. With `diarize=true`, each word carries a `speaker` index, which we
//! group into per-speaker segments for the UI.
//!
//! The API key is passed in from the frontend (it lives in JS state); it is used
//! only for the WebSocket handshake and never persisted here.

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

/// Config for a Deepgram Live session, supplied by the frontend.
#[derive(Debug, Clone, Deserialize)]
pub struct DeepgramConfig {
    /// Deepgram API key (used for the handshake only, not stored).
    pub api_key: String,
    /// Model, e.g. "nova-3".
    #[serde(default = "default_model")]
    pub model: String,
    /// Language, e.g. "multi".
    #[serde(default = "default_language")]
    pub language: String,
    /// Enable speaker diarization (#32).
    #[serde(default = "default_true")]
    pub diarize: bool,
    /// Server-side endpointing silence in ms.
    #[serde(default = "default_endpointing")]
    pub endpointing: u32,
    /// Utterance-end silence in ms.
    #[serde(default = "default_utterance_end")]
    pub utterance_end_ms: u32,
}

fn default_model() -> String {
    "nova-3".to_string()
}
fn default_language() -> String {
    "multi".to_string()
}
fn default_true() -> bool {
    true
}
fn default_endpointing() -> u32 {
    300
}
fn default_utterance_end() -> u32 {
    1000
}

/// One transcript update forwarded to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct TranscriptUpdate {
    /// The full transcript text of this result.
    pub text: String,
    /// Whether Deepgram considers this result final (vs. an interim guess).
    pub is_final: bool,
    /// Per-speaker segments when diarization is on (empty otherwise).
    pub speakers: Vec<SpeakerSegment>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpeakerSegment {
    pub speaker: i64,
    pub text: String,
}

// --- Minimal deserialization of Deepgram's Results message ---

#[derive(Debug, Deserialize)]
struct DgMessage {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    is_final: Option<bool>,
    channel: Option<DgChannel>,
}

#[derive(Debug, Deserialize)]
struct DgChannel {
    alternatives: Vec<DgAlternative>,
}

#[derive(Debug, Deserialize)]
struct DgAlternative {
    #[serde(default)]
    transcript: String,
    #[serde(default)]
    words: Vec<DgWord>,
}

#[derive(Debug, Deserialize)]
struct DgWord {
    #[serde(default)]
    word: String,
    // `punctuated_word` is present when smart_format/punctuate is on; prefer it.
    punctuated_word: Option<String>,
    speaker: Option<i64>,
}

/// Build the wss URL with all query params.
fn build_url(sample_rate: u32, cfg: &DeepgramConfig) -> String {
    format!(
        "wss://api.deepgram.com/v1/listen?model={model}&language={lang}\
&encoding=linear16&sample_rate={sr}&channels=1&interim_results=true\
&punctuate=true&smart_format=true&diarize={diarize}&endpointing={ep}\
&utterance_end_ms={ue}&vad_events=true",
        model = cfg.model,
        lang = cfg.language,
        sr = sample_rate,
        diarize = cfg.diarize,
        ep = cfg.endpointing,
        ue = cfg.utterance_end_ms,
    )
}

/// Group a result's words into per-speaker segments (contiguous runs of the
/// same speaker index). Only meaningful when diarization is enabled.
fn group_speakers(words: &[DgWord]) -> Vec<SpeakerSegment> {
    let mut segments: Vec<SpeakerSegment> = Vec::new();
    for w in words {
        let Some(spk) = w.speaker else { continue };
        let token = w
            .punctuated_word
            .as_ref()
            .filter(|s| !s.is_empty())
            .unwrap_or(&w.word);
        if token.is_empty() {
            continue;
        }
        match segments.last_mut() {
            Some(last) if last.speaker == spk => {
                last.text.push(' ');
                last.text.push_str(token);
            }
            _ => segments.push(SpeakerSegment {
                speaker: spk,
                text: token.clone(),
            }),
        }
    }
    segments
}

/// Run a Deepgram Live streaming session until the audio stream ends or the
/// stop flag is set. Emits `dg-connected`, `dg-transcript`, `dg-error`,
/// `dg-closed` to the frontend.
pub async fn run_deepgram_streaming(
    app: AppHandle,
    stream: impl StreamExt<Item = f32> + Unpin + Send + 'static,
    sample_rate: u32,
    cfg: DeepgramConfig,
    stop_flag: Arc<AtomicBool>,
    // Owned by AudioState so stop_system_audio_capture can wake the child tasks
    // directly, without depending on this (abortable) parent task.
    stop_notify: Arc<Notify>,
) {
    let url = build_url(sample_rate, &cfg);

    // Build the handshake request and attach the Authorization header.
    let mut request = match url.as_str().into_client_request() {
        Ok(r) => r,
        Err(e) => {
            let _ = app.emit("dg-error", format!("Invalid Deepgram URL: {e}"));
            return;
        }
    };
    match HeaderValue::from_str(&format!("Token {}", cfg.api_key)) {
        Ok(hv) => {
            request.headers_mut().insert("Authorization", hv);
        }
        Err(_) => {
            let _ = app.emit("dg-error", "Invalid Deepgram API key");
            return;
        }
    }

    // Connect (TLS via rustls-webpki-roots).
    let ws = match tokio_tungstenite::connect_async(request).await {
        Ok((ws, _resp)) => ws,
        Err(e) => {
            let _ = app.emit("dg-error", format!("Deepgram connection failed: {e}"));
            return;
        }
    };
    let _ = app.emit("dg-connected", ());

    let (mut write, mut read) = ws.split();

    // `stop_notify` (a parameter, owned by AudioState) is `select!`ed against
    // EVERY blocking await in the child tasks, so a stop tears them down promptly
    // even if the WS sink or the channel is wedged (dead/slow TCP). Because it
    // lives in AudioState, stop_system_audio_capture can fire it directly —
    // independent of this parent task, which it aborts.

    // Channel: audio-sender task pushes PCM frames; a single writer task owns
    // the sink and also sends KeepAlive/CloseStream control messages.
    let (tx, mut rx) = mpsc::channel::<Message>(64);

    // Writer task: drains control/audio messages onto the WebSocket sink,
    // cancellable on stop.
    let writer_stop = stop_notify.clone();
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = writer_stop.notified() => break,
                maybe_msg = rx.recv() => {
                    match maybe_msg {
                        Some(msg) => {
                            // The send itself is also cancellable, so a wedged
                            // sink can't pin this task past a stop.
                            tokio::select! {
                                _ = writer_stop.notified() => break,
                                res = write.send(msg) => {
                                    if res.is_err() { break; }
                                }
                            }
                        }
                        None => break, // channel closed (all senders dropped)
                    }
                }
            }
        }
        // Best-effort graceful close.
        let _ = write
            .send(Message::Text(json!({ "type": "CloseStream" }).to_string()))
            .await;
        let _ = write.close().await;
    });
    let writer_abort = writer.abort_handle();

    // Audio producer task: pull f32 samples, batch, convert to i16 LE, send.
    // Also emits a KeepAlive when no audio has flowed for a while (silence).
    let audio_tx = tx.clone();
    let stop_for_audio = stop_flag.clone();
    let producer_stop = stop_notify.clone();
    let producer = tokio::spawn(async move {
        let mut stream = stream;
        // ~50ms of audio per frame at the given sample rate.
        let frame_samples = ((sample_rate as usize) / 20).max(256);
        let mut buf: Vec<i16> = Vec::with_capacity(frame_samples);
        // KeepAlive cadence: if we haven't sent audio in ~3s, ping.
        let mut ticks_since_audio: u32 = 0;

        // Send `msg`, but bail immediately on stop instead of blocking on a full
        // channel. Returns false if we should stop.
        macro_rules! send_or_stop {
            ($msg:expr) => {
                tokio::select! {
                    _ = producer_stop.notified() => false,
                    res = audio_tx.send($msg) => res.is_ok(),
                }
            };
        }

        loop {
            if stop_for_audio.load(Ordering::Acquire) {
                break;
            }
            // Pull with a timeout so we can send KeepAlive during long silence
            // and re-check the stop flag even if the stream stalls.
            let next = tokio::select! {
                _ = producer_stop.notified() => break,
                n = tokio::time::timeout(
                    tokio::time::Duration::from_millis(150),
                    stream.next(),
                ) => n,
            };

            match next {
                Ok(Some(sample)) => {
                    let clamped = sample.clamp(-1.0, 1.0);
                    buf.push((clamped * i16::MAX as f32) as i16);
                    if buf.len() >= frame_samples {
                        let mut bytes = Vec::with_capacity(buf.len() * 2);
                        for s in &buf {
                            bytes.extend_from_slice(&s.to_le_bytes());
                        }
                        buf.clear();
                        ticks_since_audio = 0;
                        if !send_or_stop!(Message::Binary(bytes)) {
                            break;
                        }
                    }
                }
                Ok(None) => break, // stream ended
                Err(_) => {
                    // Timeout (silence). Send KeepAlive roughly every ~3s.
                    ticks_since_audio += 1;
                    if ticks_since_audio >= 20 {
                        ticks_since_audio = 0;
                        if !send_or_stop!(Message::Text(
                            json!({ "type": "KeepAlive" }).to_string()
                        )) {
                            break;
                        }
                    }
                }
            }
        }
        // Dropping audio_tx (and the original tx below) closes the channel,
        // which ends the writer task and triggers CloseStream.
        drop(audio_tx);
    });
    let producer_abort = producer.abort_handle();

    // Drop our own tx handle so the channel closes once the producer is done.
    drop(tx);

    // Reader loop: parse server messages and forward transcripts. Uses a
    // periodic tick so we notice stop_flag even during long silences when
    // read.next() would otherwise block indefinitely.
    loop {
        let next = tokio::time::timeout(
            tokio::time::Duration::from_millis(200),
            read.next(),
        )
        .await;

        match next {
            // Timeout: no message; just re-check the stop flag below.
            Err(_) => {}
            Ok(None) => break, // socket closed
            Ok(Some(msg)) => match msg {
                Ok(Message::Text(txt)) => {
                    if let Some(update) = parse_transcript(&txt) {
                        // Skip empty interims (Deepgram sends many blank ones).
                        if !update.text.is_empty() {
                            let _ = app.emit("dg-transcript", &update);
                        }
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(e) => {
                    let _ = app.emit("dg-error", format!("Deepgram stream error: {e}"));
                    break;
                }
            },
        }

        if stop_flag.load(Ordering::Acquire) {
            break;
        }
    }

    // Tear the child tasks down. `notify_waiters` wakes them out of any
    // blocking await (channel send/recv, WS send, stream pull) immediately —
    // this, not the abort below, is what guarantees prompt teardown even when
    // the network is wedged. The AtomicBool is set too so a child parked at its
    // loop head also sees the stop. We then wait briefly for graceful CloseStream
    // and finally abort as a backstop (e.g. if our own parent is aborted before
    // reaching here, these abort handles are the last-resort cleanup).
    stop_flag.store(true, Ordering::Release);
    stop_notify.notify_waiters();
    let _ = tokio::time::timeout(tokio::time::Duration::from_millis(500), async {
        let _ = producer.await;
        let _ = writer.await;
    })
    .await;
    producer_abort.abort();
    writer_abort.abort();
    let _ = app.emit("dg-closed", ());
}

/// Parse a Deepgram `Results` text message into a TranscriptUpdate, or None if
/// it isn't a transcript-bearing message.
fn parse_transcript(txt: &str) -> Option<TranscriptUpdate> {
    let msg: DgMessage = serde_json::from_str(txt).ok()?;
    // Only Results messages carry a channel/alternatives; ignore Metadata,
    // UtteranceEnd, SpeechStarted, etc.
    if let Some(t) = &msg.msg_type {
        if t != "Results" {
            return None;
        }
    }
    let channel = msg.channel?;
    let alt = channel.alternatives.into_iter().next()?;
    let speakers = group_speakers(&alt.words);
    Some(TranscriptUpdate {
        text: alt.transcript,
        is_final: msg.is_final.unwrap_or(false),
        speakers,
    })
}
