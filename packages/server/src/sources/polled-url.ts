import { createHash } from "node:crypto";
import { Poller, type PollResult } from "./poller.js";
import type { SourceContext } from "./registry.js";

export interface PolledUrlOptions {
  url: string;
  intervalMs?: number;
  headers?: Record<string, string>;
  /** emit an event on the first successful poll (baseline snapshot); default false */
  emitInitial?: boolean;
  /** max chars of body kept in payload snippet; default 2000 */
  snippetChars?: number;
}

/**
 * Quick-and-dirty polling source: fetch a URL, detect changes via
 * ETag/Last-Modified, falling back to a content hash. Emits:
 *  - "url-snapshot" (optional, first poll)
 *  - "url-changed"  (content changed)
 *  - "url-error"    (fetch/HTTP failure; deduped per status)
 */
export class PolledUrlSource extends Poller {
  private opts: PolledUrlOptions;

  constructor(ctx: SourceContext) {
    const opts = ctx.config.options as unknown as PolledUrlOptions;
    // ADR-0002: default poll interval for polled-url is 60s
    super(ctx, { intervalMs: opts.intervalMs ?? 60_000 });
    this.opts = opts;
  }

  protected async poll(): Promise<PollResult[]> {
    const { url, headers = {}, emitInitial = false, snippetChars = 2000 } = this.opts;
    const prevEtag = this.ctx.getState<string>("etag");
    const prevHash = this.ctx.getState<string>("contentHash");
    const hadBaseline = this.ctx.getState<boolean>("hasBaseline") ?? false;

    const reqHeaders: Record<string, string> = { ...headers };
    if (prevEtag) reqHeaders["if-none-match"] = prevEtag;

    let res: Response;
    try {
      res = await fetch(url, { headers: reqHeaders, redirect: "follow" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [{ kind: "url-error", key: `error:network:${msg}`, payload: { url, error: msg } }];
    }

    if (res.status === 304) return []; // unchanged per etag

    if (!res.ok) {
      return [{ kind: "url-error", key: `error:http:${res.status}`, payload: { url, status: res.status } }];
    }

    const body = await res.text();
    const etag = res.headers.get("etag") ?? undefined;
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
    this.ctx.setState("etag", etag);
    this.ctx.setState("contentHash", hash);
    this.ctx.setState("hasBaseline", true);

    const snippet = body.slice(0, snippetChars);
    if (!hadBaseline) {
      return emitInitial
        ? [{ kind: "url-snapshot", key: `snapshot:${hash}`, payload: { url, status: res.status, hash, snippet } }]
        : [];
    }
    if (hash === prevHash) return [];
    return [{
      kind: "url-changed",
      key: `changed:${hash}`,
      payload: { url, status: res.status, hash, previousHash: prevHash, snippet },
    }];
  }
}
