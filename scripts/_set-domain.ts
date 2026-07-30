import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { upsertCompetitor } from "../src/lib/competitors";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const [,, matchTerm, domain]=process.argv;
(async()=>{
  const a=createAdminClient();
  const { data:r }=await a.from("competitors").select("*").eq("workspace_id",WS).or(`brand.ilike.%${matchTerm}%,search_keyword.ilike.%${matchTerm}%`).maybeSingle();
  if(!r){ console.log(`no competitor matching "${matchTerm}"`); return; }
  const c:any=r;
  await upsertCompetitor({ workspace_id:WS, product_id:c.product_id, brand:c.brand, domain, pdp_urls:c.pdp_urls, category:c.category, spend_signal:c.spend_signal, source:c.source, status:c.status, evidence:c.evidence, runs_ads_for:c.runs_ads_for, search_keyword:c.search_keyword } as any);
  console.log(`${c.brand} (kw="${c.search_keyword}") → domain = ${domain} (collect via domain search)`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
