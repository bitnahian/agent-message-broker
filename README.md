# agent-message-broker

A local message broker for coding agents. Wire event sources (GitHub, Jira, Google Drive/Sheets/Docs, polled URLs, generic webhooks) to topics, subscribe running coding-agent sessions (pi, Claude Code, Codex) to those topics, and let events steer them mid-session without per-agent background scripts.

## Why

Coding agents are batch processes. You prompt, they run, they stop. What an agent actually cares about (a ticket moved, a PR opened, a spec landed in a doc) happens between prompts, and the usual bridge is a polling script per agent or manual re-prompting.

One example of the pattern: a pi session watches a Jira board and a Google Doc. A ticket moves to In Progress, so pi gets the event and waits, because the implementation spec is still being written in the doc. When the doc update lands, pi reads the spec, implements the ticket, and raises a PR. A Claude session watching the repo sees the PR event and reviews it. Any set of sources, topics, and sessions composes the same way.

Mechanically: sources publish events to topics, subscriptions push those events into live agent sessions, and the agent reacts in the conversation it's already having.

## Quickstart

Prerequisites: Node 22.5 or newer (the broker uses node's built-in SQLite) and git.

The easiest way to run the broker is the published npm package:

```bash
npx agent-message-broker          # broker + UI + API at http://127.0.0.1:4733
# or: npm install -g agent-message-broker, then use the `amb` command
```

To run from source instead:

```bash
npm install
npm run build              # build all workspace packages (incl. the UI)
npm run start              # broker + UI + API at http://127.0.0.1:4733
```

All commands below use `amb` (substitute `npx agent-message-broker` if you prefer zero-install).

See an event flow end to end:

```bash
npx agent-message-broker topics create prs --retain 50
npx agent-message-broker sources create --topic prs --kind github --options '{"repo":"cli/cli"}'
npx agent-message-broker sources start <sourceId>
npx agent-message-broker events list --topic prs
```

Now subscribe a running agent session so events push to it live:

```bash
npx agent-message-broker sessions                                                       # discover sessions
npx agent-message-broker subscriptions create --topic prs --agent pi --session <sessionId> --template "PR event: {{kind}} {{payload}}"
```

Verify an offline pass of the whole system (server + CLI + UI + retention, no external creds):

```bash
npm run e2e
```

## Recipes: agent-reacts-to-events wiring

The flow shown above (ticket moves to In Progress, implementation spec lands in a Google Doc, agent implements, another agent reviews the PR) is three topics wired to three sources. Each recipe is copy-paste; every source needs `sources start <sourceId>` after create.

### 1. Jira: ticket pushed to In Progress

Needs `~/.amb/jira/credentials.json` (`amb config init --kind jira` scaffolds it).

```bash
amb topics create jira --retain 100
amb sources create --topic jira --kind jira --options '{
  "jql": "status CHANGED TO \"In Progress\" AFTER -30d ORDER BY updated DESC",
  "intervalMs": 120000
}'
```

Emits `jira:workitem-updated` with `{key, summary, status, assignee, issueType, updated}`. The `AFTER -30d` bound is required: Atlassian rejects unbounded JQL on this endpoint.

### 2. Google Doc: implementation spec updated

Needs the Google OAuth login (`amb google login`).

```bash
amb topics create doc --retain 100
amb sources create --topic doc --kind google --options '{
  "api": "drive.files.list",
  "params": {
    "q": "name = \"Implementation Plan\" and trashed = false",
    "fields": "files(id,name,modifiedTime)"
  },
  "itemsPath": "files",
  "fingerprintField": "modifiedTime",
  "intervalMs": 120000
}'
```

Emits `gws:drive:changed` once per edit (the dedupe key includes `modifiedTime`). Drive's search language can't filter by file id, so match by name.

To put the content and a diff in the payload, add `content`, and the agent sees what changed without any follow-up calls:

```bash
amb sources create --topic doc --kind google --options '{
  "api": "drive.files.list",
  "params": { "q": "name = \"Implementation Plan\" and trashed = false", "fields": "files(id,name,modifiedTime,mimeType)" },
  "itemsPath": "files",
  "fingerprintField": "modifiedTime",
  "content": { "format": "auto" },
  "intervalMs": 120000
}'
```

Events then carry `content` (full exported text) and `contentDiff` (unified diff vs the last seen version; `null` on first sighting). `format: "auto"` exports Docs as markdown, Sheets as CSV (first sheet), Presentations as text. Override with `"format": "text" | "csv" | "markdown"`. Export is capped at 500KB; non-Google-native files report `contentError` instead.

### 3. GitHub: PRs by author, or a specific PR's comments/CI (for a reviewer agent)

Needs `~/.amb/github/credentials.json` (`amb config init --kind github`). The `github` kind is resource-discriminated (ADR-0008).

Repo-wide PR discovery by author (`resource: search`):

```bash
amb topics create prs --retain 100
amb sources create --topic prs --kind github --options '{
  "repo": "owner/repo",
  "resource": "search",
  "queries": [{"name": "my-prs", "q": "is:pr is:open author:owner"}],
  "intervalMs": 120000
}'
```

Emits `github:search-match` when an item newly appears in a result set. Any Search syntax works: `review-requested:me`, `mentions:me`, `label:security`, and so on. `repo:` is auto-injected unless the query scopes its own.

Track a specific PR's comments, reviews, and CI (`resource: pulls`):

```bash
amb sources create --topic prs --kind github --options '{
  "repo": "owner/repo",
  "resource": "pulls",
  "prs": [142],
  "include": ["comments", "reviews", "inline-comments", "ci", "state", "head"],
  "intervalMs": 60000
}'
```

Emits `github:pr-comment`, `github:pr-review`, `github:pr-inline-comment` (diff-line comments, with `path`/`line`/`diffHunk` in the payload), `github:pr-ci` (terminal conclusions only: success, failure, cancelled), `github:pr-head` (the PR's head SHA changed, i.e. new commits or a force-push; carries `previousHeadSha` and the new commit headlines so the subscriber can tell a real change from a merge from main), and `github:pr-state` (open/merged/closed/conflicted). Like `state`, the head stream emits once as a baseline on the first poll. CI is fetched with `head_sha` server-side filtering, which matters because the events feed can't see CI at all.

The original generic feed remains available as `"resource": "events"` (the default), emitting `github:<Type>` with the `eventTypes` allowlist.

### 4. Subscribe the live sessions

```bash
amb sessions                                        # discover running agent sessions
amb subscriptions create --topic jira --agent pi --session <sessionId> --template "Ticket event: {{kind}}\n{{payload}}"
amb subscriptions create --topic doc --agent pi --session <sessionId> --template "Spec updated: {{kind}}\n{{payload}}"
amb subscriptions create --topic prs --agent claude --session <sessionId> --template "Review request: {{kind}}\n{{payload}}"
```

Templates support `{{kind}}` and `{{payload}}` (pretty-printed JSON); omit `--template` for a sensible default. Events push into the live session, so the agent reacts mid-conversation.

## How it works

```
event sources ──poll──▶ topics ──subscription──▶ delivery adapter ──push──▶ agent session
                              │
                              └── retainN event buffer (SQLite) + SSE live feed + UI
```

Subscriptions bind a `sessionRef = { agent, sessionId }` to a topic. The server renders events through the subscription's template and pushes them through per-agent delivery adapters that share one interface (`listSessions()`, `deliver()`). All three adapters signal the live process rather than appending to a headless resume.

Polling is the baseline: every source pulls on an interval, so nothing has to be reachable from the internet. Webhooks are an optional opt-in tier. The broker can open a shared tunnel (smee by default; `127.0.0.1` stays closed) and register per-source vendor webhooks against it. Jira Cloud and Google realtime webhooks are vendor-gated and stay poll-only.

## Sources

| Source | `kind` | How it polls |
|---|---|---|
| Any URL (Slack thread, file, ticket, PR…) | `polled-url` | fetch + ETag/sha256 change detection |
| GitHub | `github` | octokit SDK, `resource`-discriminated (ADR-0008): `events` (repo event feed), `search` (saved queries: `author:`, `review-requested:`, `mentions:`…), `pulls` (per-PR comments/reviews/CI/state) |
| Jira | `jira` | Atlassian REST `rest/api/3/search/jql`; `key@updated` cursor |
| Google | `google` | googleapis SDK as the logged-in developer; Drive/Sheets/Docs endpoints (`drive.files.list`, `sheets.spreadsheets.values.get`, …) |
| Generic webhook | `generic-webhook` | opt-in tier; envelope `{type,id,occurredAt,payload}` → `webhook:<type>` |

## Agent delivery

| Agent | Mechanism | Verification |
|---|---|---|
| pi | direct push via pi-intercom broker protocol (unix socket; steers between turns) | automated e2e against a real broker |
| claude | direct post to the session's inbox unix socket (optional auth-token first frame) | manual: `npx tsx scripts/verify-claude.mts <sessionId>` |
| codex | direct `codex app-server` JSON-RPC (`turn/steer` when active, else `turn/start`) | manual: `npx tsx scripts/verify-codex.mts <threadId>` |

Manual verification needs the target CLI authenticated once by a human. Claude delivery is additionally subject to the target session's `crossSessionInbound` controls; untokenized broker posts may show a hold-for-approval notice. For pi, the automated e2e covers broker-level delivery, and `npx tsx scripts/verify-pi-live.mts <sessionId>` additionally exercises the live interactive `steer` path against a real pi session.

## Configuration

### Server environment

| Variable | Default | Purpose |
|---|---|---|
| `BROKER_PORT` | `4733` | HTTP port |
| `BROKER_DB` | `~/.amb/broker.db`¹ | SQLite path (`:memory:` for ephemeral) |
| `BROKER_TOKEN` | auto-generated¹ | bearer token for the API |
| `BROKER_UI_DIR` | packaged UI | serve a different UI build |
| `BROKER_LOG` | off | `1` enables request logs |

¹ Auto-generated at `~/.config/agent-message-broker/token` (mode 0600); the CLI reads it automatically. `BROKER_DB` resolves in order: explicit option → `$BROKER_DB` → existing `./broker.db` (dev/back-compat) → `~/.amb/broker.db` (honoring `$AMB_HOME`).

### Source credentials

Credentials are config-first: each kind reads `~/.amb/<kind>/credentials.json` (mode 0600), never the broker DB.

```bash
npx agent-message-broker config init                  # scaffold github|jira|google templates
```

| Kind | Shape |
|---|---|
| `github` | `{ token }` |
| `jira` | `{ email, apiToken, domain }` |
| `google` | OAuth client (installed/web), written by the login flow; service-account and authorized-user gcloud shapes also load as fallbacks |

Google uses a per-developer OAuth loopback flow:

```bash
npx agent-message-broker google login --credentials=<downloaded-oauth-client.json>
```

`amb google login` performs consent once: it installs your downloaded OAuth client at `~/.amb/google/credentials.json` (0600), runs a localhost consent handshake (ephemeral port, browser opens, code captured, token exchanged), and caches the token at `~/.amb/google/token.json` (0600). The google feed then acts as you, which is what gives it access to Drive, Sheets, and Docs. The cached token auto-refreshes thereafter.

## Security model

- The server binds to 127.0.0.1 only; the bearer token blocks other local processes (and web pages you visit) from driving the broker.
- Credential files live on disk at `~/.amb/<kind>/credentials.json`, mode 0600, verified by the loader (world-readable files are rejected). They never enter the broker DB or `Source.options`.
- The live e2e harnesses stage credentials into ephemeral temp homes that are deleted on exit, so tests never read your real `~/.amb`.

## Development

nx + npm workspaces. Projects: `core` (types/DeliveryAdapter), `server` (Fastify + SQLite + SSE), `ui`, `cli`, `adapter-pi|claude|codex`.

```bash
npm run verify             # build + test all 8 projects
npm run e2e                # offline full-system e2e
npx tsx scripts/e2e-feeds.mts    # live github+jira feed e2e (needs E2E_* env)
npx tsx scripts/e2e-google.mts   # live google sheets+docs feed e2e (needs consent-derived token)
```

The live harnesses source account-specific values from `.env` or the environment. Copy `.env.example` to `.env` and fill in your own (each key is commented; CI maps the same names to its secret store).

The feed abstraction is the core model: sources poll vendor APIs through injectable SDK runners (never CLI exec), publish typed events to topics, and fail loudly on credential problems.

## License

[MIT](LICENSE)