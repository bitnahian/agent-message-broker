import { randomUUID } from "node:crypto";
import type {Db} from "./db.js";
import type {
  BrokerEvent,
  EventSourceConfig,
  SessionRef,
  Subscription,
  Topic,
} from "@amb/core";
interface TopicRow { id: string; name: string; retainN: number; createdAt: number }
interface SourceRow { id: string; topicId: string; kind: string; options: string; enabled: number; createdAt: number }
interface SubRow { id: string; topicId: string; agent: string; sessionId: string; label: string | null; template: string | null; enabled: number; createdAt: number }
interface EventRow { id: string; topicId: string; sourceId: string | null; kind: string; payload: string; detectedAt: number }

function withTransaction(db: Db, fn: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  }
}

export class BrokerStore {
  constructor(private db: Db) {}

  createTopic(name: string, retainN = 100): Topic {
    const t: Topic = { id: randomUUID(), name, retainN, createdAt: Date.now() };
    this.db.prepare("INSERT INTO topics(id,name,retainN,createdAt) VALUES(?,?,?,?)")
      .run(t.id, t.name, t.retainN, t.createdAt);
    return t;
  }

  listTopics(): Topic[] {
    return this.db.prepare("SELECT * FROM topics ORDER BY createdAt").all() as unknown as Topic[];
  }

  getTopic(idOrName: string): Topic | undefined {
    return (this.db.prepare("SELECT * FROM topics WHERE id=? OR name=?").get(idOrName, idOrName) ?? undefined) as unknown as Topic | undefined;
  }

  createSource(input: { topicId: string; kind: string; options?: Record<string, unknown> }): EventSourceConfig {
    const s: EventSourceConfig = {
      id: randomUUID(),
      topicId: input.topicId,
      kind: input.kind,
      options: input.options ?? {},
      enabled: true,
      createdAt: Date.now(),
    };
    this.db.prepare("INSERT INTO sources(id,topicId,kind,options,enabled,createdAt) VALUES(?,?,?,?,1,?)")
      .run(s.id, s.topicId, s.kind, JSON.stringify(s.options), s.createdAt);
    return s;
  }

  listSources(): EventSourceConfig[] {
    const rows = this.db.prepare("SELECT * FROM sources ORDER BY createdAt").all() as unknown as SourceRow[];
    return rows.map((r) => ({ ...r, options: JSON.parse(r.options), enabled: r.enabled === 1 }));
  }

  createSubscription(input: { topicId: string; target: SessionRef; template?: string }): Subscription {
    const sub: Subscription = {
      id: randomUUID(),
      topicId: input.topicId,
      target: input.target,
      template: input.template,
      enabled: true,
      createdAt: Date.now(),
    };
    this.db.prepare("INSERT INTO subscriptions(id,topicId,agent,sessionId,label,template,enabled,createdAt) VALUES(?,?,?,?,?,?,1,?)")
      .run(sub.id, sub.topicId, sub.target.agent, sub.target.sessionId, sub.target.label ?? null, sub.template ?? null, sub.createdAt);
    return sub;
  }

  listSubscriptions(topicId?: string): Subscription[] {
    const rows = (topicId
      ? this.db.prepare("SELECT * FROM subscriptions WHERE topicId=? ORDER BY createdAt").all(topicId)
      : this.db.prepare("SELECT * FROM subscriptions ORDER BY createdAt").all()) as unknown as SubRow[];
    return rows.map((r) => ({
      id: r.id, topicId: r.topicId, template: r.template ?? undefined,
      target: { agent: r.agent as SessionRef["agent"], sessionId: r.sessionId, label: r.label ?? undefined },
      enabled: r.enabled === 1, createdAt: r.createdAt,
    }));
  }

  /** Publish an event and enforce per-topic retainN buffer. Returns stored event. Returns undefined if the topic was deleted. */
  publishEvent(input: { topicId: string; sourceId?: string; kind: string; payload: unknown; detectedAt?: number }): BrokerEvent | undefined {
    const ev: BrokerEvent = {
      id: randomUUID(),
      topicId: input.topicId,
      sourceId: input.sourceId ?? "",
      kind: input.kind,
      payload: input.payload,
      detectedAt: input.detectedAt ?? Date.now(),
    };
    const insert = this.db.prepare("INSERT INTO events(id,topicId,sourceId,kind,payload,detectedAt) VALUES(?,?,?,?,?,?)");
    const prune = this.db.prepare(`
      DELETE FROM events WHERE topicId=? AND id NOT IN (
        SELECT id FROM events WHERE topicId=? ORDER BY detectedAt DESC, id DESC LIMIT ?
      )`);
    const pruneDeliveries = this.db.prepare("DELETE FROM deliveries WHERE eventId NOT IN (SELECT id FROM events)");
    try {
      withTransaction(this.db, () => {
        insert.run(ev.id, ev.topicId, ev.sourceId || null, ev.kind, JSON.stringify(ev.payload), ev.detectedAt);
        const topic = this.getTopic(ev.topicId);
        prune.run(ev.topicId, ev.topicId, topic?.retainN ?? 100);
        // delivery attempts for pruned events are dead weight — cascade them
        pruneDeliveries.run();
      });
      return ev;
    } catch (err) {
      // If the topic was cascade-deleted, ignore silently
      if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "ERR_SQLITE_ERROR") {
        const msg = String(err);
        if (msg.includes("FOREIGN KEY") || msg.includes("constraint")) return undefined;
      }
      throw err;
    }
  }

  listEvents(topicId?: string, limit = 100): BrokerEvent[] {
    const rows = (topicId
      ? this.db.prepare("SELECT * FROM events WHERE topicId=? ORDER BY detectedAt DESC LIMIT ?").all(topicId, limit)
      : this.db.prepare("SELECT * FROM events ORDER BY detectedAt DESC LIMIT ?").all(limit)) as unknown as EventRow[];
    return rows.map((r) => ({
      id: r.id, topicId: r.topicId, sourceId: r.sourceId ?? "", kind: r.kind,
      payload: JSON.parse(r.payload), detectedAt: r.detectedAt,
    }));
  }

  /** Delete a topic and its sources, subscriptions, events, and source state. Returns false if missing. */
  deleteTopic(idOrName: string): boolean {
    const topic = this.getTopic(idOrName);
    if (!topic) return false;
    withTransaction(this.db, () => {
      const sourceIds = (this.db.prepare("SELECT id FROM sources WHERE topicId=?").all(topic.id) as { id: string }[]).map((r) => r.id);
      for (const sid of sourceIds) this.db.prepare("DELETE FROM source_state WHERE sourceId=?").run(sid);
      this.db.prepare("DELETE FROM sources WHERE topicId=?").run(topic.id);
      this.db.prepare("DELETE FROM subscriptions WHERE topicId=?").run(topic.id);
      this.db.prepare("DELETE FROM deliveries WHERE eventId IN (SELECT id FROM events WHERE topicId=?)").run(topic.id);
      this.db.prepare("DELETE FROM events WHERE topicId=?").run(topic.id);
      this.db.prepare("DELETE FROM topics WHERE id=?").run(topic.id);
    });
    return true;
  }

  deleteSource(id: string): boolean {
    this.db.prepare("DELETE FROM source_state WHERE sourceId=?").run(id);
    return this.db.prepare("DELETE FROM sources WHERE id=?").run(id).changes > 0;
  }

  deleteSubscription(id: string): boolean {
    return this.db.prepare("DELETE FROM subscriptions WHERE id=?").run(id).changes > 0;
  }

  recordDelivery(eventId: string, subscriptionId: string, ok: boolean, error?: string): void {
    this.db.prepare("INSERT INTO deliveries(eventId,subscriptionId,ok,error,attemptedAt) VALUES(?,?,?,?,?)")
      .run(eventId, subscriptionId, ok ? 1 : 0, error ?? null, Date.now());
  }

  listDeliveries(eventId?: string, limit = 100): { eventId: string; subscriptionId: string; ok: boolean; error?: string; attemptedAt: number }[] {
    const rows = (eventId
      ? this.db.prepare("SELECT * FROM deliveries WHERE eventId=? ORDER BY attemptedAt DESC LIMIT ?").all(eventId, limit)
      : this.db.prepare("SELECT * FROM deliveries ORDER BY attemptedAt DESC LIMIT ?").all(limit)) as unknown as { eventId: string; subscriptionId: string; ok: number; error: string | null; attemptedAt: number }[];
    return rows.map((r) => ({ ...r, ok: r.ok === 1, error: r.error ?? undefined }));
  }

  /**
   * Events in the window with no successful delivery record for ANY enabled sub of their topic.
   * A (event, subscription) pair that already accumulated `maxAttempts` failures is spent —
   * permanently-failing subscriptions stop being re-driven on every boot (BUG-08).
   */
  eventsPendingRetry(sinceMs: number, maxAttempts = 10): { event: BrokerEvent; missingSubs: string[] }[] {
    const events = this.db.prepare("SELECT * FROM events WHERE detectedAt > ? ORDER BY detectedAt").all(sinceMs) as unknown as EventRow[];
    const failedCounts = this.db.prepare("SELECT subscriptionId, count(*) AS n FROM deliveries WHERE eventId=? AND ok=0 GROUP BY subscriptionId");
    const out: { event: BrokerEvent; missingSubs: string[] }[] = [];
    for (const row of events) {
      const subs = this.listSubscriptions(row.topicId).filter((s) => s.enabled);
      if (!subs.length) continue;
      const delivered = new Set(
        (this.db.prepare("SELECT subscriptionId FROM deliveries WHERE eventId=? AND ok=1").all(row.id) as unknown as { subscriptionId: string }[])
          .map((r) => r.subscriptionId));
      const spent = new Set(
        (failedCounts.all(row.id) as unknown as { subscriptionId: string; n: number }[])
          .filter((r) => r.n >= maxAttempts)
          .map((r) => r.subscriptionId));
      const missing = subs.filter((s) => !delivered.has(s.id) && !spent.has(s.id)).map((s) => s.id);
      if (missing.length) {
        out.push({
          event: { id: row.id, topicId: row.topicId, sourceId: row.sourceId ?? "", kind: row.kind, payload: JSON.parse(row.payload), detectedAt: row.detectedAt },
          missingSubs: missing,
        });
      }
    }
    return out;
  }

  getSourceState<T>(sourceId: string, key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM source_state WHERE sourceId=? AND key=?").get(sourceId, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setSourceState(sourceId: string, key: string, value: unknown): void {
    this.db.prepare("INSERT INTO source_state(sourceId,key,value) VALUES(?,?,?) ON CONFLICT(sourceId,key) DO UPDATE SET value=excluded.value")
      .run(sourceId, key, JSON.stringify(value ?? null));
  }

  close(): void { this.db.close(); }
}
