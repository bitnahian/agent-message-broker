import { describe, expect, it } from "vitest";
import type { BrokerEvent, DeliveryAdapter } from "@amb/core";
import { buildApp } from "./app.js";
import { createDb } from "./db.js";
import { BrokerStore } from "./store.js";

function makeApp(token?: string) {
  const store = new BrokerStore(createDb(":memory:"));
  const app = buildApp({ store, token });
  return { app, store };
}

describe("server skeleton", () => {
  it("health is public", async () => {
    const { app } = makeApp("secret");
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("enforces bearer token when configured", async () => {
    const { app } = makeApp("secret");
    const res = await app.inject({ method: "GET", url: "/topics" });
    expect(res.statusCode).toBe(401);
    const ok = await app.inject({ method: "GET", url: "/topics", headers: { authorization: "Bearer secret" } });
    expect(ok.statusCode).toBe(200);
    // UI cookie path: GET / is open and sets SameSite=Strict cookie; cookie then authenticates
    const open = await app.inject({ method: "GET", url: "/" });
    const setCookie = open.headers["set-cookie"] as string | undefined;
    if (setCookie) {
      expect(setCookie).toContain("SameSite=Strict");
      const viaCookie = await app.inject({ method: "GET", url: "/topics", headers: { cookie: "amb_token=secret" } });
      expect(viaCookie.statusCode).toBe(200);
    }
  });

  it("rejects duplicate topic names with 409", async () => {
    const { app } = makeApp();
    const first = await app.inject({ method: "POST", url: "/topics", payload: { name: "dup" } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/topics", payload: { name: "dup" } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toContain("already exists");
  });

  it("validates per-kind required options", async () => {
    const { app, store } = makeApp();
    const topic = store.createTopic("val");
    const bad = await app.inject({ method: "POST", url: "/sources", payload: { topicId: topic.id, kind: "jira", options: {} } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("jql");
    const good = await app.inject({ method: "POST", url: "/sources", payload: { topicId: topic.id, kind: "jira", options: { jql: "x" } } });
    expect(good.statusCode).toBe(200);
  });

  it("rejects duplicate sources with 409", async () => {
    const { app, store } = makeApp();
    const topic = store.createTopic("dupsrc");
    const payload = { topicId: topic.id, kind: "github", options: { repo: "cli/cli" } };
    const first = await app.inject({ method: "POST", url: "/sources", payload });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/sources", payload });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toContain("identical source");
  });

  it("rejects duplicate subscriptions with 409", async () => {
    const { app, store } = makeApp();
    const topic = store.createTopic("dupsub");
    const payload = { topicId: topic.id, target: { agent: "pi", sessionId: "s-1" } };
    expect((await app.inject({ method: "POST", url: "/subscriptions", payload })).statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/subscriptions", payload });
    expect(second.statusCode).toBe(409);
  });

  it("creates topics, sources, subscriptions", async () => {
    const { app } = makeApp();
    const t = await app.inject({ method: "POST", url: "/topics", payload: { name: "prs", retainN: 5 } });
    expect(t.statusCode).toBe(200);
    const topic = t.json();
    const s = await app.inject({ method: "POST", url: "/sources", payload: { topicId: topic.id, kind: "github", options: { repo: "a/b" } } });
    expect(s.statusCode).toBe(200);
    const sub = await app.inject({ method: "POST", url: "/subscriptions", payload: { topicId: topic.id, target: { agent: "pi", sessionId: "x" } } });
    expect(sub.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/subscriptions?topicId=${topic.id}` })).json()).toHaveLength(1);
  });

  it("retains only retainN events per topic when published", async () => {
    const { app, store } = makeApp();
    const topic = store.createTopic("bounded", 3);
    for (let i = 0; i < 6; i++) {
      await app.inject({ method: "POST", url: "/events", payload: { topicId: topic.id, kind: "tick", payload: { i } } });
    }
    const events = store.listEvents(topic.id);
    expect(events).toHaveLength(3);
    expect((events[0] as BrokerEvent).payload).toEqual({ i: 5 }); // most recent first
  });

  it("persists delivery attempts incl. failures", async () => {
    const { app, store } = makeApp();
    const topic = store.createTopic("deliveries");
    const sub = store.createSubscription({ topicId: topic.id, target: { agent: "pi", sessionId: "s1" } });
    const res = await app.inject({ method: "POST", url: "/events", payload: { topicId: topic.id, kind: "k", payload: 1 } });
    expect(res.statusCode).toBe(202);
    const attempts = store.listDeliveries();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.ok).toBe(false); // no adapter registered
    expect(attempts[0]?.error).toContain("no adapter");
    const list = await app.inject({ method: "GET", url: "/deliveries" });
    expect(list.statusCode).toBe(200);
  });

  it("publishes by topic NAME as well as id (CLI --topic accepts both)", async () => {
    const { app, store } = makeApp();
    const topic = store.createTopic("by-name");
    const res = await app.inject({ method: "POST", url: "/events", payload: { topicId: "by-name", kind: "k", payload: { x: 1 } } });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { event: { topicId: string } };
    expect(body.event.topicId).toBe(topic.id); // stored under the canonical id
    const events = store.listEvents(topic.id);
    expect(events).toHaveLength(1);
  });

  it("publishes without a payload (defaults to empty object, no 500)", async () => {
    const { app, store } = makeApp();
    const topic = store.createTopic("no-payload");
    const res = await app.inject({ method: "POST", url: "/events", payload: { topicId: topic.id, kind: "k" } });
    expect(res.statusCode).toBe(202);
    const events = store.listEvents(topic.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({});
  });

  it("lists events by topic NAME as well as id", async () => {
    const { app, store } = makeApp();
    const topic = store.createTopic("list-by-name");
    await app.inject({ method: "POST", url: "/events", payload: { topicId: topic.id, kind: "k", payload: 1 } });
    const byName = await app.inject({ method: "GET", url: "/events?topicId=list-by-name" });
    expect((byName.json() as unknown[]).length).toBe(1);
    const byId = await app.inject({ method: "GET", url: `/events?topicId=${topic.id}` });
    expect((byId.json() as unknown[]).length).toBe(1);
  });

  it("dispatches published events to subscription adapters", async () => {
    const { app, store } = makeApp();
    const topic = store.createTopic("dispatch");
    store.createSubscription({ topicId: topic.id, target: { agent: "pi", sessionId: "s1" } });
    const received: string[] = [];
    const fake: DeliveryAdapter = {
      agent: "pi",
      listSessions: async () => [],
      deliver: async (_t, p) => { received.push(p.message); return { ok: true }; },
    };
    app.dispatcher.registerAdapter(fake);
    const res = await app.inject({ method: "POST", url: "/events", payload: { topicId: topic.id, kind: "pr-opened", payload: { n: 1 } } });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.dispatch.delivered).toBe(1);
    expect(received[0]).toContain("pr-opened");
  });

  it("SSE replay honors Last-Event-ID to avoid duplicate replay", async () => {
    const { app, store } = makeApp();
    const topic = store.createTopic("sse");
    const evs = [];
    for (let i = 0; i < 3; i++) evs.push(store.publishEvent({ topicId: topic.id, kind: "k", payload: { i } }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/events/stream?topicId=${topic.id}&replay=1`, {
      headers: { "last-event-id": evs[1]!.id },
    });
    const reader = res.body!.getReader();
    let text = "";
    const decoder = new TextDecoder();
    for (let reads = 0; reads < 5 && !text.includes("data:"); reads++) {
      text += decoder.decode((await reader.read()).value ?? "");
    }
    const payloadEvents = [...text.matchAll(/data: (\{.*\})/g)].map((m) => JSON.parse(m[1]!));
    expect(payloadEvents).toHaveLength(1);
    expect(payloadEvents[0].id).toBe(evs[2]!.id);
    await reader.cancel();
    await app.close();
  });

  it("accepts hybrid inbound webhooks with optional secret", async () => {
    const { app, store } = makeApp();
    const topic = store.createTopic("hook");
    const open = store.createSource({ topicId: topic.id, kind: "polled-url" });
    const ok = await app.inject({ method: "POST", url: `/webhooks/${open.id}`, payload: { kind: "push", data: 1 } });
    expect(ok.statusCode).toBe(202);

    const secured = store.createSource({ topicId: topic.id, kind: "polled-url", options: { secret: "s3cr" } });
    const bad = await app.inject({ method: "POST", url: `/webhooks/${secured.id}`, payload: {} });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: "POST", url: `/webhooks/${secured.id}`, headers: { "x-broker-secret": "s3cr" }, payload: {} });
    expect(good.statusCode).toBe(202);

    const missing = await app.inject({ method: "POST", url: "/webhooks/nope", payload: {} });
    expect(missing.statusCode).toBe(404);
  });

  it("deletes subscriptions, sources, and topics (cascade)", async () => {
    const { app, store } = makeApp();
    const topic = store.createTopic("todel");
    const source = store.createSource({ topicId: topic.id, kind: "polled-url" });
    const sub = store.createSubscription({ topicId: topic.id, target: { agent: "pi", sessionId: "x" } });
    store.publishEvent({ topicId: topic.id, kind: "k", payload: 1 });

    const d1 = await app.inject({ method: "DELETE", url: `/subscriptions/${sub.id}` });
    expect(d1.statusCode).toBe(200);
    expect(store.listSubscriptions()).toHaveLength(0);

    const d2 = await app.inject({ method: "DELETE", url: `/sources/${source.id}` });
    expect(d2.statusCode).toBe(200);

    const d3 = await app.inject({ method: "DELETE", url: `/topics/${topic.id}` });
    expect(d3.statusCode).toBe(200);
    expect(store.listTopics()).toHaveLength(0);
    expect(store.listEvents(topic.id)).toHaveLength(0);

    const missing = await app.inject({ method: "DELETE", url: "/topics/nope" });
    expect(missing.statusCode).toBe(404);
  });

  it("reconcile re-drives failed deliveries once an adapter appears", async () => {
    const { app, store } = makeApp();
    const topic = store.createTopic("reconcile");
    const sub = store.createSubscription({ topicId: topic.id, target: { agent: "pi", sessionId: "s1" } });
    await app.inject({ method: "POST", url: "/events", payload: { topicId: topic.id, kind: "k", payload: 1 } });
    expect(store.eventsPendingRetry(Date.now() - 1000)).toHaveLength(1); // no adapter yet

    const received: string[] = [];
    app.dispatcher.registerAdapter({
      agent: "pi",
      listSessions: async () => [],
      deliver: async (_t, p) => { received.push(p.message); return { ok: true }; },
    });
    const redriven = await app.dispatcher.reconcile();
    expect(redriven).toBe(1);
    expect(received).toHaveLength(1);
    expect(store.eventsPendingRetry(Date.now() - 1000)).toHaveLength(0);
    expect(store.listDeliveries().filter((d) => d.subscriptionId === sub.id && d.ok)).toHaveLength(1);
  });

  it("delivery attempts cascade when retention prunes their events", async () => {
    const { app, store } = makeApp();
    const topic = store.createTopic("cascade", 2);
    store.createSubscription({ topicId: topic.id, target: { agent: "pi", sessionId: "s1" } });
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: "POST", url: "/events", payload: { topicId: topic.id, kind: "tick", payload: { i } } });
    }
    expect(store.listEvents(topic.id)).toHaveLength(2);
    // every attempt row must reference a live event — no orphan growth
    const retainedIds = new Set(store.listEvents(topic.id).map((e) => e.id));
    const attempts = store.listDeliveries(undefined, 1000);
    expect(attempts.length).toBeGreaterThan(0);
    for (const a of attempts) expect(retainedIds.has(a.eventId)).toBe(true);
  });

  it("delivery attempts cascade when the topic is deleted", async () => {
    const { app, store } = makeApp();
    const topic = store.createTopic("cascade-del");
    store.createSubscription({ topicId: topic.id, target: { agent: "pi", sessionId: "s1" } });
    await app.inject({ method: "POST", url: "/events", payload: { topicId: topic.id, kind: "k", payload: 1 } });
    expect(store.listDeliveries(undefined, 1000).length).toBeGreaterThan(0);
    store.deleteTopic(topic.id);
    expect(store.listDeliveries(undefined, 1000)).toHaveLength(0);
  });

  it("reconcile stops re-driving a subscription after max failed attempts", async () => {
    const { app, store } = makeApp();
    const topic = store.createTopic("spent");
    const sub = store.createSubscription({ topicId: topic.id, target: { agent: "pi", sessionId: "s1" } });
    app.dispatcher.registerAdapter({
      agent: "pi",
      listSessions: async () => [],
      deliver: async () => ({ ok: false, detail: "always fails" }),
    });
    await app.inject({ method: "POST", url: "/events", payload: { topicId: topic.id, kind: "k", payload: 1 } });
    // one initial dispatch attempt + repeated reconciles up to the cap
    let total = 0;
    for (let i = 0; i < 20; i++) total += await app.dispatcher.reconcile(Date.now() - 60_000);
    const failures = store.listDeliveries(undefined, 1000).filter((d) => d.subscriptionId === sub.id && !d.ok);
    expect(failures.length).toBeLessThanOrEqual(10); // maxAttempts cap
    expect(total).toBeLessThanOrEqual(10);
    // further boots change nothing
    expect(await app.dispatcher.reconcile(Date.now() - 60_000)).toBe(0);
    expect(store.eventsPendingRetry(Date.now() - 60_000)).toHaveLength(0);
  });

  it("events are persisted even when nobody is listening (retention buffer)", async () => {
    const { app, store } = makeApp();
    const topic = store.createTopic("offline");
    await app.inject({ method: "POST", url: "/events", payload: { topicId: topic.id, kind: "k", payload: 1 } });
    const res = await app.inject({ method: "GET", url: `/events?topicId=${topic.id}` });
    expect(res.json()).toHaveLength(1);
  });
});
