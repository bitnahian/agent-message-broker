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
  kind: string; // e.g. "polled-url", "github", "jira", "gws", "generic-webhook"
  /** kind-specific options (JSON). Holds non-secret config; credentials never live here. */
  options: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
}

/** How a Feed materializes events: SDK polling (baseline, ADR-0006) or webhook push (opt-in, ADR-0007). */
export type Mechanism = "poll" | "webhook";

/**
 * Feed: the durable statement of *what events a source receives* (ADR-0005).
 * Mechanism-agnostic — polling and webhook feeds share the same shape so both
 * emit identical event kinds. One source = one Feed in v1.
 */
export interface FeedConfig {
  /** vendor entity scope, e.g. "owner/repo" for github, JQL/project for jira, resource for google. */
  entityScope: string;
  /** event-type allowlist; empty/missing means "all supported types". */
  eventTypes: string[];
  /** delivery mechanism for this feed. */
  mechanism: Mechanism;
  /** present on webhook feeds: vendor webhook registration (ADR-0007). */
  webhook?: WebhookRegistration;
}

/** A $mechanism-agnostic view of one Source's data contract. */
export interface Feed {
  /** source kind, e.g. "github". */
  kind: string;
  config: FeedConfig;
}

/** Persisted vendor-side webhook registration for a Feed that opted into webhook delivery (ADR-0007). */
export interface WebhookRegistration {
  /** vendor webhook id. */
  id: string;
  /** public delivery URL the vendor POSTs to. */
  url: string;
  /** event types registered with the vendor. */
  eventTypes: string[];
  /** shared secret for verify(). */
  secret: string;
  /** when the registration was (re)issued. */
  createdAt: number;
}

/**
 * Canonical event-type identifier used as the event `kind` prefix, e.g. `github:pull_request`.
 * Recomputed from kind + feed event type everywhere both mechanisms emit.
 */
export type FeedKind = `${string}:${string}`;

/** Canonical event-type key emitted by both mechanisms, e.g. `github:pull_request`. */
export function feedKind(sourceKind: string, eventType: string): FeedKind {
  return `${sourceKind}:${eventType}`;
}

/** Read a source's delivery mechanism, defaulting to "poll" (ADR-0002/0006). */
export function sourceMechanism(source: Pick<EventSourceConfig, "options">): Mechanism {
  const m = (source.options as { mechanism?: string }).mechanism;
  return m === "webhook" ? "webhook" : "poll";
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
  /**
   * Optional liveness probe: false means the session is gone (e.g. the user
   * exited it) and deliveries to it should be skipped, not attempted.
   * Adapters that cannot tell may omit this — the dispatcher then attempts
   * delivery as before.
   */
  isSessionActive?(target: SessionRef): Promise<boolean>;
}

export interface DeliveryResult {
  ok: boolean;
  detail?: string;
}
