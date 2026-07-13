# libraries/approvals-feed

The **enrichment + merge** behind the [[../dashboard/approvals|Approvals activity feed]] — turns the two raw approval sources into one unified, card-ready stream.

**File:** `src/lib/agents/approvals-feed.ts`

## Why this exists

The [[approval-inbox]] emitter + the [[approval-decisions]] ledger each surface one half of the picture: the **pending routed queue** ([[../tables/dashboard_notifications]] `agent_approval_request`) and the **decided ledger** ([[../tables/approval_decisions]]). The founder's mental model is one flat activity feed — "show me everything, surface the few that need me." This module is the read-side join that produces that: it merges both sources newest-first and **enriches** each item off its [[../tables/agent_jobs]] row so a card can show the **spec · milestone/goal · phase · who raised it · who/how it was decided · type** without a click-through.

Read-only by construction. It never records a decision (that is [[approval-decisions]] `recordApprovalDecision`) and never mutates a job — the page's Approve/Decline rides the unchanged `POST /api/roadmap/approve`.

## Exports

- **`buildApprovalsFeed(admin, workspaceId)`** → `Promise<{ items: ApprovalFeedItem[]; escalatedCount }>` — the feed. Fetches the ≤100 open pending requests + ≤150 newest decisions, batch-resolves their jobs → specs → phases/milestones → goals, and maps each into an enriched `ApprovalFeedItem`. `escalatedCount` = pending requests routed to the CEO (the actionable count). **Best-effort:** a missing job/spec degrades the card (raw slug, no phase), never drops it.
- **`countEscalatedApprovals(admin, workspaceId)`** → `Promise<number>` — the lightweight count-only path (the sidebar badge): open `agent_approval_request` rows whose `metadata.routed_to_function` is `ceo`/unset. No enrichment.
- **`kindLabel(kind)`** → `string` — the human "type of approval" label per `agent_jobs.kind` (`build`→"Build", `migration-fix`→"Migration fix", `proposed-goal`→"Goal greenlight", …; unknown ⇒ the raw kind).
- Types **`ApprovalFeedItem`** (the card model — see below), **`FeedPersona`**, **`FeedStatus`** (`awaiting｜approved｜declined｜escalated`), **`ApprovalsFeed`**.

## How an item is enriched

The target spec is resolved from **candidate slugs** in priority order — `pending_actions[].spec_slug` / `pending_actions[].spec.slug` (the real target, e.g. a `repair`/`plan` branch) before the job's own (sometimes synthetic, e.g. `vercel:…`) `spec_slug`, then the notification's `metadata.spec_slug`. Only a slug that matches a real [[../tables/specs]] row links; otherwise the raw slug is shown. A **`plan`** job names a [[../tables/goals|goal]] slug, so its candidates resolve a goal directly; every other kind resolves a spec → its [[../tables/spec_phases|phases]] (the **phase needing approval** = first `in_progress`, else first `planned`) → its `milestone_id` → [[../tables/goal_milestones]] → [[../tables/goals]]. Personas (raiser / approver / decider) come from [[agent-personas|personas.ts]] `getPersona`; the raiser for a pending item is `metadata.escalated_by_director` (the director that escalated) or `ownerFunctionForKind(kind)` ([[approval-inbox]]); inline actions come from `inlineApproveActions(job)`.

`ApprovalFeedItem` carries: `source` (`pending｜decision`) · `status` · `escalated` (routed to the CEO seat — the **Needs CEO** lane, parks included) · `actionable` (escalated **and** has inline actions) · `kind`/`typeLabel` · `raisedBy`/`routedTo`/`decidedByLabel`/`autonomous` · `spec`/`goal`/`milestone`/`phase` · `title`/`summary` · and the pending affordances `jobId`/`actions`/`deepLink`/`escalatedBy`.

## Callers

- `src/app/api/developer/approvals/route.ts` — `GET /api/developer/approvals` (full feed) + `?count=1` (badge).
- `src/app/dashboard/developer/approvals/page.tsx` — the [[../dashboard/approvals|feed page]] (consumes `ApprovalFeedItem`).
- `src/app/dashboard/sidebar.tsx` — polls `?count=1` for the "needs you" badge.

## Related

[[../dashboard/approvals]] · [[approval-inbox]] · [[approval-decisions]] · [[approval-router]] · [[control-tower-node-registry]] · [[agent-personas]] · [[../tables/approval_decisions]] · [[../tables/dashboard_notifications]] · [[../tables/agent_jobs]] · [[../tables/specs]] · [[../tables/spec_phases]] · [[../tables/goals]] · [[../tables/goal_milestones]] · [[../specs/approval-routing-engine]]
