# libraries/cold-scaler-cohort

Typed read + WRITE chokepoint over [[../tables/media_buyer_cold_scaler_cohorts]] — the SCALER-rail sibling of [[media-buyer-publish-gate]] `getEffectiveMediaBuyerTestCohort`. The single allowed entry point for reading (and, since [[../specs/graduate-crowned-winners-into-the-cold-scaler-mint-campaign-and-duplicate]] Phase 1, writing) a cold-scaler cohort — CLAUDE.md § "Raw .from(...) STOP" applies to both directions (a wrong column name silently reads as empty on the read half, and silently drops `is_active` on the write half so the scaler rail can look opted-in when it isn't). Read half authored by [[../specs/bianca-cold-scaler-cohort-and-daily-ceiling]] Phase 2; write half by the graduate spec Phase 1.

**File:** `src/lib/media-buyer/cold-scaler-cohort.ts` · **Tests:** `src/lib/media-buyer/cold-scaler-cohort.test.ts` (`npm run test:media-buyer-cold-scaler-cohort`).

**Callers:** the (future) Bianca M4 follow-on specs — arming gate, CAC:LTV sensor, graduate — plus any Media Buyer surface that needs to know whether a scaler cohort exists for a `(workspace, meta_ad_account, product)` tuple.

**Distinct from** [[media-buyer-publish-gate]] — that gate reads the TEST-cohort table at PUBLISH time on ONE ad set's ABSOLUTE daily budget; this SDK reads the SCALER-cohort table for ceiling/arming decisions on a CAMPAIGN. Different tables, different rails, same precedence pattern.

## Exports

### `MediaBuyerColdScalerCohort` — interface

TS shape of a [[../tables/media_buyer_cold_scaler_cohorts]] row (`snake → camel`; `bigint` `daily_scaler_ceiling_cents` normalized to `number`).

```ts
interface MediaBuyerColdScalerCohort {
  id: string;
  workspaceId: string;
  metaAdAccountId: string | null;
  productId: string | null;
  scalerMetaCampaignId: string | null;
  dailyScalerCeilingCents: number;
  isActive: boolean;
  notes: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### `getEffectiveMediaBuyerColdScalerCohort` — function

```ts
async function getEffectiveMediaBuyerColdScalerCohort(
  admin: Admin,
  workspaceId: string,
  args: { metaAdAccountId?: string | null; productId?: string | null },
): Promise<MediaBuyerColdScalerCohort | null>
```

Resolves the MOST-SPECIFIC active row for one `(workspace, meta_ad_account, product)` tuple — mirrors [[media-buyer-publish-gate]] `getEffectiveMediaBuyerTestCohort` so the two cohort concepts have identical semantics:

1. `(metaAdAccountId, productId)` — most specific.
2. `(metaAdAccountId, product NULL)` — the account default.
3. `(account NULL, product NULL)` — the workspace-wide default.

Only considers `is_active=true` rows. Returns `null` when no active row matches — consumers then treat "scaler surface dormant" (arming gate refuses).

### `listActiveColdScalerCohorts` — function

```ts
async function listActiveColdScalerCohorts(
  admin: Admin,
  args: { workspaceId: string; metaAdAccountId: string | null },
): Promise<MediaBuyerColdScalerCohort[]>
```

Enumerate every ACTIVE scaler cohort for one `(workspace, meta_ad_account)` pair, sorted by `product_id` ASC with nulls last — same shape as the `readActiveCohortProductIds` pattern the Phase 3 media-buyer dispatcher uses over [[media_buyer_test_cohorts]]. `metaAdAccountId=null` restricts to the workspace-wide (null-account) rows.

### `setColdScalerCampaignId` — function

```ts
async function setColdScalerCampaignId(
  admin: Admin,
  args: { cohortId: string; scalerMetaCampaignId: string },
): Promise<{ stamped: number }>
```

Compare-and-set writer for the cohort's `scaler_meta_campaign_id`. The `.is("scaler_meta_campaign_id", null)` guard means two concurrent graduate executors can't double-stamp — the second one no-ops (`stamped=0`) and the caller re-reads via `getMediaBuyerColdScalerCohortById` to see the id the first executor persisted. Called by `mintAndProvisionColdScalerCampaign` below and by [[../specs/bianca-cold-scaler-graduate-crowned-winners-to-advantage-plus-new-customers]] Phase 3's `executeGraduateActionAgainstMeta`.

### `provisionColdScalerCohort` — function ([[../specs/graduate-crowned-winners-into-the-cold-scaler-mint-campaign-and-duplicate]] Phase 1)

```ts
async function provisionColdScalerCohort(
  admin: Admin,
  opts: {
    workspaceId: string;
    metaAdAccountId?: string | null;
    productId?: string | null;
    dailyScalerCeilingCents: number;
    notes?: string | null;
    updatedBy?: string | null;
  },
): Promise<{
  cohortId: string;
  metaAdAccountId: string | null;
  productId: string | null;
  dailyScalerCeilingCents: number;
}>
```

SANCTIONED provision writer — retires any prior ACTIVE row for the same `(workspace, meta_ad_account, product)` scope (leaves the audit trail), then inserts a fresh active row with the owner-set `daily_scaler_ceiling_cents`. The retire-then-insert order preserves the table's partial unique index (one active row per scope). Invariant: `dailyScalerCeilingCents > 0` — a `≤ 0` ceiling throws before touching the DB so the scaler rail can never seed unbounded. This is the (future) Media Buyer admin surface's write; today a one-off seed script calls it. Never client-side.

### `mintAndProvisionColdScalerCampaign` — function ([[../specs/graduate-crowned-winners-into-the-cold-scaler-mint-campaign-and-duplicate]] Phase 1)

```ts
async function mintAndProvisionColdScalerCampaign(
  admin: Admin,
  opts: { workspaceId: string; cohortId: string; metaAccountActId: string },
): Promise<{ cohortId: string; scalerMetaCampaignId: string; stampedNow: boolean }>
```

Composed execution helper — combines two pre-existing chokepoints so callers don't have to sequence them: (1) [[../meta-ads]] `getOrCreateColdScalerCampaign` mints (or finds) the cohort's CBO / Advantage+ Sales scaler campaign on Meta (`PAUSED`, new-customer-only, `daily_budget = cohort.daily_scaler_ceiling_cents`); (2) `setColdScalerCampaignId` compare-and-set-stamps the bare campaign id onto the cohort. Idempotent — a cohort whose `scaler_meta_campaign_id` is already set short-circuits and returns the existing id (no Meta call, `stampedNow=false`). Throws `cold_scaler_cohort_not_found_or_dormant` when the cohort is missing or `is_active=false` (fail-closed — a dormant cohort must never mint a campaign it can't own).

## Callers

- Bianca M4 follow-on specs — arming gate, CAC:LTV sensor, graduate-crowned-winners — consume `getEffectiveMediaBuyerColdScalerCohort` to gate on "does a scaler cohort exist for this tuple, and what is its ceiling?"
- Enumeration surfaces (dispatcher, admin editor) use `listActiveColdScalerCohorts` to iterate every scaler cohort for one account.

## Gotchas

- **`.from("media_buyer_cold_scaler_cohorts")` is FORBIDDEN outside this file** (CLAUDE.md § "Raw .from(...) STOP"). All reads AND writes go through the exports (`provisionColdScalerCohort` for the row upsert, `setColdScalerCampaignId` for the campaign-id stamp); if you need a new query shape, add it here.
- **`bigint` arrives as a string from PostgREST.** The `toColdScalerCohort` mapper normalizes `daily_scaler_ceiling_cents` to `number` so callers don't have to remember. If you add a new bigint column to the table, update the mapper.
- **`null` result ≠ error.** No active row is the DEFAULT — the scaler rail ships dormant. Consumers must treat `null` as "no scaler cohort configured", not "look-up failed".
- **Precedence mirrors the test-cohort SDK deliberately.** If the test-cohort resolver changes, this one should follow — the two are read side-by-side by Bianca M4 arming code.

## Related

[[../tables/media_buyer_cold_scaler_cohorts]] · [[../tables/media_buyer_test_cohorts]] · [[media-buyer-publish-gate]] · [[meta-ads]] · [[../specs/bianca-cold-scaler-cohort-and-daily-ceiling]] · [[../specs/graduate-crowned-winners-into-the-cold-scaler-mint-campaign-and-duplicate]] · [[../goals/bianca-temperature-aware-campaign-structure]] · [[../functions/growth]]
