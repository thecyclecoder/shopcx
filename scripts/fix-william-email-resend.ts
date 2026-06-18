import { readFileSync, existsSync } from "node:fs"; import { resolve } from "node:path";
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath,"utf8").split("\n")){const t=line.trim();if(!t||t.startsWith("#"))continue;const eq=t.indexOf("=");if(eq<0)continue;const k=t.slice(0,eq);if(!process.env[k])process.env[k]=t.slice(eq+1);}
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", TID="825f93fd-bfe2-4e67-942a-4f8645923e4b";
const CUST="25f93f41-0ef2-42f6-9c7a-d11e9e205d43";
const NEW="billhunt1234abc@gmail.com";
(async()=>{
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { generatePaymentRecoveryLink } = await import("../src/lib/magic-link");
  const { sendTicketReply } = await import("../src/lib/email");
  const admin = createAdminClient();
  // 1) confirm no other customer already uses the new email
  const { data: dup } = await admin.from("customers").select("id").eq("workspace_id",WS).eq("email",NEW).maybeSingle();
  if (dup) { console.log("ABORT: another customer already uses", NEW, "→", dup.id); return; }
  // 2) update the email
  const { data: before } = await admin.from("customers").select("email,shopify_customer_id,first_name").eq("id",CUST).single();
  await admin.from("customers").update({ email: NEW, updated_at: new Date().toISOString() }).eq("id", CUST);
  console.log(`email: ${before!.email} → ${NEW}`);
  // 3) regenerate link + resend to the new address
  const link = await generatePaymentRecoveryLink(CUST, before!.shopify_customer_id||"", NEW, WS);
  const btn = `<a href="${link}" style="display:inline-block;padding:13px 26px;background:#1f5e3a;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Update my payment method</a>`;
  const body = `<p>Hi William, quick update on your order — unfortunately your card was declined when we went to place it, so it hasn't gone through yet.</p>
<p>It's an easy fix: just tap the button below to pop in a new payment method, and we'll get your Superfood Tabs order taken care of right away.</p>
<p>${btn}</p>
<p>Julie at Superfoods Company</p>`;
  const { data: t } = await admin.from("tickets").select("subject,email_message_id").eq("id",TID).single();
  await admin.from("ticket_messages").insert({ ticket_id: TID, direction:"outbound", visibility:"external", author_type:"ai", body, sent_at:new Date().toISOString() });
  const res = await sendTicketReply({ workspaceId: WS, toEmail: NEW, subject:`Re: ${t!.subject||"Your order"}`, body, inReplyTo: t!.email_message_id||null, agentName:"Julie", workspaceName:"Superfoods Company" });
  console.log("resent to", NEW, "→", JSON.stringify(res));
  if(res.messageId) await admin.from("tickets").update({ email_message_id:`<${res.messageId}@resend.dev>`, updated_at:new Date().toISOString() }).eq("id",TID);
}
)().catch(e=>console.error("ERR:",e.message));
