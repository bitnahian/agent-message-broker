import { Octokit } from "octokit";
import { Poller, type PollResult } from "./poller.js";
import type { SourceContext } from "./registry.js";
import { loadCredentials } from "./credentials.js";

export interface GitHubSourceOptions {
  /** e.g. "owner/repo" → queries repos/{owner}/{repo}/events */
  repo?: string;
  /** feed event-type allowlist (ADR-0005); empty = all supported types */
  eventTypes?: string[];
  intervalMs?: number;
  /** max events per poll; default 30 */
  perPage?: number;
}

export interface GhEvent {
  id: string;
  type: string;
  actor?: { login?: string } | null;
  repo?: { name?: string } | null;
  created_at?: string;
  payload?: Record<string, unknown>;
}

/**
 * Minimal octokit surface the GitHub feed depends on, so tests can inject a
 * fake client (no network). We only read repository events and, for webhook
 * registration (ADR-0007), manage hooks.
 */
export interface OctokitLike {
  rest: {
    activity: {
      listRepoEvents: (p: { owner: string; repo: string; per_page?: number }) => Promise<{ data: GhEvent[] }>;
    };
    repos: {
      listHooks?: (p: { owner: string; repo: string }) => Promise<{ data: { id: number }[] }>;
      createWebhook?: (p: { owner: string; repo: string; name: string; config: Record<string, unknown>; events: string[] }) => Promise<{ data: { id: number } }>;
      deleteWebhook?: (p: { owner: string; repo: string; hook_id: number }) => Promise<{ status: number }>;
    };
  };
}

/** Build an authenticated octokit client from ~/.amb/github/credentials.json. */
export function buildOctokit(base?: string): OctokitLike {
  const { token } = loadCredentials("github", base) as { token: string };
  const octokit = new Octokit({ auth: token });
  return octokit as unknown as OctokitLike;
}

function summarize(ev: GhEvent): string {
  const actor = ev.actor?.login ?? "?";
  const repo = ev.repo?.name ?? "";
  const p = ev.payload ?? {};
  switch (ev.type) {
    case "PushEvent": {
      const commits = (p.commits as { message?: string }[] | undefined) ?? [];
      return `${actor} pushed ${commits.length} commit(s) to ${repo}: ${commits[0]?.message?.split("\n")[0] ?? ""}`;
    }
    case "PullRequestEvent": return `${actor} ${String(p.action)} PR #${(p.pull_request as { number?: number })?.number ?? "?"} in ${repo}`;
    case "IssuesEvent": return `${actor} ${String(p.action)} issue #${(p.issue as { number?: number })?.number ?? "?"} in ${repo}`;
    case "IssueCommentEvent": return `${actor} commented in ${repo}`;
    case "CreateEvent": return `${actor} created ${String(p.ref_type)} in ${repo}`;
    case "DeleteEvent": return `${actor} deleted ${String(p.ref_type)} in ${repo}`;
    case "WatchEvent": return `${actor} starred ${repo}`;
    case "ForkEvent": return `${actor} forked ${repo}`;
    case "ReleaseEvent": return `${actor} released in ${repo}`;
    default: return `${actor} ${ev.type} in ${repo}`;
  }
}

/**
 * GitHub SDK poller over octokit (ADR-0006), replacing `gh api` CLI exec.
 * Polls repository events, filters by the feed event-type allowlist, dedupes
 * on GitHub's stable event id, and emits `github:<Type>` events (same kinds as
 * the previous CLI poller / as the webhook tier).
 */
export class GitHubSource extends Poller {
  private opts: GitHubSourceOptions;
  private api: OctokitLike;

  constructor(ctx: SourceContext, api?: OctokitLike) {
    const opts = ctx.config.options as unknown as GitHubSourceOptions;
    super(ctx, { intervalMs: opts.intervalMs ?? 60_000 });
    this.opts = opts;
    this.api = api ?? buildOctokit();
  }

  /** The concrete octokit client (exposed for webhook registration). */
  get octokit(): OctokitLike {
    return this.api;
  }

  /** Register a repository webhook via octokit (ADR-0007). Returns the hook id. */
  async registerWebhook(owner: string, repo: string, url: string, events: string[], secret: string): Promise<number> {
    const { data } = await this.api.rest.repos.createWebhook!({
      owner, repo,
      name: "web",
      config: { url, content_type: "json", secret },
      events,
    });
    return data.id;
  }

  /** Delete a registered repo webhook by id. */
  async deleteWebhook(owner: string, repo: string, hookId: number): Promise<boolean> {
    const res = await this.api.rest.repos.deleteWebhook!({ owner, repo, hook_id: hookId });
    return res.status >= 200 && res.status < 300;
  }

  protected async poll(): Promise<PollResult[]> {
    let events: GhEvent[];
    try {
      events = await this.fetchEvents();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [{ kind: "github:error", key: `error:${msg.slice(0, 80)}`, payload: { error: msg } }];
    }
    const perPage = this.opts.perPage ?? 30;
    const allow = this.opts.eventTypes;
    return events.slice(0, perPage)
      .filter((ev) => !allow || allow.includes(ev.type))
      .map((ev) => ({
        kind: `github:${ev.type}`,
        key: `gh:${ev.id}`,
        payload: {
          id: ev.id,
          type: ev.type,
          repo: ev.repo?.name,
          actor: ev.actor?.login,
          createdAt: ev.created_at,
          summary: summarize(ev),
        },
      }));
  }

  private async fetchEvents(): Promise<GhEvent[]> {
    const repo = this.opts.repo;
    if (!repo || !repo.includes("/")) {
      throw new Error("github feed requires options.repo (owner/repo)");
    }
    const [owner, name] = repo.split("/");
    const perPage = this.opts.perPage ?? 30;
    const { data } = await this.api.rest.activity.listRepoEvents({ owner, repo: name, per_page: perPage });
    return data;
  }
}

export { summarize as githubSummarize };
