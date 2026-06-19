/**
 * Ticket 178ae5a7 — Jodi. Correct the erroneous 17:10 auto-reply (which told
 * her we'd stopped her renewal and asked her to confirm a cancel). She'd
 * actually accepted a 20%-off save and chose to KEEP the Superfood Tabs sub;
 * the renewal already shipped (SC132928) and we've refunded the 20% ($15.17).
 * Send the corrected confirmation, then unescalate + unassign + close.
 *
 * Dry-run by default. Pass --apply to send + mutate.
 */
import { createAdminClient } from "./_bootstrap";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET = "178ae5a7-c29e-45ed-a4b7-24fcbf0e51af";
const TO = "jodi@lender2.com";
const SUBJECT = "Re: A shipment from order SC132887 is on the way";
const IN_REPLY_TO = "<064f01dcff73$df5f02e0$9e1d08a0$@lender2.com>";
const APPLY = process.argv.includes("--apply");

const body = [
  "<p>Hi Jodi,</p>",
  "<p>Quick correction to my last note — please disregard it. Looking again, I can see you chose to keep your Superfood Tabs subscription with 20% off rather than cancel.</p>",
  "<p>So that's exactly what I've done. Your most recent order is on its way to you, and I've put the 20% back on your card — $15.17.</p>",
  "<p>Nothing else has changed on your account. Just reply here if you need anything at all.</p>",
  "<p>Suzie, Customer Support at Superfoods Company</p>",
].join("");

async function main() {
  const admin = createAdminClient();
  console.log(`=== Jodi reply + close (ticket 178ae5a7) — ${APPLY ? "APPLY" : "DRY RUN"} ===\n`);
  console.log("To:", TO, "\nSubject:", SUBJECT, "\nIn-Reply-To:", IN_REPLY_TO);
  console.log("\nBody:\n" + body.replace(/<\/p>/g, "\n").replace(/<[^>]+>/g, ""));

  if (!APPLY) {
    console.log("\n--- DRY RUN --- re-run with --apply to send + unescalate/unassign/close.");
    return;
  }

  const { sendTicketReply } = await import("../src/lib/email");
  console.log("\nSending…");
  const { messageId, error } = await sendTicketReply({
    workspaceId: WS, toEmail: TO, subject: SUBJECT, body,
    inReplyTo: IN_REPLY_TO, agentName: "Suzie", workspaceName: "Superfoods Company",
  });
  if (error || !messageId) throw new Error(`send failed: ${error}`);
  console.log("  ✓ sent, resend id:", messageId);

  const { error: insErr } = await admin.from("ticket_messages").insert({
    ticket_id: TICKET, direction: "outbound", visibility: "external", author_type: "agent",
    body, resend_email_id: messageId, sent_at: new Date().toISOString(),
  });
  if (insErr) throw new Error(`message insert failed: ${insErr.message}`);
  console.log("  ✓ outbound message persisted");

  const { error: updErr } = await admin.from("tickets").update({
    escalated_to: null, escalated_at: null, escalation_reason: null,
    assigned_to: null, status: "closed", closed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", TICKET);
  if (updErr) throw new Error(`ticket update failed: ${updErr.message}`);
  console.log("  ✓ ticket unescalated, unassigned, closed");

  const { data: check } = await admin.from("tickets")
    .select("status, escalated_to, assigned_to, closed_at").eq("id", TICKET).single();
  console.log("\nfinal ticket state:", JSON.stringify(check));
}
main().then(() => process.exit(0)).catch((e) => { console.error("✗ FAILED:", e); process.exit(1); });
