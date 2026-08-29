import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db.js";
import { BrokerStore } from "../store.js";
import { verifyAndDecode, GenericWebhookSource } from "./generic-webhook.js";
import type { SourceContext } from "./registry.js";

describe("verifyAndDecode", () => {
  it("requires envelope.type", () => {
    expect(() => verifyAndDecode({}, { foo: 1 })).toThrow(/missing envelope.type/);
  });

  it("requires matching secret when configured", () => {
    const verify = () => verifyAndDecode({ secret: "s3" }, { type: "push" }, "wrong");
    try {
      verify();
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { status?: number }).status).toBe(401);
    }
  });

  it("accepts matching secret and returns envelope", () => {
    const env = verifyAndDecode({ secret: "s3" }, { type: "push", id: "1", occurredAt: "2026-01-01T00:00:00Z", payload: { x: 1 } }, "s3");
    expect(env).toEqual({ type: "push", id: "1", occurredAt: "2026-01-01T00:00:00Z", payload: { x: 1 } });
  });

  it("passes when no secret configured (off by default)", () => {
    const env = verifyAndDecode({}, { type: "push" }, undefined);
    expect(env.type).toBe("push");
    expect(env.payload).toEqual({ type: "push" });
  });

  it("rejects types outside the allowlist", () => {
    try {
      verifyAndDecode({ types: ["a", "b"] }, { type: "z" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { status?: number }).status).toBe(403);
    }
  });
});

describe("GenericWebhookSource", () => {
  it("is a no-op receiver (start/stop do not poll)", async () => {
    const store = new BrokerStore(createDb(":memory:"));
    const app = buildApp({ store });
    const topic = store.createTopic("gw");
    const source = store.createSource({ topicId: topic.id, kind: "generic-webhook", options: { secret: "s", types: ["push"] } });
    const ctx: SourceContext = {
      store, bus: app.bus, config: source,
      getState: (k) => store.getSourceState(source.id, k),
      setState: (k, v) => store.setSourceState(source.id, k, v),
      emit: async () => {},
    };
    const src = new GenericWebhookSource(ctx);
    expect(src.options).toEqual({ secret: "s", types: ["push"] });
    await expect(src.start()).resolves.toBeUndefined();
    await expect(src.stop()).resolves.toBeUndefined();
  });
});

describe("POST /webhooks/:sourceId (generic-webhook)", () => {
  function makeApp() {
    const store = new BrokerStore(createDb(":memory:"));
    const app = buildApp({ store });
    const topic = store.createTopic("gwtopic");
    const source = store.createSource({ topicId: topic.id, kind: "generic-webhook", options: { secret: "hooksecret" } });
    return { app, store, source, topic };
  }

  it("kind = webhook:<type>, stores envelope", async () => {
    const { app, store, topic } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${store.listSources()[0].id}`,
      payload: { type: "deploy", id: "e1", occurredAt: "2026-01-01T00:00:00Z", payload: { sha: "abc" } },
      headers: { "x-broker-secret": "hooksecret" },
    });
    expect(res.statusCode).toBe(202);
    const ev = store.listEvents(topic.id)[0];
    expect(ev.kind).toBe("webhook:deploy");
    expect((ev.payload as { type: string }).type).toBe("deploy");
  });

  it("401 on bad secret", async () => {
    const { app, store } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${store.listSources()[0].id}`,
      payload: { type: "push" },
      headers: { "x-broker-secret": "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("404 when source missing", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "POST", url: "/webhooks/nope", payload: { type: "x" } });
    expect(res.statusCode).toBe(404);
  });

  it("400 when envelope.type missing", async () => {
    const { app, store } = makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${store.listSources()[0].id}`,
      payload: { nope: 1 },
      headers: { "x-broker-secret": "hooksecret" },
    });
    expect(res.statusCode).toBe(400);
  });
});