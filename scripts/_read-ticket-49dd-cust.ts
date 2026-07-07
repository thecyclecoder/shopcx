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
  const { data: tok, error } = await db.from("ai_token_usage").select("*").eq("customer_id", CUST);
  if (error) { console.log("no customer_id col:", error.message); }
  console.log("rows by customer_id:", (tok||[]).length);
  let c=0, tin=0, tout=0; const byModel:Record<string,number>={};
  for (const r of tok||[]) {
    const i=(r as any).input_tokens??0, o=(r as any).output_tokens??0, m=(r as any).model||"";
    c+=price(m,i,o); tin+=i; tout+=o;
    const k=m.includes("opus")?"opus":m.includes("sonnet")?"sonnet":"haiku"; byModel[k]=(byModel[k]||0)+price(m,i,o);
  }
  console.log("input:",tin,"output:",tout,"cost $"+c.toFixed(2), JSON.stringify(Object.fromEntries(Object.entries(byModel).map(([k,v])=>[k,"$"+v.toFixed(2)]))));

  // distinct tickets this customer has
  const { data: tks } = await db.from("tickets").select("id,subject,status,created_at,ai_cost,cost_usd,total_cost").eq("customer_id",CUST).order("created_at",{ascending:true});
  console.log("\n=== this customer's tickets:", (tks||[]).length, "===");
  for (const t of tks||[]) console.log(`  ${(t as any).id.slice(0,8)} [${(t as any).status}] ${(t as any).created_at?.slice(0,16)}  ${(t as any).subject?.slice(0,50)}  cost=${(t as any).ai_cost??(t as any).cost_usd??(t as any).total_cost??"-"}`);
  process.exit(0);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
