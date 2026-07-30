import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  // 1) is the box ads-supervisor agent shipped?
  const s:any=await getSpec(WS,"growth-ads-supervisor-3h-agent").catch(()=>null);
  console.log(`growth-ads-supervisor-3h-agent: ${s?`status=${s.status??"(derived)"} phases=${(s.phases||[]).map((p:any)=>p.status).join(",")}`:"NOT FOUND"}`);
  // 2) recent kind='ads-supervisor' box jobs (who runs it)
  const {data:jobs}=await admin.from("agent_jobs").select("id,kind,status,created_at,claimed_by,created_by").eq("workspace_id",WS).eq("kind","ads-supervisor").order("created_at",{ascending:false}).limit(8);
  console.log(`\nkind='ads-supervisor' box jobs: ${jobs?.length||0}`);
  for(const j of (jobs||[]) as any[]) console.log(`  ${j.created_at?.slice(5,16)} ${j.status} claimed_by=${j.claimed_by||"—"} created_by=${j.created_by||"—"}`);
  // 3) who authored the ads-supervisor-fix specs (intended_status_set_by / created_by)
  const {data:fixspecs}=await admin.from("specs").select("slug,intended_status_set_by,created_at").eq("workspace_id",WS).ilike("slug","ads-supervisor-fix-%").order("created_at",{ascending:false}).limit(5);
  console.log(`\nads-supervisor-fix specs (author attribution):`);
  for(const f of (fixspecs||[]) as any[]) console.log(`  ${f.created_at?.slice(5,16)} by=${f.intended_status_set_by||"?"} ${f.slug.slice(0,50)}`);
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
