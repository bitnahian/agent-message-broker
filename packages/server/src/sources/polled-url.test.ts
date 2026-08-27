import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { createDb } from "../db.js";
import { BrokerStore } from "../store.js";
import { PolledUrlSource } from "./polled-url.js";
import type { SourceContext } from "./registry.js";

let server: Server;
let baseUrl: string;
let body = "v1";
let status = 200;
let etag: string | null = null;

function setup() {
  const store = new BrokerStore(createDb(":memory:"));
  const app = buildApp({ store });
  return { app, store };
}

function makeCtx(app: ReturnType<typeof buildApp>, store: BrokerStore, topicId: string, sourceId: string, options: Record<string, unknown>): SourceContext {
  return {
    store,
    bus: app.bus,
    config: { id: sourceId, topicId, kind: "polled-url", options, enabled: true, createdAt: Date.now() },
    getState: (k) => store.getSourceState(sourceId, k),
    setState: (k, v) => store.setSourceState(sourceId, k, v),
    emit: async (kind, payload) => { await app.bus.publish({ topicId, sourceId, kind, payload }); },
  };
}

describe("PolledUrlSource", () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (etag && req.headers["if-none-match"] === etag) {
        res.writeHead(304).end();
        return;
      }
      res.writeHead(status, { "content-type": "text/plain", ...(etag ? { etag } : {}) });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/thing`;
  });

  afterAll(() => server.close());

  it("baseline poll emits nothing by default; change emits url-changed once", async () => {
    const { app, store } = setup();
    const topic = store.createTopic("url");
    const source = store.createSource({ topicId: topic.id, kind: "polled-url", options: { url: baseUrl } });
    const ctx = makeCtx(app, store, topic.id, source.id, { url: baseUrl });
    const src = new PolledUrlSource(ctx);

    body = "v1"; status = 200; etag = null;
    expect(await src.tick()).toBe(0); // baseline
    expect(await src.tick()).toBe(0); // unchanged
    body = "v2";
    expect(await src.tick()).toBe(1); // changed
    expect(await src.tick()).toBe(0); // same change not re-emitted

    const events = store.listEvents(topic.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("url-changed");
    expect((events[0]?.payload as { snippet: string }).snippet).toBe("v2");
  });

  it("emitInitial produces url-snapshot on first poll", async () => {
    const { app, store } = setup();
    const topic = store.createTopic("url2");
    const source = store.createSource({ topicId: topic.id, kind: "polled-url" });
    const src = new PolledUrlSource(makeCtx(app, store, topic.id, source.id, { url: baseUrl, emitInitial: true }));
    body = "snap"; status = 200;
    expect(await src.tick()).toBe(1);
    expect(store.listEvents(topic.id)[0]?.kind).toBe("url-snapshot");
  });

  it("uses ETag: 304 means no event", async () => {
    const { app, store } = setup();
    const topic = store.createTopic("url3");
    const source = store.createSource({ topicId: topic.id, kind: "polled-url" });
    const src = new PolledUrlSource(makeCtx(app, store, topic.id, source.id, { url: baseUrl }));
    body = "etagged"; status = 200; etag = '"abc"';
    expect(await src.tick()).toBe(0); // baseline stores etag
    expect(await src.tick()).toBe(0); // 304
    etag = '"def"'; body = "etagged-2";
    expect(await src.tick()).toBe(1); // new etag + new hash
  });

  it("emits deduped url-error on HTTP failure", async () => {
    const { app, store } = setup();
    const topic = store.createTopic("url4");
    const source = store.createSource({ topicId: topic.id, kind: "polled-url" });
    const src = new PolledUrlSource(makeCtx(app, store, topic.id, source.id, { url: baseUrl }));
    status = 500; etag = null;
    expect(await src.tick()).toBe(1);
    expect(await src.tick()).toBe(0); // same error deduped
    expect(store.listEvents(topic.id)[0]?.kind).toBe("url-error");
  });
});
