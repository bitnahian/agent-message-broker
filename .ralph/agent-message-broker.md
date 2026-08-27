# Agent Message Broker for Coding Agents

A local message broker + UI/CLI that lets developers wire event sources (polled URLs, GitHub, Jira, Google Workspace) to topics, and push events into specific running coding-agent sessions (pi, claude-code, codex) to steer them reactively. Unified push-orchestration architecture: the app/CLI subscribes a sessionRef ({agent, sessionId}) to a topic; the server resolves and pushes via per-agent delivery adapters behind one uniform interface.

## Design decisions (from grilling, confirmed)
- **Architecture**: unified push-orchestration. One `DeliveryAdapter` interface: `listSessions()`, `deliver(sessionRef, payload)`. Delivery strategy under investigation: primary candidate = broker-maintained long-running agent sessions that relay into subscribed sessions (pi-intercom / claude session IPC/SDK / codex orchestration); evaluate direct-push alternatives per agent and pick the most reliable. **Milestone 3 must record the chosen mechanism per agent with evidence.**
- **Retention** (added iter 1): persist events when no subscriber connected; per-topic configurable buffer `retainN` (default 100) replayed to late subscribers.
- **Monorepo**: nx. Projects: `core` (types), `server` (Fastify+SQLite better-sqlite3+SSE), `ui` (React+Vite+Tailwind), `cli` (commander), `adapter-pi/claude/codex`.
- **Event sources (MVP order)**: polled-URL → GitHub (gh api; investigate native events/webhooks) → Jira (acli; investigate events) → Google Workspace (gws poll).
- **Security**: local-first, optional bearer token.
- **Workflow per iteration** (user requirement): write `docs/implementation-log/iteration-<NN>.md` (work, decisions, evidence), verify, then `git add -A && git commit -m "ralph(iter-<NN>): <summary>"`.

## Goals
1. nx monorepo with the projects above, all building and tested
2. Server: event-source registry, topics, subscriptions, event log with per-topic `retainN` retention buffer, SSE stream, optional bearer auth
3. Delivery adapters for pi/claude/codex (uniform interface; pi e2e tested; claude/codex tested or documented manual-verify)
4. Event sources: polled-URL, GitHub, Jira, Google Workspace
5. CLI to manage sources/topics/subscriptions/sessions/events
6. UI served by the server: sources, topics, sessions, subscription wiring, live event feed (SSE)

## Checklist
- [x] 1. nx workspace scaffold (git, nx init, projects, tsconfig base, vitest)
- [x] 2. core types + server skeleton (Fastify, SQLite, CRUD, SSE, bearer auth, event log w/ `retainN`)
- [x] 3. DeliveryAdapter interface + mechanism research per agent; record chosen mechanism (broker-maintained relay vs direct push)
  - DECISION: pi = direct push via pi-intercom broker protocol (unix socket, 4-byte BE length-prefixed JSON; register/list/send). claude = `claude -p --resume <sessionId>` headless steer (appends turn to session transcript). codex = `codex exec resume <sessionId>` headless steer. Broker-maintained relay sessions = fallback only (would burn LLM tokens per event).
- [x] 4. adapter-pi end-to-end tested vs REAL pi-intercom broker (e2e/real-broker.ts: list + deliver + target inbox ✓)
- [x] 5. Event-source framework (EventBus single publish path, SourceRegistry/Manager, Poller base w/ key dedupe + persisted source_state, start/stop routes)
- [x] 6. polled-URL source + tests (etag/304 + sha256 hash diff, url-snapshot/url-changed/url-error, dedupe)
- [x] 7. GitHub source + tests. FINDINGS: webhooks need public URL (local broker can't receive w/o tunnel) → poll via `gh api repos/{o}/{r}/events`; stable event ids = natural dedupe keys; live smoke vs cli/cli fetched 30 events ✓
- [x] 8. Jira source + tests. FINDINGS: Jira webhooks need public URL, Forge events need a Forge app → poll via `acli jira workitem search --jql --json`. acli rejects `updated` in --fields → content-hash fingerprint dedupe. Live smoke vs KAN project ✓
- [x] 9. Google Workspace source + tests (generic gws poller: any service/resource/method, itemsPath, optional detail fetch w/ {{id}} substitution, fingerprintField for change detection). Live gmail list+get ✓
- [x] 10. adapter-claude (`claude -p --resume <id>` steer; sessions discovered from ~/.claude/projects jsonl; unit tested; e2e blocked: claude never authed on this machine — manual-verify doc pending in README)
- [x] 11. adapter-codex (`codex exec resume <id>` steer; sessions from ~/.codex/sessions rollout jsonl; unit tested; codex not logged in on this machine → manual-verify). Also: adapters wired into server runtime + GET /sessions, GET /agents.
- [x] 12. CLI (`amb`): topics/sources/subscriptions/sessions/events/doctor; tested against live server on ephemeral port. Bug found via test: commander .option() 2nd arg is description not default → limit=undefined → SQLITE_MISMATCH (fastify logger behind BROKER_LOG env now)
- [x] 13. UI (React+Vite+Tailwind v4): events SSE feed w/ replay, topics/sources/subscriptions/sessions panels, session datalist in subscription form. Server serves dist w/ SPA fallback (smoke: / 200, fallback 200, API intact)
- [x] 14. README (quickstart, adapter matrix, manual-verify notes), `npm run verify`, `npm run e2e` (full stack: server proc + CLI + UI + retention) → E2E FULL PASS

## Verification
- iter 13: `nx run-many -t build,test --all` ✓ (7 projects incl. vite build) + static-serving smoke (GET / → index.html, SPA fallback, /topics intact)
- iter 12: `nx run-many -t build,test --all` ✓ (6 projects; 4 CLI tests against live server: full topic→source→subscription→publish→list flow)
- iter 11: `nx run-many -t build,test --all` ✓ (5 projects; 4 adapter-codex tests; server registers all 3 adapters)
- iter 10: `nx run-many -t build,test --all` ✓ (4 adapter-claude tests)
- iter 9: `nx run-many -t build,test --all` ✓ (4 gws tests) + live gmail list→get detail smoke ✓
- iter 8: `nx run-many -t build,test --all` ✓ (3 jira tests) + live `acliRunner("project = KAN...")` → 3 work items (KAN-5)
- iter 7: `nx run-many -t build,test --all` ✓ (3 github tests: id dedupe, late events, deduped error) + live `ghRunner("repos/cli/cli/events")` → 30 events
- iter 6: `nx run-many -t build,test --all` ✓ (4 polled-url tests vs local http server: baseline, change-once, etag 304, deduped error). Fixed: source_state NULL on undefined value.
- iter 5: `nx run-many -t build,test --all` ✓ (framework tests: dedupe across instances via persisted state, bus→adapter routing, start/stop routes)
- iter 4: `npx tsx packages/adapter-pi/e2e/real-broker.ts` → E2E PASS (real broker, deliver ack, target received message)
- iter 3: `nx run-many -t build,test --all` ✓ (adapter-pi protocol test vs fake broker: list excludes self, deliver ack/nack)
- iter 2: `nx run-many -t build,test --all` ✓ (6 server tests: CRUD, bearer auth, retainN buffer=3 pruned 6→3, dispatch to fake adapter, offline persistence)
- iter 1: `npx nx run-many -t test --all` ✓ ; `npx nx run-many -t build --all` ✓ (after excluding *.test.ts from tsc)

## Final Verification
- Command: `npm run verify && npx nx run @amb/ui:build && npm run e2e`
- Working directory: `/home/nahian/projects/agent-message-broker`
- Required preserved artifacts: `node_modules/` (with `npm approve-scripts better-sqlite3 esbuild` + rebuild already applied), `packages/ui/dist/`
- Result summary: 7 nx projects build+test PASS (core, server, adapter-pi/claude/codex, cli, ui); e2e prints E2E FULL PASS (health, doctor agents=[pi,claude,codex], topic/source/subscription create, event publish+retention, sessions discovery, UI served)

## Reflections

### Iteration 10 checkpoint
1. **Accomplished**: 8/14 items. All four event sources done (polled-url, github, jira, gws) with unit tests + live smokes; adapter-pi e2e'd; adapter-claude implemented (unit-tested; no auth on this machine → manual-verify).
2. **Working well**: injectable runners make CLI-backed sources/adapters fully testable; live smokes (gh, acli, gws) give real evidence without fixtures going stale.
3. **Not working**: `claude` has no ~/.claude dir (never authed) — claude e2e will need user auth. Same risk for codex; check `codex login status` in iter 11 before deciding.
4. **Adjustments**: adapter pattern settled (injectable runner, fake-broker/fake-runner tests + live smoke). No architecture change needed.
5. **Next priorities**: adapter-codex (11), CLI (12), UI (13), README+final verify (14).

### Iteration 5 checkpoint
1. **Accomplished**: 4/14 items in 4 iterations — nx scaffold, server skeleton (CRUD/SSE/auth/retainN buffer), milestone-3 delivery decisions with evidence, adapter-pi unit + real-broker e2e.
2. **Working well**: build+test gate catches type errors immediately; protocol-first research on pi-intercom eliminated the relay-agent fallback for pi (no LLM tokens burned per event); e2e scripts per adapter give strong evidence.
3. **Not working**: nothing blocking. Minor: npm allow-scripts blocks native postinstalls (documented workaround `npm approve-scripts`); `ralph_done` reports queued messages each time — loop still advancing.
4. **Adjustments**: keep iterations small (1-2 checklist items); co-locate e2e scripts with adapters; extract an EventBus so sources and HTTP route share the publish path.
5. **Next priorities**: item 5 event-source framework, then polled-URL (6), GitHub (7).

## Notes
- Toolchain: node 22, npm 11, npx nx, gh, acli, gws, pi, claude, codex on PATH.
- pi push: `pi.sendUserMessage(msg, {triggerTurn:true, deliverAs:"steer"})` (extension API).
- Loop policy: max 200 iterations, reflect every 5. If core progress blocked by human-only step, record blocker and emit `<promise>COMPLETE</promise>` to self-close.
- Per-iteration log: `docs/implementation-log/iteration-NN.md`; `.ralph/*.state.json` gitignored.
