/** Prove the Research > Ads grid now returns rows for K-Cups: same predicate as the route. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
import { resolveShelfProductIds } from "../src/lib/ads/creative-sourcing";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KCUPS = "f081a8ee-530b-4789-8654-bd57c3a51569";

async function main() {
  const a = createAdminClient();

  const before = await a.from("creative_skeletons").select("id", { count: "exact", head: true })
    .eq("workspace_id", WS).in("status", ["analyzed", "shortlisted"]).eq("media_type", "static")
    .eq("product_id", KCUPS).eq("do_not_use", false);
  console.log(`BEFORE (.eq product_id)  → ${before.count} ads`);

  const ids = await resolveShelfProductIds(a, KCUPS);
  const after = await a.from("creative_skeletons").select("id", { count: "exact", head: true })
    .eq("workspace_id", WS).in("status", ["analyzed", "shortlisted"]).eq("media_type", "static")
    .in("product_id", ids).eq("do_not_use", false);
  console.log(`AFTER  (.in shelf ids)   → ${after.count} ads   shelf=[${ids.length} product(s)]`);

  const vid = await a.from("creative_skeletons").select("id", { count: "exact", head: true })
    .eq("workspace_id", WS).in("status", ["analyzed", "shortlisted", "video_pending"]).eq("media_type", "video")
    .in("product_id", ids).eq("do_not_use", false);
  console.log(`AFTER  (video toggle)    → ${vid.count} ads`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
