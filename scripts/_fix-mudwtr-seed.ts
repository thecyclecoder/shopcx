import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { upsertCompetitor } from "../src/lib/competitors";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  const { data:r }=await a.from("competitors").select("*").eq("workspace_id",WS).ilike("brand","mudwtr").maybeSingle();
  if(!r){ console.log("no mudwtr row (brand may differ) — searching…"); const {data}=await a.from("competitors").select("id,brand,search_keyword").eq("workspace_id",WS).or("brand.ilike.%mud%,search_keyword.ilike.%mud%"); console.log(JSON.stringify(data)); return; }
  const c:any=r;
  await upsertCompetitor({ workspace_id:WS, product_id:c.product_id, brand:c.brand, domain:c.domain, pdp_urls:c.pdp_urls, category:c.category, spend_signal:c.spend_signal, source:c.source, status:c.status, evidence:c.evidence, runs_ads_for:c.runs_ads_for, search_keyword:"MUD\\WTR" } as any);
  console.log(`updated ${c.brand}: search_keyword "${c.search_keyword}" → "MUD\\WTR" (real page id 172538983355501, 124K likes)`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
