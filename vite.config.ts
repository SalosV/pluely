import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

/**
 * Copies the VAD model + worklet + onnxruntime WASM binaries into `public/` so
 * the mic VAD works OFFLINE. Vite serves `public/` in dev and emits it to
 * `dist/` on build, so this single step covers both.
 *
 * By default @ricky0123/vad-web loads these from cdn.jsdelivr.net, which fails
 * in the packaged Tauri app (no guaranteed network / CSP). We copy them into
 * `public/vad/` and point useMicVAD at these local paths (see AutoSpeechVad).
 *
 * Runs at buildStart (both `vite` dev and `vite build`). Skips files that are
 * already up to date so it doesn't thrash on every dev restart.
 */
function copyVadAssets(): Plugin {
  // Only the assets actually used at runtime. vad-web's DEFAULT_MODEL is
  // "legacy", so we skip silero_vad_v5.onnx. onnxruntime-web picks the WASM at
  // runtime: with no cross-origin isolation (the Tauri case) it uses the
  // non-threaded build, preferring SIMD when the CPU supports it. So we ship
  // ort-wasm-simd.wasm (used on all modern CPUs) plus ort-wasm.wasm as a
  // no-SIMD fallback, and skip the ~19 MB of threaded variants that Tauri never
  // loads. This keeps public/vad ~21 MB instead of ~43 MB.
  const assets: string[] = [
    "node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js",
    "node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx",
    "node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm",
    "node_modules/onnxruntime-web/dist/ort-wasm.wasm",
  ];

  return {
    name: "copy-vad-assets",
    buildStart() {
      const destDir = path.resolve(__dirname, "public/vad");
      fs.mkdirSync(destDir, { recursive: true });
      for (const rel of assets) {
        const src = path.resolve(__dirname, rel);
        if (!fs.existsSync(src)) {
          console.warn(`[copy-vad-assets] missing, skipped: ${rel}`);
          continue;
        }
        const dest = path.join(destDir, path.basename(src));
        // Skip if destination already matches (same size) to avoid churn.
        if (
          fs.existsSync(dest) &&
          fs.statSync(dest).size === fs.statSync(src).size
        ) {
          continue;
        }
        fs.copyFileSync(src, dest);
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), copyVadAssets()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
