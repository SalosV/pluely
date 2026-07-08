import { useState, useMemo } from "react";
import {
  SparklesIcon,
  Loader2,
  ChevronDownIcon,
  ChevronUpIcon,
} from "lucide-react";
import { Markdown, CopyButton } from "@/components";
import { useStreamingResponse } from "@/hooks";

type Props = {
  isAIProcessing: boolean;
};

// The system prompt is instructed to output the spoken answer first, then a
// `---` horizontal rule, then the supporting bullets. We split on that rule so
// the UI can give the spoken part the spotlight (big type) and tuck the support
// away. Splitting on an explicit marker (rather than guessing "first paragraph")
// is what makes this robust while streaming and across formatting drift:
//   - before the `---` arrives, everything is treated as the spoken part (which
//     is exactly right — it's still being written);
//   - if the model forgets the `---`, we degrade gracefully to showing the whole
//     answer as the spoken part (the previous behavior).
// Only the FIRST `---` splits, so rules inside the support section are left
// alone.
function splitSpokenAndSupport(text: string): {
  spoken: string;
  support: string;
} {
  // Match a horizontal rule on its own line (---, ***, or ___), optionally
  // surrounded by blank lines — the standard Markdown thematic break.
  const match = text.match(/\n[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*(?:\n|$)/);
  if (!match || match.index === undefined) {
    return { spoken: text, support: "" };
  }
  const spoken = text.slice(0, match.index).trim();
  const support = text.slice(match.index + match[0].length).trim();
  return { spoken, support };
}

/**
 * Live-mode reading view for the AI answer (distinct from the batch
 * ResultsSection). This is the surface the user READS ALOUD while on camera, so
 * it's optimized for glance-reading, not scanning:
 *   - the SPOKEN part (everything the prompt puts before the `---`) is shown big
 *     (`prose-lg`) and on its own, so the eyes grab it in one glance;
 *   - the SUPPORT part (bullets, gotchas, "if they push") is smaller and
 *     collapsed by default — it's there to peek at only if the interviewer digs;
 *   - the whole panel renders ABOVE the (collapsed) transcript in Live, so the
 *     eyes land on "what I say" first.
 */
export const LiveResponse = ({ isAIProcessing }: Props) => {
  // Same streaming store the batch view subscribes to — this is the only Live
  // element that re-renders per token.
  const response = useStreamingResponse();
  const [showSupport, setShowSupport] = useState(false);

  const { spoken, support } = useMemo(
    () => splitSpokenAndSupport(response),
    [response]
  );

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
        <>
          {/* SPOKEN part — the teleprompter line. `prose-lg` + relaxed leading =
              readable out of the corner of the eye. Tight vertical rhythm so
              short sentences sit close together. */}
          <div className="prose prose-lg max-w-none dark:prose-invert leading-relaxed [&_p]:my-1 [&_p]:font-normal text-foreground">
            <Markdown isStreaming={isAIProcessing}>{spoken}</Markdown>
            {isAIProcessing && !support && (
              <span className="inline-block w-2 h-5 bg-primary animate-pulse ml-1 align-middle" />
            )}
          </div>

          {/* SUPPORT part — smaller, collapsed by default. Only rendered once the
              `---` has arrived and there's actually support text. */}
          {support && (
            <div className="pt-1 border-t border-border/40">
              <button
                type="button"
                onClick={() => setShowSupport((v) => !v)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {showSupport ? (
                  <>
                    <ChevronUpIcon className="w-3 h-3" /> Hide backup
                  </>
                ) : (
                  <>
                    <ChevronDownIcon className="w-3 h-3" /> If they dig deeper
                  </>
                )}
              </button>
              {showSupport && (
                <div className="mt-1.5 prose prose-sm max-w-none dark:prose-invert [&_p]:my-1 [&_ul]:my-1 [&_li]:my-0.5 text-foreground/80">
                  <Markdown isStreaming={isAIProcessing}>{support}</Markdown>
                  {isAIProcessing && (
                    <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-1 align-middle" />
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};
