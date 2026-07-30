import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getMetaUserToken } from "../src/lib/meta-ads";
import { metaGraphRequest } from "../src/lib/meta/api";
import { getTestingResults, enrichWithMetaCreatives } from "../src/lib/ads/testing-results-sdk";
async function main(){
  const admin=createAdminClient();
  const res = await getTestingResults(admin, "fdc11e10-b89f-4989-8b73-ed6526c4d906");
  const token = await getMetaUserToken("fdc11e10-b89f-4989-8b73-ed6526c4d906");
  const allRows = res.products.flatMap(g=>g.rows);
  await enrichWithMetaCreatives(allRows, token!, metaGraphRequest, { onlyActive: true });
  let img=0, enr=0;
  for(const r of allRows){ if(r.creative?.thumbnailUrl) img++; if(r.creative?.metaEnriched) enr++; }
  console.log(`active rows enriched=${enr} withThumbnail=${img}`);
  const sample = allRows.find(r=>r.creative?.metaEnriched);
  if(sample){ console.log("\nsample:", sample.productTitle, "/", sample.adsetName.slice(0,30));
    console.log("  thumb:", sample.creative!.thumbnailUrl?.slice(0,60));
    console.log("  headline:", sample.creative!.headline);
    console.log("  primary:", sample.creative!.primaryText?.slice(0,90)); }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
