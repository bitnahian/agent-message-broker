import { createHash } from "node:crypto";
import { Poller, type PollResult } from "./poller.js";
import type { SourceContext } from "./registry.js";
import { loadCredentials } from "./credentials.js";
import type { JiraCredentials } from "./credentials.js";

export interface JiraSourceOptions {
  /** JQL query, e.g. "project = KAN ORDER BY updated DESC" */
  jql: string;
  /** feed event-type allowlist; empty = all supported. Defaults to ["workitem-updated"]. */
  eventTypes?: string[];
  intervalMs?: number;
  limit?: number;
}

export interface JiraWorkItem {
  id: string;
  key: string;
  fields: {
    summary?: string;
    updated?: string;
    status?: { name?: string };
    assignee?: { displayName?: string } | null;
    issuetype?: { name?: string };
  };
}

/** Atlassian Cloud Jira Search REST response (v3 /rest/api/3/search/jql). */
export interface JiraSearchResponse {
  issues: JiraWorkItem[];
}

/**
 * Minimal Atlassian REST client surface the Jira feed depends on, so tests
 * inject a fake (no network). We only call `search(jql, limit)`.
 */
export interface AtlassianRestLike {
  search: (jql: string, limit: number) => Promise<JiraSearchResponse>;
}

/** Build an Atlassian REST client from ~/.amb/jira/credentials.json (email + apiToken + domain). */
export function buildAtlassian(base?: string): AtlassianRestLike {
  const { email, apiToken, domain } = loadCredentials("jira", base) as JiraCredentials;
  const baseUrl = domain.startsWith("https://") ? domain : `https://${domain}`;
  const auth = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  return {
    search: async (jql, limit) => {
      const res = await fetch(`${baseUrl}/rest/api/3/search/jql`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth, accept: "application/json" },
        body: JSON.stringify({ jql, maxResults: limit, fields: ["summary", "updated", "status", "assignee", "issuetype"] }),
      });
      if (!res.ok) {
        throw new Error(`jira search failed: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as JiraSearchResponse;
    },
  };
}

function fingerprintHash(item: JiraWorkItem): string {
  return createHash("sha256")
    .update(JSON.stringify([item.key, item.fields.summary, item.fields.status?.name, item.fields.assignee?.displayName, item.fields.issuetype?.name]))
    .digest("hex").slice(0, 16);
}

/** Canonical event kinds a jira feed can emit (ADR-0005 kind `jira:<type>`). */
export const JIRA_EVENT_TYPES = ["workitem-updated"] as const;

/**
 * Jira SDK poller over Atlassian Cloud REST (ADR-0006), replacing the `acli`
 * CLI exec. Emits `jira:workitem-updated` per work item whose `updated`
 * timestamp is new (key = `<KEY>@<updated>`), with a content-hash fallback when
 * `updated` is absent. Filtered by the feed event-type allowlist.
 */
export class JiraSource extends Poller {
  private opts: JiraSourceOptions;
  private api: AtlassianRestLike;

  constructor(ctx: SourceContext, api?: AtlassianRestLike) {
    const opts = ctx.config.options as unknown as JiraSourceOptions;
    super(ctx, { intervalMs: opts.intervalMs ?? 120_000 });
    this.opts = opts;
    this.api = api ?? buildAtlassian();
  }

  protected async poll(): Promise<PollResult[]> {
    const limit = this.opts.limit ?? 20;
    let items: JiraWorkItem[];
    try {
      const res = await this.api.search(this.opts.jql, limit);
      items = res.issues;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [{ kind: "jira:error", key: `error:${msg.slice(0, 80)}`, payload: { error: msg } }];
    }
    const allow = new Set(this.opts.eventTypes ?? JIRA_EVENT_TYPES);
    const results: PollResult[] = [];
    for (const item of items) {
      const updated = item.fields.updated;
      const fingerprint = updated ?? fingerprintHash(item);
      const actions = [
        { kind: "jira:workitem-updated", key: `jira:${item.key}@${fingerprint}`, payload: { key: item.key, summary: item.fields.summary, status: item.fields.status?.name, assignee: item.fields.assignee?.displayName ?? null, issueType: item.fields.issuetype?.name, updated: updated ?? null } },
      ];
      if (actions.length === 0) continue;
      for (const a of actions) if (allow.has("workitem-updated")) results.push(a);
    }
    return results;
  }
}