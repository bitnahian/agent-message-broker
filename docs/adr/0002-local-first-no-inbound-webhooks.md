# ADR-0002: Local-First, No Inbound Webhooks (Hybrid Escape Hatch)

**Date:** 2025-08-20
**Status:** accepted — extended by [ADR-0007](0007-webhook-delivery-optional-tier.md), which allows webhook delivery as an *opt-in* per-source tier (with a swappable tunnel-provider plugin) while keeping polling as the default. ADR-0002's poll-first default remains canonical.

## Context

The broker runs as a development-time tool on a developer's machine. It discovers and pushes into agent sessions that live on the same host. The natural reflex is to also accept inbound webhooks — GitHub push events, Jira issue updates — so event sources can push rather than being polled. But:

- The broker binds `127.0.0.1` only. Receiving an external POST requires a reverse tunnel (ngrok, Cloudflare Tunnel), and that tunnel introduces latency, configuration drift, and a dependency the broker doesn't control.
- Webhook delivery (at-least-once from the provider's perspective) forces a queuing/reliability layer the broker's SQLite retention buffer isn't designed to provide.
- The three poller kinds (polled-url, github, jira, gws) already cover the same data with simpler operational surface: start the broker, sources self-configure, no tunnel needed.

## Decision

The broker is **poll-first**. All built-in sources are pollers: they run on an interval via `setInterval`, check for changes via ETag/sha256 (polled-url) or API cursors (github, jira, gws), and emit events only when something changed. No webhook listener, no ngrok integration, no inbound-path docs in the README quickstart.

However, a **hybrid escape hatch** exists: `POST /webhooks/:sourceId`. Each source config can carry an optional `secret`. When a tunnel is already set up by the user (outside the broker's scope), this endpoint accepts POSTs and publishes them as broker events. It doesn't start a tunnel, doesn't document tunnel setup, and doesn't promise delivery guarantees. It's a convenience for users who already have a tunnel.

## Consequences

- **Zero-config local dev**: start the server, start sources, events flow. No tunnel, no public URL, no DNS.
- **Polling is eventual**: the minimum interval is controlled per source kind (default 60s for polled-url), so event latency is bounded by the poll interval. Acceptable for development steering use cases.
- **Webhook path is best-effort**: no retry, no ack, no queue. If the tunnel is down, the POST fails.
- **No fan-out webhook**: webhooks arrive at one `sourceId` only; the broker doesn't broadcast a single webhook to multiple topics.

## Alternatives considered

- **Webhook-first with polling fallback**: complications from deduplication between polled and pushed deliveries, and from the need to run a tunnel before any event flows. Rejected as premature complexity for a local dev tool.
- **No webhook path at all**: rejected because some users already run tunnels for other reasons, and wiring a GitHub webhook to a tunnel URL that already exists is low-effort for them.