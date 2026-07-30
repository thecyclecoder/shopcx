import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { deleteCompetitor } from "../src/lib/competitors";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const term=process.argv[2];
(async()=>{
  const a=createAdminClient();
  const { data:r }=await a.from("competitors").select("id,brand,search_keyword").eq("workspace_id",WS).or(`brand.ilike.%${term}%,search_keyword.ilike.%${term}%`).maybeSingle();
  if(!r){ console.log(`no competitor matching "${term}"`); return; }
  await deleteCompetitor((r as any).id,{workspaceId:WS});
  console.log(`dropped: ${(r as any).brand} (kw="${(r as any).search_keyword}")`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
