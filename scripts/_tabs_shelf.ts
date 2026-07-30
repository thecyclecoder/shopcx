import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main() {
  const admin = createAdminClient();
  const { data: prods } = await admin.from("products").select("id,title,handle")
    .eq("workspace_id",WS).ilike("title","%tab%");
  const tabs = (prods??[]).find((p:any)=>/superfood tab/i.test(p.title)) ?? (prods??[])[0];
  console.log("tabs product:", JSON.stringify(tabs));
  if(!tabs) return;
  const { data, error } = await admin.from("creative_skeletons")
    .select("status,hook,days_running,advertiser").eq("workspace_id",WS).eq("product_id",tabs.id);
  if(error){console.error(error.message);return;}
  const rows = data??[];
  const byStatus:Record<string,number>={};
  for(const r of rows as any[]) byStatus[r.status]=(byStatus[r.status]??0)+1;
  const analyzed=(rows as any[]).filter(r=>r.status==="analyzed");
  const qual=analyzed.filter(r=>r.hook && r.days_running!=null && r.days_running>=30);
  console.log(`tabs skeletons: ${rows.length} | byStatus ${JSON.stringify(byStatus)} | analyzed ${analyzed.length} | qualifying ${qual.length}`);
  for(const q of qual.slice(0,6)) console.log(`  [${q.advertiser}] dr=${q.days_running} :: ${String(q.hook).slice(0,60)}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
