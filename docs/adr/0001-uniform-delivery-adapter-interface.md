# ADR-0001: Uniform DeliveryAdapter Interface

**Date:** 2025-08-20  
**Status:** accepted

## Context

The broker pushes events into three different coding agents: pi, Claude Code, and Codex. Each has a fundamentally different live-delivery mechanism:

- **pi** speaks an intercom broker protocol over a unix socket, registering as a synthetic session and issuing `send` commands.
- **Claude Code** accepts cross-session messages posted to an inbox unix socket as newline-delimited JSON frames.
- **Codex** exposes a JSON-RPC daemon (`codex app-server proxy`) requiring thread-resume then turn-steer or turn-start.

Without a shared abstraction, the dispatcher would need per-agent branching: a switch on `agent` in every code path, duplicated session-listing logic, and no way to add a fourth agent without touching the dispatch core.

## Decision

Define one interface — `DeliveryAdapter` — with exactly two methods:

```ts
interface DeliveryAdapter {
  readonly agent: AgentKind;
  listSessions(): Promise<SessionRef[]>;
  deliver(target: SessionRef, payload: { message: string; eventId: string }): Promise<DeliveryResult>;
}
```

Every agent kind implements this interface. The `Dispatcher` holds a `Map<AgentKind, DeliveryAdapter>` and iterates by agent, never by kind-specific code. `deliver()` must never throw — it returns `{ ok: boolean, detail?: string }` so one adapter's failure doesn't skip other subscribers.

`AgentKind` is a string union (`"pi" | "claude" | "codex"`), deliberately not an enum — adding a fourth agent means importing its adapter class and appending one literal, with no shared library rebuild.

## Consequences

- **Adds an agent**: implement the interface, register on the dispatcher, append to `AgentKind`. Zero dispatcher changes.
- **No streaming**: the interface is push-only. The broker fires and forgets; the adapter owns the transport lifecycle (connect, send, disconnect).
- **Sessions are opaque**: `listSessions()` returns `SessionRef[]` with no adapter-specific fields. The UI and CLI see one flat list regardless of which agent produced which entry.
- **No shared state**: each adapter owns its socket/client lifecycle independently. The server start up registers all three but never coordinates them.

## Alternatives considered

- **EventEmitter per agent**: a callback-style registry where the dispatcher emits `"event"` and each adapter subscribes. Rejected because callbacks hide the correlation between event delivery and result, making the outbox reconciliation pattern impossible.
- **One adapter method with a `method` string**: `call(method, ...args)`. Rejected because it pushes type-safety to runtime and eliminates the interface as documentation.