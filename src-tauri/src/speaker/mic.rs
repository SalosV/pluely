// Pluely macOS microphone input and stream (native, via cpal).
//
// This mirrors the shape of `macos.rs`'s `SpeakerStream` so the two can be
// combined into a single stereo stream for Deepgram multichannel (#34):
//   - channel 0 (mic)    = "You"
//   - channel 1 (system) = "Interlocutor"
//
// Like `SpeakerStream`, `MicStream` is a `futures::Stream<Item = f32>` yielding
// mono samples, backed by a `HeapRb` ring buffer and the same lock-free
// `AtomicWaker` handoff between the real-time audio callback and the async
// consumer. Multi-channel mics are down-mixed to mono in the callback.
//
// The system-audio path captures via CoreAudio and identifies devices by their
// CoreAudio UID. cpal, however, identifies devices by *name*. So to honor a
// user-selected input device we translate UID -> name (via CoreAudio) and then
// match that name against cpal's enumerated input devices.

use anyhow::{anyhow, Result};
use cidre::core_audio as ca;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use futures_util::task::AtomicWaker;
use futures_util::Stream;
use ringbuf::{
    traits::{Consumer, Producer, Split},
    HeapCons, HeapRb,
};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::task::Poll;

/// `cpal::Stream` is `!Send` on most backends (it holds a thread-affine handle
/// to the OS audio callback). We only ever *drop* it — never call a method on
/// it — from another thread (the tokio task that owns the combiner). Dropping
/// is what stops the stream, and CoreAudio permits teardown from any thread.
/// Wrapping it lets `MicStream` be `Send` so it can live inside a spawned
/// future. INVARIANT: never call methods on the inner stream cross-thread;
/// only drop it.
struct SendStream(#[allow(dead_code)] cpal::Stream);
unsafe impl Send for SendStream {}

/// Lock-free wake coordination between the RT audio callback (producer) and the
/// async consumer — identical pattern to `macos.rs`'s `WakerSync`.
struct WakerSync {
    waker: AtomicWaker,
    has_data: AtomicBool,
}

pub struct MicInput {
    device: cpal::Device,
    config: StreamConfig,
    sample_format: SampleFormat,
    input_channels: u16,
    sample_rate: u32,
}

pub struct MicStream {
    consumer: HeapCons<f32>,
    waker_sync: Arc<WakerSync>,
    // Keeps the cpal stream alive; dropped on Drop to stop capture.
    _stream: SendStream,
    sample_rate: u32,
    should_terminate: Arc<AtomicBool>,
}

impl MicStream {
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
}

/// Resolve a CoreAudio input-device UID to its human-readable name, so we can
/// match it against cpal's name-keyed device list. Returns None if the UID
/// isn't found among current input devices.
fn input_name_for_uid(uid: &str) -> Option<String> {
    let all_devices = ca::System::devices().ok()?;
    for device in all_devices.into_iter() {
        // Only consider devices that actually have input buffers.
        let has_input = device
            .input_stream_cfg()
            .map(|cfg| cfg.number_buffers() > 0)
            .unwrap_or(false);
        if !has_input {
            continue;
        }
        if let Ok(dev_uid) = device.uid() {
            if dev_uid.to_string() == uid {
                return device.name().ok().map(|n| n.to_string());
            }
        }
    }
    None
}

/// Pick the cpal input device: if `device_id` is a real UID, translate it to a
/// name and match; otherwise (None / "default") use cpal's default input.
fn resolve_input_device(host: &cpal::Host, device_id: Option<String>) -> Result<cpal::Device> {
    let wanted_name = match device_id {
        Some(ref uid) if !uid.is_empty() && uid != "default" => input_name_for_uid(uid),
        _ => None,
    };

    if let Some(name) = wanted_name {
        if let Ok(devices) = host.input_devices() {
            for dev in devices {
                if dev.name().map(|n| n == name).unwrap_or(false) {
                    return Ok(dev);
                }
            }
        }
        // Requested device not found in cpal — fall through to default.
    }

    host.default_input_device()
        .ok_or_else(|| anyhow!("No default microphone input device available"))
}

impl MicInput {
    pub fn new(device_id: Option<String>) -> Result<Self> {
        let host = cpal::default_host();
        let device = resolve_input_device(&host, device_id)?;

        let supported = device
            .default_input_config()
            .map_err(|e| anyhow!("Failed to get default mic input config: {e}"))?;

        let sample_format = supported.sample_format();
        let input_channels = supported.channels();
        let sample_rate = supported.sample_rate().0;
        let config: StreamConfig = supported.config();

        Ok(Self {
            device,
            config,
            sample_format,
            input_channels,
            sample_rate,
        })
    }

    pub fn stream(self) -> Result<MicStream> {
        let buffer_size = 1024 * 128;
        let rb = HeapRb::<f32>::new(buffer_size);
        let (mut producer, consumer) = rb.split();

        let waker_sync = Arc::new(WakerSync {
            waker: AtomicWaker::new(),
            has_data: AtomicBool::new(false),
        });
        let should_terminate = Arc::new(AtomicBool::new(false));
        let consecutive_drops = Arc::new(AtomicU32::new(0));

        let channels = self.input_channels.max(1) as usize;
        let waker_cb = waker_sync.clone();
        let term_cb = should_terminate.clone();
        let drops_cb = consecutive_drops.clone();

        // Reused scratch buffer for the mono down-mix. Owned by the closure, and
        // the cpal data callback is single-threaded, so this is allocation-free
        // on the hot path after the first few calls.
        let mut mono: Vec<f32> = Vec::with_capacity(4096);

        let err_fn = |e| {
            tracing::error!("[mic] cpal input stream error: {e}");
        };

        // Push already-mono f32 samples into the ring buffer with the same
        // overflow policy as macos.rs::process_audio_data.
        macro_rules! push_mono {
            ($mono:expr) => {{
                let want = $mono.len();
                let pushed = producer.push_slice($mono);
                if pushed < want {
                    let n = drops_cb.fetch_add(1, Ordering::AcqRel) + 1;
                    if n == 25 {
                        tracing::warn!("[mic] audio buffer experiencing drops");
                    }
                    if n > 50 {
                        tracing::error!("[mic] audio buffer overflow - mic capture stopping");
                        term_cb.store(true, Ordering::Release);
                    }
                } else {
                    drops_cb.store(0, Ordering::Release);
                }
                waker_cb.has_data.store(true, Ordering::Release);
                waker_cb.waker.wake();
            }};
        }

        // Down-mix interleaved multi-channel input to mono by averaging each
        // frame's channels; pass mono through untouched.
        let stream = match self.sample_format {
            SampleFormat::F32 => self.device.build_input_stream(
                &self.config,
                move |data: &[f32], _| {
                    if channels == 1 {
                        push_mono!(data);
                    } else {
                        mono.clear();
                        mono.reserve(data.len() / channels + 1);
                        for frame in data.chunks(channels) {
                            let sum: f32 = frame.iter().copied().sum();
                            mono.push(sum / channels as f32);
                        }
                        push_mono!(&mono);
                    }
                },
                err_fn,
                None,
            ),
            SampleFormat::I16 => self.device.build_input_stream(
                &self.config,
                move |data: &[i16], _| {
                    mono.clear();
                    mono.reserve(data.len() / channels + 1);
                    for frame in data.chunks(channels) {
                        let sum: f32 = frame
                            .iter()
                            .map(|&s| s as f32 / i16::MAX as f32)
                            .sum();
                        mono.push(sum / channels as f32);
                    }
                    push_mono!(&mono);
                },
                err_fn,
                None,
            ),
            SampleFormat::U16 => self.device.build_input_stream(
                &self.config,
                move |data: &[u16], _| {
                    mono.clear();
                    mono.reserve(data.len() / channels + 1);
                    for frame in data.chunks(channels) {
                        // u16 center is 32768; map to [-1, 1).
                        let sum: f32 = frame
                            .iter()
                            .map(|&s| (s as f32 - 32768.0) / 32768.0)
                            .sum();
                        mono.push(sum / channels as f32);
                    }
                    push_mono!(&mono);
                },
                err_fn,
                None,
            ),
            other => {
                return Err(anyhow!(
                    "Unsupported microphone sample format: {other:?}"
                ));
            }
        }
        .map_err(|e| anyhow!("Failed to build mic input stream: {e}"))?;

        // On CoreAudio the stream may already be running, but play() is
        // idempotent and required on other backends.
        stream
            .play()
            .map_err(|e| anyhow!("Failed to start mic input stream: {e}"))?;

        Ok(MicStream {
            consumer,
            waker_sync,
            _stream: SendStream(stream),
            sample_rate: self.sample_rate,
            should_terminate,
        })
    }
}

impl Stream for MicStream {
    type Item = f32;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        // Identical lock-free handoff to macos.rs::SpeakerStream::poll_next.
        if let Some(sample) = self.consumer.try_pop() {
            return Poll::Ready(Some(sample));
        }

        if self.should_terminate.load(Ordering::Acquire) {
            return match self.consumer.try_pop() {
                Some(sample) => Poll::Ready(Some(sample)),
                None => Poll::Ready(None),
            };
        }

        self.waker_sync.has_data.store(false, Ordering::Release);
        self.waker_sync.waker.register(cx.waker());

        if let Some(sample) = self.consumer.try_pop() {
            return Poll::Ready(Some(sample));
        }

        if self.waker_sync.has_data.load(Ordering::Acquire) {
            cx.waker().wake_by_ref();
        }

        Poll::Pending
    }
}

impl Drop for MicStream {
    fn drop(&mut self) {
        self.should_terminate.store(true, Ordering::Release);
        // Dropping `_stream` (SendStream) stops the cpal capture.
    }
}
