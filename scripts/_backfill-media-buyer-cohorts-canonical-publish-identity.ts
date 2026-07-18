/**
 * One-off BACKFILL: normalize every active `media_buyer_test_cohorts` row for
 * the Superfoods workspace to the CANONICAL Superfoods Company Facebook Page +
 * Instagram user id.
 *
 * Why: 5 of the 6 hero-product cohorts shipped with
 * `default_meta_instagram_user_id = NULL`, and cohorts pointed at TWO different
 * Facebook Pages (the Superfoods Company page 104094194369069 vs an Ashwavana
 * page 771546149377238). Bianca's Superfood Tabs publish then created ad sets
 * but Meta rejected the ad upload with `meta_400: Instagram Account Is
 * Missing`. The publish path now always resolves the canonical identity via
 * `resolvePublishIdentity` (all-product-ads-always-publish-under-the-superfoods-
 * company-fb-page-and-instagram Phase 1); this backfill fixes the cohorts on
 * disk too so any adhoc script or CEO-console flow that still reads the
 * cohort's `default_meta_page_id`/`default_meta_instagram_user_id` sees the
 * canonical values instead of a stale/wrong per-row default.
 *
 * DRY-RUN by default; `APPLY=1` to write.
 *
 *   npx tsx scripts/_backfill-media-buyer-cohorts-canonical-publish-identity.ts
 *   APPLY=1 npx tsx scripts/_backfill-media-buyer-cohorts-canonical-publish-identity.ts
 */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";
import {
  resolvePublishIdentity,
  SUPERFOODS_WORKSPACE_ID,
} from "../src/lib/media-buyer/publish-identity";

const APPLY = process.env.APPLY === "1";

type CohortRow = {
  id: string;
  workspace_id: string;
  meta_ad_account_id: string | null;
  product_id: string | null;
  is_active: boolean;
  default_meta_page_id: string | null;
  default_meta_instagram_user_id: string | null;
};

(async () => {
  const admin = createAdminClient();
  const canonical = resolvePublishIdentity(SUPERFOODS_WORKSPACE_ID);

  const { data: cohorts, error } = await admin
    .from("media_buyer_test_cohorts")
    .select("id, workspace_id, meta_ad_account_id, product_id, is_active, default_meta_page_id, default_meta_instagram_user_id")
    .eq("workspace_id", SUPERFOODS_WORKSPACE_ID)
    .eq("is_active", true);
  if (error) throw new Error(`select failed: ${error.message}`);

  const rows = (cohorts ?? []) as CohortRow[];
  const drift = rows.filter(
    (r) => r.default_meta_page_id !== canonical.pageId || r.default_meta_instagram_user_id !== canonical.instagramUserId,
  );

  console.log(
    `active cohorts (workspace=${SUPERFOODS_WORKSPACE_ID}): ${rows.length} total · ${drift.length} DRIFTED ` +
      `from canonical page=${canonical.pageId} ig=${canonical.instagramUserId} · mode=${APPLY ? "APPLY" : "DRY-RUN"}`,
  );
  if (!drift.length) {
    console.log("nothing to backfill — every active cohort already points at the canonical Superfoods Company page + IG.");
    return;
  }

  let fixed = 0;
  for (const r of drift) {
    console.log(
      `  FIX  cohort=${r.id} product=${r.product_id ?? "(null)"} account=${r.meta_ad_account_id ?? "(null)"} ` +
        `page=${r.default_meta_page_id ?? "(null)"} → ${canonical.pageId} · ig=${r.default_meta_instagram_user_id ?? "(null)"} → ${canonical.instagramUserId}`,
    );
    if (APPLY) {
      // Compare-and-set: re-assert active + workspace so a concurrent retire between read and write
      // can't be silently clobbered. `.select('id')` proves exactly one row transitioned.
      const { error: upErr, data: upData } = await admin
        .from("media_buyer_test_cohorts")
        .update({
          default_meta_page_id: canonical.pageId,
          default_meta_instagram_user_id: canonical.instagramUserId,
        })
        .eq("id", r.id)
        .eq("workspace_id", SUPERFOODS_WORKSPACE_ID)
        .eq("is_active", true)
        .select("id");
      if (upErr) throw new Error(`update failed cohort=${r.id}: ${upErr.message}`);
      if (!upData?.length) {
        console.log(`    (skipped by compare-and-set — cohort changed since read)`);
        continue;
      }
    }
    fixed++;
  }

  console.log(
    `\nresult: ${fixed} cohort(s) ${APPLY ? "written" : "would be written (DRY-RUN)"} to canonical page + IG.`,
  );
  if (!APPLY) console.log("re-run with APPLY=1 to write.");
})().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
