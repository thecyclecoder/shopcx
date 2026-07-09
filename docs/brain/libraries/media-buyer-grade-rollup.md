# `src/lib/media-buyer/grade-rollup.ts`

Per-ad-account rollups of [[../tables/media_buyer_action_grades]] for the Growth dashboard (media-buyer-grade-rollup-on-growth-director-brief Phase 2). The grades table keys by `source_meta_ad_id` (the graded creative), **not** by account — so this maps ad → account through [[../tables/meta_ads]] (`meta_ad_id` → `meta_ad_account_id`, the internal-UUID form the cohorts tile + `media_buyer_test_cohorts` use) and groups. READ-ONLY. Sibling of [[growth-director]] `loadMediaBuyerRollup` (same table, grouped by `action_kind` for the brief; grouped by account here).

## Exports

- `loadAccountGradeRollups(admin, workspaceId, accountIds)` → `Map<accountId, AccountGradeRollup>`. Per account over the last 30 days: `avgOverallGrade` + `dailyOverallAvg14d` (the cohort-row sparkline). Accounts with zero grades get a zeroed row (count 0, null avg) so the tile renders a **"no graded actions yet"** placeholder rather than a broken chart. Consumed by [[../integrations/meta-marketing]]-adjacent `GET /api/growth/media-buyer/cohorts` (each enriched cohort carries `grades`).
- `loadAccountGrades(admin, workspaceId, metaAdAccountId, limit=50)` → `AccountGradeRow[]` (newest first) for the per-account detail page `/dashboard/growth/media-buyer/{meta_ad_account_id}` (via `GET /api/growth/media-buyer/grades`). Each row exposes the two orthogonal axes `decisionQuality` + `outcomeQuality` plus `overallGrade` + `realizedRoas`.

## Gotchas

- **No `meta_ad_account_id` on the grades table** — always map through `meta_ads`. An ad not present in `meta_ads` (unsynced) drops out of the rollup.
- Empty `media_buyer_action_grades` (the common case until the grader has run for 3+ days) → every rollup is empty / null; both the tile and the detail page placeholder on it.

## Related

[[../tables/media_buyer_action_grades]] · [[growth-director]] · [[../functions/growth]] · [[../reference/meta-scaling-methodology]]
