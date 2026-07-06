import { useState, useEffect, useCallback } from "react";
import { STORAGE_KEYS } from "@/config";
import {
  getSystemAudioContext,
  setSystemAudioContext,
} from "@/lib";

/**
 * Lightweight store for the system-audio AI context settings (use-system-prompt
 * toggle + custom context text). Reads/writes localStorage without pulling in
 * the heavy `useSystemAudio` capture hook, and stays fresh across windows via a
 * `storage` event listener.
 */
export function useSystemAudioContextStore() {
  const [state, setState] = useState(getSystemAudioContext);

  const setUseSystemPrompt = useCallback((value: boolean) => {
    setState((prev) => {
      const next = { ...prev, useSystemPrompt: value };
      setSystemAudioContext(next);
      return next;
    });
  }, []);

  const setContextContent = useCallback((content: string) => {
    setState((prev) => {
      const next = { ...prev, contextContent: content };
      setSystemAudioContext(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT) {
        setState(getSystemAudioContext());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return {
    useSystemPrompt: state.useSystemPrompt,
    contextContent: state.contextContent,
    setUseSystemPrompt,
    setContextContent,
  };
}
