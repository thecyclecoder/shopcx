import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const MEMBERS=["dahlia-copy-author-box-session","dahlia-max-independent-copy-qc-box-session","dahlia-five-frameworks-copy-skill","dahlia-market-sophistication-escalation","dahlia-never-fabricate-copy-firewall","dahlia-preserve-competitor-copy-dna-debranded","dahlia-shared-deterministic-copy-validator","max-copy-qc-scroll-stop-dims","dahlia-andromeda-concept-diversity-tags","dahlia-cold-graded-inline-link-ctr-leading-signal","dahlia-deeper-competitor-selection","dahlia-publisher-asset-feed-spec-upgrade-and-competitor-selection","dahlia-temperature-banded-multi-variant-copy-pack"];
(async()=>{
  const admin=createAdminClient();
  // recent jobs (any status) for members
  const { data:jobs }=await admin.from("agent_jobs")
    .select("id,kind,spec_slug,status,claimed_at,updated_at,attempts,error")
    .eq("workspace_id",WS).in("spec_slug",MEMBERS)
    .order("updated_at",{ascending:false}).limit(60);
  console.log("=== recent member jobs ===");
  for(const j of jobs||[]) console.log(`  ${(j.status||"").padEnd(14)} ${(j.kind||"").padEnd(11)} ${j.spec_slug} | upd ${j.updated_at} att ${j.attempts} ${j.error?("ERR:"+String(j.error).slice(0,50)):""}`);
  console.log("\n=== member spec statuses + blockers + position ===");
  for(const slug of MEMBERS){
    const s:any=await getSpec(WS, slug).catch(()=>null);
    if(!s){ console.log(`  ${slug}: (getSpec null)`); continue; }
    console.log(`  pos ${String(s.position??"?").padStart(3)} ${String(s.status||"?").padEnd(11)} auto=${s.auto_build} blk=${JSON.stringify(s.blocked_by||[])} ${slug}`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
