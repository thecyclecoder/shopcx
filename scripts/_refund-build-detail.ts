import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: jobs } = await db.from("agent_jobs").select("*").order("created_at",{ascending:false}).limit(300);
  const refund = (jobs||[]).filter((j:any)=>{
    const s=j.spec_slug||(j.payload&&(j.payload.slug||j.payload.spec_slug)); return s==="refund-idempotency-guard-in-commerce-refund-facade";
  });
  for (const j of refund) {
    console.log(`[${(j as any).status}] kind=${(j as any).kind} created=${(j as any).created_at} upd=${(j as any).updated_at}`);
    const p=(j as any).payload||{};
    for (const k of ["pr_number","pr_url","branch","pr","result","error","note"]) if(p[k]||((j as any)[k])) console.log("   ", k, ":", JSON.stringify(p[k]??(j as any)[k]).slice(0,160));
    // any top-level pr fields
    for (const k of Object.keys(j as any)) if(/pr|branch|result/i.test(k) && (j as any)[k]) console.log("   ."+k+":", JSON.stringify((j as any)[k]).slice(0,160));
  }
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
