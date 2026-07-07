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
};

/** A finalized turn in the running transcript. */
export type TranscriptEntry = {
  id: number;
  text: string;
  speakers: SpeakerSegment[];
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
  // Finalized turns, in order.
  const [finals, setFinals] = useState<TranscriptEntry[]>([]);
  // The current, not-yet-final transcript (live preview).
  const [interim, setInterim] = useState<string>("");

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
    async (config: DeepgramConfigInput, deviceId?: string) => {
      setError("");
      setFinals([]);
      setInterim("");
      setConnected(false);

      // Register listeners BEFORE starting so we don't miss early events.
      cleanupListeners();
      unlistensRef.current = await Promise.all([
        listen("dg-connected", () => setConnected(true)),
        listen<TranscriptUpdate>("dg-transcript", (e) => {
          const update = e.payload;
          if (update.is_final) {
            setInterim("");
            if (update.text.trim()) {
              setFinals((prev) => [
                ...prev,
                {
                  id: entryIdRef.current++,
                  text: update.text,
                  speakers: update.speakers ?? [],
                },
              ]);
            }
          } else {
            setInterim(update.text);
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
          deviceId: deviceId ?? null,
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
    setInterim("");
  }, [cleanupListeners]);

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      cleanupListeners();
    };
  }, [cleanupListeners]);

  return {
    isStreaming,
    connected,
    error,
    finals,
    interim,
    startStreaming,
    stopStreaming,
  };
}
