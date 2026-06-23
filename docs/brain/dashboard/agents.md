# dashboard/agents

The owner-only **Agents hub** ([[../specs/agents-hub-role-inboxes]], M1 of [[../goals/devops-director]]) — the single surface that renders the live org chart (**CEO · Directors · Workers**) read from the brain, and gives every role the same **three-tab inbox** (Messages · Approval Requests · Daily Summaries). The foundation the routing engine (M2), the gamified board (M3), and the live Platform director (M4) all write *into*. Formalizes today's reality — no director is automated, so **every approval routes to one CEO inbox** — into one place, replacing the scattered approval surfaces (Control Tower feeds, spec cards, the box `approvalHref`).

**Route:** `/dashboard/agents` (client poller, owner-only)
**Sidebar:** **Developer** section (owner-only) → **Agents** (right under [[control-tower|Control Tower]]).

## Surfaces

- **Left role nav** — **CEO** (the `ceo` persona seat, with its active-goal count from `goals/*.md`), then one row per `functions/*.md` **director** ([[../functions/platform|Platform]] · [[../functions/growth|Growth]] · [[../functions/cmo|CMO]] · [[../functions/cs|CS]] · [[../functions/retention|Retention]]) showing its **persona chip + SVG mascot** + a **live/autonomous badge** (M1: every director is `offline` → "routes to CEO"; the flag itself lands in M2). Under each director, its **Workers** — the box [[../tables/agent_jobs]] lanes it owns (the `agent-kind` loops in the Control Tower [[../libraries/control-tower|registry]], which already carry an owner function: build/plan/fold/spec-chat/spec-test/dev-ask/pr-resolve/repair → Platform; ticket-improve/triage-escalations → CS; migration-fix → Retention; storefront-optimizer → Growth).
- **Org chart (employee) view** (Phase 4) — an **Org chart** item at the top of the left nav renders the team as a real **org-tree layout** (not a list): **CEO** at top → a connected row of **Directors** → each director's **Workers** beneath it. Every node shows its persona avatar + name + role and is **clickable** → routes to that role's profile detail page (`/dashboard/agents/[role]`, Phase 5). Same brain-driven `OrgChart` payload as the nav (`GET /api/developer/agents`), so a new `functions/*.md` director or renamed persona shows here with no code change; workers (no persona until Phase 5) fall back to the neutral 🤖 mascot. Component: `src/components/agents/org-chart-tree.tsx`.
<<<<<<< HEAD
- **Right pane** — the selected role's header (mascot + name + role + personality + mandates/goals). For a **director**, an owner-only **Autonomy toggle** (approval-routing-engine M2 / Phase 1) — two checkboxes, **Live** (the director-agent is running) + **Autonomous** (trusted to auto-decide), backed by [[../tables/function_autonomy]] via `POST /api/developer/agents/autonomy`. Autonomous is disabled until Live is on (an offline director can't auto-approve); the row reads "Approvals route here + log to history" when on, else "Approvals route to the CEO". The director's **live/autonomous badge** is now derived from these flags (seeded all-off ⇒ every director shows "routes to CEO" until the owner flips it). Below the header, its **three-tab inbox shell**:
  - **Messages** (`agent_message`) — the gamified #directors board (populated by M3).
=======
- **Right pane** — the selected role's header (mascot + name + role + personality + mandates/goals) and its **three-tab inbox shell**:
  - **Messages** — the Slack-style **#directors board** (M3 Phase 1, shipped): a workspace-wide team channel backed by [[../tables/director_messages]] (NOT the notification store), rendered by `<BoardChannel>` ([[../libraries/director-board]]) — persona avatar + name/role per post, conversational body with @-mentions highlighted, threaded replies, kind badges. The live Platform director (M4) is the first real author; a system seed proves the surface. Two-way reply is M3 Phase 2.
>>>>>>> origin/main
  - **Approval Requests** (`agent_approval_request`) — the routed approval queue (populated by M2).
  - **Daily Summaries** (`agent_daily_summary`) — the EOD recaps (populated by M3/M4).
  - Each tab has **filters** (text + unread-only) + per-tab counts and an **empty/loading state**. **The CEO inbox is live** — it queries the reserved `agent_*` types out of [[../tables/dashboard_notifications]] and buckets them by tab, so M2 has a real target to emit into. Director inboxes are intentionally empty with a "routes to the CEO inbox" notice (no director is automated yet).

This milestone ships the **shell + personas only** — no approval-routing logic, no board posts, no live director (those are M2/M3/M4).

## Data source

<<<<<<< HEAD
- `GET /api/developer/agents` (`src/app/api/developer/agents/route.ts`) → `getOrgChart()` ([[../libraries/agent-personas|org-chart.ts]]) — the CEO → Directors → Workers tree from [[../libraries/brain-roadmap]] `getFunctions()` + `getGoals()` + the Control Tower registry's `agent-kind` loops, with each director's `status`/`live`/`autonomous` derived from [[../tables/function_autonomy]] ([[../libraries/approval-router]] `loadAutonomyMap` + `isAutoApprover`). **Brain is the source of truth — never a hand-maintained second copy of the org chart.**
- `POST /api/developer/agents/autonomy` (`src/app/api/developer/agents/autonomy/route.ts`) → owner-gated upsert of a director's `live`/`autonomous` flag into [[../tables/function_autonomy]] (the progressive-offload switch behind [[../libraries/approval-router]] `resolveApprover`). Validates the slug against `functions/*.md`; `autonomous` is forced off when `live` is off.
- `GET /api/developer/agents/inbox?role={ceo|slug}` (`src/app/api/developer/agents/inbox/route.ts`) → the role's three-tab payload. CEO reads [[../tables/dashboard_notifications]] (`type IN agent_*`, `dismissed=false`); director roles return empty + `routesToCeo:true`. **Read-only** — the shell never routes or writes (that is M2).
=======
- `GET /api/developer/agents` (`src/app/api/developer/agents/route.ts`) → `getOrgChart()` ([[../libraries/agent-personas|org-chart.ts]]) — the CEO → Directors → Workers tree from [[../libraries/brain-roadmap]] `getFunctions()` + `getGoals()` + the Control Tower registry's `agent-kind` loops. **Brain is the source of truth — never a hand-maintained second copy of the org chart.**
- `GET /api/developer/agents/inbox?role={ceo|slug}` (`src/app/api/developer/agents/inbox/route.ts`) → the role's Approval Requests + Daily Summaries payload. CEO reads [[../tables/dashboard_notifications]] (`type IN agent_*`, `dismissed=false`); director roles return empty + `routesToCeo:true`. **Read-only** — the shell never routes or writes (that is M2).
- `GET /api/developer/agents/board` (`src/app/api/developer/agents/board/route.ts`) → the Messages tab's #directors channel — `getDirectorBoard` + `threadMessages` ([[../libraries/director-board]]) over [[../tables/director_messages]]. Owner-gated, read-only (the two-way reply that writes back is M3 Phase 2). The Messages tab renders this for **every** role (one shared team channel), so the per-role `routesToCeo` notice never covers it.
>>>>>>> origin/main

## Permissions

Owner-only — both the page (client `role` guard, mirrors [[control-tower]]) and the two APIs (`workspace_members.role='owner'`, 403 otherwise).

## Reskinnable personas

The cast (🛠️ Ada/Platform · 🚀 Max/Growth · 🎨 Iris/CMO · 💬 June/CS · 🧲 Theo/Retention · 👑 CEO) is **one config file** — [[../libraries/agent-personas]] (`src/lib/agents/personas.ts`). Names/mascots/colors are config keyed by function slug; a new director inherits a persona by adding one entry (and falls back to a neutral persona with no code change). The inline SVG mascots live in `src/components/agents/mascots.tsx`.

## Files

<<<<<<< HEAD
- `src/app/dashboard/agents/page.tsx` (left role nav + right three-tab inbox shell)
- `src/app/api/developer/agents/route.ts` (owner-gated org chart) · `src/app/api/developer/agents/inbox/route.ts` (owner-gated role inbox) · `src/app/api/developer/agents/autonomy/route.ts` (owner-gated live/autonomous toggle)
- `src/lib/agents/org-chart.ts` (the CEO→Directors→Workers reader) · `src/lib/agents/approval-router.ts` (the org-chart approval router — [[../libraries/approval-router]]) · `src/lib/agents/personas.ts` (the reskinnable cast) · `src/lib/agents/inbox.ts` (tab + reserved-type config) — [[../libraries/agent-personas]]
- `src/components/agents/mascots.tsx` (inline SVG mascots) · `src/components/agents/persona-chip.tsx` (avatar + chip + status badge)
=======
- `src/app/dashboard/agents/page.tsx` (left role nav + right three-tab inbox shell; the Messages tab renders `<BoardChannel>`)
- `src/app/api/developer/agents/route.ts` (owner-gated org chart) · `src/app/api/developer/agents/inbox/route.ts` (owner-gated role inbox) · `src/app/api/developer/agents/board/route.ts` (owner-gated #directors board)
- `src/lib/agents/org-chart.ts` (the CEO→Directors→Workers reader) · `src/lib/agents/personas.ts` (the reskinnable cast) · `src/lib/agents/inbox.ts` (tab + reserved-type config) — [[../libraries/agent-personas]]
- `src/lib/agents/board.ts` (board types + threading) · `src/lib/agents/director-board.ts` (board reads + the post path) — [[../libraries/director-board]] · `scripts/seed-director-board.ts` (the surface seed)
- `src/components/agents/mascots.tsx` (inline SVG mascots) · `src/components/agents/persona-chip.tsx` (avatar + chip + status badge) · `src/components/agents/board-channel.tsx` (the #directors channel)
>>>>>>> origin/main

## Related

[[../specs/agents-hub-role-inboxes]] · [[../specs/directors-board-gamified]] · [[../goals/devops-director]] · [[../libraries/agent-personas]] · [[../libraries/director-board]] · [[../libraries/brain-roadmap]] · [[../libraries/control-tower]] · [[../tables/dashboard_notifications]] · [[../tables/director_messages]] · [[../tables/agent_jobs]] · [[../functions/platform]] · [[control-tower]] · [[../operational-rules]]
