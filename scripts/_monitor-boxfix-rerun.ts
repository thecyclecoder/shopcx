import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { execSync } from "child_process";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", PRODUCT="ea433e56-0aa4-4b46-9107-feb11f77f533";
const FIX_SHA="735123d8"; // always-bin + scroll_stop merge; box must include this
const TERMINAL=["completed","failed","cancelled","needs_input","needs_attention"];
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function boxHasFix(boxSha:string):boolean{ try{ execSync(`git fetch origin main -q`,{cwd:process.cwd()}); execSync(`git merge-base --is-ancestor ${FIX_SHA} ${boxSha}`,{cwd:process.cwd(),stdio:"ignore"}); return true; }catch{ return false; } }
async function main(){ const a=createAdminClient();
  let testJob:string|null=null, phase="waiting for box to include the always-bin fix";
  for(let i=0;i<40;i++){ // ~60 min
    if(!testJob){
      const {data:hb}=await a.from("worker_heartbeats").select("running_sha").order("updated_at",{ascending:false}).limit(1);
      const sha=(hb as any)?.[0]?.running_sha ?? "";
      const has=boxHasFix(sha.replace(/[^0-9a-f]/gi,"").slice(0,40));
      phase=`box sha=${sha} hasFix=${has}`;
      if(has){
        const {data:job}=await a.from("agent_jobs").insert({workspace_id:WS,kind:"ad-creative-copy-author",status:"queued",spec_slug:`ad-creative-copy-author:${PRODUCT}`,instructions:JSON.stringify({product_id:PRODUCT,count:1})}).select("id").single();
        testJob=(job as any).id; console.log(`[${new Date().toISOString().slice(11,19)}] box has fix (${sha}) — ENQUEUED re-run ${testJob}`);
      }
    } else {
      const {data}=await a.from("agent_jobs").select("status").eq("id",testJob).maybeSingle();
      if(TERMINAL.includes((data as any)?.status)){ phase=`test ${(data as any)?.status}`; break; }
    }
    await sleep(90000);
  }
  console.log(`\n════════ RESULT — ${phase} ════════`);
  if(!testJob){ console.log("Box never picked up the fix within the window — it may need a nudge/restart. Not run."); return; }
  const {data:job}=await a.from("agent_jobs").select("status,log_tail,error").eq("id",testJob).maybeSingle();
  console.log(`test job ${testJob.slice(0,8)} status=${(job as any)?.status}`);
  console.log("log:", (job as any)?.log_tail || (job as any)?.error || "(none)");
  const since=new Date(Date.now()-40*60*1000).toISOString();
  const {data:camps}=await a.from("ad_campaigns").select("id,status,angle_id,audience_temperature,concept_tag,author_self_score,created_at").eq("workspace_id",WS).eq("product_id",PRODUCT).gte("created_at",since).order("created_at",{ascending:false}).limit(2);
  for(const c of (camps??[]) as any[]){
    console.log(`\ncampaign ${c.id.slice(0,8)} status=${c.status} temp=${c.audience_temperature} concept=${c.concept_tag} dahlia_self=${c.author_self_score?.total??"-"}`);
    if(c.angle_id){ const {data:ang}=await a.from("product_ad_angles").select("meta_headline,metadata").eq("id",c.angle_id).maybeSingle(); const cp=(ang as any)?.metadata?.copy_pack;
      console.log(`  HEADLINE: ${(ang as any)?.meta_headline}`); if(cp?.headlines) cp.headlines.forEach((h:string,i:number)=>console.log(`   [${cp.frameworks?.[i]??"?"}] ${h}`)); }
    const {data:v}=await a.from("ad_creative_copy_qc_verdicts").select("hard_gate_pass,persuasion_score,verdict_reason").eq("ad_campaign_id",c.id).order("created_at",{ascending:false}).limit(3);
    console.log(`  MAX verdicts: ${(v??[]).length}`);
    for(const mv of (v??[]) as any[]) console.log(`    hard_gate_pass=${mv.hard_gate_pass} persuasion=${mv.persuasion_score}/10 reason=${String(mv.verdict_reason??"").slice(0,150)}`);
  }
  console.log("\n════════ END ════════");
}
main().catch(e=>{console.error("monitor threw:",e instanceof Error?e.message:String(e));process.exit(1);});
