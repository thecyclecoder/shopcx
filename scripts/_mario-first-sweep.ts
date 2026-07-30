import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "./../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUGS=["appstle-call-log-fetch-timeout-guard","error-feed-transient-auth-noise-never-escalate-chronic","db-investigate-timeouts-instance-rollback","box-self-update-freshness-anchors-to-boot-sha","tickets-awaiting-qc-workprobe-exclude-analyzer-locked"];
async function main(){const admin=createAdminClient();
 console.log("=== are these Mario-authored specs? ===");
 for(const slug of SLUGS){
   const { data:s }=await admin.from("specs").select("slug,priority,owner,created_at,intended_status").eq("workspace_id",WS).eq("slug",slug).maybeSingle();
   console.log(s ? `  SPEC ${s.slug}  priority=${(s as any).priority??"-"} owner=${(s as any).owner} created=${(s as any).created_at}` : `  (no spec row for ${slug})`);
 }
 console.log("\n=== Mario director_activity (last 8) ===");
 const { data:da }=await admin.from("director_activity").select("action_kind,spec_slug,reason,created_at").in("spec_slug",SLUGS).order("created_at",{ascending:false}).limit(8);
 for(const a of (da??[]) as any[]) console.log(`  [${a.action_kind}] ${a.spec_slug} :: ${String(a.reason??"").slice(0,140)}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
