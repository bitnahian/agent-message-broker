import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db.js";
import { BrokerStore } from "../store.js";
import { GwsSource, type GwsRunner } from "./gws.js";
import type { SourceContext } from "./registry.js";

function setup(runner: GwsRunner, options: Record<string, unknown>) {
  const store = new BrokerStore(createDb(":memory:"));
  const app = buildApp({ store });
  const topic = store.createTopic("gws");
  const source = store.createSource({ topicId: topic.id, kind: "gws", options });
  const ctx: SourceContext = {
    store, bus: app.bus, config: source,
    getState: (k) => store.getSourceState(source.id, k),
    setState: (k, v) => store.setSourceState(source.id, k, v),
    emit: async (kind, payload) => { await app.bus.publish({ topicId: topic.id, sourceId: source.id, kind, payload }); },
  };
  return { store, src: new GwsSource(ctx, runner) };
}

describe("GwsSource", () => {
  it("emits gws:<service>:new per new item id, deduped", async () => {
    const runner: GwsRunner = async () => JSON.stringify({ messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }] });
    const { store, src } = setup(runner, { command: ["gmail", "users", "messages", "list"], params: { userId: "me" }, itemsPath: "messages" });
    expect(await src.tick()).toBe(2);
    expect(await src.tick()).toBe(0);
    expect(store.listEvents().every((e) => e.kind === "gws:gmail:new")).toBe(true);
  });

  it("fetches per-item detail with {{id}} substitution", async () => {
    const calls: string[] = [];
    const runner: GwsRunner = async (command, params) => {
      calls.push(`${command.join(" ")} ${JSON.stringify(params)}`);
      if (command.includes("get")) return JSON.stringify({ id: params.id, snippet: "hello world" });
      return JSON.stringify({ messages: [{ id: "m9" }] });
    };
    const { store, src } = setup(runner, {
      command: ["gmail", "users", "messages", "list"], params: { userId: "me" }, itemsPath: "messages",
      detail: { command: ["gmail", "users", "messages", "get"], params: { userId: "me", id: "{{id}}", format: "metadata" } },
    });
    expect(await src.tick()).toBe(1);
    expect(calls.some((c) => c.includes('"id":"m9"'))).toBe(true);
    const ev = store.listEvents()[0];
    expect((ev?.payload as { detail: { snippet: string } }).detail.snippet).toBe("hello world");
  });

  it("fingerprintField re-emits changed items (drive modifiedTime)", async () => {
    let files = [{ id: "f1", name: "a.png", modifiedTime: "2026-01-01T00:00:00Z" }];
    const runner: GwsRunner = async () => JSON.stringify({ files });
    const { store, src } = setup(runner, { command: ["drive", "files", "list"], itemsPath: "files", fingerprintField: "modifiedTime" });
    expect(await src.tick()).toBe(1);
    expect(await src.tick()).toBe(0);
    files = [{ id: "f1", name: "a.png", modifiedTime: "2026-01-02T00:00:00Z" }];
    expect(await src.tick()).toBe(1);
    expect(store.listEvents().every((e) => e.kind === "gws:drive:changed")).toBe(true);
  });

  it("emits deduped gws:error on failure", async () => {
    const { store, src } = setup(async () => { throw new Error("gws auth expired"); }, { command: ["gmail"], itemsPath: "messages" });
    expect(await src.tick()).toBe(1);
    expect(await src.tick()).toBe(0);
    expect(store.listEvents()[0]?.kind).toBe("gws:error");
  });

  it("skips items without an id and handles a missing items array", async () => {
    // item with no id is skipped; doc without the itemsPath yields no events
    const runner: GwsRunner = async () => JSON.stringify({ messages: [{ id: "m1" }, { noId: true }] });
    const { store, src } = setup(runner, { command: ["gmail"], itemsPath: "messages" });
    expect(await src.tick()).toBe(1);
    const empty = setup(async () => JSON.stringify({ somethingElse: [{ id: "x" }] }), { command: ["gmail"], itemsPath: "messages" });
    expect(await empty.src.tick()).toBe(0);
  });

  it("keeps emitting when the per-item detail fetch fails (best-effort)", async () => {
    const runner: GwsRunner = async (cmd) => {
      if (cmd.includes("get")) throw new Error("detail boom");
      return JSON.stringify({ messages: [{ id: "m5" }] });
    };
    const { store, src } = setup(runner, {
      command: ["gmail", "list"], itemsPath: "messages",
      detail: { command: ["gmail", "get"], params: { userId: "me", id: "{{id}}" } },
    });
    expect(await src.tick()).toBe(1);
    const ev = store.listEvents()[0];
    // detail left undefined but the event is still emitted
    expect(ev?.kind).toBe("gws:gmail:new");
  });

  it("substitute() leaves non-string and non-{{id}} values untouched", async () => {
    const runner: GwsRunner = async (cmd, params) => {
      if (cmd.includes("get")) return JSON.stringify({ userId: params.id });
      return JSON.stringify({ messages: [{ id: "zz" }] });
    };
    const { src } = setup(runner, {
      command: ["gmail", "list"], itemsPath: "messages",
      detail: { command: ["gmail", "get"], params: { id: "{{id}}", numeric: 5, fixed: "no-placeholder" } },
    });
    expect(await src.tick()).toBe(1);
  });
});
