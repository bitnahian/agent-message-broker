import { Poller, type PollResult } from "./poller.js";
import type { SourceContext } from "./registry.js";
import { loadCredentials } from "./credentials.js";
import type { GoogleCredentials } from "./credentials.js";

export interface GoogleSourceOptions {
  /** googleapis API target, e.g. "drive.files.list" | "sheets.spreadsheets.values.get". */
  api: string;
  /** params for the call, e.g. {"spreadsheetId": "...", "range": "A1"} or {"pageSize": 10}. */
  params?: Record<string, unknown>;
  /** JSON path to the items array in the response, e.g. "files" | "values". */
  itemsPath: string;
  /** item field used as identity; default "id". */
  idField?: string;
  /** when set, dedupe key becomes `<id>@<field value>` (e.g. "modifiedTime") so updates re-emit. */
  fingerprintField?: string;
  intervalMs?: number;
}

/**
 * Google API invocation surface the feed depends on, so tests inject a fake
 * (no network). A function that calls the googleapis method for `api` with
 * `params` and returns the data object.
 */
export type GoogleApiRunner = (api: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Split an `api` spec into [service, resourcePath, method]. */
export function splitApi(api: string): { service: string; resourcePath: string[]; method: string } {
  const parts = api.split(".");
  if (parts.length < 3 || parts.some((p) => !p)) throw new Error(`invalid google api target: ${api}`);
  return { service: parts[0], resourcePath: parts.slice(1, -1), method: parts[parts.length - 1] };
}

const VERSIONS: Record<string, string> = { drive: "v3", sheets: "v4", docs: "v1", gmail: "v1", calendar: "v3", pubsub: "v1" };

/** Load a cached OAuth2Client from ~/.amb/google/token.json, or null. */
async function loadOAuthFrom(base?: string): Promise<unknown> {
  const { cachedGoogleClient } = await import("./google-auth.js");
  try {
    return cachedGoogleClient(base);
  } catch {
    return null;
  }
}

/**
 * Build the default googleapis-based runner from `~/.amb/google/credentials.json`.
 * Accepts the service_account shape (JWT) or the OAuth authorized_user shape.
 * Dispatches `"<service>.<resource>.<method>"` to the matching googleapis client
 * via the service factory (e.g. drive({version:"v3"}).files.list).
 */
export async function buildGoogleApi(base?: string): Promise<GoogleApiRunner> {
  // googleapis is an optional peer dep (large install); fail loud with the fix.
  const mod = await import("googleapis").catch(() => null);
  if (!mod) {
    throw new Error("googleapis is not installed. Google Workspace sources need it: npm install googleapis");
  }
  const { google } = mod;
  // Per-developer OAuth token (distributed-tool pattern): reuse a cached
  // token.json OAuth2Client when present so the google feed acts as the
  // logged-in developer (needed for Drive/Sheets/Docs).
  let auth: unknown = await loadOAuthFrom(base);
  if (!auth) {
    const creds = loadCredentials("google", base) as GoogleCredentials;
    if (creds.type === "service_account" || creds.private_key) {
      const { JWT } = await import("google-auth-library");
      auth = new JWT({ email: creds.client_email!, key: creds.private_key!, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    } else {
      const { OAuth2Client } = await import("google-auth-library");
      const oauth = new OAuth2Client({ clientId: creds.client_id, clientSecret: creds.client_secret });
      oauth.setCredentials({ refresh_token: creds.refresh_token });
      auth = oauth;
    }
  }

  const clientCache = new Map<string, unknown>();
  function getClient(service: string): unknown {
    const cached = clientCache.get(service);
    if (cached) return cached;
    const version = VERSIONS[service];
    if (!version) throw new Error(`unsupported google service: ${service}`);
    const factory = google[service as keyof typeof google] as ((opts: { version: string; auth: unknown }) => unknown) | undefined;
    if (typeof factory !== "function") throw new Error(`no googleapis factory for: ${service}`);
    const client = factory({ version, auth });
    clientCache.set(service, client);
    return client;
  }

  const methodCache = new Map<string, (p: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>>();
  return async (api, params) => {
    let call = methodCache.get(api);
    if (!call) {
      const parsed = splitApi(api);
      let node: Record<string, unknown> = getClient(parsed.service) as Record<string, unknown>;
      for (const seg of parsed.resourcePath) {
        const next = node[seg] as Record<string, unknown> | undefined;
        if (!next) throw new Error(`no resource ${parsed.service}.${parsed.resourcePath.join(".")}`);
        node = next;
      }
      const fn = node[parsed.method] as ((p: unknown) => Promise<{ data: Record<string, unknown> }>) | undefined;
      if (typeof fn !== "function") throw new Error(`no method ${parsed.service}.${parsed.resourcePath.join(".")}.${parsed.method}`);
      call = fn.bind(node);
      methodCache.set(api, call);
    }
    const res = await call(params);
    return res.data;
  };
}

/**
 * Google SDK feed (ADR-0006/0007). Polls a googleapis endpoint (drive.files.list,
 * sheets.spreadsheets.values.get, ...) through an injectable runner and emits
 * `gws:<service>:<new|changed>` events, matching the pre-existing gws CLI kind
 * contract so existing subscriptions keep working. Replaces the `gws` CLI exec.
 */
export class GoogleSource extends Poller {
  private opts: GoogleSourceOptions;
  private runner: GoogleApiRunner;
  private built: GoogleApiRunner | null = null;

  constructor(ctx: SourceContext, runner?: GoogleApiRunner) {
    const opts = ctx.config.options as unknown as GoogleSourceOptions;
    super(ctx, { intervalMs: opts.intervalMs ?? 120_000 });
    this.opts = opts;
    this.runner = runner ?? (async (api, params) => {
      if (!this.built) this.built = await buildGoogleApi();
      return this.built(api, params);
    });
  }

  private serviceName(): string {
    return splitApi(this.opts.api).service ?? "google";
  }

  protected async poll(): Promise<PollResult[]> {
    const { itemsPath, idField = "id", fingerprintField, params = {} } = this.opts;
    let doc: Record<string, unknown>;
    try {
      doc = await this.runner(this.opts.api, params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [{ kind: "gws:error", key: `error:${msg.slice(0, 80)}`, payload: { error: msg } }];
    }
    const items = (doc[itemsPath] as Record<string, unknown>[] | undefined) ?? [];
    const svc = this.serviceName();
    const results: PollResult[] = [];
    for (const item of items) {
      const id = String(dig(item, idField) ?? "");
      if (!id) continue;
      const fingerprint = fingerprintField ? String(dig(item, fingerprintField) ?? "") : "";
      const key = fingerprint ? `gws:${svc}:${id}@${fingerprint}` : `gws:${svc}:${id}`;
      results.push({
        kind: `gws:${svc}:${fingerprintField ? "changed" : "new"}`,
        key,
        payload: { service: svc, id, fingerprint: fingerprint || undefined, item },
      });
    }
    return results;
  }
}

/**
 * Resolve a possibly-dotted path (`a.b.c`) against an object. Sheet row arrays
 * are supported via a numeric index path (e.g. idField "0" keys on the first
 * cell) so `sheets.spreadsheets.values.get` rows work as feed items.
 */
function dig(obj: unknown, path: string): unknown {
  let cur: unknown = obj as Record<string, unknown> & { [k: string]: unknown };
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(seg)) {
      cur = cur[Number(seg)];
    } else {
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}