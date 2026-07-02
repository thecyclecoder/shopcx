# Harden the Vault agent — roll persistent coaching into its mandate

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — graduate persistent coaching into a durable fix (director grades agents: low score → fix spec, never a CEO escalation)
**Found in use 2026-07-02:** the **Vault** agent (`security-review`) sits at **2.0/10** after **2** coaching attempts that didn't stick. Rather than escalate to the CEO, roll the coaching into a permanent fix so the agent improves at the mandate level.

## The accumulated coaching to bake in (now archived as rolled-into-mandates)
- **When when handed a diff-mode security-review whose spec is already status='folded'/'deferred' or lives in docs/brain/archive.d/ (its ship-time review already ran):** self-abort with a clean no-op verdict before spinning up a full Max review, rather than re-scanning a merge that was already reviewed at ship time — All 10 cancelled Vault jobs targeted specs confirmed folded on origin/main (spec-review-agent, retire-md-reads-from-pm-flow, whitelisted-page-auto-tracking, etc.). A cheap spec-status check at the top of the review would have made Vault resilient to an over-broad enqueue and prevented the Max burn even before #1008's enqueue-side fix — defense in depth for the objective-owner, not blind execution of whatever was queued.
- **When when your target spec is already archived/folded (status folded, no open claude/* branch, no diff to fetch):** exit immediately with a no-op/skipped verdict instead of backfilling a full security review — probe the spec's status and confirm a reviewable branch+diff exists before doing any analysis, and bail cleanly the moment there is none — All nine Vault jobs this batch (e.g. control-tower-cron-grace, spec-status-db-driven, remotion-lambda-pin) were security-reviews dispatched against already-folded specs with no branch to inspect; each ran away and had to be force-cancelled to protect Max, producing zero verdicts and dragging the rolling average to 5.0. A fast archived-spec guard turns nine wasteful runaways into cheap clean skips.

## Phase 1 — bake the coaching into the agent
- Make the above coaching PERMANENT behavior of the `security-review` agent — fold it into its prompt/mandate/code (its run-job + prompt in `scripts/builder-worker.ts` and the relevant `src/lib/agents/*`), not ephemeral appended `agent_instructions`. Once baked, the agent should follow it by default.
- Verify the agent's grade rollup recovers (≥ 7/10) over the next window of graded actions; if a coaching class still recurs, the bake-in missed it.

## Ownership
Owner: [[../functions/platform]] (Ada supervises Vault). The director authored this from Vault's coaching ledger; building it hardens the agent so the coaching never has to repeat.
