/**
 * Ticket d31f8183 — send Brad the confirmation that his 3-bag Amazing Coffee
 * sub ($44.95/bag) is locked in and today's order is placed, then unescalate +
 * close + unassign.
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
const TICKET = "d31f8183-6737-45c1-a480-58f8ff9b5f5a";
const TO = "sftl87@yahoo.com";
const SUBJECT = "Re: Your subscription is cancelled — you’re all set 👍";
const IN_REPLY_TO = "<BE1FB699-92ED-4519-8636-504FEC90DA36@yahoo.com>";

const body = [
  "<p>Hi Brad,</p>",
  "<p>You're all set. I've locked in your 3-bag Amazing Coffee subscription at $44.95 per bag — that's 2 bags of Hazelnut French Roast and 1 bag of Cocoa French Roast, with free shipping on every order and nothing else added on.</p>",
  "<p>Since you're out, I placed your order today so it ships right away. The three bags came to $134.85 plus any applicable tax, and your subscription renews at that same $44.95 per bag going forward.</p>",
  "<p>Thanks for your patience while we got this sorted, Brad. Just reply here if you need anything.</p>",
  "<p>Dylan<br>Superfoods Company</p>",
].join("");

async function main() {
  const { sendTicketReply } = await import("../src/lib/email");
  console.log("Sending confirmation email to", TO, "…");
  const { messageId, error } = await sendTicketReply({
    workspaceId: WS,
    toEmail: TO,
    subject: SUBJECT,
    body,
    inReplyTo: IN_REPLY_TO,
    agentName: "Dylan",
    workspaceName: "Superfoods Company",
  });
  if (error || !messageId) throw new Error(`send failed: ${error}`);
  console.log("  ✓ sent, resend id:", messageId);

  const { error: insErr } = await admin.from("ticket_messages").insert({
    ticket_id: TICKET,
    direction: "outbound",
    visibility: "external",
    author_type: "agent",
    body,
    resend_email_id: messageId,
    sent_at: new Date().toISOString(),
  });
  if (insErr) throw new Error(`message insert failed: ${insErr.message}`);
  console.log("  ✓ outbound message persisted");

  // Unescalate + close + unassign
  const { error: updErr } = await admin.from("tickets").update({
    escalated_to: null,
    escalated_at: null,
    escalation_reason: null,
    assigned_to: null,
    status: "closed",
    closed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", TICKET);
  if (updErr) throw new Error(`ticket update failed: ${updErr.message}`);
  console.log("  ✓ ticket unescalated, unassigned, closed");

  const { data: check } = await admin.from("tickets")
    .select("status, escalated_to, assigned_to, closed_at").eq("id", TICKET).single();
  console.log("\nfinal ticket state:", JSON.stringify(check));
}
main().catch(e => { console.error("✗ FAILED:", e); process.exit(1); });
