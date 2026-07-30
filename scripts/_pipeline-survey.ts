import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const { data:jobs }=await admin.from("agent_jobs")
    .select("kind,status,spec_slug,updated_at,pending_actions")
    .in("status",["queued","claimed","building","needs_input","needs_approval","needs_attention","queued_resume","blocked_on_usage"])
    .order("updated_at",{ascending:false}).limit(300);
  const all=jobs||[];
  const byKS:Record<string,number>={};
  for(const j of all){ const k=`${j.kind}/${j.status}`; byKS[k]=(byKS[k]||0)+1; }
  console.log("=== ACTIVE jobs by kind/status ("+all.length+") ===");
  for(const [k,n] of Object.entries(byKS).sort((a,b)=>b[1]-a[1])) console.log(`  ${k.padEnd(32)} ${n}`);
  console.log("\n=== needs_approval / needs_attention / needs_input (blocking) ===");
  for(const j of all.filter(x=>["needs_approval","needs_attention","needs_input"].includes(x.status))){
    let pa=""; try{ const p=JSON.parse(JSON.stringify(j.pending_actions||[])); pa=Array.isArray(p)&&p.length?` | action:${JSON.stringify(p[0]).slice(0,90)}`:""; }catch{}
    console.log(`  ${j.status.padEnd(15)} ${j.kind.padEnd(14)} ${j.spec_slug||"-"}${pa}`);
  }
})().then(()=>process.exit(0));
