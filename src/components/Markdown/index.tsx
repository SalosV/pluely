import React from "react";
import { Streamdown } from "streamdown";
import type { BundledTheme } from "shiki";
import "katex/dist/katex.min.css";
import { openUrl } from "@tauri-apps/plugin-opener";

interface MarkdownRendererProps {
  children: string;
  isStreaming?: boolean;
}

// Hoisted to module scope so their identity is stable across renders. When
// these were inline literals, every streaming chunk (~47/s) handed Streamdown
// fresh array/object props, defeating its internal memoization and forcing a
// full markdown re-parse per token.
const SHIKI_THEMES: [BundledTheme, BundledTheme] = [
  "github-light",
  "github-dark",
];
const STREAMDOWN_CONTROLS = {
  table: true,
  code: true,
  mermaid: {
    download: true,
    copy: true,
    fullscreen: false,
    panZoom: false,
  },
} as const;

function MarkdownImpl({
  children,
  isStreaming = false,
}: MarkdownRendererProps) {
  return (
    <Streamdown
      isAnimating={isStreaming}
      shikiTheme={SHIKI_THEMES}
      components={COMPONENTS as any}
      controls={STREAMDOWN_CONTROLS}
    >
      {children}
    </Streamdown>
  );
}

// Memoized so a parent re-render that doesn't change `children`/`isStreaming`
// (common while streaming updates sibling state) doesn't re-render the markdown.
export const Markdown = React.memo(MarkdownImpl);

const COMPONENTS = {
  a: ({ children, href, ...props }: any) => {
    const handleClick = async (e: React.MouseEvent) => {
      e.preventDefault();
      if (href) {
        try {
          await openUrl(href);
        } catch (error) {
          console.error("Failed to open URL:", error);
        }
      }
    };

    return (
      <a
        href={href}
        className="text-gray-600 underline underline-offset-2 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100 cursor-pointer"
        onClick={handleClick}
        {...props}
      >
        {children}
      </a>
    );
  },
};
