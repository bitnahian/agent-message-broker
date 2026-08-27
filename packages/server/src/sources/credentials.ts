import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Config-first, credentials-only credential store (ADR-0006).
 *
 * Credentials live on disk at `~/.amb/<kind>/credentials.json` and are never
 * stored in the broker DB. Each source kind has a fixed per-kind schema.
 *
 * The three supported source kinds:
 *  - `github`: { token }
 *  - `jira`:   { email, apiToken, domain }
 *  - `google`: { clientEmail, privateKey, projectId }   (service account)
 *
 * Loader resolves `~/.amb/` (honoring $AMB_HOME when set), validates the file
 * is present and mode is not world-readable, returns typed credentials, and
 * throws a clear, actionable error for missing/malformed files so sources can
 * fail fast/loud on start.
 */

export interface GitHubCredentials {
  token: string;
}
export interface JiraCredentials {
  email: string;
  apiToken: string;
  domain: string;
}
export interface GoogleCredentials {
  /** service-account client email, e.g. "sa@project.iam.gserviceaccount.com" */
  clientEmail: string;
  privateKey: string;
  projectId: string;
}

export type SourceCredentials = GitHubCredentials | JiraCredentials | GoogleCredentials;

export interface CredentialError extends Error {
  code: "MISSING_CREDENTIALS" | "MALFORMED_CREDENTIALS" | "INSECURE_PERMS";
  kind: string;
  path: string;
}

export type CredentialKind = "github" | "jira" | "google";

const SCHEMAS: Record<CredentialKind, string[]> = {
  github: ["token"],
  jira: ["email", "apiToken", "domain"],
  google: ["clientEmail", "privateKey", "projectId"],
};

/** Resolve the broker credential home (`~/.amb` by default; $AMB_HOME overrides). */
export function ambHome(): string {
  return process.env.AMB_HOME || join(homedir(), ".amb");
}

/** Per-kind credentials file path. */
export function credentialsPath(kind: CredentialKind, base: string = ambHome()): string {
  return join(base, kind, "credentials.json");
}

function fail(code: CredentialError["code"], kind: CredentialKind, path: string, msg: string): never {
  const err = new Error(msg) as CredentialError;
  err.code = code;
  err.kind = kind;
  err.path = path;
  throw err;
}

/**
 * Load and validate credentials for a source kind.
 *
 * Throws `CredentialError` (code MISSING/MALFORMED/INSECURE_PERMS) when the
 * file is absent, unparseable, shape-invalid, or world-readable. Returns a
 * typed credential object on success.
 */
export function loadCredentials(kind: CredentialKind, base?: string): SourceCredentials {
  const home = base ?? ambHome();
  const path = credentialsPath(kind, home);
  if (!existsSync(path)) {
    fail("MISSING_CREDENTIALS", kind, path, `credentials not found: ${path} (run 'amb config init' to scaffold ~/.amb/${kind}/credentials.json)`);
  }
  try {
    const mode = statSync(path).mode & 0o777;
    // Credential file must not be group/world readable.
    if ((mode & 0o077) !== 0) {
      fail("INSECURE_PERMS", kind, path, `insecure permissions on ${path} (mode ${mode.toString(8)}); expected 0600 or stricter`);
    }
    const raw = readFileSync(path, "utf8");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      fail("MALFORMED_CREDENTIALS", kind, path, `malformed JSON in ${path}`);
    }
    const required = SCHEMAS[kind];
    for (const field of required) {
      const v = parsed[field];
      if (typeof v !== "string" || v.length === 0) {
        fail("MALFORMED_CREDENTIALS", kind, path, `missing required field "${field}" in ${path}`);
      }
    }
    return parsed as unknown as SourceCredentials;
  } catch (err) {
    // rethrow our own CredentialError; wrap anything unexpected.
    if ((err as CredentialError).code) throw err;
    fail("MALFORMED_CREDENTIALS", kind, path, `unable to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Return the schema (required fields) for a kind, for scaffolding templates. */
export function credentialSchema(kind: CredentialKind): string[] {
  return SCHEMAS[kind];
}
