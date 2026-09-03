import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db.js";
import { BrokerStore } from "../store.js";
import { GitHubSource, type OctokitLike } from "./github.js";
import type { PrDetail } from "./github-pulls.js";
import type { SourceContext } from "./registry.js";

interface Fixture {
  pr: PrDetail;
  comments: { id: number; body?: string; user?: { login?: string }; html_url?: string; created_at?: string }[];
  reviews: { id: number; state?: string; body?: string; user?: { login?: string }; html_url?: string }[];
  inline: { id: number; body?: string; path?: string; line?: number | null; diff_hunk?: string; user?: { login?: string }; html_url?: string; created_at?: string; pull_request_review_id?: number }[];
  runs: { id: number; name?: string; conclusion?: string | null; html_url?: string }[];
  prCommits?: { sha: string; commit?: { message?: string }; html_url?: string }[];
  fail?: boolean;
}

function fakeOctokit(fix: Record<number, Fixture>, opts: { calls?: string[] } = {}): OctokitLike {
  return {
    rest: {
      activity: { listRepoEvents: async () => ({ data: [] }) },
      pulls: {
        get: async (p) => {
          opts.calls?.push(`pulls.get:${p.pull_number}`);
          const f = fix[p.pull_number];
          if (!f) throw new Error(`404 not found (pulls.get:${p.pull_number})`);
          return { data: f.pr };
        },
        listReviews: async (p) => {
          opts.calls?.push(`reviews:${p.pull_number}`);
          return { data: fix[p.pull_number]?.reviews ?? [] };
        },
        listReviewComments: async (p) => {
          opts.calls?.push(`inline:${p.pull_number}`);
          return { data: fix[p.pull_number]?.inline ?? [] };
        },
        listCommits: async (p) => {
          opts.calls?.push(`listCommits:${p.pull_number}`);
          return { data: fix[p.pull_number]?.prCommits ?? [] };
        },
      },
      issues: {
        listComments: async (p) => {
          opts.calls?.push(`comments:${p.issue_number}`);
          return { data: fix[p.issue_number]?.comments ?? [] };
        },
      },
      actions: {
        listWorkflowRunsForRepo: async (p) => {
          opts.calls?.push(`actions:${p.head_sha}`);
          return { data: { workflow_runs: Object.values(fix).flatMap((f) => f.runs) } };
        },
      },
    },
  };
}

function setup(options: Record<string, unknown>, fix: Record<number, Fixture>, api?: OctokitLike) {
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
  const src = new GitHubSource(ctx, api ?? fakeOctokit(fix));
  return { store, src };
}

const OPEN_PR: PrDetail = {
  number: 142, state: "open", merged: false, mergeable: true,
  title: "Fix login bug", html_url: "https://github.com/o/r/pull/142",
  user: { login: "bitnahian" }, head: { sha: "abc123", ref: "fix-login" },
};

describe("GitHubSource resource=pulls", () => {
  const base = { repo: "o/r", resource: "pulls", prs: [142] };

  it("emits comments, reviews, state, and terminal CI runs — each exactly once", async () => {
    const fix: Record<number, Fixture> = {
      142: {
        pr: OPEN_PR,
        comments: [{ id: 900, body: "looks good", user: { login: "ana" }, created_at: "2026-01-01T00:00:00Z" }],
        inline: [],
        reviews: [{ id: 901, state: "APPROVED", user: { login: "ana" } }],
        runs: [
          { id: 700, name: "ci", conclusion: "success" },
          { id: 701, name: "ci", conclusion: null }, // in-progress → skipped
          { id: 702, name: "ci", conclusion: "failure" },
        ],
      },
    };
    const { store, src } = setup(base, fix);
    expect(await src.tick()).toBe(6); // state + head + 1 comment + 1 review + 2 terminal CI
    expect(await src.tick()).toBe(0); // all deduped
    const kinds = store.listEvents().map((e) => e.kind).sort();
    expect(kinds).toEqual(["github:pr-ci", "github:pr-ci", "github:pr-comment", "github:pr-head", "github:pr-review", "github:pr-state"]);
    const ci = store.listEvents().filter((e) => e.kind === "github:pr-ci");
    expect(ci.map((e) => (e.payload as { conclusion: string }).conclusion).sort()).toEqual(["failure", "success"]);
    const state = store.listEvents().find((e) => e.kind === "github:pr-state");
    expect((state?.payload as { state: string }).state).toBe("open");
  });

  it("emits github:pr-state transitions for merged and conflicted", async () => {
    const fix: Record<number, Fixture> = { 142: { pr: { ...OPEN_PR }, comments: [], reviews: [], runs: [] } };
    const { store, src } = setup(base, fix, fakeOctokit(fix));
    await src.tick();
    fix[142]!.pr = { ...OPEN_PR, state: "closed", merged: true };
    await src.tick();
    fix[142]!.pr = { ...OPEN_PR, mergeable: false };
    await src.tick();
    const states = store.listEvents().filter((e) => e.kind === "github:pr-state")
      .map((e) => (e.payload as { state: string }).state).sort();
    expect(states).toEqual(["conflicted", "merged", "open"]);
  });

  it("include gates which streams poll", async () => {
    const calls: string[] = [];
    const fix: Record<number, Fixture> = {
      142: { pr: OPEN_PR, comments: [{ id: 900 }], reviews: [{ id: 901 }], inline: [], runs: [{ id: 700, conclusion: "failure" }] },
    };
    const { store, src } = setup({ ...base, include: ["comments"] }, fix, fakeOctokit(fix, { calls }));
    expect(await src.tick()).toBe(1);
    expect(calls.some((c) => c.startsWith("comments:"))).toBe(true);
    expect(calls.some((c) => c.startsWith("reviews:"))).toBe(false);
    expect(calls.some((c) => c.startsWith("actions:"))).toBe(false);
    expect(store.listEvents().map((e) => e.kind)).toEqual(["github:pr-comment"]);
  });

  it("CI uses the PR head SHA as a server-side filter", async () => {
    const calls: string[] = [];
    const fix: Record<number, Fixture> = { 142: { pr: OPEN_PR, comments: [], reviews: [], inline: [], runs: [] } };
    const { src } = setup(base, fix, fakeOctokit(fix, { calls }));
    await src.tick();
    expect(calls).toContain("actions:abc123");
  });

  it("a missing PR degrades to a deduped github:error without killing the rest", async () => {
    const fix: Record<number, Fixture> = { 142: { pr: OPEN_PR, comments: [{ id: 900 }], reviews: [], inline: [], runs: [] } };
    const { store, src } = setup({ ...base, prs: [142, 999] }, fix);
    await src.tick();
    const kinds = store.listEvents().map((e) => e.kind).sort();
    expect(kinds).toEqual(["github:error", "github:pr-comment", "github:pr-head", "github:pr-state"]);
    expect((store.listEvents().find((e) => e.kind === "github:error")?.payload as { pr: number }).pr).toBe(999);
  });

  it("missing prs throws a config error surfaced as github:error", async () => {
    const { store, src } = setup({ repo: "o/r", resource: "pulls" }, {});
    await src.tick();
    const ev = store.listEvents()[0];
    expect(ev?.kind).toBe("github:error");
    expect((ev?.payload as { error: string }).error).toContain("prs");
  });
});

describe("GitHubSource resource=pulls inline-comments", () => {
  const base = { repo: "o/r", resource: "pulls", prs: [142] };
  const OPEN_PR_LOCAL = {
    number: 142, state: "open", merged: false, mergeable: true,
    title: "t", user: { login: "bitnahian" }, head: { sha: "abc123" },
  };

  function inlineFix(inline: { id: number; body?: string; path?: string }[]) {
    return { 142: { pr: OPEN_PR_LOCAL as PrDetail, comments: [], reviews: [], inline, runs: [] } };
  }

  it("emits github:pr-inline-comment with path/line/diffHunk, deduped by id", async () => {
    const fix = inlineFix([
      { id: 800, body: "this line is wrong", path: "src/index.ts", line: 42, diff_hunk: "@@ -40,7 +40,7 @@ fn()", user: { login: "ana" }, html_url: "u", created_at: "2026-01-01T00:00:00Z", pull_request_review_id: 901 },
    ]);
    const { store, src } = setup(base, fix, fakeOctokit(fix));
    expect(await src.tick()).toBe(3); // state + head + inline comment
    expect(await src.tick()).toBe(0);
    const ev = store.listEvents().find((e) => e.kind === "github:pr-inline-comment");
    const p = ev!.payload as { pr: number; author: string; path: string; line: number; diffHunk: string; reviewId: number };
    expect(p).toMatchObject({ pr: 142, author: "ana", path: "src/index.ts", line: 42, reviewId: 901 });
    expect(p.diffHunk).toContain("@@");
  });

  it("is gated by include", async () => {
    const calls: string[] = [];
    const fix = inlineFix([{ id: 800, body: "x", path: "a.ts" }]);
    const { store, src } = setup({ ...base, include: ["comments"] }, fix, fakeOctokit(fix, { calls }));
    await src.tick();
    expect(calls.some((c) => c.startsWith("inline:"))).toBe(false);
    expect(store.listEvents().some((e) => e.kind === "github:pr-inline-comment")).toBe(false);
  });

  it("is part of the default include set", async () => {
    const calls: string[] = [];
    const fix = inlineFix([{ id: 800, body: "x", path: "a.ts" }]);
    const { src } = setup(base, fix, fakeOctokit(fix, { calls }));
    await src.tick();
    expect(calls.some((c) => c.startsWith("inline:"))).toBe(true);
  });
});

describe("GitHubSource resource=pulls head tracking", () => {
  const base = { repo: "o/r", resource: "pulls", prs: [142] };
  const pr = (sha: string): PrDetail => ({
    number: 142, state: "open", merged: false, mergeable: true, title: "t",
    html_url: "https://github.com/o/r/pull/142", user: { login: "bitnahian" },
    head: { sha, ref: "feature" },
  });
  const COMMITS = [
    { sha: "c1", commit: { message: "first commit" }, html_url: "u1" },
    { sha: "c2", commit: { message: "second commit" }, html_url: "u2" },
    { sha: "c3", commit: { message: "third commit" }, html_url: "u3" },
  ];
  const FIXTURE = { 142: { pr: pr("c1"), comments: [], reviews: [], inline: [], runs: [], prCommits: COMMITS } };

  it("baseline poll emits pr-head without previousHeadSha or a commits fetch", async () => {
    const calls: string[] = [];
    const { store, src } = setup(base, { 142: { ...FIXTURE[142] } }, fakeOctokit({ 142: { ...FIXTURE[142] } }, { calls }));
    await src.tick();
    const ev = store.listEvents().find((e) => e.kind === "github:pr-head");
    const p = ev!.payload as { headSha: string; previousHeadSha?: string };
    expect(p.headSha).toBe("c1");
    expect(p.previousHeadSha).toBeUndefined();
    expect(calls.some((c) => c.startsWith("listCommits:"))).toBe(false);
    void store;
  });

  it("a head change emits previousHeadSha and the commit headlines after it", async () => {
    const fix = { 142: { ...FIXTURE[142], pr: pr("c1") } };
    const { store, src } = setup(base, fix, fakeOctokit(fix, { calls: [] }));
    await src.tick();
    fix[142]!.pr = pr("c3");
    await src.tick();
    const headEvs = store.listEvents().filter((e) => e.kind === "github:pr-head");
    expect(headEvs.length).toBe(2);
    const second = headEvs.find((e) => (e.payload as { headSha: string }).headSha === "c3")!.payload as { previousHeadSha: string; commits: { sha: string; message: string }[] };
    expect(second.previousHeadSha).toBe("c1");
    expect(second.commits).toEqual([
      { sha: "c2", message: "second commit", url: "u2" },
      { sha: "c3", message: "third commit", url: "u3" },
    ]);
  });

  it("a rewritten history is flagged forcePushed with empty commits", async () => {
    const fix = { 142: { ...FIXTURE[142], pr: pr("old-sha") } };
    const { store, src } = setup(base, fix, fakeOctokit(fix));
    await src.tick();
    fix[142]!.pr = pr("new-sha"); // "old-sha" not in prCommits → force-push
    await src.tick();
    const ev = store.listEvents().filter((e) => e.kind === "github:pr-head")
      .find((e) => (e.payload as { headSha: string }).headSha === "new-sha");
    const p = ev!.payload as { forcePushed?: boolean; commits: unknown[]; previousHeadSha: string };
    expect(p.forcePushed).toBe(true);
    expect(p.commits).toEqual([]);
    expect(p.previousHeadSha).toBe("old-sha");
  });

  it("an unchanged head emits nothing on later polls", async () => {
    const fix = { 142: { ...FIXTURE[142], pr: pr("c1") } };
    const { store, src } = setup(base, fix, fakeOctokit(fix));
    await src.tick();
    expect(await src.tick()).toBe(0);
    expect(store.listEvents().filter((e) => e.kind === "github:pr-head")).toHaveLength(1);
  });

  it("the head stream is gated by include", async () => {
    const calls: string[] = [];
    const fix = { 142: { ...FIXTURE[142], pr: pr("c1") } };
    const { store, src } = setup({ ...base, include: ["state"] }, fix, fakeOctokit(fix, { calls }));
    await src.tick();
    expect(store.listEvents().some((e) => e.kind === "github:pr-head")).toBe(false);
    expect(calls.some((c) => c.startsWith("listCommits:"))).toBe(false);
  });

  it("works without a state store (head events still flow, deduped by key)", async () => {
    const store = new BrokerStore(createDb(":memory:"));
    const app = buildApp({ store });
    const topic = store.createTopic("gh");
    const source = store.createSource({ topicId: topic.id, kind: "github", options: base });
    const ctx: SourceContext = {
      store, bus: app.bus, config: source,
      getState: <T,>() => undefined as T | undefined,
      setState: () => { /* no-op */ },
      emit: async (kind, payload) => { await app.bus.publish({ topicId: topic.id, sourceId: source.id, kind, payload }); },
    };
    const src = new GitHubSource(ctx, fakeOctokit({ 142: { ...FIXTURE[142], pr: pr("c1") } }));
    await src.tick();
    expect(store.listEvents().filter((e) => e.kind === "github:pr-head")).toHaveLength(1);
  });
});
