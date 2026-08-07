/**
 * sl-crisis-notify — tell the Strawberry Lemonade crisis cohort what happened, and give each of
 * them a personal link to the Tier 1 flavour-swap journey so they can pick Peach Mango instead.
 *
 * CEO 2026-07-30: "we are out of stock of strawberry lemonade but the mixed berry is back in stock
 * so we will ship that until it's back in stock" + wire the existing Tier 1 journey, which offers
 * the alternative flavour.
 *
 * TONE — this is NOT the Mixed Berry win-back. That was a celebration to people who had left. This
 * goes to ACTIVE subscribers whose flavour we changed without asking. It leads with what we did and
 * what it means for their next box, and the choice is genuinely optional — the default already
 * works, so the email must not manufacture urgency about a decision they don't have to make.
 *
 * THE JOURNEY
 * `crisis-tier1-flavor-swap` (trigger_intent `crisis_tier1`) reads the crisis's
 * `available_flavor_swaps` — now Peach Mango only, since Mixed Berry IS the default swap and
 * offering it alongside "Keep Mixed Berry" was a duplicate option. One session per customer, its
 * own token, resolved at /journey/{token}: the link IS the authentication, no login.
 *
 *   npx tsx scripts/sl-crisis-notify.ts                               # dry run
 *   npx tsx scripts/sl-crisis-notify.ts --test-to dylan@superfoodscompany.com
 *   npx tsx scripts/sl-crisis-notify.ts --apply --limit 10            # canary
 *   npx tsx scripts/sl-crisis-notify.ts --apply                       # the rest
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { errText } from "../src/lib/error-text";
import { generateJourneyToken, getJourneyUrl } from "../src/lib/journey-tokens";
import { shellHtml, getBrand } from "../src/lib/email-storefront";

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const JOURNEY_SLUG = "crisis-tier1-flavor-swap";
const PRODUCT_ID = "221d272d-a6c5-4a5d-86ff-ac693926c992";
const MB_SKU = "SC-TABS-BERRY";
const TOKEN_TTL_DAYS = 60;

const APPLY = process.argv.includes("--apply");
const TEST_TO = (() => { const i = process.argv.indexOf("--test-to"); return i > -1 ? process.argv[i + 1] : null; })();
const LIMIT = (() => { const i = process.argv.indexOf("--limit"); return i > -1 ? Math.max(1, Number(process.argv[i + 1])) : Infinity; })();

function esc(v: string) {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function loadCreative(admin: any) {
  const { data: variant } = await admin.from("product_variants")
    .select("image_url").eq("product_id", PRODUCT_ID).eq("sku", MB_SKU).maybeSingle();
  const { data: reviews } = await admin.from("product_reviews")
    .select("reviewer_name, rating, title, body, smart_quote, verified_purchase")
    .eq("product_id", PRODUCT_ID).eq("rating", 5).eq("status", "published")
    .or("body.ilike.%mixed berry%,body.ilike.%berry%")
    .order("verified_purchase", { ascending: false, nullsFirst: false })
    .limit(10);
  // These people are about to receive Mixed Berry for the first time — pick reviews that reassure
  // them the substitute is good, not reviews about missing the product.
  const best = (reviews || [])
    .filter((r: any) => String(r.body || "").length > 80)
    .slice(0, 2);
  return { imageUrl: (variant?.image_url as string | null) || null, reviews: best };
}

function renderEmail(firstName: string | null, journeyUrl: string, creative: { imageUrl: string | null; reviews: any[] }) {
  const hi = firstName ? `Hi ${firstName},` : "Hi there,";
  const text = [
    hi,
    "",
    "Strawberry Lemonade is temporarily out of stock — we expect it back in early November.",
    "",
    "So your next box doesn't slip, we've switched your subscription to Mixed Berry, which is back in stock and shipping now. Your price is unchanged, and when Strawberry Lemonade returns we'll switch you back automatically. You don't need to do anything.",
    "",
    "If you'd rather have Peach Mango in the meantime, you can pick it here:",
    "",
    journeyUrl,
    "",
    "— The Superfoods Company team",
  ].join("\n");

  const hero = creative.imageUrl
    ? `<tr><td style="padding:0;"><img src="${creative.imageUrl}" width="600" alt="Superfood Tabs — Mixed Berry" style="display:block;width:100%;max-width:600px;height:auto;border:0;" /></td></tr>`
    : "";

  const reviewCards = creative.reviews.map((rv) => {
    const rating = Math.max(0, Math.min(5, rv.rating || 5));
    const stars = "★★★★★".slice(0, rating) + "☆☆☆☆☆".slice(0, 5 - rating);
    const body = String(rv.smart_quote || rv.body || "").trim().slice(0, 240);
    const who = String(rv.reviewer_name || "").trim() || "A verified customer";
    const badge = rv.verified_purchase ? ' <span style="color:#71717a;font-size:11px;">· verified buyer</span>' : "";
    return `
      <tr><td class="sx-pad" style="padding:8px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafafa;border-radius:8px;">
          <tr><td style="padding:16px 18px;">
            <div style="color:#eab308;font-size:14px;letter-spacing:2px;">${stars}</div>
            <div class="sx-review-body" style="font-size:14px;color:#27272a;line-height:1.55;margin-top:6px;">${esc(body)}</div>
            <div style="font-size:12px;color:#52525b;margin-top:8px;">— ${esc(who)}${badge}</div>
          </td></tr>
        </table>
      </td></tr>`;
  }).join("");

  const bodyHtml = `
      ${hero}
      <tr><td class="sx-pad" style="padding:28px 32px 0 32px;">
        <div class="sx-h1" style="font-size:24px;font-weight:800;color:#18181b;line-height:1.3;">Strawberry Lemonade is out of stock — your next box is covered</div>
      </td></tr>
      <tr><td class="sx-pad" style="padding:12px 32px 0 32px;">
        <div class="sx-body" style="font-size:15px;color:#27272a;line-height:1.6;">${esc(hi)}</div>
        <div class="sx-body" style="font-size:15px;color:#27272a;line-height:1.6;margin-top:10px;">
          Strawberry Lemonade is temporarily out of stock — we expect it back in <strong>early November</strong>.
        </div>
        <div class="sx-body" style="font-size:15px;color:#27272a;line-height:1.6;margin-top:10px;">
          So your next box doesn't slip, we've switched you to <strong>Mixed Berry</strong> — which is back in stock and shipping now. Your price is unchanged, and when Strawberry Lemonade returns <strong>we'll switch you back automatically</strong>. You don't need to do anything.
        </div>
      </td></tr>
      <tr><td class="sx-pad" style="padding:22px 32px 0 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafafa;border-radius:8px;">
          <tr><td style="padding:18px 20px;">
            <div style="font-size:15px;font-weight:700;color:#18181b;">Prefer Peach Mango instead?</div>
            <div style="font-size:14px;color:#3f3f46;line-height:1.55;margin-top:6px;">Mixed Berry is our closest match, but Peach Mango is there if you'd rather. Takes one click.</div>
            <div style="margin-top:14px;">
              <a href="${journeyUrl}" style="background:#18181b;color:#ffffff;text-decoration:none;padding:13px 26px;border-radius:8px;display:inline-block;font-weight:700;font-size:15px;">Choose my flavor</a>
            </div>
          </td></tr>
        </table>
      </td></tr>
      ${reviewCards ? `<tr><td class="sx-pad" style="padding:22px 32px 2px 32px;"><div style="font-size:13px;font-weight:700;color:#52525b;letter-spacing:.4px;text-transform:uppercase;">On Mixed Berry</div></td></tr>` : ""}
      ${reviewCards}
      <tr><td class="sx-pad" style="padding:20px 32px 28px 32px;">
        <div style="font-size:12px;color:#71717a;line-height:1.5;">Change or cancel any time. — The Superfoods Company team</div>
      </td></tr>`;

  return {
    subject: "Strawberry Lemonade is out of stock — here's what we did",
    preheader: "We switched you to Mixed Berry so your next box ships on time. Prefer Peach Mango? One click.",
    text, bodyHtml,
  };
}

async function main() {
  const admin = createAdminClient() as any;
  console.log(APPLY ? "🔥 APPLYING" : TEST_TO ? "✉️  TEST SEND" : "🔍 DRY RUN");
  const brand = await getBrand(W, "superfoodscompany.com");
  const creative = await loadCreative(admin);
  console.log(`creative: hero=${creative.imageUrl ? "yes" : "MISSING"} · reviews=${creative.reviews.length}`);

  const { data: jdef } = await admin.from("journey_definitions")
    .select("id, slug, is_active").eq("workspace_id", W).eq("slug", JOURNEY_SLUG).maybeSingle();
  if (!jdef) throw new Error(`journey ${JOURNEY_SLUG} not found`);
  console.log(`journey: ${jdef.slug} (${jdef.is_active ? "active" : "inactive"})`);

  const { data: crisis } = await admin.from("crisis_events")
    .select("id, name, available_flavor_swaps, default_swap_title")
    .eq("workspace_id", W).eq("status", "active").ilike("name", "%Strawberry Lemonade%").maybeSingle();
  if (!crisis) throw new Error("no active Strawberry Lemonade crisis");
  console.log(`crisis: default swap ${crisis.default_swap_title} · alternatives ${JSON.stringify(crisis.available_flavor_swaps)}`);

  const { data: actions } = await admin.from("crisis_customer_actions")
    .select("id, customer_id, subscription_id").eq("crisis_id", crisis.id);
  const audience: { id: string; email: string; first_name: string | null; subscription_id: string | null }[] = [];
  for (const a of actions || []) {
    // Only people whose subscription is still LIVE — a cancelled sub has nothing to re-flavour.
    const { data: sub } = await admin.from("subscriptions")
      .select("status").eq("id", a.subscription_id).maybeSingle();
    if (!sub || !["active", "paused"].includes(sub.status)) continue;
    const { data: cust } = await admin.from("customers").select("id, email, first_name").eq("id", a.customer_id).maybeSingle();
    if (!cust?.email) continue;
    audience.push({ ...cust, subscription_id: a.subscription_id });
  }
  console.log(`\nenrolled: ${actions?.length ?? 0} · emailable (live sub + email): ${audience.length}`);

  const { sendCampaignEmailAsTicket } = await import("./_campaign-send");

  if (TEST_TO) {
    const preview = renderEmail("Dylan", getJourneyUrl("EXAMPLE-TOKEN-not-a-real-session"), creative);
    const html = await shellHtml({ title: preview.subject, preheader: preview.preheader, bodyHtml: preview.bodyHtml, brand });
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
    return;
  }

  if (!APPLY) {
    const preview = renderEmail("Sarah", getJourneyUrl("EXAMPLE-TOKEN"), creative);
    console.log(`\nsubject: ${preview.subject}\n`);
    console.log(preview.text);
    console.log(`\nWould mint ${Math.min(audience.length, LIMIT === Infinity ? audience.length : LIMIT)} Tier-1 sessions + send.`);
    return;
  }

  const slice = audience.slice(0, LIMIT === Infinity ? audience.length : LIMIT);
  let sent = 0; const failures: { email: string; error: string }[] = [];
  for (const cust of slice) {
    try {
      // Idempotency, scoped to THIS CAMPAIGN. Two bugs found on the first run:
      //  (a) keying only on (journey_id, customer_id, pending) meant a stale OPEN session from the
      //      RESOLVED Mixed Berry crisis — same crisis-tier1 journey — blocked the send. 22 customers
      //      were switched to Mixed Berry and never told.
      //  (b) `.maybeSingle()` ERRORS when a customer has more than one pending row, and the error was
      //      discarded, so `open` came back null and a duplicate was minted. One customer got 3 emails.
      // Filter on the campaign source and take the first row rather than asserting singularity.
      const { data: openRows, error: openErr } = await admin.from("journey_sessions")
        .select("id, config_snapshot").eq("workspace_id", W).eq("journey_id", jdef.id)
        .eq("customer_id", cust.id).eq("status", "pending").limit(20);
      if (openErr) { failures.push({ email: cust.email, error: `idempotency read: ${openErr.message}` }); continue; }
      const sameCampaign = (openRows || []).some((r: any) => r.config_snapshot?.source === "sl-crisis-notify");
      if (sameCampaign) { console.log(`  · ${cust.email} already emailed for this campaign — skipped`); continue; }

      const token = generateJourneyToken();
      const { error: sErr } = await admin.from("journey_sessions").insert({
        workspace_id: W, journey_id: jdef.id, customer_id: cust.id, subscription_id: cust.subscription_id,
        token, token_expires_at: new Date(Date.now() + TOKEN_TTL_DAYS * 864e5).toISOString(),
        status: "pending", current_step: 0, responses: {},
        config_snapshot: { source: "sl-crisis-notify", crisis_id: crisis.id },
      });
      if (sErr) { failures.push({ email: cust.email, error: `session: ${sErr.message}` }); continue; }

      const mail = renderEmail(cust.first_name, getJourneyUrl(token), creative);
      const html = await shellHtml({ title: mail.subject, preheader: mail.preheader, bodyHtml: mail.bodyHtml, brand });
      const r = await sendCampaignEmailAsTicket({
        workspaceId: W, customerId: cust.id, toEmail: cust.email,
        subject: mail.subject, html, text: mail.text,
        tags: ["crisis","crisis:strawberry-lemonade","campaign"], source: "sl-crisis-notify",
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
