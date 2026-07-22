# libraries/media-buyer-retarget-cohort

Typed read + provisioning chokepoint over [[../tables/media_buyer_retarget_cohorts]] — the RETARGET-rail sibling of [[media-buyer-publish-gate]] `getEffectiveMediaBuyerTestCohort` and [[cold-scaler-cohort]] `getEffectiveMediaBuyerColdScalerCohort`. The single allowed entry point for reading + writing a retarget cohort (CLAUDE.md § "Raw .from(...) STOP" — a wrong column name against the table silently reads as empty otherwise). Authored by [[../specs/retarget-campaign-warm-hot-mixed-content]] Phase 1 as the foundation the Phase 2 retarget replenish sibling + Phase 3 retarget cadence cron read against.

**File:** `src/lib/media-buyer/retarget-cohort.ts`

**Callers:** the (future Phase 2) retarget replenish sibling + retarget publish gate, plus any Media Buyer surface that needs to know whether a retarget cohort exists for a `(workspace, meta_ad_account, product)` tuple.

**Distinct from** [[media-buyer-publish-gate]] — that gate reads the TEST-cohort table at PUBLISH time on ONE cold ad set's ABSOLUTE daily budget. [[cold-scaler-cohort]] reads the cold-scaler CAMPAIGN table for cold arming + graduate decisions. This SDK reads the RETARGET table for the warm+hot mixed rail's consolidated adset + ceiling + audience-temperature whitelist. Three cohort concepts, three tables, one precedence pattern.

## Exports

### `RetargetAudienceTemperature` — type alias

```ts
type RetargetAudienceTemperature = "warm" | "hot";
```

### `DEFAULT_RETARGET_AUDIENCE_TEMPERATURES` — const

`['warm', 'hot']` — the whitelist a retarget cohort ships with by default. Mirrors the migration's column default and the v3 goal M3 design ("warm+hot mixed").

### `MediaBuyerRetargetCohort` — interface

TS shape of a [[../tables/media_buyer_retarget_cohorts]] row (`snake → camel`; `bigint` `daily_ceiling_cents` normalized to `number`; `audience_temperatures` filtered to the legal whitelist).

```ts
interface MediaBuyerRetargetCohort {
  id: string;
  workspaceId: string;
  metaAdAccountId: string | null;
  productId: string | null;
  retargetMetaCampaignId: string;
  retargetMetaAdsetId: string;
  dailyCeilingCents: number;
  audienceTemperatures: RetargetAudienceTemperature[];
  defaultMetaPageId: string | null;
  defaultMetaInstagramUserId: string | null;
  isActive: boolean;
  notes: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### `getEffectiveRetargetCohort` — function

```ts
async function getEffectiveRetargetCohort(
  admin: Admin,
  workspaceId: string,
  args?: { metaAdAccountId?: string | null; productId?: string | null },
): Promise<MediaBuyerRetargetCohort | null>
```

Resolves the MOST-SPECIFIC active row for one `(workspace, meta_ad_account, product)` tuple — mirrors [[cold-scaler-cohort]] `getEffectiveMediaBuyerColdScalerCohort` + [[media-buyer-publish-gate]] `getEffectiveMediaBuyerTestCohort` so the three cohort concepts have identical semantics:

1. `(metaAdAccountId, productId)` — most specific.
2. `(metaAdAccountId, product NULL)` — the account default.
3. `(account NULL, product NULL)` — the workspace-wide default.

Only considers `is_active=true` rows. Returns `null` when no active row matches — the Phase 2 replenish sibling treats "retarget surface dormant" and no-ops.

### `listActiveRetargetCohorts` — function

```ts
async function listActiveRetargetCohorts(
  admin: Admin,
  args: { workspaceId: string; metaAdAccountId: string | null },
): Promise<MediaBuyerRetargetCohort[]>
```

Enumerate every ACTIVE retarget cohort for one `(workspace, meta_ad_account)` pair, sorted by `product_id` ASC with nulls last — same shape as [[cold-scaler-cohort]] `listActiveColdScalerCohorts`. Consumed by the Phase 2 retarget replenish sibling's per-account dispatch loop. `metaAdAccountId=null` restricts to the workspace-wide (null-account) rows.

### `provisionRetargetCohort` — function

```ts
async function provisionRetargetCohort(
  admin: Admin,
  opts: ProvisionRetargetCohortOptions,
): Promise<ProvisionRetargetCohortResult>
```

Provision (or refresh) a workspace's retarget cohort for one `(workspace, meta_ad_account, product)` tuple. Idempotent by tuple: RETIRES any prior active row at the SAME tuple, then inserts a fresh active row with the canonical publish identity resolved via [[media-buyer-publish-identity]] `resolvePublishIdentity` — the shipped [[../specs/all-product-ads-always-publish-under-the-superfoods-company-fb-page-and-instagram]] Phase 1 chokepoint. A wrong or missing publish identity is structurally impossible.

`ProvisionRetargetCohortOptions`:

```ts
interface ProvisionRetargetCohortOptions {
  workspaceId: string;
  metaAdAccountId?: string | null;
  productId?: string | null;
  retargetMetaCampaignId: string;   // required — bare Meta id
  retargetMetaAdsetId: string;      // required — bare Meta id
  dailyCeilingCents: number;        // required — > 0
  audienceTemperatures?: RetargetAudienceTemperature[];  // default ['warm','hot']
  notes?: string;
}
```

Throws on empty campaign/adset id, non-positive ceiling, empty temperature whitelist, or an unknown workspace (via `resolvePublishIdentity`). Phase 1 does NOT mint the campaign/adset — the caller supplies the pair the founder has created via the (later Phase 2/3) admin surface or manually. Minting flows live in Phase 2/3.

## Callers

- Phase 2 retarget replenish sibling (`runRetargetReplenishLoopForAccount`) — consumes `listActiveRetargetCohorts` + `getEffectiveRetargetCohort` to iterate active retarget cohorts and filter the warm/hot ready-to-test bin per cohort.
- Phase 2 retarget publish gate (`evaluateMediaBuyerRetargetPublish`) — reads the effective cohort at publish time to enforce the daily ceiling + audience-temperature whitelist.
- (Future) retarget admin surface — calls `provisionRetargetCohort` on owner opt-in.

## Gotchas

- **`.from("media_buyer_retarget_cohorts")` is FORBIDDEN outside this file** (CLAUDE.md § "Raw .from(...) STOP"). All reads + writes go through the exports; if you need a new query shape, add it here.
- **`bigint` arrives as a string from PostgREST.** The `toRetargetCohort` mapper normalizes `daily_ceiling_cents` to `number` so callers don't have to remember. If you add a new bigint column to the table, update the mapper.
- **`null` result ≠ error.** No active row is the DEFAULT — the retarget rail ships dormant. Consumers must treat `null` as "no retarget cohort configured", not "look-up failed".
- **Precedence mirrors the test-cohort + cold-scaler SDKs deliberately.** If either resolver changes, this one should follow — the three are read side-by-side in the Media Buyer's per-account dispatch.
- **`audience_temperatures` is filtered at read time.** Only `warm` + `hot` are legal; a stray value silently drops. Add a new legal temperature by widening `RetargetAudienceTemperature` here AND the migration's column default.
- **`provisionRetargetCohort` resolves the publish identity from `resolvePublishIdentity`, never from caller input.** A future edit that adds a `pageId` / `instagramUserId` option would silently re-open the 5-of-6 cohorts-missing-IG defect the publish-identity spec closed. Do not add those knobs.
- **Phase 1 does not mint Meta ids.** `retargetMetaCampaignId` + `retargetMetaAdsetId` are caller-provided. Phase 2/3 will introduce a getOrCreate helper that mints them; until then the founder supplies the pair.

## Related

[[../tables/media_buyer_retarget_cohorts]] · [[../tables/media_buyer_test_cohorts]] · [[../tables/media_buyer_cold_scaler_cohorts]] · [[cold-scaler-cohort]] · [[media-buyer-publish-gate]] · [[media-buyer-publish-identity]] · [[provision-cohort]] · [[../specs/retarget-campaign-warm-hot-mixed-content]] · [[../specs/bianca-route-ready-creatives-by-dahlia-temperature-tag]] · [[../specs/all-product-ads-always-publish-under-the-superfoods-company-fb-page-and-instagram]] · [[../goals/v3-ad-creative-engine]] · [[../functions/growth]]
