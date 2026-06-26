# dashboard/approvals

The owner-only **Approvals activity feed** — the ONE place every approval in the workspace surfaces: the live routed queue the CEO must still decide **and** the ledger of everything already decided (mostly the autonomous Platform/DevOps Director's auto-approvals). North star ([[../operational-rules]] § supervisable autonomy): the CEO can always audit **what** a proxy decided + **why** — this feed is that surface, with the escalated-to-human items carrying the real **Approve / Decline** affordance inline.

It is the **founder-facing, mobile-friendly** companion to the per-role inbox on the [[agents|Agents hub]]: the hub renders the routing org chart + the three-tab role inbox; this page is the flat, card-based **activity stream** ("just show me the logs; surface the few that need me"). Same backing data, same execution paths — different lens.

**Route:** `/dashboard/developer/approvals` (client poller, owner-only, 15s)
**Sidebar:** **Developer** section (owner-only) → **Approvals** (right under [[control-tower|Control Tower]]), with an **amber "needs CEO" badge** = the count of pending requests routed to the CEO seat (today the founder; a future autonomous CEO inherits the seat unchanged — the framing is the **CEO**, not "you").

## Surfaces

- **The feed** — every item is a **card** (not a wide row), newest-first, merging two sources:
  - **Pending** ([[../tables/dashboard_notifications]] `type='agent_approval_request'`, not dismissed) — the routed queue. A request routed to the **CEO** (`metadata.routed_to_function='ceo'`, the fail-safe root) is **escalated to the CEO** (`escalated:true`, the **Needs CEO** lane — parks included, not just the actionable ones); one carrying inline plain actions renders **Approve / Decline** per action (→ the unchanged `POST /api/roadmap/approve`, [[../libraries/roadmap-actions]]). A `needs_attention` park (no inline actions) instead shows the escalation reason + an **Open the full surface →** deep-link. Every pending card has **Dismiss** (→ `POST /api/developer/agents/inbox/dismiss`, the job is untouched).
  - **Decision** (`public.approval_decisions`, the [[../tables/approval_decisions|ledger]]) — read-only logs. Most are the autonomous director's auto-approvals (`decided_by='director'`, `autonomous=true`) — the "just see the logs" case. Each shows the decision, who decided, and the reasoning (the auditable "why", collapsible).
- **Each card answers "what is this, whose is it, where in the plan"** without a click-through — chips for the **Spec** (title/slug) · **Goal** · **Milestone** · **Phase needing approval**, a **type** label (from `agent_jobs.kind`), a **status** badge (Needs CEO / Awaiting / Approved / Declined / Escalated), an **autonomous** badge, and a `from {raiser} → routed to {approver}` / `decided by {Ada (autonomous)|You|Henry (CEO)}` line. Personas resolved via [[../libraries/agent-personas|personas.ts]] `getPersona`.
- **Filters** — a segmented control (**All activity · Needs CEO · Approved · Declined**, with live counts) + a text filter + Refresh.

## Data source

- `GET /api/developer/approvals` (`src/app/api/developer/approvals/route.ts`, owner-gated) → [[../libraries/approvals-feed]] `buildApprovalsFeed(admin, workspaceId)` → `{ items, escalatedCount }`. The builder merges the two sources and **enriches** each item off its [[../tables/agent_jobs]] row (spec → [[../tables/specs]] → [[../tables/spec_phases]] / [[../tables/goal_milestones]] → [[../tables/goals]]); a `plan` job's `spec_slug` resolves a **goal** directly. Best-effort: a missing job/spec degrades the card (raw slug, no phase) rather than dropping it.
- `GET /api/developer/approvals?count=1` → `{ escalatedCount }` only (`countEscalatedApprovals`) — the **lightweight** path the always-mounted sidebar (`src/app/dashboard/sidebar.tsx`) polls for the badge, so the badge never runs the full enrichment query.

## Invariants

- **Read-only surface, unchanged execution.** The page raises no new mutation path — Approve/Decline rides `POST /api/roadmap/approve`, Dismiss rides `POST /api/developer/agents/inbox/dismiss`. It only *reads* + *renders*.
- **Escalated = routed to CEO.** The "needs CEO" badge + filter count only pending requests routed to the fail-safe root (`routed_to_function='ceo'`/unrouted) — that's the durable seat (the founder today, an autonomous CEO later), never "you". Everything else is a log.
- **Owner-only.** Same gate as the rest of the Developer section + the Agents hub.

## Related

[[agents]] · [[control-tower]] · [[../libraries/approvals-feed]] · [[../libraries/approval-inbox]] · [[../libraries/approval-decisions]] · [[../libraries/approval-router]] · [[../tables/approval_decisions]] · [[../tables/dashboard_notifications]] · [[../tables/agent_jobs]] · [[../specs/approval-routing-engine]] · [[../operational-rules]] (§ North star — supervisable autonomy)
