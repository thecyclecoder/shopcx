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
 * Pull the workspace's storefront branding so the email header
 * matches what the customer sees on the site. Returns sensible
 * defaults so emails still render if branding hasn't been uploaded.
 */
async function getBrand(workspaceId: string): Promise<{ logoUrl: string | null; primaryColor: string; brandName: string }> {
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("name, storefront_logo_url, storefront_primary_color")
    .eq("id", workspaceId)
    .single();
  return {
    logoUrl: (ws?.storefront_logo_url as string | null) || null,
    primaryColor: (ws?.storefront_primary_color as string) || "#18181b",
    brandName: (ws?.name as string) || FROM_NAME,
  };
}

interface OrderLineLike {
  title: string;
  variant_title?: string | null;
  quantity: number;
  unit_price_cents?: number;
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
      const lineTotal = l.is_gift
        ? '<span style="color:#16a34a;font-weight:600;">Free</span>'
        : fmtCents((l.line_total_cents ?? (l.unit_price_cents || 0) * l.quantity) || 0);
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
          <td style="padding:8px 0;text-align:right;vertical-align:top;font-size:14px;color:#18181b;">${lineTotal}</td>
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
  const logoRow = opts.brand.logoUrl
    ? `<img src="${escapeHtml(opts.brand.logoUrl)}" alt="${escapeHtml(opts.brand.brandName)}" height="36" style="display:block;height:36px;max-height:36px;width:auto;border:0;" />`
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

    const lineRows = renderLineItemsRows(order.line_items);
    const ship = order.shipping_address;
    const welcome = isFirstOrder
      ? `Welcome to the Superfoods family, ${escapeHtml(firstName)}! `
      : `Thanks ${escapeHtml(firstName)}, `;
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

      <tr><td style="padding:16px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:14px;color:#52525b;">
          <tr><td style="padding:4px 0;">Subtotal</td><td style="padding:4px 0;text-align:right;color:#18181b;">${fmtCents(subtotalCents)}</td></tr>
          <tr><td style="padding:4px 0;">Shipping</td><td style="padding:4px 0;text-align:right;color:#18181b;">${shippingCents === 0 ? "Free" : fmtCents(shippingCents)}</td></tr>
          ${taxCents > 0 ? `<tr><td style="padding:4px 0;">Tax</td><td style="padding:4px 0;text-align:right;color:#18181b;">${fmtCents(taxCents)}</td></tr>` : ""}
          <tr><td style="padding:8px 0 4px 0;border-top:1px solid #e4e4e7;font-weight:700;color:#18181b;">Total</td><td style="padding:8px 0 4px 0;border-top:1px solid #e4e4e7;text-align:right;font-weight:700;color:#18181b;">${fmtCents(order.total_cents)}</td></tr>
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

    const brand = await getBrand(opts.workspaceId);
    const html = shellHtml({
      title: `Order confirmation — ${order.order_number}`,
      preheader: `Your order ${order.order_number} is confirmed. We'll send tracking once it ships.`,
      bodyHtml,
      brand,
    });

    const { error } = await client.resend.emails.send({
      from: `${brand.brandName} <orders@${client.domain}>`,
      to: order.email,
      // Replies route to no-reply@ which the workspace has an
      // autoresponder on (deflects "cancel my order" reply attempts
      // and points the customer to the account portal). Stops random
      // mutation requests from sneaking in via the order receipt
      // thread.
      replyTo: `no-reply@${client.domain}`,
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

    const brand = await getBrand(opts.workspaceId);
    const html = shellHtml({
      title: `Your order ${order.order_number} has shipped`,
      preheader: `Tracking ${tracking} — your order is on its way.`,
      bodyHtml,
      brand,
    });

    const { error } = await client.resend.emails.send({
      from: `${brand.brandName} <orders@${client.domain}>`,
      to: order.email,
      // See note on the confirmation send — replies go to the
      // workspace's autoresponder, not a real human inbox.
      replyTo: `no-reply@${client.domain}`,
      subject: `Your order is on its way — ${order.order_number}`,
      html,
    });
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
