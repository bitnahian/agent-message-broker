import { describe, expect, it } from "vitest";
import type { BrokerEvent } from "@amb/core";
import { formatSse, SseHub, type SseClient } from "./sse.js";

function client(topicIds: Set<string> | null): SseClient & { received: BrokerEvent[] } {
  const received: BrokerEvent[] = [];
  return { topicIds, received, send: (e) => received.push(e) };
}

const ev = (id: string, topicId: string): BrokerEvent =>
  ({ id, topicId, sourceId: "", kind: "k", payload: {}, detectedAt: 1 });

describe("SseHub", () => {
  it("broadcasts to wildcard clients (topicIds === null) only", () => {
    const hub = new SseHub();
    const all = client(null);
    const t1 = client(new Set(["t1"]));
    const t2 = client(new Set(["t2"]));
    hub.add(all); hub.add(t1); hub.add(t2);

    expect(hub.broadcast(ev("e1", "t1"))).toBe(2); // wildcard + t1
    expect(hub.broadcast(ev("e2", "t3"))).toBe(1); // wildcard only
    expect(all.received.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(t1.received.map((e) => e.id)).toEqual(["e1"]);
    expect(t2.received).toHaveLength(0);
  });

  it("subscriberCount: total, and per-topic including wildcards", () => {
    const hub = new SseHub();
    hub.add(client(null));
    hub.add(client(new Set(["t1"])));
    expect(hub.subscriberCount()).toBe(2);
    expect(hub.subscriberCount("t1")).toBe(2); // wildcard counts for every topic
    expect(hub.subscriberCount("t9")).toBe(1);
  });

  it("remove() drops a client from broadcast", () => {
    const hub = new SseHub();
    const c = client(null);
    hub.add(c);
    hub.remove(c);
    expect(hub.broadcast(ev("e", "t"))).toBe(0);
    expect(hub.subscriberCount()).toBe(0);
  });

  it("formatSse emits id/data framing (unnamed message events)", () => {
    const s = formatSse(ev("id-1", "t"));
    expect(s).toContain("id: id-1\n");
    // named events never dispatch to onmessage; the kind travels in data.kind
    expect(s).not.toContain("event:");
    expect(s).toContain(`data: ${JSON.stringify(ev("id-1", "t"))}\n\n`);
  });
});
