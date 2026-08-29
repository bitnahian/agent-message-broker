import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db.js";
import { BrokerStore } from "../store.js";
import { registerBuiltinSources } from "./index.js";
import type { SourceContext, SourceInstance } from "./registry.js";
import { Poller, type PollResult } from "./poller.js";

/** Polling source that fails to start (simulates preflight auth failure). */
class FailingSource implements SourceInstance {
  constructor(private ctx: SourceContext) {}
  async start(): Promise<void> { throw new Error("credentials missing"); }
  async stop(): Promise<void> {}
}

class OkSource extends Poller {
  constructor(ctx: SourceContext) { super(ctx, { intervalMs: 60_000, immediate: false }); }
  protected async poll(): Promise<PollResult[]> { return []; }
}

describe("SourceManager lifecycle status", () => {
  function make() {
    const store = new BrokerStore(createDb(":memory:"));
    const app = buildApp({ store });
    const topic = store.createTopic("t");
    return { app, store, topic };
  }

  it("tracks running/stopped status through start/stop", async () => {
    const { app, store, topic } = make();
    const source = store.createSource({ topicId: topic.id, kind: "ok" });
    app.sourceRegistry.register("ok", (ctx) => new OkSource(ctx));
    expect(app.sourceManager.status(source.id)).toBe("configured");
    await app.sourceManager.start(source.id);
    expect(app.sourceManager.status(source.id)).toBe("running");
    expect(app.sourceManager.runningIds()).toEqual([source.id]);
    await app.sourceManager.stop(source.id);
    expect(app.sourceManager.status(source.id)).toBe("stopped");
  });

  it("sets auth-failed when start() preflight throws; source not running", async () => {
    const { app, store, topic } = make();
    const source = store.createSource({ topicId: topic.id, kind: "failing" });
    app.sourceRegistry.register("failing", (ctx) => new FailingSource(ctx));
    await expect(app.sourceManager.start(source.id)).rejects.toThrow(/credentials missing/);
    expect(app.sourceManager.status(source.id)).toBe("auth-failed");
    expect(app.sourceManager.runningIds()).toEqual([]);
  });

  it("source missing throws on start", async () => {
    const { app } = make();
    await expect(app.sourceManager.start("nope")).rejects.toThrow(/source not found/);
  });

  it("builtin source registry kinds include generic-webhook", () => {
    const { app } = make();
    registerBuiltinSources(app.sourceRegistry);
    expect(app.sourceRegistry.kinds()).toContain("generic-webhook");
    expect(app.sourceRegistry.has("github")).toBe(true);
    expect(app.sourceRegistry.has("unknown")).toBe(false);
  });

  it("/sources responds with per-source status", async () => {
    const { app, store, topic } = make();
    app.sourceRegistry.register("ok", (ctx) => new OkSource(ctx));
    const source = store.createSource({ topicId: topic.id, kind: "ok" });
    await app.sourceManager.start(source.id);
    const res = await app.inject({ method: "GET", url: "/sources" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; status: string }[];
    const s = body.find((b) => b.id === source.id);
    expect(s?.status).toBe("running");
  });
});