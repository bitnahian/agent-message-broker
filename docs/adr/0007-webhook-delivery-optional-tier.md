# ADR-0007: Webhook Delivery as an Optional, Opt-in Tier — Tunnels as Swappable Plugins

**Date:** 2026-08-27
**Status:** accepted

## Context

ADR-0002 chose **poll-first** and rejected webhook-first, largely because inbound webhooks force a reverse tunnel and an unreliable public surface. That decision remains correct for the *default*. But some feeds genuinely benefit from low-latency push (e.g. GitHub pull-request activity), and a user who already runs a tunnel should be able to flip a source to push without changing its event semantics.

So webhook delivery should not displace the default; it should be a **per-feed opt-in tier** that reuses the receiver path the broker already has (`POST /webhooks/:sourceId`, ADR-0002's escape hatch).

## Decision

### Webhook is a per-source opt-in mechanism

- A Feed is delivered by **SDK polling by default** (ADR-0005/0006). If the source sets a `webhook: { enabled: true }` and has a reachable tunnel, the Feed registers a **WebhookRegistration** on the vendor and receives push events.
- A Feed's event-type allowlist (ADR-0005) is shared: webhook registration mirrors it vendor-side, and the broker keeps a defensive broker-side gate so an over-broad vendor can't flood a topic.
- Both mechanisms emit identical event `kind`s; switching a feed from poll to push (or back) does not change downstream subscriptions.

### Receiver is a thin, vendor-agnostic intake

`POST /webhooks/:sourceId` stays a thin intake. Each Feed carries vendor-specific `verify()` + `decode()`:

- **verify()** — checks the inbound signature using the feed's shared secret (github `X-Hub-Signature-256`, jira HMAC-SHA256, or a generic `x-webhook-secret`).
- **decode()** — parses the vendor envelope to `{ eventType, payload }`, mapped to `feedKind:<eventType>`.

An **ack-on-durable-persist** semantics: the receiver returns a `2xx` as soon as the event is persisted (before dispatch), and dispatch proceeds asynchronously — so vendor retries (which fire on non-2xx) don't cause duplicate events. Outbox reconciliation still covers skipped/failed dispatch.

### Tunnels are a swappable plugin

Tunneling is abstracted behind a **tunnel-provider plugin** so providers are hot-swappable at runtime (no restart):

- A provider implements: `open({ localUrl }) → { publicUrl, close() }`.
- **Default provider = smee** (`smee.io`, or a self-hosted smee): the broker keeps `127.0.0.1` closed — it makes an *outbound* WebSocket to smee, and smee POSTs to a public URL that the vendor webhooks point at. No inbound port, no account/token.
- Alternative providers (e.g. `untun`/Cloudflare Quick Tunnels, ngrok) can be registered as plugins and swapped in per-operation or globally.

### The broker owns the public URL lifecycle

- One **shared broker-level tunnel URL** (not per-source): inbound routes by path to `/webhooks/:sourceId`.
- When a provider's public URL changes (ephemeral URL recycled, or a hot-swap), the broker **auto re-registers** the new URL with every active vendor WebhookRegistration.

### Security

- **Verify by default**: shared-secret signature verification is on for every feed; a feed refuses to turn it off unless it explicitly allows unverified (local smee-only dev).
- Failed verification → `401`/`403`, logged, **no event published, no dispatch**.

## Consequences

- **Polling stays the safe default**; push is a clearly-marked opt-in that never breaks the feed's event model.
- **Keeps the inbound surface minimal**: default provider is outbound-only (smee); inbound tunneling is an explicit alternative choice.
- **The receiver is reused**, not multiplied: one `/webhooks/:sourceId` intake, many feed decoders.
- **At-most-fidelity loss**: ack-on-persist + async dispatch + reconciliation keeps webhook events durable without vendor-visible retry loops.

## Alternatives considered

- **Webhook-primary, polling-deleted**: reversed earlier at the user's direction because polling is simpler and safer for a local-first broker; webhooks stayed as an option, not the baseline.
- **Single inbound tunnel default**: rejected — exposes a public inbound surface by default and breaks the local-first claim.
- **Per-source tunnels**: rejected — one shared broker tunnel URL routed by path is cheaper and fewer moving parts.