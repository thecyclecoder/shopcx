import { readFileSync, existsSync } from "node:fs"; import { resolve } from "node:path";
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const t=line.trim();if(!t||t.startsWith("#"))continue;const eq=t.indexOf("=");if(eq<0)continue;const k=t.slice(0,eq);if(!process.env[k])process.env[k]=t.slice(eq+1);}

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TID = "f5c47b1b-e7b7-4fbc-b80e-fedb48246a74";
const ORDER_ID = "b1c9ea50-ba2a-4c02-8aba-6e03c40d9c63";
const ORDER_NUMBER = "SC129696";
const SHOPIFY_ORDER_ID = "6917941985453";
const CUSTOMER_ID = "c682bcf7-6808-4a5a-bb9b-27e36fe8f162";

(async () => {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { createFullReturn } = await import("../src/lib/shopify-returns");
  const { sendTicketReply } = await import("../src/lib/email");
  const admin = createAdminClient();

  const r = await createFullReturn({
    workspaceId: WS,
    orderId: ORDER_ID,
    orderNumber: ORDER_NUMBER,
    shopifyOrderGid: `gid://shopify/Order/${SHOPIFY_ORDER_ID}`,
    customerId: CUSTOMER_ID,
    ticketId: TID,
    customerName: "Dolores Flynn",
    customerPhone: "+15302388616",
    shippingAddress: { street1: "20265 Lakeview Drive", city: "Lakehead-Lakeshore", state: "CA", zip: "96051", country: "US" },
    resolutionType: "refund_return",
    source: "playbook",
    freeLabel: false,
  });
  console.log("createFullReturn:", JSON.stringify(r, null, 2));
  if (!r.success || !r.labelUrl) { console.log("✗ No label — aborting send."); return; }

  const orderTotal = 11094;
  const netRefund = orderTotal - (r.labelCostCents ?? 795);
  const carrier = r.carrier || "USPS";

  // She was promised the label 2 weeks ago and never got it — acknowledge the delay (like Millie's recovery).
  const BODY =
    `<p>Hi Dolores, so sorry for the delay in getting your return label over — here it is now:</p>` +
    `<p><a href="${r.labelUrl}">Download your prepaid return label</a></p>` +
    `<p>Print it, attach it to your package, and drop it off at any ${carrier} location. Once we receive it, your refund of <b>$${(netRefund / 100).toFixed(2)}</b> will be processed back to your original payment.</p>` +
    `<p>Julie at Superfoods Company</p>`;

  const { data: t } = await admin.from("tickets").select("subject, email_message_id").eq("id", TID).single();
  const { data: cust } = await admin.from("customers").select("email").eq("id", CUSTOMER_ID).single();
  const { data: ws } = await admin.from("workspaces").select("name").eq("id", WS).single();
  console.log("to:", cust?.email, "| inReplyTo:", t?.email_message_id);

  await admin.from("ticket_messages").insert({
    ticket_id: TID, direction: "outbound", visibility: "external", author_type: "ai",
    body: BODY, sent_at: new Date().toISOString(),
  });

  const res = await sendTicketReply({
    workspaceId: WS, toEmail: cust!.email,
    subject: `Re: ${t?.subject || "Your return"}`,
    body: BODY, inReplyTo: t?.email_message_id || null,
    agentName: "Julie", workspaceName: ws?.name || "Superfoods Company",
  });
  console.log("send result:", JSON.stringify(res));
  if (res.messageId) {
    // Reopen the archived ticket so the reply thread is live, and store msg id for threading
    await admin.from("tickets").update({ email_message_id: `<${res.messageId}@resend.dev>`, status: "open", updated_at: new Date().toISOString() }).eq("id", TID);
    console.log(`✓ sent (messageId ${res.messageId}) | return ${r.returnId} | tracking ${r.trackingNumber}`);
  } else {
    console.log("✗ NOT sent:", res.error);
  }
})().catch(e => { console.error("ERR:", e); process.exit(1); });
