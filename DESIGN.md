---
name: agent-message-broker
description: Local-first event broker for steering coding-agent sessions
colors:
  signal-blue: "#4f46e5"
  signal-blue-soft: "#6366f1"
  signal-blue-deep: "#4338ca"
  canvas: "#09090b"
  canvas-raised: "#18181b"
  panel: "#18181b"
  text-primary: "#f4f4f5"
  text-secondary: "#e4e4e7"
  text-body: "#d4d4d8"
  text-muted: "#a1a1aa"
  text-faint: "#71717a"
  text-subtle: "#52525b"
  border-line: "#3f3f46"
  border-soft: "#3f3f46"
  live: "#34d399"
  test-event: "#fbbf24"
  error: "#f87171"
  codex-agent: "#c084fc"
  event-generic: "#60a5fa"
  toast-success: "#022c22"
  toast-error: "#450a0a"
typography:
  display:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.25
  headline:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.75rem"
rounded:
  md: "6px"
  lg: "8px"
  full: "9999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.signal-blue}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
  button-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text-body}"
    rounded: "{rounded.md}"
    padding: "0.375rem 0.75rem"
  input-field:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.75rem"
  card-panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.lg}"
    padding: "0.75rem"
---

# Design System: agent-message-broker

## Overview

**Creative North Star: "The Local Exchange"**

agent-message-broker is a local-first exchange where event signals are routed from sources to live coding-agent sessions. The interface is a control room that mirrors the terminal the developer already lives in. Every surface is a channel; every accent is a confirmed signal whether something is live, flowing, waiting, or down.

This is an **Operate** surface: the developer comes to complete a task, not to be entertained. The system earns its craft through practiced restraint: a dark zinc canvas calibrated to reduce glare for hours-long sessions, an indigo primary that means only one thing (the actionable path), and a strict semantic language where green means *live*, amber means *test/manual*, and red means *error/destructive*. Density is a feature; nothing decorative.

The aesthetic philosophy is **terminal-as-dashboard**: a command-line ethos rendered as a web shell. Type stays human (a clean system sans), data stays monospace (event payloads, session IDs, timestamps all render in a fixed-width face so streams line up like logs). The whole composition is a faithful, legible instrument panel.

**Key Characteristics:**
- A dark, high-contrast zinc instrument panel tuned for long developer sessions
- Indigo (Signal Blue) reserved strictly for primary actionable paths
- Semantic status color as the only personality: live/connected green, test amber, error red, codex purple
- Terminal-honest typography: sans for chrome, monospace for data
- Structure communicates routing: a topic is a channel and everything about it lives in one surface

## Colors

A cold, dark, high-contrast palette built on Tailwind zinc, with a single restrained indigo action accent and a strict semantic status layer. The palette is deliberately monochrome-first so the status colors remain authoritative signals.

### Primary
- **[Signal Blue]** (`#4f46e5`): The single primary action color. Used for main CTAs (Create, Subscribe, Publish), the active topic's left-rail indicator, and the active tab's bottom rule. It appears on the actionable path only — never on passive links, helper text, or generic chrome.
- **[Signal Blue — Soft]** (`#6366f1`): Primary button hover state. Slightly lifted to signal readiness.
- **[Signal Blue — Deep]** (`#4338ca`): Pressed/active primary button and the selected-topic rail background tint.

### Neutral
- **[Canvas]** (`#09090b`): The base application background. Near-black, low-glare.
- **[Canvas Raised]** (`#18181b`): Elevated surfaces. Used behind secondary action buttons and the raised panel rows.
- **[Panel]** (`#18181b`): The card/panel background behind clustered content.
- **[Text — primary]** (`#f4f4f5`): Body text, the app shell foreground.
- **[Text — secondary]** (`#e4e4e7`): Strong headings and active tab text.
- **[Text — body]** (`#d4d4d8`): Event payload content and secondary body text.
- **[Text — muted]** (`#a1a1aa`): Inactive tab text, subscription target labels.
- **[Text — faint]** (`#71717a`): Helper text, muted captions. Contrast approx 5.3:1 on Canvas.
- **[Text — subtle]** (`#52525b`): The most de-emphasized metadata (truncated IDs, template previews). Secondary-only.
- **[Border — line]** (`#3f3f46`): Form-control borders and stronger separators.
- **[Border — soft]** (`#3f3f46`): Structural panel separators. Delineates depth without shadows.

### Semantic
- **[Live]** (`#34d399`): A connected, flowing, or running state. Counts in the top bar, the running badge, success toasts.
- **[Test / Manual]** (`#fbbf24`): A manually published or laboratory event, rendered less authoritative than real stream data.
- **[Error]** (`#f87171`): Errors and destructive actions. Deletes, failed events, error toasts.
- **[Codex Agent]** (`#c084fc`): The Codex agent identity, distinct from pi and claude.
- **[Generic Event]** (`#60a5fa`): An event kind with no special status meaning.

### Named Rules
**The Signal Blue Rule.** Signal Blue is the actionable path, and only the actionable path. If a stroke of indigo does not lead to a user action, remove it. Its rarity is what makes the CTA obvious.

**The Semantic Only Rule.** Color carries meaning or it is absent. Green means live, amber means manual, red means error. If a color is not communicating one of those, it comes out.

## Typography

**Display Font:** ui-sans-serif, system-ui, sans-serif
**Body Font:** ui-sans-serif, system-ui, sans-serif
**Monospace Font:** ui-monospace, SFMono-Regular, Menlo, monospace

**Character:** A single humanist system-sans family carries all chrome and prose, favoring legibility and density over display flares. The only counterpoint is a fixed-width face reserved for data so event streams and identifiers read like logs.

### Hierarchy
- **Display** (700, 1.25rem/20px, 1.25): The topic name in the detail header. The largest type in the interface; rare.
- **Headline** (600, 1.125rem/18px, 1.3): The empty-state title "Select a topic". Section-level emphasis.
- **Body** (400, 0.875rem/14px, 1.5): Primary control and content text. The reading floor for interactive content.
- **Label** (500, 0.75rem/12px, 1.4): Form field labels, badges, helper text, status text. Compact but AA-safe.
- **Mono** (400, 0.75rem/12px, 1.4): Event payloads, session IDs, timestamps, template previews. Fixed-width so log-style streams align vertically.

### Named Rules
**The Mono-Is-Data Rule.** Monospace renders only data and code: event payloads, session IDs, timestamps. Chrome and labels stay in the system sans.
**The 12px Floor Rule.** Secondary and label text never falls below 12px. Metadata sits visually subordinated through color (zinc-500/600) and weight, never by shrinking below the legible floor.

## Layout

A two-region shell with a persistent left topic rail and a context-aware detail surface, stacked inside a full-height viewport.

- **Top bar**: the status strip of the exchange. Left: the app title. Right: live session counts per agent, offline indicator, Refresh action.
- **Left rail**: fixed 256px, border-delineated. Top: topic creation form. Below: the scrollable topic list. Active topic gains a 2px Signal Blue left rail.
- **Detail surface**: the selected topic's channel. Header (name + retain/source/subscriber counts + id), 3-tab rule (Events / Sources / Subscriptions), scrollable content.
- **Spacing rhythm**: tight component groups (8-12px) with generous region separation (24px gutters). Intentional density for a monitoring instrument.
- **Responsive**: the shell assumes a desktop coding environment. Collapsing the rail on narrow screens is the expected structural change.

## Elevation & Depth

The system is **flat-by-default** and conveys depth through **tonal layering** (background tint + border separation) rather than shadows. This is a deliberate nod to the dark control-room aesthetic — panels sit on the canvas as quieter surfaces, delineated by zinc borders and opacity fills, not by drop shadows.

The one genuine shadow in the system is the toast stack (`shadow-lg`) — a deliberate, brief rise out of the flow to claim attention for a transient notification, then it is gone. Everything else is flat.

### Named Rules
**The Flat-by-Default Rule.** Surfaces are tonally separated, not shadowed. Depth comes from raised fills (zinc-900) and borders (zinc-800) on the zinc-950 canvas. The only shadow is the transient toast.

## Shapes

A restrained corner language tuned for density: **6px** (`rounded-md`) for interactive controls, **8px** (`rounded-lg`) for grouped containers, and **full/9999px** for status badges. The range is narrow because corners are quiet in a terminal-instrument. Borders are hairline (1px) separators in zinc.

## Components

### Buttons
- **Shape:** gently curved, compact (6px radius).
- **Primary:** Signal Blue bg, white text, 0.5rem 1rem padding, 14px/500. Hover lifts to Signal Blue Soft. Disabled at 40% opacity. This is the only button that carries the accent color.
- **Secondary:** canvas-neutral (zinc-800 bg), muted text, 0.375rem 0.75rem padding, 12px/500. Used for non-primary actions (Browse retained, Refresh, Start/Stop source).
- **Danger:** red-600 bg, white text, full-height padding. Used for destructive confirmation. Wrapped in a two-step confirm gate (click to arm, then confirm or cancel).

### Inputs / Fields
- **Style:** canvas background, border-line stroke, 6px radius, 0.5rem 0.75rem padding, 14px text. Focus shifts the border to Signal Blue with a subtle ring glow.
- **Placeholder:** zinc-600 text, deliberately dim to stay behind user input.
- **Textarea (JSON):** same style, fixed-width font, taller (`h-20`/`h-24`) for structured data entry.

### Status Badges
- **Style:** inline flex, rounded-full, 0 0.375rem padding, 12px/500. The badge is a compact tag that signals a single state: running (emerald), stopped (zinc), test (amber), error (red). Color is the payload; the word is the confirmation.

### Cards / Panels
- **Style:** 8px radius, panel background, soft border, 0.75rem internal padding. Each source row, subscription row, and event row is a card-panel. Hover lifts the row (`hover:bg-zinc-800/30`), giving a subtle depth cue.

### Navigation
- **Style:** the tab bar under the topic header uses a 2px bottom-border indicator (Signal Blue for active, transparent for inactive). Inactive tabs are text-muted, hover to text-secondary. No button shapes, no filled backgrounds — the active state is a single line, consistent with the terminal-chrome aesthetic.

## Do's and Don'ts

### Do:
- **Do** use Signal Blue for the one primary action on a surface. Every other button is secondary or danger.
- **Do** use `text-xs` for metadata and labels. Use color (zinc-500/600) for de-emphasis, never size.
- **Do** use monospace for event payloads, session IDs, timestamps, and template previews.
- **Do** use two-step confirm on all destructive actions (delete source, delete subscription, delete topic).
- **Do** keep the flat-by-default elevation. Only the toast earns a shadow.

### Don't:
- **Don't** use Signal Blue for passive links, helper text, or decorative chrome. The accent is the actionable path.
- **Don't** use glyph emoji as icons. Text labels and Unicode typographic characters (like ✕) are acceptable; drawn icons belong in a future icon system.
- **Don't** use text-[10px] or any size below 12px for user-facing text.
- **Don't** add shadows to panels, cards, or the sidebar. Tonal separation is sufficient.
- **Don't** use a display font or any font beyond the system sans + monospace pair.