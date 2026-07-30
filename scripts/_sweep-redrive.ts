import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { enqueueRepairJob } from "../src/lib/repair-agent";
import { execSync } from "node:child_process";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const FIX="3b614c31"; // #1304 parent-parse fix
// auth-listusers omitted — its spec was authored directly and is already in the build pipeline.
const SIGS=[
  {signature:"box-worker-self-update-anchor-boot-sha",title:"Re-drive: box self-update freshness → boot-time RUNNING_SHA"},
  {signature:"error-feed-scope-supabase-auth-dial-io-timeout-transient",title:"Re-drive: scope 'dial tcp i/o timeout' into transient class"},
  {signature:"error-feed-drop-supabase-gotrue-504-edge-noise",title:"Re-drive: drop GoTrue 504 /auth/v1/user edge noise"},
  {signature:"loop:ai:ticket-analyzer",title:"Re-drive: ticket-analyzer false analyzer_locked — mirror cron source filter in the probe"},
  {signature:"vercel:db57eb2d13e0a610",title:"Re-drive: Appstle call-log fetch has no timeout → 30s customer hang; add AbortSignal.timeout"},
];
const LIVE=["queued","claimed","building","needs_input","needs_approval","queued_resume","needs_attention"];
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const db=createAdminClient();
  let armed=false;
  for(let i=0;i<40 && !armed;i++){
    const { data: hb } = await db.from("worker_heartbeats").select("running_sha").eq("id","box").maybeSingle();
    const sha=(hb as any)?.running_sha;
    let live=false; try{ execSync("git fetch origin main -q",{stdio:"ignore"}); execSync(`git merge-base --is-ancestor ${FIX} ${sha}`,{stdio:"ignore"}); live=true; }catch{}
    console.log(`[wait t+${i}] box=${sha} fix#1304-live=${live}`);
    if(live){
      for(const s of SIGS){
        const { data: parked } = await db.from("agent_jobs").select("id,status").eq("kind","repair").eq("spec_slug",s.signature).in("status",LIVE);
        for(const p of (parked||[]) as any[]) await db.from("agent_jobs").update({status:"completed",error:null,log_tail:"Re-drive post-#1304 (parent-parse fix live) — superseded by fresh diagnosis."}).eq("id",p.id).eq("status",p.status);
        const r=await enqueueRepairJob(db,{source:"manual-redrive-4",signature:s.signature,title:s.title,errorEventId:null});
        console.log(`  · ${s.signature} — resolved ${(parked||[]).length} → ${r.enqueued?"FRESH ENQUEUED":"skip("+r.reason+")"}`);
      }
      armed=true;
    } else await sleep(90_000);
  }
  if(!armed){ console.log("box never reached #1304 in ~60min."); process.exit(2); }
  console.log("\n[watch] outcomes (spec authored = fix live; needs_attention w/ real cause = surfaced; InvalidParent = STILL broken)…");
  for(let i=0;i<30;i++){
    await sleep(90_000);
    const { data: specs } = await db.from("specs").select("slug").eq("workspace_id",WS).in("slug",["tickets-awaiting-qc-workprobe-exclude-analyzer-locked","appstle-call-log-fetch-timeout-guard","worker-self-update-anchor-freshness-to-boot-sha"]);
    const { data: jobs } = await db.from("agent_jobs").select("spec_slug,status,error").eq("kind","repair").in("spec_slug",SIGS.map(s=>s.signature)).order("created_at",{ascending:false});
    const latest=new Map<string,any>(); for(const j of (jobs||[]) as any[]) if(!latest.has(j.spec_slug)) latest.set(j.spec_slug,j);
    let done=true; let invalidParent=0;
    const line=SIGS.map(s=>{const j=latest.get(s.signature); if(!["completed","needs_attention","failed"].includes(j?.status))done=false; if(/InvalidParent/i.test(j?.error||""))invalidParent++; return `${s.signature.split(":").pop()!.split("-")[0]}:${j?.status}`;}).join(" ");
    console.log(`[watch t+${i}] ${line} | authored specs: ${(specs||[]).length} | InvalidParent: ${invalidParent}`);
    if(done){
      console.log("\n=== FINAL ===");
      for(const s of SIGS){ const j=latest.get(s.signature); const ip=/InvalidParent/i.test(j?.error||"");
        console.log(`  ${s.signature}: ${j?.status}${ip?" [❌ STILL InvalidParent]":j?.error?" ["+String(j.error).slice(0,60)+"]":" [✓ no parent error]"}`); }
      console.log(invalidParent?`\n❌ ${invalidParent} still InvalidParent — #1304 not effective.`:`\n✓ ZERO InvalidParentError across all — the parent chain is fully fixed.`);
      break;
    }
  }
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
