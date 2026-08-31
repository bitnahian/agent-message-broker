import type { BrokerEvent } from "@amb/core";

export interface SseClient {
  topicIds: Set<string> | null; // null = all topics
  send(event: BrokerEvent): void;
}

/** In-memory hub for live SSE subscribers. Buffer replay handles late subscribers. */
export class SseHub {
  private clients = new Set<SseClient>();

  add(client: SseClient): void { this.clients.add(client); }
  remove(client: SseClient): void { this.clients.delete(client); }

  subscriberCount(topicId?: string): number {
    if (!topicId) return this.clients.size;
    let n = 0;
    for (const c of this.clients) if (c.topicIds === null || c.topicIds.has(topicId)) n++;
    return n;
  }

  broadcast(event: BrokerEvent): number {
    let delivered = 0;
    for (const c of this.clients) {
      if (c.topicIds === null || c.topicIds.has(event.topicId)) {
        c.send(event);
        delivered++;
      }
    }
    return delivered;
  }
}

/**
 * Frame an event as a default (unnamed) SSE message. The `event:` line is
 * deliberately omitted: named events don't dispatch to `onmessage`, which is
 * what the UI live feed (and the Last-Event-ID replay) listens on. The kind
 * rides in the JSON payload as `kind`.
 */
export function formatSse(event: BrokerEvent): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}
