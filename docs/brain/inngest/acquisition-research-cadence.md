# inngest/acquisition-research-cadence

The **standing re-scan loop + gap→outcome grading sweep** that makes the Acquisition Research Engine constant research, not one-shot. M5 of [[../goals/acquisition-research-engine]] ([[../specs/acquisition-research-loop-grading]]).

**File:** `src/lib/inngest/acquisition-research-cadence.ts`

## Functions

### `acquisition-research-cadence-cron`
- **Trigger:** cron `0 10 * * *` (daily, offset AFTER the 9am [[creative-finder]] sweep so it reasons over fresh [[../tables/creative_skeletons]])
- **Retries:** 1
- Scope: ad-tool workspaces (those with [[../tables/ad_campaigns]]). Per workspace, in a `cadence-${ws}` step:
  1. **promote** — [[../libraries/competitors]] `promoteFromCategorySweep` → heavy advertisers recurring in the fresh sweep surface as `proposed` competitors (deduped).
  1b. **promote whitelisted** — [[../libraries/competitors]] `promoteWhitelistedPages` → advertiser pages fronting a KNOWN competitor `destination_domain` surface as `source='whitelisted'` `proposed` rows with `search_keyword` = the exact page name + `runs_ads_for` = the fronted competitor (deduped). See [[../specs/whitelisted-page-auto-tracking]].
  2. **ad gaps** — [[../libraries/acquisition-hub]] `materializeAdGaps` → re-materialize the deterministic ad-gap report into [[../tables/ad_gap_recommendations]] as `proposed` (idempotent on `dedup_key`; SUPPRESSED `ad_angle` skipped).
  3. **grade** — [[../libraries/acquisition-gap-grader]] `gradeActedGaps` → initial-grade each acted-on gap, revise-grade resolved outcomes.
  - then `sendEvent ads/landing-page-scout.analyze { workspaceId }` → the Landing Page Scout re-surfaces NEW lander gaps (deduped; suppressed types skipped).
- Ends with a Control-Tower heartbeat (`emit-heartbeat`) so a healthy-but-idle run still beats.

### `acquisition-research-cadence-manual`
- **Trigger:** event `ads/acquisition-research.cadence { workspaceId? }` — same per-workspace pass, scoped to one workspace or all ad-tool workspaces. No heartbeat (manual).

## Downstream events sent
- `ads/landing-page-scout.analyze` `{ workspaceId }` → [[landing-page-scout]] (re-surface lander gaps from the latest snapshots).

## Tables written (indirectly, via the libraries)
- [[../tables/competitors]] (`promoteFromCategorySweep` + `promoteWhitelistedPages`)
- [[../tables/ad_gap_recommendations]] (`materializeAdGaps`)
- [[../tables/acquisition_gap_grades]] + [[../tables/acquisition_grader_prompts]] (`gradeActedGaps`)
- `ai_token_usage` (grader usage, via [[../libraries/ai-usage]])

## Gotchas
- **Snapshot CAPTURE is box-driven** — the per-chapter Playwright snapshots are `scripts/landing-page-snapshot.ts` (can't run serverless). This loop keeps the ANALYSIS + gap surfacing fresh against whatever's captured; it does not capture.
- **Every step is read/propose or human-gated** — nothing auto-routes or auto-approves (North star). The Growth-director grade only TUNES what's surfaced.
- **Idempotent throughout** — promotion, materialization, lander analysis, and grading all dedup, so daily re-runs never duplicate.

---

[[../README]] · [[creative-finder]] · [[competitor-scout]] · [[landing-page-scout]] · [[../libraries/acquisition-gap-grader]] · [[../libraries/acquisition-hub]] · [[../specs/acquisition-research-loop-grading]] · [[../../CLAUDE]]
