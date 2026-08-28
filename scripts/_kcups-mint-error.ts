/** The exact Meta error on the failed K-Cups mints. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const a = createAdminClient();
  const { data, error } = await a.from("ad_publish_jobs")
    .select("id,campaign_id,publish_status,meta_adset_id,created_at,error,create_adset_spec")
    .eq("workspace_id", WS).eq("publish_status", "failed")
    .order("created_at", { ascending: false }).limit(10);
  if (error) throw new Error(`ad_publish_jobs: ${error.message}`);

  console.log(`failed publish jobs: ${(data ?? []).length}\n`);
  const seen = new Set<string>();
  for (const j of data ?? []) {
    const spec = (j.create_adset_spec ?? {}) as Record<string, unknown>;
    const tg = (spec.targeting ?? {}) as Record<string, unknown>;
    console.log(`${String(j.created_at).slice(0, 16)}  campaign=${String(j.campaign_id).slice(0, 8)}  age ${tg.age_min ?? "?"}-${tg.age_max ?? "?"}`);
    const err = String(j.error ?? "");
    if (!seen.has(err)) { console.log(`   ERROR: ${err.slice(0, 700)}\n`); seen.add(err); }
  }

  // Which product do the failures belong to?
  const ids = [...new Set((data ?? []).map((j) => String(j.campaign_id)))];
  const { data: camps } = await a.from("ad_campaigns").select("id,name,product_id").in("id", ids);
  const { data: prods } = await a.from("products").select("id,title").eq("workspace_id", WS);
  const title = new Map((prods ?? []).map((p) => [String(p.id), String(p.title)]));
  console.log("failing campaigns → product:");
  for (const c of camps ?? []) console.log(`  ${String(c.id).slice(0, 8)} ${String(c.name).slice(0, 40).padEnd(40)} ${title.get(String(c.product_id))}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
