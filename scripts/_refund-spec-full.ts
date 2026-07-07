import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: s } = await db.from("specs").select("*").eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").eq("slug","refund-idempotency-guard-in-commerce-refund-facade").maybeSingle();
  if (!s) { console.log("not found"); process.exit(0); }
  for (const k of ["slug","status","intended_status","intended_status_set_by","vale_pass","owner_function","parent_ref","parent_kind","updated_at"]) console.log(`  ${k}:`, (s as any)[k]);
  // phase rollup
  const { data: ph } = await db.from("spec_phases").select("title,status,shipped_pr,shipped_sha").eq("spec_id",(s as any).id).order("position",{ascending:true});
  for (const p of ph||[]) console.log(`  phase: ${(p as any).status.padEnd(8)} ${(p as any).title?.slice(0,45)}`);
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
