# agent-message-broker

A local message broker for coding agents. Wire event sources (polled URLs, GitHub, Jira, Google Workspace) to **topics**, subscribe **running coding-agent sessions** (pi, claude-code, codex) to those topics, and let events steer them reactively — no per-agent background scripts.

## Architecture

Unified push-orchestration. The app/CLI subscribes a `sessionRef = { agent, sessionId }` to a topic; the server pushes rendered events via per-agent **delivery adapters** behind one uniform interface (`listSessions()`, `deliver()`).

```
event sources ──poll──▶ topics ──subscription──▶ delivery adapter ──push──▶ agent session
                              │
                              └── retainN event buffer (SQLite) + SSE live feed + UI
```

| agent  | live delivery mechanism | e2e status |
|--------|-------------------------|------------|
| pi     | direct push via pi-intercom broker protocol (unix socket; registers as synthetic `amb-broker` session; steer between turns) | ✅ automated e2e against real broker |
| claude | direct post to the session's **inbox unix socket** (cross-session messaging; discovery via `~/.claude/agent-registry.json`; optional `{"type":"auth","token":…}` first frame; delivery subject to `crossSessionInbound` controls, between tool calls / new turn when idle) | ⚠️ manual verify: `npx tsx scripts/verify-claude.mts <sessionId>` (needs claude auth) |
| codex  | **app-server daemon JSON-RPC** (`codex app-server proxy`): `thread/list` → `thread/resume` → `turn/steer` when a turn is active, else `turn/start` | ⚠️ manual verify: `npx tsx scripts/verify-codex.mts <threadId>` (needs `codex login`) |

All three signal the live process — no headless-resume appends. (Claude/codex live e2e still needs a human to authenticate those CLIs once.)

| source | kind | how |
|--------|------|-----|
| any URL (Slack thread, file, ticket, PR…) | `polled-url` | fetch + ETag/sha256 change detection |
| GitHub | `github` | `gh api repos/{o}/{r}/events` (or any gh api path) |
| Jira | `jira` | `acli jira workitem search --jql …` |
| Google Workspace | `gws` | any `gws <service> <resource> <method>` (gmail/drive/calendar), optional per-item detail fetch |

Webhooks (GitHub/Jira/Workspace push) are intentionally not used: the broker is local-first and can't receive pushes without a tunnel.

## Quickstart

```bash
npm install

npm run verify            # build + test all 7 nx projects
npx nx run @amb/ui:build  # build the UI (served by the server)

npm run start             # → http://127.0.0.1:4733  (UI + API)
npx tsx scripts/e2e.mts   # full e2e: server + CLI + UI + retention
```

CLI (same server, `BROKER_URL`/`BROKER_TOKEN` envs respected):

```bash
amb topics create prs --retain 50
amb sources create --topic <name|id> --kind github --options '{"repo":"cli/cli"}'
amb sources start <sourceId>
amb sessions                                   # discover running agent sessions
amb subscriptions create --topic prs --agent pi --session <sessionId> --template "PR event: {{payload}}"
amb events list --topic prs
```

Server env: `BROKER_PORT` (default 4733), `BROKER_DB` (default `broker.db`), `BROKER_TOKEN` (optional; if unset a token is auto-generated at `~/.config/agent-message-broker/token`, mode 0600, and the CLI reads it automatically), `BROKER_UI_DIR`, `BROKER_LOG=1` for request logs. The server binds 127.0.0.1 only; the bearer token blocks other local processes and web pages you visit from driving the broker.

## Retention

Every event is persisted per topic (`retainN`, default 100) even with zero subscribers; SSE clients get `?replay=1` buffer replay. Late subscribers can also `GET /events?topicId=…`.

## Monorepo

nx + npm workspaces. Projects: `core` (types/DeliveryAdapter), `server` (Fastify+SQLite+SSE), `ui`, `cli`, `adapter-pi|claude|codex`. Per-iteration implementation logs in `docs/implementation-log/`.

## Manual verification pending

- **claude delivery**: `npx tsx scripts/verify-claude.mts <sessionId> [token]` (claude must be authed; message delivery is subject to the target session's `crossSessionInbound` controls — untokenized broker posts may show a hold-for-approval notice).
- **codex delivery**: `npx tsx scripts/verify-codex.mts <threadId>` (needs `codex login`).
- **pi live interactive delivery**: automated e2e covers broker-level delivery; injecting into a live interactive pi session additionally exercises pi-intercom's own `sendUserMessage(steer)` path.
