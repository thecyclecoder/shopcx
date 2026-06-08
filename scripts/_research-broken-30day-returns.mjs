import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

// The exact broken promise text from the old confirm_return case
const { data: msgs } = await admin.from("ticket_messages")
  .select("id, ticket_id, body, created_at")
  .ilike("body", "%generating your prepaid shipping label now and will email it to you shortly%")
  .order("created_at", { ascending: false });

console.log(`Tickets with the broken "email it shortly" promise: ${msgs?.length || 0}\n`);

let stuck = 0, ok = 0;
for (const m of msgs || []) {
  const { data: t } = await admin.from("tickets")
    .select("id, subject, status, customer_id, created_at").eq("id", m.ticket_id).single();
  const { data: c } = await admin.from("customers").select("email, first_name").eq("id", t?.customer_id).single();
  // Does this customer have ANY real return with a label?
  const { data: rets } = await admin.from("returns")
    .select("id, order_number, status, label_url, created_at")
    .eq("customer_id", t?.customer_id);
  const hasLabel = (rets || []).some(r => r.label_url);
  const flag = hasLabel ? "OK (has label)" : "STUCK — no label";
  if (hasLabel) ok++; else stuck++;
  console.log(`${m.created_at?.slice(0,10)} ${c?.first_name||"?"} <${c?.email}> ticket=${t?.id?.slice(0,8)} status=${t?.status} returns=${rets?.length||0} → ${flag}`);
}
console.log(`\nSummary: ${stuck} STUCK (no label ever delivered), ${ok} later resolved.`);
