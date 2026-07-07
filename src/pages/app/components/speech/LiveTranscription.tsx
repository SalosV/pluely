import { RadioIcon, Loader2 } from "lucide-react";
import type { TranscriptEntry } from "@/hooks";

type Props = {
  connected: boolean;
  error: string;
  finals: TranscriptEntry[];
  interim: string;
};

// Stable-ish color per speaker index for the diarization labels (#32).
const SPEAKER_COLORS = [
  "text-blue-500",
  "text-green-500",
  "text-purple-500",
  "text-orange-500",
  "text-pink-500",
];

function speakerColor(speaker: number) {
  return SPEAKER_COLORS[speaker % SPEAKER_COLORS.length];
}

/**
 * Live transcription view for Deepgram streaming (#31/#32). Renders finalized
 * turns (with per-speaker labels when diarization is on) plus the current
 * interim result, shown greyed-out as it's still being revised.
 */
export const LiveTranscription = ({
  connected,
  error,
  finals,
  interim,
}: Props) => {
  const hasContent = finals.length > 0 || interim;

  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-2">
      <div className="flex items-center gap-1.5">
        <RadioIcon
          className={`w-3.5 h-3.5 ${
            connected ? "text-red-500 animate-pulse" : "text-muted-foreground"
          }`}
        />
        <h4 className="text-xs font-medium">Live transcript</h4>
        {!connected && !error && (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" /> connecting…
          </span>
        )}
      </div>

      {error && (
        <p className="text-[10px] text-red-600 bg-red-50 rounded p-1.5">
          {error}
        </p>
      )}

      {!hasContent && connected && !error && (
        <p className="text-[11px] text-muted-foreground italic">
          Listening… speak or play audio to see the transcript appear live.
        </p>
      )}

      {hasContent && (
        <div className="space-y-1.5 text-[11px] leading-relaxed">
          {finals.map((entry) =>
            entry.speakers.length > 0 ? (
              <div key={entry.id} className="space-y-0.5">
                {entry.speakers.map((seg, i) => (
                  <p key={i}>
                    <span
                      className={`font-semibold ${speakerColor(seg.speaker)}`}
                    >
                      Speaker {seg.speaker}:
                    </span>{" "}
                    <span className="text-foreground/85">{seg.text}</span>
                  </p>
                ))}
              </div>
            ) : (
              <p key={entry.id} className="text-foreground/85">
                {entry.text}
              </p>
            )
          )}
          {/* Interim (in-progress) result, greyed out. */}
          {interim && (
            <p className="text-muted-foreground/70 italic">{interim}</p>
          )}
        </div>
      )}
    </div>
  );
};
