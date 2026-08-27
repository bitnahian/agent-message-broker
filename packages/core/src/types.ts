/** Agent kinds we can deliver events to. Extensible. */
export type AgentKind = "pi" | "claude" | "codex";

/** Reference to a specific agent session targeted by a subscription. */
export interface SessionRef {
  agent: AgentKind;
  sessionId: string;
  /** Optional human-friendly alias shown in UI */
  label?: string;
}

/** A named stream of events. Sources publish into topics. */
export interface Topic {
  id: string;
  name: string;
  /** Max events retained for replay to late/offline subscribers. Default 100. */
  retainN: number;
  createdAt: number;
}

/** Configuration for a single event source instance bound to a topic. */
export interface EventSourceConfig {
  id: string;
  topicId: string;
  kind: string; // e.g. "polled-url", "github", "jira", "gws"
  /** kind-specific options (JSON) */
  options: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
}

/** A subscription wires a topic to a target agent session. */
export interface Subscription {
  id: string;
  topicId: string;
  target: SessionRef;
  /** Template rendered with the event payload before delivery. */
  template?: string;
  enabled: boolean;
  createdAt: number;
}

/** A normalized event flowing through the broker. */
export interface BrokerEvent {
  id: string;
  topicId: string;
  sourceId: string;
  kind: string;
  /** opaque payload produced by the source */
  payload: unknown;
  detectedAt: number;
}

/** Uniform delivery adapter interface — one architecture for all agents. */
export interface DeliveryAdapter {
  readonly agent: AgentKind;
  /** List currently reachable sessions for this agent. */
  listSessions(): Promise<SessionRef[]>;
  /** Push a rendered payload into a session. */
  deliver(target: SessionRef, payload: { message: string; eventId: string }): Promise<DeliveryResult>;
}

export interface DeliveryResult {
  ok: boolean;
  detail?: string;
}
