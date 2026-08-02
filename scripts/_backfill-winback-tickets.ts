/**
 * Backfill closed tickets for the 187 Mixed Berry win-back emails already sent.
 *
 * Those went out through an ad-hoc sender before the ticket-anchored path existed, so there is no
 * record in the ticket system that we contacted these customers — and they carried a dead reply-to
 * (`no-reply@superfoodscompany.com`) instead of the support address inbound mail is processed on.
 *
 * WHAT THIS CAN AND CANNOT DO
 * - CAN: create the closed ticket + the exact outbound message, so any agent looking at the customer
 *   sees what we sent and when. Each recipient's real journey link is reconstructed from their
 *   `journey_sessions` token, so the record shows the message they actually received.
 * - CANNOT: make replies thread. The sent messages carried the dead reply-to and their Resend ids
 *   were never stored, so `email_message_id` cannot be anchored retroactively. A reply to one of
 *   those emails is already lost. This is a record, not a repair.
 *
 * Sends NOTHING. Idempotent — a customer who already has a win-back ticket is skipped.
 *
 *   npx tsx scripts/_backfill-winback-tickets.ts            # dry run
 *   npx tsx scripts/_backfill-winback-tickets.ts --apply
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getJourneyUrl } from "../src/lib/journey-tokens";

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");
const SUBJECT = "Mixed Berry is back 🎉";

async function main() {
  const admin = createAdminClient() as any;
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");

  const { data: jdef } = await admin.from("journey_definitions")
    .select("id").eq("workspace_id", W).eq("slug", "reactivate-subscription").maybeSingle();
  const { data: sessions } = await admin.from("journey_sessions")
    .select("customer_id, token, created_at, config_snapshot")
    .eq("workspace_id", W).eq("journey_id", jdef.id);
  const winback = (sessions || []).filter((s: any) => s.config_snapshot?.source === "winback-mixed-berry");
  console.log(`win-back sessions (emails actually sent): ${winback.length}`);

  let created = 0, skipped = 0;
  for (const s of winback) {
    const { data: existing } = await admin.from("tickets")
      .select("id").eq("workspace_id", W).eq("customer_id", s.customer_id)
      .contains("tags", ["winback"]).maybeSingle();
    if (existing) { skipped++; continue; }
    if (!APPLY) { created++; continue; }

    const { data: cust } = await admin.from("customers").select("email, first_name").eq("id", s.customer_id).maybeSingle();
    if (!cust?.email) { skipped++; continue; }

    const { data: ticket, error } = await admin.from("tickets").insert({
      workspace_id: W, customer_id: s.customer_id, channel: "email", status: "closed",
      subject: SUBJECT, tags: ["winback", "crisis:mixed-berry", "campaign", "backfilled"],
      ai_handled: false, created_at: s.created_at,
      closed_at: new Date().toISOString(), resolved_at: new Date().toISOString(),
    }).select("id").single();
    if (error) { console.log(`  ✗ ${cust.email}: ${error.message}`); skipped++; continue; }

    const url = getJourneyUrl(s.token);
    const body = [
      `<p><em>[Backfilled record — this campaign email was sent on ${String(s.created_at).slice(0, 16).replace("T", " ")} UTC.]</em></p>`,
      `<p><strong>Mixed Berry is back.</strong></p>`,
      `<p>${cust.first_name ? `Hi ${cust.first_name},` : "Hi there,"} it's restocked, it's shipping, and your spot is still here. One click puts your subscription back exactly how you had it — same items, same price.</p>`,
      `<p><a href="${url}">Restart my subscription</a></p>`,
      `<p style="color:#71717a;font-size:12px;">Sent with reply-to no-reply@superfoodscompany.com — replies to this message were not delivered. Fixed for later campaigns.</p>`,
    ].join("\n");

    await admin.from("ticket_messages").insert({
      ticket_id: ticket.id, direction: "outbound", visibility: "external", author_type: "system",
      body, sent_at: s.created_at, email_status: "sent",
    });
    created++;
    if (created % 50 === 0) console.log(`  … ${created}`);
  }

  console.log(`\n${APPLY ? "✓ created" : "would create"} ${created} closed ticket(s) · skipped ${skipped}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
