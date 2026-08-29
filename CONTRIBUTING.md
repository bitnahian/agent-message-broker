# Contributing

Thanks for your interest in contributing! This stub covers the minimum; more detail will land as the project matures.

## Setup

```bash
npm install          # Node >= 22.5 (uses node's built-in SQLite)
npm run verify       # build + test all 7 workspace projects
```

Copy `.env.example` to `.env` if you want to run the live e2e harnesses against your own vendor accounts — see [docs/agents/e2e-secrets.md](docs/agents/e2e-secrets.md) for the key contract. Never commit `.env`, `.secrets/`, or any credential material.

## Ground rules

- **Build + test must pass** before every commit: `npm run verify`.
- Work on `feature/<name>` branches off `master`. Commit messages are short, imperative, prefixed by area: `ui:`, `server:`, `cli:`, `core:`, `adapter-<agent>:`, `docs:`, `repo:`.
- Keep coverage ≥ 80% statements and branches per package (`bash scripts/verify-coverage-80.sh`).
- New source kinds follow the Feed abstraction: an injectable SDK runner (no CLI exec), config-first credentials, loud credential errors.
- No secrets, tokens, or personal account data in code, tests, docs, or fixtures — account-specific values belong in `.env` (gitignored).

## Design principles

Substantive architectural changes should be floated in an issue or PR description before implementation. The core principles new work must respect:

- **Local-first**: the broker binds `127.0.0.1` and polls out; nothing requires inbound reachability.
- **Live push, not headless resume**: deliveries steer the agent's running session; no background appending to dead sessions.
- **Feeds, not CLI exec**: sources call vendor SDKs/REST through injectable runners, never shell out to `gh`/`acli`-style CLIs.

## Reporting bugs

Open an issue with: what you ran, what you expected, what happened, and relevant broker logs (`BROKER_LOG=1`). Redact tokens and session identifiers.
