import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Poller, type PollResult } from "./poller.js";
import type { SourceContext } from "./registry.js";

const execFileAsync = promisify(execFile);

export interface GitHubSourceOptions {
  /** e.g. "owner/repo" → polls repos/{owner}/{repo}/events */
  repo?: string;
  /** raw gh api path override, e.g. "notifications" or "users/<u>/events" */
  path?: string;
  intervalMs?: number;
  /** max events per poll; default 30 */
  perPage?: number;
}

export interface GhEvent {
  id: string;
  type: string;
  actor?: { login?: string };
  repo?: { name?: string };
  created_at?: string;
  payload?: Record<string, unknown>;
}

export type GhRunner = (path: string) => Promise<string>;

/** Default runner shells out to `gh api` (uses the user's existing gh auth). */
export const ghRunner: GhRunner = async (path) => {
  const { stdout } = await execFileAsync("gh", ["api", path], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
};

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
 * GitHub events via `gh api` polling. Webhooks are intentionally not used:
 * the broker is local-only and can't receive pushes without a tunnel.
 * Dedupe via GitHub's stable event ids.
 */
export class GitHubSource extends Poller {
  private opts: GitHubSourceOptions;
  private runner: GhRunner;

  constructor(ctx: SourceContext, runner: GhRunner = ghRunner) {
    const opts = ctx.config.options as unknown as GitHubSourceOptions;
    super(ctx, { intervalMs: opts.intervalMs ?? 60_000 });
    this.opts = opts;
    this.runner = runner;
  }

  private apiPath(): string {
    if (this.opts.path) return this.opts.path;
    if (this.opts.repo) return `repos/${this.opts.repo}/events`;
    throw new Error("github source requires options.repo or options.path");
  }

  protected async poll(): Promise<PollResult[]> {
    let events: GhEvent[];
    try {
      const raw = await this.runner(this.apiPath());
      events = JSON.parse(raw) as GhEvent[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return [{ kind: "github:error", key: `error:${msg.slice(0, 80)}`, payload: { error: msg } }];
    }
    const perPage = this.opts.perPage ?? 30;
    return events.slice(0, perPage).map((ev) => ({
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
}
