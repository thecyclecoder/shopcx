import { loadEnv } from "./_bootstrap"; loadEnv();
import { upsertCompetitor, loadApprovedCompetitorsForProduct } from "@/lib/competitors";
import { inngest } from "@/lib/inngest/client";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", ZEN="48bfa48c-b8db-42f9-9303-19c70ab8e7a1";
async function m(){
  const row=await upsertCompetitor({
    workspace_id:WS, product_id:ZEN, brand:"Nectar Calm", domain:"drinknectar.co",
    search_keyword:"Nectar Calm", category:"calm / relaxation drink",
    source:"manual", status:"approved",
    evidence:"CEO-seeded direct competitor for Ashwavana Zen Relax; ingest via AdLibrary domain search (advertisers/winners API won't resolve it).",
    pdp_urls:["https://drinknectar.co"],
  });
  console.log(`✓ upserted competitor ${row.id.slice(0,8)} brand="${row.brand}" domain=${row.domain} product=ZEN status=${row.status}`);
  const seeds=await loadApprovedCompetitorsForProduct(WS,ZEN);
  console.log(`\nApproved Zen Relax competitors now (${seeds.length}):`);
  for(const s of seeds)console.log(`  ${s.keyword}  expectedDomain=${s.expectedDomain||"—"}`);
  await inngest.send({name:"ads/creative-scout.sweep", data:{workspaceId:WS, productId:ZEN, force:true}});
  console.log(`\n✓ fired ads/creative-scout.sweep for Zen Relax (force) — LANE B domain search will pull drinknectar.co`);
}
m().then(()=>process.exit(0)).catch(e=>{console.error("THREW:",e.message);process.exit(1);});
