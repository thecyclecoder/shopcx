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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Drop non-UUID line-item product_ids before they reach the reviews
 * query's `.in('product_id', …)` filter. Shipping Protection carries a
 * Shopify NUMERIC product id (7634377900205), and a single non-UUID
 * value makes Postgres raise 22P02 for the WHOLE query — dropping the
 * social-proof block for every valid product in the same order.
 * Non-reviewable line items (Shipping Protection, gifts, anything with
 * a Shopify id in that field) are silently excluded; there is nothing
 * to resolve them to.
 */
export function uuidLineItemProductIds(ids: ReadonlyArray<string | null | undefined>): string[] {
  return ids.filter((id): id is string => typeof id === "string" && UUID_RE.test(id));
}

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

export interface OrderLineLike {
  title: string;
  variant_title?: string | null;
  quantity: number;
  unit_price_cents?: number;
  /** Subscription/renewal line items carry the unit price as `price_cents`. */
  price_cents?: number;
  unit_msrp_cents?: number;
  line_total_cents?: number;
  is_gift?: boolean;
  image_url?: string | null;
  sku?: string | null;
  product_id?: string | null;
}

export interface AddressLike {
  first_name?: string;
  last_name?: string;
  address1?: string;
  address2?: string | null;
  city?: string;
  province_code?: string;
  zip?: string;
  country_code?: string;
}

export interface OrderForEmail {
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
  // Defense-in-depth: strip any non-UUID id before it reaches the UUID
  // column filter (see uuidLineItemProductIds — a single Shopify-id
  // value 22P02s the WHOLE query and silently drops the block).
  const uuidIds = uuidLineItemProductIds(productIds);
  if (uuidIds.length === 0) return null;
  const admin = createAdminClient();
  // Featured first
  const sel = "reviewer_name, rating, title, body, smart_quote, product_id";
  const { data: featured } = await admin
    .from("product_reviews")
    .select(sel)
    .eq("workspace_id", workspaceId)
    .in("product_id", uuidIds)
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
      .in("product_id", uuidIds)
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
      <tr><td class="sx-pad" style="padding:16px 32px 8px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafafa;border-radius:8px;">
          <tr><td style="padding:18px 20px;">
            <div style="color:#eab308;font-size:15px;letter-spacing:2px;">${stars}</div>
            ${review.title ? `<div style="font-size:15px;font-weight:700;color:#18181b;margin-top:6px;">${escapeHtml(review.title)}</div>` : ""}
            <div class="sx-review-body" style="font-size:14px;color:#27272a;line-height:1.55;margin-top:6px;white-space:pre-wrap;">${escapeHtml(text)}</div>
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
      // Use || (not ??) so a stored line_total_cents of 0 — common on
      // renewal/Amplifier orders — falls back to unit × qty instead of
      // rendering $0.00. Renewal items carry the unit as price_cents.
      const unitCents = l.unit_price_cents || l.price_cents || 0;
      const paidLine = l.line_total_cents || unitCents * l.quantity;
      const msrpLine = (l.unit_msrp_cents || unitCents) * l.quantity;
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
            <div class="sx-line-title" style="font-weight:600;">${title}${variant}${giftBadge}</div>
            <div class="sx-line-meta" style="color:#71717a;font-size:13px;margin-top:2px;">Qty ${l.quantity}</div>
          </td>
          <td class="sx-line-price" style="padding:8px 0;text-align:right;vertical-align:top;font-size:14px;color:#18181b;">${priceCell}</td>
        </tr>`;
    })
    .join("");
}

/**
 * Totals + savings block — subtotal (at MSRP) → discount → shipping (free /
 * strikethrough) → tax → total, plus the green "You saved $X" badge. Shared by
 * the order-confirmation AND shipping emails so both reiterate the savings.
 */
function renderTotalsBlock(order: OrderForEmail, shippingValueCents = 0): string {
  const lineUnit = (l: OrderLineLike) => l.unit_price_cents || l.price_cents || 0;
  const subtotalCents = order.payment_details?.subtotal_cents
    ?? order.line_items.reduce((s, l) => s + (l.line_total_cents || lineUnit(l) * l.quantity), 0);
  const shippingCents = order.payment_details?.shipping_cents ?? 0;
  const taxCents = order.payment_details?.tax_cents ?? 0;
  const msrpSubtotalCents = order.line_items.reduce((s, l) => s + (l.unit_msrp_cents || lineUnit(l)) * l.quantity, 0);
  const discountCents = Math.max(0, msrpSubtotalCents - subtotalCents);
  const shippingSavedCents = Math.max(0, shippingValueCents - shippingCents);
  const youSaveCents = discountCents + shippingSavedCents;
  return `
    <tr><td class="sx-pad" style="padding:16px 32px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="sx-totals" style="font-size:14px;color:#52525b;">
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
    </td></tr>`;
}

/**
 * Probe an image's aspect ratio by fetching the first chunk of the
 * file and parsing the dimensions out of the header. Supports
 * WebP / PNG / JPEG — every format Resend likes to render. Uses an
 * HTTP Range request so we only download ~16KB even if the source
 * is megabytes. Returns null on any parse failure; caller falls back
 * to a sane default.
 */
async function probeImageAspectRatio(url: string): Promise<number | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { headers: { Range: "bytes=0-16383" }, signal: controller.signal });
    clearTimeout(t);
    if (!res.ok && res.status !== 206) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    // PNG: 8-byte sig, then IHDR chunk with width(4)+height(4) at byte 16.
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      const w = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
      const h = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
      if (w > 0 && h > 0) return w / h;
    }
    // WebP container: "RIFF" .. "WEBP", then chunk header.
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57) {
      const chunk = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
      if (chunk === "VP8X") {
        const w = ((buf[24] | (buf[25] << 8) | (buf[26] << 16)) >>> 0) + 1;
        const h = ((buf[27] | (buf[28] << 8) | (buf[29] << 16)) >>> 0) + 1;
        if (w > 0 && h > 0) return w / h;
      } else if (chunk === "VP8 ") {
        const w = ((buf[26] | (buf[27] << 8)) & 0x3fff);
        const h = ((buf[28] | (buf[29] << 8)) & 0x3fff);
        if (w > 0 && h > 0) return w / h;
      } else if (chunk === "VP8L") {
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
        const w = 1 + (((b1 & 0x3f) << 8) | b0);
        const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        if (w > 0 && h > 0) return w / h;
      }
    }
    // JPEG: scan for SOF marker.
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 8) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const sof = marker === 0xc0 || marker === 0xc1 || marker === 0xc2;
        if (sof) {
          const h = (buf[i + 5] << 8) | buf[i + 6];
          const w = (buf[i + 7] << 8) | buf[i + 8];
          if (w > 0 && h > 0) return w / h;
          return null;
        }
        const len = (buf[i + 2] << 8) | buf[i + 3];
        i += 2 + len;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Render the logo row with dimensions calculated from the source's
 * actual aspect ratio. Display height is fixed at 160px; width is
 * height × aspect_ratio. Falls back to height:160 width:auto if the
 * probe fails — works in most clients, just less reliable in Outlook.
 */
async function buildLogoBlock(rawLogoUrl: string, brandName: string): Promise<string> {
  const displayH = 160;
  // Rewrite Supabase /object/public/ to /render/image/public/ + size
  // hints. resize=contain is REQUIRED; without it Supabase center-
  // crops to fill the requested dimension box. Earlier renderings
  // showed only "ERFO / MPAN" because of this.
  let renderUrl = rawLogoUrl;
  let aspect: number | null = await probeImageAspectRatio(rawLogoUrl);
  if (rawLogoUrl.includes("supabase.co/storage/v1/object/public/")) {
    const base = rawLogoUrl.replace("/storage/v1/object/public/", "/storage/v1/render/image/public/");
    const sep = base.includes("?") ? "&" : "?";
    // Ask for 2x retina at the display height.
    renderUrl = `${base}${sep}height=${displayH * 2}&resize=contain`;
  }
  const safeAlt = escapeHtml(brandName);
  if (aspect && aspect > 0) {
    const displayW = Math.round(displayH * aspect);
    return `<img src="${escapeHtml(renderUrl)}" alt="${safeAlt}" width="${displayW}" height="${displayH}" style="display:block;width:${displayW}px;height:${displayH}px;border:0;outline:none;" />`;
  }
  // Fallback when the probe failed — height-locked, width:auto.
  return `<img src="${escapeHtml(renderUrl)}" alt="${safeAlt}" height="${displayH}" style="display:block;height:${displayH}px;width:auto;border:0;outline:none;" />`;
}

async function shellHtml(opts: {
  title: string;
  preheader: string;
  bodyHtml: string;
  brand: { logoUrl: string | null; primaryColor: string; brandName: string };
}): Promise<string> {
  // Logo header row — render the workspace's storefront_logo_url when
  // configured, otherwise fall back to the brand name in the workspace
  // primary color. The logo block is built async (probes source
  // dimensions, generates correctly-sized Supabase render URL).
  // Build the logo row dynamically: probe the source's actual
  // aspect ratio (parsed from the file header — only ~64 bytes
  // needed), compute width from a fixed 160px display height, then
  // ask Supabase for a 2x-retina PNG at exactly those dimensions
  // with resize=contain. Sets BOTH HTML width/height attrs AND
  // CSS — Outlook & older clients need the attrs; modern ones use
  // CSS. Every client gets the correct shape.
  const logoBlock = opts.brand.logoUrl
    ? await buildLogoBlock(opts.brand.logoUrl, opts.brand.brandName)
    : `<div style="font-size:18px;font-weight:700;color:${escapeHtml(opts.brand.primaryColor)};">${escapeHtml(opts.brand.brandName)}</div>`;
  const logoRow = logoBlock;

  // Mobile typography — iOS/Android Mail apps shrink emails to fit
  // the screen if `viewport` isn't set, which makes 14-15px body
  // text look ~9-10px on a 600-px-wide email. Setting the viewport
  // + telling clients NOT to auto-scale means the desktop sizes
  // render at their actual size on mobile. We ALSO bump key text up
  // a notch via a media query so on smaller phones the totals row
  // and review block stay legible.
  return `<!DOCTYPE html><html lang="en"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="color-scheme" content="light" />
  <title>${escapeHtml(opts.title)}</title>
  <style>
    /* Body resets — block Gmail/iOS auto-scaling. */
    body, table, td, p, div, span { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; }
    /* Mobile (phones) — bump body text from 14 to 16, headings
       slightly up, tighten the padding. Width:100% on the email card
       so it fills the viewport instead of leaving white margins. */
    @media only screen and (max-width: 480px) {
      .sx-card { width: 100% !important; max-width: 100% !important; border-radius: 0 !important; }
      .sx-pad { padding-left: 20px !important; padding-right: 20px !important; }
      .sx-body { font-size: 16px !important; line-height: 1.6 !important; }
      .sx-h1 { font-size: 22px !important; }
      .sx-totals td { font-size: 15px !important; padding-top: 6px !important; padding-bottom: 6px !important; }
      .sx-review-body { font-size: 15px !important; }
      .sx-line-title { font-size: 15px !important; }
      .sx-line-meta { font-size: 14px !important; }
      .sx-line-price { font-size: 15px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b;">
<div style="display:none;font-size:1px;color:#f4f4f5;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(opts.preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f4f5;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" class="sx-card" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;">
      <tr><td class="sx-pad" style="padding:24px 32px 0 32px;border-bottom:1px solid #f4f4f5;">
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
}): Promise<{ success: boolean; error?: string; resendEmailId?: string }> {
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
    // Filter to UUID-shaped ids — Shipping Protection's line item
    // carries the Shopify NUMERIC product id and would 22P02 the whole
    // reviews query, dropping the block for every valid product too.
    const reviewProductIds = uuidLineItemProductIds(Array.from(new Set(
      order.line_items
        .filter((l) => !l.is_gift)
        .map((l) => (l as unknown as { product_id?: string }).product_id),
    )));
    const featuredReview = await pickFeaturedReview(opts.workspaceId, reviewProductIds);
    const reviewBlock = featuredReview ? renderReviewBlock(featuredReview) : "";
    const protectionBadge = order.shipping_protection_added
      ? `
      <tr><td class="sx-pad" style="padding:0 32px 8px 32px;">
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
      <tr><td class="sx-pad" style="padding:32px 32px 16px 32px;">
        <div style="font-size:13px;color:#71717a;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">Order ${escapeHtml(order.order_number)}</div>
        <h1 class="sx-h1" style="margin:8px 0 12px 0;font-size:24px;color:#18181b;font-weight:700;">Order confirmed</h1>
        <p class="sx-body" style="margin:0;color:#52525b;font-size:15px;line-height:1.55;">
          ${welcome}we received your order and we're getting it ready to ship. We'll send you tracking as soon as it leaves our warehouse.
        </p>
      </td></tr>

      <tr><td class="sx-pad" style="padding:8px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid #e4e4e7;border-bottom:1px solid #e4e4e7;">
          ${lineRows}
        </table>
      </td></tr>

      ${reviewBlock}

      <tr><td class="sx-pad" style="padding:16px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="sx-totals" style="font-size:14px;color:#52525b;">
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
      <tr><td class="sx-pad" style="padding:8px 32px 16px 32px;">
        <div style="background:#f4f4f5;border-radius:8px;padding:14px 16px;font-size:14px;color:#3f3f46;">
          <strong style="color:#18181b;">Your subscription is active.</strong> Your next delivery will charge on <strong>${escapeHtml(nextBillingPretty)}</strong>. Cancel or change it anytime from your account.
        </div>
      </td></tr>` : ""}

      ${ship ? `
      <tr><td class="sx-pad" style="padding:8px 32px 16px 32px;">
        <div style="font-size:13px;color:#71717a;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;margin-bottom:8px;">Shipping to</div>
        <div style="font-size:14px;color:#18181b;line-height:1.6;">${formatAddress(ship)}</div>
      </td></tr>` : ""}

      ${opts.founderNote ? `
      <tr><td class="sx-pad" style="padding:16px 32px 24px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafafa;border-left:3px solid #18181b;border-radius:4px;">
          <tr><td style="padding:18px 20px;font-size:15px;color:#27272a;line-height:1.65;font-style:italic;">
            ${escapeHtml(opts.founderNote)}
          </td></tr>
        </table>
      </td></tr>` : ""}

      <tr><td class="sx-pad" style="padding:20px 32px;border-top:1px solid #e4e4e7;text-align:center;font-size:13px;color:#71717a;line-height:1.6;">
        — The Superfoods Company team
      </td></tr>
    `;

    const brand = await getBrand(opts.workspaceId, client.domain);
    const html = await shellHtml({
      title: `Order confirmation — ${order.order_number}`,
      preheader: `Your order ${order.order_number} is confirmed. We'll send tracking once it ships.`,
      bodyHtml,
      brand,
    });

    const { data, error } = await client.resend.emails.send({
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
    // Phase 3 — return the Resend id so the queued sender
    // (Phase 4) can stamp `orders.order_confirmation_email_id` +
    // `order_confirmation_sent_at` on the order and drive the
    // Resend-events pipeline (`/api/webhooks/resend-events`).
    return { success: true, resendEmailId: data?.id };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendShippingNotificationEmail(opts: {
  workspaceId: string;
  order: OrderForEmail;
  /** What one-time shipping would have cost — drives the strikethrough → Free
   *  treatment + the shipping-saved portion of "You saved". */
  shippingValueCents?: number | null;
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

    // Mirror the order-confirmation email's review block here too —
    // every customer touchpoint earns a piece of social proof. Pool
    // is workspace-featured reviews on the customer's purchased
    // products; falls back to 5-star published. Random pick so the
    // shipping email doesn't repeat the confirmation's review.
    // Same UUID guard as the confirmation email — a Shipping Protection
    // line item's Shopify-numeric product_id would 22P02 the whole
    // reviews query and silently drop the block.
    const reviewProductIds = uuidLineItemProductIds(Array.from(new Set(
      order.line_items
        .filter((l) => !l.is_gift)
        .map((l) => (l as unknown as { product_id?: string }).product_id),
    )));
    const featuredReview = await pickFeaturedReview(opts.workspaceId, reviewProductIds);
    const reviewBlock = featuredReview ? renderReviewBlock(featuredReview) : "";

    const protectionBadge = order.shipping_protection_added
      ? `
      <tr><td class="sx-pad" style="padding:0 32px 8px 32px;">
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
      <tr><td class="sx-pad" style="padding:32px 32px 16px 32px;">
        <div style="font-size:13px;color:#71717a;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">Order ${escapeHtml(order.order_number)}</div>
        <h1 style="margin:8px 0 12px 0;font-size:24px;color:#18181b;font-weight:700;">Your order is on its way</h1>
        <p style="margin:0 0 16px 0;color:#52525b;font-size:15px;line-height:1.55;">
          Hey ${escapeHtml(firstName)}, your order just shipped via ${escapeHtml(carrier)}.
        </p>
        ${ctaButton}
        <div style="font-size:13px;color:#71717a;">Tracking number: <span style="font-family:monospace;color:#18181b;">${escapeHtml(tracking)}</span></div>
      </td></tr>

      <tr><td class="sx-pad" style="padding:8px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid #e4e4e7;border-bottom:1px solid #e4e4e7;">
          ${lineRows}
        </table>
      </td></tr>

      ${reviewBlock}

      ${renderTotalsBlock(order, opts.shippingValueCents ?? 0)}

      ${protectionBadge}

      ${ship ? `
      <tr><td class="sx-pad" style="padding:16px 32px 24px 32px;">
        <div style="font-size:13px;color:#71717a;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;margin-bottom:8px;">Shipping to</div>
        <div style="font-size:14px;color:#18181b;line-height:1.6;">${formatAddress(ship)}</div>
      </td></tr>` : ""}

      <tr><td class="sx-pad" style="padding:24px 32px;border-top:1px solid #e4e4e7;text-align:center;font-size:13px;color:#71717a;line-height:1.6;">
        Questions? Just reply to this email.<br>
        — The Superfoods Company team
      </td></tr>
    `;

    const brand = await getBrand(opts.workspaceId, client.domain);
    const html = await shellHtml({
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

/**
 * Abandoned-cart reminder. Fires once per cart_draft when the
 * customer has been idle for 30+ minutes without converting. The cart
 * token survives so the CTA drops them back into /customize with all
 * their line items intact — no re-picking products, no losing their
 * subscribe-vs-onetime selection.
 */
interface AbandonedCartLine {
  title: string;
  variant_title?: string | null;
  quantity: number;
  unit_price_cents?: number;
  unit_msrp_cents?: number;
  line_total_cents?: number;
  image_url?: string | null;
  is_gift?: boolean;
}

interface RecoveryReview {
  reviewer_name: string | null;
  rating: number;
  title: string | null;
  body: string | null;
  product_title?: string | null;
}

/**
 * Cart-recovery email — the elaborate counterpart to the urgent recovery SMS.
 * Highlights the extra discount + total savings, shows up to 3 featured reviews,
 * the brand-trust facts (3rd-party tested, made in USA, Non-GMO), an
 * expert/nutritionist note, and the 30-day money-back guarantee. CTA drops them
 * straight onto checkout with the coupon applied.
 */
export async function sendCartRecoveryEmail(opts: {
  workspaceId: string;
  to: string;
  firstName?: string | null;
  lineItems: AbandonedCartLine[];
  subtotalCents: number;
  /** Total savings on the cart (qty + S&S + the recovery coupon), in cents. */
  savingsCents: number;
  couponPct: number;
  ctaUrl: string;
  reviews: RecoveryReview[];
  nutritionistNote?: string | null;
  /** Second touch (24 h) — "last chance" framing. */
  followUp?: boolean;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const client = await getResendClient(opts.workspaceId, opts.to);
    if (!client) return { success: false, error: "resend_not_configured_or_blocked" };
    if (!opts.lineItems || opts.lineItems.length === 0) return { success: false, error: "empty_cart" };
    const brand = await getBrand(opts.workspaceId, client.domain);
    const greeting = opts.firstName ? `Hi ${escapeHtml(opts.firstName)}, ` : "Hi there, ";
    const lineRows = renderLineItemsRows(opts.lineItems as OrderLineLike[]);
    const reviewsHtml = (opts.reviews || []).slice(0, 3).map((r) => renderReviewBlock(r as NonNullable<Awaited<ReturnType<typeof pickFeaturedReview>>>)).join("");

    const trustBadges = `
      <tr><td class="sx-pad" style="padding:8px 32px 0 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;">
          <tr><td style="padding:14px 18px;font-size:13px;color:#166534;line-height:1.8;">
            <strong style="color:#14532d;">Why ${escapeHtml(brand.brandName)}:</strong><br>
            ✓ Third-party lab tested for purity &amp; potency<br>
            ✓ Made in the USA · Non-GMO<br>
            ✓ Family-run, expert-recommended<br>
            ✓ 30-day money-back guarantee — love it or your money back
          </td></tr>
        </table>
      </td></tr>`;

    const nutritionistBlock = opts.nutritionistNote ? `
      <tr><td class="sx-pad" style="padding:16px 32px 0 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafafa;border-left:3px solid #18181b;border-radius:4px;">
          <tr><td style="padding:16px 18px;font-size:14px;color:#27272a;line-height:1.6;font-style:italic;">
            ${escapeHtml(opts.nutritionistNote)}
            <div style="font-style:normal;font-size:12px;color:#71717a;margin-top:8px;">— Recommended by nutrition experts</div>
          </td></tr>
        </table>
      </td></tr>` : "";

    const eyebrow = opts.followUp ? "Last chance" : "Your cart is waiting";
    const heading = opts.followUp ? "Your discount is about to expire" : "Still thinking it over?";
    const intro = opts.followUp
      ? `${greeting}this is a final reminder — your cart and the <strong style="color:#15803d;">extra ${opts.couponPct}% off</strong> won't be held much longer. It's still applied; tap below before it's gone.`
      : `${greeting}we saved your cart — and we've added an <strong style="color:#15803d;">extra ${opts.couponPct}% off</strong> to help you finish. It's already applied; just tap below.`;
    const bodyHtml = `
      <tr><td class="sx-pad" style="padding:32px 32px 8px 32px;">
        <div style="font-size:13px;color:#71717a;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">${eyebrow}</div>
        <h1 class="sx-h1" style="margin:8px 0 12px 0;font-size:24px;color:#18181b;font-weight:700;">${heading}</h1>
        <p class="sx-body" style="margin:0;color:#52525b;font-size:15px;line-height:1.55;">
          ${intro}
        </p>
      </td></tr>

      <tr><td class="sx-pad" style="padding:16px 32px 8px 32px;" align="center">
        <a href="${escapeHtml(opts.ctaUrl)}" style="display:inline-block;background:${escapeHtml(brand.primaryColor)};color:#ffffff;font-weight:700;font-size:16px;padding:14px 30px;border-radius:8px;text-decoration:none;">Complete my order — ${opts.couponPct}% off →</a>
      </td></tr>

      <tr><td class="sx-pad" style="padding:8px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid #e4e4e7;border-bottom:1px solid #e4e4e7;">
          ${lineRows}
        </table>
      </td></tr>

      <tr><td class="sx-pad" style="padding:12px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;color:#52525b;">
          <tr><td style="padding:4px 0;">Subtotal</td><td style="padding:4px 0;text-align:right;color:#18181b;">${fmtCents(opts.subtotalCents)}</td></tr>
          ${opts.savingsCents > 0 ? `<tr><td colspan="2" style="padding:8px 0 0 0;text-align:right;"><span style="display:inline-block;background:#dcfce7;color:#166534;padding:6px 12px;border-radius:999px;font-size:13px;font-weight:700;">You save ${fmtCents(opts.savingsCents)} with your discount</span></td></tr>` : ""}
        </table>
      </td></tr>

      ${trustBadges}
      ${nutritionistBlock}
      ${reviewsHtml}

      <tr><td class="sx-pad" style="padding:16px 32px 8px 32px;" align="center">
        <a href="${escapeHtml(opts.ctaUrl)}" style="display:inline-block;background:${escapeHtml(brand.primaryColor)};color:#ffffff;font-weight:700;font-size:16px;padding:14px 30px;border-radius:8px;text-decoration:none;">Complete my order →</a>
        <div style="font-size:12px;color:#a1a1aa;margin-top:8px;">Your ${opts.couponPct}% discount is already applied at checkout.</div>
      </td></tr>

      <tr><td class="sx-pad" style="padding:20px 32px;border-top:1px solid #e4e4e7;text-align:center;font-size:13px;color:#71717a;line-height:1.6;">
        — The ${escapeHtml(brand.brandName)} team
      </td></tr>
    `;

    const html = await shellHtml({
      title: "Your cart is waiting — extra discount inside",
      preheader: `Finish your order and take an extra ${opts.couponPct}% off — plus free shipping & a 30-day guarantee.`,
      bodyHtml,
      brand,
    });

    const { error } = await client.resend.emails.send({
      from: `${brand.brandName} <${brand.fromEmail}>`,
      to: opts.to,
      replyTo: brand.replyToEmail,
      subject: opts.followUp
        ? `${opts.firstName ? `${opts.firstName}, ` : ""}last chance — your ${opts.couponPct}% off expires soon`
        : `${opts.firstName ? `${opts.firstName}, ` : ""}your cart + an extra ${opts.couponPct}% off`,
      html,
    });
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendAbandonedCartEmail(opts: {
  workspaceId: string;
  to: string;
  firstName?: string | null;
  cartToken: string;
  lineItems: AbandonedCartLine[];
  subtotalCents: number;
  storefrontDomain: string | null;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const client = await getResendClient(opts.workspaceId, opts.to);
    if (!client) return { success: false, error: "resend_not_configured_or_blocked" };
    if (!opts.lineItems || opts.lineItems.length === 0) {
      return { success: false, error: "empty_cart" };
    }

    // CTA lands on the customer's storefront, not the dashboard. When
    // the workspace has no custom storefront domain set we fall back
    // to NEXT_PUBLIC_SITE_URL so test workspaces still get a usable
    // link.
    const storefrontBase = opts.storefrontDomain
      ? `https://${opts.storefrontDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`
      : (process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai");
    const ctaUrl = `${storefrontBase}/customize?token=${encodeURIComponent(opts.cartToken)}`;

    const greeting = opts.firstName
      ? `Hi ${escapeHtml(opts.firstName)}, `
      : "Hi there, ";
    const brand = await getBrand(opts.workspaceId, client.domain);
    const lineRows = renderLineItemsRows(opts.lineItems as OrderLineLike[]);

    const bodyHtml = `
      <tr><td class="sx-pad" style="padding:32px 32px 16px 32px;">
        <div style="font-size:13px;color:#71717a;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">Your cart</div>
        <h1 class="sx-h1" style="margin:8px 0 12px 0;font-size:24px;color:#18181b;font-weight:700;">You left something behind</h1>
        <p class="sx-body" style="margin:0;color:#52525b;font-size:15px;line-height:1.55;">
          ${greeting}your cart is still waiting. Pick up where you left off — we saved everything for you.
        </p>
      </td></tr>

      <tr><td class="sx-pad" style="padding:8px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid #e4e4e7;border-bottom:1px solid #e4e4e7;">
          ${lineRows}
        </table>
      </td></tr>

      <tr><td class="sx-pad" style="padding:16px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="sx-totals" style="font-size:14px;color:#52525b;">
          <tr><td style="padding:8px 0;font-weight:700;color:#18181b;">Subtotal</td><td style="padding:8px 0;text-align:right;font-weight:700;color:#18181b;">${fmtCents(opts.subtotalCents)}</td></tr>
        </table>
      </td></tr>

      <tr><td class="sx-pad" style="padding:8px 32px 32px 32px;" align="center">
        <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:${escapeHtml(brand.primaryColor)};color:#ffffff;font-weight:700;font-size:16px;padding:14px 28px;border-radius:8px;text-decoration:none;">Complete your order</a>
      </td></tr>

      <tr><td class="sx-pad" style="padding:20px 32px;border-top:1px solid #e4e4e7;text-align:center;font-size:13px;color:#71717a;line-height:1.6;">
        — The ${escapeHtml(brand.brandName)} team
      </td></tr>
    `;

    const html = await shellHtml({
      title: "You left something behind",
      preheader: "Your cart is still waiting — pick up where you left off.",
      bodyHtml,
      brand,
    });

    const { error } = await client.resend.emails.send({
      from: `${brand.brandName} <${brand.fromEmail}>`,
      to: opts.to,
      replyTo: brand.replyToEmail,
      subject: "You left something behind",
      html,
    });
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
