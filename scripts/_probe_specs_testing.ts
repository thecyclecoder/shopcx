import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
async function main(){
  const admin = createAdminClient();
  const { data } = await admin.from("specs")
    .select("slug, title, status, updated_at")
    .eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906")
    .or("slug.ilike.%test%,slug.ilike.%insight%,slug.ilike.%intraday%,slug.ilike.%scorecard%,slug.ilike.%refresh%,slug.ilike.%2h%,slug.ilike.%fresh%,title.ilike.%testing%,title.ilike.%intraday%")
    .order("updated_at",{ascending:false}).limit(25);
  for (const s of (data||[]) as any[]) console.log(`  [${s.status}] ${s.slug} — ${s.title} (${s.updated_at?.slice(0,10)})`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
