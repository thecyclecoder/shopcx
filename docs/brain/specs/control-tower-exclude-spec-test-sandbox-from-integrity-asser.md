# Control Tower: exclude the is_test spec-test sandbox from renewal-integrity (and sibling) assertions 🚧

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/control-tower/monitor.ts::monitor-false-positive`
**Repair-signature:** `loop:internal-subscription-renewal-cron`

Control Tower output-assertion integrity queries scan global tables (subscriptions, dunning_cycles, renewal outcome beats) but never exclude the permanent spec-test sandbox workspace (is_test=true, 5ec77e57-…0001). A deliberately-stuck sandbox fixture therefore reads as a real production anomaly. Add a single shared exclusion so synthetic fixtures can never trip a real loop tile, then verify the internal-subscription-renewal-cron renewal-integrity tile returns green.

## Problem (from Control Tower signature `loop:internal-subscription-renewal-cron`)
The internal-subscription-renewal-cron tile went RED (reason=renewal_integrity: '1 active internal subscription have next_billing_date in the past'). The lone overdue sub is the seeded spec-test fixture SPEC_TEST_FIXTURES.subscriptionCompId (shopify_contract_id 'internal-spectest-comp', comp=true, customer has no comp_role by design so the fail-closed comp gate intentionally never advances it). gatherAssertionInputs in src/lib/control-tower/monitor.ts (~L782) builds overdueInternalSubs with .eq('is_internal',true).eq('status','active').lt('next_billing_date', startOfToday) and no is_test filter, so the synthetic sandbox sub counts as a real overdue customer sub. The renewal cron + per-sub handler are healthy; only the assertion is wrong.

**Likely target:** `src/lib/control-tower/monitor.ts`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

**Shipped:** `fetchAssertionInputs` in `src/lib/control-tower/monitor.ts` now excludes the permanent spec-test sandbox tenant (`SPEC_TEST_SANDBOX_WORKSPACE_ID` = `SPEC_TEST_FIXTURES.workspaceId`, `is_test=true`) from the workspace-scoped integrity queries via `.neq("workspace_id", …)`: the renewal-integrity overdue-subscriptions scan and the sibling stuck-dunning scan. A deliberately-stuck synthetic fixture (e.g. the comp sub whose customer has no `comp_role`) can no longer trip a real loop tile RED. Brain page [[../libraries/control-tower]] updated. (`loop_heartbeats`-sourced reads — escalation/spec-test/renewal-outcome — carry no `workspace_id` column and are unaffected.)

## Verification
- Re-trigger the originating condition (signature `loop:internal-subscription-renewal-cron`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:internal-subscription-renewal-cron` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
