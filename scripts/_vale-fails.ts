import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUGS=["sonnet-prompts-sdk-for-review-agent-db-access","prompt-auto-review-becomes-box-agent-under-june","ticket-analyzer-becomes-box-agent-under-june"];
(async () => {
  const db = createAdminClient();
  const { data: acts } = await db.from("director_activity").select("*").in("action_kind",["spec_review_needs_fix","spec_review_fail","spec_review"]).order("created_at",{ascending:false}).limit(60);
  for(const slug of SLUGS){
    const a=(acts||[]).find((x:any)=> JSON.stringify(x).includes(slug));
    console.log(`\n=== ${slug} ===`);
    if(a){ console.log("  kind:", (a as any).action_kind, "| reason:", ((a as any).reason||(a as any).detail||(a as any).summary||"").slice(0,400)); }
    else console.log("  (no director_activity found — check spec vale fields)");
  }
  // also the spec's vale fields
  for(const slug of SLUGS){
    const {data:s}=await db.from("specs").select("vale_pass,vale_notes,vale_reason,status,parent_ref,parent_kind").eq("workspace_id",WS).eq("slug",slug).maybeSingle();
    if(s) console.log(`  ${slug.slice(0,40)}: vale_pass=${(s as any).vale_pass} parent_ref=${(s as any).parent_ref} notes=${((s as any).vale_notes||(s as any).vale_reason||"").slice(0,200)}`);
  }
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
