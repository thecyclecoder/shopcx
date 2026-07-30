import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const db = createAdminClient();
  const { data: specs } = await db.from("specs").select("slug,status,blocked_by,vale_pass,milestone_id").ilike("slug","sol-%").order("slug");
  console.log("=== Sol goal specs — blocked_by + status ===");
  for(const s of specs||[]){
    console.log(`\n${(s as any).slug}`);
    console.log(`   status=${(s as any).status} vale=${(s as any).vale_pass}`);
    console.log(`   blocked_by=${JSON.stringify((s as any).blocked_by)}`);
  }
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
