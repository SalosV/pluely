import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// Configuration constants for the level meter
const AUDIO_CONFIG = {
  // Number of history samples drawn across the canvas at once. Each Rust
  // "audio-level" event (~every 100ms) pushes one new sample in on the right
  // and the oldest sample scrolls off the left.
  HISTORY_LENGTH: 48,
  // Lerp factor applied to incoming levels so the meter doesn't jitter
  // between consecutive ~100ms samples.
  SMOOTHING: 0.35,
  MIN_BAR_HEIGHT: 2,
  MIN_BAR_WIDTH: 2,
  BAR_SPACING: 4,
  COLOR: {
    MIN_INTENSITY: 100, // Minimum gray value (darker)
    MAX_INTENSITY: 255, // Maximum gray value (brighter)
    INTENSITY_RANGE: 155, // MAX_INTENSITY - MIN_INTENSITY
  },
} as const;

interface AudioVisualizerProps {
  isRecording: boolean;
  stream?: MediaStream | null;
}

// `stream` is kept in the props for API compatibility with callers that pass
// a browser MediaStream (e.g. mic recording elsewhere in the app), but system
// audio capture happens in the Rust backend, so there is nothing to read from
// it here.
export function AudioVisualizer({
  stream: _stream,
  isRecording,
}: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number>(0);

  // Rolling history of smoothed levels (0..1), oldest first. Drawn as bars
  // left-to-right so the meter scrolls as new samples arrive.
  const historyRef = useRef<number[]>(
    new Array(AUDIO_CONFIG.HISTORY_LENGTH).fill(0)
  );
  // Current smoothed level, updated by lerping toward each incoming raw
  // sample from the "audio-level" event.
  const smoothedLevelRef = useRef<number>(0);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current && containerRef.current) {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        const dpr = window.devicePixelRatio || 1;

        // Set canvas size based on container and device pixel ratio
        const rect = container.getBoundingClientRect();
        // Account for the 2px total margin (1px on each side)
        canvas.width = (rect.width - 2) * dpr;
        canvas.height = (rect.height - 2) * dpr;

        // Scale canvas CSS size to match container minus margins
        canvas.style.width = `${rect.width - 2}px`;
        canvas.style.height = `${rect.height - 2}px`;
      }
    };

    window.addEventListener("resize", handleResize);
    // Initial setup
    handleResize();

    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Calculate the color intensity based on bar height
  const getBarColor = (normalizedHeight: number) => {
    const intensity =
      Math.floor(normalizedHeight * AUDIO_CONFIG.COLOR.INTENSITY_RANGE) +
      AUDIO_CONFIG.COLOR.MIN_INTENSITY;
    return `rgb(${intensity}, ${intensity}, ${intensity})`;
  };

  // Draw a single bar of the visualizer
  const drawBar = (
    ctx: CanvasRenderingContext2D,
    x: number,
    centerY: number,
    width: number,
    height: number,
    color: string
  ) => {
    ctx.fillStyle = color;
    // Draw upper bar (above center)
    ctx.fillRect(x, centerY - height, width, height);
    // Draw lower bar (below center)
    ctx.fillRect(x, centerY, width, height);
  };

  // Render the current rolling history buffer to the canvas
  const drawFrame = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.width / dpr;
    const cssHeight = canvas.height / dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const history = historyRef.current;
    const barWidth = Math.max(
      AUDIO_CONFIG.MIN_BAR_WIDTH,
      cssWidth / history.length - AUDIO_CONFIG.BAR_SPACING
    );
    const centerY = cssHeight / 2;
    let x = 0;

    for (let i = 0; i < history.length; i++) {
      const normalizedHeight = history[i];
      const barHeight = Math.max(
        AUDIO_CONFIG.MIN_BAR_HEIGHT,
        normalizedHeight * centerY
      );

      drawBar(
        ctx,
        x,
        centerY,
        barWidth,
        barHeight,
        getBarColor(normalizedHeight)
      );

      x += barWidth + AUDIO_CONFIG.BAR_SPACING;
    }
  };

  // Subscribe to real audio levels and drive the draw loop while recording
  useEffect(() => {
    if (!isRecording) {
      cancelAnimationFrame(animationFrameRef.current);
      return;
    }

    // Reset state so a new recording session starts from a flat, silent
    // meter instead of carrying over the previous session's history.
    historyRef.current = new Array(AUDIO_CONFIG.HISTORY_LENGTH).fill(0);
    smoothedLevelRef.current = 0;

    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    const setupListener = async () => {
      try {
        const fn = await listen<number>("audio-level", (event) => {
          const rawLevel = Math.min(1, Math.max(0, event.payload));
          smoothedLevelRef.current +=
            (rawLevel - smoothedLevelRef.current) * AUDIO_CONFIG.SMOOTHING;

          const history = historyRef.current;
          history.push(smoothedLevelRef.current);
          if (history.length > AUDIO_CONFIG.HISTORY_LENGTH) {
            history.shift();
          }
        });

        // The effect may have been cleaned up while awaiting listen(); if so,
        // unlisten immediately so no stale listener survives.
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      } catch (error) {
        console.error("Failed to subscribe to audio-level event:", error);
      }
    };

    setupListener();

    const loop = () => {
      drawFrame();
      animationFrameRef.current = requestAnimationFrame(loop);
    };
    animationFrameRef.current = requestAnimationFrame(loop);

    return () => {
      cancelled = true;
      unlisten?.();
      cancelAnimationFrame(animationFrameRef.current);
    };
  }, [isRecording]);

  return (
    <div ref={containerRef} className="!h-[32px] !w-full pl-4 pt-2">
      <canvas ref={canvasRef} className="h-full !w-full" />
    </div>
  );
}
