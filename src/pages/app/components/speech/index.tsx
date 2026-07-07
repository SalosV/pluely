import { useState, useCallback, useEffect } from "react";
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
import { PermissionFlow } from "./PermissionFlow";
import { QuickActions } from "./QuickActions";
import { LiveTranscription } from "./LiveTranscription";
import {
  useSystemAudioType,
  useDeepgramStreaming,
  setWindowForceExpanded,
} from "@/hooks";
import { useApp } from "@/contexts";
import { cn } from "@/lib/utils";

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

  const isVadMode = vadConfig.enabled;
  const hasResponse = hasAIResponse || isAIProcessing;

  // The three capture modes are mutually exclusive, derived from the two
  // underlying flags. Live takes precedence when on.
  const captureMode: CaptureMode = liveMode
    ? "live"
    : isVadMode
    ? "auto"
    : "manual";

  const handleModeChange = (next: CaptureMode) => {
    if (next === captureMode) return;
    // Switching modes ends whatever session is currently running so two
    // pipelines can't overlap: a live stream is stopped by setLiveMode(false),
    // and an in-progress batch capture is stopped here.
    if (capturing) {
      void stopCapture();
    }
    if (next === "live") {
      setLiveMode(true);
      // stopCapture() above closes the popover; reopen it so the Live panel
      // (with its Start button and any config error) stays visible.
      setIsPopoverOpen(true);
    } else {
      setLiveMode(false);
      updateVadConfiguration({ ...vadConfig, enabled: next === "auto" });
    }
  };

  // The window height is controlled explicitly: the overlay is a ~60px bar
  // until something grows it. useSystemAudio's own effect grows it for the
  // batch pipeline (capturing/error/…), but it does NOT know about Live mode —
  // so in Live the panel would render into a window that's still 60px tall and
  // stay clipped/invisible. This effect owns the resize for the Live states
  // (mode selected, or a stream running) so the panel actually shows.
  useEffect(() => {
    const liveActive = liveMode || dg.isStreaming;
    // Pin the window expanded while Live is active so the DOM-polling observer
    // in useWindowResize can't shrink it out from under the panel.
    setWindowForceExpanded(liveActive);
    if (liveActive) {
      setIsPopoverOpen(true);
      resizeWindow(true);
    } else {
      // Left Live: unpin and let the hook's own effect decide the size.
      resizeWindow(!!capturing || !!error);
    }
  }, [
    liveMode,
    dg.isStreaming,
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
    const deviceId =
      selectedAudioDevices.output.id &&
      selectedAudioDevices.output.id !== "default"
        ? selectedAudioDevices.output.id
        : undefined;
    await dg.startStreaming(
      { apiKey, model, language: "multi", diarize: true },
      deviceId
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
                  <LiveTranscription
                    isStreaming={dg.isStreaming}
                    connected={dg.connected}
                    error={dg.error || liveConfigError}
                    finals={dg.finals}
                    interim={dg.interim}
                    onStart={startLive}
                    onStop={() => dg.stopStreaming()}
                  />
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
