import { describe, expect, it } from "vitest";
import type { DeliveryAdapter } from "@amb/core";
import { buildApp } from "../app.js";
import { createDb } from "../db.js";
import { BrokerStore } from "../store.js";
import { Poller, type PollResult } from "./poller.js";
import type { SourceContext } from "./registry.js";

/** Fake polling source: emits an incrementing counter each tick. */
class CounterSource extends Poller {
  private n = 0;
  constructor(ctx: SourceContext) { super(ctx, { intervalMs: 60_000, immediate: false }); }
  protected async poll(): Promise<PollResult[]> {
    this.n++;
    return [{ kind: "tick", key: `tick-${this.n}`, payload: { n: this.n } }];
  }
}

function setup() {
  const store = new BrokerStore(createDb(":memory:"));
  const app = buildApp({ store });
  return { app, store };
}

describe("event-source framework", () => {
  it("dedupes events by key across ticks and persists state", async () => {
    const { app, store } = setup();
    const topic = store.createTopic("fw");
    const source = store.createSource({ topicId: topic.id, kind: "counter" });
    app.sourceRegistry.register("counter", (ctx) => new CounterSource(ctx));

    await app.sourceManager.start(source.id);
    const inst = app.sourceManager.runningIds();
    expect(inst).toEqual([source.id]);

    // manual ticks via a fresh instance share persisted state
    const ctx1 = (app.sourceManager as unknown as { makeContext: (c: unknown) => SourceContext });
    void ctx1; // context creation is internal; use stop/start cycle instead
    await app.sourceManager.stop(source.id);

    // tick twice via start/stop with immediate sources
    const src1 = new CounterSource({
      store, bus: app.bus, config: source,
      getState: (k) => store.getSourceState(source.id, k),
      setState: (k, v) => store.setSourceState(source.id, k, v),
      emit: async (kind, payload) => { await app.bus.publish({ topicId: topic.id, sourceId: source.id, kind, payload }); },
    });
    expect(await src1.tick()).toBe(1); // tick-1 new
    expect(await src1.tick()).toBe(1); // tick-2 new
    expect(await src1.tick()).toBe(1); // tick-3 new

    // fresh instance with same persisted state: replays nothing new until counter passes
    const src2 = new CounterSource({
      store, bus: app.bus, config: source,
      getState: (k) => store.getSourceState(source.id, k),
      setState: (k, v) => store.setSourceState(source.id, k, v),
      emit: async (kind, payload) => { await app.bus.publish({ topicId: topic.id, sourceId: source.id, kind, payload }); },
    });
    expect(await src2.tick()).toBe(0); // tick-1 already seen
    expect(store.listEvents(topic.id)).toHaveLength(3);
  });

  it("routes emitted events through the bus to adapters", async () => {
    const { app, store } = setup();
    const topic = store.createTopic("fw2");
    store.createSubscription({ topicId: topic.id, target: { agent: "pi", sessionId: "s1" } });
    const received: string[] = [];
    const fake: DeliveryAdapter = {
      agent: "pi",
      listSessions: async () => [],
      deliver: async (_t, p) => { received.push(p.message); return { ok: true }; },
    };
    app.dispatcher.registerAdapter(fake);
    const source = store.createSource({ topicId: topic.id, kind: "counter" });
    app.sourceRegistry.register("counter", (ctx) => new CounterSource(ctx));
    await app.sourceManager.start(source.id);
    // start() with immediate:false won't tick; trigger via start route on immediate source instead
    const res = await app.inject({ method: "POST", url: `/sources/${source.id}/start` });
    expect(res.statusCode).toBe(200);
    await app.sourceManager.stop(source.id);
    // directly tick the managed instance path once more via registry
    const inst = app.sourceRegistry.create({
      store, bus: app.bus, config: source,
      getState: (k) => store.getSourceState(source.id, k),
      setState: (k, v) => store.setSourceState(source.id, k, v),
      emit: async (kind, payload) => { await app.bus.publish({ topicId: topic.id, sourceId: source.id, kind, payload }); },
    }) as CounterSource;
    await inst.tick();
    expect(received.length).toBeGreaterThan(0);
    expect(received[0]).toContain("tick");
  });

  it("backs off exponentially while erroring, recovers on success", async () => {
    class FlapSource extends Poller {
      constructor(ctx: SourceContext) { super(ctx, { intervalMs: 10, immediate: false }); }
      fail = true;
      protected async poll(): Promise<PollResult[]> {
        if (this.fail) return [{ kind: "flap:error", key: "e", payload: {} }];
        return [{ kind: "flap:ok", key: `ok-${Date.now()}`, payload: {} }];
      }
    }
    const { app, store } = setup();
    const topic = store.createTopic("flap");
    const source = store.createSource({ topicId: topic.id, kind: "flap" });
    const mk = () => ({
      store, bus: app.bus, config: source,
      getState: (k: string) => store.getSourceState(source.id, k),
      setState: (k: string, v: unknown) => store.setSourceState(source.id, k, v),
      emit: async (kind: string, payload: unknown) => { await app.bus.publish({ topicId: topic.id, sourceId: source.id, kind, payload }); },
    });
    const src = new FlapSource(mk() as SourceContext);
    await src.tick();
    const after1 = (src as unknown as { intervalMs: number }).intervalMs;
    await src.tick();
    const after2 = (src as unknown as { intervalMs: number }).intervalMs;
    expect(after2).toBeGreaterThan(after1);
    src.fail = false;
    await src.tick();
    expect((src as unknown as { intervalMs: number }).intervalMs).toBe(10);
  });

  it("start/stop routes manage the source lifecycle", async () => {
    const { app, store } = setup();
    const topic = store.createTopic("fw3");
    const source = store.createSource({ topicId: topic.id, kind: "counter" });
    app.sourceRegistry.register("counter", (ctx) => new CounterSource(ctx));
    const r1 = await app.inject({ method: "POST", url: `/sources/${source.id}/start` });
    expect(r1.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/sources/running" })).json().running).toContain(source.id);
    await app.inject({ method: "POST", url: `/sources/${source.id}/stop` });
    expect((await app.inject({ method: "GET", url: "/sources/running" })).json().running).toHaveLength(0);
  });
});
