import { useState, useEffect, useCallback } from "react";
import { STORAGE_KEYS } from "@/config";
import { getVadConfig, setVadConfig, VadConfig } from "@/lib";

/**
 * Lightweight store for the VAD config that reads/writes localStorage and syncs
 * the Rust backend, WITHOUT pulling in the heavy `useSystemAudio` capture hook.
 * Safe to use from any window (overlay or dashboard).
 *
 * A `storage` event listener keeps the value fresh across separate Tauri
 * webviews: when one window writes the config, the others re-read it.
 */
export function useVadConfigStore() {
  const [vadConfig, setVadConfigState] = useState<VadConfig>(getVadConfig);

  const updateVadConfig = useCallback(async (config: VadConfig) => {
    setVadConfigState(config);
    await setVadConfig(config);
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.VAD_CONFIG) {
        setVadConfigState(getVadConfig());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return { vadConfig, updateVadConfig };
}
