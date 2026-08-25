/** The remaining K-Cups blockers: the deferred campaign, angle source, and competitor scoping. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
import { listCompetitors } from "../src/lib/competitors";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KCUPS = "f081a8ee-530b-4789-8654-bd57c3a51569";
const DEFERRED = "07de29d6-9790-4efd-ae2c-3c9a1ddfd449"; // the campaign Bianca kept deferring

async function main() {
  const admin = createAdminClient();
  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id", WS);
  const title = new Map((prods ?? []).map((p) => [String(p.id), String(p.title)]));

  // Which product is the campaign Bianca keeps deferring on?
  const { data: d } = await admin.from("ad_campaigns")
    .select("id,product_id,name,status,angle_id,audience_temperature,concept_tag,landing_url")
    .eq("id", DEFERRED).maybeSingle();
  console.log("=== the campaign Bianca keeps DEFERRING ===");
  if (d) {
    console.log(`  ${d.name}`);
    console.log(`  product ${title.get(String(d.product_id))} · status ${d.status} · angle_id ${d.angle_id ?? "NULL ← the defer reason"} · temp ${d.audience_temperature ?? "untagged"}`);
  }

  // Every K-Cups creative, in full.
  const { data: kc } = await admin.from("ad_campaigns").select("*").eq("workspace_id", WS).eq("product_id", KCUPS);
  console.log(`\n=== every K-Cups creative (${(kc ?? []).length}) ===`);
  for (const c of kc ?? []) {
    console.log(`  ${String(c.id).slice(0, 8)} "${String(c.name).slice(0, 40)}" status=${c.status} temp=${c.audience_temperature ?? "untagged"} angle=${c.angle_id ?? "NULL"} concept=${c.concept_tag ?? "—"} lander=${c.landing_url ? "yes" : "NO"} max_qc=${c.max_qc_eligible}`);
    const { data: v } = await admin.from("ad_videos").select("id,status,media_kind").eq("campaign_id", c.id);
    console.log(`      assets: ${(v ?? []).map((x) => `${x.media_kind}/${x.status}`).join(", ") || "NONE"}`);
  }

  // Where do angles live, and does any product have them?
  for (const tbl of ["product_ad_angles", "ad_angles"]) {
    const { data, error, count } = await admin.from(tbl).select("*", { count: "exact" }).eq("workspace_id", WS).limit(4);
    if (error) { console.log(`\n${tbl}: ${error.message}`); continue; }
    console.log(`\n=== ${tbl} — ${count} row(s) workspace-wide ===`);
    const byProd: Record<string, number> = {};
    const { data: all } = await admin.from(tbl).select("product_id").eq("workspace_id", WS);
    for (const r of all ?? []) byProd[String(title.get(String(r.product_id)) ?? r.product_id)] = (byProd[String(title.get(String(r.product_id)) ?? r.product_id)] ?? 0) + 1;
    for (const [p, n] of Object.entries(byProd).sort((a, b) => b[1] - a[1])) console.log(`   ${String(p).padEnd(28)} ${n}`);
    for (const r of data ?? []) console.log(`   sample: ${JSON.stringify(r).slice(0, 200)}`);
  }

  // Competitors — how are they scoped? Route through the SDK chokepoint
  // (`src/lib/competitors.ts` -> listCompetitors). A hand-rolled query would
  // silently read as empty if a column name drifts (an 82-row workspace once
  // read as 0 because a raw probe selected a non-existent column).
  const compAll = await listCompetitors({ workspaceId: WS, limit: 10000 });
  const compSample = compAll.slice(0, 3);
  console.log(`\n=== competitors ===`);
  console.log(`  columns: ${Object.keys(compSample[0] ?? {}).join(", ")}`);
  console.log(`  total ${compAll.length}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
