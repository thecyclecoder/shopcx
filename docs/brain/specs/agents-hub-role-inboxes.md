# Agents hub + role inboxes ⏳

**Owner:** [[../functions/platform]] · **Parent:** M1 — Agents hub + role inboxes

The foundation surface for the [[../goals/devops-director]] goal — an owner-only **"Agents" hub** that renders the live org chart (CEO · Directors · Workers) read from the brain, and gives every role the **same three-tab inbox shell** (Messages · Approval Requests · Daily Summaries) that M2/M3/M4 fill. Today there is no single place to see the org or its queues — approvals scatter across the Control Tower feeds, spec cards, and the box page ([[../operational-rules]] default `approvalHref`), and [[../tables/dashboard_notifications]] is a generic bell, not a role-routed inbox. This milestone formalizes today's reality (no director is live → **everything lands in the CEO inbox**) into one consolidated surface, and lands the reusable **director-persona + SVG-mascot design-system piece** (🛠️ Ada/Platform · 🚀 Max/Growth · 🎨 Iris/CMO · 💬 June/CS · 🧲 Theo/Retention · 👑 CEO) every later milestone reuses. Success metric served: the CEO reads **one inbox**, not N scattered surfaces — the precondition for "% of platform approvals you never have to touch" to even be measurable.

## Phase 1 — org-chart reader → the Agents hub sidebar ⏳
- ⏳ planned
- Read the org chart from the brain via [[../libraries/brain-roadmap]] `getFunctionMap()`/`getFunctions()` (the `functions/*.md` directors + their mandates) and `getGoals()` (the `goals/*.md` finite goals) — **no new parser**; reuse the existing markdown-as-data source. Workers = the existing [[../tables/agent_jobs]] `kind`s (the box lanes) grouped under their owning function.
- New owner-only route `src/app/dashboard/agents/` (sibling of `/dashboard/developer/control-tower`): a left nav listing **CEO → Directors → Workers**, each director row showing its persona chip (name/color/mascot) + a live/autonomous badge (the flag itself lands in M2). Owner-gated like the Control Tower (workspace owner only).

## Phase 2 — the director-persona + SVG-mascot design system ⏳
- ⏳ planned
- A reusable `src/lib/agents/personas.ts` (+ brain page `libraries/agent-personas.md`) mapping each function slug → `{ name, color, personality, mascotSvg }` for the cast (Ada/Max/Iris/June/Theo + CEO). Mascots are inline SVG components in `src/components/agents/` so M3's board can render them without an asset pipeline.
- Persona data is **reskinnable** (names/mascots are config, per the goal) and keyed by function slug so a new director inherits a persona by adding one entry — the template every other director reuses.

## Phase 3 — the three-tab inbox shell (CEO inbox live first) ⏳
- ⏳ planned
- Each role page renders three filterable tabs — **Messages** (the board; populated by M3), **Approval Requests** (the routed queue; populated by M2), **Daily Summaries** (EOD recaps; populated by M3/M4). This milestone ships the **shell + filters + empty/loading states**; the CEO inbox is wired live first so M2 has a real target to emit into.
- Reuse [[../tables/dashboard_notifications]] as the backing store for the shell where it fits (it already has `type`/`title`/`body`/`link`/`read`/`dismissed`), or add a thin `agent_inbox_items` view — decided at build time against the live schema (probe first, per [[../README]] § Probing technique). No approval-routing logic here — that is M2's keystone.

## Safety / invariants
- **Owner-only.** The Agents hub + every inbox is gated to the workspace owner (mirror the Control Tower gate); no member-facing surface in this milestone.
- **Brain is the source of truth.** The org chart renders from `functions/*.md` + `goals/*.md` via [[../libraries/brain-roadmap]] — never a hand-maintained second copy of the org chart (no drift).
- **Shell, not engine.** This milestone ships surfaces + personas only. Approval routing (M2), the board's two-way posts (M3), and the live director (M4) write *into* these tabs later — do not pre-build their logic here.
- **Reskinnable personas.** Names/mascots/colors are config in one file, never hardcoded across components ([[../operational-rules]]).

## Completion criteria
- `/dashboard/agents` renders the live org chart (CEO · Directors · Workers) read from `functions/*.md` + `goals/*.md` via [[../libraries/brain-roadmap]], owner-gated.
- A reusable persona/mascot module exists with the full cast (Ada/Max/Iris/June/Theo + CEO), reskinnable from one config file, with a brain page.
- Every role exposes the three-tab inbox shell (Messages · Approval Requests · Daily Summaries) with working filters; the CEO inbox is live and ready to receive M2's routed approvals.
- Brain pages written for the new route + persona library; cross-linked from [[../goals/devops-director]].

## Verification
- On `/dashboard/agents` as the workspace owner, expect the left nav to list **CEO** plus one row per `docs/brain/functions/*.md` director (Platform/Growth/CMO/CS/Retention) each with a persona chip + mascot, and Workers grouped from the [[../tables/agent_jobs]] kinds — matching the files actually present in `functions/`.
- As a non-owner member, hitting `/dashboard/agents` → expect the owner-only gate (redirect/403), same as the Control Tower.
- Open the CEO inbox → expect three tabs (Messages · Approval Requests · Daily Summaries) with filters; empty states render (no crash) before M2/M3 populate them.
- Add a new function `.md` under `docs/brain/functions/` (or rename a persona in the config) → reload → expect the hub to reflect it with no code change (brain-driven + reskinnable).
