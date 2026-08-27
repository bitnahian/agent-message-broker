# Surface Brief: Topic Dashboard

**Target:** `packages/ui/src/App.tsx`
**Mode:** Operate (task-completion developer surface)
**World:** The Local Exchange / terminal-as-dashboard (see `DESIGN.md`)

## 1. Job and Audience

A developer on their own machine, running coding agents locally, opens the dashboard to observe and control the flow of event signals into their agent sessions. Visitor mode is Operate — they come to complete a task (subscribe a session, watch events, audit delivery), not to be entertained. They already live in a terminal; the dashboard should feel like a control room for the broker, not a generic admin panel.

## 2. Outcome and Proof

**Primary task:** Subscribe a running agent session to a topic (and observe events flowing into it).

**Success looks like:** The developer lands, sees their topic channels, opens one, and in seconds knows which sources feed it, which sessions subscribe, and whether events are flowing. When they subscribe, they get unmistakable confirmation the action worked.

**Product-specific truth the surface must carry:** The broker *routes signals from sources to live sessions*. The dashboard should communicate that a topic is a **channel** with sources feeding in and sessions listening out — not a row in a generic table.

## 3. Selected Direction

- **Visual authority:** The incumbent system as documented in `DESIGN.md` — The Local Exchange. Dark zinc instrument panel, Signal Blue actionable path only, semantic status (green=live, amber=test, red=error, purple=codex), terminal-honest typography (mono for data), flat-by-default depth.
- **Structural thesis:** A topic is a channel. Everything about one topic lives in one surface — its sources (in), its events (thrthrough), its subscribers (out). The three-tab detail panel already reflects this; keep it.
- **Sequence:** Land → see channel list (topic rail) → select channel → inspect / act. The rail should be the primary; the detail surface needs an engaging empty/launch state.
- **Focal moment:** The live event stream. When events are flowing, the Events tab should feel alive — this is the "exchange" happening.

## 4. Scope and Boundaries

**Fidelity:** Refinement to the existing implementation — extend the incumbent system, do not replace its visual world.

**Target:** `packages/ui/src/App.tsx`

**What stays untouched:**
- The topic-rail + detail-surface two-region layout.
- The three-tab detail panel (Events / Sources / Subscriptions).
- The semantic status language and Signal Blue primary.
- All product behavior: topics, sources, subscriptions, sessions, events, toasts, two-step delete confirm, launch hints.

**Explicit anti-goals:**
- No new technology / framework / routing library. Stay single-file React + Tailwind.
- No redesign of color tokens; no new fonts (system sans + mono only).
- No new backend endpoints unless truly required.

## 5. States and Ranges

**Must handle:**
- **First run:** no topics, no sources, no sessions, fresh install. Biggest gap — needs a guided launchpad instead of a bare empty rail.
- **No topics:** the sidebar is empty; "Select a topic" empty state must teach the create flow.
- **No sessions:** the launch-hint guidance (already implemented) persists.
- **No events:** Events tab empty state persists.
- **Live flow:** events streaming into a topic (the focal moment).
- **Source error / delivery failure:** semantic status surfaces it.
- **Overflow:** many topics / many sessions — the unbounded session picker and topic list need no new machinery but should remain scrollable.

**Data ranges:** topics (0–dozens), sources per topic (0–5), sessions per agent (0–many), events (0–200 retained + live).

## 6. Interaction and Layout

- **Hierarchy:** Signal Blue is the actionable path ONLY. Primary CTA per surface (Create, Subscribe, Publish) is the only indigo strong fill. Everything else is neutral.
- **Topology:** keep the two-region shell (top bar + rail + detail). No new top-level navigation.
- **Link affordances:** summary actions ("+ Add source", "+ Subscribe agent") stay as muted underlined links (neutral, not CTA-strength).
- **Feedback:** toasts carry all transient success/error; two-step confirm on destructive actions; the "just subscribed" row highlight persists.
- **Empty/first-run:** replace the generic "Select a topic" with a guided launchpad that names the 3-step flow (Create Topic → Add Source → Subscribe Agent).
- **Live signal:** consider a compact event-throughput pulse in the top bar or a fixed bottom ticker strip so the "exchange" reads as alive even before a topic is selected. Single quiet element, serving the North Star.
- **Transitions:** quick (~150ms), state-revealing only, per the DESIGN.md motion rules.

## 7. Constraints and Open Decisions

**Binding constraints:**
- Tailwind v4 via `@import "tailwindcss"`; React 19; single-file `App.tsx`.
- Design tokens are normative in `DESIGN.md` frontmatter.
- No text below 12px; monospace only for data; Signal Blue only for CTAs/active; flat-by-default.
- Two-step confirm on all destructive actions.
- Must pass `npm run build` and `npm run test` (7 nx projects).

**Open decisions (builder must not invent, confirm with user or leave explicit):**
- Whether the "event-throughput pulse" is a top-bar indicator or a bottom ticker strip.
- The exact copy of the first-run launchpad card.
- Whether the "just subscribed" row should auto-expand the Subscriptions tab on first subscribe (currently it lives in the detail panel).