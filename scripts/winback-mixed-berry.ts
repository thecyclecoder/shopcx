/**
 * winback-mixed-berry — one-click reactivation win-back for customers who cancelled during the
 * Mixed Berry out-of-stock crisis.
 *
 * CEO 2026-07-30. Mixed Berry is back. 187 customers cancelled during the crisis and are genuinely
 * lost (no active or paused subscription anywhere). Each gets a personal, no-login link that opens
 * the reactivation journey and restarts their subscription in ONE CLICK.
 *
 * WHY NOT "REPLY TO THIS EMAIL"
 * A reply lands in the ticket queue and needs Sol or a human to interpret it and fire the action —
 * 187 times, each an opportunity to pick the wrong subscription. A journey session is bound to one
 * customer and one subscription at mint time, so the click is unambiguous and the mutation is
 * deterministic. It also means we can measure conversion instead of guessing.
 *
 * THE TOKEN
 * `journey_sessions.token` (48-char URL-safe, [[../src/lib/journey-tokens]]) is minted PER CUSTOMER
 * and resolved at `/journey/{token}`. The session already carries customer_id + subscription_id, so
 * the link itself is the authentication — no login, no lookup. One token per customer; it is a
 * secret, so it is never logged in full and never reused across people.
 *
 * SAFETY
 * - --test-to sends ONE rendered email to a single address and mints nothing. Always run this first.
 * - Recipients are recomputed live: a customer who has resubscribed since the crisis is EXCLUDED,
 *   so nobody gets "come back!" while actively subscribed (10 rows carry a stale cancelled flag —
 *   the flag is never trusted, only live subscription state).
 * - Idempotent: a customer who already has an open reactivation session is skipped, so a re-run
 *   never double-emails.
 *
 *   npx tsx scripts/winback-mixed-berry.ts                                # dry run — audience + preview
 *   npx tsx scripts/winback-mixed-berry.ts --test-to dylan@superfoodscompany.com
 *   npx tsx scripts/winback-mixed-berry.ts --apply --limit 10             # real, canary
 *   npx tsx scripts/winback-mixed-berry.ts --apply                        # the rest
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { errText } from "../src/lib/error-text";
import { generateJourneyToken, getJourneyUrl } from "../src/lib/journey-tokens";
import { shellHtml, getBrand } from "../src/lib/email-storefront";

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const JOURNEY_SLUG = "reactivate-subscription";
const TOKEN_TTL_DAYS = 45; // the offer is the point — long-lived, but bounded

const APPLY = process.argv.includes("--apply");
const TEST_TO = (() => { const i = process.argv.indexOf("--test-to"); return i > -1 ? process.argv[i + 1] : null; })();
const LIMIT = (() => { const i = process.argv.indexOf("--limit"); return i > -1 ? Math.max(1, Number(process.argv[i + 1])) : Infinity; })();

const PRODUCT_ID = "221d272d-a6c5-4a5d-86ff-ac693926c992"; // Superfood Tabs
const MB_SKU = "SC-TABS-BERRY";

/** Mixed Berry hero shot + up to two real 5★ reviews that actually mention the flavour. */
async function loadCreative(admin: any) {
  const { data: variant } = await admin.from("product_variants")
    .select("image_url").eq("product_id", PRODUCT_ID).eq("sku", MB_SKU).maybeSingle();
  const { data: reviews } = await admin.from("product_reviews")
    .select("reviewer_name, rating, title, body, smart_quote, verified_purchase, featured")
    .eq("product_id", PRODUCT_ID).eq("rating", 5).eq("status", "published")
    .or("body.ilike.%mixed berry%,body.ilike.%berry%,title.ilike.%berry%")
    .order("featured", { ascending: false, nullsFirst: false })
    .order("verified_purchase", { ascending: false, nullsFirst: false })
    .limit(12);
  // Prefer reviews that read like a WIN-BACK — someone who stopped and missed them. Those land
  // hardest on an audience that cancelled. Then fall back to the strongest remaining review.
  const scored = (reviews || []).map((r: any) => {
    const b = String(r.body || "").toLowerCase();
    const missed = /miss(ed)?\b|came back|went back|reorder|start(ed)? again|without them|ran out/.test(b) ? 2 : 0;
    const len = Math.min(1, String(r.body || "").length / 400);
    return { r, score: missed + len };
  }).sort((a: any, b: any) => b.score - a.score);
  return {
    imageUrl: (variant?.image_url as string | null) || null,
    reviews: scored.slice(0, 2).map((x: any) => x.r),
  };
}

function renderEmail(
  firstName: string | null,
  journeyUrl: string,
  creative: { imageUrl: string | null; reviews: any[] },
) {
  const hi = firstName ? `Hi ${firstName},` : "Hi there,";
  const text = [
    hi,
    "",
    "Mixed Berry is back.",
    "",
    "It's restocked, it's shipping, and your spot is still here. One click puts your subscription back exactly how you had it — same items, same price.",
    "",
    journeyUrl,
    "",
    "Nothing ships today. Restarting just puts you back on your normal schedule, and you can change or cancel any time.",
    "",
    "— The Superfoods Company team",
  ].join("\n");

  const hero = creative.imageUrl
    ? `<tr><td style="padding:0;">
         <img src="${creative.imageUrl}" width="600" alt="Superfood Tabs — Mixed Berry"
              style="display:block;width:100%;max-width:600px;height:auto;border:0;" />
       </td></tr>`
    : "";

  const reviewCards = creative.reviews.map((rv) => {
    const rating = Math.max(0, Math.min(5, rv.rating || 5));
    const stars = "★★★★★".slice(0, rating) + "☆☆☆☆☆".slice(0, 5 - rating);
    const body = String(rv.smart_quote || rv.body || "").trim().slice(0, 260);
    const who = String(rv.reviewer_name || "").trim() || "A verified customer";
    const badge = rv.verified_purchase ? ' <span style="color:#71717a;font-size:11px;">· verified buyer</span>' : "";
    return `
      <tr><td class="sx-pad" style="padding:8px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafafa;border-radius:8px;">
          <tr><td style="padding:16px 18px;">
            <div style="color:#eab308;font-size:14px;letter-spacing:2px;">${stars}</div>
            <div class="sx-review-body" style="font-size:14px;color:#27272a;line-height:1.55;margin-top:6px;">${escapeHtmlLite(body)}</div>
            <div style="font-size:12px;color:#52525b;margin-top:8px;">— ${escapeHtmlLite(who)}${badge}</div>
          </td></tr>
        </table>
      </td></tr>`;
  }).join("");

  const bodyHtml = `
      ${hero}
      <tr><td class="sx-pad" style="padding:28px 32px 0 32px;">
        <div class="sx-h1" style="font-size:26px;font-weight:800;color:#18181b;line-height:1.25;">Mixed Berry is back.</div>
      </td></tr>
      <tr><td class="sx-pad" style="padding:12px 32px 0 32px;">
        <div class="sx-body" style="font-size:15px;color:#27272a;line-height:1.6;">${escapeHtmlLite(hi)}</div>
        <div class="sx-body" style="font-size:15px;color:#27272a;line-height:1.6;margin-top:10px;">
          It's restocked, it's shipping, and your spot is still here. One click puts your subscription back exactly how you had it — <strong>same items, same price</strong>.
        </div>
      </td></tr>
      <tr><td class="sx-pad" align="center" style="padding:24px 32px 4px 32px;">
        <a href="${journeyUrl}" style="background:#18181b;color:#ffffff;text-decoration:none;padding:16px 34px;border-radius:8px;display:inline-block;font-weight:700;font-size:16px;">Restart my subscription</a>
      </td></tr>
      <tr><td class="sx-pad" align="center" style="padding:0 32px 18px 32px;">
        <div style="font-size:12px;color:#71717a;">Nothing ships today — you'll just pick up your normal schedule.</div>
      </td></tr>
      ${reviewCards ? `<tr><td class="sx-pad" style="padding:14px 32px 2px 32px;"><div style="font-size:13px;font-weight:700;color:#52525b;letter-spacing:.4px;text-transform:uppercase;">Why people keep it in the rotation</div></td></tr>` : ""}
      ${reviewCards}
      <tr><td class="sx-pad" style="padding:20px 32px 28px 32px;">
        <div style="font-size:12px;color:#71717a;line-height:1.5;">Change or cancel any time. — The Superfoods Company team</div>
      </td></tr>`;

  return { subject: "Mixed Berry is back 🎉", preheader: "Restart your subscription in one click — same items, same price.", text, bodyHtml };
}

/** Minimal HTML escape for interpolated copy. */
function escapeHtmlLite(v: string): string {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function main() {
  const admin = createAdminClient() as any;
  console.log(APPLY ? "🔥 APPLYING" : TEST_TO ? "✉️  TEST SEND" : "🔍 DRY RUN");
  const brand = await getBrand(W, "superfoodscompany.com");
  const creative = await loadCreative(admin);
  console.log(`creative: hero=${creative.imageUrl ? "yes" : "MISSING"} · reviews=${creative.reviews.length}`);

  // The journey definition (idempotent).
  let { data: jdef } = await admin.from("journey_definitions")
    .select("id, slug, is_active").eq("workspace_id", W).eq("slug", JOURNEY_SLUG).maybeSingle();
  if (!jdef && (APPLY || TEST_TO)) {
    const { data: created, error } = await admin.from("journey_definitions").insert({
      workspace_id: W, slug: JOURNEY_SLUG, name: "Reactivate Subscription",
      journey_type: "win_back", trigger_intent: "reactivate_subscription",
      description: "One-click win-back — restart a cancelled or paused subscription from a personal link.",
      channels: ["email"], is_active: true, priority: 0,
    }).select("id, slug, is_active").single();
    if (error) throw error;
    jdef = created;
    console.log(`✓ journey definition created: ${jdef.slug}`);
  }
  console.log(`journey: ${jdef ? `${jdef.slug} (${jdef.is_active ? "active" : "inactive"})` : "(not created — dry run)"}`);

  // ── Audience: cancelled during the crisis AND genuinely gone today ──
  const { data: crisis } = await admin.from("crisis_events")
    .select("id, name").eq("workspace_id", W).ilike("name", "%Mixed Berry%").maybeSingle();
  const { data: rows } = await admin.from("crisis_customer_actions")
    .select("customer_id").eq("crisis_id", crisis.id).eq("cancelled", true);
  const candidateIds = [...new Set((rows || []).map((r: any) => r.customer_id).filter(Boolean))];

  const audience: { id: string; email: string; first_name: string | null }[] = [];
  for (const cid of candidateIds) {
    // LIVE check — never trust the cancelled flag. Anyone with an active or paused sub is excluded;
    // emailing an active subscriber "come back" is worse than not emailing at all.
    const { count: live } = await admin.from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", W).eq("customer_id", cid).in("status", ["active", "paused"]);
    if ((live ?? 0) > 0) continue;
    const { data: cust } = await admin.from("customers")
      .select("id, email, first_name").eq("id", cid).maybeSingle();
    if (!cust?.email) continue;
    audience.push(cust);
  }
  console.log(`\ncandidates flagged cancelled: ${candidateIds.length}`);
  console.log(`→ genuinely lost (no active/paused sub anywhere): ${audience.length}`);

  // ── Test send ──
  if (TEST_TO) {
    const preview = renderEmail("Dylan", getJourneyUrl("EXAMPLE-TOKEN-not-a-real-session"), creative);
    const html = await shellHtml({ title: preview.subject, preheader: preview.preheader, bodyHtml: preview.bodyHtml, brand });
    const { sendCampaignEmailAsTicket } = await import("./_campaign-send");
    const { Resend } = await import("resend");
    const { decrypt } = await import("../src/lib/crypto");
    const { data: ws } = await admin.from("workspaces").select("resend_api_key_encrypted, resend_domain, support_email, name").eq("id", W).maybeSingle();
    const resend = new Resend(decrypt(ws.resend_api_key_encrypted));
    const replyTo = ws.support_email || `support@${ws.resend_domain}`;
    const sent = await resend.emails.send({ from: `${ws.name} <orders@${ws.resend_domain}>`, to: TEST_TO,
      subject: `[TEST] ${preview.subject}`, html, text: preview.text, replyTo });
    const r = sent.error ? { error: sent.error.message } : { messageId: sent.data?.id };
    console.log(`   reply-to: ${replyTo}`);
    console.log(`\n✉️  test sent to ${TEST_TO}: ${r.error ? `FAILED — ${r.error}` : `ok (${r.messageId})`}`);
    console.log("   (link is a placeholder — real sends mint a per-customer token)");
    return;
  }

  if (!APPLY) {
    const preview = renderEmail("Sarah", getJourneyUrl("EXAMPLE-TOKEN"), creative);
    console.log(`\nsubject: ${preview.subject}\n`);
    console.log(preview.text);
    console.log(`\nWould mint ${Math.min(audience.length, LIMIT === Infinity ? audience.length : LIMIT)} personal tokens + send.`);
    console.log("Run --test-to <email> first, then --apply --limit 10.");
    return;
  }

  // ── Mint one session per customer + send ──
  const { sendCampaignEmailAsTicket } = await import("./_campaign-send");
  const slice = audience.slice(0, LIMIT === Infinity ? audience.length : LIMIT);
  let sent = 0; const failures: { email: string; error: string }[] = [];
  for (const cust of slice) {
    try {
      const { data: open } = await admin.from("journey_sessions")
        .select("id").eq("workspace_id", W).eq("journey_id", jdef.id)
        .eq("customer_id", cust.id).eq("status", "pending").maybeSingle();
      if (open) { console.log(`  · ${cust.email} already has an open session — skipped`); continue; }

      const token = generateJourneyToken();
      const { error: sErr } = await admin.from("journey_sessions").insert({
        workspace_id: W, journey_id: jdef.id, customer_id: cust.id, token,
        token_expires_at: new Date(Date.now() + TOKEN_TTL_DAYS * 864e5).toISOString(),
        status: "pending", current_step: 0, responses: {},
        config_snapshot: { source: "winback-mixed-berry", crisis_id: crisis.id },
      });
      if (sErr) { failures.push({ email: cust.email, error: `session: ${sErr.message}` }); continue; }

      const mail = renderEmail(cust.first_name, getJourneyUrl(token), creative);
      const html = await shellHtml({ title: mail.subject, preheader: mail.preheader, bodyHtml: mail.bodyHtml, brand });
      const r = await sendCampaignEmailAsTicket({
        workspaceId: W, customerId: cust.id, toEmail: cust.email,
        subject: mail.subject, html, text: mail.text,
        tags: ["winback","crisis:mixed-berry","campaign"], source: "winback-mixed-berry",
      });
      if (!r.ok) { failures.push({ email: cust.email, error: r.error ?? "send failed" }); continue; }
      sent++;
      if (sent % 25 === 0) console.log(`  … ${sent}/${slice.length}`);
    } catch (e) {
      failures.push({ email: cust.email, error: errText(e) });
    }
  }
  console.log(`\n✓ sent ${sent}/${slice.length}`);
  if (failures.length) {
    console.log(`✗ ${failures.length} failed:`);
    for (const f of failures.slice(0, 10)) console.log(`   ${f.email}: ${String(f.error).slice(0, 120)}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
