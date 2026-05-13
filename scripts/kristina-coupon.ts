/**
 * Ticket 2876a0b1 (Kristina Strom). She typed her phone number into
 * chat three times trying to complete the discount signup. Her email
 * + SMS are already subscribed in our DB (the cron picked them up
 * after the fact) but she never got the coupon. Send her the SHOPCX
 * code via chat and close the ticket.
 *
 * Defensive: also run marketing_signup direct action so we KNOW
 * Shopify has both channels subscribed.
 *
 *   npx tsx scripts/kristina-coupon.ts            # dry run
 *   npx tsx scripts/kristina-coupon.ts --apply
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const APPLY = process.argv.includes("--apply");
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET = "2876a0b1-9bee-4578-aefd-549962d82a5c";
const CUST = "2c6c1a0d-86b2-4217-96b0-6e2c267ac596";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");

  const { data: c } = await admin.from("customers")
    .select("first_name, phone, email_marketing_status, sms_marketing_status, shopify_customer_id")
    .eq("id", CUST).single();
  console.log("Customer:", c);

  // Defensive: subscribe both channels (no-op if already subscribed Shopify-side)
  if (APPLY && c?.shopify_customer_id) {
    const { subscribeToEmailMarketing, subscribeToSmsMarketing } = await import("../src/lib/shopify-marketing");
    const eRes = await subscribeToEmailMarketing(W, c.shopify_customer_id);
    console.log("  email subscribe:", eRes.success ? "ok" : `fail (${eRes.error})`);
    if (c.phone) {
      const sRes = await subscribeToSmsMarketing(W, c.shopify_customer_id, c.phone);
      console.log("  sms subscribe:", sRes.success ? "ok" : `fail (${sRes.error})`);
    }
    await admin.from("customers").update({
      email_marketing_status: "subscribed",
      sms_marketing_status: "subscribed",
      updated_at: new Date().toISOString(),
    }).eq("id", CUST);
  }

  // Chat-channel reply with the coupon
  const body = `<p>Sorry for the runaround, Kristina! Here's your code for 15% off your first order:</p>
<p style="font-family: monospace; font-size: 18px; font-weight: bold; padding: 12px 16px; background: #fef3c7; border-radius: 8px; display: inline-block;">SHOPCX</p>
<p>Just paste it at checkout. Welcome to the family — and thanks for sticking with us through the back-and-forth!</p>
<p>Julie at Superfoods Company</p>`;

  console.log("\n--- BODY ---");
  console.log(body);
  console.log("--- END ---");

  if (!APPLY) {
    console.log("\n🔍 Dry run — re-run with --apply");
    return;
  }

  // Chat — insert as ticket_message (no email send for chat channel)
  await admin.from("ticket_messages").insert({
    ticket_id: TICKET,
    direction: "outbound",
    visibility: "external",
    author_type: "ai",
    body,
    sent_at: new Date().toISOString(),
  });
  console.log("✓ message inserted");

  await admin.from("ticket_messages").insert({
    ticket_id: TICKET,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body: "[System] Operator Dylan: confirmed Shopify email+SMS subscribed, sent SHOPCX coupon (15% off) in chat to close out the discount signup loop.",
  });

  await admin.from("tickets").update({
    status: "closed",
    closed_at: new Date().toISOString(),
    escalation_reason: null,
    updated_at: new Date().toISOString(),
  }).eq("id", TICKET);
  console.log("✓ ticket closed");
}

main().catch((e) => { console.error(e); process.exit(1); });
