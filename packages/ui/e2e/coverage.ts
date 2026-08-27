/**
 * E2E coverage collection for Playwright.
 *
 * The UI is built with istanbul instrumentation when VITE_E2E_COVERAGE=1 (see
 * istanbul-plugin.ts), so each browser session writes honest per-line/per-branch
 * hit counts to `window.__coverage__`. This fixture reads that global after
 * every test, merges it with the rest of the run, and writes Istanbul reports
 * under packages/ui/e2e-coverage/ (JSON + HTML + printed text summary).
 *
 * Import `test`/`expect` from this module (instead of "@playwright/test")
 * from every spec so the coverage fixture is applied automatically.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCoverageMap } = require("istanbul-lib-coverage") as any;
const libReport = require("istanbul-lib-report") as any;
const libReports = require("istanbul-reports") as any;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OUT_DIR = join(ROOT, "packages", "ui", "e2e-coverage");
const RAW_FILE = "/tmp/amb-e2e-raw-coverage.json";

export const collected: any[] = [];

function persist(): void {
  writeFileSync(RAW_FILE, JSON.stringify(collected), "utf-8");
}

export const test = base.extend({
  page: async ({ page }, use) => {
    if (!existsSync(RAW_FILE)) writeFileSync(RAW_FILE, "[]", "utf-8");
    try {
      await use(page);
    } finally {
      try {
        // the instrumented bundle records per-run coverage; capture it now
        const cov = await page.evaluate(() => (window as any).__coverage__).catch(() => undefined);
        if (cov && typeof cov === "object" && Object.keys(cov).length) {
          collected.push(cov);
          persist();
        }
      } catch { /* ignore */ }
    }
  },
});

export const expect = base.expect;

const isSrcFile = (f: string) =>
  f.replace(/\\/g, "/").includes("/packages/ui/src/") &&
  !/\.(test|stories)\./.test(f) && !f.replace(/\\/g, "/").endsWith("/src/main.tsx");

/** Merge all collected per-page istanbul coverage into one map (src files only). */
export function toCoverageMap(entries: any[]): any {
  const merged = createCoverageMap({});
  for (const pageCov of entries) {
    if (!pageCov) continue;
    const filtered: Record<string, unknown> = {};
    for (const [file, cov] of Object.entries(pageCov)) {
      if (isSrcFile(file)) filtered[file] = cov;
    }
    if (Object.keys(filtered).length) merged.merge(createCoverageMap(filtered) as any);
  }
  return merged;
}

/** Read persisted coverage, merge it, and write JSON + text + html reports. */
export function writeCoverageReport(): void {
  try {
    if (!existsSync(RAW_FILE)) { console.warn("[coverage] no raw coverage file; skipping"); return; }
    let entries: any[];
    try { entries = JSON.parse(readFileSync(RAW_FILE, "utf-8")); } catch { entries = []; }
    if (!entries.length) { console.warn("[coverage] raw coverage empty; skipping"); return; }

    const map = toCoverageMap(entries);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, "coverage-final.json"), JSON.stringify(map.toJSON()), "utf-8");

    const summary = map.getCoverageSummary();
    const pct = (v: any) => (Number.isFinite(v.pct) ? `${v.pct}%` : "n/a");
    console.log("e2e coverage (packages/ui/src):");
    console.log(`  stmts: ${pct(summary.statements)}  branch: ${pct(summary.branches)}  funcs: ${pct(summary.functions)}  lines: ${pct(summary.lines)}`);

    const context = libReport.createContext({ dir: OUT_DIR, coverageMap: map, defaultSummarizer: "nested" });
    libReports.create("text-summary", { skipFull: false }).execute(context);
    libReports.create("html", {}).execute(context);
  } catch (err) {
    console.error("coverage report failed:", err);
  }
}