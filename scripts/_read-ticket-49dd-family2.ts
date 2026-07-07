import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const IDS = [
  ["49ddd6c4","49ddd6c4-9894-4474-b925-fffe19a175c8"],
  ["e671e536","e671e536-cde6-43cb-91bb-b4113e94492f"],
  ["4f513c1f","4f513c1f-c16d-4a48-b43a-cf3569460b66"],
  ["a818cb97","a818cb97-de33-4c90-b222-7a802f8e345c"],
];
const price = (m:string,i:number,o:number)=>{
  const P:Record<string,[number,number]> = {opus:[15,75],sonnet:[3,15],haiku:[1,5]};
  const k = m.includes("opus")?"opus":m.includes("sonnet")?"sonnet":"haiku";
  return (i*P[k][0]+o*P[k][1])/1e6;
};
(async () => {
  const db = createAdminClient();
  let grand = 0, grandRows = 0;
  for (const [short,id] of IDS) {
    const { data: tok, error } = await db.from("ai_token_usage").select("*").eq("ticket_id", id);
    if (error) { console.log(short, "ERR", error.message); continue; }
    let c = 0;
    for (const r of tok||[]) {
      const i = (r as any).input_tokens ?? (r as any).prompt_tokens ?? 0;
      const o = (r as any).output_tokens ?? (r as any).completion_tokens ?? 0;
      c += price(((r as any).model||""), i, o);
    }
    grand += c; grandRows += (tok||[]).length;
    console.log(`${short}  rows=${(tok||[]).length}  $${c.toFixed(2)}`);
  }
  console.log(`GRAND across 4 tickets: rows=${grandRows}  $${grand.toFixed(2)}`);
  process.exit(0);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
