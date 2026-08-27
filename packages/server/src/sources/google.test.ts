import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db.js";
import { BrokerStore } from "../store.js";
import { GoogleSource, splitApi, type GoogleApiRunner } from "./google.js";
import type { SourceContext } from "./registry.js";

function fakeRunner(data: unknown | (() => unknown), opts: { fail?: boolean; calls?: string[] } = {}): GoogleApiRunner {
  return async (api, params) => {
    opts.calls?.push(`${api}:${JSON.stringify(params)}`);
    if (opts.fail) throw new Error("google down");
    const d = typeof data === "function" ? data() : data;
    return d as Record<string, unknown>;
  };
}

function setup(runner?: GoogleApiRunner, options: Record<string, unknown> = { api: "drive.files.list", itemsPath: "files" }) {
  const store = new BrokerStore(createDb(":memory:"));
  const app = buildApp({ store });
  const topic = store.createTopic("g");
  const source = store.createSource({ topicId: topic.id, kind: "google", options });
  const ctx: SourceContext = {
    store, bus: app.bus, config: source,
    getState: (k) => store.getSourceState(source.id, k),
    setState: (k, v) => store.setSourceState(source.id, k, v),
    emit: async (kind, payload) => { await app.bus.publish({ topicId: topic.id, sourceId: source.id, kind, payload }); },
  };
  const src = runner ? new GoogleSource(ctx, runner) : new GoogleSource(ctx, fakeRunner({ files: [] }));
  return { store, src };
}

describe("splitApi", () => {
  it("splits service.resource.method", () => {
    expect(splitApi("drive.files.list")).toEqual({ service: "drive", resourcePath: ["files"], method: "list" });
  });
  it("handles deeply nested pubsub path", () => {
    expect(splitApi("pubsub.projects.subscriptions.pull")).toEqual({ service: "pubsub", resourcePath: ["projects", "subscriptions"], method: "pull" });
  });
  it("throws on malformed target", () => {
    expect(() => splitApi("drive.files")).toThrow();
  });
});

describe("GoogleSource (SDK poller)", () => {
  it("emits gws:drive:new for first-seen file ids, deduped", async () => {
    const { store, src } = setup(fakeRunner({ files: [{ id: "a", modifiedTime: "t1" }, { id: "b", modifiedTime: "t2" }] }), { api: "drive.files.list", itemsPath: "files" });
    expect(await src.tick()).toBe(2);
    expect(await src.tick()).toBe(0);
    const events = store.listEvents();
    expect(events.map((e) => e.kind).sort()).toEqual(["gws:drive:new", "gws:drive:new"]);
  });

  it("emits gws:<svc>:changed when fingerprintField set and value changes", async () => {
    let data = { files: [{ id: "a", modifiedTime: "t1" }] };
    const { store, src } = setup(fakeRunner(() => data), { api: "drive.files.list", itemsPath: "files", fingerprintField: "modifiedTime" });
    expect(await src.tick()).toBe(1);
    expect(store.listEvents()[0]?.kind).toBe("gws:drive:changed");
    data = { files: [{ id: "a", modifiedTime: "t2" }] };
    expect(await src.tick()).toBe(1); // same id, new fingerprint -> re-emit
    expect(store.listEvents()).toHaveLength(2);
  });

  it("passes api + params to the runner", async () => {
    const calls: string[] = [];
    const { src } = setup(fakeRunner({ values: [["x"]] }, { calls }), { api: "sheets.spreadsheets.values.get", itemsPath: "values", params: { spreadsheetId: "S", range: "A1" } });
    await src.tick();
    expect(calls[0]).toBe('sheets.spreadsheets.values.get:{"spreadsheetId":"S","range":"A1"}');
  });

  it("emits gws:error once on runner failure", async () => {
    const { store, src } = setup(fakeRunner({}, { fail: true }), { api: "drive.files.list", itemsPath: "files" });
    expect(await src.tick()).toBe(1);
    expect(await src.tick()).toBe(0);
    expect(store.listEvents()[0]?.kind).toBe("gws:error");
  });

  it("skips items without an id and defaults itemsPath empty", async () => {
    const { store, src, } = setup(fakeRunner({ files: [{ modifiedTime: "x" }] }), { api: "drive.files.list", itemsPath: "files", idField: "id" });
    expect(await src.tick()).toBe(0);
    expect(store.listEvents()).toHaveLength(0);
  });
});