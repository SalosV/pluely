import { RadioIcon, Loader2, PlayIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components";
import type { TranscriptEntry, InterimEntry } from "@/hooks";

type Props = {
  isStreaming: boolean;
  connected: boolean;
  error: string;
  finals: TranscriptEntry[];
  interims: InterimEntry[];
  onStart: () => void;
  onStop: () => void;
};

// Unified two-channel Live session (#34): channel 0 = mic ("You"),
// channel 1 = system ("Interlocutor"). Each source gets a stable label + color.
function channelLabel(channel: number | null | undefined): string | null {
  if (channel === 0) return "You";
  if (channel === 1) return "Interlocutor";
  return null; // single-channel fallback: no speaker label
}

function channelColor(channel: number | null | undefined): string {
  if (channel === 0) return "text-blue-500"; // You
  if (channel === 1) return "text-green-500"; // Interlocutor
  return "text-muted-foreground";
}

/**
 * Live transcription view for Deepgram streaming (#31/#32/#34). Renders
 * finalized turns labeled by source ("You" / "Interlocutor" from the two-channel
 * session) plus each channel's current interim result, shown greyed-out as it's
 * still being revised.
 */
export const LiveTranscription = ({
  isStreaming,
  connected,
  error,
  finals,
  interims,
  onStart,
  onStop,
}: Props) => {
  const hasContent = finals.length > 0 || interims.length > 0;

  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <RadioIcon
            className={`w-3.5 h-3.5 ${
              connected ? "text-red-500 animate-pulse" : "text-muted-foreground"
            }`}
          />
          <h4 className="text-xs font-medium">Live transcript</h4>
        </div>
        {/* Explicit Start/Stop so the action is obvious from inside the panel. */}
        {isStreaming ? (
          <Button
            size="sm"
            variant="outline"
            onClick={onStop}
            className="h-6 text-[10px] gap-1 px-2"
          >
            <SquareIcon className="w-3 h-3" /> Stop
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={onStart}
            className="h-6 text-[10px] gap-1 px-2"
          >
            <PlayIcon className="w-3 h-3" /> Start
          </Button>
        )}
      </div>

      {/* Connecting spinner: only while a stream is starting up. */}
      {isStreaming && !connected && !error && (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> connecting…
        </span>
      )}

      {error && (
        <p className="text-[10px] text-red-600 bg-red-50 rounded p-1.5">
          {error}
        </p>
      )}

      {/* Idle hint when Live mode is selected but not started yet. */}
      {!isStreaming && !error && (
        <p className="text-[11px] text-muted-foreground italic">
          Press Start to begin the live session — it transcribes both you and the
          other party from system audio.
        </p>
      )}

      {isStreaming && !hasContent && connected && !error && (
        <p className="text-[11px] text-muted-foreground italic">
          Listening… speak or play audio to see the transcript appear live.
        </p>
      )}

      {hasContent && (
        <div className="space-y-1.5 text-[11px] leading-relaxed">
          {finals.map((entry) => {
            const label = channelLabel(entry.channel);
            return label ? (
              <p key={entry.id}>
                <span className={`font-semibold ${channelColor(entry.channel)}`}>
                  {label}:
                </span>{" "}
                <span className="text-foreground/85">{entry.text}</span>
              </p>
            ) : (
              <p key={entry.id} className="text-foreground/85">
                {entry.text}
              </p>
            );
          })}
          {/* Interim (in-progress) results per channel, greyed out. */}
          {interims.map((it) => {
            const label = channelLabel(it.channel);
            return (
              <p
                key={`interim-${it.channel}`}
                className="text-muted-foreground/70 italic"
              >
                {label && (
                  <span className={`font-semibold ${channelColor(it.channel)}`}>
                    {label}:{" "}
                  </span>
                )}
                {it.text}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
};
