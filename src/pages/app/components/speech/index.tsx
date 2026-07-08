import { useState, useCallback, useEffect, useRef } from "react";
import {
  Button,
  Popover,
  PopoverAnchor,
  PopoverContent,
  ScrollArea,
  Switch,
} from "@/components";
import {
  HeadphonesIcon,
  AlertCircleIcon,
  LoaderIcon,
  AudioLinesIcon,
  CameraIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { ModeSwitcher, type CaptureMode } from "./ModeSwitcher";
import { RecordingPanel } from "./RecordingPanel";
import { ResultsSection } from "./ResultsSection";
import { LiveResponse } from "./LiveResponse";
import { PermissionFlow } from "./PermissionFlow";
import { QuickActions } from "./QuickActions";
import { LiveTranscription } from "./LiveTranscription";
import {
  useSystemAudioType,
  useDeepgramStreaming,
  setWindowForceExpanded,
  setLiveBridge,
} from "@/hooks";
import { useApp } from "@/contexts";
import { cn } from "@/lib/utils";
import type { Message } from "@/types/completion";
import { STORAGE_KEYS } from "@/config/constants";

export const SystemAudio = (props: useSystemAudioType) => {
  const {
    capturing,
    isProcessing,
    isAIProcessing,
    lastTranscription,
    hasAIResponse,
    error,
    discardedNotice,
    autoRespond,
    setAutoRespond,
    pendingTranscript,
    setupRequired,
    startCapture,
    stopCapture,
    isPopoverOpen,
    setIsPopoverOpen,
    startNewConversation,
    conversation,
    resizeWindow,
    quickActions,
    addQuickAction,
    removeQuickAction,
    isManagingQuickActions,
    setIsManagingQuickActions,
    showQuickActions,
    setShowQuickActions,
    handleQuickActionClick,
    vadConfig,
    updateVadConfiguration,
    isRecordingInContinuousMode,
    recordingProgress,
    manualStopAndSend,
    startContinuousRecording,
    ignoreContinuousRecording,
    scrollAreaRef,
    processWithAI,
    buildEffectiveSystemPrompt,
  } = props;

  const { supportsImages, selectedSttProvider, selectedAudioDevices } =
    useApp();

  const dg = useDeepgramStreaming();

  // View mode toggle
  const [conversationMode, setConversationMode] = useState(false);

  // Screenshot state
  const [screenshotImage, setScreenshotImage] = useState<string | null>(null);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);

  // Live (Deepgram streaming) mode toggle (#31/#32), persisted across sessions
  const [liveMode, setLiveModeState] = useState(
    () => localStorage.getItem("system_audio_live_mode") === "true"
  );
  const [liveConfigError, setLiveConfigError] = useState("");

  const setLiveMode = (value: boolean) => {
    setLiveModeState(value);
    localStorage.setItem("system_audio_live_mode", String(value));
    // Turning Live off while a session is (or looks) active stops it, so the
    // toggle can always recover from a stuck streaming state.
    if (!value && dg.isStreaming) {
      void dg.stopStreaming();
    }
    setLiveConfigError("");
  };

  // --- AI responses in Live mode (point 1) ---------------------------------
  // Only the INTERLOCUTOR (channel 1) is treated as "a question to answer"; the
  // user's own voice (channel 0) is included only as context. The AI fires
  // either on the global hotkey (default) or automatically per interlocutor
  // turn when "Hands-free" is on.

  // "Hands-free": auto-respond on each interlocutor turn (default OFF → hotkey).
  const [handsFree, setHandsFreeState] = useState(
    () => localStorage.getItem(STORAGE_KEYS.SYSTEM_AUDIO_HANDS_FREE) === "true"
  );
  const setHandsFree = (value: boolean) => {
    setHandsFreeState(value);
    localStorage.setItem(STORAGE_KEYS.SYSTEM_AUDIO_HANDS_FREE, String(value));
  };

  // How long (ms) the interlocutor must stay silent after finishing a turn
  // before hands-free fires the AI. This is what lets them pause mid-thought
  // without the AI jumping in: each new final restarts the timer, so we only
  // fire once they've genuinely stopped. Configurable; clamped to a sane range.
  const [turnDebounceMs, setTurnDebounceMsState] = useState<number>(() => {
    const raw = Number(
      localStorage.getItem(STORAGE_KEYS.SYSTEM_AUDIO_TURN_DEBOUNCE_MS)
    );
    return Number.isFinite(raw) && raw > 0 ? raw : 1200;
  });
  const setTurnDebounceMs = (value: number) => {
    const clamped = Math.min(5000, Math.max(300, Math.round(value)));
    setTurnDebounceMsState(clamped);
    localStorage.setItem(
      STORAGE_KEYS.SYSTEM_AUDIO_TURN_DEBOUNCE_MS,
      String(clamped)
    );
  };

  // Live transcription language. "multi" = Deepgram code-switching (its default,
  // more false positives); "en"/"es" restrict to a single language (Deepgram
  // won't transcribe other languages → far fewer false positives). Pick per
  // interview since the language is usually known up front.
  const [liveLanguage, setLiveLanguageState] = useState<string>(
    () => localStorage.getItem(STORAGE_KEYS.SYSTEM_AUDIO_LIVE_LANGUAGE) || "multi"
  );
  const setLiveLanguage = (value: string) => {
    setLiveLanguageState(value);
    localStorage.setItem(STORAGE_KEYS.SYSTEM_AUDIO_LIVE_LANGUAGE, value);
  };

  // Id of the newest final already sent to the AI, so the same interlocutor
  // turn is never answered twice (advanced synchronously at fire time).
  const consumedFinalIdRef = useRef<number>(-1);
  // Pending hands-free auto-fire timer (the turn-debounce). Restarted on every
  // fresh interlocutor final so we only fire after real silence.
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of isAIProcessing for the fire guard. Set to true synchronously in
  // fireLiveAI (so a second turn arriving before React commits the state can't
  // slip past the guard) and kept in sync by the effect below (true→false when
  // the response actually finishes).
  const isAIProcessingRef = useRef<boolean>(isAIProcessing);
  useEffect(() => {
    isAIProcessingRef.current = isAIProcessing;
  }, [isAIProcessing]);
  // Read finals from a ref so fireLiveAI/buildLiveHistory don't need `dg.finals`
  // in their deps: the hotkey (via the bridge) always sees the freshest finals,
  // and they don't churn on every transcript. (fireLiveAI still changes identity
  // when processWithAI does — i.e. after each answer, since processWithAI closes
  // over conversation.messages — but that's harmless: the effects it feeds are
  // idempotent.)
  const finalsRef = useRef(dg.finals);
  useEffect(() => {
    finalsRef.current = dg.finals;
  }, [dg.finals]);

  // Build the AI history from the transcript already CONSUMED (id <= upto), so
  // the fresh interlocutor turn being asked about isn't duplicated (it goes only
  // as the userMessage). Both speakers map to `user` (providers reliably support
  // only user/assistant); the "Interlocutor:"/"Me:" prefix carries the "who", so
  // the user's own words are context, not something the model thinks it said.
  const buildLiveHistory = useCallback((upto: number): Message[] => {
    const now = Date.now();
    return finalsRef.current
      .filter((f) => f.id <= upto)
      .map((f, i) => {
        const who = f.channel === 1 ? "Interlocutor" : "Me";
        return {
          id: `live-${f.id}`,
          role: "user" as const,
          content: `${who}: ${f.text}`,
          timestamp: now + i,
        };
      });
  }, []);

  // Fire the AI over the interlocutor text accumulated since the last response.
  // Shared by the hotkey and the hands-free auto-fire. No-op if nothing pending
  // or a response is already streaming (turns that arrive mid-answer are ignored
  // until it finishes).
  const fireLiveAI = useCallback(async () => {
    if (isAIProcessingRef.current) return;
    const finals = finalsRef.current;
    const prevMarker = consumedFinalIdRef.current;
    const fresh = finals.filter(
      (f) => f.channel === 1 && f.id > prevMarker
    );
    const question = fresh
      .map((f) => f.text)
      .join(" ")
      .trim();
    if (!question) return;
    // Advance the marker only as far as the newest INTERLOCUTOR final we actually
    // included in `question` — NOT the global max. Advancing past a final whose
    // text we didn't send would silently drop that turn if it raced in at fire
    // time; capping at the consumed interlocutor id means any later-arriving turn
    // stays "fresh" and gets answered on the next debounce window. Set the
    // in-flight guard synchronously too, so a turn landing in the gap can't
    // double-fire or abort this answer.
    consumedFinalIdRef.current = fresh[fresh.length - 1].id;
    isAIProcessingRef.current = true;
    // History = everything already consumed (context); the fresh interlocutor
    // turn is the userMessage only, so it isn't sent twice.
    const history = buildLiveHistory(prevMarker);
    await processWithAI(question, buildEffectiveSystemPrompt(), history);
  }, [buildLiveHistory, processWithAI, buildEffectiveSystemPrompt]);

  // Reset the consumed marker whenever a session (re)starts. -1 is below every
  // possible final id, so it's a safe floor even though Deepgram's id counter is
  // monotonic across sessions.
  useEffect(() => {
    if (dg.isStreaming) {
      consumedFinalIdRef.current = -1;
    }
  }, [dg.isStreaming]);

  // Publish Live state + fire handler into the bridge the hotkey reads. Re-runs
  // when the session starts/stops or fireLiveAI's identity changes (after each
  // answer); setLiveBridge is idempotent so the extra runs are harmless.
  useEffect(() => {
    setLiveBridge({ isStreaming: dg.isStreaming, fireFromHotkey: fireLiveAI });
    return () => setLiveBridge({ isStreaming: false });
  }, [dg.isStreaming, fireLiveAI]);

  // Hands-free auto-fire, DEBOUNCED: when a fresh interlocutor final arrives we
  // (re)start a timer; each new final restarts it, so the AI only fires once the
  // interlocutor has actually stopped for `turnDebounceMs`. This is what lets
  // them pause mid-sentence without the AI cutting in. Keyed on finals so it
  // re-evaluates on every transcript.
  useEffect(() => {
    if (!handsFree || !dg.isStreaming) return;
    // A response is streaming → don't schedule; the post-response effect run
    // (isAIProcessing flips false) will pick up anything new.
    if (isAIProcessing) return;
    const hasFreshInterlocutor = dg.finals.some(
      (f) => f.channel === 1 && f.id > consumedFinalIdRef.current
    );
    if (!hasFreshInterlocutor) return;

    // Restart the debounce: a newer final invalidates the previous countdown.
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      void fireLiveAI();
    }, turnDebounceMs);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [
    dg.finals,
    handsFree,
    dg.isStreaming,
    isAIProcessing,
    turnDebounceMs,
    fireLiveAI,
  ]);

  const isVadMode = vadConfig.enabled;
  const hasResponse = hasAIResponse || isAIProcessing;

  // The three capture modes are mutually exclusive, derived from the two
  // underlying flags. Live takes precedence when on.
  const captureMode: CaptureMode = liveMode
    ? "live"
    : isVadMode
    ? "auto"
    : "manual";

  const handleModeChange = async (next: CaptureMode) => {
    if (next === captureMode) return;
    // Keep the panel open across the switch so it never feels like the window
    // closed on an error. stopCapture() (below) sets isPopoverOpen(false)
    // asynchronously, so we await it and reopen afterwards — for EVERY mode, not
    // just Live.
    const wasCapturing = capturing;
    if (wasCapturing) {
      await stopCapture();
    }

    if (next === "live") {
      setLiveMode(true);
    } else {
      setLiveMode(false);
      updateVadConfiguration({ ...vadConfig, enabled: next === "auto" });
    }

    // Reopen the panel for the newly-selected mode. The resize effect above
    // keys on isPopoverOpen, so this alone keeps the window expanded and the
    // panel visible right after the switch — for every mode, not just Live.
    setIsPopoverOpen(true);
  };

  // The window height is controlled explicitly: the overlay is a ~60px bar
  // until something grows it. useSystemAudio's own effect grows it for the
  // batch pipeline (capturing/error/…), but it does NOT know about Live mode —
  // so in Live the panel would render into a window that's still 60px tall and
  // stay clipped/invisible. This effect owns the resize for the Live states
  // (mode selected, or a stream running) so the panel actually shows.
  useEffect(() => {
    const liveActive = liveMode || dg.isStreaming;
    // The window should be expanded whenever the panel is meant to be visible:
    // a Live session, an open popover (e.g. right after a mode switch, so the
    // newly-selected mode's panel shows instead of collapsing to the bar), or an
    // active batch capture / error. Pin force-expand in all those cases so the
    // DOM-polling observer in useWindowResize can't shrink it away.
    const shouldExpand =
      liveActive || isPopoverOpen || !!capturing || !!error;
    setWindowForceExpanded(shouldExpand);
    if (liveActive) {
      setIsPopoverOpen(true);
    }
    resizeWindow(shouldExpand);
  }, [
    liveMode,
    dg.isStreaming,
    isPopoverOpen,
    capturing,
    error,
    setIsPopoverOpen,
    resizeWindow,
  ]);

  // Keyboard shortcut for Cmd+K to toggle view mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPopoverOpen) return;

      // Cmd+K or Ctrl+K to toggle view mode
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setConversationMode((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPopoverOpen]);

  // Reset screenshot when processing starts (message is being sent)
  useEffect(() => {
    if (isProcessing && screenshotImage) {
      setScreenshotImage(null);
    }
  }, [isProcessing, screenshotImage]);

  // Start a Deepgram live session using the configured provider's key/model.
  const startLive = async () => {
    setLiveConfigError("");
    const apiKey = selectedSttProvider.variables["api_key"];
    const model = selectedSttProvider.variables["model"] || "nova-3";
    if (!apiKey) {
      setLiveConfigError(
        "Set a Deepgram API key in Settings to use Live mode."
      );
      setIsPopoverOpen(true);
      return;
    }

    // Live is a unified two-channel session that captures the microphone, which
    // is a separate macOS permission from system-audio capture. Prompt for it up
    // front so the user gets the OS dialog instead of a raw cpal failure.
    const platform = navigator.platform.toLowerCase();
    if (platform.includes("mac")) {
      try {
        const { checkMicrophonePermission, requestMicrophonePermission } =
          await import("tauri-plugin-macos-permissions-api");
        const hasMic = await checkMicrophonePermission();
        if (!hasMic) {
          await requestMicrophonePermission();
          setLiveConfigError(
            "Grant microphone access, then press Start again to begin the live session."
          );
          setIsPopoverOpen(true);
          return;
        }
      } catch (err) {
        console.error("Microphone permission check failed:", err);
        // Non-fatal: fall through and let the backend surface any error.
      }
    }
    const deviceId =
      selectedAudioDevices.output.id &&
      selectedAudioDevices.output.id !== "default"
        ? selectedAudioDevices.output.id
        : undefined;
    // Live is a unified two-channel session (#34): also pass the mic input so
    // the backend captures "You" (mic, ch 0) alongside "Interlocutor" (system,
    // ch 1). Falls back to the default input device if none is selected.
    const inputDeviceId =
      selectedAudioDevices.input.id &&
      selectedAudioDevices.input.id !== "default"
        ? selectedAudioDevices.input.id
        : undefined;
    await dg.startStreaming(
      { apiKey, model, language: liveLanguage, diarize: false },
      deviceId,
      inputDeviceId
    );
  };

  const handleToggleCapture = async () => {
    if (liveMode) {
      // The Live panel has its own Start/Stop, but the header button should
      // still open the panel (and start/stop as a convenience).
      setIsPopoverOpen(true);
      if (dg.isStreaming) {
        await dg.stopStreaming();
      } else {
        await startLive();
      }
      return;
    }

    if (capturing) {
      await stopCapture();
    } else {
      await startCapture();
    }
  };

  // Capture screenshot functionality
  const handleCaptureScreenshot = useCallback(async () => {
    if (isCapturingScreenshot) return;

    setIsCapturingScreenshot(true);
    try {
      // Check screen recording permission on macOS
      const platform = navigator.platform.toLowerCase();
      if (platform.includes("mac")) {
        const {
          checkScreenRecordingPermission,
          requestScreenRecordingPermission,
        } = await import("tauri-plugin-macos-permissions-api");

        const hasPermission = await checkScreenRecordingPermission();
        if (!hasPermission) {
          await requestScreenRecordingPermission();
          setIsCapturingScreenshot(false);
          return;
        }
      }

      // Capture screenshot. The backend command is `capture_to_base64` (it
      // captures the screen the overlay is on and returns base64) — the old
      // `capture_screenshot` name never existed as a Tauri command, so this
      // button used to throw "command not found" at runtime.
      const base64: string = await invoke("capture_to_base64");

      setScreenshotImage(base64);
    } catch (err) {
      console.error("Failed to capture screenshot:", err);
    } finally {
      setIsCapturingScreenshot(false);
    }
  }, [isCapturingScreenshot]);

  const handleRemoveScreenshot = useCallback(() => {
    setScreenshotImage(null);
  }, []);

  const getButtonIcon = () => {
    if (setupRequired) return <AlertCircleIcon className="text-orange-500" />;
    if (error && !setupRequired)
      return <AlertCircleIcon className="text-red-500" />;
    if (dg.isStreaming)
      return <AudioLinesIcon className="text-red-500 animate-pulse" />;
    if (isProcessing) return <LoaderIcon className="animate-spin" />;
    if (capturing)
      return <AudioLinesIcon className="text-green-500 animate-pulse" />;
    return <HeadphonesIcon />;
  };

  const getButtonTitle = () => {
    if (setupRequired) return "Setup required - Click for instructions";
    if (error && !setupRequired) return `Error: ${error}`;
    if (dg.isStreaming) return "Live transcription — click to stop";
    if (isProcessing) return "Transcribing audio...";
    if (capturing) return "Stop system audio capture";
    return "Start system audio capture";
  };

  return (
    <Popover
      open={isPopoverOpen}
      onOpenChange={(open) => {
        // Don't let an outside-click / Escape dismiss the popover while a
        // capture OR a live-streaming session is active.
        if ((capturing || dg.isStreaming) && !open) {
          return;
        }
        setIsPopoverOpen(open);
      }}
    >
      {/* Anchor (not Trigger): the button does NOT toggle the popover itself —
          that fought with handleToggleCapture and Radix's own toggle, leaving
          the panel closed. The popover is controlled purely by isPopoverOpen,
          and the button decides what to do (open panel, start/stop capture or
          streaming) explicitly. */}
      <PopoverAnchor asChild>
        <Button
          size="icon"
          title={getButtonTitle()}
          onClick={handleToggleCapture}
          className={cn(
            capturing && "bg-green-50 hover:bg-green-100",
            error && "bg-red-100 hover:bg-red-200"
          )}
        >
          {getButtonIcon()}
        </Button>
      </PopoverAnchor>

      {(capturing ||
        dg.isStreaming ||
        liveMode ||
        setupRequired ||
        error) && (
        <PopoverContent
          align="end"
          side="bottom"
          className="select-none w-screen p-0 border shadow-lg overflow-hidden border-input/50"
          sideOffset={8}
        >
          <div className="flex flex-col h-[calc(100vh-4rem)] overflow-hidden">
            {/* Header - Mode Switcher + Actions */}
            <div className="flex-shrink-0 p-3 border-b border-border/50">
              <div className="flex items-center justify-between gap-2">
                {/* One selector for the 3 mutually-exclusive capture modes,
                    plus the Auto-respond modifier which only applies to
                    Auto-detect (#25). Mode can't be switched mid-session. */}
                {!setupRequired && (
                  <div className="flex items-center gap-2 min-w-0">
                    {/* Mode can be switched while the overlay is open/capturing
                        — handleModeChange stops any live stream and flips the VAD
                        flag as needed. Only lock it during an in-flight continuous
                        recording or while processing, so a mode change can't
                        corrupt a segment mid-capture. */}
                    <ModeSwitcher
                      mode={captureMode}
                      onModeChange={handleModeChange}
                      disabled={
                        isRecordingInContinuousMode ||
                        isProcessing ||
                        isAIProcessing
                      }
                    />
                    {captureMode === "auto" && (
                      <label
                        className="flex items-center gap-1.5 cursor-pointer select-none"
                        title="When off, speech is only transcribed into a timeline; press the system-audio hotkey to ask the AI"
                      >
                        <Switch
                          checked={autoRespond}
                          onCheckedChange={setAutoRespond}
                          className="scale-75"
                        />
                        <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                          Auto-respond
                        </span>
                      </label>
                    )}
                  </div>
                )}
                {setupRequired && (
                  <h2 className="font-semibold text-sm">Setup Required</h2>
                )}

                {/* Action Buttons */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {/* Screenshot Button */}
                  {!setupRequired && supportsImages && (
                    <Button
                      size="sm"
                      variant={screenshotImage ? "default" : "outline"}
                      onClick={handleCaptureScreenshot}
                      disabled={isCapturingScreenshot}
                      className={cn(
                        "h-6 text-[10px] gap-1 px-2",
                        screenshotImage && "bg-primary text-primary-foreground"
                      )}
                      title="Capture screenshot to include with transcription"
                    >
                      {isCapturingScreenshot ? (
                        <LoaderIcon className="w-3 h-3 animate-spin" />
                      ) : (
                        <CameraIcon className="w-3 h-3" />
                      )}
                      Screenshot
                    </Button>
                  )}

                  {/* New Conversation Button */}
                  {!setupRequired && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={startNewConversation}
                      className="h-6 text-[10px] gap-1 px-2"
                      title="Start a new conversation"
                    >
                      <PlusIcon className="w-3 h-3" />
                      New
                    </Button>
                  )}

                  {/* Close Button — hidden during capture or live streaming */}
                  {!capturing && !dg.isStreaming && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      title="Close"
                      onClick={() => {
                        setIsPopoverOpen(false);
                        resizeWindow(false);
                      }}
                    >
                      <XIcon className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </div>

            <ScrollArea className="flex-1 min-h-0" ref={scrollAreaRef}>
              <div className="p-2 space-y-2">
                {/* Screenshot Preview */}
                {screenshotImage && (
                  <div className="flex items-center gap-2 p-2 rounded-lg bg-primary/5 border border-primary/20">
                    <img
                      src={`data:image/png;base64,${screenshotImage}`}
                      alt="Screenshot"
                      className="h-12 w-20 object-cover rounded"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] font-medium">
                        Screenshot attached
                      </p>
                      <p className="text-[9px] text-muted-foreground">
                        Will be sent with next transcription
                      </p>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-5 w-5"
                      onClick={handleRemoveScreenshot}
                    >
                      <XIcon className="h-3 w-3" />
                    </Button>
                  </div>
                )}

                {/* Error Display */}
                {error && !setupRequired && (
                  <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-50 border border-red-200">
                    <AlertCircleIcon className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[10px] font-medium text-red-800">
                        Error
                      </p>
                      <p className="text-[10px] text-red-700">{error}</p>
                    </div>
                  </div>
                )}

                {/* Discarded-segment notice (#24) — subtle, auto-clearing */}
                {discardedNotice && !error && !setupRequired && (
                  <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-muted/40 border border-border/50 animate-in fade-in">
                    <AlertCircleIcon className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                    <p className="text-[10px] text-muted-foreground">
                      {discardedNotice}
                    </p>
                  </div>
                )}

                {/* Setup Required - Permission Flow */}
                {setupRequired ? (
                  <PermissionFlow
                    onPermissionGranted={() => {
                      startCapture();
                    }}
                    onPermissionDenied={() => {
                      // Keep showing setup instructions
                    }}
                  />
                ) : liveMode ? (
                  <>
                    {/* When a response is showing, put "Say this" FIRST so the
                        eyes land on what to read aloud; the transcript collapses
                        below it. Otherwise (no answer yet) the transcript stays
                        on top as the primary surface. */}
                    {(hasAIResponse || isAIProcessing) && (
                      <LiveResponse isAIProcessing={isAIProcessing} />
                    )}

                    <LiveTranscription
                      isStreaming={dg.isStreaming}
                      connected={dg.connected}
                      error={dg.error || liveConfigError}
                      finals={dg.finals}
                      interims={dg.interims}
                      micMuted={dg.micMuted}
                      onToggleMic={() => dg.toggleMicMuted()}
                      handsFree={handsFree}
                      onToggleHandsFree={setHandsFree}
                      turnDebounceMs={turnDebounceMs}
                      onChangeDebounce={setTurnDebounceMs}
                      language={liveLanguage}
                      onChangeLanguage={setLiveLanguage}
                      collapsed={hasAIResponse || isAIProcessing}
                      onStart={startLive}
                      onStop={() => dg.stopStreaming()}
                    />
                  </>
                ) : (
                  <>
                    {/* Recording Panel */}
                    <RecordingPanel
                      isVadMode={isVadMode}
                      isRecording={isRecordingInContinuousMode}
                      isProcessing={isProcessing}
                      isAIProcessing={isAIProcessing}
                      recordingProgress={recordingProgress}
                      maxDuration={vadConfig.max_recording_duration_secs}
                      onStartRecording={startContinuousRecording}
                      onStopAndSend={manualStopAndSend}
                      onIgnore={ignoreContinuousRecording}
                    />

                    {/* Pending transcript timeline (#25): only in Auto-detect
                        with Auto-respond off, while nothing is being answered */}
                    {isVadMode &&
                      !autoRespond &&
                      pendingTranscript &&
                      !isAIProcessing && (
                        <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-medium text-primary uppercase tracking-wide">
                              Transcript
                            </span>
                            <span className="text-[9px] text-muted-foreground">
                              Press the system-audio hotkey to ask the AI
                            </span>
                          </div>
                          <p className="text-[11px] whitespace-pre-wrap text-foreground/80">
                            {pendingTranscript}
                          </p>
                        </div>
                      )}

                    {/* AI Response — reads streaming text from the store itself */}
                    <ResultsSection
                      lastTranscription={lastTranscription}
                      isAIProcessing={isAIProcessing}
                      conversation={conversation}
                      conversationMode={conversationMode}
                      setConversationMode={setConversationMode}
                    />
                  </>
                )}
              </div>
            </ScrollArea>

            {/* Quick Actions */}
            {!setupRequired && hasResponse && (
              <div className="flex-shrink-0 border-t border-border/50 p-2">
                <QuickActions
                  actions={quickActions}
                  onActionClick={handleQuickActionClick}
                  onAddAction={addQuickAction}
                  onRemoveAction={removeQuickAction}
                  isManaging={isManagingQuickActions}
                  setIsManaging={setIsManagingQuickActions}
                  show={showQuickActions}
                  setShow={setShowQuickActions}
                />
              </div>
            )}
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
};
