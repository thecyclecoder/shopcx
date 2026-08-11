import * as fs from "fs";
import { createClient } from "@supabase/supabase-js";
const envText = fs.readFileSync("/Users/admin/Projects/shoptics/.env.local", "utf8");
const env: Record<string,string> = {};
for (const l of envText.split("\n")){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)env[m[1]]=m[2].replace(/^["']|["']$/g,"");}
const shoptics = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
async function main(){
  const { data: closes } = await shoptics.from("month_end_closings").select("*").order("created_at",{ascending:false});
  console.log("=== month_end_closings columns ===");
  if(closes?.[0]) console.log(Object.keys(closes[0]).join(", "));
  console.log("\n=== close summaries ===");
  for(const c of closes ?? []){
    console.log(`\n--- ${(c as any).month ?? (c as any).period ?? (c as any).id} ---`);
    for(const [k,v] of Object.entries(c)){
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      console.log(`  ${k}: ${s.length>200?s.slice(0,200)+"…["+s.length+"]":s}`);
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
