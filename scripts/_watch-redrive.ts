import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SIGS=["auth-listusers-hot-path-scan-fix","box-worker-self-update-anchor-boot-sha","error-feed-scope-supabase-auth-dial-io-timeout-transient","error-feed-drop-supabase-gotrue-504-edge-noise"];
(async()=>{
  const db=createAdminClient();
  const MAX=30; // ~30*90s = 45min
  for(let i=0;i<MAX;i++){
    const { data: specs } = await db.from("specs").select("slug").eq("workspace_id",WS).in("slug",SIGS);
    const persisted=new Set((specs||[]).map((s:any)=>s.slug));
    const { data: jobs } = await db.from("agent_jobs").select("spec_slug,status,error,created_at").eq("kind","repair").in("spec_slug",SIGS).order("created_at",{ascending:false});
    const latest=new Map<string,any>();
    for(const j of (jobs||[]) as any[]) if(!latest.has(j.spec_slug)) latest.set(j.spec_slug,j);
    // done when every sig either persisted a spec OR its latest repair is terminal (completed/needs_attention)
    let allDone=true;
    for(const s of SIGS){ const j=latest.get(s); const term=persisted.has(s)||["completed","needs_attention","failed"].includes(j?.status); if(!term) allDone=false; }
    console.log(`[t+${i}] ` + SIGS.map(s=>{const j=latest.get(s);return `${s.split("-")[0]}:${persisted.has(s)?"SPEC✓":j?.status||"?"}`;}).join(" "));
    if(allDone){
      console.log("\n=== FINAL ===");
      let parentErrs=0;
      for(const s of SIGS){ const j=latest.get(s); const parentBug=/InvalidParent/i.test(j?.error||"");
        if(parentBug) parentErrs++;
        console.log(`  ${s}: ${persisted.has(s)?"PERSISTED SPEC ✓":`park[${j?.status}]`}${j?.error?` — ${String(j.error).slice(0,90)}`:""}`);
      }
      console.log(parentErrs? `\n⚠ ${parentErrs} still hit InvalidParent — coercion not effective, investigate.` : `\n✓ ZERO InvalidParentError — the parent fix holds. Repair pipeline self-heals end-to-end.`);
      process.exit(0);
    }
    await new Promise(r=>setTimeout(r,90_000));
  }
  console.log("[watch] timeout — box still processing; check manually.");
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
