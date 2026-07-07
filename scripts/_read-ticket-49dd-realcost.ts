import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { usageCostCents } from "../src/lib/ai-usage";
const CUST = "7f215e32-a825-4a55-b558-9630dd2357c9";
(async () => {
  const db = createAdminClient();
  const { data: tks } = await db.from("tickets").select("id,subject,status").eq("customer_id",CUST);
  let grand=0;
  const perTicket:Record<string,number>={};
  for (const t of tks||[]) {
    const { data: tok } = await db.from("ai_token_usage").select("*").eq("ticket_id",(t as any).id);
    let c=0;
    for (const r of tok||[]) {
      c += usageCostCents((r as any).model||"", {
        input_tokens:(r as any).input_tokens||0, output_tokens:(r as any).output_tokens||0,
        cache_creation_tokens:(r as any).cache_creation_tokens||0, cache_read_tokens:(r as any).cache_read_tokens||0,
      });
    }
    if ((tok||[]).length) perTicket[(t as any).id.slice(0,8)] = c;
    grand+=c;
  }
  for (const [k,v] of Object.entries(perTicket)) console.log(`  ${k}: $${(v/100).toFixed(2)} (${(v).toFixed(1)}¢)`);
  console.log("SAGA TOTAL (real usageCostCents incl cache): $" + (grand/100).toFixed(2));

  // just this ticket, break down cache vs non-cache
  const TID="49ddd6c4-9894-4474-b925-fffe19a175c8";
  const { data: tok } = await db.from("ai_token_usage").select("*").eq("ticket_id",TID);
  let ci=0,cr=0,cc=0,co=0;
  for (const r of tok||[]) { ci+=(r as any).input_tokens||0; co+=(r as any).output_tokens||0; cc+=(r as any).cache_creation_tokens||0; cr+=(r as any).cache_read_tokens||0; }
  console.log(`\nThis ticket token totals: input=${ci} output=${co} cache_create=${cc} cache_read=${cr}`);
  process.exit(0);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
