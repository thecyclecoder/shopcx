import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const admin = createAdminClient();
  // all needs_attention jobs
  const { data: na } = await admin.from("agent_jobs")
    .select("id,kind,status,spec_slug,updated_at").eq("workspace_id", WS).eq("status","needs_attention")
    .order("updated_at",{ascending:true});
  console.log(`needs_attention jobs total: ${na?.length??0}`);
  const slugs = [...new Set((na||[]).map((j:any)=>j.spec_slug).filter(Boolean))];
  // stored status of those specs
  const { data: specs } = await admin.from("specs").select("slug,status").eq("workspace_id", WS).in("slug", slugs.length?slugs:["_"]);
  const statusOf = new Map((specs||[]).map((s:any)=>[s.slug,s.status]));
  const TERMINAL = new Set(["folded","shipped","done","superseded"]);
  let zombie=0, live=0;
  const zombieSlugs:string[]=[];
  for (const j of na||[]){
    const st = statusOf.get(j.spec_slug);
    const isZombie = j.spec_slug && TERMINAL.has(String(st));
    if (isZombie){ zombie++; zombieSlugs.push(`${j.spec_slug}(${st})`); }
    else live++;
  }
  console.log(`  → superseded/zombie (spec already terminal): ${zombie}`);
  console.log(`  → genuinely open (spec not terminal / no slug): ${live}`);
  console.log(`\nzombie job specs:`);
  for (const z of [...new Set(zombieSlugs)]) console.log("   "+z);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
