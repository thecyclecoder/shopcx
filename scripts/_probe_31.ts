import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { listReadyToTest } from "../src/lib/ads/ready-to-test";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS="221d272d-a6c5-4a5d-86ff-ac693926c992";
const TABS_ACCT_UUID="2a97bb87-9806-472f-a4a7-f6f6125dd9bf";
async function main(){
  const admin=createAdminClient();
  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id",WS);
  const pName=new Map((prods||[]).map((p:any)=>[p.id,p.title]));

  // 1) ready-to-test bin (workspace-wide), grouped by product
  const { readyToTest } = await listReadyToTest(admin, { workspaceId: WS });
  console.log(`=== ready-to-test bin: ${readyToTest.length} rows ===`);
  const byProd=new Map<string,number>();
  for(const r of readyToTest as any[]){ const pid=r.product_id??"(none)"; byProd.set(pid,(byProd.get(pid)||0)+1); }
  for(const [pid,n] of byProd) console.log(`   ${pName.get(pid)??pid}: ${n}`);
  console.log(`   → Tabs bin depth: ${byProd.get(TABS)||0}`);

  // 2) Tabs product ad_campaigns by status (Dahlia's output)
  const { data: acs } = await admin.from("ad_campaigns").select("status").eq("workspace_id",WS).eq("product_id",TABS);
  const st=new Map<string,number>(); for(const a of (acs||[]) as any[]) st.set(a.status,(st.get(a.status)||0)+1);
  console.log(`\n=== Tabs ad_campaigns by status ===`); for(const[s,n]of st) console.log(`   ${s}: ${n}`);

  // 3) recent media-buyer director_activity (workspace) — any Tabs replenish/pass?
  const { data: da } = await admin.from("director_activity").select("action_kind, reason, metadata, created_at").eq("workspace_id",WS).ilike("action_kind","media_buyer%").order("created_at",{ascending:false}).limit(12);
  console.log(`\n=== recent media_buyer director_activity (${(da||[]).length}) ===`);
  for(const d of (da||[]) as any[]){
    const acct=d.metadata?.meta_ad_account_id||d.metadata?.metaAdAccountId||"";
    console.log(`   ${d.created_at?.slice(5,16)} ${d.action_kind}  acct=${acct?String(acct).slice(0,8):"-"}`);
    if(d.reason) console.log(`       ${String(d.reason).slice(0,140)}`);
  }

  // 4) currentTestCohortSize as the runner computes it (workspace-wide active media-buyer-test jobs)
  const { data: live } = await admin.from("ad_publish_jobs").select("id, meta_adset_id").eq("workspace_id",WS).eq("origin","media-buyer-test").eq("publish_active",true).eq("publish_status","published");
  console.log(`\n=== workspace-wide active media-buyer-test published jobs: ${(live||[]).length} (this is currentTestCohortSize; target default=3) ===`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
