import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { deleteCompetitor } from "../src/lib/competitors";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
// pure generic/category search terms (NOT brands) — founder: ad-library searches must be brands
const GENERIC=["recovery","relax","no stress","alcohol alternative"];
(async()=>{
  const a=createAdminClient();
  const { data:comps }=await a.from("competitors").select("id,brand,search_keyword,product_id").eq("workspace_id",WS);
  const toDel=(comps||[]).filter((c:any)=>GENERIC.includes(String(c.brand).toLowerCase().trim()) || GENERIC.includes(String(c.search_keyword||"").toLowerCase().trim()));
  console.log("deleting generic (non-brand) competitors:", toDel.map((c:any)=>`${c.brand}(kw="${c.search_keyword}")`).join(", ")||"none matched");
  for(const c of toDel) await deleteCompetitor((c as any).id, {workspaceId:WS});
  const { data:rem }=await a.from("competitors").select("id").eq("workspace_id",WS);
  console.log("deleted:", toDel.length, "| competitors remaining:", (rem||[]).length);
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
