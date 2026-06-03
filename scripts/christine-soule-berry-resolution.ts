/**
 * Resolve ticket 5a279c92 for Christine Soule.
 *
 * Background: Mixed Berry is in active crisis (expected restock 2026-07-09).
 * The Tier-1 swap put her on Strawberry Lemonade for 2 orders and she
 * doesn't want it. Per Dylan:
 *   1. Reply explaining Mixed Berry is OOS (expected back July 9).
 *   2. Remove Strawberry Lemonade from her sub (auto-readd=true is
 *      already set on her crisis_customer_actions row, so Mixed Berry
 *      will come back automatically when the crisis resolves).
 *   3. Create a return label for the most recent wrong shipment
 *      (SC131396 from May 28) and put it in the reply as a CTA.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { subRemoveItem } from "@/lib/subscription-items";
import { sendTicketReply } from "@/lib/email";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"),"utf8").split("\n")) {
  const t=line.trim(); if(!t||t.startsWith("#")) continue;
  const eq=t.indexOf("="); if(eq<0) continue;
  if(!process.env[t.slice(0,eq)]) process.env[t.slice(0,eq)]=t.slice(eq+1);
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET_ID = "5a279c92-89f4-4256-8948-439ae5a157ba";
const CUSTOMER_ID = "3fc54392-44d6-46ef-ba37-baa06132054b";
const SUB_ID = "946db2fd-8cbc-47a7-98ca-f85f664e7a32";
const CONTRACT_ID = "27836285101";
const SL_LINE_ID = "e2d4534b-8954-4c6b-a95a-a2a917a4e93d"; // Strawberry Lemonade line on her active sub
const ORDER_NUMBER = "SC131396";

async function main() {
  // ── 1. Confirm context ──
  const { data: ticket } = await sb.from("tickets").select("*").eq("id", TICKET_ID).single();
  const { data: cust } = await sb.from("customers").select("first_name, last_name, email").eq("id", CUSTOMER_ID).single();
  const { data: ws } = await sb.from("workspaces").select("name").eq("id", WS).single();
  if (!ticket || !cust || !ws) throw new Error("missing context");

  // Determine agent signature — use the assigned_to member's display_name when set.
  let agentName = "Susie";
  if (ticket.assigned_to) {
    const { data: mem } = await sb.from("workspace_members").select("display_name").eq("user_id", ticket.assigned_to).eq("workspace_id", WS).maybeSingle();
    if (mem?.display_name) agentName = mem.display_name;
  }
  console.log(`Customer: ${cust.first_name} ${cust.last_name} <${cust.email}>`);
  console.log(`Agent persona: ${agentName}`);

  // ── 2. Verify crisis enrollment with auto_readd=true (already confirmed in probe) ──
  const { data: cca } = await sb.from("crisis_customer_actions").select("id, segment, auto_readd, current_tier").eq("subscription_id", SUB_ID).maybeSingle();
  console.log(`Crisis enrollment: segment=${cca?.segment} tier=${cca?.current_tier} auto_readd=${cca?.auto_readd}`);
  if (!cca?.auto_readd) {
    // Defensive: set it if missing.
    await sb.from("crisis_customer_actions").update({ auto_readd: true }).eq("id", cca!.id);
    console.log("  → forced auto_readd=true");
  }

  // ── 3. Remove Strawberry Lemonade from her active sub ──
  console.log("\nRemoving Strawberry Lemonade line from active sub...");
  const removeRes = await subRemoveItem(WS, CONTRACT_ID, { lineGid: SL_LINE_ID });
  console.log("  result:", removeRes);
  if (!removeRes.success) {
    console.error("aborting — could not remove line");
    process.exit(1);
  }

  // ── 4. Create return label for the most recent wrong shipment ──
  console.log("\nCreating return label for", ORDER_NUMBER);
  const { createFullReturn } = await import("@/lib/shopify-returns");
  const { data: order } = await sb.from("orders")
    .select("id, order_number, shopify_order_id, shipping_address")
    .eq("workspace_id", WS).eq("order_number", ORDER_NUMBER).single();
  if (!order) throw new Error(`order ${ORDER_NUMBER} not found`);

  const addr = order.shipping_address as Record<string, string> | null;
  if (!addr) throw new Error("no shipping address on order");

  const { data: custFull } = await sb.from("customers").select("first_name, last_name, phone").eq("id", CUSTOMER_ID).single();

  const ret = await createFullReturn({
    workspaceId: WS,
    orderId: order.id,
    orderNumber: order.order_number,
    shopifyOrderGid: `gid://shopify/Order/${order.shopify_order_id}`,
    customerId: CUSTOMER_ID,
    ticketId: TICKET_ID,
    customerName: `${custFull?.first_name || ""} ${custFull?.last_name || ""}`.trim() || "Customer",
    customerPhone: custFull?.phone || undefined,
    shippingAddress: {
      street1: addr.address1 || addr.street1 || "",
      city: addr.city || "",
      state: addr.province_code || addr.provinceCode || addr.state || "",
      zip: addr.zip || "",
      country: addr.country_code || addr.countryCode || "US",
    },
    source: "agent",
    freeLabel: true,
  });
  console.log("  return result:", { success: ret.success, labelUrl: ret.labelUrl, tracking: ret.trackingNumber, error: ret.error });
  if (!ret.success || !ret.labelUrl) {
    console.error("aborting — could not create return label");
    process.exit(1);
  }

  // ── 5. Compose + send the reply ──
  const greeting = cust.first_name ? `Hi ${cust.first_name},` : "Hi,";
  const html = `
    <p>${greeting}</p>
    <p>You're right — and I'm sorry that wasn't communicated up front. Our Mixed Berry Superfood Tabs are temporarily out of stock, with restock expected around <strong>July 9th</strong>. Strawberry Lemonade went out automatically as a stand-in, which clearly missed the mark.</p>
    <p>Here's what I've done:</p>
    <ul>
      <li>Removed the Strawberry Lemonade tabs from your subscription so you won't receive another bag.</li>
      <li>Set your subscription to automatically add Mixed Berry back the moment we have stock again — no action needed on your side.</li>
      <li>Generated a prepaid return label for your most recent shipment (order ${ORDER_NUMBER}) so you can send the Strawberry Lemonade back at no cost.</li>
    </ul>
    <p style="margin: 24px 0;">
      <a href="${ret.labelUrl}" style="display: inline-block; background: #4f46e5; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 6px; font-weight: 600;">Get your return label →</a>
    </p>
    <p>Tracking number: <strong>${ret.trackingNumber}</strong>. Drop it at any USPS location whenever it's convenient.</p>
    <p>Your Ashwavana Guru Focus will keep shipping on your normal cadence, and Mixed Berry rejoins as soon as it lands in the warehouse.</p>
    <p>Thanks for sticking with us,<br>${agentName}</p>
  `;

  // Insert the outbound ticket_messages row
  const { data: msgRow, error: insertErr } = await sb.from("ticket_messages")
    .insert({
      ticket_id: TICKET_ID,
      direction: "outbound",
      visibility: "external",
      author_type: "agent",
      body: html,
    })
    .select("id")
    .single();
  if (insertErr) { console.error("insert msg err:", insertErr); process.exit(1); }

  const send = await sendTicketReply({
    workspaceId: WS,
    toEmail: cust.email,
    subject: ticket.subject || "Your Superfoods order",
    body: html,
    inReplyTo: ticket.email_message_id || null,
    agentName,
    workspaceName: ws.name || "Superfoods Company",
  });
  console.log("\nemail send:", send);
  if (send.messageId) {
    await sb.from("ticket_messages").update({ resend_email_id: send.messageId, email_status: "sent", sent_at: new Date().toISOString() }).eq("id", msgRow.id);
    await sb.from("tickets").update({ status: "pending", updated_at: new Date().toISOString() }).eq("id", TICKET_ID);
  }

  console.log("\n✓ Done. Sub line removed, return label created, customer notified.");
}
main().catch(e=>{console.error(e); process.exit(1);});
