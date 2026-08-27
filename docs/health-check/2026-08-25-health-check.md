# Health Check — 2026-08-25

> **FIX STATUS UPDATE (2026-08-26, branch `feature/health-check-fixes`):** all 8 bugs are fixed.
>
> | Bug | Fix | Verification |
> |---|---|---|
> | BUG-01 (blocker) | `defaultSpawn` stdio `pipe`; real-spawn regression test with a fake daemon over actual pipes | adapter-codex 9/9 tests; live RPC round-trip vs real codex 0.149.1 |
> | BUG-02 (blocker) | adapter reworked for Claude ≥2.1.24x: live sessions from `~/.claude/sessions/<pid>.json`, auth via `peerToken` from the `.key` file, `"type":"user"` message frames | live delivery to a running session — message landed in the session transcript |
> | BUG-03 (major) | adapter speaks to a spawned `codex app-server` stdio process directly; the daemon/proxy websocket relay is broken in codex 0.149.x (write-race) and is no longer used | `thread/list` live round-trip; `deliver()` returns `{ok:false}` cleanly for unknown threads |
> | BUG-04 (major) | playwright webServer boots a dedicated e2e broker (:4799, `BROKER_TOKEN=test-token`, scratch DB); specs share helpers | suite 14/14 green (was 5 failed / 3 blocked / 2 passed), incl. 4 new edge-case specs |
> | BUG-05 (minor) | stories self-contained via a fetch-mock decorator; `storybook-static/` gitignored | `storybook build` passes |
> | BUG-06 (minor) | polled-url default interval moved to 60s per ADR-0002 | server 36/36 |
> | BUG-07 (minor) | top-level `amb webhook <id>` alias (alongside `amb events webhook`) | cli 6/6 |
> | BUG-08 (minor) | delivery rows cascade on retention-prune/topic-delete; reconcile re-drive capped at 10 failed attempts per (event, subscription) | server 36/36 (3 new tests) |
>
> Also: pi delivery live-verified (`{ok:true}`); `@vitest/coverage-v8` installed — baselines: server 83.8% / cli 89.9% stmts.
> Full delivery verification (pi + claude) done against the user's live sessions. Codex verified at the RPC level (no live codex session was sanctioned for test events).

Audit of ADR-0001–0004 capabilities against reality. Nothing in the source tree was modified (git status clean at end of audit). Scratch verification used `BROKER_PORT=4811`, `BROKER_DB=/tmp/hc-broker.db`, `BROKER_TOKEN=test-token`; all scratch processes were stopped afterwards. No test events were pushed into any real pi/claude/codex session.

**Baseline:** `npm run build` — 7/7 projects pass. `npm run test` — 7/7 projects pass, 52 tests total. `npx tsx scripts/e2e.mts` — `E2E FULL PASS`.

Classification: **VERIFIED-REPRO** = reproduced by command/observation; **CODE-LEVEL** = proven by reading the code path; **SUSPECTED** = needs an environment I can't drive.

---

## 1. Capability matrix

### ADR-0001 — Uniform DeliveryAdapter

| # | Capability | Status | Evidence |
|---|-----------|--------|----------|
| 1.1 | Three adapters implement `listSessions()` + `deliver()` | WORKING | All three compile & register: `packages/server/src/index.ts:19-21`; unit tests pass (adapter-pi 2, adapter-claude 5, adapter-codex 5) |
| 1.2 | `deliver()` never throws, returns `{ok, detail}` | WORKING | pi probe: `{"ok":false,"detail":"Session not found"}` for missing session (no throw); claude probe: `{"ok":false,"detail":"session found in registry..."}`; codex probe: `{"ok":false,"detail":"Cannot read properties of null..."}` — all return, none throw |
| 1.3 | Dispatcher holds `Map<AgentKind, DeliveryAdapter>`, no per-agent branching | WORKING | `packages/server/src/dispatcher.ts:13` (`Map<string, DeliveryAdapter>`), `:69` (`adapters.get(sub.target.agent)` in a uniform loop); dispatch verified end-to-end via POST /events on scratch server |

### ADR-0002 — Poll-first sources

| # | Capability | Status | Evidence |
|---|-----------|--------|----------|
| 2.1 | polled-url with ETag/sha256 change detection | WORKING | Live scratch run: `url-snapshot` → file edit → `url-changed` with `previousHash`; unchanged polls emit nothing. BUT default interval is 30s, not 60s as ADR says (BUG-06) |
| 2.2 | github poller (`gh api`) | WORKING | Scratch source on `cli/cli` @5s interval emitted 3 `github:PullRequestEvent` events with summaries (`dependabot[bot] labeled PR #14258...`); dedupe by event id held |
| 2.3 | jira poller (`acli`) | WORKING | `acli jira workitem search ... --json` succeeds on this machine (authed); parsing covered by `jira.test.ts`; same Poller framework as 2.2 |
| 2.4 | gws poller | UNVERIFIABLE (env) | `gws gmail users messages list` → 401 `invalid_grant: Token has been expired or revoked` on this machine. Code path identical to 2.2/2.3 and unit-tested (`gws.test.ts`) |
| 2.5 | Sources emit only on change | WORKING | Restart test: no duplicate `url-snapshot` after server restart (seenKeys/hasBaseline persisted); github second tick emitted 0 new events |
| 2.6 | Webhook escape hatch `POST /webhooks/:sourceId` + optional secret | WORKING | Scratch: no secret → 401; `x-broker-secret` header → 202; `?secret=` query → 202; unknown sourceId → 404 |
| 2.7 | Server binds 127.0.0.1 only | WORKING | `packages/server/src/index.ts:27` `host: "127.0.0.1"`; `ss -tln` shows `127.0.0.1:4733` |

### ADR-0003 — Live push delivery

| # | Capability | Status | Evidence |
|---|-----------|--------|----------|
| 3.1 | pi via intercom broker socket (register synthetic session, `send`) | WORKING | Wire probe against the running intercom broker: fake target registered, `listSessions` saw it, `deliver` returned `{ok:true}`, message received by target inbox (`PI WIRE PASS`). User's own broker.db: 50/50 pi deliveries `ok=1` |
| 3.2 | claude via inbox unix socket NDJSON + optional auth frame | BROKEN | BUG-02. Real DB: 0/50 claude deliveries succeeded. Unit test proves frame-writing works when a registry entry with an inbox socket exists, but no such configuration exists on this machine (and arguably rarely does) |
| 3.3 | codex via JSON-RPC daemon (thread/resume → turn/steer/turn/start) | BROKEN | BUG-01 (blocker): adapter can never write to the proxy (stdin ignored). Also daemon won't start on this machine (BUG-03 env factor) |
| 3.4 | `listSessions()` discovers only running sessions | BROKEN (codex), DEGRADED (claude) | codex: always returns `[]` here (BUG-01/03). claude: falls back to scanning `~/.claude/projects` `.jsonl` files — discovers *historical* sessions, not running ones (`adapter-claude/src/index.ts:96`). pi: correct |
| 3.5 | deliver() never throws | WORKING | See 1.2 |

### ADR-0004 — SQLite WAL retention

| # | Capability | Status | Evidence |
|---|-----------|--------|----------|
| 4.1 | broker.db WAL mode, `BROKER_DB` env, `:memory:` for tests | WORKING | `PRAGMA journal_mode` on scratch DB → `wal`; env honored (scratch server ran on `/tmp/hc-broker.db`); tests use `:memory:` |
| 4.2 | retainN per topic with pruning | WORKING | Scratch: 4 events into a retainN=2 topic → only newest 2 retained (`n=3,4`) |
| 4.3 | SSE `/events/stream?replay=1` pushes retained buffer | WORKING | curl: 2 retained events replayed in ascending order |
| 4.4 | `Last-Event-ID` dedupe on reconnect | WORKING | curl with anchor id → only the newer event replayed; also covered by `app.test.ts` |
| 4.5 | Delivery attempts recorded; reconciliation re-drives | WORKING | Scratch: every publish recorded an attempt row; restart logged `reconciled 2 pending deliver(s)` and re-attempted. Real broker restore logged `reconciled 80 pending deliver(s)`. Caveat: BUG-09 (unbounded retries/growth) |
| 4.6 | Per-source state persisted (ETags, cursors) | WORKING | `source_state` rows (`etag`, `contentHash`, `hasBaseline`, `seenKeys`) read directly from scratch DB after restart; no re-emit post-restart |

### User-reported issues

| # | Report | Verdict | Evidence |
|---|--------|---------|----------|
| U1 | UI doesn't surface live codex sessions | CONFIRMED (BROKEN) | `/sessions` on the live broker lists pi+claude, zero codex; `CodexAdapter.listSessions()` → `[]` in 3-4ms despite a running codex process. Root causes: BUG-01 + BUG-03. UI rendering code itself is correct (`App.tsx:285`) |
| U2 | Server not delivering to subscribed claude sessions | CONFIRMED (BROKEN) | Real broker.db: claude sub has 50 delivery attempts, all `ok=0` "session found in registry but no inbox socket known"; same result reproduced against the scratch server and via direct adapter probe (BUG-02) |
| U3 | Test coverage is very bad | PARTIALLY CONFIRMED | 52 tests total; no coverage provider installed (`MISSING DEPENDENCY Cannot find dependency '@vitest/coverage-v8'`). Server well covered at inject level; UI has exactly 1 trivial SSR test for 623 LOC; see §3 |
| U4 | Playwright/storybook shallow; UI edge cases fail | CONFIRMED | Playwright suite: **5 failed, 3 blocked, 2 passed** (BUG-04). Storybook: 2 stories in 1 file, mock data inert (BUG-05). Many UI behaviors have zero specs (§3.4) |
| U5 | Hardly any integration tests | PARTIALLY CONFIRMED | Real integration exists (server inject suite, CLI↔live-server suite, `e2e.mts`, pi wire e2e) but key seams untested; inventory in §3.5 |
| U6 | CLI barely tested | PARTIALLY CONFIRMED | 18 commands, 11 with automated tests, 7 without. All 18 smoke-verified manually against the scratch server — all work when invoked correctly (see BUG-08) |

**Overall:** 21 ADR capability rows → 17 WORKING, 3 BROKEN, 1 UNVERIFIABLE. User issues → 3 CONFIRMED-BROKEN, 3 PARTIALLY CONFIRMED.

---

## 2. Verified bug reports

### BUG-01 — Codex adapter spawns the app-server proxy with stdin ignored; every RPC write throws
- **Severity:** blocker
- **Classification:** VERIFIED-REPRO
- **Expected:** `CodexAdapter.deliver()` sends `thread/resume` → `turn/steer|turn/start` over `codex app-server proxy` stdio; `listSessions()` returns threads from `thread/list`.
- **Actual:** `defaultSpawn` opens the proxy with `stdio: ["ignore", "pipe", "pipe"]` (`packages/adapter-codex/src/app-server-client.ts:8`), so `proc.stdin` is `null`. The first request does `this.proc.stdin!.write(...)` (`app-server-client.ts:51`) → `TypeError: Cannot read properties of null (reading 'write')`. `deliver()` catches it and returns `{ok:false, detail:"Cannot read properties of null (reading 'write')"}`; `listSessions()` catches it and silently falls back to a filesystem scan that finds nothing (returns `[]` in ~3ms, before the proxy process even starts).
- **Repro:** `CodexAdapter` with default options → `deliver({agent:"codex",sessionId:"hc-fake-thread"}, ...)` → `{"ok":false,"detail":"Cannot read properties of null (reading 'write')"}`; `listSessions()` → `[]` in 3ms with `spawn called: codex ['app-server','proxy']` logged.
- **Why tests miss it:** the unit tests inject `fakeProxy`, which assigns `PassThrough` streams (`adapter-codex/src/index.test.ts:11-16`) — `proc.stdin` is never null there, so the real spawn path is never exercised.
- **Affected capability:** ADR-0003 rows 3.3, 3.4; user issue U1.

### BUG-02 — Claude delivery only works for registry-discovered sessions; real sessions are discovered via the projects fallback and are undeliverable
- **Severity:** blocker (for the claude capability)
- **Classification:** VERIFIED-REPRO
- **Expected:** An event published to a topic with a claude subscription is posted to the session's inbox socket.
- **Actual:** `listSessions()` discovers sessions two ways: `~/.claude/agent-registry.json` entries, or a fallback scan of `~/.claude/projects/**/*.jsonl` (`adapter-claude/src/index.ts:96`). `deliver()` only looks up targets in the *registry* (`adapter-claude/src/index.ts:122` — `this.entries().find(...)`), so any session discovered via the projects fallback can never be delivered to. On this machine the registry file does not exist at all, so the single discovered claude session (`c876d757-...`) is undeliverable by construction. The failure detail is also misleading: `"session found in registry but no inbox socket known"` (`index.ts:125`) — the session was *not* found in the registry.
- **Repro (system level):** user's `broker.db`: `SELECT s.agent, d.ok, count(*) FROM deliveries d JOIN subscriptions s ... GROUP BY s.agent, d.ok` → `claude, 0, 50` (all failed, 59 of 61 failures share that error string). `pi, 1, 50` (all succeeded).
- **Repro (adapter level):** `adapter.deliver({agent:"claude",sessionId:"c876d757-..."}, ...)` → `{"ok":false,"detail":"session found in registry but no inbox socket known"}`.
- **Affected capability:** ADR-0003 row 3.2; user issue U2.

### BUG-03 — Codex session discovery: `listSessions()` never starts the app-server daemon, and the daemon can't start on this install anyway
- **Severity:** major
- **Classification:** VERIFIED-REPRO
- **Expected:** A running codex session appears in `/sessions` and the UI session picker.
- **Actual:** Discovery requires `codex app-server proxy` → control socket `~/.codex/app-server-control/app-server-control.sock`, which only exists if the daemon runs. `listSessions()` never starts the daemon (only `deliver()` does, `adapter-codex/src/index.ts:92`); on failure it falls back to scanning `~/.codex/sessions/**/*.jsonl` — a directory that current codex (0.147.0) does not create. `codex app-server daemon start` itself fails on this machine: `Error: managed standalone Codex install not found at ~/.codex/packages/standalone/current/codex` (codex is installed via nix, not the managed installer). Result: codex sessions can never be discovered or delivered to on this machine, even after BUG-01 is fixed. Also note `CodexAdapterOptions.fsFallback` (`index.ts:22`) is declared but never read — dead option.
- **Repro:** `codex app-server proxy` → `Error: failed to connect to socket .../app-server-control.sock`; `codex app-server daemon start` → managed-install error above; `ls ~/.codex/sessions` → no such directory.
- **Affected capability:** ADR-0003 rows 3.3, 3.4; user issue U1.

### BUG-04 — Playwright suite cannot run: hardcoded `test-token` against a token-authed server, and broken `webServer` command
- **Severity:** major
- **Classification:** VERIFIED-REPRO
- **Expected:** `cd packages/ui && npx playwright test` passes against a broker started by the config's `webServer`.
- **Actual:** Two independent breaks:
  1. All three specs hardcode `Authorization: Bearer test-token` (`e2e/smoke.spec.ts:3`, `e2e/ui.spec.ts:3`, `e2e/mutations.spec.ts:3`), but the server auto-generates/persists a real token (`server/src/token.ts`) — the `webServer` command never sets `BROKER_TOKEN=test-token`. Every API-seeding call gets 401; `ui.spec.ts`'s `beforeAll` then crashes with `TypeError: topics is not iterable` (`ui.spec.ts:9`), failing the whole file.
  2. When no server is running, `webServer.command: "npm run start"` (`playwright.config.ts:21`) executes in `packages/ui`, which has no `start` script → `Missing script: "start"` → webServer exits 1, tests never start.
- **Observed run:** `5 failed, 3 did not run, 2 passed` (the 2 passes are the bare `/health` checks). No user data was mutated — all mutation attempts were blocked by 401.
- **Affected capability:** user issue U4 (e2e confidence); masks every UI regression.

### BUG-05 — Storybook "WithData" story's mock data is inert; storybook coverage is 2 stories
- **Severity:** minor
- **Classification:** CODE-LEVEL
- **Expected:** `WithData` story shows a populated dashboard ("With Topics (simulated)").
- **Actual:** The story sets `parameters.mockData` (`App.stories.tsx:20`) but `.storybook/main.ts:5` has `addons: []` — no addon reads `mockData`, so the story renders against the live proxied broker (or empty). Entire storybook surface: 1 stories file, 2 stories (`FirstRun`, `WithData`); `@storybook/test-runner` is in devDependencies but no script wires it up. `npx storybook build` does succeed.
- **Affected capability:** user issue U4.

### BUG-06 — ADR-0002 documents a 60s default poll interval for polled-url; code default is 30s
- **Severity:** minor
- **Classification:** CODE-LEVEL
- **Actual:** `poller.ts:29` and `polled-url.ts:27` both default to `30_000`; ADR-0002 and PRODUCT.md say "default 60s". (github=60s `github.ts:67`, jira/gws=120s.) Docs-code drift only.
- **Affected capability:** ADR-0002 row 2.1.

### BUG-07 — CLI webhook command is nested under `events`; `amb webhook` is an unknown command
- **Severity:** minor
- **Classification:** VERIFIED-REPRO
- **Actual:** `program.ts:60` registers `events.command("webhook <sourceId>")`, so only `amb events webhook <id>` works; `amb webhook <id>` → `error: unknown command 'webhook'`. Neither README nor `amb --help` hint at the nesting (no top-level alias). Untested by `program.test.ts`.
- **Affected capability:** ADR-0002 row 2.6 usability; user issue U6.

### BUG-08 — `deliveries` table grows unbounded; permanently failing subscriptions are re-driven on every server start
- **Severity:** minor
- **Classification:** CODE-LEVEL (+ observed on real DB)
- **Actual:** `store.recordDelivery` (`store.ts:154`) inserts a row per attempt; nothing ever deletes from `deliveries` (retention prunes only `events`, `store.ts:131-146` `deleteTopic` also leaves orphan delivery rows). `dispatcher.reconcile()` (`dispatcher.ts:17-36`) re-drives every event in the last hour that lacks an `ok=1` record — for a permanently failing subscription (e.g. the claude one, BUG-02) this appends a fresh failure row on *every* boot, forever. Observed: user broker boot logged `reconciled 80 pending deliver(s)`; its `deliveries` table already holds 321 rows for 50 events. `GET /deliveries` caps reads at 100, so the growth is invisible until it isn't.
- **Affected capability:** ADR-0004 row 4.5 (works, but degrades).

---

## 3. Coverage & test inventory

### 3.1 Coverage numbers
- **Not obtainable:** no coverage provider installed. `npx vitest run --coverage` in `packages/server` → `MISSING DEPENDENCY Cannot find dependency '@vitest/coverage-v8'`. No `coverage` config in any package.
- Test totals (all passing): core 1, adapter-pi 2, adapter-claude 5, adapter-codex 5, cli 5, server 33, ui 1 = **52 tests in 11 files**.
- Source vs test LOC: core 67/22, server 1248/628, cli 139/79, adapter-pi 183/69, adapter-claude 145/74, adapter-codex 218/121, **ui 623/10**.

### 3.2 Per-package test map

| Package | Test files | What's covered | Not covered |
|---|---|---|---|
| core | `types.test.ts` | interface implementability (trivial) | — (types only) |
| server | `app.test.ts` (15), `sources/framework.test.ts`, `github/jira/gws/polled-url.test.ts` | auth hook, CRUD+409/400/404, retention prune, delivery recording, dispatch, SSE Last-Event-ID, webhook secret, cascade delete, reconcile, poller dedupe/backoff, per-source parsing | `token.ts` (auto-gen/persist path), `index.ts` boot wiring, SSE live fan-out (only replay tested), restart/startAll, `db.ts` |
| cli | `program.test.ts` (5) | topics/sources/subscriptions CRUD, publish, list, doctor, sessions | `sources start/stop/running`, `events webhook`, `deliveries`, token-file auth path (`client.ts:8-14`) |
| adapter-pi | `index.test.ts` (2) | list/deliver vs fake broker, delivery_failed | reconnect/error paths, timeout path |
| adapter-claude | `index.test.ts` (5) | registry listing, projects fallback, auth+message frames over a real tmp socket, failure paths | the BUG-02 gap: deliver to a projects-fallback-discovered session |
| adapter-codex | `index.test.ts` (5) | thread/list parsing, fs fallback, steer/start branching, rpc error | **the real spawn path (BUG-01)**; `app-server-client.ts` line buffering only via fakes |
| ui | `App.smoke.test.tsx` (1) | SSR renders shell text | everything else: all interactions, empty/error states, SSE handling, filtering |

### 3.3 Modules with zero direct test files
`server/src/{index,event-bus,token,dispatcher,sse,store,db}.ts`, `server/src/sources/{index,poller,registry}.ts` (most exercised transitively via `app.test.ts`), `adapter-codex/src/app-server-client.ts` (real path untested — see BUG-01), `adapter-pi/src/framing.ts` (transitively covered), `cli/src/{index,client}.ts` (client transitively covered), `ui/src/{App,api,main,assets/illustrations}.tsx/ts` (623 LOC, one SSR smoke test).

### 3.4 Playwright / storybook gap list
Existing specs (all currently failing — BUG-04): `smoke.spec.ts` (5 API tests), `ui.spec.ts` (4: shell, launchpad, create-topic nav, retained-events), `mutations.spec.ts` (1: source start/stop/delete + topic delete).
Uncovered UI behaviors: error toasts (401/404/409/ECONNREFUSED mapping in `useCatchToast`), offline banner, duplicate-topic toast, event-feed client cap at 200, long topic lists, "All sessions already subscribed" state, subscription picker with mixed reachable/unreachable sessions, template placeholder entry, SSE reconnect dedupe in the browser, topic-delete two-step confirm, publish-event form validation (invalid JSON), webhook-secret sources. Storybook: see BUG-05.

### 3.5 Integration-test inventory
- `packages/server/src/app.test.ts` — HTTP-level via fastify inject (in-memory DB). Strong for API semantics; not a real process/socket test.
- `packages/cli/src/program.test.ts` — CLI against a real listening fastify server. Real HTTP.
- `scripts/e2e.mts` — real server process + real CLI + UI-served check + retention. Passes. Does not exercise webhooks, SSE, sources, reconcile, or delivery success.
- `packages/adapter-pi/e2e/real-broker.ts` — real intercom wire test (manual, not in `npm test`; equivalent verification performed in this audit — PASS).
- Playwright specs — the only browser-level integration; currently broken (BUG-04).
- No integration test exists for: server restart persistence (startAll + reconcile), real claude/codex delivery (manual scripts only: `scripts/verify-claude.mts`, `scripts/verify-codex.mts`), gws/jira/github sources against real CLIs, webhook auth via real HTTP.

### 3.6 CLI command ↔ test map
Commands (18): `topics list` ✓, `topics create` ✓, `topics delete` ✓, `sources list` ✓, `sources create` ✓, `sources delete` ✓, `sources start` ✗, `sources stop` ✗, `sources running` ✗, `subscriptions list` ✓, `subscriptions create` ✓, `subscriptions delete` ✓, `sessions` ✓, `events list` ✓, `events publish` ✓, `events webhook` ✗, `deliveries` ✗, `doctor` ✓. (✓ = covered by `program.test.ts`; all 18 additionally smoke-verified manually against the scratch server — all work.)

---

## 4. Environment / setup notes

- **No coverage provider** — `@vitest/coverage-v8` (or istanbul) is not installed; coverage numbers are unobtainable without a dependency change.
- **Playwright** — chromium 1234 is installed and runs; the blocker is the config/spec auth mismatch (BUG-04), not the browser.
- **Claude Code on this machine** — no `~/.claude/agent-registry.json`, no `~/.claude/inbox/`; sessions exist only as `~/.claude/projects/*.jsonl` history. The registry+inbox delivery path is therefore untestable here beyond the socket-level unit test.
- **Codex on this machine** — `codex-cli 0.147.0` via nix; `codex app-server daemon start` requires the managed standalone install (`curl ... | sh`), so the JSON-RPC path is unrunnable here even with BUG-01 fixed. `verify-codex.mts` cannot pass in this environment.
- **gws** — binary present but auth token expired (`invalid_grant`); gws source would emit `gws:error` events (with backoff) rather than data.
- **gh / acli** — present and authenticated; github + jira sources work.
- **Intercom broker** — running at `~/.pi/agent/intercom/broker.sock`; pi adapter verified against it with a self-registered fake target (no user session touched).
- **User broker on :4733** — was running at audit start; accidentally stopped mid-audit by an over-broad `pkill` during scratch cleanup and immediately restarted with identical env (`npm run start`, same token/DB); its state is intact (1 topic, 2 subscriptions, 50 events). Its boot reconcile appended new delivery-attempt rows for previously failed claude deliveries (BUG-08 behavior).
- Scratch artifacts left outside the repo: `/tmp/hc-broker.db*`, `/tmp/hc-probe/`, `/tmp/hc-www/`, `/tmp/hc-storybook-out/`, `/tmp/hc-*.log`. Repo tree is untouched (`git status` clean).
