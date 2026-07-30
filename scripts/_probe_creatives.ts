import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getTestingResults } from "../src/lib/ads/testing-results-sdk";
async function main(){
  const admin=createAdminClient();
  const res = await getTestingResults(admin, "fdc11e10-b89f-4989-8b73-ed6526c4d906");
  let withImg=0, withCopy=0, total=0;
  for(const g of res.products) for(const r of g.rows){
    total++;
    if(r.creative?.heroImageUrl) withImg++;
    if(r.creative?.headline||r.creative?.primaryText) withCopy++;
  }
  console.log(`tests=${total}  withHeroImage=${withImg}  withCopy=${withCopy}`);
  // sample one system-published test's creative
  for(const g of res.products) for(const r of g.rows){
    if(r.creative?.headline){ console.log("\nsample:", g.productTitle, "/", r.adsetName.slice(0,30));
      console.log("  img:", r.creative.heroImageUrl?.slice(0,80));
      console.log("  headline:", r.creative.headline);
      console.log("  primary:", r.creative.primaryText?.slice(0,100));
      console.log("  desc:", r.creative.description); return; }
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
