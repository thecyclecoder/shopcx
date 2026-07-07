import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUGS=["refund-idempotency-guard-in-commerce-refund-facade","add-payment-method-journey","assisted-purchase-playbook","human-directives-hard-gates-over-ticket-ai","ticket-merge-summary-and-context-cap","replacement-address-uses-current-canonical-not-stale-order"];
(async () => {
  const db = createAdminClient();
  // recent agent_jobs
  const { data: jobs, error } = await db.from("agent_jobs")
    .select("id, kind, status, spec_slug, slug, payload, created_at, updated_at, pr_number, pr_url")
    .order("created_at",{ascending:false}).limit(200);
  if (error) { console.log("agent_jobs err:", error.message); }
  const relevant = (jobs||[]).filter((j:any)=>{
    const s = j.spec_slug || j.slug || (j.payload && (j.payload.slug || j.payload.spec_slug));
    return s && SLUGS.includes(s);
  });
  console.log("=== build/agent jobs touching our specs ===");
  for (const j of relevant) {
    const s = (j as any).spec_slug || (j as any).slug || ((j as any).payload && ((j as any).payload.slug||(j as any).payload.spec_slug));
    console.log(`  [${(j as any).status}] kind=${(j as any).kind} slug=${s} pr=${(j as any).pr_number??(j as any).pr_url??"-"} created=${(j as any).created_at?.slice(5,16)} updated=${(j as any).updated_at?.slice(5,16)} job=${(j as any).id?.slice(0,8)}`);
  }
  if (!relevant.length) console.log("  (none — no build jobs reference these slugs)");
  // vale_pass + auto_build per spec
  console.log("\n=== spec review/build flags ===");
  for (const slug of SLUGS) {
    const { data: s } = await db.from("specs").select("vale_pass, auto_build, deferred, status, review_passed_at").eq("workspace_id",WS).eq("slug",slug).maybeSingle();
    console.log(`  ${slug.slice(0,42).padEnd(42)} vale_pass=${(s as any)?.vale_pass} auto_build=${(s as any)?.auto_build} deferred=${(s as any)?.deferred}`);
  }
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
