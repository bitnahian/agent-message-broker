# E2E secrets & env contract

The live e2e harnesses (`scripts/e2e-*.mts`) run against real vendor APIs. They
resolve every account-specific value through **one resolver**
(`scripts/e2e-secrets.mts`) with a single precedence:

1. **process environment** — how CI supplies secrets
2. **repo-root `.env`** (gitignored) — local fallback, `KEY=VALUE` lines

Nothing personal (emails, domains, projects, tokens) is ever hardcoded in
harness code or committed. Copy `.env.example` → `.env` and fill in your own
values. Unit tests and CI tier-1 (`npm run test`) never need any of these.

## Keys

| Key | Used by | Notes |
| --- | --- | --- |
| `E2E_GITHUB_TOKEN` | `e2e-feeds.mts` | PAT that seeds + deletes a throwaway private repo; repo scope is enough |
| `E2E_JIRA_EMAIL` | `e2e-feeds.mts` | account the API token belongs to |
| `E2E_JIRA_API_TOKEN` | `e2e-feeds.mts` | Atlassian API token |
| `E2E_JIRA_DOMAIN` | `e2e-feeds.mts` | `your-site.atlassian.net` |
| `E2E_JIRA_PROJECT` | `e2e-feeds.mts` | sandbox project key for throwaway tickets |
| `E2E_GITHUB_REPO_PREFIX` | `e2e-feeds.mts` | optional; default `amb-e2e-` |
| `E2E_GOOGLE_CLIENT_JSON` | `e2e-google.mts` | optional; whole OAuth client JSON. Falls back to `.secrets/google-oauth-client.json` |
| `E2E_GOOGLE_TOKEN_JSON` | `e2e-google.mts` | optional; whole `token.json` blob. Falls back to `~/.amb/google/token.json` (from `amb google login`) |

## Harness behavior (what makes this CI-safe)

- Each run stages an **ephemeral `AMB_HOME`** (temp dir, files mode 0600),
  spawns the broker with `AMB_HOME` pointed at it, and deletes it in
  `finally` — real credentials never enter the repo or the broker DB.
- Seeded cloud resources (throwaway repo, Jira ticket, scratch spreadsheet)
  are created with a timestamp stamp and deleted in `finally`.
- Missing keys fail **loud and early** with the exact fix (which env var, which
  doc), never silently skip.

## CI mapping

- Tier 1 (`npm run test`): no secrets, always runs.
- Tier 2 (github/jira live): set the `E2E_GITHUB_*` / `E2E_JIRA_*` keys as CI
  secrets; run on your own branches only (not untrusted PRs).
- Tier 3 (google live): requires a consent-derived token
  (`amb google login`). Either store the token blob as the
  `E2E_GOOGLE_TOKEN_JSON` secret in a manual `workflow_dispatch` job, or keep
  it local-only — note Google expires refresh tokens of unverified "Testing"
  consent screens after 7 days of non-use, so CI cannot rely on it long-term.

## Rotation notes

- GitHub PAT / Jira API token: rotate on your normal schedule (≤1 year).
- Google refresh token: re-run `amb google login` whenever the e2e reports
  `invalid_grant` (testing-mode consent screens lapse after ~7 idle days).
