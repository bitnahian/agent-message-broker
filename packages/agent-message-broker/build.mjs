/**
 * Package build for the published `agent-message-broker` npm package.
 *
 * Bundles the workspace TS sources into two self-contained ESM files:
 *   dist/cli.js     — the `amb` CLI (bundles @amb/cli + @amb/core)
 *   dist/server.js  — the broker server (bundles @amb/server, core, adapters)
 *
 * npm deps (fastify, octokit, commander, ...) stay external and are declared
 * as real dependencies; googleapis stays an optional peer dep so the default
 * install stays small. The prebuilt UI (built by nx into ../ui/dist) is copied
 * to ./ui and shipped as static assets the server serves.
 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";

// npm packages resolve at runtime from the published package's dependencies;
// everything else (@amb/* workspace sources) is bundled in.
const external = [
  "commander",
  "fastify",
  "@fastify/static",
  "octokit",
  "google-auth-library",
  "googleapis",
  "diff",
];

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
};

mkdirSync("dist", { recursive: true });

await build({
  ...common,
  entryPoints: ["../cli/src/index.ts"],
  outfile: "dist/cli.js",
  external,
});

await build({
  ...common,
  entryPoints: ["../server/src/index.ts"],
  outfile: "dist/server.js",
  external,
});

if (!existsSync("../ui/dist")) {
  throw new Error("UI is not built: run `npm run build` at the repo root first (nx builds @amb/ui into packages/ui/dist).");
}
rmSync("ui", { recursive: true, force: true });
cpSync("../ui/dist", "ui", {
  recursive: true,
  filter: (src) => !src.endsWith(".map"), // vite sourcemaps: dev-only, 3x tarball size
});

console.log("packaged: dist/cli.js, dist/server.js, ui/");
