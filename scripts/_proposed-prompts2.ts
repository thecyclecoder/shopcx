import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data } = await db.from("sonnet_prompts").select("*").limit(3000);
  console.log("sonnet_prompts columns:", data&&data[0]?Object.keys(data[0]).join(", "):"none");
  // find the status/review fields
  const statusField = data&&data[0]?Object.keys(data[0]).find(k=>/status|state|approv/i.test(k)):null;
  const reviewField = data&&data[0]?Object.keys(data[0]).find(k=>/review/i.test(k)):null;
  console.log("status-ish field:", statusField, "| review-ish field:", reviewField, "\n");
  const byStatus:Record<string,number>={}; let rev=0, unrev=0, oldest="";
  for(const r of data||[]){
    const st=statusField?(r as any)[statusField]:(r as any).is_active;
    byStatus[String(st)]=(byStatus[String(st)]||0)+1;
    if(reviewField&&(r as any)[reviewField]) rev++; else { unrev++; const c=(r as any).created_at; if(!oldest||c<oldest)oldest=c; }
  }
  console.log(`total ${(data||[]).length} | by ${statusField}:`, JSON.stringify(byStatus));
  console.log(`reviewed:${rev} unreviewed:${unrev} oldest-unreviewed:${oldest?.slice(0,16)}`);
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
