import { SparklesIcon, Loader2 } from "lucide-react";
import { Markdown, CopyButton } from "@/components";
import { useStreamingResponse } from "@/hooks";

type Props = {
  isAIProcessing: boolean;
};

/**
 * Live-mode reading view for the AI answer (distinct from the batch
 * ResultsSection). This is the surface the user READS ALOUD while on camera, so
 * it's optimized for glance-reading, not scanning:
 *   - larger type (`prose-base`, not `prose-sm`) so it's legible out of the
 *     corner of the eye without leaning into the screen;
 *   - relaxed line height and a little more spacing between blocks;
 *   - it renders ABOVE the (collapsed) transcript in Live, so the eyes land on
 *     "what I say" first.
 * The AI's system prompt is expected to lead with a short first-person spoken
 * line; this view just makes that line easy to read.
 */
export const LiveResponse = ({ isAIProcessing }: Props) => {
  // Same streaming store the batch view subscribes to — this is the only Live
  // element that re-renders per token.
  const response = useStreamingResponse();

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/[0.03] p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <SparklesIcon className="w-3.5 h-3.5 text-primary" />
          <h4 className="text-xs font-medium">Say this</h4>
        </div>
        {response && <CopyButton content={response} />}
      </div>

      {isAIProcessing && !response ? (
        <div className="flex items-center gap-2 py-2">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="text-xs text-muted-foreground">Thinking…</span>
        </div>
      ) : (
        // `prose-base` + `leading-relaxed` = teleprompter-friendly sizing. The
        // Markdown/Streamdown output inherits the prose scale from this wrapper.
        <div className="prose prose-base max-w-none dark:prose-invert leading-relaxed [&_p]:my-1.5 [&_ul]:my-1.5 [&_li]:my-0.5">
          <Markdown isStreaming={isAIProcessing}>{response}</Markdown>
          {isAIProcessing && (
            <span className="inline-block w-2 h-5 bg-primary animate-pulse ml-1 align-middle" />
          )}
        </div>
      )}
    </div>
  );
};
