import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { searchAds, isWinner } from "../src/lib/adlibrary";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  // Obvi competitor row: when approved? swept?
  const { data:comp }=await a.from("competitors").select("id,brand,search_keyword,status,product_id,created_at,updated_at").eq("workspace_id",WS).ilike("brand","obvi").maybeSingle();
  console.log("Obvi competitor:", JSON.stringify(comp));
  // do any of the found ads pass isWinner (the sweep's filter)?
  const ads=await searchAds({ keyword:"Obvi collagen", daysBack:30, pageSize:30 } as any);
  const winners=ads.filter((x:any)=>isWinner(x));
  console.log(`\nsearchAds returned ${ads.length} ads; ${winners.length} pass isWinner (the sweep saves only winners)`);
  console.log("sample days_count of top 5:", ads.slice(0,5).map((x:any)=>x.days_count ?? x.days_running ?? "?").join(","));
})().then(()=>process.exit(0));
