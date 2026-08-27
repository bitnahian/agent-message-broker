# Domain Glossary

A shared vocabulary for the agent-message-broker: a local-first pub/sub broker that routes external events into running coding-agent sessions.

## Core Terms

**Topic**:
A named event stream that acts as a channel between sources and subscribers. Each topic retains a configurable number of recent events (`retainN`) so late or offline subscribers can replay history.
_Avoid_: Channel, queue

**Source** (EventSource):
A configurable ingest point that receives events from an external system and publishes them into a topic. Every source declares a `kind` that determines the specific integration strategy (e.g. GitHub, Jira, Google, generic webhook) and carries kind-specific options encoded as a JSON blob. Each Source owns one Feed in v1.
_Avoid_: Ingestor, connector, provider

**Feed**:
The durable statement of *what events a source receives*: a source kind, the vendor entity scope, and an event-type allowlist. A Feed is mechanism-agnostic — it is delivered by SDK polling (default) or webhook push (opt-in) without changing its event contract. Never called a Subscription (see Subscription).
_Avoid_: Source-sink, event filter (when referring to the whole concept), vendor subscription

**FeedCursor**:
A Feed's typed, persisted position within a vendor (a page token, an `updated` timestamp, an event id) that makes each poll incremental rather than recomputing from scratch. Stored in the source's per-source persisted state, never in the event payload.
_Avoid_: Offset, watermark, bookmark

**Mechanism**:
The transport by which a Feed is delivered — **poll** (SDK-based, the default) or **webhook** (opt-in push). A mechanism is configuration on a Source, not a separate data model; it never changes the Feed's emitted event `kind`s.
_Avoid_: Mode, transport strategy (imprecise), delivery type (already used elsewhere)

**Subscription**:
A binding between a topic and a specific agent session. An optional `template` string with `{{kind}}` and `{{payload}}` placeholders controls how the raw event is rendered into a human-readable message before delivery.
_Avoid_: Rule, binding, hook

**SessionRef**:
A lightweight identifier triples a target agent session: the agent kind, a session id, and an optional human-readable label. It is the value the broker passes through to delivery adapters and the key the UI uses to surface connected sessions.
_Avoid_: Target, endpoint, destination

**DeliveryAdapter**:
The uniform contract every agent kind must fulfill. It exposes `listSessions()` to discover running sessions and `deliver(target, payload)` to push a rendered message into one, returning a `DeliveryResult` with an `ok` flag and optional detail without ever throwing.
_Avoid_: Transport, writer, sink

**AgentKind**:
The enumerated set of coding-agent runtimes the broker can deliver to: `pi`, `claude`, and `codex`. Each kind maps to its own adapter implementation that conforms to the DeliveryAdapter interface.
_Avoid_: Provider, platform, runtime

**BrokerEvent**:
A normalized, immutable event record flowing through the broker. Every event carries a unique id, topic, source, kind label, an opaque payload (the broker never inspects it), and a detection timestamp.
_Avoid_: Message, envelope, record

**EventBus**:
The single publish path through which every event enters the broker. On `publish()`, it atomically persists the event for retention, fans it out to live SSE clients, and dispatches it to matching subscriptions through their registered delivery adapters.
_Avoid_: Pipeline, pub-sub engine, router

**Dispatcher**:
The component that matches published events to topic subscriptions, renders each subscription's template (substituting `{{kind}}` and `{{payload}}`), calls the appropriate delivery adapter, and records every delivery attempt. It also powers reconciliation by re-driving events whose delivery records are missing.
_Avoid_: Router, forwarder, notifier

**Retention (retainN)**:
The per-topic ceiling on stored event history. The store prunes events beyond `retainN` (oldest first) on each publish, keeping a bounded rolling buffer. Events persist whether or not any subscription exists, so newly created subscriptions can replay the window.
_Avoid_: Buffer size, TTL, history limit

## Delivery

**Delivery Frame**:
The final rendered message an adapter pushes into an agent's runtime socket. For pi, it is a content block in the intercom protocol. For claude, a newline-delimited JSON frame on the inbox socket. For codex, a text block in the app-server JSON-RPC input stream.
_Avoid_: Envelope, packet, inbox item

**Steering**:
Inline injection into an agent's active turn. When codex has a turn already running, the adapter uses `turn/steer` (instead of starting a new turn) to push the message into the live conversation stream without interrupting the agent's current work.
_Avoid_: Injection, mid-turn delivery, interruption

**Reconciliation**:
The dispatcher's startup recovery pass. It scans recent events for any that lack a successful delivery record for one or more enabled subscriptions, then re-drives those events through the matching adapter — effectively replaying the outbox gap.
_Avoid_: Recovery, replay, catch-up

## Observability

**SSE Hub**:
An in-memory fan-out that broadcasts events to connected browser clients over Server-Sent Events. It supports optional `?replay=1` buffer replay for late-connecting clients and `Last-Event-ID` deduplication to prevent duplicate delivery on reconnect.
_Avoid_: Event stream, live feed, notification channel

## Sources

**SourceRegistry / SourceManager**:
The plugin system for event sources. The Registry holds factories keyed by source `kind`; the Manager starts and stops running feed instances and provides each with a `SourceContext` — handle on the store, event bus, feed config, per-source persisted state, and an `emit()` helper.
_Avoid_: Plugin loader, source controller

**WebhookRegistration**:
The concrete vendor-side cursor a Webhook **Feed** materializes when it opts into webhook delivery. It captures which vendor webhook is registered (its URL, event types, and secret) so the broker can re-register when the public URL changes and surface delivery health.
_Avoid_: Webhook, endpoint (when referring to the registration object), hook

**Webhook (receiver path)**:
An inbound HTTP endpoint at `POST /webhooks/:sourceId` that accepts events from external services. The receiver is a thin, vendor-agnostic intake: each feed carries `verify()` (shared-secret signature check) and `decode()` (vendor envelope → `{eventType, payload}`). Verification is on by default; a failed check returns `401`/`403` and no event is published. A dangerous, off-by-default `verify:false` exists only for local smee-only dev.
_Avoid_: Inbound hook, callback URL (unspecific), receiver endpoint

**TunnelProvider**:
A swappable plugin that turns a local receiver into a reachable public URL so vendor webhooks can POST in. The default **smee** provider keeps `127.0.0.1` closed (outbound WebSocket to a relay); alternative providers (untun/Cloudflare, ngrok) may open a true inbound public surface. Providers are hot-swappable at runtime.
_Avoid_: Tunnel, relay, proxy (when meaning the plugin contract)

**Credentials (config-first)**:
SDK pollers read vendor credentials from `~/.amb/<kind>/credentials.json` (mode 0600) — github `{token}`, jira `{email,apiToken,domain}`, google `{clientEmail,privateKey,projectId}`. Credentials are never stored in the broker DB; `Source.options` holds non-secret config only (entity scope, event-type allowlist, mechanism). `amb config init` scaffolds templates.
_Avoid_: env-var-only creds, inline secrets in `Source.options`

## Auth

**Bearer Token**:
The broker's single authentication mechanism. It binds exclusively to `127.0.0.1`. The CLI passes it as an `Authorization: Bearer <token>` header; the local web UI writes it into an HttpOnly, SameSite=Strict cookie on first visit so subsequent requests are transparently authenticated.
_Avoid_: API key, session token, JWT