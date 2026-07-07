import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: jobs } = await db.from("agent_jobs").select("*").order("created_at",{ascending:false}).limit(150);
  const bf=(jobs||[]).filter((j:any)=>{const s=j.spec_slug||(j.payload&&(j.payload.slug||j.payload.spec_slug));return s==="backfill-order-refunds-ledger-from-history";});
  for(const j of bf.slice(0,4)){
    console.log(`\n[${(j as any).status}] ${(j as any).kind} id=${(j as any).id} upd=${(j as any).updated_at?.slice(11,19)}`);
    const p=(j as any).payload||{};
    const qs=p.questions||[];
    for(const q of qs) console.log("  Q:", JSON.stringify(q).slice(0,500));
    for(const k of ["question","input_needed","needs_input_reason","blocker","note"]) if(p[k]) console.log("  "+k+":", JSON.stringify(p[k]).slice(0,400));
  }
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
