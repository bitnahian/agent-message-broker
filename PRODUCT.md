# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A developer on their own machine, running coding-agent sessions (pi, Claude Code, Codex) locally. They reach for the broker when they want external events to steer their agents reactively — without setting up per-agent background scripts or reconfiguring event sources for each agent. The user is hands-on, knows their command line, and expects zero-config local dev.

## Product Purpose

The agent-message-broker subscribes running coding-agent sessions to event topics so external events reach the agent as steerable messages. It replaces per-agent polling scripts with one broker that discovers live sessions, routes events through a uniform delivery interface, and persists events for late subscribers.

Success means a developer opens the web UI, creates a topic, connects an event source, clicks their running agent session, and events flow — without reading documentation.

## Positioning

**Cross-agent, one subscription surface.** pi, Claude Code, and Codex each have different live-delivery mechanisms (unix socket broker protocol, inbox socket, JSON-RPC daemon). The broker's `DeliveryAdapter` interface makes them uniform: subscribe once per topic, and every matching agent session receives the event. The developer switches between agents without reconfiguring sources.

**Direct delivery product surface.** The web UI and CLI are first-class product interfaces, not afterthoughts. The UI gives developers an intuitive, unified dashboard to observe event signals flowing into agent subscriptions. The CLI lets agents and scripts subscribe to popular event sources programmatically.

**Reliable local broker.** Events are persisted in SQLite with per-topic retention buffers. Delivery is tracked and reconciled — if an agent session isn't running when an event fires, the broker re-drives it when the adapter appears. The system runs on `127.0.0.1` with bearer-token auth: no cloud dependency, no tunnel, no three-service install.

## Operating Context

A developer's laptop or workstation. The broker server binds `127.0.0.1:4733` and tolerates being restarted. Agent sessions (pi, claude, codex) come and go throughout the day. Event sources poll on configurable intervals (60s+ default). The CLI is invoked by the developer directly or by agent sessions as part of automated workflows.

## Capabilities and Constraints

- **Event sources**: polled URLs, GitHub repo events, Jira work items, Google Workspace (Gmail, Drive, Calendar). All are poll-based; no inbound webhook dependency.
- **Retention**: per-topic `retainN` buffer (SQLite with WAL). Events persist even with zero subscribers.
- **Delivery**: live push into running agent sessions via adapters (never headless-resume). Delivery attempts are recorded; reconciliation re-drives missed deliveries.
- **Template rendering**: subscriptions support `{{kind}}` and `{{payload}}` template placeholders.
- **SSE live feed**: browser clients receive events in real time with replay and `Last-Event-ID` deduplication.
- **Auth**: bearer token (auto-generated) + HttpOnly SameSite cookie for UI.
- **Monorepo**: npm workspaces + nx, 7 packages (core, server, cli, ui, adapter-pi, adapter-claude, adapter-codex).
- Undecided: visual design system, logo, color palette, typography.

## Brand Commitments

- **Name**: agent-message-broker (CLI binary: `amb`)
- **Logo**: not yet designed
- **API contract**: the `@amb/core` types (`DeliveryAdapter`, `SessionRef`, `Subscription`, `Topic`, `BrokerEvent`, `AgentKind`) plus the REST API routes (`/topics`, `/sources`, `/subscriptions`, `/events`, `/sessions`, `/agents`, `/health`) are the public surface. Breaking changes must preserve backward compatibility or bump a version.
- **Security boundary**: binds `127.0.0.1` only. Bearer token (`Authorization` header or `amb_token` cookie). The token is auto-generated at `~/.config/agent-message-broker/token` with mode 0600.

## Evidence on Hand

- Working server, CLI, and UI. `npm run start` serves the full product at `http://127.0.0.1:4733`.
- Automated e2e tests for the pi adapter and the server API. Claude and Codex delivery have manual verification scripts.
- Existing `CONTEXT.md` domain glossary (17 terms).
- Architectural Decision Records in `docs/adr/`: uniform DeliveryAdapter (0001), local-first no-webhooks (0002), live push not headless-resume (0003), SQLite+WAL (0004).
- No logo, no visual identity, no design system.

## Product Principles

1. **Zero-config local dev.** Start the server, create a topic, connect a source — events flow. No cloud, no tunnel, no service dependency beyond the agent tools already installed.
2. **One subscription, every agent.** The uniform adapter interface means cross-agent is not a feature — it's the architecture.
3. **Events are persistent, delivery is accountable.** Retention means late subscribers never miss the window. Reconciliation means failed deliveries aren't silently dropped.
4. **API-first, everything consumes it.** The CLI and UI are consumers of the same REST API. No backdoor, no privileged path.
5. **Developer ergonomics over enterprise scale.** Choices like SQLite (not Postgres), local-only binding (not multi-tenant), and poll-first (not webhooks) serve one developer on one machine well.

## Accessibility & Inclusion

No product-specific accessibility requirements established beyond standard web a11y for the UI surface. The CLI is text-only and inherits terminal accessibility.