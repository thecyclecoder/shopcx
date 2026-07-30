import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { upsertCompetitor } from "../src/lib/competitors";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  const { data:r }=await a.from("competitors").select("*").eq("workspace_id",WS).ilike("brand","ag1").maybeSingle();
  if(!r){ console.log("no AG1 row"); return; }
  const c:any=r;
  const updated=await upsertCompetitor({
    workspace_id:WS, product_id:c.product_id, brand:c.brand, domain:c.domain, pdp_urls:c.pdp_urls,
    category:c.category, spend_signal:c.spend_signal, source:c.source, status:c.status, evidence:c.evidence,
    runs_ads_for:c.runs_ads_for,
    search_keyword:"AG1 by Athletic Greens", // was "AG1" → resolved to America's Got Talent
  } as any);
  console.log("AG1 seed updated → search_keyword:", (updated as any).search_keyword, "| brand:", (updated as any).brand, "| status:", (updated as any).status);
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
