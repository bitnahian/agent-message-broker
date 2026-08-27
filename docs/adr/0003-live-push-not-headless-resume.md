# ADR-0003: Live Push Delivery, Not Headless Resume

**Date:** 2025-08-20  
**Status:** accepted

## Context

Each agent supports two ways to inject a message:

- **Headless resume**: spawn a new process (`claude -p "message" --resume <session>`, `codex exec resume <threadId>`). The message appends to the session transcript as if the user typed it, but the process creates a fresh model turn — and there's no way to steer an already-running turn.
- **Live push**: deliver into the *already-running* session process via its IPC surface. pi's intercom broker, Claude's inbox socket, and Codex's JSON-RPC daemon all accept in-process injection. An active turn can be steered; an idle session starts a new turn.

The broker's stated use case is "subscribe your running sessions to events and let them steer agents reactively." Reactive steering — injecting an event mid-turn so the agent can adjust — requires live push. Headless resume always starts a *new* turn, which means the agent can't respond to an event that arrives while it's already working.

## Decision

All three adapters signal the **live process** — never headless-resume:

- **pi**: connects to the intercom broker socket, registers as a synthetic session, uses `send` to push a message into the target session. Delivery is immediate and the receiving session can process it between turns.
- **Claude**: posts a message frame to the session's inbox unix socket. The target session processes it subject to `crossSessionInbound` controls, delivering between tool calls or when the session is idle.
- **Codex**: calls `thread/resume` to get the active turn, then `turn/steer` (active turn) or `turn/start` (idle). Steering injects the message into the current turn's context.

Live delivery is authenticated where the agent requires it: Claude supports an optional `{ type: "auth", token }` frame; Codex runs over the user's own `codex login` session.

## Consequences

- **Steering works**: the primary use case (event arrives while agent is working → agent reacts) is possible with Codex. Pi and Claude deliver between turns or when idle — not mid-turn, but without spawning a new process.
- **No process-per-delivery**: the broker doesn't fork on every event. Delivery is a socket write (pi, claude) or a JSON-RPC call (codex), all O(1) IO.
- **Requires running sessions**: an agent session must be alive to receive. The broker's `listSessions()` on each adapter discovers only running sessions. Headless resume would work on any session log, live or not — but at the cost of spawning a process and losing steering.
- **Session ownership**: the broker doesn't start sessions. The user starts an agent session normally, and the broker discovers it and pushes in.

## Alternatives considered

- **Headless resume for all**: would work on sessions that aren't currently running, but would lose mid-turn steering entirely and fork a new process per delivery (expensive at scale). Rejected because the steering use case is the whole point.
- **Both modes, adapter-configured**: each adapter could expose `deliverLive` and `deliverHeadless`. Rejected as over-parameterization — no adapter needs both today, and the live push path covers all current agents.