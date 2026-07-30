import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { execSync } from "child_process";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", PRODUCT="ea433e56-0aa4-4b46-9107-feb11f77f533";
const GREP="requires-variations"; // require-variations merge commit on main
const TERMINAL=["completed","failed","cancelled","needs_input","needs_attention"];
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function boxHasFix(boxSha:string):boolean{ try{
  execSync(`git fetch origin main -q`,{cwd:process.cwd()});
  const merge=execSync(`git log origin/main --grep="${GREP}" --oneline -1`,{cwd:process.cwd()}).toString().trim().split(" ")[0];
  if(!merge) return false; // spec not merged yet
  execSync(`git merge-base --is-ancestor ${merge} ${boxSha}`,{cwd:process.cwd(),stdio:"ignore"});
  return true;
}catch{ return false; } }
async function main(){ const a=createAdminClient();
  let testJob:string|null=null, phase="waiting for require-variations fix to merge + land on box";
  for(let i=0;i<55;i++){ // ~80 min
    if(!testJob){
      const {data:hb}=await a.from("worker_heartbeats").select("running_sha").order("updated_at",{ascending:false}).limit(1);
      const sha=((hb as any)?.[0]?.running_sha??"").replace(/[^0-9a-f]/gi,"").slice(0,40);
      if(sha && boxHasFix(sha)){
        const {data:open}=await a.from("agent_jobs").select("id").eq("workspace_id",WS).eq("kind","ad-creative-copy-author").in("status",["queued","queued_resume","claimed","building"]);
        if((open??[]).length){ phase=`fix live but an author job is already in-flight (${(open as any[]).map(j=>j.id.slice(0,8))}) — waiting`; }
        else { const {data:job}=await a.from("agent_jobs").insert({workspace_id:WS,kind:"ad-creative-copy-author",status:"queued",spec_slug:`ad-creative-copy-author:${PRODUCT}`,instructions:JSON.stringify({product_id:PRODUCT,count:1})}).select("id").single();
          testJob=(job as any).id; console.log(`[${new Date().toISOString().slice(11,19)}] require-variations fix live on box (${sha.slice(0,9)}) — ENQUEUED re-run ${testJob}`); }
      }
    } else {
      const {data}=await a.from("agent_jobs").select("status").eq("id",testJob).maybeSingle();
      if(TERMINAL.includes((data as any)?.status)){ phase=`test ${(data as any)?.status}`; break; }
    }
    await sleep(90000);
  }
  console.log(`\n════════ RESULT — ${phase} ════════`);
  if(!testJob){ console.log("Fix never landed on the box within the window — re-check the require-variations spec build."); return; }
  const {data:job}=await a.from("agent_jobs").select("status,log_tail").eq("id",testJob).maybeSingle();
  console.log(`test job ${testJob.slice(0,8)} status=${(job as any)?.status}`);
  console.log("log:", (job as any)?.log_tail || "(none)");
  const since=new Date(Date.now()-40*60*1000).toISOString();
  const {data:camps}=await a.from("ad_campaigns").select("id,status,angle_id,audience_temperature,concept_tag,author_self_score,created_at").eq("workspace_id",WS).eq("product_id",PRODUCT).gte("created_at",since).order("created_at",{ascending:false}).limit(1);
  for(const c of (camps??[]) as any[]){
    console.log(`\ncampaign ${c.id.slice(0,8)} status=${c.status} temp=${c.audience_temperature} concept=${c.concept_tag} dahlia_self=${c.author_self_score?.total??"-"}`);
    if(c.angle_id){ const {data:ang}=await a.from("product_ad_angles").select("metadata").eq("id",c.angle_id).maybeSingle(); const cp=(ang as any)?.metadata?.copy_pack;
      const hs=cp?.headlines??[]; const distinct=new Set(hs).size;
      console.log(`  VARIATIONS: ${hs.length} headlines, ${distinct} DISTINCT ${distinct>=5?"✓ (native distinct variations!)":"✗ (still collapsing to identical)"}`);
      hs.forEach((h:string,idx:number)=>console.log(`   [${cp.frameworks?.[idx]??"?"}] ${h}`)); }
    const {data:v}=await a.from("ad_creative_copy_qc_verdicts").select("hard_gate_pass,persuasion_score,verdict_reason").eq("ad_campaign_id",c.id).order("created_at",{ascending:false}).limit(1);
    for(const mv of (v??[]) as any[]) console.log(`  MAX: hard_gate_pass=${mv.hard_gate_pass} persuasion=${mv.persuasion_score}/10`);
  }
  console.log("\n════════ END ════════");
}
main().catch(e=>{console.error("monitor threw:",e instanceof Error?e.message:String(e));process.exit(1);});
