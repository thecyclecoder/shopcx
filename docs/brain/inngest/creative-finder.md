# inngest/creative-finder

Daily sweep that pulls long-running competitor + category ads from [[../integrations/adlibrary]], vision-deconstructs each static into a skeleton, and routes videos aside for Phase 6. See [[../specs/winning-static-creative-finder]].

**File:** `src/lib/inngest/creative-finder.ts`

## Functions

### `creative-finder-daily-cron`
- **Trigger:** cron `0 9 * * *`
- **Retries:** 1
- Gated on `hasAdLibraryKey()` → returns `{ skipped: "no_adlibrary_key" }` if unset.
- For each ad-tool workspace (distinct `ad_campaigns.workspace_id`), loops `ALL_SEEDS`: one `step.run` per seed (`sweepSeed`) with a `step.sleep` ~7s throttle between searches (AdLibrary 10/min cap).

### `creative-finder-manual-sweep`
- **Trigger:** event `ads/creative-finder.sweep` `{ workspaceId? }`
- **Retries:** 1
- Same sweep; scoped to `workspaceId` when supplied (else all ad-tool workspaces). Fired by the dashboard "Run sweep now" button.

## Downstream events sent

_None._

## Tables written

- [[../tables/creative_skeletons]] (via [[../libraries/creative-skeleton]] `ingestAd` — idempotent upsert)
- `ai_token_usage` (vision usage, via [[../libraries/ai-usage]])

## Tables read (not written)

- [[../tables/ad_campaigns]] (which workspaces use the ad tool)
- [[../tables/creative_skeletons]] (dedup by `ad_key`)

## Gotchas

- **Dedup + throttle** keep credit/vision spend bounded — re-runs are cheap (already-seen `ad_key`s skipped).
- Per-seed failures are swallowed (`safeSweep`) so one bad keyword doesn't fail the sweep; counts surface in the return value.

---

[[../README]] · [[../integrations/adlibrary]] · [[../libraries/creative-skeleton]] · [[../libraries/adlibrary]] · [[../specs/winning-static-creative-finder]] · [[../../CLAUDE]]
