/**
 * Vite plugin that instruments the app source with istanbul when
 * VITE_E2E_COVERAGE=1, so a real browser run records per-line/per-branch
 * hit counts to `window.__coverage__` (like c8/instrumented-runtime coverage).
 *
 * Runs with enforce:'post' so it sees plain JS (esbuild already stripped JSX),
 * making istanbul-lib-instrument able to parse the module without a JSX preset.
 */
import { createInstrumenter } from "istanbul-lib-instrument";
import type { Plugin } from "vite";

export function istanbulCoveragePlugin(): Plugin {
  const enabled = process.env.VITE_E2E_COVERAGE === "1";
  const instrumenter = createInstrumenter({
    esModules: true,
    coverageVariable: "__coverage__",
    autoWrap: false,
  });

  return {
    name: "amb-e2e-istanbul-coverage",
    enforce: "post",
    transform(code, id) {
      if (!enabled) return null;
      if (!/\.(tsx?|m?jsx?)$/.test(id)) return null;
      const norm = id.replace(/\\/g, "/");
      if (norm.includes("/node_modules/")) return null;
      if (!norm.includes("/packages/ui/src/")) return null;
      if (/\.(test|stories)\./.test(norm) || norm.endsWith("main.tsx")) return null;
      try {
        return { code: instrumenter.instrumentSync(code, id), map: null };
      } catch {
        // leave un-instrumented if we can't parse it
        return null;
      }
    },
  };
}