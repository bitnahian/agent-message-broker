import type { PollResult } from "./poller.js";
import type { GitHubSourceOptions, OctokitLike } from "./github.js";

/** A named saved search query (ADR-0008). */
export interface SearchQuery {
  /** stable identifier used in dedupe keys and event payloads */
  name: string;
  /** GitHub Search syntax, e.g. "is:pr is:open author:bitnahian" */
  q: string;
}

/** Search API result item (issue or PR; `pull_request` marks PRs). */
export interface SearchItem {
  id: number;
  number: number;
  title?: string;
  state?: string;
  html_url?: string;
  user?: { login?: string } | null;
  pull_request?: unknown;
}

/**
 * `resource: "search"` poller (ADR-0008): runs each named query against the
 * Search API and emits `github:search-match` for items newly seen in a result
 * set (the dedupe key includes the item id, so a match emits exactly once).
 * `repo` is auto-injected as `repo:owner/repo` unless the query scopes its own
 * repo. Throws on config-shape errors; the caller converts them to github:error.
 */
export async function pollSearch(opts: GitHubSourceOptions, api: OctokitLike): Promise<PollResult[]> {
  const repo = opts.repo;
  if (!repo || !repo.includes("/")) {
    throw new Error("github search feed requires options.repo (owner/repo)");
  }
  const queries = opts.queries;
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error("github search feed requires options.queries ([{name, q}])");
  }
  if (!api.rest.search) {
    throw new Error("octokit client is missing the search namespace");
  }
  const results: PollResult[] = [];

  for (const query of queries) {
    if (!query?.name || !query?.q) {
      throw new Error("github search feed queries must be {name, q}");
    }
    const q = /\brepo:/.test(query.q) ? query.q : `repo:${repo} ${query.q}`;
    try {
      const { data } = await api.rest.search.issuesAndPullRequests({ q, per_page: 50 });
      for (const item of data.items) {
        results.push({
          kind: "github:search-match",
          key: `search:${query.name}:${item.id}`,
          payload: {
            query: query.name,
            q,
            id: item.id,
            number: item.number,
            title: item.title,
            state: item.state,
            author: item.user?.login,
            url: item.html_url,
            isPr: item.pull_request !== undefined,
            summary: `${item.user?.login ?? "?"}: ${item.title ?? `#${item.number}`}`,
          },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        kind: "github:error",
        key: `search:${query.name}:${msg.slice(0, 60)}`,
        payload: { error: msg, query: query.name },
      });
    }
  }
  return results;
}
