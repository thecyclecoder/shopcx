import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { listSpecs } from "../src/lib/specs-table";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const now=Date.now(); const ago=(t?:string)=>t?`${((now-new Date(t).getTime())/3.6e6).toFixed(1)}h`:"—";
function roll(ph:any[]){ if(!ph?.length) return "no-phase"; const s=ph.map(p=>p.status);
  if(s.every(x=>x==="shipped"))return "SHIPPED"; if(s.some(x=>x==="in_progress"||x==="in progress"))return "in_progress";
  return s.join("/"); }
async function main(){
  const admin = createAdminClient();
  const all = await listSpecs(WS);
  const goalSpecs = all.filter((s:any)=> String(s.slug).startsWith("dahlia-")||String(s.slug).startsWith("bianca-")||["orders-classification-sdk","ada-reacts-to-approvals-immediately-never-sits","reap-needs-attention-jobs-for-archived-specs"].includes(s.slug));
  console.log("=== goal/session spec build state ===");
  for (const s of goalSpecs as any[]){
    console.log(`  ${roll(s.phases).padEnd(26)} pr=${s.merged_pr??"-"} blk=${JSON.stringify(s.blocked_by)} ${s.slug}`);
  }

  // 65 needs_attention breakdown
  const { data: na } = await admin.from("agent_jobs").select("kind,spec_slug,updated_at,error").eq("workspace_id",WS).eq("status","needs_attention").order("updated_at",{ascending:false});
  const byKind:Record<string,number>={}; for(const j of na||[]) byKind[j.kind]=(byKind[j.kind]||0)+1;
  console.log(`\n=== needs_attention (${na?.length}) by kind ===`); for(const[k,n]of Object.entries(byKind))console.log(`  ${k}: ${n}`);
  console.log("  sample (newest 12):");
  for(const j of (na||[]).slice(0,12)) console.log(`    [${j.kind}] ${j.spec_slug??""} ${ago(j.updated_at)}  err=${String(j.error??"").slice(0,70)}`);

  // queued bianca build — why not claimed
  const { data: q } = await admin.from("agent_jobs").select("id,kind,status,spec_slug,blocked_on,error,created_at,updated_at").eq("workspace_id",WS).eq("status","queued");
  console.log(`\n=== queued jobs (${q?.length}) ===`);
  for(const j of q||[]) console.log(`  ${j.kind} ${j.spec_slug} queued ${ago(j.created_at)}  err=${j.error??""}`);

  // kill switches — correct columns
  const { data: ks, error: kerr } = await admin.from("kill_switches").select("*").limit(10);
  console.log(`\n=== kill_switches (${ks?.length??0})${kerr?" ERR "+kerr.message:""} ===`);
  for(const k of ks||[]) console.log("  "+JSON.stringify(k));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
