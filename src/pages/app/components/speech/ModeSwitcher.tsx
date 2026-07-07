import { cn } from "@/lib/utils";
import { AudioWaveformIcon, MicIcon, RadioIcon } from "lucide-react";

/** The three mutually-exclusive capture modes. */
export type CaptureMode = "manual" | "auto" | "live";

interface ModeSwitcherProps {
  mode: CaptureMode;
  onModeChange: (mode: CaptureMode) => void;
  disabled?: boolean;
}

const MODES: {
  id: CaptureMode;
  label: string;
  hint: string;
  icon: typeof MicIcon;
}[] = [
  {
    id: "auto",
    label: "Auto-detect",
    hint: "voice activity",
    icon: AudioWaveformIcon,
  },
  { id: "manual", label: "Manual", hint: "press to record", icon: MicIcon },
  { id: "live", label: "Live", hint: "streaming", icon: RadioIcon },
];

/**
 * Single selector for the three mutually-exclusive capture modes
 * (Auto-detect / Manual / Live). Only one is active at a time. The
 * "Auto-respond" modifier lives outside this component and only applies to
 * Auto-detect.
 */
export const ModeSwitcher = ({
  mode,
  onModeChange,
  disabled = false,
}: ModeSwitcherProps) => {
  return (
    <div
      className={cn(
        "flex bg-muted rounded-lg w-full p-0.5 gap-0.5",
        disabled && "opacity-50 pointer-events-none"
      )}
    >
      {MODES.map(({ id, label, hint, icon: Icon }) => {
        const active = mode === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onModeChange(id)}
            disabled={disabled}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md transition-all",
              active
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            <div className="flex flex-col items-start">
              <span className="text-xs font-medium leading-tight">{label}</span>
              <span className="text-[9px] font-normal opacity-60 leading-tight">
                ({hint})
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
};
