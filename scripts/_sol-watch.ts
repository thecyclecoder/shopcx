import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const db=createAdminClient();
  // goal + members
  const {data:g}=await db.from("goals").select("id,status,main_merge_sha,promotion_held_reason").eq("workspace_id",WS).eq("slug","sol-ticket-direction-then-cheap-execution").single();
  console.log(`GOAL status=${(g as any).status} main_merge_sha=${(g as any).main_merge_sha||"-"} held=${(g as any).promotion_held_reason||"-"}`);
  const {data:sol}=await db.from("specs").select("slug,status").ilike("slug","sol-%").order("slug");
  // latest job per spec
  console.log("\n=== per-spec latest job ===");
  const actionable:any[]=[];
  for(const s of sol||[]){
    const slug=(s as any).slug;
    const {data:jobs}=await db.from("agent_jobs").select("id,kind,status,pending_actions,questions").eq("spec_slug",slug).order("created_at",{ascending:false}).limit(1);
    const j=(jobs||[])[0];
    console.log(`  ${slug.replace('sol-','').slice(0,42).padEnd(42)} spec=${(s as any).status||"pending"} | ${j?`${(j as any).kind}=${(j as any).status}`:'(no job)'}`);
    if(j && ["needs_approval","needs_input","failed"].includes((j as any).status)) actionable.push({slug, id:(j as any).id, kind:(j as any).kind, status:(j as any).status, pa:(j as any).pending_actions||[], q:(j as any).questions});
  }
  console.log("\n=== ACTIONABLE ===");
  for(const a of actionable){
    console.log(`\n▸ ${a.slug} [${a.status}] job=${a.id}`);
    for(const p of a.pa) if((p.status||"pending")==="pending") console.log(`   pending: ${p.id} ${p.type} | ${(p.cmd||"").slice(0,80)}`);
    if(a.q && (Array.isArray(a.q)?a.q.length:a.q)) console.log(`   question: ${JSON.stringify(a.q).slice(0,300)}`);
  }
  if(!actionable.length) console.log("  (nothing actionable — all building/queued/shipped)");
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
