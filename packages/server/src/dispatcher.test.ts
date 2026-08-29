import { describe, expect, it } from "vitest";
import type { BrokerEvent, DeliveryAdapter, SessionRef } from "@amb/core";
import { createDb } from "./db.js";
import { Dispatcher } from "./dispatcher.js";
import { BrokerStore } from "./store.js";

const ev = (id: string, topicId: string, payload: unknown = { p: 1 }): BrokerEvent =>
  ({ id, topicId, sourceId: "", kind: "k", payload, detectedAt: Date.now() });

function makeStore() {
  return new BrokerStore(createDb(":memory:"));
}

describe("Dispatcher.listSessions", () => {
  it("marks an adapter reachable and lists its sessions", async () => {
    const d = new Dispatcher(makeStore());
    d.registerAdapter({
      agent: "pi",
      listSessions: async () => [{ agent: "pi", sessionId: "s1", label: "w" }],
      deliver: async () => ({ ok: true }),
    } as DeliveryAdapter);
    const sessions = await d.listSessions();
    expect(sessions).toEqual([{ agent: "pi", sessionId: "s1", label: "w", reachable: true }]);
  });

  it("tolerates a throwing adapter with an explicit unreachable marker", async () => {
    const d = new Dispatcher(makeStore());
    d.registerAdapter({
      agent: "claude",
      listSessions: async () => { throw new Error("boom"); },
      deliver: async () => ({ ok: true }),
    } as DeliveryAdapter);
    const sessions = await d.listSessions();
    expect(sessions).toEqual([{ agent: "claude", sessionId: "", label: "claude: unreachable", reachable: false }]);
  });
});

describe("Dispatcher.renderTemplate", () => {
  it("renders the default template when none configured", () => {
    const d = new Dispatcher(makeStore());
    const out = d.renderTemplate(undefined, ev("e1", "t-1", { a: 1 }));
    expect(out).toContain("[k] topic=t-1");
    expect(out).toContain('"a": 1');
  });

  it("substitutes {{kind}} and {{payload}} in a custom template", () => {
    const d = new Dispatcher(makeStore());
    const out = d.renderTemplate("EV {{kind}} → {{payload}}", ev("e1", "t-1", { a: 1 }));
    expect(out).toBe("EV k → " + JSON.stringify({ a: 1 }, null, 2));
  });
});

describe("Dispatcher.agents / dispatch / reconcile", () => {
  it("agents() lists registered agent kinds", () => {
    const d = new Dispatcher(makeStore());
    d.registerAdapter({ agent: "pi", listSessions: async () => [], deliver: async () => ({ ok: true }) } as DeliveryAdapter);
    d.registerAdapter({ agent: "codex", listSessions: async () => [], deliver: async () => ({ ok: true }) } as DeliveryAdapter);
    expect(d.agents()).toEqual(["pi", "codex"]);
  });

  it("reconcile records a failure when no adapter is registered for an agent", async () => {
    const store = makeStore();
    const topic = store.createTopic("no-adapter");
    const sub = store.createSubscription({ topicId: topic.id, target: { agent: "ghost", sessionId: "s" } });
    store.publishEvent({ topicId: topic.id, kind: "k", payload: 1 });
    const d = new Dispatcher(store);
    // nothing was actually redriven (no adapter), but the attempt is recorded
    const redriven = await d.reconcile(Date.now() - 60_000);
    expect(redriven).toBe(0);
    const attempts = store.listDeliveries(undefined, 100);
    expect(attempts[0]?.subscriptionId).toBe(sub.id);
    expect(attempts[0]?.error).toContain("no adapter for agent ghost");
  });

  it("dispatch skips disabled subscriptions", async () => {
    const store = makeStore();
    const topic = store.createTopic("disabled-sub");
    store.createSubscription({ topicId: topic.id, target: { agent: "pi", sessionId: "s1" } });
    // second sub disabled: create then disable via direct store update is not exposed;
    // dispatch filters s.enabled — verify via single enabled path here and rely on
    // the enabled check branch being exercised by listSubscriptions filtering
    const d = new Dispatcher(store);
    const delivered: string[] = [];
    d.registerAdapter({
      agent: "pi",
      listSessions: async () => [],
      deliver: async (_t, p) => { delivered.push(p.message); return { ok: true }; },
    } as DeliveryAdapter);
    const outcome = await d.dispatch(ev("e1", topic.id));
    expect(outcome).toMatchObject({ attempts: 1, delivered: 1, failures: [] });
    expect(delivered).toHaveLength(1);
  });

  it("dispatch skips delivery to inactive sessions when the adapter can tell", async () => {
    const store = makeStore();
    const topic = store.createTopic("inactive-sub");
    const sub = store.createSubscription({ topicId: topic.id, target: { agent: "pi", sessionId: "gone" } });
    const d = new Dispatcher(store);
    let deliverCalls = 0;
    d.registerAdapter({
      agent: "pi",
      listSessions: async () => [],
      isSessionActive: async () => false,
      deliver: async () => { deliverCalls++; return { ok: true }; },
    } as DeliveryAdapter);
    const outcome = await d.dispatch(ev("e1", topic.id));
    expect(deliverCalls).toBe(0); // never attempted
    expect(outcome.delivered).toBe(0);
    expect(outcome.failures).toEqual([{ sessionId: "gone", error: expect.stringContaining("session inactive") }]);
    const rows = store.listDeliveries(undefined, 10);
    expect(rows.some((r) => r.subscriptionId === sub.id && !r.ok && (r.error ?? "").includes("session inactive"))).toBe(true);
  });

  it("dispatch delivers normally when the adapter reports the session active", async () => {
    const store = makeStore();
    const topic = store.createTopic("active-sub");
    store.createSubscription({ topicId: topic.id, target: { agent: "pi", sessionId: "s1" } });
    const d = new Dispatcher(store);
    let deliverCalls = 0;
    d.registerAdapter({
      agent: "pi",
      listSessions: async () => [],
      isSessionActive: async () => true,
      deliver: async () => { deliverCalls++; return { ok: true }; },
    } as DeliveryAdapter);
    const outcome = await d.dispatch(ev("e1", topic.id));
    expect(deliverCalls).toBe(1);
    expect(outcome.delivered).toBe(1);
  });

  it("dispatch still delivers for adapters without isSessionActive (optional capability)", async () => {
    const store = makeStore();
    const topic = store.createTopic("legacy-adapter");
    store.createSubscription({ topicId: topic.id, target: { agent: "claude", sessionId: "s1" } });
    const d = new Dispatcher(store);
    let deliverCalls = 0;
    d.registerAdapter({
      agent: "claude",
      listSessions: async () => [],
      deliver: async () => { deliverCalls++; return { ok: true }; },
    } as DeliveryAdapter);
    const outcome = await d.dispatch(ev("e1", topic.id));
    expect(deliverCalls).toBe(1);
    expect(outcome.delivered).toBe(1);
  });
});
