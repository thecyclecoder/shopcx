/** Verify the cohort-unseal fix using the ACTUAL patched readers, not a re-implementation. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
import { readCurrentTestCohortSize, readCurrentLiveCrownedCount, readCurrentLiveExploitCount } from "../src/lib/media-buyer/agent";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const EXPLORE_TARGET_WITH_WINNER = 2;

async function main() {
  const admin = createAdminClient();
  const { data: cohorts } = await admin.from("media_buyer_test_cohorts")
    .select("id,product_id,test_meta_campaign_id,is_active").eq("workspace_id", WS).eq("is_active", true);
  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id", WS);
  const title = new Map((prods ?? []).map((p) => [p.id as string, String(p.title)]));

  console.log("cohort                          size  exploit  crowned  liveExplore  deficit  →");
  for (const c of cohorts ?? []) {
    const camp = c.test_meta_campaign_id as string | null;
    const size = await readCurrentTestCohortSize(admin, {
      workspaceId: WS, productId: c.product_id as string, testMetaCampaignId: camp,
    });
    const exploit = await readCurrentLiveExploitCount(admin, { workspaceId: WS, productId: c.product_id as string });
    const crowned = await readCurrentLiveCrownedCount(admin, { workspaceId: WS, testMetaCampaignId: camp });

    const clampedExploit = Math.min(exploit, Math.max(0, size));
    const clampedCrowned = Math.min(crowned, Math.max(0, size - clampedExploit));
    const liveExplore = Math.max(0, size - clampedExploit - clampedCrowned);
    // Any crowned winner ⇒ winner-aware target of 2.
    const target = crowned > 0 ? EXPLORE_TARGET_WITH_WINNER : 4;
    const deficit = Math.max(0, target - liveExplore);

    const name = (title.get(String(c.product_id)) ?? String(c.product_id).slice(0, 8)).slice(0, 28);
    console.log(
      `${name.padEnd(30)} ${String(size).padStart(4)}  ${String(clampedExploit).padStart(7)}  ${String(clampedCrowned).padStart(7)}  ${String(liveExplore).padStart(11)}  ${String(deficit).padStart(7)}  ${deficit > 0 ? `✅ ${deficit} slot(s) OPEN` : "sealed"}`,
    );
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
