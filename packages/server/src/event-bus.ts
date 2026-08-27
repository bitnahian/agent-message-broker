import type { BrokerEvent } from "@amb/core";
import { Dispatcher, type DispatchOutcome } from "./dispatcher.js";
import { SseHub } from "./sse.js";
import { BrokerStore } from "./store.js";

export interface PublishResult {
  event: BrokerEvent;
  sseDelivered: number;
  dispatch: DispatchOutcome;
}

/** Single publish path shared by HTTP route and event sources. */
export class EventBus {
  constructor(
    private store: BrokerStore,
    private hub: SseHub,
    private dispatcher: Dispatcher,
  ) {}

  async publish(input: { topicId: string; sourceId?: string; kind: string; payload: unknown }): Promise<PublishResult | undefined> {
    const event = this.store.publishEvent(input); // retained per topic retainN even with no subscribers
    if (!event) return; // topic was deleted between the request and the write
    const sseDelivered = this.hub.broadcast(event);
    const dispatch = await this.dispatcher.dispatch(event);
    return { event, sseDelivered, dispatch };
  }
}
