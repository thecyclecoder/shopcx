/** Exact skeleton counts (the earlier scan hit the 1000-row cap). READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KCUPS = "f081a8ee-530b-4789-8654-bd57c3a51569";
const COFFEE = "ea433e56-0aa4-4b46-9107-feb11f77f533";

async function main() {
  const a = createAdminClient();
  const { count: all } = await a.from("creative_skeletons").select("id", { count: "exact", head: true }).eq("workspace_id", WS);
  console.log(`total creative_skeletons in workspace: ${all}`);

  for (const [label, pid] of [["Amazing Coffee K-Cups", KCUPS], ["Amazing Coffee", COFFEE]] as const) {
    const { count } = await a.from("creative_skeletons").select("id", { count: "exact", head: true }).eq("workspace_id", WS).eq("product_id", pid);
    const { count: d60 } = await a.from("creative_skeletons").select("id", { count: "exact", head: true }).eq("workspace_id", WS).eq("product_id", pid).gte("days_running", 60);
    console.log(`  ${label.padEnd(24)} skeletons=${count}  >=60d=${d60}`);
  }

  const { data: nullProd, count: nullCount } = await a.from("creative_skeletons")
    .select("id,advertiser", { count: "exact" }).eq("workspace_id", WS).is("product_id", null).limit(3);
  console.log(`\nskeletons with NULL product_id: ${nullCount}`);
  for (const s of nullProd ?? []) console.log(`   ${s.advertiser}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
