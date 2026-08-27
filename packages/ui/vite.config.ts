import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { istanbulCoveragePlugin } from "./istanbul-plugin";

export default defineConfig({
  plugins: [react(), tailwindcss(), istanbulCoveragePlugin()],
  server: {
    proxy: {
      "/topics": "http://127.0.0.1:4733",
      "/sources": "http://127.0.0.1:4733",
      "/subscriptions": "http://127.0.0.1:4733",
      "/sessions": "http://127.0.0.1:4733",
      "/events": "http://127.0.0.1:4733",
      "/agents": "http://127.0.0.1:4733",
      "/health": "http://127.0.0.1:4733",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "src/test-setup.ts", "src/**/*.stories.tsx", "src/**/*.test.tsx", "src/assets/**"],
    },
  },
} as import("vite").UserConfig & { test?: Record<string, unknown> });
