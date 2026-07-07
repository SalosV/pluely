/**
 * Bridge between the Live (Deepgram streaming) session and the single global
 * system-audio hotkey.
 *
 * The hotkey callback is registered inside `useSystemAudio` (a hook instance
 * that knows nothing about Live), while the Live session and its accumulated
 * interlocutor transcript live in the `SystemAudio` component (via
 * `useDeepgramStreaming`). This module-level singleton lets the component
 * publish "is a Live session active, and here's how to fire the AI on the
 * interlocutor's transcript", which the hotkey callback reads.
 *
 * It's a plain ref-style store (no React state / no subscribers) — mirrors the
 * pattern of the global system-audio callback in `useGlobalShortcuts`. Reading
 * it inside the hotkey callback body means the callback's effect deps don't
 * change, so the hotkey isn't re-registered on every Live update.
 */

type LiveBridge = {
  /** Whether a Live streaming session is currently active. */
  isStreaming: boolean;
  /**
   * Fire the AI over the accumulated interlocutor transcript (and reset the
   * accumulation). Supplied by the SystemAudio component. No-op by default.
   */
  fireFromHotkey: () => void | Promise<void>;
};

export const liveBridge: LiveBridge = {
  isStreaming: false,
  fireFromHotkey: () => {},
};

/** Publish (partial) Live state/handlers into the bridge. */
export function setLiveBridge(partial: Partial<LiveBridge>): void {
  Object.assign(liveBridge, partial);
}
