## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

---

## Development Cycle

### Before every commit or iteration

1. **Build**: `npm run build` must pass all 7 nx projects.
2. **Test**: `npm run test` must pass all 7 projects.
3. **E2E**: If UI files changed (`packages/ui/src/`), run `cd packages/ui && npx playwright test` against a running broker.
4. **Lint the diff**: Review the commit diff for the following before committing:
   - No `node_modules/`, `.nx/`, `dist/`, or `broker.db*` files in the diff.
   - No `.vite/` cache dirs or `test-results/` artifacts.
   - No `console.log` calls left in production code.
   - No `text-[10px]` or other sub-12px text (per DESIGN.md 12px floor rule).
   - No glyph emoji in UI text (per DESIGN.md craft-floor).

### Git hygiene

- The `.gitignore` covers `node_modules/`, `dist/`, `.nx/`, `*.db` and `*.sqlite` broker data files, `test-results/`, `playwright-report/`, `.vite/`, `*.tsbuildinfo`, and OS/editor temp files.
- If a new kind of generated, cache, or data file appears, add it to `.gitignore` before committing.
- Never `git add` files that match a gitignore pattern. If `git status` shows ignored files as modified, they were tracked before the gitignore was added — run `git rm --cached` on them first.
- `package-lock.json` is tracked (it's the lockfile). `npm install` changes to it are expected.
- `node_modules/` is not tracked. It was mass-removed from the index; do not re-add it.

### Branch and commit convention

- Work on feature branches (`feature/<name>`) off `master`.
- Commit messages are short, imperative, and prefixed with the affected area: `ui:`, `server:`, `cli:`, `core:`, `adapter-<agent>:`, `docs:`, `repo:`.
- Squash fixup commits before merging. Each commit should leave the repo in a buildable, testable state.
- Commit after each meaningful unit of work, not after every file save.

### Design system

- The visual system is documented in `DESIGN.md` (The Local Exchange). All UI changes must respect its rules:
  - Signal Blue (`#4f46e5`) is for primary actionable paths only. Never for passive links or chrome.
  - Mono font is for data only (event payloads, session IDs, timestamps). Not for UI labels.
  - No text below 12px (`text-xs` is the floor).
  - No glyph emoji as icons. Inline SVG is acceptable.
  - Flat-by-default: tonal separation, not shadows. Only the toast stack earns a shadow.
- `PRODUCT.md` carries durable product truth. Update it when product facts change.
- `CONTEXT.md` carries the domain glossary. Update it when a new term is settled.
- Before changing the visual system, run `/impeccable document` to update `DESIGN.md` and `.impeccable/design.json`.

### Before asking an agent to design or implement

- Run `/impeccable critique` on the affected surface before large design changes.
- Run `/impeccable shape` before any new surface or major layout change.
- Keep an implementation log at `docs/implementation-log/iteration-NN.md` for each significant iteration. The log should record what changed, what was verified, and any deferred decisions.