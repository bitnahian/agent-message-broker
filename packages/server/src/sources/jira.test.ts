import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db.js";
import { BrokerStore } from "../store.js";
import { JiraSource, type AcliRunner } from "./jira.js";
import type { SourceContext } from "./registry.js";

const fixture = [
  { id: "10014", key: "KAN-5", fields: { summary: "Implement work item", updated: "2026-08-19T10:00:00Z", status: { name: "To Do" }, assignee: null, issuetype: { name: "Subtask" } } },
  { id: "10013", key: "KAN-4", fields: { summary: "Setup board", updated: "2026-08-18T09:00:00Z", status: { name: "Done" }, assignee: { displayName: "Nahian" }, issuetype: { name: "Task" } } },
];

function setup(runner: AcliRunner) {
  const store = new BrokerStore(createDb(":memory:"));
  const app = buildApp({ store });
  const topic = store.createTopic("jira");
  const source = store.createSource({ topicId: topic.id, kind: "jira", options: { jql: "project = KAN" } });
  const ctx: SourceContext = {
    store, bus: app.bus, config: source,
    getState: (k) => store.getSourceState(source.id, k),
    setState: (k, v) => store.setSourceState(source.id, k, v),
    emit: async (kind, payload) => { await app.bus.publish({ topicId: topic.id, sourceId: source.id, kind, payload }); },
  };
  return { store, src: new JiraSource(ctx, runner) };
}

describe("JiraSource", () => {
  it("emits one event per work item, deduped by key@updated", async () => {
    const { store, src } = setup(async () => JSON.stringify(fixture));
    expect(await src.tick()).toBe(2);
    expect(await src.tick()).toBe(0);
    const events = store.listEvents();
    expect(events.every((e) => e.kind === "jira:workitem-updated")).toBe(true);
    const kan5 = events.find((e) => (e.payload as { key: string }).key === "KAN-5");
    expect((kan5?.payload as { status?: string }).status).toBe("To Do");
  });

  it("re-emits an item when its updated timestamp changes", async () => {
    let data = fixture;
    const { store, src } = setup(async () => JSON.stringify(data));
    await src.tick();
    data = [{ ...fixture[0]!, fields: { ...fixture[0]!.fields, updated: "2026-08-19T11:00:00Z", status: { name: "In Progress" } } }, fixture[1]!];
    expect(await src.tick()).toBe(1);
    const events = store.listEvents();
    expect(events).toHaveLength(3);
    const updated = events.find((e) => (e.payload as { status?: string }).status === "In Progress");
    expect(updated).toBeTruthy();
  });

  it("emits deduped jira:error on runner failure", async () => {
    const { store, src } = setup(async () => { throw new Error("acli not authed"); });
    expect(await src.tick()).toBe(1);
    expect(await src.tick()).toBe(0);
    expect(store.listEvents()[0]?.kind).toBe("jira:error");
  });

  it("falls back to a content hash when updated is missing (no fingerprint field)", async () => {
    const item = {
      id: "1", key: "KAN-9",
      fields: { summary: "no date", status: { name: "Open" }, assignee: null, issuetype: { name: "Story" } },
    };
    const { store, src } = setup(async () => JSON.stringify([item]));
    expect(await src.tick()).toBe(1);
    const ev = store.listEvents()[0];
    expect((ev?.payload as { key: string }).key).toBe("KAN-9");
    // null assignee folds to null
    expect((ev?.payload as { assignee: string | null }).assignee).toBeNull();
    // identical fingerprint => identical key works only via review; second tick is deduped
    await src.tick();
    expect(store.listEvents()).toHaveLength(1);
  });
});
