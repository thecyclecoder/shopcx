/**
 * POST /api/lead
 *
 * Lead capture endpoint. Any storefront surface (PDP popup,
 * customize-page save-cart, exit intent, footer form) hits this with:
 *
 *   {
 *     workspace_id:     required
 *     email:            required
 *     phone?:           optional (E.164)
 *     first_name?,
 *     last_name?:       optional
 *     email_consent:    bool
 *     sms_consent:      bool
 *     source:           free-form string (e.g. "customize_save_cart")
 *     anonymous_id?:    pixel session id — used for identity-stitch
 *   }
 *
 * Behavior:
 *   1. Match by email within the workspace; create the customers row if
 *      missing with subscription_status='never'.
 *   2. Refresh consent + names + phone.
 *   3. Stamp the anonymous_id → customer_id stitch on
 *      storefront_sessions + storefront_events, also enriching the
 *      session with device + IP-geo from the request headers.
 *   4. Append a storefront_leads row for funnel analytics.
 *
 * Returns: { customer_id, created: boolean }
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readVisitorContext, stitchVisitor } from "@/lib/identity-stitch";
import { toE164US } from "@/lib/phone";

// CORS — /api/lead is hit cross-origin by the Shopify theme homepage signup
// form (and same-origin by the in-house storefront popup). Reflect allowed
// brand origins only (not "*") since this endpoint creates customers + coupons.
const LEAD_CORS_ORIGINS = new Set([
  "https://superfoodscompany.com",
  "https://www.superfoodscompany.com",
  "https://shop.superfoodscompany.com",
  "https://2c6b02-3.myshopify.com",
]);
function leadCors(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  if (!LEAD_CORS_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}
export function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: leadCors(request) });
}

interface Body {
  workspace_id?: string;
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  email_consent?: boolean;
  sms_consent?: boolean;
  source?: string;
  anonymous_id?: string | null;
  /** Coupon minted for this lead (popup flow), stamped on the lead row. */
  coupon_code?: string | null;
  /** Quiz answers (Phase 4) — persisted to Klaviyo + the lead for segmentation. */
  properties?: Record<string, unknown>;
  /**
   * Popup email step: mint a customer-scoped single-use coupon now (never
   * returned to the client — delivered only by SMS at the phone step, or by
   * the 5-min email fallback). When set, also arms the abandonment fallback.
   * Legacy path — `coupon_master` is preferred.
   */
  mint_coupon?: { type: "percentage" | "fixed_amount"; value: number } | null;
  /**
   * Preferred: derive a virtual code "{MASTER}-{short_code}" from a master
   * coupon (e.g. "WELCOME") instead of minting a per-customer row. Terms live
   * on the master; single-use is the coupon_redemptions ledger. No row written.
   */
  coupon_master?: string | null;
  /** PDP handle the popup fired on — threaded to the fallback email's redeem link. */
  product_handle?: string | null;
  /** Quiz answers to persist on the lead (cups/day + health goal). */
  quiz_answers?: Record<string, unknown> | null;
}

export async function POST(request: Request) {
  const cors = leadCors(request);
  const body = (await request.json().catch(() => ({}))) as Body;
  // Store phone canonically as E.164 (UI re-formats for display).
  const leadPhoneE164 = body.phone ? (toE164US(body.phone) || body.phone) : null;
  if (!body.workspace_id) {
    return NextResponse.json({ error: "workspace_id required" }, { status: 400, headers: cors });
  }
  if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400, headers: cors });
  }
  const email = body.email.trim().toLowerCase();
  const admin = createAdminClient();
  const ctx = readVisitorContext(request);

  // Match by email within workspace.
  let { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("workspace_id", body.workspace_id)
    .ilike("email", email)
    .maybeSingle();
  let created = false;
  if (!customer) {
    // Get-or-create is non-atomic (check-then-insert): two concurrent requests
    // for the same new email both miss the select above and both try to insert,
    // and the loser hits the UNIQUE(workspace_id, email) constraint (Postgres
    // 23505). Upsert with ignoreDuplicates so the loser inserts nothing (returns
    // no row) instead of throwing; then re-read the winner's row by (ws, email).
    const { data: row, error } = await admin
      .from("customers")
      .upsert({
        workspace_id: body.workspace_id,
        email,
        first_name: body.first_name || null,
        last_name: body.last_name || null,
        phone: leadPhoneE164,
        subscription_status: "never",
        email_marketing_status: body.email_consent ? "subscribed" : "not_subscribed",
        sms_marketing_status: body.sms_consent && body.phone ? "subscribed" : "not_subscribed",
      }, { onConflict: "workspace_id,email", ignoreDuplicates: true })
      .select("id")
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: error.message || "customer_create_failed" }, { status: 500, headers: cors });
    }
    if (row) {
      customer = row;
      created = true;
    } else {
      // Lost the insert race — the row already exists, so re-read it.
      const { data: existing } = await admin
        .from("customers")
        .select("id")
        .eq("workspace_id", body.workspace_id)
        .eq("email", email)
        .maybeSingle();
      if (!existing) {
        return NextResponse.json({ error: "customer_create_failed" }, { status: 500, headers: cors });
      }
      customer = existing;
    }
  } else {
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.first_name) updates.first_name = body.first_name;
    if (body.last_name) updates.last_name = body.last_name;
    if (leadPhoneE164) updates.phone = leadPhoneE164;
    if (typeof body.email_consent === "boolean") {
      updates.email_marketing_status = body.email_consent ? "subscribed" : "unsubscribed";
    }
    if (typeof body.sms_consent === "boolean" && body.phone) {
      updates.sms_marketing_status = body.sms_consent ? "subscribed" : "unsubscribed";
    }
    if (Object.keys(updates).length > 1) {
      await admin.from("customers").update(updates).eq("id", customer.id);
    }
  }

  // Stitch identity + enrich session.
  await stitchVisitor({
    workspaceId: body.workspace_id,
    customerId: customer.id,
    anonymousId: body.anonymous_id,
    context: ctx,
  });

  // Resolve the session id (storefront_leads.session_id → storefront_sessions)
  // so the lead threads back to the exact capture session.
  let sessionId: string | null = null;
  if (body.anonymous_id) {
    const { data: sess } = await admin
      .from("storefront_sessions")
      .select("id")
      .eq("workspace_id", body.workspace_id)
      .eq("anonymous_id", body.anonymous_id)
      .maybeSingle();
    sessionId = (sess?.id as string) || null;
  }

  // Popup email step: mint the customer-scoped single-use coupon now. We
  // never return it to the client — it's revealed only via SMS (phone step)
  // or the 5-min email fallback. Stored on the lead so both deliveries +
  // the fallback job can read it.
  let mintedCoupon: string | null = body.coupon_code || null;
  // Preferred: derive a virtual "{MASTER}-{short_code}" code — no row written,
  // single-use enforced by the redemption ledger.
  if (!mintedCoupon && body.coupon_master) {
    try {
      const { deriveCustomerCoupon } = await import("@/lib/coupons");
      const d = await deriveCustomerCoupon(body.workspace_id, customer.id, body.coupon_master);
      mintedCoupon = d?.code || null;
    } catch (e) {
      console.warn("[lead] coupon derive failed:", e instanceof Error ? e.message : e);
    }
  }
  // Legacy fallback: mint a per-customer coupon row (only if no master resolved).
  if (!mintedCoupon && body.mint_coupon) {
    try {
      const { mintCustomerCoupon } = await import("@/lib/coupons");
      const res = await mintCustomerCoupon(body.workspace_id, customer.id, {
        type: body.mint_coupon.type,
        value: body.mint_coupon.value,
        recurring_cycle_limit: 1,
        codePrefix: "WELCOME",
      });
      mintedCoupon = res?.code || null;
    } catch (e) {
      console.warn("[lead] coupon mint failed:", e instanceof Error ? e.message : e);
    }
  }

  // Upsert storefront_leads. The previous code wrote boolean
  // email_consent/sms_consent columns that DON'T EXIST (they're
  // *_consent_at timestamps) and used .insert(), so a repeat email threw
  // a unique violation — net result: no lead rows were ever written.
  // Fix: map consent → *_consent_at, stamp session_id, upsert on
  // (workspace_id, email).
  const nowIso = new Date().toISOString();
  await admin
    .from("storefront_leads")
    .upsert(
      {
        workspace_id: body.workspace_id,
        customer_id: customer.id,
        anonymous_id: body.anonymous_id || null,
        session_id: sessionId,
        email,
        phone: leadPhoneE164,
        email_consent_at: body.email_consent ? nowIso : null,
        sms_consent_at: body.sms_consent && body.phone ? nowIso : null,
        source: body.source || "unknown",
        coupon_code_issued: mintedCoupon,
        quiz_answers: body.quiz_answers || {},
        updated_at: nowIso,
      },
      { onConflict: "workspace_id,email" },
    )
    .then(() => undefined, (e) => {
      console.warn("[lead] storefront_leads upsert failed:", e?.message || e);
    });

  // Fire Lead to Klaviyo (profile upsert + consent). Fire-and-forget —
  // never block the response on Klaviyo. The Meta CAPI Lead is handled by
  // the client `lead_captured` storefront event flowing through the CAPI
  // cron (deduped on event_id), so we don't double-fire it here.
  void import("@/lib/klaviyo-lead").then(({ upsertKlaviyoLead }) =>
    upsertKlaviyoLead(body.workspace_id!, {
      email,
      phone: body.phone || null,
      firstName: body.first_name || null,
      lastName: body.last_name || null,
      emailConsent: !!body.email_consent,
      smsConsent: !!(body.sms_consent && body.phone),
      properties: { source: body.source || "unknown", ...(body.properties || {}), ...(body.quiz_answers || {}) },
    }).catch(() => undefined),
  );

  // Arm the abandonment fallback: if this lead minted a coupon (popup email
  // step) but never completes the phone step, an Inngest delayed job emails
  // the code after 5 min. Fired only when a coupon was minted.
  if (mintedCoupon && (body.mint_coupon || body.coupon_master)) {
    void import("@/lib/inngest/client").then(({ inngest }) =>
      inngest.send({
        name: "popup/email-lead-captured",
        data: { workspace_id: body.workspace_id, customer_id: customer.id, email, product_handle: body.product_handle || null, coupon_code: mintedCoupon },
      }).catch(() => undefined),
    );
  }

  return NextResponse.json({ customer_id: customer.id, created, coupon_minted: !!mintedCoupon }, { headers: cors });
}
