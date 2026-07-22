# media-buyer-retarget-publish-gate

**File:** `src/lib/media-buyer/retarget-publish-gate.ts` · **Owner:** [[../functions/growth]]

The RETARGET-rail sibling of [[media-buyer-publish-gate]]. Introduced by
[[../specs/retarget-campaign-warm-hot-mixed-content]] Phase 2 as the fail-closed
gate at the money step for the v3 goal M3 retarget campaign — one lean campaign,
one consolidated adset per cohort, warm+hot MIXED content on its own supervisable-
autonomy rail. Bianca's cold rail is untouched.

## Exports

- **`MEDIA_BUYER_RETARGET_ORIGIN`** — the `ad_publish_jobs.origin` sentinel that
  opts INTO this gate (value: `'media-buyer-retarget'`). Documented in the
  migration `20261128120000_ad_publish_jobs_origin_retarget.sql` alongside the
  legacy `'media-buyer-test'` and `NULL`/`'operator'` values.
- **`MediaBuyerRetargetRefusalReason`** — the closed set of refusal reasons:
  - `no_active_cohort` — no active [[../tables/media_buyer_retarget_cohorts]] row
    for the tuple (opt-in table; workspace hasn't provisioned).
  - `wrong_adset` — requested `meta_adset_id` != `cohort.retargetMetaAdsetId`.
  - `over_ceiling` — projected daily spend > `cohort.dailyCeilingCents`.
  - `missing_max_copy_qc_verdict` / `hard_gate_fail` / `below_score_floor` —
    the SHIPPED 9/10 Max copy-QC floor from [[media-buyer-publish-gate]]
    `evaluateMaxCopyQcAtPublish`, re-used VERBATIM so the retarget rail can never
    diverge from Bianca-posts-only-at-9of10.
- **`evaluateMediaBuyerRetargetPublish(admin, input)`** — the fail-closed gate.
  Precedence: cohort check → adset match → ceiling → Max copy-QC. Returns
  `{ allowed: true, cohort, ceilingCents, projectedDailyCents, copyQc }` on go
  or `{ allowed: false, reason, cohort, diagnosis, ... }` on refuse. NEVER
  escalates — the caller runs `escalateMediaBuyerRetargetPublishRefusal` so
  the audit trail records WHO caught the rail (the runner vs the publisher).
- **`escalateMediaBuyerRetargetPublishRefusal(admin, args)`** — emits the CEO
  escalation via [[platform-director]] `escalateDiagnosisToCeo` + records ONE
  `director_activity` row with `action_kind='media_buyer_retarget_publish_refused'`
  (growth-owned). Deduped by `dedupe_key = media_buyer_retarget_gate:<workspace>:<adset>:<reason>`
  so one OPEN escalation exists per (workspace, adset, reason) at a time.

## Callers

- [[media-buyer-retarget-cohort]] `runRetargetReplenishLoopForAccount` (the
  cadence runner — Phase 2) evaluates the gate BEFORE inserting the publish job
  row so a refused creative never enqueues.
- [[../inngest/ad-tool]] `adToolPublishToMeta` re-runs the same gate on any
  `origin='media-buyer-retarget'` job BEFORE flipping `publish_active=true` on
  Meta — belt-and-suspenders for a cohort retired mid-run.

## Invariants

- The retarget rail publishes into ONE consolidated adset per cohort — the goal
  design decision. A gate that let a wrong-adset publish through would break
  the M3 rollup's factor-scoring assumption.
- The 9/10 Max copy-QC floor is inherited VERBATIM from
  [[media-buyer-publish-gate]] `evaluateMaxCopyQcAtPublish`. A retarget refusal
  reason maps 1:1 to the copy-QC reason so downstream audit surfaces (CEO
  escalation dedup, `director_activity`) read as if the same rail fired.
- On refuse, the caller downgrades the ad to PAUSED and escalates to the CEO
  (never silently spend) — the ShopCX north-star escalate-don't-execute rule.
