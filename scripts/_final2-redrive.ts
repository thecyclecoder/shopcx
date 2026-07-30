import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { enqueueRepairJob } from "../src/lib/repair-agent";
import { execSync } from "node:child_process";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const FIX="48a03c88"; // #1298 ledger fix
const SIGS=[
  {signature:"auth-listusers-hot-path-scan-fix",title:"Re-drive #3: auth.users full-table scan → 500s/timeouts (db_health cache-pressure suspect)"},
  {signature:"box-worker-self-update-anchor-boot-sha",title:"Re-drive #3: box self-update freshness must anchor to boot-time RUNNING_SHA"},
  {signature:"error-feed-scope-supabase-auth-dial-io-timeout-transient",title:"Re-drive #3: scope 'dial tcp i/o timeout' into transient class"},
  {signature:"error-feed-drop-supabase-gotrue-504-edge-noise",title:"Re-drive #3: drop GoTrue 504 /auth/v1/user edge noise"},
];
const LIVE=["queued","claimed","building","needs_input","needs_approval","queued_resume","needs_attention"];
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const db=createAdminClient();
  // 1) wait for box on #1298
  let enqueued=false;
  for(let i=0;i<40 && !enqueued;i++){
    const { data: hb } = await db.from("worker_heartbeats").select("running_sha").eq("id","box").maybeSingle();
    const sha=(hb as any)?.running_sha;
    let live=false; try{ execSync("git fetch origin main -q",{stdio:"ignore"}); execSync(`git merge-base --is-ancestor ${FIX} ${sha}`,{stdio:"ignore"}); live=true; }catch{}
    console.log(`[wait t+${i}] box=${sha} fix#1298-live=${live}`);
    if(live){
      for(const s of SIGS){
        const { data: parked } = await db.from("agent_jobs").select("id,status").eq("kind","repair").eq("spec_slug",s.signature).in("status",LIVE);
        for(const p of (parked||[]) as any[]) await db.from("agent_jobs").update({status:"completed",error:null,log_tail:"Re-drive #3 (post-#1298 ledger fix live) — superseded by fresh diagnosis."}).eq("id",p.id).eq("status",p.status);
        const r=await enqueueRepairJob(db,{source:"manual-redrive-3",signature:s.signature,title:s.title,errorEventId:null});
        console.log(`  · ${s.signature} — resolved ${(parked||[]).length} → ${r.enqueued?"FRESH ENQUEUED":"skip("+r.reason+")"}`);
      }
      enqueued=true; break;
    }
    await sleep(90_000);
  }
  if(!enqueued){ console.log("box never reached #1298 in ~60min — check manually."); process.exit(2); }
  // 2) watch outcomes
  console.log("\n[watch] waiting for the 4 to author a spec or park with a REAL (non-parent, non-ghost) cause…");
  for(let i=0;i<30;i++){
    await sleep(90_000);
    const { data: specs } = await db.from("specs").select("slug,related_spec,created_at").eq("workspace_id",WS).gte("created_at",new Date(Date.now()-40*60*1000).toISOString());
    const { data: jobs } = await db.from("agent_jobs").select("spec_slug,status,error,created_at,log_tail").eq("kind","repair").in("spec_slug",SIGS.map(s=>s.signature)).eq("source" in {} ? "" : "kind","repair").order("created_at",{ascending:false});
    const latest=new Map<string,any>();
    for(const j of (jobs||[]) as any[]) if(!latest.has(j.spec_slug)) latest.set(j.spec_slug,j);
    let done=true; const lines:string[]=[];
    for(const s of SIGS){ const j=latest.get(s.signature); const term=["completed","needs_attention","failed"].includes(j?.status);
      lines.push(`${s.signature.split("-")[0]}:${j?.status}${/already-fixed/.test(j?.log_tail||"")?"(STILL already-fixed!)":""}`);
      if(!term) done=false;
    }
    console.log(`[watch t+${i}] ${lines.join(" ")} | new specs(20m): ${(specs||[]).length}`);
    if(done){
      console.log("\n=== FINAL ===");
      for(const s of SIGS){ const j=latest.get(s.signature);
        const authored=(specs||[]).some((sp:any)=>sp.slug===s.signature||sp.related_spec===s.signature);
        console.log(`  ${s.signature}: ${j?.status}${/already-fixed/.test(j?.log_tail||"")?" [FALSE already-fixed — NOT fixed]":authored?" [SPEC AUTHORED ✓]":" ["+(j?.log_tail||"").slice(0,70)+"]"}`);
      }
      break;
    }
  }
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
