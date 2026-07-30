import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const now = Date.now();
const ago = (t?:string)=> t ? `${((now-new Date(t).getTime())/3.6e6).toFixed(1)}h` : "—";
async function main(){
  const admin = createAdminClient();

  // 1) agent_jobs status distribution + freshest updated per status
  const { data: jobs } = await admin.from("agent_jobs")
    .select("id,kind,status,spec_slug,updated_at,created_at").eq("workspace_id", WS)
    .order("updated_at",{ascending:false}).limit(400);
  const byStatus: Record<string,{n:number,newest?:string,oldest?:string}> = {};
  for (const j of jobs||[]){
    const s=String(j.status); byStatus[s]=byStatus[s]||{n:0};
    byStatus[s].n++;
    if(!byStatus[s].newest||j.updated_at>byStatus[s].newest!) byStatus[s].newest=j.updated_at;
    if(!byStatus[s].oldest||j.updated_at<byStatus[s].oldest!) byStatus[s].oldest=j.updated_at;
  }
  console.log("=== agent_jobs by status (last 400) ===");
  for (const [s,v] of Object.entries(byStatus)) console.log(`  ${s.padEnd(16)} n=${String(v.n).padStart(3)}  newest=${ago(v.newest)}  oldest=${ago(v.oldest)}`);

  // 2) building / claimed jobs — are they stuck?
  console.log("\n=== in-flight (building/claimed/queued_resume) ===");
  for (const j of (jobs||[]).filter((j:any)=>["building","claimed","queued_resume"].includes(String(j.status)))) 
    console.log(`  [${j.status}] ${j.kind} ${j.spec_slug??""} updated ${ago(j.updated_at)}`);

  // 3) queued jobs not being claimed?
  const queued = (jobs||[]).filter((j:any)=>String(j.status)==="queued");
  console.log(`\n=== queued (waiting to claim): ${queued.length} ===`);
  for (const j of queued.slice(0,12)) console.log(`  ${j.kind} ${j.spec_slug??""} queued ${ago(j.created_at)} updated ${ago(j.updated_at)}`);

  // 4) needs_approval — blockers
  const na = (jobs||[]).filter((j:any)=>String(j.status)==="needs_approval");
  console.log(`\n=== needs_approval (blocking): ${na.length} ===`);
  for (const j of na) console.log(`  ${j.kind} ${j.spec_slug??""} since ${ago(j.updated_at)}`);

  // 5) box worker heartbeat / liveness
  const { data: hb } = await admin.from("loop_heartbeats").select("loop_id,beat_at,ok").order("beat_at",{ascending:false}).limit(15);
  console.log(`\n=== recent loop_heartbeats ===`);
  for (const h of hb||[]) console.log(`  ${String(h.loop_id).padEnd(38)} ${ago(h.beat_at)} ok=${h.ok}`);

  // 6) kill switches (global / build)
  const { data: ks } = await admin.from("kill_switches").select("node_id,scope,is_on,off_by,updated_at").order("updated_at",{ascending:false}).limit(20);
  console.log(`\n=== kill_switches (recent) ===`);
  for (const k of ks||[]) console.log(`  ${String(k.node_id).padEnd(28)} scope=${k.scope} is_on=${k.is_on} off_by=${k.off_by??""} ${ago(k.updated_at)}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
