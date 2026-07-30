import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const COFFEE = "ea433e56-0aa4-4b46-9107-feb11f77f533";
async function main() {
  const admin = createAdminClient();
  const { data, error } = await admin.from("creative_skeletons")
    .select("status,hook,days_running,advertiser")
    .eq("workspace_id",WS).eq("product_id",COFFEE);
  if (error) { console.error("QUERY ERROR:", error.message); return; }
  const rows = data ?? [];
  console.log(`total coffee skeletons: ${rows.length}`);
  const byStatus: Record<string,number> = {};
  for (const r of rows as any[]) byStatus[r.status] = (byStatus[r.status]??0)+1;
  console.log("by status:", JSON.stringify(byStatus));
  const analyzed = (rows as any[]).filter(r=>r.status==="analyzed");
  const withHook = analyzed.filter(r=>r.hook);
  const drGe30 = withHook.filter(r=>r.days_running!=null && r.days_running>=30);
  console.log(`analyzed=${analyzed.length}  analyzed+hook=${withHook.length}  +dr>=30=${drGe30.length}`);
  const drVals = (rows as any[]).map(r=>r.days_running);
  console.log("days_running sample:", JSON.stringify(drVals.slice(0,15)));
  console.log("hooks sample:", JSON.stringify((rows as any[]).slice(0,4).map(r=>({st:r.status,adv:r.advertiser,dr:r.days_running,hook:r.hook?String(r.hook).slice(0,50):null}))));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
