# libraries/media-buyer-publish-identity

Canonical publish identity — the SINGLE Superfoods Company Facebook Page + Instagram user id every paid-social ad publishes under, resolved from a workspace registry so no per-cohort divergence can silently ship an ad under the wrong brand. Authored by [[../specs/all-product-ads-always-publish-under-the-superfoods-company-fb-page-and-instagram]] (Phase 1).

**File:** `src/lib/media-buyer/publish-identity.ts`

**Callers:** [[media-buyer-agent]] `enqueueReplenishPublish` → `buildReplenishJobInsert`. The resolver's result is stamped onto every replenish [[../tables/ad_publish_jobs]] row's `meta_page_id` + `meta_instagram_user_id`, so [[../inngest/ad-tool]] `adToolPublishToMeta` reads the canonical values (never the cohort's per-row `default_meta_page_id`/`default_meta_instagram_user_id`) when it builds Meta's `object_story_spec`.

**Distinct from** [[ads__publish-instagram-identity-guard]] — that guard is the fail-CLOSED rail at the publisher (`adToolPublishToMeta`) that refuses a placement-customized creative when the job's IG is null (Meta returns 400 `Instagram Account Is Missing`). This library is the always-canonical INJECTOR upstream at Bianca's insert step; the two compose (canonical injection → guard). Even if the canonical constant were emptied by a future edit, `buildReplenishJobInsert` refuses at the same money step (`missing_canonical_instagram_identity`) and the downstream guard still catches any non-Bianca publish path that skipped the injector.

## Exports

### `SUPERFOODS_WORKSPACE_ID` — const

`"fdc11e10-b89f-4989-8b73-ed6526c4d906"` — the sole workspace on record today. Also used by many `scripts/*.ts` as `WS`/`WORKSPACE_ID`. Kept exported so the backfill script + tests share the same anchor.

### `SUPERFOODS_COMPANY_PAGE_ID` — const

`"104094194369069"` — the Superfoods Company Facebook Page id. Every product's paid-social ad publishes under this page.

### `SUPERFOODS_COMPANY_INSTAGRAM_USER_ID` — const

`"17841409041235543"` — the Superfoods Company Instagram user id (@superfoodscompany). Meta's placement-customized creative builder requires `object_story_spec.instagram_user_id`; this is that id, canonical for every product.

### `MISSING_CANONICAL_INSTAGRAM_IDENTITY_REASON` — const

`"missing_canonical_instagram_identity"` — the stable refusal fingerprint `buildReplenishJobInsert` returns when the resolved identity's `instagramUserId` is empty. Belt-and-suspenders over the resolver constant; would only fire if a future edit emptied it.

### `PublishIdentity` — interface

`{ pageId: string; instagramUserId: string }` — the resolved canonical pair. Passed into `buildReplenishJobInsert` so unit tests can pin a fixture without triggering the resolver's Superfoods lookup.

### `resolvePublishIdentity(workspaceId)` — function

```ts
function resolvePublishIdentity(workspaceId: string): PublishIdentity
```

Returns the canonical Facebook Page + Instagram user id for `workspaceId`. Superfoods is the sole registered workspace — any other id THROWS with `no canonical publish identity registered for workspace <id>`. A throw is the correct fail-closed default: silent per-cohort fallback is exactly what caused the two-different-pages divergence this spec kills.

### `hasResolvedInstagramIdentity(identity)` — function

`(identity: { instagramUserId } | null | undefined) => boolean` — PURE. Treats null/undefined/empty/whitespace as MISSING; a real string as PRESENT. Used by `buildReplenishJobInsert` as the belt-and-suspenders guard: even if a future edit empties the constant, the insert path refuses (`missing_canonical_instagram_identity`) rather than shipping an ad_publish_jobs row that Meta will 400 on.

## How the publish path uses it

1. Bianca's cadence pass ([[media-buyer-agent]] `runMediaBuyer` → `runReplenish` → `enqueueReplenishPublish`) calls `resolvePublishIdentity(workspaceId)` once per publish.
2. The resolved `{ pageId, instagramUserId }` is passed into `buildReplenishJobInsert` as `publishIdentity`.
3. `buildReplenishJobInsert` writes `meta_page_id` = `publishIdentity.pageId` and `meta_instagram_user_id` = `publishIdentity.instagramUserId` on the [[../tables/ad_publish_jobs]] insert body — never the cohort's `defaultMetaPageId` / `defaultMetaInstagramUserId`.
4. [[../inngest/ad-tool]] `adToolPublishToMeta` reads those two columns from the job row and builds Meta's `object_story_spec` with the canonical values, so the placement/dual creative always carries a non-null `instagram_user_id`.

## Backfill

`scripts/_backfill-media-buyer-cohorts-canonical-publish-identity.ts` — sets `default_meta_page_id` + `default_meta_instagram_user_id` on every active Superfoods cohort to the canonical pair (compare-and-set, dry-run by default, `APPLY=1` to write). The publish path itself no longer consults those columns, but the backfill keeps the cohorts on disk aligned so any adhoc script or CEO-console flow that still reads the per-row defaults sees canonical values instead of the historical drift (5-of-6 cohorts had `NULL` IG, and cohorts pointed at two different Facebook Pages).

## Status / open work

- ✅ Phase 1 shipped — resolver + `buildReplenishJobInsert` canonical injection + fail-closed guard + tests + backfill.

## Related

- [[../specs/all-product-ads-always-publish-under-the-superfoods-company-fb-page-and-instagram]] — the spec.
- [[ads__publish-instagram-identity-guard]] — the downstream fail-closed rail at `adToolPublishToMeta`.
- [[media-buyer-agent]] `enqueueReplenishPublish` — the caller.
- [[media-buyer-publish-gate]] — the sibling gate library (test-cohort ceiling + Max copy-QC rails).
- [[../tables/media_buyer_test_cohorts]] — the cohort table (its `default_meta_page_id` + `default_meta_instagram_user_id` are the legacy columns this spec kills as a source of truth for publish).
