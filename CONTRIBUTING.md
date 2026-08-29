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
- New source kinds follow the Feed abstraction ([docs/adr/0005-feed-abstraction.md](docs/adr/0005-feed-abstraction.md)): an injectable SDK runner (no CLI exec), config-first credentials, loud credential errors.
- No secrets, tokens, or personal account data in code, tests, docs, or fixtures — account-specific values belong in `.env` (gitignored).

## Design decisions

Substantive architectural changes go through an ADR in [docs/adr/](docs/adr/). Read [ADR-0002](docs/adr/0002-local-first-no-inbound-webhooks.md) (local-first), [ADR-0003](docs/adr/0003-live-push-not-headless-resume.md) (live push, not headless resume), and [ADR-0005](docs/adr/0005-feed-abstraction.md) (feeds) before proposing changes to delivery or sources.

## Reporting bugs

Open an issue with: what you ran, what you expected, what happened, and relevant broker logs (`BROKER_LOG=1`). Redact tokens and session identifiers.
