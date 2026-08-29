import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db.js";
import { BrokerStore } from "../store.js";
import { JiraSource, type AtlassianRestLike, type JiraSearchResponse, type JiraWorkItem } from "./jira.js";
import type { SourceContext } from "./registry.js";

const fixture: JiraWorkItem[] = [
  { id: "10014", key: "KAN-5", fields: { summary: "Implement work item", updated: "2026-08-19T10:00:00Z", status: { name: "To Do" }, assignee: null, issuetype: { name: "Subtask" } } },
  { id: "10013", key: "KAN-4", fields: { summary: "Setup board", updated: "2026-08-18T09:00:00Z", status: { name: "Done" }, assignee: { displayName: "Nahian" }, issuetype: { name: "Task" } } },
];

function fakeApi(items: JiraWorkItem[] | (() => JiraWorkItem[]), opts: { fail?: boolean; calls?: { jql: string; limit: number }[] } = {}): AtlassianRestLike {
  return {
    search: async (jql, limit) => {
      opts.calls?.push({ jql, limit });
      if (opts.fail) throw new Error("api down");
      const arr = typeof items === "function" ? items() : items;
      return { issues: arr } as JiraSearchResponse;
    },
  };
}

function setup(api?: AtlassianRestLike, options: Record<string, unknown> = { jql: "project = KAN" }) {
  const store = new BrokerStore(createDb(":memory:"));
  const app = buildApp({ store });
  const topic = store.createTopic("jira");
  const source = store.createSource({ topicId: topic.id, kind: "jira", options });
  const ctx: SourceContext = {
    store, bus: app.bus, config: source,
    getState: (k) => store.getSourceState(source.id, k),
    setState: (k, v) => store.setSourceState(source.id, k, v),
    emit: async (kind, payload) => { await app.bus.publish({ topicId: topic.id, sourceId: source.id, kind, payload }); },
  };
  const src = api ? new JiraSource(ctx, api) : new JiraSource(ctx, fakeApi(fixture));
  return { store, src };
}

describe("JiraSource (SDK poller)", () => {
  it("emits one event per work item, deduped by key@updated", async () => {
    const { store, src } = setup(fakeApi(fixture));
    expect(await src.tick()).toBe(2);
    expect(await src.tick()).toBe(0);
    const events = store.listEvents();
    expect(events.every((e) => e.kind === "jira:workitem-updated")).toBe(true);
    const kan5 = events.find((e) => (e.payload as { key: string }).key === "KAN-5");
    expect((kan5?.payload as { status?: string }).status).toBe("To Do");
  });

  it("re-emits an item when its updated timestamp changes", async () => {
    let data = fixture;
    const { store, src } = setup(fakeApi(() => data));
    await src.tick();
    data = [{ ...fixture[0]!, fields: { ...fixture[0]!.fields, updated: "2026-08-19T11:00:00Z", status: { name: "In Progress" } } }, fixture[1]!];
    expect(await src.tick()).toBe(1);
    expect(store.listEvents()).toHaveLength(3);
    expect(store.listEvents().find((e) => (e.payload as { status?: string }).status === "In Progress")).toBeTruthy();
  });

  it("emits deduped jira:error on API failure", async () => {
    const { store, src } = setup(fakeApi(fixture, { fail: true }));
    expect(await src.tick()).toBe(1);
    expect(await src.tick()).toBe(0);
    expect(store.listEvents()[0]?.kind).toBe("jira:error");
  });

  it("falls back to a content hash when updated is missing", async () => {
    const item: JiraWorkItem = { id: "1", key: "KAN-9", fields: { summary: "no date", status: { name: "Open" }, assignee: null, issuetype: { name: "Story" } } };
    const { store, src } = setup(fakeApi([item]));
    expect(await src.tick()).toBe(1);
    const ev = store.listEvents()[0];
    expect((ev?.payload as { key: string }).key).toBe("KAN-9");
    expect((ev?.payload as { assignee: string | null }).assignee).toBeNull();
    await src.tick();
    expect(store.listEvents()).toHaveLength(1);
  });

  it("passes jql + limit to the client", async () => {
    const calls: { jql: string; limit: number }[] = [];
    const { src } = setup(fakeApi([{ id: "1", key: "K", fields: { summary: "s", updated: "x", status: { name: "Open" }, assignee: null, issuetype: null } }], { calls }), { jql: "project = Z", limit: 5 });
    await src.tick();
    expect(calls).toEqual([{ jql: "project = Z", limit: 5 }]);
  });
});