/** Confirm the new ad is live on Meta itself, not just in our record. READ-ONLY. */
import "./_bootstrap";
import { getMetaUserToken, listAdSets } from "../src/lib/meta-ads";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ADSET = "120251358715490326";
const AD = "120251358717870326";
const TABS_CAMPAIGN = "120250066504550326";

async function main() {
  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no Meta token");

  const j = await fetch(
    `https://graph.facebook.com/v21.0/${AD}?fields=id,name,status,effective_status,adset_id,creative{id}&access_token=${encodeURIComponent(token)}`,
  ).then((r) => r.json());
  console.log("=== THE AD, from Meta ===");
  console.log(JSON.stringify(j, null, 2));

  const a = await fetch(
    `https://graph.facebook.com/v21.0/${ADSET}?fields=id,name,status,effective_status,daily_budget,campaign_id&access_token=${encodeURIComponent(token)}`,
  ).then((r) => r.json());
  console.log("\n=== ITS ADSET, from Meta ===");
  console.log(JSON.stringify(a, null, 2));

  console.log("\n=== THE TABS TEST CAMPAIGN — all live adsets ===");
  const sets = await listAdSets(token, "196487894712827", TABS_CAMPAIGN);
  let total = 0;
  for (const s of sets.filter((x) => x.effective_status === "ACTIVE")) {
    const b = s.daily_budget ? Number(s.daily_budget) : 0;
    total += b;
    console.log(`  ● ${String(s.name).slice(0, 46).padEnd(46)} $${(b / 100).toFixed(0).padStart(5)}/day  ${s.id === ADSET ? "◄ NEW" : ""}`);
  }
  console.log(`  ${sets.filter((x) => x.effective_status === "ACTIVE").length} live · $${(total / 100).toFixed(0)}/day committed (ceiling $800)`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
