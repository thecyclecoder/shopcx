import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const ids=["60e105df","9e3936f9","34b2284a","1e691b5e","b69ed884","88149a37","6bf489b7"]; // Mixed Berry + August
  const { data } = await db.from("sonnet_prompts").select("*").limit(3000);
  for(const r of data||[]){
    const id=(r as any).id;
    if(!ids.some(p=>id.startsWith(p))) continue;
    const content=(r as any).content||(r as any).rule||(r as any).body||"";
    if(!/mixed berry|restock|stock|august|july/i.test(content)) continue;
    console.log(`\n=== ${id.slice(0,12)} | active=${(r as any).is_active} | ${((r as any).title||"").slice(0,70)} ===`);
    console.log(content.slice(0,700));
  }
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
