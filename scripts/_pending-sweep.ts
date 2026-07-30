import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SESSION_SPECS=["add-payment-method-journey","assisted-purchase-playbook","human-directives-hard-gates-over-ticket-ai","ticket-merge-summary-and-context-cap","replacement-address-uses-current-canonical-not-stale-order","refund-idempotency-guard-in-commerce-refund-facade","backfill-order-refunds-ledger-from-history","ci-guard-table-refs-have-migrations","clarification-turns-send-full-message-not-bare-question","ci-guard-migrations-applied-not-just-merged","builder-migration-apply-uses-working-pgclient-not-broken-db-push","prompt-auto-review-becomes-box-agent-under-june","ticket-analyzer-becomes-box-agent-under-june","sonnet-prompts-sdk-for-review-agent-db-access"];
(async () => {
  const db = createAdminClient();
  console.log("=== SESSION SPEC STATUS ===");
  const buckets:Record<string,string[]>={};
  for(const slug of SESSION_SPECS){
    const s=await getSpec(WS,slug); if(!s){continue;}
    const phases=(s.phases||[]); const st=(s as any).status||"in-flight";
    const key = st==="folded"?"✅ folded":st;
    (buckets[key]||=[]).push(`${slug.slice(0,44)} [${phases.map((p:any)=>p.status[0]).join("")}] vale=${(s as any).vale_pass}`);
  }
  for(const [k,v] of Object.entries(buckets)){ console.log(`\n${k} (${v.length}):`); for(const x of v) console.log("  "+x); }
  // open agent_jobs needing attention
  const { data: jobs } = await db.from("agent_jobs").select("status,kind,spec_slug").in("status",["needs_approval","needs_input","needs_attention"]).order("created_at",{ascending:false}).limit(30);
  console.log("\n=== JOBS NEEDING ATTENTION ===");
  const seen=new Set();
  for(const j of jobs||[]){ const k=`${(j as any).status}:${(j as any).spec_slug||(j as any).kind}`; if(seen.has(k))continue; seen.add(k); console.log(`  [${(j as any).status}] ${(j as any).kind} ${(j as any).spec_slug||""}`); }
  if(!(jobs||[]).length) console.log("  (none)");
  // Sol goal
  const { data: g } = await db.from("goals").select("status").eq("workspace_id",WS).eq("slug","sol-ticket-direction-then-cheap-execution").maybeSingle();
  console.log("\n=== Sol goal status:", (g as any)?.status, "===");
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
