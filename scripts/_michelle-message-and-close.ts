import { readFileSync, existsSync } from "node:fs"; import { resolve } from "node:path";
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const t=line.trim();if(!t||t.startsWith("#"))continue;const eq=t.indexOf("=");if(eq<0)continue;const k=t.slice(0,eq);if(!process.env[k])process.env[k]=t.slice(eq+1);}

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TID = "9e6a6403-dd67-43ba-b1fe-0b208e60ee4a";
const CUSTOMER_ID = "b9adcee2-0b1e-4970-a034-c0a111d85267";

const BODY =
  `<p>Hi Michelle, wonderful news — you're all set! I made sure we protected the special pricing you've always had, so you're still paying your original <b>$41.97 per bag</b>, not the current rate.</p>` +
  `<p>I reactivated your subscription on your new card, and your order just went through — your Amazing Coffee is on its way.</p>` +
  `<p>Your next order is scheduled for <b>July 19</b>, and it'll continue every 4 weeks just like before.</p>` +
  `<p>Thank you for being such a loyal part of the Superfoods family — we're so glad to have you back on track. If there's anything else you need, just reply here.</p>` +
  `<p>Suzie, Customer Support at Superfoods Company</p>`;

(async () => {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { sendTicketReply } = await import("../src/lib/email");
  const admin = createAdminClient();

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
    subject: `Re: ${t?.subject || "Your subscription"}`,
    body: BODY, inReplyTo: t?.email_message_id || null,
    agentName: "Suzie", workspaceName: ws?.name || "Superfoods Company",
  });
  console.log("send result:", JSON.stringify(res));
  if (!res.messageId) { console.log("✗ NOT sent:", res.error); return; }

  await admin.from("tickets").update({
    email_message_id: `<${res.messageId}@resend.dev>`,
    status: "closed",
    closed_at: new Date().toISOString(),
    escalated_to: null,
    escalated_at: null,
    escalation_reason: null,
    assigned_to: null,
    updated_at: new Date().toISOString(),
  }).eq("id", TID);

  console.log(`✓ sent (messageId ${res.messageId}) + ticket unescalated, unassigned, closed`);
})().catch(e => { console.error("ERR:", e); process.exit(1); });
