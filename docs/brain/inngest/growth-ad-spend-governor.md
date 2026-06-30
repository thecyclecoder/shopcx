# inngest/growth-ad-spend-governor

The Phase-3 SUPERVISOR pass on the Growth director's ad-DOLLAR proxy ([[../libraries/ad-spend-governor]]). Once daily it finds every workspace with ≥1 [[../tables/ad_spend_budgets]] row, fans out one event per workspace, and the per-workspace handler rolls up [[../tables/daily_meta_ad_spend]] over two consecutive same-length windows vs the effective ceiling. On a TREND over (`currentOver && priorOver`), it ESCALATES via [[../libraries/platform-director]] `escalateDiagnosisToCeo` (`escalationKind='ad_spend_ceiling'`) + writes a growth-owned [[../tables/director_activity]] row (`director_function='growth'`, `action_kind='escalated_ad_spend_ceiling'`). NEVER pauses, throttles, or kills a campaign — escalation only ([[../operational-rules]] § North star).

**File:** `src/lib/inngest/growth-ad-spend-governor.ts` · logic in [[../libraries/ad-spend-governor]] (`runAdSpendGovernorPass`)

## Functions

### `growth-ad-spend-governor-cron`
- **Trigger:** cron `0 12 * * *` (once daily at 12:00 UTC, mid-day so a fresh `daily_meta_ad_spend` snapshot is already in)
- **Concurrency:** `concurrency: [{ limit: 1 }]`, `retries: 1`
- **What it does:** reads `ad_spend_budgets.workspace_id` (distinct) — every workspace with at least one configured ceiling. For each, it `step.sendEvent("growth/ad-spend-governor-sweep", { workspace_id })`. End-of-run heartbeat via `emitCronHeartbeat("growth-ad-spend-governor-cron", …)`.
- **Returns** `{ workspaces }` (count fanned out).

### `growth-ad-spend-governor-sweep`
- **Trigger:** event `growth/ad-spend-governor-sweep` (data: `{ workspace_id, trigger? }`)
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspace_id" }]`, `retries: 1`
- **What it does:** calls [[../libraries/ad-spend-governor]] `runAdSpendGovernorPass(admin, { workspaceId })` which iterates every `ad_spend_budgets` row, rolls up [[../tables/daily_meta_ad_spend]] over today's + yesterday's same-length window, and on the 2-day TREND over the ceiling emits the CEO Approval Request + growth `director_activity` row.
- **Returns** `{ status: "complete", observed, escalations }`.

## North-star invariant

A ceiling is a **surfaced leash**, never a kill-switch. The governor is the autonomous TOOL on the ad-DOLLAR proxy ([[../tables/daily_meta_ad_spend]]); when it hits the rail (a budget over its ceiling for 2 consecutive windows), it ESCALATES UP to its supervisor (the CEO inbox via [[../libraries/platform-director]] `escalateDiagnosisToCeo`) — it never pauses, throttles, or kills a campaign (see [[../operational-rules]] § North star + [[../specs/growth-ad-spend-rail]] Phase 3).

## Downstream events sent

- `growth/ad-spend-governor-sweep` (one per budgeted workspace, from the cron's fan-out)

Side effects from the sweep are a [[../tables/dashboard_notifications]] insert/update (`type='agent_approval_request'`, `metadata.escalation_kind='ad_spend_ceiling'`) + a [[../tables/director_activity]] insert.

## Tables written

- [[../tables/dashboard_notifications]] (one OPEN ceiling notification per (workspace, platform, account); bumped on re-surface)
- [[../tables/director_activity]] (`action_kind='escalated_ad_spend_ceiling'`, one per emitted escalation — Growth's per-breach audit trail)
- [[../tables/loop_heartbeats]] (its own end-of-run beat)

## Tables read (not written)

- [[../tables/ad_spend_budgets]] (workspace discovery + effective ceilings)
- [[../tables/daily_meta_ad_spend]] (via [[../libraries/ad-spend-governor]] `rollupAdSpendActual`)

## Register-or-it's-incomplete

Registered in `src/lib/control-tower/registry.ts` as a `cron` loop owned by `growth` (`livenessWindowMs` 26h) — per [[../operational-rules]], a new cron is incomplete without a Control Tower entry + an end-of-run heartbeat.

## Related

[[../libraries/ad-spend-governor]] · [[../libraries/platform-director]] · [[../libraries/growth-director]] · [[fleet-spend-governor]] · [[../tables/ad_spend_budgets]] · [[../tables/daily_meta_ad_spend]] · [[../specs/growth-ad-spend-rail]] · [[../functions/growth]]
