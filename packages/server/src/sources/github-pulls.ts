import type { PollResult } from "./poller.js";
import type { GitHubSourceOptions, OctokitLike } from "./github.js";

/** Which per-PR streams to poll (ADR-0008); default: all four. */
export type PullsInclude = "comments" | "reviews" | "ci" | "state";

const DEFAULT_INCLUDE: PullsInclude[] = ["comments", "reviews", "ci", "state"];
/** Workflow-run conclusions worth emitting; queued/in_progress are noise. */
const TERMINAL_CONCLUSIONS = new Set(["success", "failure", "cancelled", "startup_failure"]);

export interface PrDetail {
  number: number;
  state?: string;
  merged?: boolean;
  mergeable?: boolean | null;
  title?: string;
  html_url?: string;
  user?: { login?: string } | null;
  head?: { sha?: string; ref?: string };
}

export interface IssueComment {
  id: number;
  body?: string;
  html_url?: string;
  created_at?: string;
  user?: { login?: string } | null;
}

export interface PrReview {
  id: number;
  body?: string;
  state?: string;
  html_url?: string;
  user?: { login?: string } | null;
}

export interface WorkflowRun {
  id: number;
  name?: string;
  conclusion?: string | null;
  html_url?: string;
}

/**
 * `resource: "pulls"` poller (ADR-0008): tracks an explicit list of PR numbers
 * and emits per-concern events — comments and reviews (id-deduped), CI runs on
 * the PR head SHA (terminal conclusions only, `github:pr-ci`), and PR state
 * transitions (open/merged/closed/conflicted, `github:pr-state`). All lookups
 * are exact-entity REST with server-side filters; no feed scraping. Throws on
 * config-shape errors; per-PR API errors degrade to deduped github:error.
 */
export async function pollPulls(opts: GitHubSourceOptions, api: OctokitLike): Promise<PollResult[]> {
  const repo = opts.repo;
  if (!repo || !repo.includes("/")) {
    throw new Error("github pulls feed requires options.repo (owner/repo)");
  }
  const prs = opts.prs;
  if (!Array.isArray(prs) || prs.length === 0) {
    throw new Error("github pulls feed requires options.prs ([numbers])");
  }
  if (!api.rest.pulls || !api.rest.issues || !api.rest.actions) {
    throw new Error("octokit client is missing the pulls/issues/actions namespaces");
  }
  const include = new Set<PullsInclude>(opts.include ?? DEFAULT_INCLUDE);
  const [owner, name] = repo.split("/", 2);
  const results: PollResult[] = [];

  for (const prNumber of prs) {
    try {
      // PR detail: needed for state and for CI (head SHA); cheap single fetch
      let headSha: string | undefined;
      if (include.has("state") || include.has("ci")) {
        const { data: pr } = await api.rest.pulls.get({ owner, repo: name, pull_number: prNumber });
        headSha = pr.head?.sha;
        if (include.has("state")) {
          const state = pr.merged ? "merged" : pr.state === "closed" ? "closed" : pr.mergeable === false ? "conflicted" : "open";
          results.push({
            kind: "github:pr-state",
            key: `pulls:${prNumber}:state:${state}`,
            payload: { pr: prNumber, state, title: pr.title, author: pr.user?.login, url: pr.html_url },
          });
        }
      }

      if (include.has("comments")) {
        const { data } = await api.rest.issues.listComments({ owner, repo: name, issue_number: prNumber, per_page: 50 });
        for (const c of data) {
          results.push({
            kind: "github:pr-comment",
            key: `pulls:${prNumber}:comment:${c.id}`,
            payload: { pr: prNumber, author: c.user?.login, body: c.body?.slice(0, 500), url: c.html_url, createdAt: c.created_at },
          });
        }
      }

      if (include.has("reviews")) {
        const { data } = await api.rest.pulls.listReviews({ owner, repo: name, pull_number: prNumber, per_page: 50 });
        for (const r of data) {
          results.push({
            kind: "github:pr-review",
            key: `pulls:${prNumber}:review:${r.id}`,
            payload: { pr: prNumber, author: r.user?.login, state: r.state, body: r.body?.slice(0, 500), url: r.html_url },
          });
        }
      }

      if (include.has("ci") && headSha) {
        const { data } = await api.rest.actions.listWorkflowRunsForRepo({ owner, repo: name, head_sha: headSha, per_page: 30 });
        for (const run of data.workflow_runs) {
          if (!run.conclusion || !TERMINAL_CONCLUSIONS.has(run.conclusion)) continue;
          results.push({
            kind: "github:pr-ci",
            key: `pulls:${prNumber}:ci:${run.id}@${run.conclusion}`,
            payload: { pr: prNumber, name: run.name, conclusion: run.conclusion, url: run.html_url },
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        kind: "github:error",
        key: `pulls:${prNumber}:${msg.slice(0, 60)}`,
        payload: { error: msg, pr: prNumber },
      });
    }
  }
  return results;
}
