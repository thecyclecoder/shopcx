/**
 * Ticket 1b62b00f — Traci Studebaker. Re-send her three prepaid return labels
 * as clean CTA buttons (the prior message delivered them as raw URL strings).
 * The three returns already exist (label_created, refund-on-delivery); this
 * just re-delivers them properly. Then unescalate + close.
 *
 * Note (policy, not this customer): going forward we do NOT goodwill-refund
 * older out-of-window orders — the correct offer is a return for the most
 * recent eligible order only. Traci's 3 were already created + promised, so we
 * honor them here. See docs/brain/operational-rules.md § Returns.
 *
 * Dry-run by default. Pass --apply to send + mutate.
 */
import { createAdminClient } from "./_bootstrap";
import { ctaButton } from "../src/lib/label-cta";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET = "1b62b00f-a1e3-45c0-b171-6667abd9b417";
const TO = "traci.l.studebaker@gmail.com";
const SUBJECT = "Re: Subscription";
const APPLY = process.argv.includes("--apply");

// Newest → oldest, labelled by ship date + order number.
const LABELS = [
  { order: "SC132079", date: "June 6", url: "https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/20260619/e8845e1385860c4ad9bdbc6a4f29db0c50.png" },
  { order: "SC129894", date: "May 9", url: "https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/20260619/e81b9a58edc61346f5819b9eda76b9f5ad.png" },
  { order: "SC127642", date: "April 11", url: "https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/20260619/e8078c564119b947098107668eba8ae3b4.png" },
];

const body = [
  "<p>Hi Traci,</p>",
  "<p>Here are your three prepaid return labels — just tap each one to open and print it, then drop the boxes at any USPS location whenever you're able. There's no cost to you and no rush.</p>",
  ...LABELS.map(l => ctaButton(l.url, `Return label — ${l.date} order (${l.order}) →`)),
  "<p>Once each box makes its way back to us, the refund for that order goes through automatically — you don't need to do anything else.</p>",
  "<p>Your subscription is paused, and it's already set to switch back to Mixed Berry and resume on its own once it's restocked on July 9. Take care of yourself, Traci.</p>",
  "<p>Suzie, Customer Support at Superfoods Company</p>",
].join("");

async function main() {
  const admin = createAdminClient();
  console.log(`=== Traci reply + close (1b62b00f) — ${APPLY ? "APPLY" : "DRY RUN"} ===`);

  // Thread onto her most recent inbound email.
  const { data: lastIn } = await admin.from("ticket_messages")
    .select("email_message_id").eq("ticket_id", TICKET).eq("direction", "inbound")
    .not("email_message_id", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const inReplyTo = lastIn?.email_message_id || null;
  console.log("In-Reply-To:", inReplyTo);
  console.log("\nBody preview:\n" + body.replace(/<table[\s\S]*?<\/table>/g, "[CTA BUTTON]").replace(/<\/p>/g, "\n").replace(/<[^>]+>/g, ""));

  if (!APPLY) {
    console.log("\n--- DRY RUN --- re-run with --apply.");
    return;
  }

  const { sendTicketReply } = await import("../src/lib/email");
  const { messageId, error } = await sendTicketReply({
    workspaceId: WS, toEmail: TO, subject: SUBJECT, body,
    inReplyTo, agentName: "Suzie", workspaceName: "Superfoods Company",
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

  const { data: check } = await admin.from("tickets").select("status, escalated_to, assigned_to").eq("id", TICKET).single();
  console.log("\nfinal:", JSON.stringify(check));
}
main().then(() => process.exit(0)).catch((e) => { console.error("✗", e); process.exit(1); });
