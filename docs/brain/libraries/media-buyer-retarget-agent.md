# media-buyer-retarget-agent

**File:** `src/lib/media-buyer/retarget-agent.ts` · **Owner:** [[../functions/growth]]

The RETARGET-rail sibling of [[media-buyer-agent]] `runMediaBuyerLoopForAccount`
(the cold-test replenish loop). Introduced by
[[../specs/retarget-campaign-warm-hot-mixed-content]] Phase 2 to publish warm+hot
MIXED content into the retarget cohort's consolidated adset WITHOUT touching
Bianca's cold-only invariant.

## Exports

- **`runRetargetReplenishLoopForAccount(admin, opts)`** — one pass for a single
  `(workspace, meta_ad_account)` tuple. Phase-3's cadence cron
  ([[../inngest/media-buyer-retarget-cadence]]) is the driver. Read + write
  chokepoints:
  1. Enumerate every ACTIVE retarget cohort via
     [[media-buyer-retarget-cohort]] `listActiveRetargetCohorts` (per-account
     rows PLUS the workspace-wide fallback, deduped).
  2. READ `listReadyToTest` scoped to the cohort's `audienceTemperatures`
     whitelist (defaults to `['warm','hot']`). A cold-tagged creative CANNOT
     surface here — Bianca's cold rail still owns it.
  3. Per ready creative, evaluate [[media-buyer-retarget-publish-gate]]
     `evaluateMediaBuyerRetargetPublish`. On refusal, record a
     `director_activity` row (`action_kind='media_buyer_retarget_publish_refused'`)
     and escalate to the CEO via
     `escalateMediaBuyerRetargetPublishRefusal`. On allow, insert one
     `ad_publish_jobs` row with `origin='media-buyer-retarget'` targeting
     `cohort.retargetMetaAdsetId` and fire the `ad-tool/publish-to-meta` event.
- **`DEFAULT_RETARGET_CREATIVE_DAILY_CENTS`** — the default per-creative daily
  budget ($10). Kept LOW so a single misfired creative cannot exhaust a
  cohort's ceiling on its own; `cohort.dailyCeilingCents` is the outer bound
  the gate still enforces.
- **`RetargetPlanAction` / `RunRetargetReplenishResult`** — the pass-plan and
  its rollup shape (published / refused / skipped counts + one heartbeat row).

## Invariants

- READ-ONLY vs the shipped cold test cohort table + [[media-buyer-agent]].
  Reads its own [[media-buyer-retarget-cohort]] SDK, its own whitelisted
  ready-to-test bin, its own publish gate, and writes its own origin — no
  import from `runMediaBuyerLoopForAccount` beyond the PURE
  `resolveReplenishAdCopy` helper.
- Every allow AND refusal writes exactly one growth-owned `director_activity`
  row so the audit trail cites concrete (cohort, creative, reason) — never a
  silent proxy-optimizer per the ShopCX north star.
- One heartbeat `director_activity` row per pass proves the runner executed
  even when no creatives are ready (dormant is a fact, not silence).

## Callers

- [[../inngest/media-buyer-retarget-cadence]] (Phase 3) — the cadence cron
  drives one `runRetargetReplenishLoopForAccount` call per active Meta ad
  account per workspace and ends with `emitCronHeartbeat` on the outer step.
