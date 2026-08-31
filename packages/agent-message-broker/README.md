# agent-message-broker

A local message broker for coding agents. Wire event sources (GitHub, Jira, Google Workspace, any polled URL, generic webhooks) to **topics**, subscribe **running coding-agent sessions** (pi, Claude Code, Codex) to those topics, and let events steer them reactively — no per-agent background scripts.

## Quickstart

Requires **Node >= 22.5**.

```bash
npx agent-message-broker          # broker + API + UI at http://127.0.0.1:4733
```

In another terminal (or from an agent):

```bash
npx agent-message-broker topics create prs --retain 50
npx agent-message-broker sources create --topic prs --kind github --options '{"repo":"cli/cli"}'
npx agent-message-broker sources start <sourceId>
npx agent-message-broker sessions                                # discover live agent sessions
npx agent-message-broker subscriptions create --topic prs --agent pi --session <sessionId> --template "PR event: {{kind}} {{payload}}"
```

Events now push into the live agent session. The UI at http://127.0.0.1:4733 is for live viewing, orchestrating and following event flow; the `amb` CLI can do everything, so agents can wire subscriptions themselves.

Optional: Google Workspace sources need the (large) `googleapis` package — `npm install -g googleapis` alongside the broker.

See the [GitHub repo](https://github.com/bitnahian/agent-message-broker) for the full docs, source layout, and how it works.
