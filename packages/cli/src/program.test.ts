import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "@amb/server";
import { createDb } from "@amb/server/db";
import { BrokerStore } from "@amb/server/store";
import { BrokerClient } from "./client.js";
import { createProgram } from "./program.js";

let app: FastifyInstance;
let baseUrl: string;

async function runCli(...args: string[]): Promise<string> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((v) => lines.push(String(v)));
  try {
    await createProgram(new BrokerClient({ baseUrl })).parseAsync(["node", "amb", ...args]);
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

beforeAll(async () => {
  const store = new BrokerStore(createDb(":memory:"));
  app = buildApp({ store });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => { await app.close(); });

describe("amb CLI (against live server)", () => {
  it("topics create + list", async () => {
    const out = await runCli("topics", "create", "cli-topic", "--retain", "7");
    const created = JSON.parse(out);
    expect(created.name).toBe("cli-topic");
    expect(created.retainN).toBe(7);
    const list = JSON.parse(await runCli("topics", "list"));
    expect(list.some((t: { name: string }) => t.name === "cli-topic")).toBe(true);
  });

  it("full flow: topic → source → subscription → publish → events list", async () => {
    const topic = JSON.parse(await runCli("topics", "create", "flow"));
    await runCli("sources", "create", "--topic", topic.id, "--kind", "polled-url", "--options", JSON.stringify({ url: "http://example.com" }));
    await runCli("subscriptions", "create", "--topic", topic.id, "--agent", "pi", "--session", "s-1", "--template", "EV {{kind}}");
    const pub = JSON.parse(await runCli("events", "publish", "--topic", topic.id, "--kind", "manual", "--payload", JSON.stringify({ x: 1 })));
    expect(pub.event.kind).toBe("manual");
    const events = JSON.parse(await runCli("events", "list", "--topic", topic.id));
    expect(events).toHaveLength(1);
    const subs = JSON.parse(await runCli("subscriptions", "list", "--topic", topic.id));
    expect(subs[0].target).toEqual({ agent: "pi", sessionId: "s-1" });
    const sources = JSON.parse(await runCli("sources", "list"));
    expect(sources.some((s: { kind: string }) => s.kind === "polled-url")).toBe(true);
  });

  it("deletes via CLI: subscription → source → topic", async () => {
    const topic = JSON.parse(await runCli("topics", "create", "del-test"));
    const source = JSON.parse(await runCli("sources", "create", "--topic", topic.id, "--kind", "jira", "--options", JSON.stringify({ jql: "x" })));
    const sub = JSON.parse(await runCli("subscriptions", "create", "--topic", topic.id, "--agent", "claude", "--session", "s-9"));
    JSON.parse(await runCli("subscriptions", "delete", sub.id));
    JSON.parse(await runCli("sources", "delete", source.id));
    const del = JSON.parse(await runCli("topics", "delete", topic.name)); // by name
    expect(del.deleted).toBe(topic.name);
    const topics = JSON.parse(await runCli("topics", "list"));
    expect(topics.some((t: { name: string }) => t.name === "del-test")).toBe(false);
  });

  it("doctor reports health and agents", async () => {
    const out = JSON.parse(await runCli("doctor"));
    expect(out.health.ok).toBe(true);
    expect(out.agents).toHaveProperty("agents");
  });

  it("sessions endpoint responds (may be empty without running agents)", async () => {
    const out = JSON.parse(await runCli("sessions"));
    expect(Array.isArray(out)).toBe(true);
  });

  it("webhook posts via the top-level alias and the events spelling", async () => {
    const topic = JSON.parse(await runCli("topics", "create", "webhook-alias"));
    const source = JSON.parse(await runCli("sources", "create", "--topic", topic.id, "--kind", "polled-url", "--options", JSON.stringify({ url: "http://example.com", secret: "s3cr3t" })));
    // top-level alias
    const alias = JSON.parse(await runCli("webhook", source.id, "--payload", JSON.stringify({ ping: 1 }), "--secret", "s3cr3t"));
    expect(alias.event.kind).toBe("polled-url");
    // nested spelling still works
    const nested = JSON.parse(await runCli("events", "webhook", source.id, "--payload", JSON.stringify({ ping: 2 }), "--secret", "s3cr3t"));
    expect(nested.event.kind).toBe("polled-url");
    const events = JSON.parse(await runCli("events", "list", "--topic", topic.id));
    expect(events).toHaveLength(2);
  });
});
