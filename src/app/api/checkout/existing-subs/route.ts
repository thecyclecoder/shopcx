/**
 * GET /api/checkout/existing-subs?cart_token=...
 *
 * Returns the authenticated customer's active INTERNAL subscriptions
 * so the checkout client can offer a three-way choice:
 *
 *   1) Add these items to my existing subscription (next renewal only)
 *   2) Order these now AND add to my existing subscription (default)
 *   3) Create a new subscription
 *
 * Only shown when:
 *   - customer authenticated via OTP (sx_session)
 *   - cart contains ≥1 subscribe-mode line
 *   - customer has ≥1 active internal sub
 *
 * Appstle-managed subs are NOT returned — they have their own
 * billing pipeline and we can't mutate items reliably from here.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readSessionFromRequest } from "@/lib/auth-session";

export async function GET(request: NextRequest) {
  const cartToken = request.nextUrl.searchParams.get("cart_token");
  if (!cartToken) return NextResponse.json({ subscriptions: [] });

  const session = readSessionFromRequest(request);
  if (!session) return NextResponse.json({ subscriptions: [] });

  const admin = createAdminClient();
  const { data: cart } = await admin
    .from("cart_drafts")
    .select("workspace_id")
    .eq("token", cartToken)
    .maybeSingle();
  if (!cart || cart.workspace_id !== session.w) return NextResponse.json({ subscriptions: [] });

  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, items, billing_interval, billing_interval_count, next_billing_date, status, delivery_price_cents, shipping_protection_added, shipping_protection_amount_cents")
    .eq("workspace_id", session.w)
    .eq("customer_id", session.c)
    .eq("is_internal", true)
    .eq("status", "active")
    .order("next_billing_date", { ascending: true });

  return NextResponse.json({
    subscriptions: (subs || []).map((s) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = (s.items as any[]) || [];
      const itemLines = items
        .filter((i) => !i.is_gift && !i.one_time_next_renewal)
        .map((i) => `${i.quantity || 1}× ${i.title}${i.variant_title ? ` (${i.variant_title})` : ""}`);
      const itemSummary = itemLines.join(", ");
      const frequencyDays = s.billing_interval === "day"
        ? (s.billing_interval_count as number)
        : s.billing_interval === "week"
          ? (s.billing_interval_count as number) * 7
          : s.billing_interval === "month"
            ? (s.billing_interval_count as number) * 30
            : (s.billing_interval_count as number) * 30;
      return {
        id: s.id,
        items_summary: itemSummary,
        item_lines: itemLines,
        frequency_days: frequencyDays,
        next_billing_date: s.next_billing_date,
      };
    }),
  });
}
