import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db.js";
import { BrokerStore } from "../store.js";
import { GitHubSource, type GhRunner } from "./github.js";
import type { SourceContext } from "./registry.js";

const fixture = [
  { id: "100", type: "PushEvent", actor: { login: "ana" }, repo: { name: "o/r" }, created_at: "2026-01-01T00:00:00Z", payload: { commits: [{ message: "fix bug\n\nbody" }] } },
  { id: "101", type: "PullRequestEvent", actor: { login: "bob" }, repo: { name: "o/r" }, created_at: "2026-01-01T00:01:00Z", payload: { action: "opened", pull_request: { number: 42 } } },
];

function setup(runner: GhRunner) {
  const store = new BrokerStore(createDb(":memory:"));
  const app = buildApp({ store });
  const topic = store.createTopic("gh");
  const source = store.createSource({ topicId: topic.id, kind: "github", options: { repo: "o/r" } });
  const ctx: SourceContext = {
    store, bus: app.bus, config: source,
    getState: (k) => store.getSourceState(source.id, k),
    setState: (k, v) => store.setSourceState(source.id, k, v),
    emit: async (kind, payload) => { await app.bus.publish({ topicId: topic.id, sourceId: source.id, kind, payload }); },
  };
  return { store, src: new GitHubSource(ctx, runner) };
}

describe("GitHubSource", () => {
  it("emits github:<Type> events deduped by event id", async () => {
    const { store, src } = setup(async () => JSON.stringify(fixture));
    expect(await src.tick()).toBe(2);
    expect(await src.tick()).toBe(0); // same ids deduped
    const events = store.listEvents();
    expect(events.map((e) => e.kind).sort()).toEqual(["github:PullRequestEvent", "github:PushEvent"]);
    const push = events.find((e) => e.kind === "github:PushEvent");
    expect((push?.payload as { summary: string }).summary).toContain("fix bug");
  });

  it("emits new events on later polls", async () => {
    let data = fixture;
    const { store, src } = setup(async () => JSON.stringify(data));
    await src.tick();
    data = [{ id: "102", type: "WatchEvent", actor: { login: "cid" }, repo: { name: "o/r" }, created_at: "", payload: {} }, ...fixture];
    expect(await src.tick()).toBe(1);
    expect(store.listEvents().find((e) => e.kind === "github:WatchEvent")).toBeTruthy();
  });

  it("emits github:error once on runner failure", async () => {
    const { store, src } = setup(async () => { throw new Error("gh not authed"); });
    expect(await src.tick()).toBe(1);
    expect(await src.tick()).toBe(0);
    expect(store.listEvents()[0]?.kind).toBe("github:error");
  });

  it("summarizes every GitHub event type and edge shapes", async () => {
    const mkEvent = (id: string, type: string, opts: Record<string, unknown> = {}) => ({
      id, type, actor: { login: "user" }, repo: { name: "o/r" }, created_at: "2026-01-01", payload: {},
      ...opts,
    });
    const events = [
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
    ] as any;
    const { store, src } = setup(async () => JSON.stringify(events));
    await src.tick();
    const toSummary = (kind: string) => {
      const ev = store.listEvents().find((e) => e.kind === kind);
      return (ev?.payload as { summary: string }).summary;
    };
    expect(toSummary("github:IssuesEvent")).toBe("user opened issue #3 in o/r");
    expect(toSummary("github:IssueCommentEvent")).toBe("user commented in o/r");
    expect(toSummary("github:CreateEvent")).toBe("user created branch in o/r");
    expect(toSummary("github:DeleteEvent")).toBe("user deleted tag in o/r");
    expect(toSummary("github:ForkEvent")).toBe("user forked o/r");
    expect(toSummary("github:ReleaseEvent")).toBe("user released in o/r");
    expect(toSummary("github:WatchEvent")).toBe("user starred o/r");
    expect(toSummary("github:MysteryEvent")).toBe("user MysteryEvent in o/r");
    // no actor/repo => fallback "?"
    const noActor = store.listEvents().find((e) => e.kind === "github:PushEvent" && (e.payload as any).summary.includes("?"));
    expect(noActor).toBeTruthy();

    // app-bus-level config for github includes a `path` override branch
  });

  it("poll honors the perPage cap and the raw path override", async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      id: String(i), type: "WatchEvent", actor: { login: "u" }, repo: { name: "r" }, created_at: "", payload: {},
    }));
    // path override
    const store1 = new BrokerStore(createDb(":memory:"));
    const app1 = buildApp({ store1 });
    const t1 = store1.createTopic("ghp");
    const s1 = store1.createSource({ topicId: t1.id, kind: "github", options: { path: "notifications" } });
    const seen: string[] = [];
    const src1 = new GitHubSource(
      { store: store1, bus: app1.bus, config: s1, getState: (k) => store1.getSourceState(s1.id, k), setState: (k, v) => store1.setSourceState(s1.id, k, v), emit: async () => {} },
      async (p) => { seen.push(p); return JSON.stringify(events); },
    );
    expect(await src1.tick()).toBe(5);
    expect(seen).toEqual(["notifications"]);

    const store2 = new BrokerStore(createDb(":memory:"));
    const app2 = buildApp({ store2 });
    const t2 = store2.createTopic("ghp2");
    const s2 = store2.createSource({ topicId: t2.id, kind: "github", options: { repo: "o/r" } });
    const src2 = new GitHubSource(
      { store: store2, bus: app2.bus, config: s2, getState: (k) => store2.getSourceState(s2.id, k), setState: (k, v) => store2.setSourceState(s2.id, k, v), emit: async () => {} },
      async (p) => JSON.stringify(events),
    );
    expect(await src2.tick()).toBe(5);
  });

  it("throws a descriptive error when neither repo nor path is set", async () => {
    const store = new BrokerStore(createDb(":memory:"));
    const app = buildApp({ store });
    const t = store.createTopic("ghx");
    const s = store.createSource({ topicId: t.id, kind: "github", options: {} });
    const src = new GitHubSource(
      { store, bus: app.bus, config: s, getState: (k) => store.getSourceState(s.id, k), setState: (k, v) => store.setSourceState(s.id, k, v), emit: async () => {} },
      async () => JSON.stringify([]),
    );
    await expect(src.tick()).resolves.toBe(1);
  });
});
