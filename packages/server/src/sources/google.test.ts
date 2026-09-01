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

  it("resolves dotted idField (pubsub message.messageId)", async () => {
    const { store, src } = setup(fakeRunner({ receivedMessages: [{ message: { messageId: "m1", data: "x" } }] }), { api: "pubsub.projects.subscriptions.pull", itemsPath: "receivedMessages", idField: "message.messageId" });
    expect(await src.tick()).toBe(1);
    expect(store.listEvents()[0]?.kind).toBe("gws:pubsub:new");
    expect((store.listEvents()[0]?.payload as { id: string }).id).toBe("m1");
    expect(await src.tick()).toBe(0); // same messageId deduped
  });

  it("keys sheet rows by a numeric cell index (sheets.spreadsheets.values.get)", async () => {
    const { store, src } = setup(
      fakeRunner({ values: [["row-a", "x1"], ["row-b", "x2"]] }),
      { api: "sheets.spreadsheets.values.get", itemsPath: "values", idField: "0" },
    );
    expect(await src.tick()).toBe(2);
    const kinds = store.listEvents().map((e) => e.kind).sort();
    expect(kinds).toEqual(["gws:sheets:new", "gws:sheets:new"]);
    const ids = store.listEvents().map((e) => (e.payload as { id: string }).id).sort();
    expect(ids).toEqual(["row-a", "row-b"]);
    expect(await src.tick()).toBe(0); // deduped on first-cell identity
  });

  it("re-emits a sheet row when its fingerprint cell changes", async () => {
    let data = { values: [["row-a", "v1"]] };
    const { store, src } = setup(() => data, { api: "sheets.spreadsheets.values.get", itemsPath: "values", idField: "0", fingerprintField: "1" });
    expect(await src.tick()).toBe(1);
    expect(store.listEvents()[0]?.kind).toBe("gws:sheets:changed");
    data = { values: [["row-a", "v2"]] };
    expect(await src.tick()).toBe(1);
    expect(store.listEvents()).toHaveLength(2);
  });
});
describe("GoogleSource content diff", () => {
  const DOC_ITEM = {
    id: "doc1",
    name: "Implementation Plan",
    mimeType: "application/vnd.google-apps.document",
    modifiedTime: "2026-01-01T00:00:00Z",
  };

  function contentRunner(exports: string | (() => string), calls?: string[]): GoogleApiRunner {
    return async (api, params) => {
      calls?.push(`${api}:${JSON.stringify(params)}`);
      if (api === "drive.files.export") {
        const body = typeof exports === "function" ? exports() : exports;
        return body as unknown as Record<string, unknown>;
      }
      return { files: [{ ...DOC_ITEM }] };
    };
  }

  it("first sighting emits full content with null diff; export mime auto-picked as markdown", async () => {
    const calls: string[] = [];
    const { store, src } = setup(contentRunner("# Plan\nDo the thing\n", calls), {
      api: "drive.files.list", itemsPath: "files", fingerprintField: "modifiedTime",
      content: { format: "auto" },
    });
    expect(await src.tick()).toBe(1);
    const ev = store.listEvents()[0]!;
    const p = ev.payload as { content?: string; contentDiff?: string | null; contentError?: string };
    expect(p.content).toBe("# Plan\nDo the thing\n");
    expect(p.contentDiff).toBeNull();
    expect(p.contentError).toBeUndefined();
    expect(calls.some((c) => c.includes("drive.files.export") && c.includes("text/markdown"))).toBe(true);
  });

  it("changed fingerprint emits a unified contentDiff against the cached version", async () => {
    let body = "# Plan\nDo the thing\n";
    const { store, src } = setup(contentRunner(() => body), {
      api: "drive.files.list", itemsPath: "files", fingerprintField: "modifiedTime",
      content: true,
    });
    await src.tick();
    body = "# Plan\nDo the thing better\n";
    // simulate a modifiedTime change → clear the base dedupe so the (new-fingerprint) key re-emits
    const source = store.listSources()[0]!;
    store.setSourceState(source.id, "seenKeys", []);
    expect(await src.tick()).toBe(1);
    const evs = store.listEvents().filter((e) => (e.payload as { contentDiff?: string }).contentDiff);
    const diff = evs[0]!.payload as { contentDiff: string; content: string };
    expect(diff.contentDiff).toContain("-Do the thing");
    expect(diff.contentDiff).toContain("+Do the thing better");
    expect(diff.content).toBe("# Plan\nDo the thing better\n");
  });

  it("does not fetch content for already-seen keys", async () => {
    const calls: string[] = [];
    const { src } = setup(contentRunner("# same", calls), {
      api: "drive.files.list", itemsPath: "files", fingerprintField: "modifiedTime",
      content: { format: "auto" },
    });
    await src.tick();
    calls.length = 0;
    await src.tick();
    expect(calls.filter((c) => c.includes("drive.files.export"))).toHaveLength(0);
  });

  it("export failure degrades to contentError without losing the metadata event", async () => {
    const runner: GoogleApiRunner = async (api) => {
      if (api === "drive.files.export") throw new Error("exportSizeLimitExceeded");
      return { files: [{ id: "sheet1", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-01-01T00:00:00Z" }] };
    };
    const { store, src } = setup(runner, {
      api: "drive.files.list", itemsPath: "files", fingerprintField: "modifiedTime",
      content: true,
    });
    expect(await src.tick()).toBe(1);
    const ev = store.listEvents()[0]!;
    expect(ev.kind).toBe("gws:drive:changed");
    const p = ev.payload as { content: string | null; contentError: string };
    expect(p.content).toBeNull();
    expect(p.contentError).toContain("content export failed");
  });

  it("format override forces the export mime (csv for sheets)", async () => {
    const calls: string[] = [];
    const { src } = setup(contentRunner("a,b\n1,2\n", calls), {
      api: "drive.files.list", itemsPath: "files", fingerprintField: "modifiedTime",
      content: { format: "csv" },
    });
    await src.tick();
    expect(calls.some((c) => c.includes("drive.files.export") && c.includes("text/csv"))).toBe(true);
  });

  it("oversized content is truncated with contentTruncated set", async () => {
    const big = "x".repeat(500 * 1024 + 10);
    const { store, src } = setup(contentRunner(big), {
      api: "drive.files.list", itemsPath: "files", fingerprintField: "modifiedTime",
      content: true,
    });
    await src.tick();
    const p = store.listEvents()[0]!.payload as { content: string; contentTruncated?: boolean };
    expect(p.content.length).toBe(500 * 1024);
    expect(p.contentTruncated).toBe(true);
  });
});

describe("GoogleSource content diff edge cases", () => {
  it("empty baseline still produces a diff on the next version", async () => {
    let body = "";
    const runner: GoogleApiRunner = async (api) => {
      if (api === "drive.files.export") return body as unknown as Record<string, unknown>;
      return { files: [{ ...{ id: "doc1", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-01-01T00:00:00Z" } }] };
    };
    const { store, src } = setup(runner, {
      api: "drive.files.list", itemsPath: "files", fingerprintField: "modifiedTime",
      content: true,
    });
    await src.tick(); // baseline: empty export
    body = "# Now the content arrives\n";
    const source = store.listSources()[0]!;
    store.setSourceState(source.id, "seenKeys", []);
    await src.tick();
    const evs = store.listEvents().filter((e) => (e.payload as { contentDiff?: string }).contentDiff);
    expect(evs.length).toBe(1);
    expect((evs[0]!.payload as { contentDiff: string }).contentDiff).toContain("+# Now the content arrives");
  });
});
