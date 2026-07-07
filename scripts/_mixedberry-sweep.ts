import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const RX=/7\s*\/\s*8|july\s*8\b|jul\s*8\b|august|mixed berry|restock|back in stock|out of stock|7\s*\/\s*29|july\s*29/i;
async function scan(db:any, table:string, cols:string[]){
  const { data, error } = await db.from(table).select("*").limit(2000);
  if(error){ console.log(`  ${table}: (skip: ${error.message.slice(0,40)})`); return; }
  let hits=0;
  for(const row of data||[]){
    const blob = cols.map(c=>{const v=(row as any)[c]; return typeof v==="string"?v:JSON.stringify(v||"");}).join(" ");
    if(RX.test(blob)){
      hits++;
      const id=(row as any).id||(row as any).slug||(row as any).name;
      const snippet=blob.match(RX)?.[0];
      console.log(`  ★ ${table} [${String(id).slice(0,28)}] matched "${snippet}"`);
    }
  }
  if(!hits) console.log(`  ${table}: no matches (${(data||[]).length} scanned)`);
}
(async () => {
  const db = createAdminClient();
  console.log("=== scanning AI-prompt surfaces for Mixed Berry / restock / 7-8 / 7-29 ===");
  await scan(db,"sonnet_prompts",["title","content","rule","prompt","body","internal_summary"]);
  await scan(db,"policies",["name","slug","internal_summary","content","body"]);
  await scan(db,"playbooks",["name","description"]);
  await scan(db,"playbook_steps",["name","config","instructions"]);
  await scan(db,"journey_definitions",["name","config","steps"]);
  await scan(db,"grader_prompts",["title","content","prompt"]);
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
