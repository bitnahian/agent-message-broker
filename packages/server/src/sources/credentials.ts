import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Config-first, credentials-only credential store (ADR-0006).
 *
 * Credentials live on disk at `~/.amb/<kind>/credentials.json` and are never
 * stored in the broker DB. Each source kind has a fixed per-kind schema.
 *
 * The supported source kinds:
 *  - `github`: { token }
 *  - `jira`:   { email, apiToken, domain }
 *  - `google`: standard gcloud shape — service_account
 *              { client_email, private_key, project_id, type } OR
 *              OAuth authorized_user { client_id, client_secret, refresh_token, type }.
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

/**
 * Google credentials in the standard gcloud format so the key can be dropped
 * in as-is. Two accepted shapes:
 *  - service_account: { client_email, private_key, project_id, type }
 *  - authorized_user: { client_id, client_secret, refresh_token, type } (OAuth)
 */
export interface GoogleCredentials {
  /** service-account client email, e.g. "sa@project.iam.gserviceaccount.com". */
  client_email?: string;
  private_key?: string;
  project_id?: string;
  /** OAuth installed-app identity (authorized_user). */
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  /** "service_account" | "authorized_user" | "installed" */
  type?: string;
}

export type SourceCredentials = GitHubCredentials | JiraCredentials | GoogleCredentials;

export interface CredentialError extends Error {
  code: "MISSING_CREDENTIALS" | "MALFORMED_CREDENTIALS" | "INSECURE_PERMS";
  kind: string;
  path: string;
}

export type CredentialKind = "github" | "jira" | "google";

const SA_GOOGLE_FIELDS = ["client_email", "private_key", "project_id"] as const;
const OAUTH_GOOGLE_FIELDS = ["client_id", "client_secret", "refresh_token"] as const;

const _SCHEMAS: Record<Exclude<CredentialKind, "google">, string[]> = {
  github: ["token"],
  jira: ["email", "apiToken", "domain"],
};

export function credentialSchema(kind: CredentialKind): string[] {
  if (kind === "google") return [...SA_GOOGLE_FIELDS];
  return _SCHEMAS[kind];
}

function fail(code: CredentialError["code"], kind: CredentialKind, path: string, msg: string): never {
  const err = new Error(msg) as CredentialError;
  err.code = code;
  err.kind = kind;
  err.path = path;
  throw err;
}

/** Resolve the broker credential home (`~/.amb` by default; $AMB_HOME overrides). */
export function ambHome(): string {
  return process.env.AMB_HOME || join(homedir(), ".amb");
}

/** Per-kind credentials file path. */
export function credentialsPath(kind: CredentialKind, base: string = ambHome()): string {
  return join(base, kind, "credentials.json");
}

/**
 * Required fields for a kind. For google, accept either the service-account
 * snake_case shape or the OAuth authorized_user shape.
 */
function requiredFields(kind: CredentialKind, parsed: Record<string, unknown>): string[] {
  if (kind !== "google") return credentialSchema(kind);
  const type = parsed.type;
  const hasAll = (fields: readonly string[]) =>
    fields.every((x) => typeof parsed[x] === "string" && (parsed[x] as string).length > 0);
  if (type === "service_account" || hasAll(SA_GOOGLE_FIELDS)) return [...SA_GOOGLE_FIELDS];
  if (type === "authorized_user" || type === "installed" || hasAll(OAUTH_GOOGLE_FIELDS)) return [...OAUTH_GOOGLE_FIELDS];
  // fall back to SA fields; validation surfaces exactly which is missing
  return [...SA_GOOGLE_FIELDS];
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
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch (err) {
    fail("MALFORMED_CREDENTIALS", kind, path, `unable to stat ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Credential file must not be group/world readable.
  if ((mode & 0o077) !== 0) {
    fail("INSECURE_PERMS", kind, path, `insecure permissions on ${path} (mode ${mode.toString(8)}); expected 0600 or stricter`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    fail("MALFORMED_CREDENTIALS", kind, path, `unable to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    fail("MALFORMED_CREDENTIALS", kind, path, `malformed JSON in ${path}`);
  }
  const fields = requiredFields(kind, parsed);
  for (const field of fields) {
    const v = parsed[field];
    if (typeof v !== "string" || v.length === 0) {
      fail("MALFORMED_CREDENTIALS", kind, path, `missing required field "${field}" in ${path}`);
    }
  }
  return parsed as unknown as SourceCredentials;
}