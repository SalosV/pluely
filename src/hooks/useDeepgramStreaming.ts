import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Deepgram Live streaming STT (#31/#32).
 *
 * Drives the Rust `start_deepgram_streaming` command: the backend opens a
 * WebSocket to Deepgram, streams the system-audio PCM, and emits interim +
 * final transcripts back as `dg-transcript` events. This hook accumulates the
 * finals into a running transcript and keeps the latest interim separately so
 * the UI can render it live (e.g. greyed out).
 *
 * With diarization on, each transcript carries per-speaker segments, which we
 * surface for the caller to render "Speaker 0 / Speaker 1 …" labels.
 */

export type SpeakerSegment = { speaker: number; text: string };

type TranscriptUpdate = {
  text: string;
  is_final: boolean;
  speakers: SpeakerSegment[];
  // Source channel in the unified two-channel Live session (#34):
  // 0 = mic ("You"), 1 = system ("Interlocutor"). Absent in single-channel.
  channel?: number | null;
};

/** A finalized turn in the running transcript. */
export type TranscriptEntry = {
  id: number;
  text: string;
  speakers: SpeakerSegment[];
  // Which source produced this turn (see TranscriptUpdate.channel).
  channel?: number | null;
};

/** Current (not-yet-final) transcript for one channel. */
export type InterimEntry = {
  channel: number | null;
  text: string;
};

export type DeepgramConfigInput = {
  apiKey: string;
  model?: string;
  language?: string;
  diarize?: boolean;
};

export function useDeepgramStreaming() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>("");
  // Whether the user has muted their own mic ("You" channel) for this session.
  const [micMuted, setMicMuted] = useState(false);
  // Finalized turns, in order.
  const [finals, setFinals] = useState<TranscriptEntry[]>([]);
  // The current, not-yet-final transcript(s), keyed by channel. In the unified
  // two-channel session (#34) the mic ("You") and system ("Interlocutor")
  // produce interims independently, so a single string would let one overwrite
  // the other. We key by channel (using -1 as the key for the single-channel
  // case where `channel` is absent) so each source shows its own live preview.
  const [interims, setInterims] = useState<Record<number, string>>({});

  const entryIdRef = useRef(0);
  const unlistensRef = useRef<UnlistenFn[]>([]);

  const cleanupListeners = useCallback(() => {
    for (const fn of unlistensRef.current) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
    unlistensRef.current = [];
  }, []);

  const startStreaming = useCallback(
    async (
      config: DeepgramConfigInput,
      deviceId?: string,
      inputDeviceId?: string
    ) => {
      setError("");
      setFinals([]);
      setInterims({});
      setConnected(false);
      // New session starts unmuted (backend also resets its flag).
      setMicMuted(false);
      // Restart final ids from 0 each session so consumers using an id floor
      // (e.g. the Live AI "already answered up to id N" marker) stay simple and
      // don't rely on a forever-monotonic counter.
      entryIdRef.current = 0;

      // Register listeners BEFORE starting so we don't miss early events.
      cleanupListeners();
      unlistensRef.current = await Promise.all([
        listen("dg-connected", () => setConnected(true)),
        listen<TranscriptUpdate>("dg-transcript", (e) => {
          const update = e.payload;
          // Key interims by channel; -1 stands in for the single-channel case.
          const key = update.channel ?? -1;
          if (update.is_final) {
            // Clear only this channel's interim.
            setInterims((prev) => {
              if (prev[key] === undefined) return prev;
              const next = { ...prev };
              delete next[key];
              return next;
            });
            if (update.text.trim()) {
              setFinals((prev) => [
                ...prev,
                {
                  id: entryIdRef.current++,
                  text: update.text,
                  speakers: update.speakers ?? [],
                  channel: update.channel ?? null,
                },
              ]);
            }
          } else {
            setInterims((prev) => ({ ...prev, [key]: update.text }));
          }
        }),
        listen<string>("dg-error", (e) => {
          setError(e.payload || "Deepgram streaming error");
          // An errored session is not an active session — reset so the "Live"
          // toggle doesn't stay stuck disabled. (Rust also emits dg-closed on
          // failure, but reset here too as a belt-and-suspenders.)
          setConnected(false);
          setIsStreaming(false);
        }),
        listen("dg-closed", () => {
          setConnected(false);
          setIsStreaming(false);
        }),
      ]);

      try {
        await invoke("start_deepgram_streaming", {
          config: {
            api_key: config.apiKey,
            model: config.model ?? "nova-3",
            language: config.language ?? "multi",
            diarize: config.diarize ?? true,
          },
          // System output device (tap) and microphone input device. Live is
          // always a unified two-channel session (mic + system).
          deviceId: deviceId ?? null,
          inputDeviceId: inputDeviceId ?? null,
        });
        setIsStreaming(true);
      } catch (err: any) {
        cleanupListeners();
        setError(typeof err === "string" ? err : err?.message || "Failed to start streaming");
        setIsStreaming(false);
      }
    },
    [cleanupListeners]
  );

  const stopStreaming = useCallback(async () => {
    try {
      await invoke("stop_system_audio_capture");
    } catch {
      // ignore — best effort
    }
    cleanupListeners();
    setIsStreaming(false);
    setConnected(false);
    setInterims({});
    setMicMuted(false);
  }, [cleanupListeners]);

  // Toggle muting the user's own mic ("You" channel) live. Optimistically flips
  // local state, then tells the backend; on failure, revert so UI stays truthful.
  const toggleMicMuted = useCallback(async () => {
    const next = !micMuted;
    setMicMuted(next);
    try {
      await invoke("set_mic_muted", { muted: next });
    } catch (err) {
      console.error("Failed to set mic muted:", err);
      setMicMuted(!next); // revert on failure
    }
  }, [micMuted]);

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      cleanupListeners();
    };
  }, [cleanupListeners]);

  // Expose interims as a stable, ordered array (by channel) for rendering, each
  // tagged with its channel so the UI can label "You" / "Interlocutor".
  const interimEntries: InterimEntry[] = Object.entries(interims)
    .filter(([, text]) => text.trim().length > 0)
    .map(([key, text]) => ({ channel: Number(key), text }))
    .sort((a, b) => (a.channel ?? -1) - (b.channel ?? -1));

  return {
    isStreaming,
    connected,
    error,
    finals,
    interims: interimEntries,
    micMuted,
    toggleMicMuted,
    startStreaming,
    stopStreaming,
  };
}
