import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const INFLIGHT=[
 "sonnet-prompts-sdk-for-review-agent-db-access","ticket-analyzer-becomes-box-agent-under-june","prompt-auto-review-becomes-box-agent-under-june",
 "june-review-replaces-solver-skeptic-quorum-triage","playbook-compiler-becomes-box-agent-mining-full-history",
 "ci-guard-migrations-applied-not-just-merged","pia-decomposition-emits-plain-slug-blocked-by",
 "builder-persona-add-upserts-by-key-and-generates-avatar","god-mode-becomes-ceo-executive-assistant-agent",
];
(async()=>{
  const db=createAdminClient();
  console.log("=== NEW/IN-FLIGHT SPECS (non-Sol) ===");
  for(const slug of INFLIGHT){const s=await getSpec(WS,slug);if(!s){console.log(`  ? ${slug} MISSING`);continue;}
    const ph=(s.phases||[]).map((p:any)=>p.status[0]).join("");
    console.log(`  ${(s as any).status==="folded"?"✅":"⏳"} ${slug.slice(0,52).padEnd(52)} status=${(s as any).status||"in-flight"} [${ph}] vale=${(s as any).vale_pass}`);}
  // Sol goal
  const {data:g}=await db.from("goals").select("id,status").eq("workspace_id",WS).eq("slug","sol-ticket-direction-then-cheap-execution").single();
  const {data:sol}=await db.from("specs").select("slug,status,vale_pass,blocked_by").ilike("slug","sol-%").order("slug");
  console.log(`\n=== Sol goal (${(g as any).status}) — ${(sol||[]).length} specs ===`);
  for(const s of sol||[]) console.log(`  ${(s as any).status==="folded"?"✅":"⏳"} ${(s as any).slug.slice(0,50).padEnd(50)} status=${(s as any).status||"pending"} vale=${(s as any).vale_pass}`);
  // needs attention (mine-ish) + open PRs
  const {data:jobs}=await db.from("agent_jobs").select("status,kind,spec_slug").in("status",["needs_approval","needs_input"]).order("created_at",{ascending:false}).limit(20);
  console.log("\n=== jobs needing approval/input ===");
  const seen=new Set(); for(const j of jobs||[]){const k=`${(j as any).status}:${(j as any).spec_slug||(j as any).kind}`;if(seen.has(k))continue;seen.add(k);console.log(`  [${(j as any).status}] ${(j as any).kind} ${(j as any).spec_slug||""}`);}
  if(!(jobs||[]).length) console.log("  (none)");
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
