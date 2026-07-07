use anyhow::Result;
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use std::pin::Pin;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos::{SpeakerInput as PlatformSpeakerInput, SpeakerStream as PlatformSpeakerStream};

// Native microphone capture (cpal) — macOS only for now. Used by the unified
// two-channel Live session (#34) to pair the mic with the system-audio tap.
#[cfg(target_os = "macos")]
mod mic;
#[cfg(target_os = "macos")]
mod combiner;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows::{SpeakerInput as PlatformSpeakerInput, SpeakerStream as PlatformSpeakerStream};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux::{SpeakerInput as PlatformSpeakerInput, SpeakerStream as PlatformSpeakerStream};

mod commands;
pub mod deepgram;

// Re-export commands for tauri handler
pub use commands::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub(crate) fn list_input_devices() -> Result<Vec<AudioDevice>> {
    #[cfg(target_os = "macos")]
    return macos::get_input_devices();

    #[cfg(target_os = "windows")]
    return windows::get_input_devices();

    #[cfg(target_os = "linux")]
    return linux::get_input_devices();
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub(crate) fn list_output_devices() -> Result<Vec<AudioDevice>> {
    #[cfg(target_os = "macos")]
    return macos::get_output_devices();

    #[cfg(target_os = "windows")]
    return windows::get_output_devices();

    #[cfg(target_os = "linux")]
    return linux::get_output_devices();
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub(crate) fn list_input_devices() -> Result<Vec<AudioDevice>> {
    Ok(vec![])
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub(crate) fn list_output_devices() -> Result<Vec<AudioDevice>> {
    Ok(vec![])
}

// Pluely speaker input and stream
pub struct SpeakerInput {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    inner: PlatformSpeakerInput,
}

impl SpeakerInput {
    // Creates a new speaker input. Fails on unsupported platforms.
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    pub fn new() -> Result<Self> {
        let inner = PlatformSpeakerInput::new(None)?;
        Ok(Self { inner })
    }

    // Creates a new speaker input with a specific device ID
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    pub fn new_with_device(device_id: Option<String>) -> Result<Self> {
        let inner = PlatformSpeakerInput::new(device_id)?;
        Ok(Self { inner })
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    pub fn new() -> Result<Self> {
        Err(anyhow::anyhow!(
            "SpeakerInput::new is not supported on this platform"
        ))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    pub fn new_with_device(_device_id: Option<String>) -> Result<Self> {
        Err(anyhow::anyhow!(
            "SpeakerInput::new_with_device is not supported on this platform"
        ))
    }

    // Starts the audio stream.
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    pub fn stream(self) -> SpeakerStream {
        let inner = self.inner.stream();
        SpeakerStream { inner }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    pub fn stream(self) -> SpeakerStream {
        unimplemented!("SpeakerInput::stream is not supported on this platform")
    }
}

// Stream of f32 audio samples from the speaker.
pub struct SpeakerStream {
    inner: PlatformSpeakerStream,
}

impl Stream for SpeakerStream {
    type Item = f32;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        {
            Pin::new(&mut self.inner).poll_next(cx)
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            std::task::Poll::Pending
        }
    }
}

impl SpeakerStream {
    // Gets the sample rate (e.g., 16000 Hz on stub, variable on real impls).
    pub fn sample_rate(&self) -> u32 {
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        return self.inner.sample_rate();

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        0
    }
}

/// A unified two-channel Live stream (#34): microphone (channel 0 = "You")
/// interleaved with system audio (channel 1 = "Interlocutor"), as one stereo
/// `Stream<Item = f32>` at the system sample rate.
///
/// This wrapper is nameable on all platforms so the (non-cfg'd) Tauri command
/// can hold it; it only actually captures on macOS. `system_device_id` is a
/// CoreAudio output UID (as used today); `mic_device_id` is resolved
/// best-effort to a cpal input device, falling back to the default.
pub struct DualStream {
    #[cfg(target_os = "macos")]
    inner: combiner::StereoCombiner,
}

impl DualStream {
    pub fn new(
        system_device_id: Option<String>,
        mic_device_id: Option<String>,
    ) -> Result<Self> {
        #[cfg(target_os = "macos")]
        {
            let system = SpeakerInput::new_with_device(system_device_id)?.stream();
            let mic = mic::MicInput::new(mic_device_id)?.stream()?;
            let inner = combiner::StereoCombiner::new(mic, system);
            Ok(Self { inner })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (system_device_id, mic_device_id);
            Err(anyhow::anyhow!(
                "Unified mic + system capture is only supported on macOS"
            ))
        }
    }

    pub fn sample_rate(&self) -> u32 {
        #[cfg(target_os = "macos")]
        return self.inner.sample_rate();
        #[cfg(not(target_os = "macos"))]
        0
    }
}

impl Stream for DualStream {
    type Item = f32;

    fn poll_next(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        #[cfg(target_os = "macos")]
        {
            Pin::new(&mut self.inner).poll_next(cx)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = cx;
            std::task::Poll::Ready(None)
        }
    }
}
