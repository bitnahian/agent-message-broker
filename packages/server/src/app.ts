import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { BrokerEvent, SessionRef } from "@amb/core";
import { Dispatcher } from "./dispatcher.js";
import { EventBus } from "./event-bus.js";
import { SourceManager, SourceRegistry } from "./sources/registry.js";
import { verifyAndDecode, type GenericWebhookOptions } from "./sources/generic-webhook.js";
import { SseHub, formatSse } from "./sse.js";
import { BrokerStore } from "./store.js";

declare module "fastify" {
  interface FastifyInstance {
    hub: SseHub;
    dispatcher: Dispatcher;
    store: BrokerStore;
    bus: EventBus;
    sourceRegistry: SourceRegistry;
    sourceManager: SourceManager;
  }
}

export interface AppOptions {
  store: BrokerStore;
  /** When set, all routes except /health require `Authorization: Bearer <token>`. */
  token?: string;
  /** Directory of the built UI to serve at / (SPA fallback to index.html). */
  uiDir?: string;
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: !!process.env.BROKER_LOG });
  const { store, token } = opts;
  const hub = new SseHub();
  const dispatcher = new Dispatcher(store);
  const bus = new EventBus(store, hub, dispatcher);
  const registry = new SourceRegistry();
  const sourceManager = new SourceManager(store, bus, registry);

  app.addHook("onRequest", async (req, reply) => {
    if (!token) return;
    // open: GET / (UI entry, sets the SameSite=Strict cookie) and static assets
    const openGet = req.method === "GET" && (req.url === "/" || req.url.startsWith("/assets/") || req.url === "/health");
    if (openGet) { reply.header("set-cookie", `amb_token=${token}; Path=/; HttpOnly; SameSite=Strict`); return; }
    const bakedCookie = (req.headers.cookie ?? "").includes(`amb_token=${token}`);
    const headerOk = req.headers.authorization === `Bearer ${token}`;
    if (!bakedCookie && !headerOk) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", () => ({ ok: true }));

  app.post("/topics", async (req, reply) => {
    const { name, retainN } = (req.body ?? {}) as { name?: string; retainN?: number };
    if (!name) return reply.code(400).send({ error: "name required" });
    try {
      return store.createTopic(name, retainN ?? 100);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint")) {
        return reply.code(409).send({ error: "topic name already exists" });
      }
      throw err;
    }
  });

  app.get("/topics", () => store.listTopics());

  app.delete("/topics/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    // Stop all running sources for this topic before cascade-deleting from DB
    const topic = store.getTopic(id);
    if (topic) {
      const topicSources = store.listSources().filter((s) => s.topicId === topic.id);
      for (const s of topicSources) await sourceManager.stop(s.id);
    }
    if (!store.deleteTopic(id)) return reply.code(404).send({ error: "topic not found" });
    return { deleted: id };
  });

  const KIND_REQUIRED: Record<string, string[]> = {
    "polled-url": ["url"],
    github: [],
    jira: ["jql"],
    google: ["api", "itemsPath"],
  };

  app.post("/sources", async (req, reply) => {
    const b = (req.body ?? {}) as { topicId?: string; kind?: string; options?: Record<string, unknown> };
    if (!b.topicId || !b.kind) return reply.code(400).send({ error: "topicId and kind required" });
    const missing = (KIND_REQUIRED[b.kind] ?? []).filter((k) => !(k in (b.options ?? {})));
    if (missing.length > 0) return reply.code(400).send({ error: `options missing: ${missing.join(", ")}` });
    const topic = store.getTopic(b.topicId);
    if (!topic) return reply.code(404).send({ error: "topic not found" });
    const duplicates = store.listSources().filter((s) =>
      s.topicId === store.getTopic(b.topicId!)!.id && s.kind === b.kind && JSON.stringify(s.options) === JSON.stringify(b.options ?? {}));
    if (duplicates.length > 0) {
      return reply.code(409).send({ error: "identical source already exists (would double-poll)" });
    }
    return store.createSource({ topicId: store.getTopic(b.topicId!)!.id, kind: b.kind!, options: b.options });
  });

  app.get("/sources", () => {
    const sources = store.listSources();
    const statuses = sourceManager.statuses();
    return sources.map((s) => ({ ...s, status: statuses[s.id] ?? "configured" }));
  });

  app.delete("/sources/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await sourceManager.stop(id); // stop if running
    if (!store.deleteSource(id)) return reply.code(404).send({ error: "source not found" });
    return { deleted: id };
  });

  app.post("/subscriptions", async (req, reply) => {
    const b = (req.body ?? {}) as { topicId?: string; target?: SessionRef; template?: string };
    if (!b.topicId || !b.target?.agent || !b.target.sessionId) {
      return reply.code(400).send({ error: "topicId and target {agent,sessionId} required" });
    }
    const topic = store.getTopic(b.topicId);
    if (!topic) return reply.code(404).send({ error: "topic not found" });
    const duplicates = store.listSubscriptions(topic.id).filter((s) =>
      s.target.agent === b.target!.agent && s.target.sessionId === b.target!.sessionId);
    if (duplicates.length > 0) {
      return reply.code(409).send({ error: "subscription already exists for this topic/target" });
    }
    return store.createSubscription({ topicId: topic.id, target: b.target!, template: b.template });
  });

  app.get("/sessions", () => dispatcher.listSessions());

  app.delete("/subscriptions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.deleteSubscription(id)) return reply.code(404).send({ error: "subscription not found" });
    return { deleted: id };
  });

  app.get("/subscriptions", async (req) => {
    const { topicId } = req.query as { topicId?: string };
    return store.listSubscriptions(topicId);
  });

  /** Publish an event: dispatch to subscribers AND retain per topic buffer. */
  app.post("/events", async (req, reply) => {
    const b = (req.body ?? {}) as { topicId?: string; sourceId?: string; kind?: string; payload?: unknown };
    if (!b.topicId || !b.kind) return reply.code(400).send({ error: "topicId and kind required" });
    // resolve id-or-name to the canonical id before publishing (FK constraint is on id)
    const topic = store.getTopic(b.topicId);
    if (!topic) return reply.code(404).send({ error: "topic not found" });
    const result = await bus.publish({ topicId: topic.id, sourceId: b.sourceId, kind: b.kind, payload: b.payload ?? {} });
    if (!result) return reply.code(404).send({ error: "topic not found" });
    return reply.code(202).send({ event: result.event, dispatch: result.dispatch });
  });

  app.get("/events", async (req) => {
    const { topicId, limit } = req.query as { topicId?: string; limit?: string };
    // accept id or name, like every other route
    const topic = topicId ? store.getTopic(topicId) : undefined;
    return store.listEvents(topic ? topic.id : topicId, limit ? Number(limit) : 100);
  });

  /** Hybrid receive path: external webhooks → broker events (when a tunnel URL exists).
    * optional per-source `options.secret` checked via ?secret= or x-broker-secret header. */
  app.post("/webhooks/:sourceId", async (req, reply) => {
    const { sourceId } = req.params as { sourceId: string };
    const source = store.listSources().find((s) => s.id === sourceId);
    if (!source) return reply.code(404).send({ error: "source not found" });
    const secret = (source.options as { secret?: string }).secret;
    const provided = (req.headers["x-broker-secret"] ?? (req.query as { secret?: string }).secret) as string | undefined;
    if (secret && provided !== secret) return reply.code(401).send({ error: "bad secret" });
    const payload = (req.body ?? {}) as Record<string, unknown>;
    let kind = String(payload.kind ?? source.kind ?? "webhook");
    let publishedPayload: unknown = payload;
    // generic-webhook is a first-class feed kind: verify+decode envelope (ADR-0007).
    if (source.kind === "generic-webhook") {
      try {
        const env = verifyAndDecode(source.options as GenericWebhookOptions, payload, provided);
        kind = `webhook:${env.type}`;
        publishedPayload = env;
      } catch (err) {
        const status = (err as { status?: number }).status ?? 400;
        return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    const result = await bus.publish({ topicId: source.topicId, sourceId: source.id, kind, payload: publishedPayload });
    return reply.code(202).send({ event: result?.event ?? null });
  });

  /** SSE stream; `?topicId=` filters; `?replay=1` replays retained buffer first. */
  app.get("/events/stream", async (req, reply) => {
    const { topicId, replay } = req.query as { topicId?: string; replay?: string };
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const topics = topicId ? new Set([topicId]) : null;
    const lastEventId = req.headers["last-event-id"] as string | undefined;
    if (replay === "1") {
      let retained = topics
          ? [...topics].flatMap((t) => store.listEvents(t, 100))
          : store.listEvents(undefined, 100);
      // SSE reconnect sends Last-Event-ID → only replay newer events (avoids duplicates)
      if (lastEventId) {
        const anchor = retained.find((e) => e.id === lastEventId);
        retained = anchor ? retained.slice(0, retained.indexOf(anchor)) : retained;
      }
      for (const ev of retained.reverse()) reply.raw.write(formatSse(ev));
    }
    const client = {
      topicIds: topics,
      send: (ev: BrokerEvent) => reply.raw.write(formatSse(ev)),
    };
    hub.add(client);
    req.raw.on("close", () => hub.remove(client));
    return reply;
  });

  app.post("/sources/:id/start", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await sourceManager.start(id);
      return { started: id };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/sources/:id/stop", async (req) => {
    const { id } = req.params as { id: string };
    await sourceManager.stop(id);
    return { stopped: id };
  });

  app.get("/sources/running", () => ({ running: sourceManager.runningIds(), kinds: registry.kinds() }));
  app.get("/agents", () => ({ agents: dispatcher.agents() }));
  app.get("/deliveries", async (req) => {
    const { eventId } = req.query as { eventId?: string };
    return store.listDeliveries(eventId);
  });

  if (opts.uiDir && existsSync(opts.uiDir)) {
    app.register(fastifyStatic, { root: opts.uiDir, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/events") && !req.url.startsWith("/topics")
        && !req.url.startsWith("/sources") && !req.url.startsWith("/subscriptions")
        && !req.url.startsWith("/sessions") && !req.url.startsWith("/agents") && !req.url.startsWith("/health")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  app.decorate("hub", hub);
  app.decorate("dispatcher", dispatcher);
  app.decorate("store", store);
  app.decorate("bus", bus);
  app.decorate("sourceRegistry", registry);
  app.decorate("sourceManager", sourceManager);
  return app;
}
