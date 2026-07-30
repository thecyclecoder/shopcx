import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const now=Date.now(); const ago=(t?:string)=>t?`${((now-new Date(t).getTime())/3.6e6).toFixed(1)}h`:"—";
async function main(){
  const admin=createAdminClient();
  // 1) critical-path spec job history
  for (const slug of ["dahlia-conversion-psychology-rubric-module","bianca-cold-test-recent-purchaser-exclusion"]){
    const { data } = await admin.from("agent_jobs").select("id,kind,status,updated_at,created_at,error").eq("workspace_id",WS).eq("spec_slug",slug).order("updated_at",{ascending:false}).limit(8);
    console.log(`\n=== jobs for ${slug} ===`);
    for(const j of data||[]) console.log(`  [${j.status}] ${j.kind} upd=${ago(j.updated_at)} cre=${ago(j.created_at)} err=${String(j.error??"").slice(0,80)}`);
  }
  // 2) pr-1893 storm anatomy
  const { data: pr } = await admin.from("agent_jobs").select("id,kind,status,pr_number,updated_at,created_at,error").eq("workspace_id",WS).eq("kind","pr-resolve").order("updated_at",{ascending:false}).limit(10);
  console.log(`\n=== pr-resolve jobs (sample) ===`);
  for(const j of pr||[]) console.log(`  [${j.status}] pr#${j.pr_number} upd=${ago(j.updated_at)} cre=${ago(j.created_at)} err=${String(j.error??"").slice(0,90)}`);
  // distinct pr numbers among needs_attention pr-resolve
  const { data: prNA } = await admin.from("agent_jobs").select("pr_number,created_at").eq("workspace_id",WS).eq("kind","pr-resolve").eq("status","needs_attention");
  const byPr:Record<string,number>={}; let oldest="",newest="";
  for(const j of prNA||[]){ byPr[String(j.pr_number)]=(byPr[String(j.pr_number)]||0)+1; if(!oldest||j.created_at<oldest)oldest=j.created_at; if(!newest||j.created_at>newest)newest=j.created_at; }
  console.log(`\n=== needs_attention pr-resolve by PR (${(prNA||[]).length} total, oldest ${ago(oldest)}, newest ${ago(newest)}) ===`);
  for(const[p,n]of Object.entries(byPr)) console.log(`  pr#${p}: ${n}`);
  // 3) is there a goal build serializer holding things? check in-progress builds per goal
  const { data: building } = await admin.from("agent_jobs").select("kind,status,spec_slug,updated_at").eq("workspace_id",WS).in("status",["building","claimed"]);
  console.log(`\n=== currently building/claimed ===`); for(const j of building||[]) console.log(`  [${j.status}] ${j.kind} ${j.spec_slug??""} ${ago(j.updated_at)}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
