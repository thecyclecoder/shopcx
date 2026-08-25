/** Competitor scoping by product, and where ad angles come from. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const a = createAdminClient();
  const { data: p } = await a.from("products").select("id,title").eq("workspace_id", WS);
  const t = new Map((p ?? []).map((x) => [String(x.id), String(x.title)]));

  const { data: c } = await a.from("competitors").select("product_id,brand,status").eq("workspace_id", WS);
  const by: Record<string, number> = {};
  for (const r of c ?? []) {
    const k = r.product_id ? (t.get(String(r.product_id)) ?? String(r.product_id)) : "(unscoped / null)";
    by[k] = (by[k] ?? 0) + 1;
  }
  console.log("competitors by product:");
  for (const [k, v] of Object.entries(by).sort((x, y) => y[1] - x[1])) console.log(`  ${k.padEnd(30)} ${v}`);

  const cof = (c ?? []).filter((r) => t.get(String(r.product_id)) === "Amazing Coffee");
  console.log(`\nAmazing Coffee competitors (CEO: these also apply to K-Cups) — ${cof.length}:`);
  for (const r of cof.slice(0, 14)) console.log(`  ${String(r.brand).padEnd(32)} ${r.status}`);

  // Angle shape — what a K-Cups angle would need to look like.
  const { data: sample } = await a.from("product_ad_angles").select("*").eq("workspace_id", WS)
    .eq("product_id", "ea433e56-0aa4-4b46-9107-feb11f77f533").limit(2);
  console.log(`\nAmazing Coffee angle shape (${(sample ?? []).length} sampled):`);
  for (const s of sample ?? []) {
    for (const [k, v] of Object.entries(s)) {
      if (v === null || k === "workspace_id") continue;
      console.log(`   ${k.padEnd(26)} ${typeof v === "object" ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 120)}`);
    }
    console.log("   ---");
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
