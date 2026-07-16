# libraries/cold-scaler-cohort

Typed read chokepoint over [[../tables/media_buyer_cold_scaler_cohorts]] — the SCALER-rail sibling of [[media-buyer-publish-gate]] `getEffectiveMediaBuyerTestCohort`. The single allowed entry point for reading a cold-scaler cohort (CLAUDE.md § "Raw .from(...) STOP" — a wrong column name against the table silently reads as empty otherwise). Authored by [[../specs/bianca-cold-scaler-cohort-and-daily-ceiling]] Phase 2 as the foundation the M4 arming gate, CAC:LTV sensor, and graduate-crowned-winners specs read against.

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

## Callers

- Bianca M4 follow-on specs — arming gate, CAC:LTV sensor, graduate-crowned-winners — consume `getEffectiveMediaBuyerColdScalerCohort` to gate on "does a scaler cohort exist for this tuple, and what is its ceiling?"
- Enumeration surfaces (dispatcher, admin editor) use `listActiveColdScalerCohorts` to iterate every scaler cohort for one account.

## Gotchas

- **`.from("media_buyer_cold_scaler_cohorts")` is FORBIDDEN outside this file** (CLAUDE.md § "Raw .from(...) STOP"). All reads go through the two exports; if you need a new query shape, add it here.
- **`bigint` arrives as a string from PostgREST.** The `toColdScalerCohort` mapper normalizes `daily_scaler_ceiling_cents` to `number` so callers don't have to remember. If you add a new bigint column to the table, update the mapper.
- **`null` result ≠ error.** No active row is the DEFAULT — the scaler rail ships dormant. Consumers must treat `null` as "no scaler cohort configured", not "look-up failed".
- **Precedence mirrors the test-cohort SDK deliberately.** If the test-cohort resolver changes, this one should follow — the two are read side-by-side by Bianca M4 arming code.

## Related

[[../tables/media_buyer_cold_scaler_cohorts]] · [[../tables/media_buyer_test_cohorts]] · [[media-buyer-publish-gate]] · [[../specs/bianca-cold-scaler-cohort-and-daily-ceiling]] · [[../goals/bianca-temperature-aware-campaign-structure]] · [[../functions/growth]]
