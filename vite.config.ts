import { rm } from "node:fs/promises";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(({ mode }) => {
  const learningEnabled =
    process.env.VITE_FEATURE_LEARNING === "1" ||
    mode === "learning-preview";

  return {
    plugins: [
      react(),
      {
        name: "yuanyuan-learning-asset-boundary",
        apply: "build",
        async closeBundle() {
          if (!learningEnabled) {
            await rm("dist/assets/pet/learning-atlas.webp", { force: true });
          }
        },
      },
    ],
    define: {
      __YUANYUAN_LEARNING_ENABLED__: JSON.stringify(learningEnabled),
    },
    clearScreen: false,
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
        ignored: ["**/src-tauri/**"],
      },
    },
    envPrefix: ["VITE_", "TAURI_"],
    test: {
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/src-tauri/target/**",
      ],
    },
    build: {
      target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
      minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
      sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    },
  };
});
