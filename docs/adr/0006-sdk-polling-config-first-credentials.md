# ADR-0006: SDK-Based Polling With Config-First Credentials

**Date:** 2026-08-27
**Status:** accepted

## Context

Sources today poll by **asynchronously exec'ing a CLI binary** — `gh api`, `acli jira`, `gws` — for each item. This is poor design:

- **Binary coupling**: the broker shells out to unversioned CLIs (`gh`, `acli`, `gws`), each with its own auth ceremonies and output format; a missing/aged binary silently degrades into `:error` events.
- **No cursors**: dedupe is a content hash or a simple updated-timestamp compare; no typed cursors or page tokens, so pagination and high-volume feeds are lossy or duplicative.
- **No event-type awareness**: the poller and the (future) webhook mechanism would drift because neither shares an explicit allowlist (see ADR-0005).

We've decided polling remains the **baseline** mechanism (ADR-0002 stays canonical: local-first, no inbound dependency), but it must be rebuilt on proper client SDKs the same way agents use typed adapters.

## Decision

- **Polling is SDK-based.** Each vendor poller speaks its official Node SDK / REST resource library:
  - github → `octokit` (rest), event-type-aware queries
  - jira → Atlassian REST via a small typed client (email + API token)
  - google → `googleapis` (Gmail/Drive/Calendar resources)
  - generic-webhook → no outbound polling (it's inbound; ADR-0007)
- **No more `child_process` exec of `gh`/`acli`/`gws`** in the source layer. (The adapter layer may still spawn *agents*, but source ingest no longer shells to vendor CLIs.)
- **Feed-aware**: each SDK poll returns candidate events annotated with a feed event type; the Feed's allowlist (ADR-0005) decides what to emit, and the SDK keeps a typed cursor in the per-source persisted state (`SourceContext.setState`).

## Credentials: config-first, credentials-only

Credentials are **never in the broker DB** (`Source.options` stays secret-free — repo, event types, filters only) and **never in bare env vars stretched across the whole broker**. Instead, each vendor SDK reads its auth from a **config directory** under the broker's config home, following the convention of `~/.gcloud`, `~/.aws`:

```
~/.amb/
  token                      # existing broker bearer-token file (kept)
  <kind>/
    credentials.json         # e.g. ~/.amb/github/credentials.json
```

Per-kind credential shape:

- `github/credentials.json` → `{ "auth": { "type": "token", "token": "<PAT>" } }`
- `jira/credentials.json` → `{ "domain": "your.atlassian.net", "email": "...", "apiToken": "..." }`
- `google/credentials.json` → google-auth service-account fields (`clientEmail`, `privateKey`, `projectId`, `scopes`) or a service-account JSON path

The broker resolves a feed's credentials by kind from `~/.amb/<kind>/credentials.json`. On `start()` a feed **preflights** auth and **fails fast and loud** if the config is missing, malformed, or unauthorized — one clear status in the UI, not a stream of `:error` events.

## Consequences

- **Typed, robust integration**: SDKs own auth, pagination, and rate limits; cursor-based dedupe replaces hash-string hacks.
- **Secret hygiene**: DB and event payloads never carry credentials; UI/API only ever read/write non-secret feed options.
- **Local-first stays**: no tunnel, no inbound surface needed for the default path.
- **Explicit auth states**: a feed can be `configured`, `auth-pending`, `auth-failed`, `running`, `stopped`, `errored` — surfaced in the UI.
- **Removes the CLI-exec pollers**: `github`/`jira`/`gws` are re-authored over SDKs; behavior tests are ported to SDK-day harnesses (fake transport), not skipped.

## Alternatives considered

- **Env-var injection** (`GITHUB_TOKEN`, `JIRA_TOKEN`): rejected as the *primary* mechanism — it scatters secrets across process env and is hostile to per-feed override; a config dir is conventional and explicit.
- **Secrets in `Source.options`**: rejected — credentials would be replicated into every source row and into backtraces/events; the DB should remain roll-able and secret-free.
- **Keep CLI exec**: rejected — the original poor-design trigger for this entire rework.