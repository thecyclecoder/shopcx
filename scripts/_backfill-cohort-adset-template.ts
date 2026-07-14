/**
 * One-off BACKFILL: rebuild `adset_template` for any active per-test cohort whose
 * template is NULL or missing `pixelId`.
 *
 * Bianca (media buyer) fails closed with `media_buyer_replenish_missing_config`
 * when an active `adset_per_test=true` cohort has no template, so the product
 * freezes at whatever ad-slot count it had (Superfood Tabs stuck at 2 of 4).
 * This backfill rebuilds the template via `buildAdsetTemplate({ pixelId })`
 * using the pixel from a SIBLING active cohort on the same `meta_ad_account_id`
 * (accounts share a pixel). If no sibling pixel is resolvable, skip + log — do
 * NOT invent one. Restores exactly what `provisionProductTestCohort` would have
 * written (`src/lib/media-buyer/provision-cohort.ts:92,102`).
 *
 * DRY-RUN by default; `APPLY=1` to write.
 *
 *   npx tsx scripts/_backfill-cohort-adset-template.ts
 *   APPLY=1 npx tsx scripts/_backfill-cohort-adset-template.ts
 */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";
import { buildAdsetTemplate } from "../src/lib/media-buyer/provision-cohort";

const SUPERFOODS_WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.env.APPLY === "1";

type CohortRow = {
  id: string;
  workspace_id: string;
  meta_ad_account_id: string | null;
  product_id: string | null;
  adset_per_test: boolean;
  is_active: boolean;
  adset_template: Record<string, unknown> | null;
};

function pixelIdFrom(row: CohortRow): string | null {
  const t = row.adset_template;
  if (!t || typeof t !== "object") return null;
  const v = (t as Record<string, unknown>).pixelId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

(async () => {
  const admin = createAdminClient();

  const { data: cohorts, error } = await admin
    .from("media_buyer_test_cohorts")
    .select("id, workspace_id, meta_ad_account_id, product_id, adset_per_test, is_active, adset_template")
    .eq("workspace_id", SUPERFOODS_WORKSPACE_ID)
    .eq("is_active", true)
    .eq("adset_per_test", true);
  if (error) throw new Error(`select failed: ${error.message}`);

  const rows = (cohorts ?? []) as CohortRow[];
  const missing = rows.filter((r) => !pixelIdFrom(r));
  const withTpl = rows.filter((r) => pixelIdFrom(r));

  console.log(
    `active per-test cohorts (workspace=${SUPERFOODS_WORKSPACE_ID}): ${rows.length} total · ` +
      `${withTpl.length} with template · ${missing.length} MISSING · mode=${APPLY ? "APPLY" : "DRY-RUN"}`
  );
  if (!missing.length) {
    console.log("nothing to backfill.");
    return;
  }

  // Sibling pixel lookup: keyed by meta_ad_account_id (accounts share a pixel — Superfoods' cohorts all
  // use 468487900426092 per the spec). Only siblings ON THE SAME account count — do NOT cross accounts.
  const pixelByAccount = new Map<string, string>();
  for (const s of withTpl) {
    if (!s.meta_ad_account_id) continue;
    const pid = pixelIdFrom(s);
    if (pid && !pixelByAccount.has(s.meta_ad_account_id)) pixelByAccount.set(s.meta_ad_account_id, pid);
  }

  let fixed = 0;
  let skipped = 0;
  for (const r of missing) {
    const pixelId = r.meta_ad_account_id ? pixelByAccount.get(r.meta_ad_account_id) ?? null : null;
    if (!pixelId) {
      console.log(
        `  SKIP cohort=${r.id} product=${r.product_id ?? "(null)"} account=${r.meta_ad_account_id ?? "(null)"} — no sibling pixel resolvable`
      );
      skipped++;
      continue;
    }
    const template = buildAdsetTemplate({ pixelId });
    console.log(
      `  FIX  cohort=${r.id} product=${r.product_id ?? "(null)"} account=${r.meta_ad_account_id} → pixelId=${pixelId}`
    );
    if (APPLY) {
      // Compare-and-set: re-assert the read-time invariants (still active + per-test + this workspace)
      // so a concurrent provision or retire between read and write can't be clobbered silently.
      const { error: upErr, data: upData } = await admin
        .from("media_buyer_test_cohorts")
        .update({ adset_template: template })
        .eq("id", r.id)
        .eq("workspace_id", r.workspace_id)
        .eq("is_active", true)
        .eq("adset_per_test", true)
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
    `\nresult: ${fixed} template(s) ${APPLY ? "written" : "would be written (DRY-RUN)"} · ${skipped} skipped`
  );
  if (!APPLY) console.log("re-run with APPLY=1 to write.");
})().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
