import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const COFFEE = "ea433e56-0aa4-4b46-9107-feb11f77f533";
async function main() {
  const admin = createAdminClient();
  const { data, error } = await admin.from("product_ad_angles")
    .select("id,hook_slug,lead_benefit_anchor,hook_one_liner,meta_headline,meta_primary_text,created_at")
    .eq("workspace_id",WS).eq("product_id",COFFEE)
    .order("created_at",{ascending:false}).limit(6);
  if(error){console.error(error.message);return;}
  for (const a of (data??[]) as any[]) {
    console.log(`\n[${a.created_at}]`);
    console.log(`  hook_one_liner: ${a.hook_one_liner}`);
    console.log(`  lead_benefit:   ${a.lead_benefit_anchor}`);
    console.log(`  meta_headline:  ${a.meta_headline}`);
    console.log(`  meta_primary:   ${a.meta_primary_text}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
