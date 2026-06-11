/**
 * Cart-recovery orchestrator. For an abandoned cart it mints (derives) the
 * COMEBACK recovery coupon for the customer, builds a shortlinked resume-to-
 * checkout URL with the coupon auto-applied, and reaches out — preferring SMS
 * (simple + urgent), falling back to the elaborate recovery email (reviews,
 * trust, nutritionist note, savings, 30-day guarantee).
 *
 * Anonymous carts (no customer / short_code) can't get a per-customer derived
 * code, so they fall back to the plain "you left something behind" email.
 */
import { createAdminClient } from "@/lib/supabase/admin";

const RECOVERY_MASTER = "COMEBACK";
const RECOVERY_PCT = 15;

interface RecoveryLine {
  title: string;
  variant_title?: string | null;
  quantity: number;
  unit_price_cents?: number;
  unit_msrp_cents?: number;
  line_total_cents?: number;
  image_url?: string | null;
  is_gift?: boolean;
  product_id?: string;
}

export async function sendCartRecovery(opts: {
  workspaceId: string;
  cartToken: string;
  customerId: string | null;
  email: string;
  lineItems: RecoveryLine[];
  subtotalCents: number;
  storefrontDomain?: string | null;
  /** Second touch (24 h) — more urgent "last chance" copy. */
  followUp?: boolean;
}): Promise<{ channel: "sms" | "email" | "basic_email"; success: boolean; error?: string }> {
  const admin = createAdminClient();

  // Anonymous cart → no derived coupon; plain reminder email.
  if (!opts.customerId) {
    const { sendAbandonedCartEmail } = await import("@/lib/email-storefront");
    const r = await sendAbandonedCartEmail({
      workspaceId: opts.workspaceId, to: opts.email, firstName: null,
      cartToken: opts.cartToken, lineItems: opts.lineItems, subtotalCents: opts.subtotalCents,
      storefrontDomain: opts.storefrontDomain || null,
    });
    return { channel: "basic_email", success: r.success, error: r.error };
  }

  const { data: customer } = await admin
    .from("customers")
    .select("first_name, phone, short_code")
    .eq("id", opts.customerId)
    .maybeSingle();
  const firstName = (customer?.first_name as string | null) || null;

  // Derive COMEBACK-{short_code}; build the shortlinked resume-to-checkout URL.
  const { deriveCustomerCoupon } = await import("@/lib/coupons");
  const derived = await deriveCustomerCoupon(opts.workspaceId, opts.customerId, RECOVERY_MASTER);
  const { buildCheckoutResumeShortUrl } = await import("@/lib/popup/redeem-link");
  const ctaUrl = derived
    ? await buildCheckoutResumeShortUrl(opts.workspaceId, opts.customerId, derived.code, opts.cartToken)
    : null;

  // No coupon/link available → plain reminder email.
  if (!ctaUrl) {
    const { sendAbandonedCartEmail } = await import("@/lib/email-storefront");
    const r = await sendAbandonedCartEmail({
      workspaceId: opts.workspaceId, to: opts.email, firstName,
      cartToken: opts.cartToken, lineItems: opts.lineItems, subtotalCents: opts.subtotalCents,
      storefrontDomain: opts.storefrontDomain || null,
    });
    return { channel: "basic_email", success: r.success, error: r.error };
  }

  // Savings: MSRP subtotal − what they'd pay after the recovery coupon.
  const unit = (l: RecoveryLine) => l.unit_price_cents || 0;
  const msrpSubtotal = opts.lineItems.reduce((s, l) => s + (l.unit_msrp_cents || unit(l)) * l.quantity, 0);
  const couponDiscount = Math.round(opts.subtotalCents * (RECOVERY_PCT / 100));
  const savingsCents = Math.max(0, msrpSubtotal - (opts.subtotalCents - couponDiscount));

  // Prefer SMS when we have a number.
  const phone = (customer?.phone as string | null) || null;
  if (phone) {
    try {
      const { sendSMS } = await import("@/lib/twilio");
      const sms = opts.followUp
        ? `Hi ${firstName || "there"}! Last chance - your ${RECOVERY_PCT}% off is about to expire.\n\nComplete your order now:\n${ctaUrl}\n\nTap to finish before it's gone.`
        : `Hi ${firstName || "there"}! Your cart items are low in stock.\n\nFinish now & take an extra ${RECOVERY_PCT}% off:\n${ctaUrl}\n\nTap to complete checkout - discount applied.`;
      const r = await sendSMS(opts.workspaceId, phone, sms);
      if (r.success) return { channel: "sms", success: true };
    } catch { /* fall through to email */ }
  }

  // Fallback: elaborate recovery email. Show 3 FEATURED reviews with the FULL
  // body (not the smart-quote summary) — the full text usually mentions the
  // weight-loss result, which is the conversion driver.
  const productIds = Array.from(new Set(opts.lineItems.map((l) => l.product_id).filter((id): id is string => !!id)));
  let reviews: Array<{ reviewer_name: string | null; rating: number; title: string | null; body: string | null; product_title?: string | null }> = [];
  if (productIds.length > 0) {
    const { data: prods } = await admin.from("products").select("id, title").in("id", productIds);
    const titleById = new Map((prods || []).map((p) => [p.id as string, p.title as string]));
    const { data: revs } = await admin
      .from("product_reviews")
      .select("reviewer_name, rating, title, body, product_id")
      .eq("workspace_id", opts.workspaceId)
      .in("product_id", productIds)
      .eq("featured", true)
      .not("body", "is", null)
      .limit(3);
    reviews = (revs || []).map((r) => ({
      reviewer_name: r.reviewer_name as string | null,
      rating: r.rating as number,
      title: r.title as string | null,
      body: r.body as string | null, // full review body
      product_title: titleById.get(r.product_id as string) || null,
    }));
  }
  const { sendCartRecoveryEmail } = await import("@/lib/email-storefront");
  const r = await sendCartRecoveryEmail({
    workspaceId: opts.workspaceId, to: opts.email, firstName,
    lineItems: opts.lineItems, subtotalCents: opts.subtotalCents,
    savingsCents, couponPct: RECOVERY_PCT, ctaUrl, reviews, followUp: opts.followUp,
  });
  return { channel: "email", success: r.success, error: r.error };
}
