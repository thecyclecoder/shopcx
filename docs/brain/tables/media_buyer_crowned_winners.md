# media_buyer_crowned_winners

Durable per-workspace ledger of every test adset the Media Buyer's crown detector graduated to "winner." Introduced by [[../specs/media-buyer-persist-crowned-winners-and-guard-reactivation]] Phase 1.

**Why:** Crowning is a READ-TIME verdict today — recomputed each Bianca pass from `meta_insights_daily` + the active [[iteration_policies]] knobs. Nothing persists the fact that a specific test adset was crowned + eligible to graduate to the scaler, and there is no link from the test winner to its scaler duplicate. Bianca's recovered-CPA reactivation avoids resurrecting a graduate BY ACCIDENT — it happens to only consider adsets she paused as losers. But a crown BY DEFINITION has CPA at or below the crown target, which IS the reactivation threshold. So the day a graduated winner is paused through any path (a future graduate flow, an owner, a cleanup), it INSTANTLY qualifies for reactivation and gets pulled back into the test campaign.

This table is the durable crown marker Bianca writes at detection time and every reactivation / re-test flow reads at candidate-set construction to EXCLUDE the graduated adset. A crown-marker row is the contract: "this test adset has already earned its way to graduation — never resurrect it, never re-test it."

**Sibling of** [[media_buyer_cold_scaler_cohorts]] (the SCALER-rail campaign configuration): the cohorts table bounds the scaler; this table records which specific test adset earned a scaler slot.

**Ships empty.** Every workspace starts with zero rows — the marker ledger only fills as Bianca crowns test winners.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `meta_ad_account_id` | `uuid?` | → [[meta_ad_accounts]].id · the Meta ad account the crowned test adset lives under · optional (some legacy passes ran without an account handle) |
| `product_id` | `uuid?` | → [[products]].id · the product the crowned test targeted · resolved from the effective test cohort |
| `test_meta_adset_id` | `text` | NOT NULL · the crowned TEST adset (bare Meta id, client adds no prefix). Row identity — one crown-marker row per `(workspace_id, test_meta_adset_id)` |
| `winning_meta_ad_id` | `text?` | bare Meta ad id of the specific ad-grain within the crowned adset that earned the crown — audit trail for which creative won |
| `crowned_at` | `timestamptz` | NOT NULL default `now()` · first crown detection |
| `graduated_at` | `timestamptz?` | set by the (future) graduate-crowned-winners flow when budget moves onto the scaler; null until then |
| `scaler_meta_campaign_id` | `text?` | bare Meta campaign id of the scaler duplicate — set by graduate flow |
| `scaler_meta_adset_id` | `text?` | bare Meta adset id of the scaler duplicate — set by graduate flow |
| `created_at` | `timestamptz` | NOT NULL default `now()` |
| `updated_at` | `timestamptz` | NOT NULL default `now()` · touched by trigger |

## Indexes

- UNIQUE `(workspace_id, test_meta_adset_id)` — one crown-marker row per test adset. The upsert chokepoint in [[../libraries/crowned-winners]] `recordCrownedWinner` targets this key so replaying Bianca's pass never creates duplicates.
- `(workspace_id, meta_ad_account_id)` — the reactivation guard's read shape (`listCrownedWinnerAdsetIds` narrows on both).

## RLS

- `media_buyer_crowned_winners_select` — workspace members SELECT via `workspace_members.user_id = auth.uid()`.
- `media_buyer_crowned_winners_service` — service-role write (Bianca's pass runs as service role via [[../libraries/crowned-winners]]).

Mirrors [[media_buyer_cold_scaler_cohorts]] policies.

## Writers

- [[../libraries/crowned-winners]] `recordCrownedWinner` — the ONLY writer (CLAUDE.md § "Raw .from(...) STOP" chokepoint). Idempotent upsert on `(workspace_id, test_meta_adset_id)` with `ignoreDuplicates: true` so `graduated_at` / `scaler_meta_*` are NEVER clobbered by a Bianca replay. Called from `src/lib/media-buyer/agent.ts` `runMediaBuyerLoop` after `detectWinners` + `metaAdIdToAdsetId` resolve — one call per winner with a resolved parent adset. Best-effort: a marker-write failure is logged but never fails the Media Buyer pass.

## Consumers

- **Reactivation guard** (Phase 2 of the same spec — WIRED) — [[../libraries/meta-cpa-signal]] `detectMetaCpaReactivations` calls [[../libraries/crowned-winners]] `listCrownedWinnerAdsetIds({ workspaceId, metaAdAccountId })` right after `stillPaused` is built and removes every crowned test adset from the candidate set BEFORE the CPP recovery loop runs. A crowned/graduated winner is NEVER a reactivation target, regardless of who paused it or how well its CPA recovered. The crown-marker row is the durable invariant — an adset present in this table cannot be resurrected into the test campaign, period.
- **Future graduate / re-test / replenish flows** (contract) — MUST consult `listCrownedWinnerAdsetIds` before re-testing a creative or unpausing an adset. That is the crown-marker contract this table enforces; a proxy check (e.g. "did Bianca herself pause it") is not sufficient.

## Related

- [[media_buyer_test_cohorts]] — the test-rail cohort configuration (bounds the test rail's daily spend + adset count). A crowned adset here is a TEST-rail winner ready to graduate.
- [[media_buyer_cold_scaler_cohorts]] — the SCALER-rail campaign configuration (target for graduation). `scaler_meta_campaign_id` on THIS table points to the specific scaler campaign the winner graduated INTO once the graduate flow runs.
- [[../libraries/crowned-winners]] — the SDK chokepoint.
- [[../specs/media-buyer-persist-crowned-winners-and-guard-reactivation]] — the introducing spec (Phase 1 = this table + SDK + write; Phase 2 = reactivation guard).
