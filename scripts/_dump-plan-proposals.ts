import { createAdminClient } from "./_bootstrap";
async function main(){const a=createAdminClient();
  const {data:job}=await a.from("agent_jobs").select("pending_actions")
    .eq("id","1e199bbb-151c-4122-811e-b72409b4c3c2").maybeSingle();
  const pa=(job?.pending_actions as any[])||[];
  console.log(`13 proposals — keys of [0]:`, Object.keys(pa[0]||{}),"\n");
  let i=0;
  for(const act of pa){ i++;
    const s=act.spec||act;
    console.log(`\n[${i}] ${s.milestone||'?'} · ${s.slug||act.summary}  (owner=${s.owner||'?'})`);
    console.log(`    title: ${s.title||act.summary||''}`);
    console.log(`    parent: ${s.parent||''}`);
    if(s.blocked_by&&s.blocked_by.length) console.log(`    blocked_by: ${JSON.stringify(s.blocked_by)}`);
    console.log(`    intent: ${(s.intent||'').replace(/\s+/g,' ').slice(0,500)}`);
    if(s.gap) console.log(`    gap: ${(s.gap||'').replace(/\s+/g,' ').slice(0,220)}`);
  }
}
main().catch(e=>{console.error(e.message);process.exit(1);});
