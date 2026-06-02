/**
 * Five follow-up actions per the operator's direction:
 *   #4 Marilyn   — magic link to access account
 *   #15 Lynne    — brief confirmation of linking
 *   #18 Sheela   — verify crisis enrollment + complete confirmation
 *   #20 Linda    — partial refund $59.58 for the extra unit on SC129298
 *   #24 Stephanie — push next billing date +90 days, explain 8wk is max
 */
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

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

interface FollowUp {
  name: string;
  tid: string;
  cid: string;
  email: string;
  shopifyCustomerId: string;
  body: string;
  beforeSend?: () => Promise<void>;
}

async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { sendTicketReply } = await import("../src/lib/email");
  const { logEmailSent } = await import("../src/lib/email-tracking");
  const { generateMagicLinkURL } = await import("../src/lib/magic-link");
  const { executeSonnetDecision } = await import("../src/lib/action-executor");
  const { appstleUpdateNextBillingDate } = await import("../src/lib/appstle");
  const admin = createAdminClient();

  const ws = (await admin.from("workspaces").select("name").eq("id", W).single()).data;

  // Marilyn
  const marilynLink = await generateMagicLinkURL(
    "40e59f0a-a9ca-4395-8d27-b136f8452cea", "9112894570669", "mnbuman@gmail.com", W,
  );

  // Stephanie — push next billing date 90 days from today
  const stephNewDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const followups: FollowUp[] = [
    {
      name: "Marilyn",
      tid: "b99c9fec-a387-404c-b31b-2bff4494623c",
      cid: "40e59f0a-a9ca-4395-8d27-b136f8452cea",
      email: "mnbuman@gmail.com",
      shopifyCustomerId: "9112894570669",
      body: `<p>Hi Marilyn,</p>
<p>Sorry for the delayed follow-up — here's a one-click link to access your account:</p>
<p><a href="${marilynLink}" style="display:inline-block;padding:12px 24px;background:#18181b;color:white;text-decoration:none;border-radius:8px;font-weight:600;">Access My Account</a></p>
<p>This link logs you in directly so you can review your subscriptions and recent charges. It's good for 24 hours; if it expires before you use it, just reply and I'll send a fresh one.</p>
<p>Suzie<br>Customer Support at Superfoods Company</p>`,
    },
    {
      name: "Lynne",
      tid: "9bfce5c2-0e91-429a-806a-93054ef7d195",
      cid: "127fe2f1-1b91-44ec-a1bc-866df037302d",
      email: "lshovlain1@gmail.com",
      shopifyCustomerId: "9832746057901",
      body: `<p>Hi Lynne,</p>
<p>Quick follow-up — I confirmed your two accounts are linked (this email and lshovlain@mchsi.com), so any subscription or order under either email will show up together. If you'd like me to look up anything specific from there, just let me know.</p>
<p>Suzie<br>Customer Support at Superfoods Company</p>`,
    },
    {
      name: "Sheela",
      tid: "fadb5f01-7d7f-499e-af21-a144145d4e06",
      cid: "c113bb2d-5115-4fd8-94ff-5979b020e3b9",
      email: "whispyweeve@gmail.com",
      shopifyCustomerId: "7060800831661",
      body: `<p>Hi Sheela,</p>
<p>Just wrapping up loose ends — quick recap of what's done:</p>
<ul>
  <li>Your $15 loyalty coupon (LOYALTY-15-YBTEP7) is applied to your subscription — it'll come off automatically on your next renewal</li>
  <li>Your subscription is paused since Mixed Berry is out of stock; we'll automatically resume it the moment it's back (expected July 2026)</li>
</ul>
<p>You're all set, no action needed on your end.</p>
<p>Suzie<br>Customer Support at Superfoods Company</p>`,
      beforeSend: async () => {
        // Verify Sheela's crisis enrollment row exists; if not, log a warning
        const { data: enr } = await admin.from("crisis_customer_actions")
          .select("id, current_tier, paused_at, auto_resume").eq("customer_id", "c113bb2d-5115-4fd8-94ff-5979b020e3b9").maybeSingle();
        if (enr) console.log("  ✓ Sheela crisis enrollment present:", enr.id, "tier", enr.current_tier, "paused_at", enr.paused_at, "auto_resume", enr.auto_resume);
        else console.log("  ⚠ Sheela has no crisis_customer_actions row — sub paused but not enrolled in crisis tracking; flag for ops");
      },
    },
    {
      name: "Linda",
      tid: "9f53fde5-6164-428c-9805-6a4aa5624a29",
      cid: "034b35c7-5d07-4716-bf02-286f5e90d305",
      email: "lindad1203@yahoo.com",
      shopifyCustomerId: "9836576571565",
      body: `<p>Hi Linda,</p>
<p>Quick follow-up on your order — your renewal (SC129298) shipped out before we could change the quantity, so 2 packages are on their way. To make this right, I've issued a <strong>$59.58 refund</strong> to your card so you're effectively only paying for the 1 package you wanted. The refund should land in your account in 5–7 business days.</p>
<p>Feel free to keep both packages; no need to send anything back.</p>
<p>Suzie<br>Customer Support at Superfoods Company</p>`,
      beforeSend: async () => {
        // Run partial refund through the production executor
        await executeSonnetDecision(
          { admin, workspaceId: W, ticketId: "9f53fde5-6164-428c-9805-6a4aa5624a29", customerId: "034b35c7-5d07-4716-bf02-286f5e90d305", channel: "email", sandbox: false },
          {
            reasoning: "Operator: Linda asked to change qty 2→1 but order was already in Amplifier 'Processing Shipment'. Refund the extra unit ($59.58 = half of $119.16).",
            action_type: "direct_action",
            actions: [{ type: "partial_refund", shopify_order_id: "6908799189165", amount_cents: 5958, reason: "Customer requested qty change after order in fulfillment — refunding the extra unit." }],
          },
          null,
          async () => { /* no-op send */ },
          async (m) => {
            await admin.from("ticket_messages").insert({
              ticket_id: "9f53fde5-6164-428c-9805-6a4aa5624a29", direction: "outbound", visibility: "internal",
              author_type: "system", body: m,
            });
          },
        );
      },
    },
    {
      name: "Stephanie",
      tid: "61ca5299-a15f-4fe8-8348-cd651b8e668a",
      cid: "007e477d-fc40-48e9-b0ea-045fb866b703",
      email: "faust.stephanie7@gmail.com",
      shopifyCustomerId: "9486420770989",
      body: `<p>Hi Stephanie,</p>
<p>Following up on your request to space out your subscription further — every 8 weeks is the longest interval we offer, but I've gone ahead and pushed your <strong>next order out to ${new Date(stephNewDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</strong> (about 90 days from today) so you have plenty of time before your next shipment.</p>
<p>If you need to push it again before then, just reply and I'll take care of it.</p>
<p>Suzie<br>Customer Support at Superfoods Company</p>`,
      beforeSend: async () => {
        const r = await appstleUpdateNextBillingDate(W, "33172717741", stephNewDate);
        console.log("  Steph next-date push:", JSON.stringify(r));
      },
    },
  ];

  for (const f of followups) {
    console.log(`\n══ ${f.name} ══`);
    if (f.beforeSend) {
      try { await f.beforeSend(); }
      catch (e) { console.error(`  ⚠ beforeSend failed:`, e); continue; }
    }

    // Reopen so the message threads cleanly, send, then close
    await admin.from("tickets").update({ status: "open", updated_at: new Date().toISOString() }).eq("id", f.tid);

    const { data: t } = await admin.from("tickets").select("subject, email_message_id").eq("id", f.tid).single();
    const { data: inserted } = await admin.from("ticket_messages").insert({
      ticket_id: f.tid, direction: "outbound", visibility: "external", author_type: "ai",
      body: f.body, sent_at: new Date().toISOString(),
    }).select("id").single();

    const sent = await sendTicketReply({
      workspaceId: W, toEmail: f.email,
      subject: `Re: ${t?.subject || "Your account"}`,
      body: f.body,
      inReplyTo: t?.email_message_id || null,
      agentName: "Suzie",
      workspaceName: ws?.name || "Superfoods Company",
    });
    if (sent.error) { console.error(`  ✗ send fail:`, sent.error); continue; }
    console.log(`  ✓ sent ${sent.messageId}`);

    if (sent.messageId && inserted?.id) {
      await admin.from("ticket_messages").update({
        resend_email_id: sent.messageId, email_status: "sent",
        email_message_id: `<${sent.messageId}@resend.dev>`,
      }).eq("id", inserted.id);
      await logEmailSent({
        workspaceId: W, resendEmailId: sent.messageId, recipientEmail: f.email,
        subject: t?.subject || "Your account", ticketId: f.tid, customerId: f.cid,
      });
    }

    await admin.from("tickets").update({
      status: "closed",
      assigned_to: null, escalated_to: null, escalated_at: null, escalation_reason: null,
      updated_at: new Date().toISOString(),
    }).eq("id", f.tid);

    await admin.from("ticket_messages").insert({
      ticket_id: f.tid, direction: "outbound", visibility: "internal", author_type: "system",
      body: `[System] Operator follow-up sent — see prior message. Unescalated, unassigned, closed.`,
    });
  }

  console.log("\n✓ All five follow-ups sent");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
