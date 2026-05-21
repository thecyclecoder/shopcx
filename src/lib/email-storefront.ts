/**
 * Storefront transactional emails:
 *   - sendOrderConfirmationEmail  — fires from /api/checkout after a
 *     successful order (separate from packing slip, which is printed
 *     by Amplifier; this is the inbox copy)
 *   - sendShippingNotificationEmail — fires from the Amplifier
 *     order.shipped webhook once the warehouse hands the package to
 *     the carrier and we have a tracking number
 *
 * Both are best-effort: failure logs but never blocks the calling
 * pipeline (order creation succeeds even if the inbox email fails;
 * the customer can always read it on the dashboard).
 */
import { getResendClient } from "@/lib/email";
import { createAdminClient } from "@/lib/supabase/admin";

const FROM_NAME = "Superfoods Company";

/**
 * Pull the workspace's storefront branding + transactional messaging
 * config so the email header matches the site and the from/reply-to
 * addresses match what the workspace set in Settings → Transactional
 * Messaging. Defaults: brand name → workspace.name, primary color →
 * neutral zinc, from-local → "orders", reply-to → no-reply@{domain}.
 */
async function getBrand(workspaceId: string, resendDomain: string): Promise<{
  logoUrl: string | null;
  primaryColor: string;
  brandName: string;
  fromEmail: string;
  replyToEmail: string;
}> {
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("name, storefront_logo_url, storefront_primary_color, transactional_from_name, transactional_reply_to_email")
    .eq("id", workspaceId)
    .single();
  const brandName = (ws?.transactional_from_name as string | null) || (ws?.name as string) || FROM_NAME;
  return {
    logoUrl: (ws?.storefront_logo_url as string | null) || null,
    primaryColor: (ws?.storefront_primary_color as string) || "#18181b",
    brandName,
    // From-local is always `orders@`; the domain comes from the
    // workspace's Resend sender config (which already enforces
    // verification + DNS). We don't expose a separate setting for
    // this — the brand uses the same `updates.<brand>.com` (or
    // whatever the workspace set as resend_domain) across all
    // transactional sends.
    fromEmail: `orders@${resendDomain}`,
    replyToEmail: (ws?.transactional_reply_to_email as string | null) || `no-reply@${resendDomain}`,
  };
}

interface OrderLineLike {
  title: string;
  variant_title?: string | null;
  quantity: number;
  unit_price_cents?: number;
  unit_msrp_cents?: number;
  line_total_cents?: number;
  is_gift?: boolean;
  image_url?: string | null;
  sku?: string | null;
}

interface AddressLike {
  first_name?: string;
  last_name?: string;
  address1?: string;
  address2?: string | null;
  city?: string;
  province_code?: string;
  zip?: string;
  country_code?: string;
}

interface OrderForEmail {
  id: string;
  order_number: string;
  email: string;
  total_cents: number;
  line_items: OrderLineLike[];
  shipping_address?: AddressLike | null;
  shipping_method_code?: string | null;
  payment_details?: { subtotal_cents?: number; shipping_cents?: number; tax_cents?: number; protection_cents?: number } | null;
  shipping_protection_added?: boolean;
  shipping_protection_amount_cents?: number | null;
  amplifier_tracking_number?: string | null;
  amplifier_carrier?: string | null;
  subscription_id?: string | null;
}

function fmtCents(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
}

function formatAddress(a: AddressLike | null | undefined): string {
  if (!a) return "";
  const lines = [
    [a.first_name, a.last_name].filter(Boolean).join(" "),
    a.address1,
    a.address2 || "",
    [a.city, a.province_code, a.zip].filter(Boolean).join(", "),
  ].filter((s): s is string => !!s && s.trim().length > 0);
  return lines.map(escapeHtml).join("<br>");
}

/**
 * Pick one review to spotlight in the order-confirmation email.
 * Strategy:
 *   1. Featured reviews on any of the cart's products (highest tier
 *      of social proof — manually curated).
 *   2. Fall back to 5-star published reviews.
 *   3. Random within the matching pool so the customer doesn't see
 *      the same review on every order.
 *
 * Returns null when the workspace has no usable reviews for these
 * products (don't render the block at all in that case — empty
 * social-proof slot is worse than no slot).
 */
async function pickFeaturedReview(workspaceId: string, productIds: string[]): Promise<{
  reviewer_name: string | null;
  rating: number | null;
  title: string | null;
  body: string | null;
  smart_quote: string | null;
  product_title: string | null;
} | null> {
  if (productIds.length === 0) return null;
  const admin = createAdminClient();
  // Featured first
  const sel = "reviewer_name, rating, title, body, smart_quote, product_id";
  const { data: featured } = await admin
    .from("product_reviews")
    .select(sel)
    .eq("workspace_id", workspaceId)
    .in("product_id", productIds)
    .eq("featured", true)
    .not("body", "is", null)
    .limit(20);
  let pool: typeof featured = featured || [];
  // Fallback to 5-star published if nothing featured
  if (pool.length === 0) {
    const { data: fiveStar } = await admin
      .from("product_reviews")
      .select(sel)
      .eq("workspace_id", workspaceId)
      .in("product_id", productIds)
      .in("status", ["published", "featured"])
      .eq("rating", 5)
      .not("body", "is", null)
      .limit(50);
    pool = fiveStar || [];
  }
  if (pool.length === 0) return null;
  const picked = pool[Math.floor(Math.random() * pool.length)];
  // Look up product title for attribution ("on Amazing Coffee").
  const { data: prod } = await admin
    .from("products")
    .select("title")
    .eq("id", picked.product_id)
    .maybeSingle();
  return {
    reviewer_name: picked.reviewer_name,
    rating: picked.rating,
    title: picked.title,
    body: picked.body,
    smart_quote: picked.smart_quote,
    product_title: (prod?.title as string | null) || null,
  };
}

function renderReviewBlock(review: NonNullable<Awaited<ReturnType<typeof pickFeaturedReview>>>): string {
  const rating = Math.max(0, Math.min(5, review.rating || 5));
  const stars = "★★★★★".slice(0, rating) + "☆☆☆☆☆".slice(0, 5 - rating);
  // Always render the FULL review body — smart_quote (AI excerpt)
  // is reserved for spaces where length is tight; the email has
  // room for the whole thing and customers deserve to read it.
  const text = (review.body || "").trim();
  const reviewer = (review.reviewer_name || "").trim() || "A verified customer";
  const productLine = review.product_title
    ? ` · <span style="color:#71717a;">on ${escapeHtml(review.product_title)}</span>`
    : "";
  return `
      <tr><td style="padding:16px 32px 8px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafafa;border-radius:8px;">
          <tr><td style="padding:18px 20px;">
            <div style="color:#eab308;font-size:15px;letter-spacing:2px;">${stars}</div>
            ${review.title ? `<div style="font-size:15px;font-weight:700;color:#18181b;margin-top:6px;">${escapeHtml(review.title)}</div>` : ""}
            <div style="font-size:14px;color:#27272a;line-height:1.55;margin-top:6px;white-space:pre-wrap;">${escapeHtml(text)}</div>
            <div style="font-size:12px;color:#52525b;margin-top:8px;">— ${escapeHtml(reviewer)}${productLine}</div>
          </td></tr>
        </table>
      </td></tr>`;
}

function trackingUrl(carrier: string | null | undefined, trackingNumber: string): string | null {
  if (!trackingNumber) return null;
  const c = (carrier || "").toLowerCase();
  // Carrier strings come from Amplifier's `method` field — best effort.
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber)}`;
  if (c.includes("usps")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?tracknumbers=${encodeURIComponent(trackingNumber)}`;
  if (c.includes("dhl")) return `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(trackingNumber)}`;
  // Default: Google-search redirect (works for any carrier the customer eyeballs).
  return `https://www.google.com/search?q=${encodeURIComponent(trackingNumber)}+tracking`;
}

function renderLineItemsRows(lines: OrderLineLike[]): string {
  return lines
    .map((l) => {
      const title = escapeHtml(l.title);
      const variant = l.variant_title && l.variant_title !== "Default Title" ? ` — ${escapeHtml(l.variant_title)}` : "";
      const giftBadge = l.is_gift
        ? ` <span style="display:inline-block;padding:2px 6px;background:#dcfce7;color:#166534;font-size:11px;border-radius:4px;font-weight:600;margin-left:4px;">FREE GIFT</span>`
        : "";
      const paidLine = (l.line_total_cents ?? (l.unit_price_cents || 0) * l.quantity) || 0;
      const msrpLine = (l.unit_msrp_cents || l.unit_price_cents || 0) * l.quantity;
      // Strikethrough MSRP whenever the customer paid less than MSRP
      // — same treatment as the storefront cart so the savings are
      // visible at every step (cart → checkout → email).
      const priceCell = l.is_gift
        ? `<div style="color:#a1a1aa;text-decoration:line-through;font-size:13px;">${fmtCents(msrpLine)}</div><div style="color:#16a34a;font-weight:600;">Free</div>`
        : msrpLine > paidLine
          ? `<div style="font-weight:600;">${fmtCents(paidLine)}</div><div style="color:#a1a1aa;text-decoration:line-through;font-size:13px;">${fmtCents(msrpLine)}</div>`
          : `<div style="font-weight:600;">${fmtCents(paidLine)}</div>`;
      const img = l.image_url
        ? `<img src="${escapeHtml(l.image_url)}" alt="" width="56" height="56" style="display:block;border-radius:6px;object-fit:cover;" />`
        : `<div style="width:56px;height:56px;background:#f4f4f5;border-radius:6px;"></div>`;
      return `
        <tr>
          <td style="padding:8px 0;width:64px;vertical-align:top;">${img}</td>
          <td style="padding:8px 0 8px 12px;vertical-align:top;font-size:14px;color:#18181b;">
            <div style="font-weight:600;">${title}${variant}${giftBadge}</div>
            <div style="color:#71717a;font-size:13px;margin-top:2px;">Qty ${l.quantity}</div>
          </td>
          <td style="padding:8px 0;text-align:right;vertical-align:top;font-size:14px;color:#18181b;">${priceCell}</td>
        </tr>`;
    })
    .join("");
}

function shellHtml(opts: {
  title: string;
  preheader: string;
  bodyHtml: string;
  brand: { logoUrl: string | null; primaryColor: string; brandName: string };
}): string {
  // Logo header row — render the workspace's storefront_logo_url when
  // configured, otherwise fall back to the brand name in the workspace
  // primary color. Many inbox renderers (Gmail, Outlook) block external
  // images by default, so we always set an alt text to the brand name.
  // Logo rendering — the user reported blurry output when we let the
  // email client downsample a large source image (their 1650×810 WebP
  // was being scaled down with poor filtering in some clients). Two
  // fixes layered:
  //   1. Append Supabase Storage's image-transform `?width=560` so the
  //      CDN returns a pre-resized PNG (~2x the 280px display target,
  //      crisp on retina). Falls back to the raw URL for non-Supabase
  //      logos.
  //   2. Set explicit width="280" + height calculated to preserve the
  //      ~2:1 brand-mark aspect ratio. Email clients respect the width
  //      attr and downsample more carefully when they have a target.
  // Rewrite Supabase /object/public/ to /render/image/public/ so the
  // CDN runs server-side resize + format conversion (WebP → PNG with
  // broader email-client support). Falls through unchanged for any
  // non-Supabase logo host.
  function transformLogoUrl(url: string): string {
    if (!url.includes("supabase.co/storage/v1/object/public/")) return url;
    const rendered = url.replace("/storage/v1/object/public/", "/storage/v1/render/image/public/");
    const sep = rendered.includes("?") ? "&" : "?";
    return `${rendered}${sep}width=560`;
  }
  // Hard-pin width (no percentage, no max-width). Some clients —
  // Apple Mail full-screen in particular — ignore max-width on
  // images and combine width:100% with the parent cell's actual
  // rendered width (not the 600px table max-width), which makes the
  // logo overflow at 1000+ px. A fixed pixel width is the only thing
  // every client respects.
  const logoRow = opts.brand.logoUrl
    ? `<img src="${escapeHtml(transformLogoUrl(opts.brand.logoUrl))}" alt="${escapeHtml(opts.brand.brandName)}" width="240" height="auto" style="display:block;width:240px;height:auto;border:0;outline:none;" />`
    : `<div style="font-size:18px;font-weight:700;color:${escapeHtml(opts.brand.primaryColor)};">${escapeHtml(opts.brand.brandName)}</div>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>${escapeHtml(opts.title)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b;">
<div style="display:none;font-size:1px;color:#f4f4f5;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(opts.preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f4f5;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;">
      <tr><td style="padding:24px 32px 0 32px;border-bottom:1px solid #f4f4f5;">
        ${logoRow}
      </td></tr>
      ${opts.bodyHtml}
    </table>
  </td></tr>
</table>
</body></html>`;
}

export async function sendOrderConfirmationEmail(opts: {
  workspaceId: string;
  order: OrderForEmail;
  isFirstOrder: boolean;
  subscribing: boolean;
  nextBillingDate?: string | null;
  /** Personal note from the founder — same message that prints on the
   *  packing slip. Wraps in a styled blockquote with attribution. */
  founderNote?: string | null;
  /** What the customer WOULD have paid for shipping had they checked
   *  out as a one-time shopper. Used for the strikethrough → Free
   *  treatment on subscribing orders. When omitted we don't show a
   *  strikethrough. */
  shippingValueCents?: number | null;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const client = await getResendClient(opts.workspaceId, opts.order.email);
    if (!client) return { success: false, error: "resend_not_configured_or_blocked" };
    const { order, isFirstOrder, subscribing, nextBillingDate } = opts;

    const firstName = order.shipping_address?.first_name || "there";
    const subtotalCents = order.payment_details?.subtotal_cents ?? order.line_items.reduce((s, l) => s + (l.line_total_cents ?? (l.unit_price_cents || 0) * l.quantity), 0);
    const shippingCents = order.payment_details?.shipping_cents ?? 0;
    const taxCents = order.payment_details?.tax_cents ?? 0;
    // Protection is rolled into total but NOT broken out as a row —
    // it appears as a green-check badge below the totals instead.
    const nextBillingPretty = nextBillingDate
      ? new Date(nextBillingDate).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })
      : null;

    // ── Savings math (mirror of storefront cart) ─────────────────
    // MSRP subtotal includes gift "value" (gift has unit_msrp_cents
    // but unit_price=0) so the gift counts toward "you save". A line
    // with no unit_msrp falls back to its paid price (no savings).
    const msrpSubtotalCents = order.line_items.reduce((s, l) => {
      const msrpLine = (l.unit_msrp_cents || l.unit_price_cents || 0) * l.quantity;
      return s + msrpLine;
    }, 0);
    const discountCents = Math.max(0, msrpSubtotalCents - subtotalCents);
    const shippingValueCents = opts.shippingValueCents ?? 0;
    const shippingSavedCents = Math.max(0, shippingValueCents - shippingCents);
    const youSaveCents = discountCents + shippingSavedCents;

    const lineRows = renderLineItemsRows(order.line_items);
    const ship = order.shipping_address;
    const welcome = isFirstOrder
      ? `Welcome to the Superfoods family, ${escapeHtml(firstName)}! `
      : `Thanks ${escapeHtml(firstName)}, `;

    // Pick a featured review on one of the products the customer
    // bought (excluding gifts so the social proof is about something
    // they actually paid for). Random within the qualifying pool so
    // repeat customers see a different review each time.
    const reviewProductIds = Array.from(new Set(
      order.line_items
        .filter((l) => !l.is_gift)
        .map((l) => (l as unknown as { product_id?: string }).product_id)
        .filter((id): id is string => !!id),
    ));
    const featuredReview = await pickFeaturedReview(opts.workspaceId, reviewProductIds);
    const reviewBlock = featuredReview ? renderReviewBlock(featuredReview) : "";
    const protectionBadge = order.shipping_protection_added
      ? `
      <tr><td style="padding:0 32px 8px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;">
          <tr>
            <td style="padding:10px 12px;width:24px;vertical-align:middle;">
              <span style="display:inline-block;width:18px;height:18px;background:#16a34a;border-radius:50%;color:#fff;text-align:center;line-height:18px;font-size:12px;font-weight:700;">✓</span>
            </td>
            <td style="padding:10px 12px 10px 0;vertical-align:middle;font-size:13px;color:#166534;">
              <strong style="color:#14532d;">Shipping protection included</strong> · This order is protected from loss, damage or theft.
            </td>
          </tr>
        </table>
      </td></tr>` : "";

    const bodyHtml = `
      <tr><td style="padding:32px 32px 16px 32px;">
        <div style="font-size:13px;color:#71717a;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">Order ${escapeHtml(order.order_number)}</div>
        <h1 style="margin:8px 0 12px 0;font-size:24px;color:#18181b;font-weight:700;">Order confirmed</h1>
        <p style="margin:0;color:#52525b;font-size:15px;line-height:1.55;">
          ${welcome}we received your order and we're getting it ready to ship. We'll send you tracking as soon as it leaves our warehouse.
        </p>
      </td></tr>

      <tr><td style="padding:8px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid #e4e4e7;border-bottom:1px solid #e4e4e7;">
          ${lineRows}
        </table>
      </td></tr>

      ${reviewBlock}

      <tr><td style="padding:16px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;color:#52525b;">
          <tr><td style="padding:4px 0;">Subtotal</td><td style="padding:4px 0;text-align:right;color:#18181b;">${fmtCents(msrpSubtotalCents)}</td></tr>
          ${discountCents > 0 ? `<tr><td style="padding:4px 0;color:#15803d;">Discount</td><td style="padding:4px 0;text-align:right;color:#15803d;">-${fmtCents(discountCents)}</td></tr>` : ""}
          <tr><td style="padding:4px 0;">Shipping</td><td style="padding:4px 0;text-align:right;color:#18181b;">${
            shippingCents === 0 && shippingValueCents > 0
              ? `<span style="color:#a1a1aa;text-decoration:line-through;margin-right:6px;">${fmtCents(shippingValueCents)}</span><span style="color:#16a34a;font-weight:600;">Free</span>`
              : shippingCents === 0
                ? '<span style="color:#16a34a;font-weight:600;">Free</span>'
                : fmtCents(shippingCents)
          }</td></tr>
          ${taxCents > 0 ? `<tr><td style="padding:4px 0;">Tax</td><td style="padding:4px 0;text-align:right;color:#18181b;">${fmtCents(taxCents)}</td></tr>` : ""}
          <tr><td style="padding:8px 0 4px 0;border-top:1px solid #e4e4e7;font-weight:700;color:#18181b;">Total</td><td style="padding:8px 0 4px 0;border-top:1px solid #e4e4e7;text-align:right;font-weight:700;color:#18181b;">${fmtCents(order.total_cents)}</td></tr>
          ${youSaveCents > 0 ? `<tr><td colspan="2" style="padding:10px 0 0 0;text-align:right;">
            <span style="display:inline-block;background:#dcfce7;color:#166534;padding:6px 12px;border-radius:999px;font-size:13px;font-weight:700;">You saved ${fmtCents(youSaveCents)}</span>
          </td></tr>` : ""}
        </table>
      </td></tr>

      ${protectionBadge}

      ${subscribing && nextBillingPretty ? `
      <tr><td style="padding:8px 32px 16px 32px;">
        <div style="background:#f4f4f5;border-radius:8px;padding:14px 16px;font-size:14px;color:#3f3f46;">
          <strong style="color:#18181b;">Your subscription is active.</strong> Your next delivery will charge on <strong>${escapeHtml(nextBillingPretty)}</strong>. Cancel or change it anytime from your account.
        </div>
      </td></tr>` : ""}

      ${ship ? `
      <tr><td style="padding:8px 32px 16px 32px;">
        <div style="font-size:13px;color:#71717a;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;margin-bottom:8px;">Shipping to</div>
        <div style="font-size:14px;color:#18181b;line-height:1.6;">${formatAddress(ship)}</div>
      </td></tr>` : ""}

      ${opts.founderNote ? `
      <tr><td style="padding:16px 32px 24px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafafa;border-left:3px solid #18181b;border-radius:4px;">
          <tr><td style="padding:18px 20px;font-size:15px;color:#27272a;line-height:1.65;font-style:italic;">
            ${escapeHtml(opts.founderNote)}
          </td></tr>
        </table>
      </td></tr>` : ""}

      <tr><td style="padding:20px 32px;border-top:1px solid #e4e4e7;text-align:center;font-size:13px;color:#71717a;line-height:1.6;">
        — The Superfoods Company team
      </td></tr>
    `;

    const brand = await getBrand(opts.workspaceId, client.domain);
    const html = shellHtml({
      title: `Order confirmation — ${order.order_number}`,
      preheader: `Your order ${order.order_number} is confirmed. We'll send tracking once it ships.`,
      bodyHtml,
      brand,
    });

    const { error } = await client.resend.emails.send({
      from: `${brand.brandName} <${brand.fromEmail}>`,
      to: order.email,
      // Reply-to is workspace-configured (Settings → Transactional
      // Messaging). Defaults to no-reply@{domain}; the workspace
      // has an autoresponder there that deflects "cancel my order"
      // replies back to the account portal.
      replyTo: brand.replyToEmail,
      subject: `Order confirmed — ${order.order_number}`,
      html,
    });
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendShippingNotificationEmail(opts: {
  workspaceId: string;
  order: OrderForEmail;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const { order } = opts;
    if (!order.amplifier_tracking_number) {
      return { success: false, error: "no_tracking_number" };
    }
    const client = await getResendClient(opts.workspaceId, order.email);
    if (!client) return { success: false, error: "resend_not_configured_or_blocked" };

    const firstName = order.shipping_address?.first_name || "there";
    const carrier = order.amplifier_carrier || "the carrier";
    const tracking = order.amplifier_tracking_number;
    const tUrl = trackingUrl(order.amplifier_carrier, tracking);
    const lineRows = renderLineItemsRows(order.line_items);
    const ship = order.shipping_address;
    const protectionBadge = order.shipping_protection_added
      ? `
      <tr><td style="padding:0 32px 8px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;">
          <tr>
            <td style="padding:10px 12px;width:24px;vertical-align:middle;">
              <span style="display:inline-block;width:18px;height:18px;background:#16a34a;border-radius:50%;color:#fff;text-align:center;line-height:18px;font-size:12px;font-weight:700;">✓</span>
            </td>
            <td style="padding:10px 12px 10px 0;vertical-align:middle;font-size:13px;color:#166534;">
              <strong style="color:#14532d;">Shipping protection included</strong> · If your package is lost, damaged, or stolen in transit, just let us know.
            </td>
          </tr>
        </table>
      </td></tr>` : "";

    const ctaButton = tUrl
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px 0;"><tr><td bgcolor="#0f766e" style="background-color:#0f766e;border-radius:8px;"><a href="${tUrl}" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">Track your package →</a></td></tr></table>`
      : "";

    const bodyHtml = `
      <tr><td style="padding:32px 32px 16px 32px;">
        <div style="font-size:13px;color:#71717a;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">Order ${escapeHtml(order.order_number)}</div>
        <h1 style="margin:8px 0 12px 0;font-size:24px;color:#18181b;font-weight:700;">Your order is on its way</h1>
        <p style="margin:0 0 16px 0;color:#52525b;font-size:15px;line-height:1.55;">
          Hey ${escapeHtml(firstName)}, your order just shipped via ${escapeHtml(carrier)}.
        </p>
        ${ctaButton}
        <div style="font-size:13px;color:#71717a;">Tracking number: <span style="font-family:monospace;color:#18181b;">${escapeHtml(tracking)}</span></div>
      </td></tr>

      <tr><td style="padding:8px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid #e4e4e7;border-bottom:1px solid #e4e4e7;">
          ${lineRows}
        </table>
      </td></tr>

      ${protectionBadge}

      ${ship ? `
      <tr><td style="padding:16px 32px 24px 32px;">
        <div style="font-size:13px;color:#71717a;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;margin-bottom:8px;">Shipping to</div>
        <div style="font-size:14px;color:#18181b;line-height:1.6;">${formatAddress(ship)}</div>
      </td></tr>` : ""}

      <tr><td style="padding:24px 32px;border-top:1px solid #e4e4e7;text-align:center;font-size:13px;color:#71717a;line-height:1.6;">
        Questions? Just reply to this email.<br>
        — The Superfoods Company team
      </td></tr>
    `;

    const brand = await getBrand(opts.workspaceId, client.domain);
    const html = shellHtml({
      title: `Your order ${order.order_number} has shipped`,
      preheader: `Tracking ${tracking} — your order is on its way.`,
      bodyHtml,
      brand,
    });

    const { error } = await client.resend.emails.send({
      from: `${brand.brandName} <${brand.fromEmail}>`,
      to: order.email,
      replyTo: brand.replyToEmail,
      subject: `Your order is on its way — ${order.order_number}`,
      html,
    });
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
