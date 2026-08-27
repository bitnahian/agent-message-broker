import type { BrokerEvent, DeliveryAdapter, SessionRef } from "@amb/core";
import type { BrokerStore } from "./store.js";

export interface DispatchOutcome {
  eventId: string;
  attempts: number;
  delivered: number;
  failures: { sessionId: string; error: string }[];
}

/** Routes published events to subscriptions via registered delivery adapters. */
export class Dispatcher {
  private adapters = new Map<string, DeliveryAdapter>();

  constructor(private store: BrokerStore) {}

  /** Re-drive subscriptions that lack a successful delivery for the event (outbox reconcile). */
  async reconcile(sinceMs = 60 * 60 * 1000): Promise<number> {
    const pending = this.store.eventsPendingRetry(Date.now() - sinceMs);
    let redriven = 0;
    for (const { event, missingSubs } of pending) {
      const subs = this.store.listSubscriptions(event.topicId).filter((s) => s.enabled && missingSubs.includes(s.id));
      for (const sub of subs) {
        const adapter = this.adapters.get(sub.target.agent);
        if (!adapter) {
          this.store.recordDelivery(event.id, sub.id, false, `no adapter for agent ${sub.target.agent}`);
          continue;
        }
        const message = this.renderTemplate(sub.template, event);
        const res = await adapter.deliver(sub.target, { message, eventId: event.id });
        this.store.recordDelivery(event.id, sub.id, res.ok, res.ok ? undefined : (res.detail ?? "unknown"));
        redriven++;
      }
    }
    return redriven;
  }

  registerAdapter(adapter: DeliveryAdapter): void {
    this.adapters.set(adapter.agent, adapter);
  }

  /** Sessions across all registered adapters; adapter failures are tolerated. */
  async listSessions(): Promise<(SessionRef & { reachable: boolean })[]> {
    const out: (SessionRef & { reachable: boolean })[] = [];
    for (const adapter of this.adapters.values()) {
      try {
        for (const s of await adapter.listSessions()) out.push({ ...s, reachable: true });
      } catch {
        out.push({ agent: adapter.agent, sessionId: "", label: `${adapter.agent}: unreachable`, reachable: false });
      }
    }
    return out;
  }

  renderTemplate(template: string | undefined, event: BrokerEvent): string {
    const payload = JSON.stringify(event.payload, null, 2);
    if (!template) return `[${event.kind}] topic=${event.topicId}\n${payload}`;
    return template.replaceAll("{{kind}}", event.kind).replaceAll("{{payload}}", payload);
  }

  agents(): string[] {
    return [...this.adapters.keys()];
  }

  async dispatch(event: BrokerEvent): Promise<DispatchOutcome> {
    const subs = this.store.listSubscriptions(event.topicId).filter((s) => s.enabled);
    const outcome: DispatchOutcome = { eventId: event.id, attempts: 0, delivered: 0, failures: [] };
    for (const sub of subs) {
      const adapter = this.adapters.get(sub.target.agent);
      outcome.attempts++;
      if (!adapter) {
        const error = `no adapter for agent ${sub.target.agent}`;
        outcome.failures.push({ sessionId: sub.target.sessionId, error });
        this.store.recordDelivery(event.id, sub.id, false, error);
        continue;
      }
      const message = this.renderTemplate(sub.template, event);
      const res = await adapter.deliver(sub.target, { message, eventId: event.id });
      this.store.recordDelivery(event.id, sub.id, res.ok, res.ok ? undefined : (res.detail ?? "unknown"));
      if (res.ok) outcome.delivered++;
      else outcome.failures.push({ sessionId: sub.target.sessionId, error: res.detail ?? "unknown" });
    }
    return outcome;
  }
}
