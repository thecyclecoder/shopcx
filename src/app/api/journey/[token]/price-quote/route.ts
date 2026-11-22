import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveSubscriptionPricing } from "@/lib/pricing";

/**
 * POST /api/journey/[token]/price-quote
 *
 * Journey-side price quote — the SAME engine path the Portal's price-quote handler
 * uses (src/lib/portal/handlers/price-quote.ts → resolveSubscriptionPricing), so the
 * mini-site's swap/add preview matches EXACTLY what the renewal will charge, including
 * the mix-and-match quantity break that depends on the resulting total quantity.
 *
 * Scoped to the SESSION's (linked) subscriptions — a token can only quote against a
 * subscription owned by its customer or a linked account. Non-internal subs return
 * `internal:false` (the client keeps its vendor-baked estimate), identical to the Portal.
 */
type Admin = ReturnType<typeof createAdminClient>;

type QuoteBody = {
  subscription_id?: string;
  variantId?: string;
  quantity?: number;
  replaceVariantId?: string | null;
};

async function resolveOwnedSubWithItems(
  admin: Admin,
  workspaceId: string,
  sessionCustomerId: string,
  sessionSubscriptionId: string | null,
  requestedSubId: string | undefined,
): Promise<{ items: unknown; is_internal: boolean; delivery_price_cents: number | null; pricing_offer_id: string | null } | null> {
  const allowedIds = [sessionCustomerId];
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", sessionCustomerId).maybeSingle();
  if (link?.group_id) {
    const { data: grp } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
    for (const g of grp || []) if (!allowedIds.includes(g.customer_id)) allowedIds.push(g.customer_id);
  }

  const targetId = requestedSubId || sessionSubscriptionId || undefined;
  if (targetId && /^[0-9a-f-]{36}$/i.test(targetId)) {
    const { data: row } = await admin.from("subscriptions")
      .select("items, is_internal, customer_id, delivery_price_cents, pricing_offer_id")
      .eq("id", targetId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (row && row.customer_id && allowedIds.includes(row.customer_id)) {
      return { items: row.items, is_internal: !!row.is_internal, delivery_price_cents: row.delivery_price_cents ?? null, pricing_offer_id: row.pricing_offer_id ?? null };
    }
    return null;
  }

  const { data: liveSubs } = await admin.from("subscriptions")
    .select("items, is_internal, delivery_price_cents, pricing_offer_id")
    .in("customer_id", allowedIds)
    .eq("workspace_id", workspaceId)
    .in("status", ["active", "paused"]);
  if (liveSubs?.length === 1) {
    const r = liveSubs[0];
    return { items: r.items, is_internal: !!r.is_internal, delivery_price_cents: r.delivery_price_cents ?? null, pricing_offer_id: r.pricing_offer_id ?? null };
  }
  return null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const admin = createAdminClient();

  const { data: session } = await admin
    .from("journey_sessions")
    .select("id, workspace_id, customer_id, subscription_id, status, token_expires_at")
    .eq("token", token)
    .maybeSingle();

  if (!session) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (new Date(session.token_expires_at) < new Date()) {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }

  const body = (await request.json()) as QuoteBody;
  const variantId = String(body.variantId || "");
  if (!variantId) return NextResponse.json({ error: "missing_variantId" }, { status: 400 });
  const quantity = Math.max(1, Math.floor(Number(body.quantity) || 1));
  const replaceVariantId = body.replaceVariantId != null ? String(body.replaceVariantId) : null;

  const sub = await resolveOwnedSubWithItems(admin, session.workspace_id, session.customer_id, session.subscription_id, body.subscription_id);
  if (!sub) return NextResponse.json({ error: "subscription_not_found" }, { status: 400 });

  // Non-internal subs keep their vendor-baked estimate — identical to the Portal.
  if (!sub.is_internal) return NextResponse.json({ ok: true, internal: false });

  // Project the hypothetical change: drop the swapped-out line, append the previewed
  // variant at the chosen quantity, then price. The engine groups by rule and sums
  // quantities so the previewed line gets the correct mix-and-match tier.
  const current = (Array.isArray(sub.items) ? sub.items : []) as Array<Record<string, unknown>>;
  const projected = current.filter((i) => !replaceVariantId || String(i.variant_id) !== replaceVariantId);
  projected.push({ variant_id: variantId, quantity });

  const pricing = await resolveSubscriptionPricing(session.workspace_id, {
    items: projected,
    delivery_price_cents: sub.delivery_price_cents ?? 0,
    pricing_offer_id: sub.pricing_offer_id,
  });
  const line = pricing.lines.find((l) => String(l.variant_id) === variantId);
  if (!line) return NextResponse.json({ ok: true, internal: true, base_cents: null, unit_cents: null });

  return NextResponse.json({
    ok: true,
    internal: true,
    base_cents: line.base_cents,
    unit_cents: line.unit_cents,
    break_pct: line.break_pct,
    sns_pct: line.sns_pct,
  });
}
