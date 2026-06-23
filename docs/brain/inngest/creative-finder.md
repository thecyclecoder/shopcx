# inngest/creative-finder

Daily sweep that pulls long-running competitor + category ads from [[../integrations/adlibrary]], vision-deconstructs each static into a skeleton, and routes videos aside for Phase 6. See [[../specs/winning-static-creative-finder]].

**File:** `src/lib/inngest/creative-finder.ts`

## Functions

### `creative-finder-daily-cron`
- **Trigger:** cron `0 9 * * *`
- **Retries:** 1
- Gated on `hasAdLibraryKey()` → returns `{ skipped: "no_adlibrary_key" }` if unset.
- For each ad-tool workspace (distinct `ad_campaigns.workspace_id`), builds the seed list per workspace via `workspaceSeeds()` = **DB-driven approved competitors** ([[competitor-scout]] `loadApprovedCompetitorSeeds`) **+ `CATEGORY_SEEDS`** — competitor brands are no longer hardcoded. One `step.run` per seed (`sweepSeed`) with a `step.sleep` ~7s throttle (AdLibrary 10/min cap).
- After a workspace's sweep, a `promote-${workspaceId}` step runs `promoteFromCategorySweep()` — heavy advertisers that recurred (≥3 ads) in the sweep output surface as `status='proposed'` competitors for owner approval.

### `creative-finder-manual-sweep`
- **Trigger:** event `ads/creative-finder.sweep` `{ workspaceId? }`
- **Retries:** 1
- Same sweep (incl. per-workspace `workspaceSeeds` + category-sweep promotion); scoped to `workspaceId` when supplied (else all ad-tool workspaces). Fired by the dashboard "Run sweep now" button.

## Downstream events sent

_None._

## Tables written

- [[../tables/creative_skeletons]] (via [[../libraries/creative-skeleton]] `ingestAd` — idempotent upsert; now stores the **complete AdLibrary payload** per ad — destination domain, copy, CTA, spend, engagement, channel — see [[../specs/ad-creative-scout]])
- [[../tables/competitors]] (`promoteFromCategorySweep` inserts `source='category_sweep'`, `status='proposed'` candidates)
- `ai_token_usage` (vision usage, via [[../libraries/ai-usage]])

## Tables read (not written)

- [[../tables/ad_campaigns]] (which workspaces use the ad tool)
- [[../tables/competitors]] (approved competitor brands → sweep seeds, via [[../libraries/competitors]] `loadApprovedCompetitorSeeds`)
- [[../tables/creative_skeletons]] (dedup by `ad_key`; promotion scan reads `advertiser`)

## Gotchas

- **Dedup + throttle** keep credit/vision spend bounded — re-runs are cheap (already-seen `ad_key`s skipped).
- Per-seed failures are swallowed (`safeSweep`) so one bad keyword doesn't fail the sweep; counts surface in the return value.

---

[[../README]] · [[../integrations/adlibrary]] · [[../libraries/creative-skeleton]] · [[../libraries/adlibrary]] · [[../libraries/ad-gap]] · [[../libraries/competitors]] · [[../tables/competitors]] · [[competitor-scout]] · [[../specs/ad-creative-scout]] · [[../specs/winning-static-creative-finder]] · [[../specs/competitor-scout]] · [[../../CLAUDE]]
