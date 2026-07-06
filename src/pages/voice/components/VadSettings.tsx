import {
  Button,
  Header,
  Label,
  Slider,
  Switch,
} from "@/components";
import { RotateCcwIcon } from "lucide-react";
import { useVadConfigStore } from "@/hooks";
import { VadConfig } from "@/lib";
import { cn } from "@/lib/utils";

// Sensitivity presets for simpler UX
const SENSITIVITY_PRESETS = {
  low: {
    sensitivity_rms: 0.015,
    noise_gate_threshold: 0.005,
    label: "Low",
    description: "Only picks up clear, loud speech",
  },
  normal: {
    sensitivity_rms: 0.012,
    noise_gate_threshold: 0.003,
    label: "Normal",
    description: "Balanced for typical conversations",
  },
  high: {
    sensitivity_rms: 0.008,
    noise_gate_threshold: 0.002,
    label: "High",
    description: "Picks up quieter speech",
  },
} as const;

type SensitivityPreset = keyof typeof SENSITIVITY_PRESETS;

export const VadSettings = () => {
  const { vadConfig, updateVadConfig } = useVadConfigStore();

  // Determine current sensitivity preset based on values
  const getCurrentPreset = (): SensitivityPreset | "custom" => {
    for (const [key, preset] of Object.entries(SENSITIVITY_PRESETS)) {
      if (
        Math.abs(vadConfig.sensitivity_rms - preset.sensitivity_rms) < 0.001 &&
        Math.abs(vadConfig.noise_gate_threshold - preset.noise_gate_threshold) <
          0.001
      ) {
        return key as SensitivityPreset;
      }
    }
    return "custom";
  };

  const currentPreset = getCurrentPreset();

  const handlePresetChange = (preset: SensitivityPreset) => {
    const presetValues = SENSITIVITY_PRESETS[preset];
    updateVadConfig({
      ...vadConfig,
      sensitivity_rms: presetValues.sensitivity_rms,
      noise_gate_threshold: presetValues.noise_gate_threshold,
    });
  };

  const handleResetDefaults = () => {
    const defaultConfig: VadConfig = {
      enabled: vadConfig.enabled, // Keep current mode
      hop_size: 1024,
      sensitivity_rms: 0.012,
      peak_threshold: 0.035,
      silence_chunks: 45,
      min_speech_chunks: 7,
      pre_speech_chunks: 12,
      noise_gate_threshold: 0.003,
      max_recording_duration_secs: 180,
    };
    updateVadConfig(defaultConfig);
  };

  return (
    <div className="space-y-4">
      <Header
        isMainTitle
        title="System Audio Recording"
        description="Control how speech is detected and captured from system audio."
      />

      {/* Recording Mode */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <Label className="text-sm font-medium">Recording Mode</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            {vadConfig.enabled
              ? "Auto-detect: speech is captured automatically."
              : "Manual: you control when recording starts and stops."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Manual</span>
          <Switch
            checked={vadConfig.enabled}
            onCheckedChange={(enabled) =>
              updateVadConfig({ ...vadConfig, enabled })
            }
          />
          <span className="text-xs text-muted-foreground">Auto</span>
        </div>
      </div>

      {/* Sensitivity Presets - Only for VAD mode */}
      {vadConfig.enabled && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">Speech Sensitivity</Label>
          <div className="flex gap-2">
            {(
              Object.entries(SENSITIVITY_PRESETS) as [
                SensitivityPreset,
                (typeof SENSITIVITY_PRESETS)[SensitivityPreset]
              ][]
            ).map(([key, preset]) => (
              <button
                key={key}
                type="button"
                onClick={() => handlePresetChange(key)}
                className={cn(
                  "flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all border",
                  currentPreset === key
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background border-border hover:bg-accent"
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {currentPreset === "custom"
              ? "Custom sensitivity values"
              : SENSITIVITY_PRESETS[currentPreset as SensitivityPreset]
                  .description}
          </p>
        </div>
      )}

      {/* Max Duration - Only for Manual mode */}
      {!vadConfig.enabled && (
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center justify-between">
            <span>Max Recording Duration</span>
            <span className="text-muted-foreground font-normal">
              {Math.round(vadConfig.max_recording_duration_secs / 60)} min
            </span>
          </Label>
          <Slider
            value={[vadConfig.max_recording_duration_secs / 60]}
            onValueChange={([value]) =>
              updateVadConfig({
                ...vadConfig,
                max_recording_duration_secs: Math.round(value * 60),
              })
            }
            min={1}
            max={3}
            step={0.5}
            className="w-full"
          />
        </div>
      )}

      {/* Advanced controls */}
      <div className="space-y-4 pt-4 border-t border-input/50">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Advanced
        </p>

        {vadConfig.enabled && (
          <>
            <div className="space-y-2">
              <Label className="text-sm font-medium flex items-center justify-between">
                <span>Speech Sensitivity (Raw)</span>
                <span className="text-muted-foreground font-normal">
                  {(vadConfig.sensitivity_rms * 1000).toFixed(1)}
                </span>
              </Label>
              <Slider
                value={[vadConfig.sensitivity_rms * 1000]}
                onValueChange={([value]) =>
                  updateVadConfig({
                    ...vadConfig,
                    sensitivity_rms: value / 1000,
                  })
                }
                min={1}
                max={20}
                step={0.5}
                className="w-full"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-sm font-medium flex items-center justify-between">
                <span>Silence Duration</span>
                <span className="text-muted-foreground font-normal">
                  {(
                    (vadConfig.silence_chunks * vadConfig.hop_size) /
                    44100
                  ).toFixed(1)}
                  s
                </span>
              </Label>
              <Slider
                value={[vadConfig.silence_chunks]}
                onValueChange={([value]) =>
                  updateVadConfig({
                    ...vadConfig,
                    silence_chunks: Math.round(value),
                  })
                }
                min={20}
                max={180}
                step={5}
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                How long to wait after speech stops
              </p>
            </div>
          </>
        )}

        {/* Noise gate - both modes */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center justify-between">
            <span>Noise Gate</span>
            <span className="text-muted-foreground font-normal">
              {(vadConfig.noise_gate_threshold * 1000).toFixed(1)}
            </span>
          </Label>
          <Slider
            value={[vadConfig.noise_gate_threshold * 1000]}
            onValueChange={([value]) =>
              updateVadConfig({
                ...vadConfig,
                noise_gate_threshold: value / 1000,
              })
            }
            min={0}
            max={10}
            step={0.1}
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">
            Filters background noise
          </p>
        </div>

        {/* Reset button */}
        <Button
          variant="outline"
          size="sm"
          onClick={handleResetDefaults}
          className="w-full text-xs"
        >
          <RotateCcwIcon className="w-3 h-3 mr-1.5" />
          Reset to Defaults
        </Button>
      </div>
    </div>
  );
};
