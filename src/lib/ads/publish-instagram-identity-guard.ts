/**
 * Pre-publish predicate that refuses to submit a placement-customized Meta
 * creative when the resolving ad account has no Instagram identity.
 *
 * Meta's placement-customized creative builders — `createPlacementCreative`
 * (3-bucket PAC) and `createDualAssetCreative` (2-bucket dual) — attach
 * asset-customization rules that render to Instagram placements. Meta rejects
 * that creative with a 400 unless `object_story_spec.instagram_user_id` is set.
 * The single-asset `createAdCreative` path is permissive (Meta accepts a
 * Page-only creative there), so it does NOT require the guard.
 *
 * Publisher (`src/lib/inngest/ad-tool.ts`) computes `placementReady`, `dual`,
 * and `isStatic` from the ad_publish_jobs row, then delegates to this predicate
 * — refusal marks the job `failed` with reason `missing_instagram_identity` and
 * returns normally, so `/api/inngest` stops emitting a Vercel error for what is
 * a fixable configuration problem.
 */

export const MISSING_INSTAGRAM_IDENTITY_REASON = "missing_instagram_identity" as const;

export function publishPathRequiresInstagramIdentity(params: {
  placementReady: boolean;
  dual: boolean;
}): boolean {
  return params.placementReady || params.dual;
}

export function isInstagramIdentityMissing(instagramUserId: string | null | undefined): boolean {
  if (instagramUserId === null || instagramUserId === undefined) return true;
  return String(instagramUserId).trim().length === 0;
}

export function shouldRefuseForMissingInstagramIdentity(params: {
  placementReady: boolean;
  dual: boolean;
  instagramUserId: string | null | undefined;
}): boolean {
  return (
    publishPathRequiresInstagramIdentity(params)
    && isInstagramIdentityMissing(params.instagramUserId)
  );
}
