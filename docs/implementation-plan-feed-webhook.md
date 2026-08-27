# Implementation Plan: Feed Abstraction, SDK Polling, and Webhook Tier

**Status:** planning (accepted via grilling + ADRs 0005–0007)
**Drivers:** local-first broker, webhook primary was reverted to SDK-polling-default with webhook opt-in; credentials config-first.

## Goal

Rebuild the source layer so that:
1. A **Feed** (event-type allowlist) is the first-class model every source exposes.
2. Sources poll via **official SDKs** (octokit / Atlassian REST / googleapis) reading credentials from `~/.amb/<kind>/credentials.json` — no more `gh`/`acli`/`gws` CLI exec.
3. **Webhook delivery** is an optional per-source opt-in tier with a swappable **tunnel-provider plugin** (smee default) and a thin vendor-agnostic receiver.
4. Both mechanisms emit identical event `kind`s.

## Phase 1 — Feed abstraction + SDK pollers (baseline)

### 1.1 Feed model (core types + store)
- [ ] Add `Feed` + `FeedConfig` + `Mechanism` types in `packages/core/src/types.ts` (`EventSourceConfig` gains a `feed` field: `kind`, `entityScope`, `eventTypes[]`, `mechanism: "poll" | "webhook"`).
- [ ] Add `WebhookRegistration` type.
- [ ] Store: persist `feed` + `mechanism` on the source row; keep `Source.options` secret-free (non-secret config only).

### 1.2 Config-first credentials loader
- [ ] Add `packages/server/src/sources/credentials.ts`: resolves `~/.amb/<kind>/credentials.json`, parses+validates per-kind shape, returns typed creds; throws a clear "missing/malformed/unauthorized" error on `start()`.
- [ ] `~/.amb/` home resolution + unit tests (incl. perms 600).
- [ ] Update CLI: `amb config init` scaffolds `~/.amb/<kind>/credentials.json` templates.

### 1.3 SourceManager → Feed lifecycle
- [ ] Rename/extend `SourceRegistry`/`SourceManager` to own Feed instances rather than raw pollers.
- [ ] Feed status model: `configured | auth-pending | auth-failed | running | stopped | errored`; surface via `/sources` + UI badge.
- [ ] Preflight auth on `start()`; hard-fail loudly (no `:error` spam) when creds missing/bad.

### 1.4 SDK pollers (replace CLI-exec)
- [ ] **github** feed: `octokit` — query per event type (PRs, issues, releases, etc.), type-aware, cursor via `SourceContext.setState`. Remove `exec("gh")`.
- [ ] **jira** feed: Atlassian REST client (email+API token) — `updated` timestamp cursor, event-type allowlist (`issue_created/updated/...`).
- [ ] **google** feed: `googleapis` — Gmail/Drive/Calendar resources, page-token cursor.
- [ ] Port existing behavior tests onto fake-SDK harnesses (no network); assert Feed event `kind`s + allowlist filtering + cursor persistence.

### 1.5 generic-webhook as a first-class kind
- [ ] `generic-webhook` feed: user-defined envelope `{type, id?, occurredAt?, payload}` → `kind = webhook:<type>`; verify via `x-webhook-secret` (off-by-default local dev).

## Phase 2 — Webhook overlay (opt-in tier)

### 2.1 Tunnel-provider plugin
- [ ] `TunnelProvider` interface: `open({ localUrl }) → { publicUrl, close() }`; registry so providers are hot-swappable.
- [ ] Default **smee** provider (outbound WS, keeps 127.0.0.1 closed).
- [ ] Alternative provider(s): `untun`/Cloudflare (inbound), ngrok — pluggable.
- [ ] Broker owns one shared tunnel URL; routes inbound by `POST /webhooks/:sourceId`.
- [ ] URL-change handling: auto re-register with every active WebhookRegistration.

### 2.2 Receiver + verify/decode
- [ ] Thin `/webhooks/:sourceId` intake stays; each feed provides `verify()` + `decode()`.
- [ ] Acknowledge-on-durable-persist, then async dispatch (receiver 2xx before dispatch); vendor retries don't duplicate.
- [ ] Verify by default; failed → 401/403, no publish, no dispatch.

### 2.3 GitHub webhook feed (opt-in; PAT repo hook, octokit)
- [ ] Register/update/delete repo webhook (`repos.*hooks`); mirror feed event-types; `ping` as a control (non-agent) event; `@octokit/webhooks` verify.

### 2.4 Jira / Google webhook feasibility (gated)
- [ ] Re-check Jira-cloud programmatic webhook restriction (Connect/OAuth only) and Google Pub/Sub dependency; if blocked, these feeds stay **poll-only** and the webhook mechanism degrades gracefully with a clear message.

## Phase 3 — Polish, observability, docs

- [ ] UI: feed status, event-type filter editor, mechanism toggle (where feasible), credential-status badge.
- [ ] `CONTEXT.md` consistent with ADRs (done — verify no drift).
- [ ] Update README quickstart: `~/.amb/` config, SDK polling default, webhook opt-in.
- [ ] Risk register: vendor webhook auth restrictions (Jira/Google), tunnel URL churn, secret hygiene, backward-compat of existing `Source.kind` values.

## Verification gates (fresh shell, rerunnable)
- `npm run build` (7 projects) green.
- `npm run test` (7 projects) green.
- Feed/SDK harnesses: `npx vitest run --root packages/server` (sources/*) green.
- e2e: `bash scripts/verify-e2e-coverage.sh` still green (UI unchanged).
- Manual: `amb config init` → create a `github` feed → observe SDK poll emits `github:pull_request`.

## Notes
- Polling is the baseline (ADR-0002 stays); webhook is opt-in (ADR-0007). No CLI exec in sources (ADR-0006).
- This is an implementation plan for a Ralph loop: break into ~3 items/iteration, commit per meaningful unit with `source:`/`server:`/`cli:`/`docs:` prefixes, self-reflect periodically.
