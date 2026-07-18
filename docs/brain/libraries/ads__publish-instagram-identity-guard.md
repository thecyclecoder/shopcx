# `src/lib/ads/publish-instagram-identity-guard.ts` — Fail closed on missing Instagram identity

Pre-publish guard that refuses to submit a placement-customized Meta creative when the resolving ad account has no Instagram identity. Shipped as [[../specs/meta-publisher-missing-instagram-identity-guard]] Phase 1.

Meta's placement-customized creative builders — `createPlacementCreative` (3-bucket PAC) and `createDualAssetCreative` (2-bucket dual) — attach asset-customization rules that render to Instagram placements. Meta rejects that creative with a 400 unless `object_story_spec.instagram_user_id` is set. The single-asset `createAdCreative` path is permissive (Meta accepts a Page-only creative there), so it does NOT require the guard.

Publisher ([[../inngest/ad-tool]]) computes `placementReady`, `dual`, and `isStatic` from the `ad_publish_jobs` row, then delegates to this guard — refusal marks the job `failed` with reason `missing_instagram_identity` and returns normally, so `/api/inngest` stops emitting a Vercel error for what is a fixable configuration problem.

## Exports

| Export | Notes |
|---|---|
| `MISSING_INSTAGRAM_IDENTITY_REASON` | Constant sentinel (`"missing_instagram_identity"`) the publisher writes to `ad_publish_jobs.publish_status`. Stable fingerprint for escalations + director_activity deduping. |
| `publishPathRequiresInstagramIdentity(params)` | Pure predicate. Returns `true` iff `params.placementReady` OR `params.dual` (placement-customized paths need the identity; single-asset path does not). |
| `isInstagramIdentityMissing(instagramUserId)` | Pure predicate. Returns `true` iff the `instagramUserId` is null, undefined, or blank string. |
| `shouldRefuseForMissingInstagramIdentity(params)` | Main guard predicate. Returns `true` iff the publish path requires an Instagram identity AND the identity is missing. Combines the above two predicates. |

## Caller

[[../inngest/ad-tool]] `adToolPublishToMeta` — preflight guard before upload. After `placementReady` / `dual` / `isStatic` are resolved and before image upload / creative creation, the publisher calls `shouldRefuseForMissingInstagramIdentity` with the job's metadata. On refusal, marks the job `failed` with `error: MISSING_INSTAGRAM_IDENTITY_REASON` and returns normally (no throw).

## Related

[[ads__creative-pack-gate]] (Phase 3 pack refusal) · [[ads__placement-publish]] (Phase 2 routing) · [[meta-ads]] (`createPlacementCreative` / `createDualAssetCreative`) · [[../lifecycles/ad-publish]]
