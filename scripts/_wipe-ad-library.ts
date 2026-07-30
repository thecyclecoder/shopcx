/**
 * Wipe Dahlia's UNPUBLISHED creative bin for the retool freeze. Founder-approved 2026-07-15.
 *
 * SCOPE (hard safety):
 *   - Delete ad_campaigns with status IN ('ready','draft') that were NEVER published
 *     (id NOT referenced by any ad_publish_jobs row) + their ad_videos children.
 *   - KEEP 'archived' (historical learning) and KEEP anything ever published (live-test lineage).
 *   - ad_campaigns has NO meta/published columns — live Meta ads live in ad_publish_jobs/meta_adsets
 *     and on Meta itself, so this never unpublishes or touches a live test.
 *
 *   npx tsx scripts/_wipe-ad-library.ts           # dry run — counts only
 *   npx tsx scripts/_wipe-ad-library.ts --apply   # delete
 */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";

const WS = process.env.WS || "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();

  const { data: campaigns, error: cErr } = await admin
    .from("ad_campaigns").select("id,status,product_id,name").eq("workspace_id", WS);
  if (cErr) throw new Error(cErr.message);

  const { data: pubs, error: pErr } = await admin
    .from("ad_publish_jobs").select("campaign_id").eq("workspace_id", WS);
  if (pErr) throw new Error(pErr.message);
  const publishedIds = new Set((pubs || []).map((p) => p.campaign_id).filter(Boolean));

  const unpublishedBin = (campaigns || []).filter(
    (c) => (c.status === "ready" || c.status === "draft") && !publishedIds.has(c.id),
  );
  const protectedPublished = (campaigns || []).filter(
    (c) => (c.status === "ready" || c.status === "draft") && publishedIds.has(c.id),
  );
  const archived = (campaigns || []).filter((c) => c.status === "archived");
  const deleteIds = unpublishedBin.map((c) => c.id);

  console.log(`ad_campaigns total: ${campaigns?.length ?? 0}`);
  console.log(`  → DELETE (unpublished ready/draft): ${unpublishedBin.length}`);
  console.log(`  → KEEP (ready/draft that WERE published — live lineage): ${protectedPublished.length}`);
  console.log(`  → KEEP (archived history): ${archived.length}`);

  // children to remove first
  let videoCount = 0;
  if (deleteIds.length) {
    const { data: vids } = await admin.from("ad_videos").select("id").in("campaign_id", deleteIds);
    videoCount = vids?.length ?? 0;
  }
  console.log(`  → ad_videos children to delete: ${videoCount}`);

  if (!APPLY) { console.log("\nDRY RUN — pass --apply to delete."); return; }
  if (!deleteIds.length) { console.log("\nnothing to delete."); return; }

  // delete in chunks to stay well under any limits
  const chunk = <T,>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
  for (const ids of chunk(deleteIds, 100)) {
    const { error: vErr } = await admin.from("ad_videos").delete().in("campaign_id", ids);
    if (vErr) throw new Error(`ad_videos delete: ${vErr.message}`);
    const { error: dErr } = await admin.from("ad_campaigns").delete().in("id", ids);
    if (dErr) throw new Error(`ad_campaigns delete: ${dErr.message}`);
  }
  const { count } = await admin.from("ad_campaigns").select("id", { count: "exact", head: true }).eq("workspace_id", WS);
  console.log(`\n✓ WIPED ${deleteIds.length} unpublished creatives (+${videoCount} ad_videos). ad_campaigns now: ${count}.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
