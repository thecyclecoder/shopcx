import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{
  const admin=createAdminClient();
  // ALL active jobs across workspaces, grouped by kind+status
  const { data:jobs }=await admin.from("agent_jobs")
    .select("kind,status,spec_slug,created_at,workspace_id")
    .in("status",["queued","claimed","building","queued_resume","needs_input","needs_approval","needs_attention","blocked_on_usage"])
    .order("created_at",{ascending:true}).limit(500);
  const all=jobs||[];
  console.log("total ACTIVE jobs:", all.length);
  const byKind:Record<string,Record<string,number>>={};
  for(const j of all){ (byKind[j.kind]=byKind[j.kind]||{})[j.status]=(byKind[j.kind][j.status]||0)+1; }
  console.log("\n=== active jobs by kind → status ===");
  for(const [k,st] of Object.entries(byKind).sort((a,b)=>Object.values(b[1]).reduce((x,y)=>x+y,0)-Object.values(a[1]).reduce((x,y)=>x+y,0)))
    console.log(`  ${k.padEnd(22)} ${JSON.stringify(st)}`);
  // anything mario-ish
  const marioish=all.filter(j=>/mario|repair|stall|wedge/i.test(j.kind)||/mario|repair/i.test(j.spec_slug||""));
  console.log("\n=== mario/repair-ish active (first 25) ===", marioish.length);
  for(const j of marioish.slice(0,25)) console.log(`  ${j.kind} ${j.status} ${j.spec_slug||"-"} ${j.created_at}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
