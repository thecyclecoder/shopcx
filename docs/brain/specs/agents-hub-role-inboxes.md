# Agents hub + role inboxes ✅

**Owner:** [[../functions/platform]] · **Parent:** M1 — Agents hub + role inboxes

The foundation surface for the [[../goals/devops-director]] goal — an owner-only **"Agents" hub** that renders the live org chart (CEO · Directors · Workers) read from the brain, and gives every role the **same three-tab inbox shell** (Messages · Approval Requests · Daily Summaries) that M2/M3/M4 fill. Today there is no single place to see the org or its queues — approvals scatter across the Control Tower feeds, spec cards, and the box page ([[../operational-rules]] default `approvalHref`), and [[../tables/dashboard_notifications]] is a generic bell, not a role-routed inbox. This milestone formalizes today's reality (no director is live → **everything lands in the CEO inbox**) into one consolidated surface, and lands the reusable **director-persona + SVG-mascot design-system piece** (🛠️ Ada/Platform · 🚀 Max/Growth · 🎨 Iris/CMO · 💬 June/CS · 🧲 Theo/Retention · 👑 CEO) every later milestone reuses. Success metric served: the CEO reads **one inbox**, not N scattered surfaces — the precondition for "% of platform approvals you never have to touch" to even be measurable.

## Phase 1 — org-chart reader → the Agents hub sidebar ✅
- ✅ shipped
- Read the org chart from the brain via [[../libraries/brain-roadmap]] `getFunctionMap()`/`getFunctions()` (the `functions/*.md` directors + their mandates) and `getGoals()` (the `goals/*.md` finite goals) — **no new parser**; reuse the existing markdown-as-data source. Workers = the existing [[../tables/agent_jobs]] `kind`s (the box lanes) grouped under their owning function.
- New owner-only route `src/app/dashboard/agents/` (sibling of `/dashboard/developer/control-tower`): a left nav listing **CEO → Directors → Workers**, each director row showing its persona chip (name/color/mascot) + a live/autonomous badge (the flag itself lands in M2). Owner-gated like the Control Tower (workspace owner only).

## Phase 2 — the director-persona + SVG-mascot design system ✅
- ✅ shipped
- A reusable `src/lib/agents/personas.ts` (+ brain page `libraries/agent-personas.md`) mapping each function slug → `{ name, color, personality, mascotSvg }` for the cast (Ada/Max/Iris/June/Theo + CEO). Mascots are inline SVG components in `src/components/agents/` so M3's board can render them without an asset pipeline.
- Persona data is **reskinnable** (names/mascots are config, per the goal) and keyed by function slug so a new director inherits a persona by adding one entry — the template every other director reuses.

## Phase 3 — the three-tab inbox shell (CEO inbox live first) ✅
- ✅ shipped
- Each role page renders three filterable tabs — **Messages** (the board; populated by M3), **Approval Requests** (the routed queue; populated by M2), **Daily Summaries** (EOD recaps; populated by M3/M4). This milestone ships the **shell + filters + empty/loading states**; the CEO inbox is wired live first so M2 has a real target to emit into.
- Reuse [[../tables/dashboard_notifications]] as the backing store for the shell where it fits (it already has `type`/`title`/`body`/`link`/`read`/`dismissed`), or add a thin `agent_inbox_items` view — decided at build time against the live schema (probe first, per [[../README]] § Probing technique). No approval-routing logic here — that is M2's keystone.

## Phase 4 — the org-chart (employee) view ⏳
- ⏳ planned
- An Agents sidebar item that renders a **visual employee/org chart** — CEO at top → Directors → their Workers — with each node showing the persona avatar + name + role. **Every node is clickable** → routes to that role's profile detail page (Phase 5). Not just a list: a real org-tree layout (think a company team page).
- Directors read from `functions/*.md`; Workers are the platform agents grouped under their director (the roster in [[../goals/devops-director]] § The Platform team) — brain-driven, no hand-maintained copy.

## Phase 5 — profile detail pages (responsibilities) ⏳
- ⏳ planned
- A profile detail page per role (`/dashboard/agents/[role]`): avatar, name, persona, and a **responsibilities list**. **Workers carry the most precise responsibility list** (their exact mandate — e.g. Repair: "triage inbound errors, root-cause, dismiss foreign/transient, author fixes"); directors a higher-level mandate (from `functions/*.md`); the CEO the company-objective level (from `goals/*.md`). Clickable from any tab (the org-chart nodes, a director row, a worker chip) — same profile page everywhere.
- Worker personas extend the Phase-2 persona module with the full Platform worker cast (Rafa/Repair · Remi/Regression · Devi/DB-Health · Cole/Coverage · Vera/Verify · Bo/Build · Mira/Migrations · Pax/PR-Resolve · Fenn/Fold · Tao/Monitor · Pia/Planner), each with avatar + precise responsibilities.

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
- On `/dashboard/agents` as the workspace owner, expect the left nav to list **CEO** (👑, with its active-goal count) plus one row per `docs/brain/functions/*.md` director — **Ada/Platform · Max/Growth · Iris/CMO · June/CS · Theo/Retention** — each with an SVG mascot + a "routes to CEO" badge, and each director's **Workers** (its box `agent_jobs` lanes) listed beneath it (e.g. Platform shows `build`/`plan`/`fold`/…, CS shows `ticket-improve`/`triage-escalations`, Retention shows `migration-fix`, Growth shows `storefront-optimizer`).
- In the Developer sidebar section (owner-only), expect an **Agents** link right under **Control Tower** → opens `/dashboard/agents`.
- As a non-owner member, load `/dashboard/agents` → expect the owner-only notice ("This view is owner-only"); `GET /api/developer/agents` and `/api/developer/agents/inbox` return **403** for a non-owner.
- Select **CEO** → expect three tabs (**Messages · Approval Requests · Daily Summaries**) with a text filter + "Unread only" checkbox; each tab renders its empty state (e.g. "Routed approvals land here once the approval-routing engine ships (M2)") with no crash. `GET /api/developer/agents/inbox?role=ceo` returns `{routesToCeo:false, items:[...]}`.
- Insert a `dashboard_notifications` row with `type='agent_approval_request'`, a title, and `dismissed=false` for the workspace → reload the CEO inbox → expect it to appear under **Approval Requests** (count badge =1); flip `read=true` and toggle "Unread only" → expect it to hide.
- Select any **director** (e.g. Max/Growth) → expect the inbox to show "isn't live yet — routes to the CEO inbox" (no items); `GET /api/developer/agents/inbox?role=growth` returns `{routesToCeo:true, items:[]}`.
- Add a new `docs/brain/functions/<slug>.md` (or rename a persona in `src/lib/agents/personas.ts`) → reload `/dashboard/agents` → expect the hub to reflect it with **no code change** (a brand-new function with no persona renders a neutral 🤖 mascot + humanized name).
