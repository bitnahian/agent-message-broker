# ADR-0004: SQLite with WAL for Event Retention

**Date:** 2025-08-20  
**Status:** accepted

## Context

The broker must persist events so that:

- Late or offline subscribers can replay the most recent `retainN` events per topic.
- The SSE `/events/stream?replay=1` path can push the retained buffer on connect.
- Delivery attempts are recorded for the reconciliation outbox pattern.
- Sources can persist per-source state (ETags, cursors, last-seen timestamps) across restarts.

The alternatives were:

- **In-memory ring buffer**: simplest, but events are lost on restart. A developer restarting the broker or their machine would lose all buffered events and source state — breaking the "events persist even with zero subscribers" guarantee.
- **External queue (Redis, NATS)**: durable and scalable, but requires installing and running a separate service. The broker's target audience is a single developer on a laptop; adding a Redis dependency defeats the "zero-config local dev" promise.
- **Flat files (one JSONL per topic)**: durable without a server process, but per-event pruning (`retainN`) requires rewriting the entire file, and concurrent writes from pollers + HTTP routes + SSE need locking.

SQLite — specifically Node.js's built-in `node:sqlite` (DatabaseSync) — is the only option that is durable, embeddable, requires no separate process, and supports concurrent reads with atomic writes.

## Decision

Use SQLite with WAL mode (`PRAGMA journal_mode = WAL`) as the sole persistence layer. The database file lives at `./broker.db` by default (configurable via `BROKER_DB`), or `:memory:` for tests.

The schema is six tables:

- `topics` — id, name, retainN, createdAt
- `sources` — id, topicId, kind, options (JSON text), enabled, createdAt
- `subscriptions` — id, topicId, agent, sessionId, label, template, enabled, createdAt
- `events` — id, topicId, sourceId, kind, payload (JSON text), detectedAt, with an index on `(topicId, detectedAt)`
- `source_state` — sourceId, key, value (JSON text), with a composite PK on `(sourceId, key)`
- `deliveries` — eventId, subscriptionId, ok, error, attemptedAt

The `BrokerStore` wraps all queries. No ORM, no query builder — just prepared statements with `node:sqlite`'s synchronous API.

Transactions use `BEGIN IMMEDIATE` to serialize writes without blocking reads (WAL readers don't wait for writers). The `publishEvent` method wraps the INSERT + prune in a single transaction so the buffer never exceeds `retainN` from a reader's perspective.

## Consequences

- **Zero external dependencies**: SQLite ships in Node.js 22+. No install, no config, no daemon.
- **Durable across restarts**: events and source state survive server restart and machine reboot.
- **Single-writer**: SQLite serializes writes. Under the broker's expected load (pollers on 60s+ intervals, occasional API calls), this is not a bottleneck. If it ever becomes one, the WAL mode already separates readers from the single writer.
- **No migrations framework**: the schema is created via `CREATE TABLE IF NOT EXISTS` on every start. Schema changes are additive (new columns, new tables) and backward-compatible by design.
- **File-based backup**: the database is a single file. The user can copy `broker.db` to back up all state.
- **`:memory:` for tests**: every test creates a fresh in-memory database, so tests are isolated and fast.

## Alternatives considered

- **better-sqlite3**: the established Node.js SQLite binding. Rejected in favor of `node:sqlite` (DatabaseSync) because the latter ships in Node.js 22+ with zero native compilation — the broker's `npm install` already has no native deps, and adding a native binding would break that.
- **Drizzle / Kysely**: typed query builders. Rejected because the schema is six tables with straightforward queries; the added abstraction buys nothing and the types would need to mirror the `@amb/core` types anyway.
- **PostgreSQL**: the standard choice for server applications. Rejected because requiring a running Postgres instance violates the "zero-config local dev" constraint.