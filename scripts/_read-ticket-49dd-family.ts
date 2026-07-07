import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const IDS = [
  "49ddd6c4-9894-4474-b925-fffe19a175c8", // this
  "e671e536-cde6-43cb-91bb-b4113e94492f", // "My order" (50 msgs)
  "4f513c1f-c16d-4a48-b43a-cf3569460b66", // "My replacement ordwr" (60 msgs)
  "a818cb97-de33-4c90-b222-7a802f8e345c", // "Re: A shipment..." (75 msgs)
];
// Opus4.7 $15/$75, Sonnet4.6 $3/$15, Haiku4.5 $1/$5 per M
const price = (m:string,i:number,o:number)=>{
  const P:Record<string,[number,number]> = {opus:[15,75],sonnet:[3,15],haiku:[1,5]};
  const k = m.includes("opus")?"opus":m.includes("sonnet")?"sonnet":"haiku";
  return (i*P[k][0]+o*P[k][1])/1e6;
};
(async () => {
  const db = createAdminClient();
  let grand = 0;
  for (const id of IDS) {
    const { data: tok } = await db.from("ai_token_usage").select("model,input_tokens,output_tokens,prompt_tokens,completion_tokens,purpose").eq("ticket_id", id);
    let c = 0, rows = (tok||[]).length;
    for (const r of tok||[]) {
      const i = (r as any).input_tokens ?? (r as any).prompt_tokens ?? 0;
      const o = (r as any).output_tokens ?? (r as any).completion_tokens ?? 0;
      c += price(((r as any).model||""), i, o);
    }
    grand += c;
    console.log(`${id.slice(0,8)}  rows=${rows}  $${c.toFixed(2)}`);
  }
  console.log("GRAND TOTAL across family: $" + grand.toFixed(2));

  // proposed todos from the investigation
  const { data: todos } = await db.from("ticket_todos").select("*").eq("ticket_id", IDS[0]).order("created_at",{ascending:true});
  console.log("\n=== TODOS (", (todos||[]).length, ") ===");
  for (const t of todos||[]) {
    console.log(`  [${(t as any).status}] ${(t as any).title ?? (t as any).action_type ?? ""}`);
    const d = (t as any).description ?? (t as any).detail ?? (t as any).body;
    if (d) console.log("      " + String(d).replace(/\s+/g," ").slice(0,300));
  }
  process.exit(0);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
