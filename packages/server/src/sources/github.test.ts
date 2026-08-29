import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db.js";
import { BrokerStore } from "../store.js";
import { GitHubSource, type OctokitLike, type GhEvent } from "./github.js";
import type { SourceContext } from "./registry.js";

const fixture: GhEvent[] = [
  { id: "100", type: "PushEvent", actor: { login: "ana" }, repo: { name: "o/r" }, created_at: "2026-01-01T00:00:00Z", payload: { commits: [{ message: "fix bug\n\nbody" }] } },
  { id: "101", type: "PullRequestEvent", actor: { login: "bob" }, repo: { name: "o/r" }, created_at: "2026-01-01T00:01:00Z", payload: { action: "opened", pull_request: { number: 42 } } },
];

function fakeOctokit(events: GhEvent[] | (() => GhEvent[]), opts: { fail?: boolean; calls?: string[] } = {}): OctokitLike {
  return {
    rest: {
      activity: {
        listRepoEvents: async ({ owner, repo, per_page }) => {
          opts.calls?.push(`listRepoEvents:${owner}/${repo}:${per_page}`);
          if (opts.fail) throw new Error("boom");
          const e = typeof events === "function" ? events() : events;
          return { data: e };
        },
      },
      repos: {},
    },
  };
}

function setup(api?: OctokitLike, options: Record<string, unknown> = { repo: "o/r" }) {
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
  const src = api ? new GitHubSource(ctx, api) : new GitHubSource(ctx, fakeOctokit(fixture));
  return { store, src };
}

describe("GitHubSource (SDK poller)", () => {
  it("emits github:<Type> events deduped by event id", async () => {
    const { store, src } = setup();
    expect(await src.tick()).toBe(2);
    expect(await src.tick()).toBe(0); // same ids deduped
    const events = store.listEvents();
    expect(events.map((e) => e.kind).sort()).toEqual(["github:PullRequestEvent", "github:PushEvent"]);
    const push = events.find((e) => e.kind === "github:PushEvent");
    expect((push?.payload as { summary: string }).summary).toContain("fix bug");
  });

  it("emits new events on later polls", async () => {
    let data = fixture;
    const { store, src } = setup(fakeOctokit(() => data));
    await src.tick();
    data = [{ id: "102", type: "WatchEvent", actor: { login: "cid" }, repo: { name: "o/r" }, created_at: "", payload: {} }, ...fixture];
    expect(await src.tick()).toBe(1);
    expect(store.listEvents().find((e) => e.kind === "github:WatchEvent")).toBeTruthy();
  });

  it("emits github:error on API failure", async () => {
    const { store, src } = setup(fakeOctokit(fixture, { fail: true }));
    expect(await src.tick()).toBe(1);
    expect(await src.tick()).toBe(0); // same key deduped
    expect(store.listEvents()[0]?.kind).toBe("github:error");
  });

  it("filters to the feed event-type allowlist", async () => {
    const { store, src } = setup(fakeOctokit(fixture), { repo: "o/r", eventTypes: ["PushEvent"] });
    expect(await src.tick()).toBe(1);
    const kinds = store.listEvents().map((e) => e.kind);
    expect(kinds).toEqual(["github:PushEvent"]);
  });

  it("respects perPage cap", async () => {
    const calls: string[] = [];
    const many = Array.from({ length: 5 }, (_, i) => ({ id: String(i), type: "WatchEvent", actor: { login: "u" }, repo: { name: "r" }, created_at: "", payload: {} }));
    const { store, src } = setup(fakeOctokit(many, { calls }), { repo: "o/r", perPage: 3 });
    expect(await src.tick()).toBe(3);
    expect(calls[0]).toContain(":3");
  });

  it("queries owner/repo split", async () => {
    const calls: string[] = [];
    const { src } = setup(fakeOctokit([], { calls }), { repo: "cli/cli", perPage: 7 });
    await src.tick();
    expect(calls[0]).toBe("listRepoEvents:cli/cli:7");
  });

  it("summarizes every GitHub event type and edge shapes", async () => {
    const mkEvent = (id: string, type: string, opts: Record<string, unknown> = {}): GhEvent => ({
      id, type, actor: { login: "user" }, repo: { name: "o/r" }, created_at: "2026-01-01", payload: {},
      ...opts,
    });
    const events: GhEvent[] = [
      mkEvent("e1", "IssuesEvent", { payload: { action: "opened", issue: { number: 3 } } }),
      mkEvent("e2", "IssueCommentEvent"),
      mkEvent("e3", "CreateEvent", { payload: { ref_type: "branch" } }),
      mkEvent("e4", "DeleteEvent", { payload: { ref_type: "tag" } }),
      mkEvent("e5", "ForkEvent"),
      mkEvent("e6", "ReleaseEvent"),
      mkEvent("e7", "WatchEvent"),
      mkEvent("e8", "MysteryEvent"),
      // shape edge cases
      mkEvent("e9", "PushEvent", { actor: undefined, repo: undefined, payload: { commits: [] } }),
      mkEvent("e10", "PushEvent", { payload: { commits: [{ message: "headline" }] } }),
    ];
    const { store, src } = setup(fakeOctokit(events));
    await src.tick();
    const toSummary = (kind: string) => (store.listEvents().find((e) => e.kind === kind)?.payload as { summary: string }).summary;
    expect(toSummary("github:IssuesEvent")).toBe("user opened issue #3 in o/r");
    expect(toSummary("github:IssueCommentEvent")).toBe("user commented in o/r");
    expect(toSummary("github:CreateEvent")).toBe("user created branch in o/r");
    expect(toSummary("github:DeleteEvent")).toBe("user deleted tag in o/r");
    expect(toSummary("github:ForkEvent")).toBe("user forked o/r");
    expect(toSummary("github:ReleaseEvent")).toBe("user released in o/r");
    expect(toSummary("github:WatchEvent")).toBe("user starred o/r");
    expect(toSummary("github:MysteryEvent")).toBe("user MysteryEvent in o/r");
    expect(store.listEvents().some((e) => (e.payload as { summary: string }).summary.includes("?"))).toBe(true);
  });

  it("returns github:error when repo missing (descriptive)", async () => {
    const { store, src } = setup(undefined, {});
    await src.tick();
    expect(store.listEvents()[0]?.kind).toBe("github:error");
  });
});

describe("GitHubSource webhook registration", () => {
  it("registerWebhook via octokit createWebhook returns hook id", async () => {
    const created: unknown[] = [];
    const api: OctokitLike = {
      rest: {
        activity: { listRepoEvents: async () => ({ data: [] }) },
        repos: {
          createWebhook: async (p) => { created.push(p); return { data: { id: 99 } }; },
          deleteWebhook: async () => ({ status: 204 }),
        },
      },
    };
    const { src } = setup(api, { repo: "o/r" });
    const id = await src.registerWebhook("o", "r", "https://smee.io/x", ["push", "pull_request"], "sec");
    expect(id).toBe(99);
    expect(created[0]).toMatchObject({
      owner: "o", repo: "r", name: "web", events: ["push", "pull_request"],
      config: { url: "https://smee.io/x", content_type: "json", secret: "sec" },
    });
  });

  it("deleteWebhook via octokit returns success", async () => {
    const api: OctokitLike = {
      rest: {
        activity: { listRepoEvents: async () => ({ data: [] }) },
        repos: {
          createWebhook: async () => ({ data: { id: 1 } }),
          deleteWebhook: async () => ({ status: 204 }),
        },
      },
    };
    const { src } = setup(api);
    expect(await src.deleteWebhook("o", "r", 7)).toBe(true);
  });

  it("deleteWebhook returns false on non-2xx", async () => {
    const api: OctokitLike = {
      rest: {
        activity: { listRepoEvents: async () => ({ data: [] }) },
        repos: {
          createWebhook: async () => ({ data: { id: 1 } }),
          deleteWebhook: async () => ({ status: 404 }),
        },
      },
    };
    const { src } = setup(api);
    expect(await src.deleteWebhook("o", "r", 7)).toBe(false);
  });
});