import { useState, useMemo } from "react";
import {
  SparklesIcon,
  Loader2,
  ChevronDownIcon,
  ChevronUpIcon,
} from "lucide-react";
import { Markdown, CopyButton } from "@/components";
import { useStreamingResponse } from "@/hooks";
import { STORAGE_KEYS } from "@/config/constants";

type Props = {
  isAIProcessing: boolean;
  // Hands-free sessions default the support section to OPEN (the user is
  // reading, not clicking); hotkey sessions default it closed.
  handsFree: boolean;
};

// Spoken-text sizes for the A−/A+ stepper. These are core Tailwind utilities
// (NOT `prose-*` — the typography plugin isn't installed, so prose classes
// generate no CSS). Streamdown paragraphs carry no size class of their own, so
// they inherit whichever of these the wrapper sets.
const FONT_SIZES = ["text-base", "text-lg", "text-xl", "text-2xl"] as const;
const DEFAULT_FONT_INDEX = 1; // text-lg

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

// One sentence per line, like a real teleprompter script: you grab a line, say
// it, drop to the next (chunking + eye-voice span). Sentence-ending punctuation
// followed by whitespace becomes a paragraph break; decimals ("3.5") survive
// because their period has no whitespace after it. The trailing in-progress
// sentence during streaming simply renders as the last line.
function toTeleprompterLines(text: string): string {
  return text.replace(/([.!?…])\s+/g, "$1\n\n");
}

/**
 * Live-mode reading view for the AI answer (distinct from the batch
 * ResultsSection). This is the surface the user READS ALOUD while on camera, so
 * it's laid out like a teleprompter, not a chat bubble:
 *   - the SPOKEN part (everything the prompt puts before the `---`) renders one
 *     sentence per line, in large adjustable type (A− / A+, persisted);
 *   - the SUPPORT part (bullets, gotchas, "if they push") is smaller and
 *     collapsible — open by default in hands-free, closed on hotkey sessions;
 *   - the whole panel renders ABOVE the (collapsed) transcript in Live, so the
 *     eyes land on "what I say" first.
 */
export const LiveResponse = ({ isAIProcessing, handsFree }: Props) => {
  // Same streaming store the batch view subscribes to — this is the only Live
  // element that re-renders per token.
  const response = useStreamingResponse();

  // Support visibility: follow the hands-free default until the user toggles
  // it manually (the override wins for the rest of the session).
  const [supportOverride, setSupportOverride] = useState<boolean | null>(null);
  const showSupport = supportOverride ?? handsFree;

  // Spoken-text size (A− / A+), persisted across sessions.
  const [fontIndex, setFontIndexState] = useState<number>(() => {
    const raw = Number(
      localStorage.getItem(STORAGE_KEYS.SYSTEM_AUDIO_SPOKEN_FONT)
    );
    return Number.isInteger(raw) && raw >= 0 && raw < FONT_SIZES.length
      ? raw
      : DEFAULT_FONT_INDEX;
  });
  const setFontIndex = (next: number) => {
    const clamped = Math.min(FONT_SIZES.length - 1, Math.max(0, next));
    setFontIndexState(clamped);
    localStorage.setItem(
      STORAGE_KEYS.SYSTEM_AUDIO_SPOKEN_FONT,
      String(clamped)
    );
  };

  const { spoken, support } = useMemo(
    () => splitSpokenAndSupport(response),
    [response]
  );
  const spokenLines = useMemo(() => toTeleprompterLines(spoken), [spoken]);

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/[0.03] p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <SparklesIcon className="w-3.5 h-3.5 text-primary" />
          <h4 className="text-xs font-medium">Say this</h4>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Spoken-text size stepper. Only affects the teleprompter (spoken)
              part; the support stays small. */}
          <div className="flex items-center gap-0.5 rounded-md bg-background/60 p-0.5">
            <button
              type="button"
              onClick={() => setFontIndex(fontIndex - 1)}
              disabled={fontIndex === 0}
              title="Smaller text"
              className="px-1.5 py-0.5 rounded text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              A−
            </button>
            <button
              type="button"
              onClick={() => setFontIndex(fontIndex + 1)}
              disabled={fontIndex === FONT_SIZES.length - 1}
              title="Larger text"
              className="px-1.5 py-0.5 rounded text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              A+
            </button>
          </div>
          {response && <CopyButton content={response} />}
        </div>
      </div>

      {isAIProcessing && !response ? (
        <div className="flex items-center gap-2 py-2">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="text-xs text-muted-foreground">Thinking…</span>
        </div>
      ) : (
        <>
          {/* SPOKEN part — the teleprompter. One sentence per line (Streamdown
              renders each as its own <p> inside a space-y-4 root), inheritable
              size from the stepper, relaxed leading for glance-reading. */}
          <div
            className={`${FONT_SIZES[fontIndex]} leading-relaxed text-foreground`}
          >
            <Markdown isStreaming={isAIProcessing}>{spokenLines}</Markdown>
            {isAIProcessing && !support && (
              <span className="inline-block w-2 h-5 bg-primary animate-pulse ml-1 align-middle" />
            )}
          </div>

          {/* SUPPORT part — smaller, collapsible. Only rendered once the `---`
              has arrived and there's actually support text. */}
          {support && (
            <div className="pt-1 border-t border-border/40">
              <button
                type="button"
                onClick={() => setSupportOverride(!showSupport)}
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
                <div className="mt-1.5 text-sm text-foreground/80">
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
