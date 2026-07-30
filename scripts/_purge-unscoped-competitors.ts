import { loadEnv } from "./_bootstrap"; loadEnv();
import { deleteOrphanCompetitors } from "../src/lib/competitors";
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const r=await deleteOrphanCompetitors(WS);
  console.log("deleted orphan (unscoped) competitors:", r.deleted);
  // verify remaining are all product-scoped
  const a=createAdminClient();
  const { data:rem }=await a.from("competitors").select("id,product_id").eq("workspace_id",WS);
  const unscopedLeft=(rem||[]).filter((c:any)=>!c.product_id).length;
  console.log("remaining competitors:", (rem||[]).length, "| unscoped left:", unscopedLeft);
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
