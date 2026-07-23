# libraries/media-buyer-graduate-scaler

Graduate a crowned test winner into the cold-scaler CBO campaign — the MISSING M4 EXECUTION that turns a crown into scaled spend. When Bianca crowns a test winner AND the product's cold-scaler cohort is active AND the arming gate authorises, this flow DUPLICATES the winning creative into the cohort's scaler campaign as a NEW ad set (reusing the exact creative + targeting + pixel — never re-authoring).

**File:** `src/lib/media-buyer/graduate-scaler.ts` · **Tests:** `src/lib/media-buyer/graduate-scaler.test.ts` (`npx tsx --test src/lib/media-buyer/graduate-scaler.test.ts`).

**Owner:** [[../functions/growth]] · **Parent:** [[../goals/bianca-temperature-aware-campaign-structure]] M4 (bounded, supervised cold scaler gated on Dahlia winner supply) · **Introduced by:** [[../specs/graduate-crowned-winners-into-the-cold-scaler-mint-campaign-and-duplicate]] Phase 2.

**Distinct from** [[cold-scaler-cohort]] — that SDK reads/writes the cohort ROW; this module executes the graduate FLOW using the cohort's `scaler_meta_campaign_id` as the target campaign.

## The four gates

Every autonomous Meta write (the north-star supervisable-autonomy rail — see [[../operational-rules]] § North star) must clear a confirming predicate against current state, not a coarse proxy. This flow has FOUR:

1. **Active cohort exists** — [[cold-scaler-cohort]] `getEffectiveMediaBuyerColdScalerCohort` for the `(workspace, meta_ad_account, product)` tuple returns a non-null row with `isActive=true`. No row → `skip_no_cohort` — the scaler rail is dormant until the workspace owner opts in.
2. **Cohort has a minted scaler campaign** — `cohort.scalerMetaCampaignId` is non-null (Phase 1's `mintAndProvisionColdScalerCampaign` has run). Null → `skip_no_campaign` — the mint is the sanctioned surface; this flow NEVER mints.
3. **Arming authorization allowed + not expired** — [[media-buyer__cold-scaler-arming-gate]] `readLatestColdScalerArmingAuthorization` returns a row with `allowed=true` AND `expires_at > now`. Missing / refused / expired → `skip_not_armed` — the scaler cannot move budget without the human-vetoable authorization ([[media_buyer_cold_scaler_arming_authorization]]).
4. **Idempotency — creative not already published** — [[meta-ads]] `listAdsForCampaignWithCreative` scans every ad under the scaler campaign (ACTIVE + PAUSED + DELETED + ARCHIVED) and returns their `{ adId, creativeId }` pairs. A hit for `winner.metaCreativeId` → `skip_already_graduated` — a winner graduates ONCE.

Only after all four pass does the flow call `createAdSet` + `createAd` on Meta with the winning targeting/pixel/creative reused verbatim. Both writes land PAUSED (the `createAdSet` / `createAd` invariant), so nothing spends until reviewed. The CBO scaler campaign itself carries `daily_budget = cohort.dailyScalerCeilingCents` (set at mint time by Phase 1), so the new ad set inherits the ceiling as the shared pool it competes for — that IS the ceiling-bounded semantic. The graduate flow NEVER writes a per-adset daily budget.

## Exports

### `graduateCrownedWinnerToScaler` — function

```ts
async function graduateCrownedWinnerToScaler(
  admin: Admin,
  input: {
    workspaceId: string;
    productId?: string | null;
    metaAdAccountId: string;         // our UUID (matches cohort scope)
    metaAccountActId: string;         // bare Meta act id (where Meta objects live)
    winner: {
      metaAdId: string;
      metaAdsetId: string;
      metaCreativeId: string;
      targeting: Record<string, unknown>;
      pixelId: string;
    };
    now?: Date;                       // injected clock (tests pin arming-expiry)
    metaClient: GraduateMetaClient;   // production: makeProductionGraduateMetaClient(...)
  },
): Promise<{
  outcome: "graduated" | "skip_no_cohort" | "skip_no_campaign" | "skip_not_armed" | "skip_already_graduated";
  reason: string;
  cohortId: string | null;
  scalerCampaignId: string | null;
  scalerAdsetId: string | null;
  scalerAdId: string | null;
}>
```

The four-gate graduate flow. Never throws on a normal skip — a missing cohort / missing campaign / refused arming / prior graduation all resolve to `skip_*` outcomes and record ONE `cold_scaler_graduate_skipped` [[director_activity]] row with a typed `metadata.skip_reason`. Meta network errors (`createAdSet` / `createAd`) DO propagate — the caller decides whether to retry.

On success emits ONE `cold_scaler_graduated` [[director_activity]] row (Growth-owned) citing `source_meta_ad_id`, `source_meta_creative_id`, `cohort_id`, `scaler_campaign_id`, `scaler_adset_id`, `scaler_ad_id`, and `daily_scaler_ceiling_cents` — the lineage a supervisor can trace end-to-end without opening Meta.

### `makeProductionGraduateMetaClient` — function

```ts
async function makeProductionGraduateMetaClient(args: {
  workspaceId: string;
  metaAccountActId: string;
}): Promise<GraduateMetaClient>
```

Wires the real [[meta-ads]] helpers (`getMetaUserToken` + `listAdsForCampaignWithCreative` + `createAdSet` + `createAd`) behind the injectable `GraduateMetaClient` seam. Throws `no_meta_token` when the workspace has no active Meta connection.

### `describeArmingDenial` — function

```ts
function describeArmingDenial(
  authorization: ColdScalerAuthorizationRow | null,
  now: Date,
): string | null
```

PURE. Returns a human-readable denial reason when the authorization is missing / refused / past its `expires_at`; returns `null` when it clears. Unit-pinned so the four denial branches (null · `allowed=false` · expired · valid) can't drift.

### `GraduateMetaClient` — interface

The Meta-touching seam. Three methods (`listAdsForCampaign`, `createAdSet`, `createAd`). Production wires the real helpers via `makeProductionGraduateMetaClient`; unit tests stub the three methods in-memory so every gate + call sequence is pinned without a Meta round trip.

### `CrownedWinnerInput` — interface

The crowned test winner's Meta lineage: `metaAdId`, `metaAdsetId`, `metaCreativeId`, `targeting`, `pixelId`. The caller ([[media-buyer-agent]]'s action runner, after crown detection via [[media-buyer__meta-cpa-signal]] `detectMetaCpaWinners`) resolves these from the winner it just crowned.

### `GRADUATE_SCALER_SPEC_SLUG` — constant

The spec slug surfaced on every `director_activity.spec_slug` this module writes (both skip + graduate rows), so [[operational-rules]]'s audit-trail invariant is preserved: every autonomous action names the spec that authorised it.

## Callers

- [[media-buyer-agent]] `runMediaBuyerPass` action runner — after crown detection (via [[media-buyer__meta-cpa-signal]] `detectMetaCpaWinners`), the runner invokes `graduateCrownedWinnerToScaler` for each fresh crown. The graduate is a SIBLING of the existing `scale_up` verb on the test rail — the crown's parent adset still gets its `+step_pct` scale under the test campaign; the graduate additionally seeds the scaler campaign with the same creative.
- [[../recipes/graduate-a-crowned-winner]] (future) — the human-run runbook when a workspace owner wants to explicitly graduate one winner (e.g. testing a fresh scaler crown after a mint).

## Gotchas

- **PAUSED is the invariant.** Both `createAdSet` and `createAd` default to `status='PAUSED'` — the graduate flow relies on that default and never passes `status='ACTIVE'`. An unmonitored ad going live on its own violates the north-star supervisable-autonomy rail.
- **Idempotency is checked against Meta's own `/{campaign}/ads`, not a local marker.** A local "already graduated" row could drift; the campaign's ad list cannot. `listAdsForCampaignWithCreative` includes ARCHIVED + DELETED effective statuses so a previously-graduated ad that was later archived still counts as "already published" — the graduate flow must not silently double-mint against the same creative after a manual archive.
- **Meta network errors propagate.** A `createAdSet` / `createAd` throw is NOT converted to a skip. The idempotency gate (Gate 4) is the safety net: a partial failure that created the ad set but not the ad will show the ad set on the next pass, but since Gate 4 keys on CREATIVE (not adset), the retry will attempt `createAd` again with the same creative. To fully de-dupe on retry, key an outer retry on the presence of the ad set name pattern (`MB — Cold Scaler graduate ad <suffix>`); today the flow tolerates a rare orphan adset.
- **The winner's `targeting` is reused verbatim.** The graduate flow does NOT swap in the cohort's own default targeting or re-apply the cold-test recent-purchaser exclusion — the winning targeting IS the crown's proof. Callers that want a different targeting shape must re-shape the `winner.targeting` payload before invoking.
- **Never scales without an active + armed cohort.** The Bianca M4 north-star ("bounded, supervised cold scaler gated on Dahlia winner supply") is encoded at the four gates. A skip is the CORRECT outcome — the audit trail records why.

## Related

[[cold-scaler-cohort]] · [[media-buyer__cold-scaler-arming-gate]] · [[media-buyer__cold-scaler-cac-ltv-sensor]] · [[media-buyer-agent]] · [[media-buyer__meta-cpa-signal]] · [[meta-ads]] · [[../tables/media_buyer_cold_scaler_cohorts]] · [[../tables/media_buyer_cold_scaler_arming_authorization]] · [[../tables/director_activity]] · [[../specs/graduate-crowned-winners-into-the-cold-scaler-mint-campaign-and-duplicate]] · [[../goals/bianca-temperature-aware-campaign-structure]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)
