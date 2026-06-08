import { readFileSync, existsSync } from "node:fs"; import { resolve } from "node:path";
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const t=line.trim();if(!t||t.startsWith("#"))continue;const eq=t.indexOf("=");if(eq<0)continue;const k=t.slice(0,eq);if(!process.env[k])process.env[k]=t.slice(eq+1);}

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TID = "b97f558e-0400-49dc-9b19-753492b00f90";
const ORDER_ID = "97da9ef3-bdb0-454f-af58-cac4ede2b05c";
const ORDER_NUMBER = "SC131807";
const SHOPIFY_ORDER_ID = "6970365051053";
const CUSTOMER_ID = "e260c4a5-5a77-40ea-a86a-ce900c9bd5b6";

(async () => {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { createFullReturn } = await import("../src/lib/shopify-returns");
  const { sendTicketReply } = await import("../src/lib/email");
  const admin = createAdminClient();

  // 1. Create the return + buy the label (the path the playbook should have taken)
  const r = await createFullReturn({
    workspaceId: WS,
    orderId: ORDER_ID,
    orderNumber: ORDER_NUMBER,
    shopifyOrderGid: `gid://shopify/Order/${SHOPIFY_ORDER_ID}`,
    customerId: CUSTOMER_ID,
    ticketId: TID,
    customerName: "Jill Howe",
    customerPhone: "+12108618130",
    shippingAddress: { street1: "3 Kensington Court", city: "San Antonio", state: "TX", zip: "78218", country: "US" },
    resolutionType: "refund_return",
    source: "playbook",
    freeLabel: false,
  });
  console.log("createFullReturn:", JSON.stringify(r, null, 2));
  if (!r.success || !r.labelUrl) { console.log("✗ No label — aborting send."); return; }

  const orderTotal = 6484;
  const netRefund = orderTotal - (r.labelCostCents ?? 795);
  const carrier = r.carrier || "USPS";

  const BODY =
    `<p>Hi Jill, your return is all set up. Here's your prepaid shipping label:</p>` +
    `<p><a href="${r.labelUrl}">Download your return shipping label</a></p>` +
    `<p>Print it, attach it to your package, and drop it off at any ${carrier} location. Once we receive it, your refund of <b>$${(netRefund / 100).toFixed(2)}</b> will be processed back to your original payment.</p>` +
    `<p>Suzie, Customer Support at Superfoods Company</p>`;

  // 2. Send threaded into the existing email conversation
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
    subject: `Re: ${t?.subject || "Your request"}`,
    body: BODY, inReplyTo: t?.email_message_id || null,
    agentName: "Suzie", workspaceName: ws?.name || "Superfoods Company",
  });
  console.log("send result:", JSON.stringify(res));
  if (res.messageId) {
    await admin.from("tickets").update({ email_message_id: `<${res.messageId}@resend.dev>`, updated_at: new Date().toISOString() }).eq("id", TID);
    console.log(`✓ sent + threaded (messageId ${res.messageId}) | return ${r.returnId} | tracking ${r.trackingNumber}`);
  } else {
    console.log("✗ NOT sent:", res.error);
  }
})().catch(e => { console.error("ERR:", e); process.exit(1); });
