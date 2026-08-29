/**
 * Env resolution for the live e2e harnesses.
 *
 * One code path for local and CI:
 *   1. process environment (CI: the CI secret store maps to these names)
 *   2. repo-root `.env` (gitignored; local fallback, KEY=VALUE lines)
 *
 * Personal identifiers (emails, domains, projects) and secrets NEVER live in
 * harness code or committed files. See `.env.example` for the full key list
 * and `docs/agents/e2e-secrets.md` for the contract.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const ENV_FILE = join(REPO_ROOT, ".env");

let envFileCache: Map<string, string> | null = null;

function envFile(): Map<string, string> {
  if (envFileCache) return envFileCache;
  envFileCache = new Map();
  if (!existsSync(ENV_FILE)) return envFileCache;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    envFileCache.set(key, value);
  }
  return envFileCache;
}

/** Required env var: process env first, then repo-root `.env`. */
export function e2eSecret(key: string): string {
  const value = process.env[key] ?? envFile().get(key);
  if (!value) {
    throw new Error(
      `missing e2e env ${key} — export ${key}=... or set it in .env (gitignored; see .env.example)`,
    );
  }
  return value;
}

/** Optional env var: undefined when unset (harness decides how to degrade). */
export function e2eSecretOptional(key: string): string | undefined {
  return process.env[key] ?? envFile().get(key);
}

/** Optional env var with a committed, non-personal default. */
export function e2eEnvWithDefault(key: string, fallback: string): string {
  return process.env[key] ?? envFile().get(key) ?? fallback;
}
