import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", GURU="f55a1cb1-f3ca-4e0d-9c64-ecd1cd865efb";
const TERMINAL=["completed","failed","cancelled","needs_input","needs_attention"];
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const ts=()=>new Date().toISOString().slice(11,19);
async function main(){const a=createAdminClient();
  const enqAt=new Date(Date.now()-3*60*1000).toISOString();
  let status="queued";
  for(let i=0;i<50;i++){ await sleep(60000);
    const {data:j}=await a.from("agent_jobs").select("status,log_tail").ilike("id","659cf7df%").maybeSingle() as any;
    status=j?.status||status;
    if(TERMINAL.includes(status)){ console.log(`[${ts()}] Guru Focus job ${status}`); console.log("log:", (j?.log_tail||"").slice(0,200)); break; }
    if(i%3===0) console.log(`[${ts()}] Guru Focus building…`);
  }
  const {data:c}=await a.from("ad_campaigns").select("id,name,concept_tag,audience_temperature,angle_id,created_at").eq("workspace_id",WS).eq("product_id",GURU).gte("created_at",enqAt).order("created_at",{ascending:false}).limit(1) as any;
  const camp=(c||[])[0];
  if(!camp){ console.log("\n════════ NO campaign produced (held/failed) ════════"); return; }
  console.log(`\n════════ GURU FOCUS AD PRODUCED ════════`);
  console.log(`name: ${camp.name}`);
  console.log(`temp: ${camp.audience_temperature||"NULL ⚠️"}  concept: ${camp.concept_tag||"null"}`);
  const {data:ang}=await a.from("product_ad_angles").select("hook_slug,lead_benefit_anchor,meta_headline,metadata").eq("id",camp.angle_id).maybeSingle() as any;
  console.log(`angle: hook_slug=${ang?.hook_slug} lead_benefit="${ang?.lead_benefit_anchor}"`);
  const dna=ang?.metadata?.competitor_dna||ang?.metadata?.competitorDna;
  const offerish=/offer|% ?off|discount|bundle|bonus|sale|deal|holiday|free/i.test(`${ang?.lead_benefit_anchor} ${ang?.meta_headline} ${JSON.stringify(dna||{})}`);
  console.log(`OFFER/RETARGETING angle? ${offerish?"⚠️ YES (fix may not have applied)":"✓ NO — cold benefit angle"}`);
  console.log(`competitor imitated: ${dna?.competitorAdvertiser||dna?.competitor_advertiser||"(own-brand angle)"}`);
  const cp=ang?.metadata?.copy_pack;
  console.log(`variations: ${cp?.headlines?.length||0} (frameworks: ${(cp?.frameworks||[]).join(",")})`);
  console.log("════════ END ════════");
}
main().then(()=>process.exit(0)).catch(e=>{console.error("threw:",e instanceof Error?e.message:String(e));process.exit(1);});
