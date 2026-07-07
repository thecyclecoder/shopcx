import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const LIT=/7\s*\/\s*8\b|july\s*8th?\b|jul\.?\s*8\b|8th of july/i;
async function litScan(db:any,t:string){
  const {data,error}=await db.from(t).select("*").limit(2000);
  if(error){console.log(`  ${t}: skip`);return;}
  let h=0;
  for(const r of data||[]){ const b=JSON.stringify(r); if(LIT.test(b)){h++; console.log(`  ★ ${t} ${String((r as any).id||(r as any).slug).slice(0,20)} contains a literal 7/8`);}}
  if(!h) console.log(`  ${t}: no literal 7/8 (${(data||[]).length} rows)`);
}
(async () => {
  const db = createAdminClient();
  console.log("=== literal '7/8' / 'July 8' across tables ===");
  for(const t of ["sonnet_prompts","policies","playbook_steps","journey_definitions","grader_prompts","crisis_events","crisis_campaigns","crisis_customer_actions","email_templates"]) await litScan(db,t);
  console.log("\n=== canonical restock date: crisis_events / campaigns ===");
  for(const t of ["crisis_events","crisis_campaigns"]){
    const {data,error}=await db.from(t).select("*").limit(20);
    if(error){console.log(`  ${t}: (${error.message.slice(0,40)})`);continue;}
    for(const r of data||[]){
      const dateCols=Object.keys(r).filter(k=>/restock|eta|back|resolve|expected|date|available/i.test(k));
      if(dateCols.length) console.log(`  ${t} ${String((r as any).id).slice(0,10)}:`, dateCols.map(c=>`${c}=${(r as any)[c]}`).join(", "));
    }
  }
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
