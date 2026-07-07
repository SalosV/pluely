import { useEffect, useState, useCallback, useRef } from "react";
import { useWindowResize, useGlobalShortcuts } from ".";
import { setStreamingResponse } from "./useStreamingResponse";
import { liveBridge } from "./useLiveAIBridge";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/contexts";
import { fetchSTT, fetchAIResponse } from "@/lib/functions";
import {
  DEFAULT_QUICK_ACTIONS,
  DEFAULT_SYSTEM_PROMPT,
  STORAGE_KEYS,
} from "@/config";
import {
  safeLocalStorage,
  generateConversationTitle,
  saveConversation,
  CONVERSATION_SAVE_DEBOUNCE_MS,
  generateConversationId,
  generateMessageId,
} from "@/lib";
import { useVadConfigStore, useSystemAudioContextStore } from ".";
import { Message } from "@/types/completion";

// VAD config type/defaults now live in the shared storage layer; re-exported
// here to keep existing import paths (`@/hooks/useSystemAudio`) working.
export type { VadConfig } from "@/lib";

// Chat message interface (reusing from useCompletion)
interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

// Conversation interface (reusing from useCompletion)
export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export type useSystemAudioType = ReturnType<typeof useSystemAudio>;

export function useSystemAudio() {
  const { resizeWindow } = useWindowResize();
  const globalShortcuts = useGlobalShortcuts();
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAIProcessing, setIsAIProcessing] = useState(false);
  const [lastTranscription, setLastTranscription] = useState<string>("");
  // The streaming response TEXT lives in an external store (useStreamingResponse)
  // so appending tokens doesn't re-render the whole overlay. Here we only keep a
  // lightweight boolean for show/hide + resize logic, which flips at most twice
  // per response instead of once per token.
  const [hasAIResponse, setHasAIResponse] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  // Transient notice shown when the VAD discards a too-short segment (#24), so
  // the user understands why no response is coming. Auto-clears.
  const [discardedNotice, setDiscardedNotice] = useState<string>("");
  // "Auto-respond" toggle (#25). When true (default), each detected segment is
  // transcribed AND sent to the AI. When false, segments only accumulate as a
  // visible transcript timeline; the user fires the AI on demand via the global
  // hotkey. Useful in long sessions to avoid ~60 AI calls/hour.
  const [autoRespond, setAutoRespondState] = useState<boolean>(() => {
    const stored = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_AUTO_RESPOND
    );
    return stored === null ? true : stored === "true";
  });
  // Accumulated transcript while auto-respond is off, shown as a timeline.
  const [pendingTranscript, setPendingTranscript] = useState<string>("");
  const [setupRequired, setSetupRequired] = useState<boolean>(false);
  const [quickActions, setQuickActions] = useState<string[]>([]);
  const [isManagingQuickActions, setIsManagingQuickActions] =
    useState<boolean>(false);
  const [showQuickActions, setShowQuickActions] = useState<boolean>(true);
  // VAD config lives in a shared store (localStorage + backend sync), so the
  // dashboard settings page and this overlay hook stay in sync.
  const { vadConfig, updateVadConfig: updateVadConfiguration } =
    useVadConfigStore();
  const [recordingProgress, setRecordingProgress] = useState<number>(0); // For continuous mode
  const [isContinuousMode, setIsContinuousMode] = useState<boolean>(false);
  const [isRecordingInContinuousMode, setIsRecordingInContinuousMode] =
    useState<boolean>(false);

  const [conversation, setConversation] = useState<ChatConversation>({
    id: "",
    title: "",
    messages: [],
    createdAt: 0,
    updatedAt: 0,
  });

  // Context management (shared store: localStorage + cross-window sync)
  const {
    useSystemPrompt,
    contextContent,
    setUseSystemPrompt: updateUseSystemPrompt,
    setContextContent: updateContextContent,
  } = useSystemAudioContextStore();

  const {
    selectedSttProvider,
    allSttProviders,
    selectedAIProvider,
    allAiProviders,
    systemPrompt,
    selectedAudioDevices,
  } = useApp();
  const abortControllerRef = useRef<AbortController | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isSavingRef = useRef<boolean>(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const discardedTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Refs mirror auto-respond state so the speech handler and the global-hotkey
  // callback read the freshest value without being rebuilt on every change.
  const autoRespondRef = useRef<boolean>(autoRespond);
  const pendingTranscriptRef = useRef<string>("");
  // Holds the latest speech-detected handler so the Tauri listener can be
  // registered exactly once (empty deps) yet always call fresh state/providers.
  // Previously the effect re-registered on every message, opening a window
  // where two listeners were live at once and each spoken segment was
  // transcribed + sent to the AI twice.
  const speechHandlerRef = useRef<
    ((event: { payload: unknown }) => void | Promise<void>) | null
  >(null);

  // Persist the auto-respond toggle and keep its ref in sync (#25).
  const setAutoRespond = useCallback((value: boolean) => {
    setAutoRespondState(value);
    autoRespondRef.current = value;
    safeLocalStorage.setItem(
      STORAGE_KEYS.SYSTEM_AUDIO_AUTO_RESPOND,
      String(value)
    );
  }, []);

  // Single source of truth for the AI system prompt: the user's custom system
  // prompt when enabled, otherwise the context content, falling back to the
  // default. Used by every code path that calls processWithAI (batch quick
  // actions, batch speech, the hotkey, and Live).
  const buildEffectiveSystemPrompt = useCallback((): string => {
    return useSystemPrompt
      ? systemPrompt || DEFAULT_SYSTEM_PROMPT
      : contextContent || DEFAULT_SYSTEM_PROMPT;
  }, [useSystemPrompt, systemPrompt, contextContent]);

  // Keep pendingTranscriptRef mirroring the state for the hotkey callback.
  useEffect(() => {
    pendingTranscriptRef.current = pendingTranscript;
  }, [pendingTranscript]);

  // VAD config and context settings are loaded from localStorage by their
  // shared stores (useVadConfigStore / useSystemAudioContextStore) on mount.

  // Load quick actions from localStorage on mount
  useEffect(() => {
    const savedActions = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_AUDIO_QUICK_ACTIONS
    );
    if (savedActions) {
      try {
        const parsed = JSON.parse(savedActions);
        setQuickActions(parsed);
      } catch (error) {
        console.error("Failed to load quick actions:", error);
        setQuickActions(DEFAULT_QUICK_ACTIONS);
      }
    } else {
      setQuickActions(DEFAULT_QUICK_ACTIONS);
    }
  }, []);

  // Handle continuous recording progress events AND error events
  useEffect(() => {
    let progressUnlisten: (() => void) | undefined;
    let startUnlisten: (() => void) | undefined;
    let stopUnlisten: (() => void) | undefined;
    let errorUnlisten: (() => void) | undefined;
    let discardedUnlisten: (() => void) | undefined;

    const setupContinuousListeners = async () => {
      try {
        // Progress updates (every second)
        progressUnlisten = await listen("recording-progress", (event) => {
          const seconds = event.payload as number;
          setRecordingProgress(seconds);
        });

        // Recording started
        startUnlisten = await listen("continuous-recording-start", () => {
          setRecordingProgress(0);
          setIsRecordingInContinuousMode(true);
        });

        // Recording stopped
        stopUnlisten = await listen("continuous-recording-stopped", () => {
          setRecordingProgress(0);
          setIsRecordingInContinuousMode(false);
        });

        // Audio encoding errors
        errorUnlisten = await listen("audio-encoding-error", (event) => {
          const errorMsg = event.payload as string;
          console.error("Audio encoding error:", errorMsg);
          setError(`Failed to process audio: ${errorMsg}`);
          setIsProcessing(false);
          setIsAIProcessing(false);
          setIsRecordingInContinuousMode(false);
        });

        // Speech discarded (too short). Not an error, but surface a subtle,
        // self-clearing notice so the user isn't left waiting for a response
        // that will never come (#24).
        discardedUnlisten = await listen("speech-discarded", () => {
          setDiscardedNotice("Ignored — too short (likely background noise)");
          if (discardedTimeoutRef.current) {
            clearTimeout(discardedTimeoutRef.current);
          }
          discardedTimeoutRef.current = setTimeout(
            () => setDiscardedNotice(""),
            2500
          );
        });
      } catch (err) {
        console.error("Failed to setup continuous recording listeners:", err);
      }
    };

    setupContinuousListeners();

    return () => {
      if (progressUnlisten) progressUnlisten();
      if (startUnlisten) startUnlisten();
      if (stopUnlisten) stopUnlisten();
      if (errorUnlisten) errorUnlisten();
      if (discardedUnlisten) discardedUnlisten();
    };
  }, []);

  // Register the speech-detected listener exactly once. The actual work is
  // delegated to speechHandlerRef, which an effect below keeps pointed at a
  // fresh closure — so state/providers stay current without ever having two
  // listeners registered simultaneously.
  useEffect(() => {
    let speechUnlisten: (() => void) | undefined;
    let cancelled = false;

    const setupEventListener = async () => {
      try {
        const unlisten = await listen("speech-detected", (event) => {
          void speechHandlerRef.current?.(event);
        });
        // If the effect was cleaned up while awaiting, unlisten immediately so
        // no stale listener survives.
        if (cancelled) {
          unlisten();
          return;
        }
        speechUnlisten = unlisten;
      } catch (err) {
        setError("Failed to setup speech listener");
      }
    };

    setupEventListener();

    return () => {
      cancelled = true;
      if (speechUnlisten) speechUnlisten();
    };
  }, []);

  // Context settings are managed by useSystemAudioContextStore (its setters are
  // aliased above as updateUseSystemPrompt / updateContextContent).

  // Quick actions management
  const saveQuickActions = useCallback((actions: string[]) => {
    try {
      safeLocalStorage.setItem(
        STORAGE_KEYS.SYSTEM_AUDIO_QUICK_ACTIONS,
        JSON.stringify(actions)
      );
    } catch (error) {
      console.error("Failed to save quick actions:", error);
    }
  }, []);

  const addQuickAction = useCallback(
    (action: string) => {
      if (action && !quickActions.includes(action)) {
        const newActions = [...quickActions, action];
        setQuickActions(newActions);
        saveQuickActions(newActions);
      }
    },
    [quickActions, saveQuickActions]
  );

  const removeQuickAction = useCallback(
    (action: string) => {
      const newActions = quickActions.filter((a) => a !== action);
      setQuickActions(newActions);
      saveQuickActions(newActions);
    },
    [quickActions, saveQuickActions]
  );

  const handleQuickActionClick = async (action: string) => {
    setError("");

    const effectiveSystemPrompt = buildEffectiveSystemPrompt();

    // Include the most recent transcription in conversation history if it exists
    let updatedMessages = [...conversation.messages];

    if (lastTranscription && lastTranscription.trim()) {
      const lastMessage = updatedMessages[updatedMessages.length - 1];
      // Only add if it's not already the last message
      if (!lastMessage || lastMessage.content !== lastTranscription) {
        const timestamp = Date.now();
        const userMessage = {
          id: generateMessageId("user", timestamp),
          role: "user" as const,
          content: lastTranscription,
          timestamp,
        };
        updatedMessages.push(userMessage);

        // Update conversation state with the latest transcription
        setConversation((prev) => ({
          ...prev,
          messages: [userMessage, ...prev.messages],
          updatedAt: timestamp,
          title: prev.title || generateConversationTitle(lastTranscription),
        }));
      }
    }

    const previousMessages = updatedMessages.map((msg) => {
      return { role: msg.role, content: msg.content };
    });

    await processWithAI(action, effectiveSystemPrompt, previousMessages);
  };

  // Start continuous recording manually
  const startContinuousRecording = useCallback(async () => {
    try {
      setRecordingProgress(0);
      setError("");

      const deviceId =
        selectedAudioDevices.output.id !== "default"
          ? selectedAudioDevices.output.id
          : null;

      // Start a new continuous recording session
      await invoke<string>("start_system_audio_capture", {
        vadConfig: vadConfig,
        deviceId: deviceId,
      });
    } catch (err) {
      console.error("Failed to start continuous recording:", err);
      setError(`Failed to start recording: ${err}`);
    }
  }, [vadConfig, selectedAudioDevices.output.id]);

  // Ignore current recording (stop without transcription)
  const ignoreContinuousRecording = useCallback(async () => {
    try {
      if (!isContinuousMode || !isRecordingInContinuousMode) return;

      // Stop the capture without processing
      await invoke<string>("stop_system_audio_capture");

      // Reset states
      setRecordingProgress(0);
      setIsProcessing(false);
      setIsRecordingInContinuousMode(false);
    } catch (err) {
      console.error("Failed to ignore recording:", err);
      setError(`Failed to ignore recording: ${err}`);
    }
  }, [isContinuousMode, isRecordingInContinuousMode]);

  // AI Processing function
  const processWithAI = useCallback(
    async (
      transcription: string,
      prompt: string,
      previousMessages: Message[]
    ) => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      try {
        setIsAIProcessing(true);
        setStreamingResponse("");
        setHasAIResponse(false);
        setError("");

        let fullResponse = "";
        let hasResponseYet = false;

        if (!selectedAIProvider.provider) {
          setError("No AI provider selected.");
          return;
        }

        const provider = allAiProviders.find(
          (p) => p.id === selectedAIProvider.provider
        );
        if (!provider) {
          setError("AI provider config not found.");
          return;
        }

        try {
          for await (const chunk of fetchAIResponse({
            provider,
            selectedProvider: selectedAIProvider,
            systemPrompt: prompt,
            history: previousMessages,
            userMessage: transcription,
            imagesBase64: [],
            signal,
          })) {
            if (signal.aborted) break;
            fullResponse += chunk;
            // Text goes to the external store (per-token, no overlay re-render).
            setStreamingResponse(fullResponse);
            // Flip the boolean only on the first chunk.
            if (!hasResponseYet) {
              hasResponseYet = true;
              setHasAIResponse(true);
            }
          }
        } catch (aiError: any) {
          if (signal.aborted) return;
          setError(aiError.message || "Failed to get AI response");
        }

        if (signal.aborted) return;

        if (fullResponse) {
          const timestamp = Date.now();
          setConversation((prev) => ({
            ...prev,
            messages: [
              {
                id: generateMessageId("user", timestamp),
                role: "user" as const,
                content: transcription,
                timestamp,
              },
              {
                id: generateMessageId("assistant", timestamp + 1),
                role: "assistant" as const,
                content: fullResponse,
                timestamp: timestamp + 1,
              },
              ...prev.messages,
            ],
            updatedAt: timestamp,
            title: prev.title || generateConversationTitle(transcription),
          }));
        }
      } catch (err) {
        setError("Failed to get AI response");
      } finally {
        setIsAIProcessing(false);
        // No auto-restart - user manually controls when to start next recording
      }
    },
    [selectedAIProvider, allAiProviders, conversation.messages]
  );

  // The single speech-detected handler. Rebuilt whenever its inputs change and
  // stored in speechHandlerRef, so the once-registered listener always runs the
  // freshest version (see the registration effect above).
  const handleSpeechDetected = useCallback(
    async (event: { payload: unknown }) => {
      try {
        if (!capturing) return;

        const base64Audio = event.payload as string;
        // Decode the base64 WAV natively via a data: URL instead of an
        // O(n) charCodeAt loop on the main thread. For a 30s segment (up to
        // ~3.84 MB) that loop froze the UI for 150-300ms; the browser decodes
        // the data URL off the JS thread.
        const audioBlob = await fetch(`data:audio/wav;base64,${base64Audio}`).then(
          (r) => r.blob()
        );

        if (!selectedSttProvider.provider) {
          setError("No speech provider selected.");
          return;
        }

        const providerConfig = allSttProviders.find(
          (p) => p.id === selectedSttProvider.provider
        );

        if (!providerConfig) {
          setError("Speech provider config not found.");
          return;
        }

        setIsProcessing(true);

        // Add timeout wrapper for STT request (30 seconds)
        const sttPromise = fetchSTT({
          provider: providerConfig,
          selectedProvider: selectedSttProvider,
          audio: audioBlob,
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("Speech transcription timed out (30s)")),
            30000
          );
        });

        try {
          const result = await Promise.race([sttPromise, timeoutPromise]);

          // A failed transcription must NOT be forwarded to the AI as if it
          // were speech — show the error and stop.
          if (!result.ok) {
            setError(result.error);
            setIsPopoverOpen(true);
            return;
          }

          const transcription = result.text.trim();
          if (!transcription) {
            setError("Received empty transcription");
            return;
          }

          setLastTranscription(transcription);
          setError("");

          // Auto-respond OFF (#25): accumulate the transcript into the timeline
          // and stop — the user triggers the AI later via the global hotkey.
          if (!autoRespondRef.current) {
            setPendingTranscript((prev) =>
              prev ? `${prev}\n${transcription}` : transcription
            );
            setIsPopoverOpen(true);
            return;
          }

          const effectiveSystemPrompt = buildEffectiveSystemPrompt();

          const previousMessages = conversation.messages.map((msg) => {
            return { role: msg.role, content: msg.content };
          });

          await processWithAI(
            transcription,
            effectiveSystemPrompt,
            previousMessages
          );
        } catch (sttError: any) {
          // Only unexpected throws (e.g. the timeout) reach here now.
          console.error("STT Error:", sttError);
          setError(sttError.message || "Failed to transcribe audio");
          setIsPopoverOpen(true);
        }
      } catch (err) {
        setError("Failed to process speech");
      } finally {
        setIsProcessing(false);
      }
    },
    [
      capturing,
      selectedSttProvider,
      allSttProviders,
      useSystemPrompt,
      systemPrompt,
      contextContent,
      conversation.messages,
      processWithAI,
    ]
  );

  // Keep the ref pointed at the latest handler.
  useEffect(() => {
    speechHandlerRef.current = handleSpeechDetected;
  }, [handleSpeechDetected]);

  const startCapture = useCallback(async () => {
    try {
      setError("");

      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (!hasAccess) {
        setSetupRequired(true);
        setIsPopoverOpen(true);
        return;
      }

      const isContinuous = !vadConfig.enabled;

      // Set up conversation
      const conversationId = generateConversationId("sysaudio");
      setConversation({
        id: conversationId,
        title: "",
        messages: [],
        createdAt: 0,
        updatedAt: 0,
      });

      setCapturing(true);
      setIsPopoverOpen(true);
      setIsContinuousMode(isContinuous);
      setRecordingProgress(0);

      // If continuous mode
      if (isContinuous) {
        setIsRecordingInContinuousMode(false);
        return;
      }

      // VAD mode: Start recording immediately
      // Stop any existing capture
      await invoke<string>("stop_system_audio_capture");

      const deviceId =
        selectedAudioDevices.output.id !== "default"
          ? selectedAudioDevices.output.id
          : null;

      // Start capture with VAD config
      await invoke<string>("start_system_audio_capture", {
        vadConfig: vadConfig,
        deviceId: deviceId,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setIsPopoverOpen(true);
    }
  }, [vadConfig, selectedAudioDevices.output.id]);

  const stopCapture = useCallback(async () => {
    try {
      // Abort any ongoing AI requests
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }

      // Stop the audio capture
      await invoke<string>("stop_system_audio_capture");

      // Reset ALL states
      setCapturing(false);
      setIsProcessing(false);
      setIsAIProcessing(false);
      setIsContinuousMode(false);
      setIsRecordingInContinuousMode(false);
      setRecordingProgress(0);
      setLastTranscription("");
      setStreamingResponse("");
      setHasAIResponse(false);
      setPendingTranscript("");
      setError("");
      setIsPopoverOpen(false);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to stop capture: ${errorMessage}`);
      console.error("Stop capture error:", err);
    }
  }, []);

  // Manual stop for continuous recording
  const manualStopAndSend = useCallback(async () => {
    try {
      if (!isContinuousMode) {
        console.warn("Not in continuous mode");
        return;
      }

      // Show processing state immediately
      setIsProcessing(true);

      // Trigger manual stop event
      await invoke("manual_stop_continuous");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to manually stop: ${errorMessage}`);
      setIsProcessing(false); // Clear processing state on error
      console.error("Manual stop error:", err);
    }
  }, [isContinuousMode]);

  const handleSetup = useCallback(async () => {
    try {
      const platform = navigator.platform.toLowerCase();

      if (platform.includes("mac") || platform.includes("win")) {
        await invoke("request_system_audio_access");
      }

      // Delay to give the user time to grant permissions in the system dialog.
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (hasAccess) {
        setSetupRequired(false);
        await startCapture();
      } else {
        setSetupRequired(true);
        setError("Permission not granted. Please try the manual steps.");
      }
    } catch (err) {
      setError("Failed to request access. Please try the manual steps below.");
      setSetupRequired(true);
    }
  }, [startCapture]);

  // `hasAIResponse` is a boolean state that flips at most twice per response
  // (see processWithAI), so this effect and its resizeWindow IPC call no longer
  // fire on every streaming token — the response text now lives in an external
  // store instead of driving this component's state.
  useEffect(() => {
    const shouldOpenPopover =
      capturing || setupRequired || isAIProcessing || hasAIResponse || !!error;
    setIsPopoverOpen(shouldOpenPopover);
    resizeWindow(shouldOpenPopover);
  }, [
    capturing,
    setupRequired,
    isAIProcessing,
    hasAIResponse,
    error,
    resizeWindow,
  ]);

  useEffect(() => {
    globalShortcuts.registerSystemAudioCallback(async () => {
      // Live mode (#34 + AI): the hotkey fires the AI over the accumulated
      // INTERLOCUTOR transcript. This MUST come first — during a Live session
      // batch `capturing` is false (the two pipelines are mutually exclusive),
      // so without this guard the code below would fall through to startCapture.
      if (liveBridge.isStreaming) {
        await liveBridge.fireFromHotkey();
        return;
      }

      // In "transcribe-only" mode (#25) with an accumulated transcript, the
      // hotkey fires the AI on that transcript instead of toggling capture, so
      // the user can keep listening and ask for a response on demand.
      const pending = pendingTranscriptRef.current.trim();
      if (capturing && !autoRespondRef.current && pending) {
        const effectiveSystemPrompt = buildEffectiveSystemPrompt();
        const previousMessages = conversation.messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
        }));
        setLastTranscription(pending);
        setPendingTranscript("");
        await processWithAI(pending, effectiveSystemPrompt, previousMessages);
        return;
      }

      if (capturing) {
        await stopCapture();
      } else {
        await startCapture();
      }
    });
  }, [
    startCapture,
    stopCapture,
    processWithAI,
    useSystemPrompt,
    systemPrompt,
    contextContent,
    conversation.messages,
  ]);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (discardedTimeoutRef.current) {
        clearTimeout(discardedTimeoutRef.current);
      }
      invoke("stop_system_audio_capture").catch(() => {});
    };
  }, []);

  // Debounced save to prevent race conditions and improve performance
  useEffect(() => {
    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Only debounce if there are messages to save
    if (
      !conversation.id ||
      conversation.updatedAt === 0 ||
      conversation.messages.length === 0
    ) {
      return;
    }

    // Debounce saves (only save 500ms after last change)
    saveTimeoutRef.current = setTimeout(async () => {
      // Don't save if already saving (prevent concurrent saves)
      if (isSavingRef.current) {
        return;
      }

      try {
        isSavingRef.current = true;
        await saveConversation(conversation);
      } catch (error) {
        console.error("Failed to save system audio conversation:", error);
      } finally {
        isSavingRef.current = false;
      }
    }, CONVERSATION_SAVE_DEBOUNCE_MS);

    // Cleanup on unmount or dependency change
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [
    conversation.messages.length,
    conversation.title,
    conversation.id,
    conversation.updatedAt,
  ]);

  const startNewConversation = useCallback(() => {
    setConversation({
      id: generateConversationId("sysaudio"),
      title: "",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    });
    setLastTranscription("");
    setStreamingResponse("");
    setHasAIResponse(false);
    setPendingTranscript("");
    setError("");
    setSetupRequired(false);
    setIsProcessing(false);
    setIsAIProcessing(false);
    setIsPopoverOpen(false);
    updateUseSystemPrompt(true);
  }, [updateUseSystemPrompt]);

  // updateVadConfiguration is provided by useVadConfigStore (aliased above).

  useEffect(() => {
    if (capturing) {
      setIsContinuousMode(!vadConfig.enabled);

      if (!vadConfig.enabled) {
        setIsRecordingInContinuousMode(false);
      }
    }
  }, [vadConfig.enabled, capturing]);

  // Keyboard arrow key support for scrolling (local shortcut)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPopoverOpen) return;

      const scrollElement = scrollAreaRef.current?.querySelector(
        "[data-radix-scroll-area-viewport]"
      ) as HTMLElement;

      if (!scrollElement) return;

      const scrollAmount = 100; // pixels to scroll

      if (e.key === "ArrowDown") {
        e.preventDefault();
        scrollElement.scrollBy({ top: scrollAmount, behavior: "smooth" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        scrollElement.scrollBy({ top: -scrollAmount, behavior: "smooth" });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPopoverOpen]);

  // Keyboard shortcuts for continuous mode recording (local shortcuts)
  useEffect(() => {
    const handleRecordingShortcuts = (e: KeyboardEvent) => {
      if (!isPopoverOpen || !isContinuousMode) return;
      if (isProcessing || isAIProcessing) return;

      // Enter: Start recording (when not recording) or Stop & Send (when recording)
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (!isRecordingInContinuousMode) {
          startContinuousRecording();
        } else {
          manualStopAndSend();
        }
      }

      // Escape: Ignore recording (when recording)
      if (e.key === "Escape" && isRecordingInContinuousMode) {
        e.preventDefault();
        ignoreContinuousRecording();
      }

      // Space: Start recording (when not recording) - only if not typing in input
      if (
        e.key === " " &&
        !isRecordingInContinuousMode &&
        !e.metaKey &&
        !e.ctrlKey &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        startContinuousRecording();
      }
    };

    window.addEventListener("keydown", handleRecordingShortcuts);
    return () =>
      window.removeEventListener("keydown", handleRecordingShortcuts);
  }, [
    isPopoverOpen,
    isContinuousMode,
    isRecordingInContinuousMode,
    isProcessing,
    isAIProcessing,
    startContinuousRecording,
    manualStopAndSend,
    ignoreContinuousRecording,
  ]);

  return {
    capturing,
    isProcessing,
    isAIProcessing,
    lastTranscription,
    // Streaming response text is NOT returned here — consumers read it from the
    // useStreamingResponse store so per-token updates don't re-render this tree.
    // Only the boolean is exposed for show/hide logic.
    hasAIResponse,
    error,
    discardedNotice,
    autoRespond,
    setAutoRespond,
    pendingTranscript,
    setupRequired,
    startCapture,
    stopCapture,
    handleSetup,
    isPopoverOpen,
    setIsPopoverOpen,
    // Conversation management
    conversation,
    setConversation,
    // AI processing
    processWithAI,
    buildEffectiveSystemPrompt,
    // Context management
    useSystemPrompt,
    setUseSystemPrompt: updateUseSystemPrompt,
    contextContent,
    setContextContent: updateContextContent,
    startNewConversation,
    // Window resize
    resizeWindow,
    quickActions,
    addQuickAction,
    removeQuickAction,
    isManagingQuickActions,
    setIsManagingQuickActions,
    showQuickActions,
    setShowQuickActions,
    handleQuickActionClick,
    // VAD configuration
    vadConfig,
    updateVadConfiguration,
    // Continuous recording
    isContinuousMode,
    isRecordingInContinuousMode,
    recordingProgress,
    manualStopAndSend,
    startContinuousRecording,
    ignoreContinuousRecording,
    // Scroll area ref for keyboard navigation
    scrollAreaRef,
  };
}
