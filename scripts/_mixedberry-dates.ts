import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
// specific date patterns for the restock window
const DATE=/(7\s*\/\s*8\b|july\s*8th?\b|jul\s*8\b|7\s*\/\s*29|july\s*29|august\s*\d|7\s*\/\s*\d{1,2}|july\s*\d{1,2})/ig;
(async () => {
  const db = createAdminClient();
  const { data } = await db.from("sonnet_prompts").select("id,title,content,rule,body,is_active").limit(3000);
  console.log("=== sonnet_prompts mentioning a restock DATE ===");
  for(const r of data||[]){
    const blob = ["title","content","rule","body"].map(c=>typeof (r as any)[c]==="string"?(r as any)[c]:"").join(" \n ");
    if(!/mixed berry|restock|out of stock|back in stock/i.test(blob)) continue;
    const dates=[...blob.matchAll(DATE)].map(m=>m[0]);
    if(!dates.length) continue;
    // pull the sentence(s) with a date
    const sents = blob.split(/(?<=[.!\n])/).filter(s=>DATE.test(s));
    console.log(`\n★ ${(r as any).id.slice(0,12)} active=${(r as any).is_active} | title: ${((r as any).title||"").slice(0,60)}`);
    console.log(`   dates: ${JSON.stringify(dates)}`);
    for(const s of sents.slice(0,3)) console.log(`   » ${s.replace(/\s+/g," ").trim().slice(0,200)}`);
  }
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
