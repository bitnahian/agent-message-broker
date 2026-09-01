import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db.js";
import { BrokerStore } from "../store.js";
import { GitHubSource, type OctokitLike } from "./github.js";
import { pollSearch, type SearchItem } from "./github-search.js";
import type { SourceContext } from "./registry.js";

function searchItem(id: number, number: number, title: string, opts: Record<string, unknown> = {}): SearchItem {
  return { id, number, title, state: "open", html_url: `https://github.com/o/r/pull/${number}`, user: { login: "bitnahian" }, pull_request: {}, ...opts };
}

function fakeOctokit(items: SearchItem[] | (() => SearchItem[]), opts: { fail?: boolean; calls?: string[] } = {}): OctokitLike {
  return {
    rest: {
      activity: { listRepoEvents: async () => ({ data: [] }) },
      search: {
        issuesAndPullRequests: async (p) => {
          opts.calls?.push(`search:${p.q}`);
          if (opts.fail) throw new Error("search blew up");
          const data = typeof items === "function" ? items() : items;
          return { data: { items: data } };
        },
      },
    },
  };
}

function setup(options: Record<string, unknown>, api?: OctokitLike) {
  const store = new BrokerStore(createDb(":memory:"));
  const app = buildApp({ store });
  const topic = store.createTopic("gh");
  const source = store.createSource({ topicId: topic.id, kind: "github", options });
  const ctx: SourceContext = {
    store, bus: app.bus, config: source,
    getState: (k) => store.getSourceState(source.id, k),
    setState: (k, v) => store.setSourceState(source.id, k, v),
    emit: async (kind, payload) => { await app.bus.publish({ topicId: topic.id, sourceId: source.id, kind, payload }); },
  };
  const src = new GitHubSource(ctx, api ?? fakeOctokit([searchItem(5001, 142, "Fix login bug")]));
  return { store, src };
}

describe("GitHubSource resource=search", () => {
  const base = { repo: "o/r", resource: "search", queries: [{ name: "my-prs", q: "is:pr is:open author:bitnahian" }] };

  it("emits github:search-match for new matches, deduped by query+item id", async () => {
    const { store, src } = setup(base);
    expect(await src.tick()).toBe(1);
    expect(await src.tick()).toBe(0); // same item id → deduped
    const ev = store.listEvents()[0];
    expect(ev?.kind).toBe("github:search-match");
    const p = ev?.payload as { query: string; number: number; isPr: boolean; summary: string };
    expect(p.query).toBe("my-prs");
    expect(p.number).toBe(142);
    expect(p.isPr).toBe(true);
    expect(p.summary).toContain("Fix login bug");
  });

  it("emits new matches on later polls and keys dedupe per query", async () => {
    let items = [searchItem(5001, 142, "Fix login bug")];
    const { store, src } = setup(
      { ...base, queries: [{ name: "a", q: "x" }, { name: "b", q: "y" }] },
      fakeOctokit(() => items),
    );
    expect(await src.tick()).toBe(2); // same item matched by both queries → two events
    items = [searchItem(5001, 142, "Fix login bug"), searchItem(5002, 143, "Add SSO")];
    expect(await src.tick()).toBe(2); // item 5002 new in both queries
    const kinds = store.listEvents().map((e) => e.kind);
    expect(kinds.filter((k) => k === "github:search-match")).toHaveLength(4);
  });
  it("auto-injects repo: into queries that lack it, leaves scoped queries alone", async () => {
    const calls: string[] = [];
    const { src } = setup(
      { ...base, queries: [{ name: "a", q: "is:pr author:x" }, { name: "b", q: "is:pr repo:other/repo" }] },
      fakeOctokit([], { calls }),
    );
    await src.tick();
    expect(calls).toEqual(["search:repo:o/r is:pr author:x", "search:is:pr repo:other/repo"]);
  });

  it("search API failure degrades to deduped github:error", async () => {
    const { store, src } = setup(base, fakeOctokit([], { fail: true }));
    expect(await src.tick()).toBe(1);
    expect(await src.tick()).toBe(0);
    expect(store.listEvents()[0]?.kind).toBe("github:error");
  });

  it("missing queries throws a config error surfaced as github:error", async () => {
    const { store, src } = setup({ repo: "o/r", resource: "search" }, fakeOctokit([]));
    await src.tick();
    const ev = store.listEvents()[0];
    expect(ev?.kind).toBe("github:error");
    expect((ev?.payload as { error: string }).error).toContain("queries");
  });

  it("pollSearch direct: config errors reject for the caller to convert", async () => {
    await expect(pollSearch({ repo: "o/r", resource: "search", queries: [] } as never, fakeOctokit([]))).rejects.toThrow(/queries/);
    await expect(pollSearch({ resource: "search", queries: [{ name: "a", q: "x" }] } as never, fakeOctokit([]))).rejects.toThrow(/repo/);
  });
});
