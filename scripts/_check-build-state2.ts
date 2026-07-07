import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUGS=["refund-idempotency-guard-in-commerce-refund-facade","add-payment-method-journey","assisted-purchase-playbook","human-directives-hard-gates-over-ticket-ai","ticket-merge-summary-and-context-cap","replacement-address-uses-current-canonical-not-stale-order"];
(async () => {
  const db = createAdminClient();
  // discover agent_jobs columns
  const { data: sample } = await db.from("agent_jobs").select("*").limit(1);
  const cols = sample && sample[0] ? Object.keys(sample[0]) : [];
  console.log("agent_jobs columns:", cols.join(", "));
  const slugCol = cols.find(c=>/spec.*slug|^slug$/.test(c));
  console.log("slug-ish column:", slugCol, "\n");

  const { data: jobs } = await db.from("agent_jobs").select("*").order("created_at",{ascending:false}).limit(300);
  const rel = (jobs||[]).filter((j:any)=>{
    const s = j[slugCol||""] || (j.payload && (j.payload.slug||j.payload.spec_slug));
    return s && SLUGS.includes(s);
  });
  console.log("=== jobs touching our specs ===");
  for (const j of rel) {
    const s = (j as any)[slugCol||""] || ((j as any).payload && ((j as any).payload.slug||(j as any).payload.spec_slug));
    console.log(`  [${(j as any).status}] kind=${(j as any).kind} slug=${s} created=${(j as any).created_at?.slice(5,16)} upd=${(j as any).updated_at?.slice(5,16)}`);
  }
  if (!rel.length) console.log("  (none)");

  console.log("\n=== spec flags ===");
  for (const slug of SLUGS) {
    const { data: s } = await db.from("specs").select("vale_pass, auto_build, deferred, status").eq("workspace_id",WS).eq("slug",slug).maybeSingle();
    console.log(`  ${slug.slice(0,42).padEnd(42)} vale=${(s as any)?.vale_pass} auto_build=${(s as any)?.auto_build} deferred=${(s as any)?.deferred}`);
  }
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
