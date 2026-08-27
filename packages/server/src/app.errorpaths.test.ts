import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createDb } from "./db.js";
import { BrokerStore } from "./store.js";
import type { FastifyInstance } from "fastify";

/** Build an authed app + inject helper. */
function ctx() {
  const store = new BrokerStore(createDb(":memory:"));
  const app = buildApp({ store, token: "secret" });
  const inj = (opts: { method: string; url: string; payload?: unknown; headers?: Record<string, string> }) =>
    app.inject({
      method: opts.method,
      url: opts.url,
      payload: opts.payload as any,
      headers: { authorization: "Bearer secret", ...opts.headers },
    });
  return { store, app, inj, close: () => app.close() };
}

describe("api error paths (400/404/409/401 branches)", () => {
  it("rejects /topics without a name", async () => {
    const { inj } = ctx();
    const res = await inj({ method: "POST", url: "/topics", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("rejects /sources without topicId/kind, with missing options, and unknown topic", async () => {
    const { inj } = ctx();
    const noKind = await inj({ method: "POST", url: "/sources", payload: { topicId: "x" } });
    expect(noKind.statusCode).toBe(400);
    const t = (await inj({ method: "POST", url: "/topics", payload: { name: "src-t" } })).json() as any;
    const missingOpt = await inj({ method: "POST", url: "/sources", payload: { topicId: t.id, kind: "jira", options: {} } });
    expect(missingOpt.statusCode).toBe(400);
    const badTopic = await inj({ method: "POST", url: "/sources", payload: { topicId: "nope", kind: "jira", options: { jql: "x" } } });
    expect(badTopic.statusCode).toBe(404);
  });

  it("rejects /subscriptions missing target, unknown topic, and unknown id to delete", async () => {
    const { inj } = ctx();
    const t = (await inj({ method: "POST", url: "/topics", payload: { name: "sub-t" } })).json() as any;
    const noTarget = await inj({ method: "POST", url: "/subscriptions", payload: { topicId: t.id } });
    expect(noTarget.statusCode).toBe(400);
    const noTopic = await inj({ method: "POST", url: "/subscriptions", payload: { topicId: "nope", target: { agent: "pi", sessionId: "s" } } });
    expect(noTopic.statusCode).toBe(404);
    const delMissing = await inj({ method: "DELETE", url: "/subscriptions/nope" });
    expect(delMissing.statusCode).toBe(404);
  });

  it("rejects /events without topicId/kind and with unknown topic", async () => {
    const { inj } = ctx();
    const noBody = await inj({ method: "POST", url: "/events", payload: {} });
    expect(noBody.statusCode).toBe(400);
    const noTopic = await inj({ method: "POST", url: "/events", payload: { topicId: "nope", kind: "k" } });
    expect(noTopic.statusCode).toBe(404);
  });

  it("deleting a missing source and starting a missing source yields 404/400", async () => {
    const { inj } = ctx();
    const delMissing = await inj({ method: "DELETE", url: "/sources/nope" });
    expect(delMissing.statusCode).toBe(404);
    const startMissing = await inj({ method: "POST", url: "/sources/nope/start" });
    expect(startMissing.statusCode).toBe(400);
    const stopMissing = await inj({ method: "POST", url: "/sources/nope/stop" });
    expect(stopMissing.statusCode).toBe(200); // stop is best-effort
  });

  it("webhooks: rejects unknown source with 404 and wrong secret with 401", async () => {
    const { inj } = ctx();
    const notFound = await inj({ method: "POST", url: "/webhooks/nope", payload: {} });
    expect(notFound.statusCode).toBe(404);
    const t = (await inj({ method: "POST", url: "/topics", payload: { name: "wh-t" } })).json() as any;
    const src = (await inj({ method: "POST", url: "/sources", payload: { topicId: t.id, kind: "polled-url", options: { url: "https://x", secret: "sek" } } })).json() as any;
    const badSecret = await inj({ method: "POST", url: `/webhooks/${src.id}`, headers: { "x-broker-secret": "wrong" }, payload: { kind: "k" } });
    expect(badSecret.statusCode).toBe(401);
    const ok = await inj({ method: "POST", url: `/webhooks/${src.id}`, headers: { "x-broker-secret": "sek" }, payload: { kind: "k" } });
    expect(ok.statusCode).toBe(202);
  });

  it("webhooks publish uses the source kind as a fallback kind", async () => {
    const { inj } = ctx();
    const t = (await inj({ method: "POST", url: "/topics", payload: { name: "wh-kind" } })).json() as any;
    const src = (await inj({ method: "POST", url: "/sources", payload: { topicId: t.id, kind: "github", options: { repo: "a/b" } } })).json() as any;
    const res = await inj({ method: "POST", url: `/webhooks/${src.id}`, payload: {} });
    expect(res.statusCode).toBe(202);
    expect(res.json().event.kind).toBe("github");
  });
});