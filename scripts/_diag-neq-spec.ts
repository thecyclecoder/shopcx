import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { investigateSpec } from "../src/lib/spec-investigation";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="media-buyer-agent-test-mock-support-neq-filter";
(async()=>{
  const db=createAdminClient();
  const inv:any=await investigateSpec(WS,SLUG); const d=inv.diagnosis??inv;
  console.log(`derivedStatus=${d.derivedStatus}`);
  for(const p of (d.phases||[])) console.log(`  P${p.index} ${p.status} build=${p.build_sha?p.build_sha.slice(0,8):"-"} merge=${p.merge_sha?p.merge_sha.slice(0,8):"-"}`);
  console.log("\nJOBS:");
  for(const j of (d.jobs||[])) console.log(`  [${j.kind}] ${j.status} needsAttn=${j.needsAttentionClass} branch=${j.branch||"-"} pr=${j.prNumber||"-"}\n     err:${String(j.error||"").replace(/\n/g," ").slice(0,200)}\n     log:${String(j.logTail||"").replace(/\n/g," ").slice(0,220)}`);
  // Mario's escalation
  const {data:acts}=await db.from("director_activity").select("action_kind,reason,created_at,metadata")
    .eq("workspace_id",WS).ilike("reason",`%${SLUG}%`).order("created_at",{ascending:false}).limit(5);
  console.log("\nMARIO/DIRECTOR ACTIVITY:");
  for(const a of (acts||[]) as any[]) console.log(`  ${a.created_at?.slice(0,16)} ${a.action_kind}: ${String(a.reason||"").replace(/\n/g," ").slice(0,300)}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,400));process.exit(1);});
