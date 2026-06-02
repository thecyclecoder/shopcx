/**
 * Laura Fenton (ticket 20a4b3c2). The orchestrator picked
 * change_next_date instead of bill_now to ship "ASAP", and Appstle
 * rejects past-dated next-billing dates. Run bill_now directly,
 * then message her.
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
const TICKET_ID = "20a4b3c2-4aa5-46b8-a749-64f56477ef26";
const CONTRACT_ID = "27831074989";

async function main() {
  const { appstleGetUpcomingOrders, appstleAttemptBilling } = await import("../src/lib/appstle");

  // Bill now — same path the dashboard "Bill now" button uses.
  console.log("Looking up upcoming order for contract", CONTRACT_ID);
  const upcoming = await appstleGetUpcomingOrders(WS, CONTRACT_ID);
  if (!upcoming.success || !upcoming.orders?.length) {
    throw new Error(`no upcoming order: ${upcoming.error || "(empty)"}`);
  }
  const billingAttemptId = upcoming.orders[0].id;
  console.log("Charging billing attempt", billingAttemptId);
  const billed = await appstleAttemptBilling(WS, billingAttemptId);
  console.log("  →", billed);
  if (!billed.success) throw new Error(`bill_now failed: ${billed.error}`);

  const body = `<p>Hi Laura — done! I just pushed your subscription order through, so it'll ship out today with your $15 loyalty discount applied. You'll get a tracking email once it's on its way.</p><p>Suzie, Customer Support at Superfoods Company</p>`;
  const pendingAt = new Date(Date.now() + 5_000).toISOString();
  const { data: msg } = await admin.from("ticket_messages").insert({
    ticket_id: TICKET_ID,
    direction: "outbound",
    visibility: "external",
    author_type: "agent",
    body,
    pending_send_at: pendingAt,
  }).select("id").single();
  await admin.from("tickets").update({
    status: "open", escalated: false, escalation_reason: null, updated_at: new Date().toISOString(),
  }).eq("id", TICKET_ID);
  console.log(`✓ queued message ${msg?.id} for ${pendingAt}`);
}
main().catch(e => { console.error("✗", e); process.exit(1); });
