# ADR-0005: Feed Abstraction — Event-Type Awareness Shared by All Mechanisms

**Date:** 2026-08-27
**Status:** accepted

## Context

A source currently describes *an ingest point*: it declares `kind` and a JSON blob of `options`, and `SourceManager` runs a poller that emits events. The semantics of *what* events a source should surface (which event types, which entities) are implicit — the github poller emits every `github:<Type>` it sees; polled-url emits url-change; jira emits every work-item change. There is no first-class notion of "this source wants pull-request events, not push events."

Separately, the evolution we've chosen lets a source receive events via **more than one mechanism** — SDK polling and, optionally, webhook push. Both must agree on *what* to deliver, so the event-selection semantics cannot live inside either mechanism; they belong to a shared layer.

The need also exposes a vocabulary collision: the broker already uses **Subscription** to mean "topic → agent session binding." The vendor-facing idea — "subscribe this feed to pull-request events on repo X" — must not reuse that word.

## Decision

Introduce the **Feed** as a first-class concept, distinct from both a **mechanism** and a **subscription**:

- A **Feed** is the durable statement of *what events a source should receive*: a source kind, the vendor entity scope, and an **event-type allowlist**.
- A Feed is **mechanism-agnostic**: it is delivered by whichever transport the source has configured — SDK polling (default) or webhook push (opt-in). Both share the Feed's event-type filter, so the `kind` of emitted events is identical under either.
- At runtime a Feed materializes whichever transport is configured: a **poller** (poll parity) or a **WebhookRegistration** (webhook — see ADR-0007).
- **Source** keeps its current meaning (persisted ingest point bound to one topic). One Source = one Feed in v1.
- The vendor-facing term is **Feed**, never "Subscription", keeping the existing topic→agent concept uncluttered.

Canonical event `kind` from a Feed is `feedKind:<eventType>` (e.g. `github:pull_request`, `jira:issue_created`, `webhook:issue.created`).

## Consequences

- **Uniform event semantics**: a poller and a webhook feed agree on which events become broker events — no divergence in `kind` naming or filtering.
- **Single filter authority**: the Feed's allowlist is the shared filter; polling and webhook both honor it. Webhook registration mirrors it vendor-side, and the broker keeps a defensive gate broker-side so a misbehaving vendor can't flood a topic.
- **Clean new-vendor path**: adding a vendor = adding a Feed kind + a mechanism implementation, not touching the receiver or the subscription model.
- **Migration**: existing sources (github, jira, gws, polled-url) map onto Feed kinds; their options re-key into Feed (event-type allowlist) + mechanism config.

## Alternatives considered

- **Overload "Subscription"**: rejected — it collides with the existing topic→agent binding; the glossary and code would be ambiguous.
- **Put event-type filtering in the mechanism (poller/webhook)**: rejected — poll and push would drift in behavior and the semantics would be owned in two places.
- **Feed *as* Source**: rejected — keeps two separate concerns (persisted config + runtime status) clean, and lets a Source gain multiple feeds later without a rename.