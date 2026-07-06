import { invoke } from "@tauri-apps/api/core";
import { STORAGE_KEYS } from "@/config";

// VAD Configuration interface matching Rust
export interface VadConfig {
  enabled: boolean;
  hop_size: number;
  sensitivity_rms: number;
  peak_threshold: number;
  silence_chunks: number;
  min_speech_chunks: number;
  pre_speech_chunks: number;
  noise_gate_threshold: number;
  max_recording_duration_secs: number;
}

// OPTIMIZED VAD defaults - matches backend exactly for perfect performance
export const DEFAULT_VAD_CONFIG: VadConfig = {
  enabled: true,
  hop_size: 1024,
  sensitivity_rms: 0.012, // Much less sensitive - only real speech
  peak_threshold: 0.035, // Higher threshold - filters clicks/noise
  silence_chunks: 45, // ~1.0s of required silence
  min_speech_chunks: 7, // ~0.16s - captures short answers
  pre_speech_chunks: 12, // ~0.27s - enough to catch word start
  noise_gate_threshold: 0.003, // Stronger noise filtering
  max_recording_duration_secs: 180, // 3 minutes default
};

export interface SystemAudioContext {
  useSystemPrompt: boolean;
  contextContent: string;
}

export const DEFAULT_SYSTEM_AUDIO_CONTEXT: SystemAudioContext = {
  useSystemPrompt: true,
  contextContent: "",
};

/**
 * Read the VAD config from localStorage, merged over defaults so partial or
 * legacy JSON never yields an incomplete config.
 */
export const getVadConfig = (): VadConfig => {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.VAD_CONFIG);
    if (!stored) return DEFAULT_VAD_CONFIG;
    const parsed = JSON.parse(stored);
    return { ...DEFAULT_VAD_CONFIG, ...parsed };
  } catch (error) {
    console.error("Failed to get VAD config:", error);
    return DEFAULT_VAD_CONFIG;
  }
};

/**
 * Persist the VAD config to localStorage and sync it to the Rust backend.
 * The backend command is idempotent; failures are logged but not thrown so a
 * settings UI never crashes on a transient invoke error.
 */
export const setVadConfig = async (config: VadConfig): Promise<void> => {
  try {
    localStorage.setItem(STORAGE_KEYS.VAD_CONFIG, JSON.stringify(config));
    await invoke("update_vad_config", { config });
  } catch (error) {
    console.error("Failed to update VAD config:", error);
  }
};

/**
 * Read the system-audio AI context settings (use-system-prompt toggle + custom
 * context text) from localStorage.
 */
export const getSystemAudioContext = (): SystemAudioContext => {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT);
    if (!stored) return DEFAULT_SYSTEM_AUDIO_CONTEXT;
    const parsed = JSON.parse(stored);
    return {
      useSystemPrompt:
        parsed.useSystemPrompt ??
        DEFAULT_SYSTEM_AUDIO_CONTEXT.useSystemPrompt,
      contextContent:
        parsed.contextContent ?? DEFAULT_SYSTEM_AUDIO_CONTEXT.contextContent,
    };
  } catch (error) {
    console.error("Failed to get system audio context:", error);
    return DEFAULT_SYSTEM_AUDIO_CONTEXT;
  }
};

/**
 * Persist the system-audio AI context settings to localStorage.
 */
export const setSystemAudioContext = (value: SystemAudioContext): void => {
  try {
    localStorage.setItem(
      STORAGE_KEYS.SYSTEM_AUDIO_CONTEXT,
      JSON.stringify(value)
    );
  } catch (error) {
    console.error("Failed to save system audio context:", error);
  }
};
