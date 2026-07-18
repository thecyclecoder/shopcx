/**
 * Canonical publish identity — the SINGLE Superfoods Company Facebook Page +
 * Instagram account every product's paid-social ad must publish under.
 *
 * CEO's rule: every product's ads always publish under the SAME brand identity —
 * Facebook Page 104094194369069 ('Superfoods Company') and Instagram
 * 17841409041235543 (@superfoodscompany). Not per-product, not per-cohort — one
 * identity for the whole company, so an Instagram-placement ad can always upload
 * and no cohort can silently point at the wrong page.
 *
 * Why this file exists: 5 of the 6 hero-product `media_buyer_test_cohorts` rows
 * shipped with `default_meta_instagram_user_id = NULL`, and the cohorts pointed
 * at TWO different Facebook Pages (Superfoods Company page 104094194369069 vs an
 * Ashwavana page 771546149377238). Bianca's Superfood Tabs publish then created
 * the ad sets but Meta rejected the ad upload with `meta_400: Instagram Account
 * Is Missing` — the placement-customized creative builder requires an
 * `object_story_spec.instagram_user_id`. Making the publish path resolve the
 * canonical identity here (instead of reading the per-cohort default) fixes the
 * whole class: no cohort can diverge from the CEO's brand identity, and a
 * missing IG becomes structurally impossible.
 *
 * Pair with:
 * - [[./agent]] `buildReplenishJobInsert` — stamps the canonical `meta_page_id`
 *   + `meta_instagram_user_id` on every replenish `ad_publish_jobs` row (never
 *   reads the cohort's `default_meta_page_id`/`default_meta_instagram_user_id`
 *   for the shipped values).
 * - [[../ads/publish-instagram-identity-guard]] `shouldRefuseForMissingInstagramIdentity`
 *   — the fail-closed rail at `adToolPublishToMeta` that refuses a placement or
 *   dual-asset creative when the resolved IG is empty; belt-and-suspenders over
 *   the always-canonical resolver here.
 *
 * (all-product-ads-always-publish-under-the-superfoods-company-fb-page-and-instagram
 * Phase 1)
 */

/** Superfoods Company workspace id — the only workspace on record today. */
export const SUPERFOODS_WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

/** Canonical Facebook Page id every Superfoods Company product ad publishes under. */
export const SUPERFOODS_COMPANY_PAGE_ID = "104094194369069";

/** Canonical Instagram user id every Superfoods Company product ad publishes under (@superfoodscompany). */
export const SUPERFOODS_COMPANY_INSTAGRAM_USER_ID = "17841409041235543";

/** The stable refusal fingerprint for a canonical-identity resolver that came back with an empty IG. */
export const MISSING_CANONICAL_INSTAGRAM_IDENTITY_REASON =
  "missing_canonical_instagram_identity" as const;

/** Resolved canonical publish identity for a workspace. */
export interface PublishIdentity {
  pageId: string;
  instagramUserId: string;
}

/**
 * Return the canonical Facebook Page + Instagram user id every product's ads
 * publish under for `workspaceId`. Superfoods is the sole registered workspace —
 * any other id throws, so a mis-scoped call can never silently publish under
 * an unintended brand identity (the whole point of pinning ONE canonical
 * identity per the CEO's rule).
 */
export function resolvePublishIdentity(workspaceId: string): PublishIdentity {
  if (workspaceId === SUPERFOODS_WORKSPACE_ID) {
    return {
      pageId: SUPERFOODS_COMPANY_PAGE_ID,
      instagramUserId: SUPERFOODS_COMPANY_INSTAGRAM_USER_ID,
    };
  }
  throw new Error(
    `resolvePublishIdentity: no canonical publish identity registered for workspace ${workspaceId} — ` +
      `add it here before publishing (never silently fall back to a per-cohort default).`,
  );
}

/**
 * PURE — the resolver returned an identity with a non-empty Instagram user id.
 * Guards against a future edit that leaves a canonical constant empty; the
 * publish path should REFUSE (never mint an orphan ad set) if this predicate
 * ever comes back false at runtime.
 */
export function hasResolvedInstagramIdentity(
  identity: Pick<PublishIdentity, "instagramUserId"> | null | undefined,
): boolean {
  if (!identity) return false;
  return String(identity.instagramUserId ?? "").trim().length > 0;
}
