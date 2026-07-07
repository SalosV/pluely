// Stereo combiner for the unified two-channel Live session (#34).
//
// Takes two independent mono sources and produces ONE interleaved stereo
// `Stream<Item = f32>` (L, R, L, R, …) suitable for Deepgram multichannel:
//   - LEFT  (channel 0) = microphone  = "You"
//   - RIGHT (channel 1) = system audio = "Interlocutor"
//
// The two sources arrive independently and may differ in sample rate and in
// timing (one can be silent while the other is active). The combiner:
//   1. Non-blockingly drains whatever samples each source currently has.
//   2. Resamples the mic to the system's sample rate (the chosen target) using
//      a small hand-written linear resampler that stays phase-continuous across
//      calls (no external crate).
//   3. Interleaves `n = min(mic_available, sys_available)` frames, and keeps the
//      leftover of the longer side in a carry buffer so nothing is dropped and
//      the two channels don't drift.
//   4. Zero-fills the missing side when one source is silent, so a quiet mic
//      never stalls the interlocutor channel (and vice-versa).
//
// Ordering is load-bearing: mic is pushed BEFORE system in each frame, so the
// mic is channel 0 and the system is channel 1. Deepgram reports which channel
// a transcript came from via `channel_index[0]`, which we map to You/Interlocutor.

use super::mic::MicStream;
use super::SpeakerStream;
use futures_util::Stream;
use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

/// Cap on the interleaved backlog before we treat a persistently faster source
/// as drift. ~2 seconds at 48 kHz. When the SHORTER side exceeds this (i.e. the
/// other side has fallen this far behind and probably won't catch up), we drop
/// an equal number of oldest samples from BOTH sides so stereo alignment is
/// preserved by construction (never trim one side alone — that shifts channels).
const CARRY_CAP_SAMPLES: usize = 48_000 * 2;

/// How many consecutive polls a side may be empty (while the other has data and
/// hasn't ended) before we treat it as *sustained* silence and zero-fill it,
/// rather than waiting. This tolerates normal cross-callback jitter (mic and
/// system are independent audio threads that don't fire in lockstep) without
/// pairing real audio against silence — which would permanently desync the two
/// Deepgram channels. A handful of polls is a few ms; genuine silence lasts far
/// longer, so it still gets zero-filled promptly.
const SILENCE_TOLERANCE_POLLS: u32 = 8;

/// Phase-continuous linear resampler from `in_rate` to `out_rate`. Keeps a
/// fractional read position across successive `process` calls so bursts stay
/// seamless. Adequate for speech STT; Deepgram is robust to linear resampling.
struct LinearResampler {
    ratio: f64, // in_rate / out_rate: how far to advance the input per output sample
    pos: f64,   // fractional position within `hist`+`buf`, relative to buf start
    prev: f32,  // last sample of the previous chunk (for interpolation across calls)
    has_prev: bool,
}

impl LinearResampler {
    fn new(in_rate: u32, out_rate: u32) -> Self {
        Self {
            ratio: in_rate as f64 / out_rate as f64,
            pos: 0.0,
            prev: 0.0,
            has_prev: false,
        }
    }

    /// Resample `input` (at in_rate) appending output samples (at out_rate) to
    /// `out`. Interpolates between the carried `prev` sample and the current
    /// input, so the boundary between chunks is continuous.
    fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        // Virtual buffer = [prev, input...] when we have a carried sample, so
        // index 0 refers to `prev` and index i>=1 refers to input[i-1].
        let offset = if self.has_prev { 1usize } else { 0usize };
        let virtual_len = input.len() + offset;

        // Emit output samples while the interpolation window stays in range.
        // We need indices floor(pos) and floor(pos)+1 both < virtual_len.
        while (self.pos as usize) + 1 < virtual_len {
            let idx = self.pos as usize;
            let frac = self.pos - idx as f64;

            let s0 = if idx < offset {
                self.prev
            } else {
                input[idx - offset]
            };
            let s1 = if idx + 1 < offset {
                self.prev
            } else {
                input[idx + 1 - offset]
            };

            out.push(s0 + (s1 - s0) * frac as f32);
            self.pos += self.ratio;
        }

        // Consume the input: shift `pos` back by how many real input samples we
        // advanced past, and carry the last input sample as `prev` for next call.
        let consumed = self.pos - offset as f64;
        // Keep only the fractional remainder relative to the new `prev` (the
        // last input sample), which becomes virtual index 0 next time.
        self.pos = (consumed - (input.len() as f64 - 1.0)).max(0.0);
        self.prev = *input.last().unwrap();
        self.has_prev = true;
    }
}

pub struct StereoCombiner {
    mic: MicStream,        // channel 0 = "You"
    system: SpeakerStream, // channel 1 = "Interlocutor"
    target_rate: u32,

    resampler: Option<LinearResampler>,

    // Per-side available samples not yet interleaved (mic already resampled).
    mic_carry: VecDeque<f32>,
    sys_carry: VecDeque<f32>,

    // Interleaved output ready to yield, one f32 at a time.
    out: VecDeque<f32>,

    // Scratch reused across polls to avoid per-call allocation.
    mic_scratch: Vec<f32>,
    resampled_scratch: Vec<f32>,

    mic_done: bool,
    sys_done: bool,

    // Becomes true once BOTH sources have produced their first samples. Until
    // then we don't zero-fill: at startup one device often opens a few ms before
    // the other, and emitting mic-with-silence (or vice-versa) in that window
    // would offset the two channels for the whole session. We simply wait for
    // both to be live, then interleave from a common start.
    started: bool,

    // Consecutive polls where this side was empty while the other had data (and
    // hadn't ended). Reset to 0 whenever the side has data. Once it crosses
    // SILENCE_TOLERANCE_POLLS we treat the side as genuinely silent and zero-fill
    // it; below the threshold we wait (Pending) for its real samples so routine
    // jitter never mis-pairs the channels.
    mic_starved_polls: u32,
    sys_starved_polls: u32,

    // User-controlled "mute my mic" flag (#34). When set, mic samples are
    // discarded and the "You" channel is fed silence immediately (no waiting on
    // the jitter tolerance), so the interlocutor channel keeps flowing normally.
    mic_muted: Arc<AtomicBool>,
}

impl StereoCombiner {
    pub fn new(mic: MicStream, system: SpeakerStream, mic_muted: Arc<AtomicBool>) -> Self {
        let target_rate = system.sample_rate();
        let mic_rate = mic.sample_rate();
        let resampler = if mic_rate != target_rate {
            Some(LinearResampler::new(mic_rate, target_rate))
        } else {
            None
        };

        Self {
            mic,
            system,
            target_rate,
            resampler,
            mic_carry: VecDeque::new(),
            sys_carry: VecDeque::new(),
            out: VecDeque::new(),
            mic_scratch: Vec::with_capacity(4096),
            resampled_scratch: Vec::with_capacity(4096),
            mic_done: false,
            sys_done: false,
            started: false,
            mic_starved_polls: 0,
            sys_starved_polls: 0,
            mic_muted,
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.target_rate
    }

    /// Drain all immediately-available samples from a source into `dst` (after
    /// optional resampling for the mic). Returns whether the source is now done
    /// (poll returned `Ready(None)`). Registers the task waker if it returns
    /// `Pending` before producing anything (handled by the inner poll_next).
    fn drain_source(&mut self, cx: &mut Context<'_>, is_mic: bool) -> bool {
        // Pull the raw samples first into a scratch, then push into the carry.
        // We poll until Pending/None so the inner stream registers our waker.
        if is_mic {
            self.mic_scratch.clear();
            loop {
                match Pin::new(&mut self.mic).poll_next(cx) {
                    Poll::Ready(Some(s)) => self.mic_scratch.push(s),
                    Poll::Ready(None) => {
                        self.mic_done = true;
                        break;
                    }
                    Poll::Pending => break,
                }
            }
            // Muted: keep draining the mic (so its ring buffer doesn't back up)
            // but discard the samples — nothing enters the carry, so the "You"
            // channel goes silent. poll_next forces immediate silence separately.
            if self.mic_muted.load(Ordering::Acquire) {
                self.mic_scratch.clear();
                return self.mic_done;
            }
            if self.mic_scratch.is_empty() {
                return self.mic_done;
            }
            if let Some(rs) = self.resampler.as_mut() {
                self.resampled_scratch.clear();
                rs.process(&self.mic_scratch, &mut self.resampled_scratch);
                self.mic_carry.extend(self.resampled_scratch.iter().copied());
            } else {
                self.mic_carry.extend(self.mic_scratch.iter().copied());
            }
            // NOTE: CARRY_CAP trimming is done in poll_next, coordinated across
            // both sides, so alignment is preserved (never trim one side alone).
            self.mic_done
        } else {
            loop {
                match Pin::new(&mut self.system).poll_next(cx) {
                    Poll::Ready(Some(s)) => self.sys_carry.push_back(s),
                    Poll::Ready(None) => {
                        self.sys_done = true;
                        break;
                    }
                    Poll::Pending => break,
                }
            }
            self.sys_done
        }
    }

    /// Drift guard, two layers:
    ///
    /// 1. If the SHORTER side's backlog exceeds the cap, drop an EQUAL number of
    ///    oldest samples from BOTH carries. This preserves stereo alignment
    ///    (only the overlapping region is ever interleaved) while discarding
    ///    ancient overlap. This is the common, alignment-safe case.
    ///
    /// 2. If ONE side alone exceeds a hard ceiling while the other stays far
    ///    behind (a persistently faster clock — the min() in layer 1 never
    ///    triggers), we must bound memory even though perfect alignment is
    ///    impossible: the faster side is producing more real time of audio than
    ///    the slower one. Drop the excess from the faster side only, accepting a
    ///    small one-time temporal skip. Real hardware drift is a few ppm, so this
    ///    fires at most rarely over very long sessions; the tolerance below keeps
    ///    it from ever firing under normal jitter.
    fn enforce_carry_cap(&mut self) {
        // Layer 1: aligned trim of the shared backlog.
        let min_len = self.mic_carry.len().min(self.sys_carry.len());
        if min_len > CARRY_CAP_SAMPLES {
            let drop = min_len - CARRY_CAP_SAMPLES;
            self.mic_carry.drain(0..drop);
            self.sys_carry.drain(0..drop);
        }

        // Layer 2: hard per-side ceiling (2x the aligned cap) for runaway drift.
        let hard_ceiling = CARRY_CAP_SAMPLES * 2;
        if self.mic_carry.len() > hard_ceiling {
            let drop = self.mic_carry.len() - hard_ceiling;
            self.mic_carry.drain(0..drop);
        }
        if self.sys_carry.len() > hard_ceiling {
            let drop = self.sys_carry.len() - hard_ceiling;
            self.sys_carry.drain(0..drop);
        }
    }
}

impl Stream for StereoCombiner {
    type Item = f32;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.as_mut().get_mut();

        // 1. Serve any already-interleaved output first.
        if let Some(s) = this.out.pop_front() {
            return Poll::Ready(Some(s));
        }

        // 2. Refill both sides (non-blocking; registers wakers on Pending).
        this.drain_source(cx, true);
        this.drain_source(cx, false);

        // 2b. Bound memory / skew every poll (not just when interleaving), so a
        // persistently faster clock whose slow partner is starved can't grow the
        // backlog without bound. Layer 1 keeps alignment; layer 2 is the runaway
        // ceiling. See enforce_carry_cap.
        this.enforce_carry_cap();

        // 3. If both sources are finished and drained, end the stream.
        if this.mic_done && this.sys_done && this.mic_carry.is_empty() && this.sys_carry.is_empty()
        {
            return Poll::Ready(None);
        }

        // 4. Decide how many stereo frames we can emit.
        let mic_have = this.mic_carry.len();
        let sys_have = this.sys_carry.len();

        // Startup gate: don't emit (or zero-fill) until BOTH sources are live,
        // so the two channels start phase-aligned. Once a source has *ended*
        // (done) — or the mic is muted (it will never produce) — we stop waiting
        // on it, otherwise the interlocutor channel would deadlock.
        if !this.started {
            let mic_unavailable = this.mic_done || this.mic_muted.load(Ordering::Acquire);
            let both_live = mic_have > 0 && sys_have > 0;
            let one_ended_other_live =
                (mic_unavailable && sys_have > 0) || (this.sys_done && mic_have > 0);
            if both_live || one_ended_other_live {
                this.started = true;
            } else {
                // Still waiting for the second source; wakers already registered.
                return Poll::Pending;
            }
        }

        // Track how long each side has been starved (empty while the other has
        // data and hasn't ended). This is what separates routine cross-callback
        // jitter from genuine, sustained silence.
        if sys_have == 0 && mic_have > 0 && !this.sys_done {
            this.sys_starved_polls = this.sys_starved_polls.saturating_add(1);
        } else {
            this.sys_starved_polls = 0;
        }
        if mic_have == 0 && sys_have > 0 && !this.mic_done {
            this.mic_starved_polls = this.mic_starved_polls.saturating_add(1);
        } else {
            this.mic_starved_polls = 0;
        }

        // A side is treated as "silent" (safe to zero-fill against) only if it
        // has ENDED, or it has been empty for longer than the jitter tolerance.
        // A MUTED mic counts as silent immediately (no waiting): its samples were
        // already discarded in drain_source, so mic_have is 0 and we want the
        // "You" channel to go silent right away while the interlocutor flows.
        let mic_muted = this.mic_muted.load(Ordering::Acquire);
        let sys_silent = this.sys_done || this.sys_starved_polls >= SILENCE_TOLERANCE_POLLS;
        let mic_silent =
            mic_muted || this.mic_done || this.mic_starved_polls >= SILENCE_TOLERANCE_POLLS;

        let (n, mic_zero, sys_zero) = if mic_have > 0 && sys_have > 0 {
            // Both live: interleave the overlap, keep the leftover for next poll.
            // (Backlog was already capped above in step 2b.)
            (mic_have.min(sys_have), false, false)
        } else if mic_have > 0 && sys_silent {
            // System genuinely silent/ended: emit mic frames with silence on R.
            (mic_have, false, true)
        } else if sys_have > 0 && mic_silent {
            // Mic genuinely silent/ended: emit system frames with silence on L.
            (sys_have, true, false)
        } else {
            // One side is only transiently empty (jitter) — wait for its real
            // samples instead of mis-pairing against silence. Wakers already
            // registered by drain_source. This is the fix for permanent channel
            // desync under normal cross-callback timing.
            (0, false, false)
        };

        if n == 0 {
            // No data to interleave right now; wakers already registered.
            return Poll::Pending;
        }

        this.out.reserve(n * 2);
        for _ in 0..n {
            let l = if mic_zero {
                0.0
            } else {
                this.mic_carry.pop_front().unwrap_or(0.0)
            };
            let r = if sys_zero {
                0.0
            } else {
                this.sys_carry.pop_front().unwrap_or(0.0)
            };
            this.out.push_back(l); // channel 0 = You
            this.out.push_back(r); // channel 1 = Interlocutor
        }

        match this.out.pop_front() {
            Some(s) => Poll::Ready(Some(s)),
            None => Poll::Pending,
        }
    }
}
