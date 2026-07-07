import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const CUST = "7f215e32-a825-4a55-b558-9630dd2357c9";
const price = (m:string,i:number,o:number)=>{
  const P:Record<string,[number,number]> = {opus:[15,75],sonnet:[3,15],haiku:[1,5]};
  const k = m.includes("opus")?"opus":m.includes("sonnet")?"sonnet":"haiku";
  return (i*P[k][0]+o*P[k][1])/1e6;
};
(async () => {
  const db = createAdminClient();
  const { data: tks } = await db.from("tickets").select("id,subject,status,created_at").eq("customer_id",CUST).order("created_at",{ascending:true});
  console.log("=== customer tickets:", (tks||[]).length, "===");
  let grand=0, grandRows=0;
  for (const t of tks||[]) {
    const id=(t as any).id;
    const { data: tok } = await db.from("ai_token_usage").select("model,input_tokens,output_tokens").eq("ticket_id",id);
    let c=0; for (const r of tok||[]) c+=price(((r as any).model||""),(r as any).input_tokens??0,(r as any).output_tokens??0);
    grand+=c; grandRows+=(tok||[]).length;
    const flag = (tok||[]).length? `  rows=${(tok||[]).length} $${c.toFixed(2)}`:"";
    console.log(`  ${id.slice(0,8)} [${(t as any).status}] ${(t as any).created_at?.slice(5,16)}  ${((t as any).subject||"").slice(0,44)}${flag}`);
  }
  console.log(`\nSAGA TOTAL: ${grandRows} token rows across ${(tks||[]).length} tickets = $${grand.toFixed(2)} (token cost only; excludes any multi-agent investigation logging)`);
  process.exit(0);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
