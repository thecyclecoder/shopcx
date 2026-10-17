# libraries/approval-decisions

The **supervisable-autonomy ledger** — record + read every **routed approval decision** in [[../tables/approval_decisions]] ([[../specs/approval-routing-engine]] Phase 3).

**File:** `src/lib/agents/approval-decisions.ts`

## Why this exists

The North star ([[../operational-rules]] § supervisable autonomy): an autonomous tool answers to an objective-owner, never a silent proxy. When a future **live+autonomous** director auto-approves one of its tools' requests, the CEO must always be able to audit **what** the proxy decided and **why** — in **history**, never in the queue. This module is the single chokepoint that writes that ledger and reads it back for the **Decision history** view.

The flag ([[../tables/function_autonomy]]) enables *who decides*; this module guarantees *it's always recorded*.

## Exports

- **`recordApprovalDecision(admin, input)`** → `Promise<ApprovalDecisionRow | null>` — insert one row. **Best-effort**: returns `null` on failure and never throws into the caller (recording the ledger must not break the decision it records). Forces `autonomous=true` **only** when `decided_by==='director'` (a ceo/human seat is never autonomous — fail-safe).
- **`listApprovalDecisions(admin, workspaceId, role, filters)`** → `Promise<ApprovalDecisionRow[]>` — the history read. The **CEO** (`role==='ceo'`) sees **every** decision in the workspace; a director sees only the decisions routed to it. Newest-first, bounded (≤500). Filters: `routedToFunction` (CEO only) · `decision` · `autonomous`.
- **`listFounderRulings(admin, workspaceId, sinceDays = 365)`** → `Promise<ApprovalDecisionRow[]>` — the **founder rulings** read ([[../specs/june-reads-founder-rulings-before-escalating]] Phase 1). Only decisions the **founder seat** made (`decided_by` ∈ `ceo｜human`, never `director`), workspace-wide, newest-first, within the last `sinceDays`. `approval_decisions` carries no `customer_id` — a founder ruling applies to the whole workspace — so this half is workspace-scoped by design; the customer-specific half comes from [[../libraries/tickets-read]] `getFounderRulingNotes` (`[Founder ruling]` internal notes across the customer's link group). Both back the `get_founder_rulings` box tool ([[improve-tools]]), which June ([[../../../.claude/skills/cs-director-call/SKILL.md|cs-director-call]]) reads before `escalate_founder` so she never re-asks a question the founder already settled.
- Types **`ApprovalDecisionRow`**, **`RecordDecisionInput`**, **`DecisionHistoryFilters`**, **`DecidedBy`** (`ceo｜director｜human`), **`DecisionOutcome`** (`approved｜declined｜escalated`).

## How a decision gets recorded

- **Human approve/decline** — [[roadmap-actions]] `approveRoadmapAction` calls `recordApprovalDecision` after the job update. It recomputes `raised_by_function` ([[approval-inbox]] `ownerFunctionForKind`) + `routed_to_function` ([[approval-router]] `resolveApproverLive`); `decided_by` is `'ceo'` when it routed to the fail-safe root, else `'human'` (a human override of a director's queue); `autonomous=false`. A `reject` (reject-with-notes hero regen) is **not** terminal, so it isn't logged.
- **Autonomous director** (future) — a live+autonomous director's auto-approver records with `decided_by='director', autonomous=true` + its reasoning, so the CEO sees it in history and never the queue.

## Safety invariants

- **`autonomous ⇒ decided_by='director'`** — enforced here, not trusted from the caller.
- **Every autonomous decision is logged** — the invariant the ledger exists for; the human path is best-effort, the autonomous path mandatory.
- **CEO can always audit** — `listApprovalDecisions` gives the CEO the full workspace history regardless of routing.

## Callers

- `src/lib/roadmap-actions.ts` — `approveRoadmapAction` records each terminal human decision.
- `src/app/api/developer/agents/decisions/route.ts` — `GET /api/developer/agents/decisions` (owner-gated) backs the **Decision history** tab on the [[../dashboard/agents|Agents hub]].
- `src/lib/improve-tools.ts` — the `get_founder_rulings` box tool calls `listFounderRulings` (workspace founder decisions) + [[tickets-read]] `getFounderRulingNotes` (customer `[Founder ruling]` notes), merged newest-first, for June's cs-director-call session.

## Related

[[../specs/approval-routing-engine]] · [[../tables/approval_decisions]] · [[approval-router]] · [[approval-inbox]] · [[approvals-feed]] · [[roadmap-actions]] · [[../dashboard/agents]] · [[../dashboard/approvals]] · [[../operational-rules]] (§ North star — supervisable autonomy)
