// Pluely AI Speech Detection, and capture system audio (speaker output) as a stream of f32 samples.
use crate::speaker::{AudioDevice, SpeakerInput};
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::StreamExt;
use hound::{WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_shell::ShellExt;
use tracing::{error, warn};

// VAD Configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadConfig {
    pub enabled: bool,
    pub hop_size: usize,
    pub sensitivity_rms: f32,
    pub peak_threshold: f32,
    pub silence_chunks: usize,
    pub min_speech_chunks: usize,
    pub pre_speech_chunks: usize,
    pub noise_gate_threshold: f32,
    pub max_recording_duration_secs: u64,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            hop_size: 1024,
            sensitivity_rms: 0.012, // Much less sensitive - only real speech
            peak_threshold: 0.035,  // Higher threshold - filters clicks/noise
            silence_chunks: 45,     // ~1.0s of silence before stopping
            min_speech_chunks: 7,   // ~0.16s - captures short answers
            pre_speech_chunks: 12,  // ~0.27s - enough to catch word start
            noise_gate_threshold: 0.003, // Stronger noise filtering
            max_recording_duration_secs: 180, // 3 minutes default
        }
    }
}

/// RAII guard that unregisters a Tauri event listener when dropped.
///
/// This makes listener cleanup robust against task cancellation: when the
/// capture task is aborted at an await point, its locals (including this guard)
/// are dropped, so the listener is removed even though the explicit cleanup path
/// never runs.
struct ListenerGuard {
    app: AppHandle,
    id: Option<tauri::EventId>,
}

impl Drop for ListenerGuard {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            self.app.unlisten(id);
        }
    }
}

#[tauri::command]
pub async fn start_system_audio_capture(
    app: AppHandle,
    vad_config: Option<VadConfig>,
    device_id: Option<String>,
) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();

    // Check if already capturing (atomic check)
    {
        let guard = state
            .stream_task
            .lock()
            .map_err(|e| format!("Failed to acquire lock: {}", e))?;

        if guard.is_some() {
            warn!("Capture already running");
            return Err("Capture already running".to_string());
        }
    }

    // Update VAD config if provided
    if let Some(config) = vad_config {
        let mut vad_cfg = state
            .vad_config
            .lock()
            .map_err(|e| format!("Failed to acquire VAD config lock: {}", e))?;
        *vad_cfg = config;
    }

    let input = SpeakerInput::new_with_device(device_id).map_err(|e| {
        error!("Failed to create speaker input: {}", e);
        format!("Failed to access system audio: {}", e)
    })?;

    let stream = input.stream();
    let sr = stream.sample_rate();

    // Validate sample rate
    if !(8000..=96000).contains(&sr) {
        error!("Invalid sample rate: {}", sr);
        return Err(format!(
            "Invalid sample rate: {}. Expected 8000-96000 Hz",
            sr
        ));
    }

    let app_clone = app.clone();
    let vad_config = state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to read VAD config: {}", e))?
        .clone();

    // Mark as capturing BEFORE spawning task
    *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to set capturing state: {}", e))? = true;

    // Emit capture started event
    let _ = app_clone.emit("capture-started", sr);

    let state_clone = app.state::<crate::AudioState>();
    let task = tokio::spawn(async move {
        if vad_config.enabled {
            run_vad_capture(app_clone.clone(), stream, sr, vad_config).await;
        } else {
            run_continuous_capture(app_clone.clone(), stream, sr, vad_config).await;
        }

        let state = app_clone.state::<crate::AudioState>();
        {
            if let Ok(mut guard) = state.stream_task.lock() {
                *guard = None;
            };
        }
    });

    *state_clone
        .stream_task
        .lock()
        .map_err(|e| format!("Failed to store task: {}", e))? = Some(task);

    Ok(())
}

/// Start a Deepgram Live streaming session (#31/#32). Opens the system-audio
/// stream and pipes its PCM to Deepgram over WebSocket, forwarding interim +
/// final transcripts (with speaker labels) to the UI. Mutually exclusive with
/// the batch capture: reuses the same stream_task slot.
#[tauri::command]
pub async fn start_deepgram_streaming(
    app: AppHandle,
    config: crate::speaker::deepgram::DeepgramConfig,
    device_id: Option<String>,
) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();

    {
        let guard = state
            .stream_task
            .lock()
            .map_err(|e| format!("Failed to acquire lock: {}", e))?;
        if guard.is_some() {
            warn!("Capture already running");
            return Err("Capture already running".to_string());
        }
    }

    let input = SpeakerInput::new_with_device(device_id).map_err(|e| {
        error!("Failed to create speaker input: {}", e);
        format!("Failed to access system audio: {}", e)
    })?;
    let stream = input.stream();
    let sr = stream.sample_rate();
    if !(8000..=96000).contains(&sr) {
        return Err(format!(
            "Invalid sample rate: {}. Expected 8000-96000 Hz",
            sr
        ));
    }

    // Reset the shared stop flag/notify for this session (captures are mutually
    // exclusive, so reusing the AudioState-owned handles is safe).
    let stop_flag = state.deepgram_stop.clone();
    stop_flag.store(false, Ordering::Release);
    let stop_notify = state.deepgram_stop_notify.clone();

    *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to set capturing state: {}", e))? = true;
    let _ = app.emit("capture-started", sr);

    let app_clone = app.clone();
    let stop_for_task = stop_flag.clone();
    let notify_for_task = stop_notify.clone();
    let task = tokio::spawn(async move {
        crate::speaker::deepgram::run_deepgram_streaming(
            app_clone.clone(),
            stream,
            sr,
            config,
            stop_for_task,
            notify_for_task,
        )
        .await;

        // Clear capturing state + task slot when the session ends.
        let state = app_clone.state::<crate::AudioState>();
        {
            if let Ok(mut c) = state.is_capturing.lock() {
                *c = false;
            };
        }
        {
            if let Ok(mut guard) = state.stream_task.lock() {
                *guard = None;
            };
        }
    });

    *state
        .stream_task
        .lock()
        .map_err(|e| format!("Failed to store task: {}", e))? = Some(task);

    Ok(())
}

// VAD-enabled capture - OPTIMIZED for real-time speech detection
async fn run_vad_capture(
    app: AppHandle,
    stream: impl StreamExt<Item = f32> + Unpin,
    sr: u32,
    config: VadConfig,
) {
    let mut stream = stream;
    let mut buffer: VecDeque<f32> = VecDeque::new();
    let mut pre_speech: VecDeque<f32> =
        VecDeque::with_capacity(config.pre_speech_chunks * config.hop_size);
    let mut speech_buffer = Vec::new();
    let mut in_speech = false;
    let mut silence_chunks = 0;
    let mut speech_chunks = 0;
    let max_samples = sr as usize * 30; // 30s safety cap per utterance

    // Scratch buffer reused across chunks — cleared and refilled each iteration
    // instead of allocating a new Vec per chunk (this loop runs ~94×/s).
    let mut mono: Vec<f32> = Vec::with_capacity(config.hop_size);

    // --- Adaptive noise floor (#22) ---
    // Track the ambient RMS during non-speech and derive the speech threshold
    // relative to it, instead of only using the fixed config.sensitivity_rms.
    // The floor is seeded from the config value and updated with a slow EMA over
    // silence chunks, so a noisy room raises the bar and a quiet room lowers it.
    let mut noise_floor = config.sensitivity_rms;
    const NOISE_EMA_ALPHA: f32 = 0.02; // slow adaptation
    const NOISE_THRESHOLD_MULT: f32 = 2.5; // speech must exceed 2.5× the floor

    // --- Level metering throttle (#21) ---
    // Emit the real RMS to the UI roughly every ~100ms. hop_size samples per
    // chunk at `sr` Hz → chunk_ms; emit every N chunks.
    let chunk_ms = (config.hop_size as f32 / sr as f32) * 1000.0;
    let level_emit_every = ((100.0 / chunk_ms).round() as usize).max(1);
    let mut chunk_counter: usize = 0;

    while let Some(sample) = stream.next().await {
        buffer.push_back(sample);

        // Process in fixed chunks for VAD analysis
        while buffer.len() >= config.hop_size {
            mono.clear();
            for _ in 0..config.hop_size {
                if let Some(v) = buffer.pop_front() {
                    mono.push(v);
                }
            }

            // Apply noise gate BEFORE VAD (critical for accuracy), in place.
            apply_noise_gate_in_place(&mut mono, config.noise_gate_threshold);

            let (rms, peak) = calculate_audio_metrics(&mono);

            // Effective threshold is the stricter of the configured sensitivity
            // and the adaptive noise floor, so ambient noise can only raise it.
            let adaptive_rms_threshold =
                config.sensitivity_rms.max(noise_floor * NOISE_THRESHOLD_MULT);
            let is_speech = rms > adaptive_rms_threshold || peak > config.peak_threshold;

            // Emit the real level (normalized 0..1) on a ~100ms cadence so the
            // overlay visualizer can reflect actual audio instead of a fake one.
            chunk_counter = chunk_counter.wrapping_add(1);
            if chunk_counter % level_emit_every == 0 {
                // Scale RMS to a perceptually reasonable 0..1 for the meter.
                let level = (rms * 8.0).min(1.0);
                let _ = app.emit("audio-level", level);
            }

            if is_speech {
                if !in_speech {
                    // Speech START detected
                    in_speech = true;
                    speech_chunks = 0;

                    // Include pre-speech buffer for natural sound
                    speech_buffer.extend(pre_speech.drain(..));

                    let _ = app.emit("speech-start", ());
                }

                speech_chunks += 1;
                speech_buffer.extend_from_slice(&mono);
                silence_chunks = 0; // Reset silence counter on any speech

                // Safety cap: force emit if exceeds 30s
                if speech_buffer.len() > max_samples {
                    let normalized_buffer = normalize_audio_level(&speech_buffer, 0.1);
                    if let Ok(b64) = samples_to_wav_b64(sr, &normalized_buffer) {
                        // let duration = speech_buffer.len() as f32 / sr as f32;
                        let _ = app.emit("speech-detected", b64);
                    }
                    // Reallocate rather than clear(): drops the (large) capacity
                    // so a single long utterance doesn't keep that memory pinned
                    // for the rest of the session.
                    speech_buffer = Vec::new();
                    in_speech = false;
                    speech_chunks = 0;
                }
            } else {
                // Silence detected
                if in_speech {
                    silence_chunks += 1;

                    // Continue collecting during silence (important for natural speech)
                    speech_buffer.extend_from_slice(&mono);

                    // Check if silence duration exceeds threshold
                    if silence_chunks >= config.silence_chunks {
                        // Verify minimum speech duration
                        if speech_chunks >= config.min_speech_chunks && !speech_buffer.is_empty() {
                            // Trim trailing silence (keep ~0.15s for natural ending)
                            let silence_duration_samples = silence_chunks * config.hop_size;
                            let keep_silence_samples = (sr as usize) * 15 / 100; // 0.15s
                            let trim_amount =
                                silence_duration_samples.saturating_sub(keep_silence_samples);

                            if speech_buffer.len() > trim_amount {
                                speech_buffer.truncate(speech_buffer.len() - trim_amount);
                            }

                            // Emit complete speech segment
                            let normalized_buffer = normalize_audio_level(&speech_buffer, 0.1);
                            if let Ok(b64) = samples_to_wav_b64(sr, &normalized_buffer) {
                                // let duration = speech_buffer.len() as f32 / sr as f32;
                                let _ = app.emit("speech-detected", b64);
                            } else {
                                error!("Failed to encode speech to WAV");
                                let _ = app.emit("audio-encoding-error", "Failed to encode speech");
                            }
                        } else {
                            let _ = app.emit(
                                "speech-discarded",
                                "Audio too short (likely background noise)",
                            );
                        }

                        // Reset for next speech detection. Reallocate (not
                        // clear) to release the emitted segment's capacity.
                        speech_buffer = Vec::new();
                        in_speech = false;
                        silence_chunks = 0;
                        speech_chunks = 0;
                    }
                } else {
                    // Not in speech yet - this chunk is ambient noise, so fold
                    // its RMS into the adaptive noise floor via a slow EMA (#22).
                    noise_floor =
                        noise_floor * (1.0 - NOISE_EMA_ALPHA) + rms * NOISE_EMA_ALPHA;

                    // Maintain rolling pre-speech buffer. Copy from the scratch
                    // slice (it's reused next iteration).
                    pre_speech.extend(mono.iter().copied());

                    // Trim excess (maintain fixed size). The rolling buffer is
                    // already bounded by this pop_front, so no shrink_to_fit is
                    // needed — it was reallocating + memcpy'ing on every silence
                    // chunk (the dominant state), for no benefit.
                    while pre_speech.len() > config.pre_speech_chunks * config.hop_size {
                        pre_speech.pop_front();
                    }
                }
            }
        }
    }
}

// Continuous capture (VAD disabled)
async fn run_continuous_capture(
    app: AppHandle,
    stream: impl StreamExt<Item = f32> + Unpin,
    sr: u32,
    config: VadConfig,
) {
    let mut stream = stream;
    let max_samples = (sr as u64 * config.max_recording_duration_secs) as usize;

    // Start with ~30s of capacity and let the Vec grow on demand, instead of
    // eagerly reserving the full max_recording_duration (which for a large
    // configured cap could reserve hundreds of MB up front, most of it unused).
    let initial_capacity = (sr as usize * 30).min(max_samples);
    let mut audio_buffer = Vec::with_capacity(initial_capacity);
    let start_time = Instant::now();
    let max_duration = Duration::from_secs(config.max_recording_duration_secs);

    // Atomic flag for manual stop
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_for_listener = stop_flag.clone();

    // Listen for manual stop event. Wrapped in a Drop guard so the listener is
    // always unregistered when this task ends — including when it is cancelled
    // via task.abort() at an await point (stop_system_audio_capture does this),
    // where the explicit unlisten below would otherwise be skipped and leak the
    // listener across capture sessions.
    let stop_listener = app.listen("manual-stop-continuous", move |_| {
        stop_flag_for_listener.store(true, Ordering::Release);
    });
    let _listener_guard = ListenerGuard {
        app: app.clone(),
        id: Some(stop_listener),
    };

    // Emit recording started
    let _ = app.emit(
        "continuous-recording-start",
        config.max_recording_duration_secs,
    );

    // Accumulate audio - check stop flag on EVERY sample for immediate response
    loop {
        // Check stop flag FIRST on every iteration for immediate stopping
        if stop_flag.load(Ordering::Acquire) {
            break;
        }

        tokio::select! {
            sample_opt = stream.next() => {
                match sample_opt {
                    Some(sample) => {
                        if stop_flag.load(Ordering::Acquire) {
                            break;
                        }

                        audio_buffer.push(sample);

                        let elapsed = start_time.elapsed();

                        // Emit progress every second
                        if audio_buffer.len() % (sr as usize) == 0 {
                            let _ = app.emit("recording-progress", elapsed.as_secs());
                        }

                        // Check size limit (safety)
                        if audio_buffer.len() >= max_samples {
                            break;
                        }

                        // Check time limit
                        if elapsed >= max_duration {
                            break;
                        }
                    },
                    None => {
                        warn!("Audio stream ended unexpectedly");
                        break;
                    }
                }
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(10)) => {
            }
        }
    }

    // The listener is unregistered by _listener_guard's Drop when this task
    // ends (normal return OR cancellation), so no explicit unlisten here.

    // Process and emit audio
    if !audio_buffer.is_empty() {
        // let duration = start_time.elapsed().as_secs_f32();

        // Clean + normalize in place — no extra full-size copies of the
        // (potentially minutes-long) recording.
        apply_noise_gate_in_place(&mut audio_buffer, config.noise_gate_threshold);
        normalize_audio_level_in_place(&mut audio_buffer, 0.1);
        let cleaned_audio = &audio_buffer;

        match samples_to_wav_b64(sr, cleaned_audio) {
            Ok(b64) => {
                let _ = app.emit("speech-detected", b64);
            }
            Err(e) => {
                error!("Failed to encode continuous audio: {}", e);
                let _ = app.emit("audio-encoding-error", e);
            }
        }
    } else {
        warn!("No audio captured in continuous mode");
        let _ = app.emit("audio-encoding-error", "No audio recorded");
    }

    let _ = app.emit("continuous-recording-stopped", ());
}

// Apply the soft-knee noise gate in place, mutating the slice. Used in the hot
// VAD loop (once per chunk, ~94×/s) where allocating a fresh Vec per chunk was
// pure churn (~2.75 GB/h in active mode).
fn apply_noise_gate_in_place(samples: &mut [f32], threshold: f32) {
    const KNEE_RATIO: f32 = 3.0; // Compression ratio for soft knee

    for s in samples.iter_mut() {
        let abs = s.abs();
        if abs < threshold {
            *s *= (abs / threshold).powf(1.0 / KNEE_RATIO);
        }
    }
}

// Calculate RMS and peak (optimized)
fn calculate_audio_metrics(chunk: &[f32]) -> (f32, f32) {
    let mut sumsq = 0.0f32;
    let mut peak = 0.0f32;

    for &v in chunk {
        let a = v.abs();
        peak = peak.max(a);
        sumsq += v * v;
    }

    let rms = (sumsq / chunk.len() as f32).sqrt();
    (rms, peak)
}

fn normalize_audio_level(samples: &[f32], target_rms: f32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }

    let sum_squares: f32 = samples.iter().map(|&s| s * s).sum();
    let current_rms = (sum_squares / samples.len() as f32).sqrt();

    if current_rms < 0.001 {
        return samples.to_vec();
    }

    let gain = (target_rms / current_rms).min(10.0);

    samples
        .iter()
        .map(|&s| {
            let amplified = s * gain;
            if amplified.abs() > 1.0 {
                amplified.signum() * (1.0 - (-amplified.abs()).exp())
            } else {
                amplified
            }
        })
        .collect()
}

// In-place normalization, mutating the slice. Used by continuous capture at
// end-of-recording to avoid allocating a fresh Vec the size of the whole
// recording (potentially minutes of audio).
fn normalize_audio_level_in_place(samples: &mut [f32], target_rms: f32) {
    if samples.is_empty() {
        return;
    }

    let sum_squares: f32 = samples.iter().map(|&s| s * s).sum();
    let current_rms = (sum_squares / samples.len() as f32).sqrt();

    if current_rms < 0.001 {
        return;
    }

    let gain = (target_rms / current_rms).min(10.0);

    for s in samples.iter_mut() {
        let amplified = *s * gain;
        *s = if amplified.abs() > 1.0 {
            amplified.signum() * (1.0 - (-amplified.abs()).exp())
        } else {
            amplified
        };
    }
}

// Convert samples to WAV base64 (with proper error handling)
fn samples_to_wav_b64(sample_rate: u32, mono_f32: &[f32]) -> Result<String, String> {
    // Validate sample rate
    if !(8000..=96000).contains(&sample_rate) {
        error!("Invalid sample rate: {}", sample_rate);
        return Err(format!(
            "Invalid sample rate: {}. Expected 8000-96000 Hz",
            sample_rate
        ));
    }

    // Validate buffer
    if mono_f32.is_empty() {
        return Err("Empty audio buffer".to_string());
    }

    // Pre-size the output: 44-byte WAV header + 2 bytes per i16 sample. Avoids
    // repeated reallocations of the backing Vec as the WAV is written.
    let mut cursor = Cursor::new(Vec::with_capacity(44 + mono_f32.len() * 2));
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = WavWriter::new(&mut cursor, spec).map_err(|e| {
        error!("Failed to create WAV writer: {}", e);
        e.to_string()
    })?;

    // Block writer: buffers all samples and writes them in one pass, instead of
    // a fallible write per sample.
    {
        let mut sample_writer = writer.get_i16_writer(mono_f32.len() as u32);
        for &s in mono_f32 {
            let clamped = s.clamp(-1.0, 1.0);
            sample_writer.write_sample((clamped * i16::MAX as f32) as i16);
        }
        sample_writer.flush().map_err(|e| e.to_string())?;
    }

    writer.finalize().map_err(|e| e.to_string())?;

    Ok(B64.encode(cursor.into_inner()))
}

#[tauri::command]
pub async fn stop_system_audio_capture(app: AppHandle) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();

    // Signal the Deepgram streaming task (if any) to wind down gracefully
    // (send CloseStream, flush finals) before we abort. The notify wakes its
    // child tasks out of any blocking await (wedged WS/channel) directly, so
    // they can't outlive us even though we abort the parent below. Harmless if
    // the batch pipeline is the one running.
    state
        .deepgram_stop
        .store(true, std::sync::atomic::Ordering::Release);
    state.deepgram_stop_notify.notify_waiters();

    // Abort task in separate scope (Send trait fix)
    {
        let mut guard = state
            .stream_task
            .lock()
            .map_err(|e| format!("Failed to acquire task lock: {}", e))?;

        if let Some(task) = guard.take() {
            task.abort();
        }
    }

    // LONGER delay for proper cleanup (300ms instead of 150ms)
    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;

    // Mark as not capturing
    *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to update capturing state: {}", e))? = false;

    // Additional cleanup delay (CRITICAL for mic indicator)
    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

    // Emit stopped event
    let _ = app.emit("capture-stopped", ());
    Ok(())
}

/// Manual stop for continuous recording
#[tauri::command]
pub async fn manual_stop_continuous(app: AppHandle) -> Result<(), String> {
    let _ = app.emit("manual-stop-continuous", ());

    tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;

    Ok(())
}

#[tauri::command]
pub fn check_system_audio_access(_app: AppHandle) -> Result<bool, String> {
    match SpeakerInput::new() {
        Ok(_) => Ok(true),
        Err(e) => {
            error!("System audio access check failed: {}", e);
            Ok(false)
        }
    }
}

#[tauri::command]
pub async fn request_system_audio_access(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.shell()
            .command("open")
            .args(["x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture"])
            .spawn()
            .map_err(|e| {
                error!("Failed to open system preferences: {}", e);
                e.to_string()
            })?;
    }
    #[cfg(target_os = "windows")]
    {
        app.shell()
            .command("ms-settings:sound")
            .spawn()
            .map_err(|e| {
                error!("Failed to open sound settings: {}", e);
                e.to_string()
            })?;
    }
    #[cfg(target_os = "linux")]
    {
        let commands = ["pavucontrol", "gnome-control-center sound"];
        let mut opened = false;

        for cmd in &commands {
            if app.shell().command(cmd).spawn().is_ok() {
                opened = true;
                break;
            }
        }

        if !opened {
            warn!("Failed to open audio settings on Linux");
        }
    }

    Ok(())
}

// VAD Configuration Management
#[tauri::command]
pub async fn get_vad_config(app: AppHandle) -> Result<VadConfig, String> {
    let state = app.state::<crate::AudioState>();
    let config = state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to get VAD config: {}", e))?
        .clone();
    Ok(config)
}

#[tauri::command]
pub async fn update_vad_config(app: AppHandle, config: VadConfig) -> Result<(), String> {
    // Validate config
    if config.sensitivity_rms < 0.0 || config.sensitivity_rms > 1.0 {
        return Err("Invalid sensitivity_rms: must be 0.0-1.0".to_string());
    }
    if config.max_recording_duration_secs > 3600 {
        return Err("Invalid max_recording_duration_secs: must be <= 3600 (1 hour)".to_string());
    }

    let state = app.state::<crate::AudioState>();
    *state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to update VAD config: {}", e))? = config;

    Ok(())
}

#[tauri::command]
pub async fn get_capture_status(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<crate::AudioState>();
    let is_capturing = *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to get capture status: {}", e))?;
    Ok(is_capturing)
}

#[tauri::command]
pub fn get_audio_sample_rate(_app: AppHandle) -> Result<u32, String> {
    let input = SpeakerInput::new().map_err(|e| {
        error!("Failed to create speaker input: {}", e);
        format!("Failed to access system audio: {}", e)
    })?;

    let stream = input.stream();
    let sr = stream.sample_rate();

    Ok(sr)
}

#[tauri::command]
pub fn get_input_devices() -> Result<Vec<AudioDevice>, String> {
    crate::speaker::list_input_devices().map_err(|e| {
        error!("Failed to get input devices: {}", e);
        format!("Failed to get input devices: {}", e)
    })
}

#[tauri::command]
pub fn get_output_devices() -> Result<Vec<AudioDevice>, String> {
    crate::speaker::list_output_devices().map_err(|e| {
        error!("Failed to get output devices: {}", e);
        format!("Failed to get output devices: {}", e)
    })
}
