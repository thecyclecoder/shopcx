/**
 * Ticket 23fe617c — apply the new order-number auto-link to Katherine's ticket.
 * She wrote in from lovethosebuysllc@gmail.com to return order #SC132076, which
 * actually belongs to kzcosmetiks@gmail.com. Runs the real
 * autoLinkCustomerFromMessage so the order # resolves the owner and links them.
 */
import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET = "23fe617c-9b97-44d9-a278-482c61a3a98e";
const CUST = "e38ec374-5db1-41e1-827e-7055074a5095";

async function main() {
  const { autoLinkCustomerFromMessage } = await import("../src/lib/auto-link-customer-from-message");
  console.log("Running autoLinkCustomerFromMessage…");
  const result = await autoLinkCustomerFromMessage(admin as never, WS, TICKET, CUST);
  console.log("result:", JSON.stringify(result));

  if (result.linkedCount > 0) {
    await admin.from("ticket_messages").insert({
      ticket_id: TICKET, direction: "outbound", visibility: "internal", author_type: "system",
      body: `[System] Auto-linked ${result.linkedCount} account(s) from inline email/order-number mention(s) in inbound messages: ${result.linkedEmails.join(", ")}`,
    });
  }

  // Verify the link group
  const ids = [CUST, "715554d2-20a3-4b76-b1e2-d9b4486d5a24"];
  const { data: links } = await admin.from("customer_links").select("customer_id, group_id, is_primary").in("customer_id", ids);
  console.log("\ncustomer_links now:", JSON.stringify(links, null, 2));
  const groups = new Set((links || []).map(l => l.group_id));
  console.log(groups.size === 1 && (links || []).length === 2 ? "\n✅ Both accounts share one group — linked." : "\n⚠️ Link state unexpected.");
}
main().catch(e => { console.error("✗", e); process.exit(1); });
