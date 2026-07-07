import { useSyncExternalStore } from "react";

/**
 * Ephemeral module-level store for the system-audio AI response text as it
 * streams in.
 *
 * Why this exists: the response text used to live in `useSystemAudio` state,
 * which runs at the overlay root (`App`). Appending each token with
 * `setLastAIResponse` re-rendered the ENTIRE overlay (~47×/s) — mode switcher,
 * quick actions, recording panel, drag handle, custom cursor — even though only
 * the `<Markdown>` leaf actually depends on the text.
 *
 * By keeping the streaming text in an external store and reading it via
 * `useSyncExternalStore`, only the component that subscribes (the response
 * renderer) re-renders per token. `useSystemAudio` still tracks a lightweight
 * boolean (`hasAIResponse`) for show/hide + window-resize logic, which flips at
 * most twice per response instead of once per token.
 *
 * This is intentionally NOT persisted to localStorage (unlike the VAD/context
 * stores): the streaming buffer is transient UI state, not settings, and is
 * scoped to a single overlay window.
 */

let currentResponse = "";
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Replace the current streaming response text. Called from `useSystemAudio`:
 * `""` on reset, then the growing buffer on each chunk. Skips the notify if the
 * value is unchanged so identical writes don't wake subscribers.
 */
export function setStreamingResponse(value: string) {
  if (value === currentResponse) return;
  currentResponse = value;
  emitChange();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return currentResponse;
}

/**
 * Subscribe to the streaming response text. Only re-renders the calling
 * component when the text changes — not the rest of the overlay tree.
 */
export function useStreamingResponse(): string {
  return useSyncExternalStore(subscribe, getSnapshot);
}
