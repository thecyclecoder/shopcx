import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; orderId: string }> }
) {
  const { id: workspaceId, orderId } = await params;
  void request;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: order } = await admin
    .from("orders")
    .select(`
      id, order_number, email, total_cents, currency, financial_status,
      fulfillment_status, delivery_status, delivered_at, line_items, created_at, tags, source_name,
      shopify_order_id, shopify_customer_id, subscription_id,
      session_id, anonymous_id,
      shipping_address, discount_codes, order_type,
      amplifier_order_id, amplifier_received_at, amplifier_shipped_at,
      amplifier_tracking_number, amplifier_carrier, amplifier_status,
      sync_resolved_at, sync_resolved_note,
      fulfillments,
      customer_id,
      customers(id, email, first_name, last_name, phone, shopify_customer_id, retention_score, ltv_cents, total_orders)
    `)
    .eq("workspace_id", workspaceId)
    .eq("id", orderId)
    .single();

  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Get workspace for Shopify domain
  const { data: workspace } = await admin
    .from("workspaces")
    .select("shopify_myshopify_domain")
    .eq("id", workspaceId)
    .single();

  // Get subscription info if linked
  let subscription = null;
  if (order.subscription_id) {
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id, shopify_contract_id, status, billing_interval, billing_interval_count, next_billing_date")
      .eq("id", order.subscription_id)
      .single();
    subscription = sub;
  }

  // Build timeline
  const timeline: { timestamp: string; event: string; detail?: string }[] = [];

  timeline.push({
    timestamp: order.created_at,
    event: "Order created",
    detail: `${order.order_number} — $${(order.total_cents / 100).toFixed(2)}${order.source_name ? ` via ${order.source_name}` : ""}`,
  });

  if (order.amplifier_received_at) {
    timeline.push({
      timestamp: order.amplifier_received_at,
      event: "Received by Amplifier",
      detail: order.amplifier_status || "Processing",
    });
  }

  if (order.amplifier_shipped_at) {
    timeline.push({
      timestamp: order.amplifier_shipped_at,
      event: "Shipped",
      detail: [order.amplifier_carrier, order.amplifier_tracking_number].filter(Boolean).join(" — ") || undefined,
    });
  }

  // Add fulfillment events from Shopify
  const fulfillments = (order.fulfillments as { status?: string; createdAt?: string; trackingInfo?: { number?: string; company?: string; url?: string }[] }[]) || [];
  for (const f of fulfillments) {
    if (f.createdAt) {
      const tracking = f.trackingInfo?.[0];
      timeline.push({
        timestamp: f.createdAt,
        event: `Fulfillment ${f.status || "updated"}`,
        detail: tracking ? `${tracking.company || ""} ${tracking.number || ""}`.trim() : undefined,
      });
    }
  }

  // Delivery status events
  if (order.delivered_at) {
    timeline.push({
      timestamp: order.delivered_at,
      event: "Delivered",
      detail: order.delivery_status === "returned" ? "Returned to sender" : undefined,
    });
  } else if (order.delivery_status === "returned" && order.sync_resolved_at) {
    timeline.push({
      timestamp: order.sync_resolved_at,
      event: "Returned to sender",
      detail: order.sync_resolved_note || undefined,
    });
  }

  if (order.financial_status === "refunded" || order.financial_status === "partially_refunded") {
    // We don't have the exact refund timestamp, use a marker
    timeline.push({
      timestamp: order.created_at, // approximate
      event: order.financial_status === "refunded" ? "Fully refunded" : "Partially refunded",
    });
  }

  // Sort timeline chronologically
  timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Check for replacement links
  const { data: replacementForThis } = await admin.from("replacements")
    .select("id, shopify_replacement_order_name, status")
    .eq("original_order_id", orderId)
    .limit(1).single();

  const { data: replacementOfOriginal } = await admin.from("replacements")
    .select("id, original_order_number, status")
    .eq("shopify_replacement_order_id", order.shopify_order_id)
    .limit(1).single();

  // ── Journey panel (experiment-session-stamped-attribution Phase 4) ──
  // For a storefront order with a resolved session_id: the visitor's source (lander +
  // ?variant=, UTM/ad), the experiment + arm they were stamped to, and the full funnel
  // (landing → pdp_view → engagement → add_to_cart → checkout → order_placed) from the
  // session's storefront_events. Null for synced Shopify orders (no session link).
  const journey = await buildJourney(admin, order.session_id as string | null);

  return NextResponse.json({
    order,
    subscription,
    shopify_domain: workspace?.shopify_myshopify_domain || "",
    timeline,
    journey,
    replacement_order: replacementForThis ? { id: replacementForThis.id, order_name: replacementForThis.shopify_replacement_order_name, status: replacementForThis.status } : null,
    is_replacement_for: replacementOfOriginal ? { id: replacementOfOriginal.id, original_order: replacementOfOriginal.original_order_number } : null,
  });
}

/** Funnel step labels in canonical order — the journey panel renders the session's
 *  storefront_events grouped by these, with first/last timestamps + counts. */
const FUNNEL_ORDER: Record<string, number> = {
  landing: 0,
  pdp_view: 1,
  pdp_engaged: 2,
  chapter_view: 3,
  chapter_dwell: 3,
  scroll_depth: 3,
  experiment_exposure: 3,
  lead_captured: 4,
  pack_selected: 5,
  add_to_cart: 6,
  cta_click: 6,
  customize_view: 7,
  checkout_view: 8,
  checkout_step_completed: 8,
  order_placed: 9,
};

interface JourneyStep {
  event_type: string;
  first_at: string;
  last_at: string;
  count: number;
}

async function buildJourney(admin: ReturnType<typeof createAdminClient>, sessionId: string | null) {
  if (!sessionId) return null;

  const { data: session } = await admin
    .from("storefront_sessions")
    .select(
      "id, anonymous_id, landing_url, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term, first_seen_at, last_seen_at, device_type, os, browser, ip_country, ip_region, ip_city, experiment_assignments, advertorial_page_id, ad_campaign_id, is_internal, is_bot",
    )
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) return null;

  // Lander identity (slug + the ?variant= it served) + ad campaign name, for "source".
  let lander: { slug: string | null; render_variant: string | null } | null = null;
  if (session.advertorial_page_id) {
    const { data: page } = await admin
      .from("advertorial_pages")
      .select("slug")
      .eq("id", session.advertorial_page_id)
      .maybeSingle();
    let renderVariant: string | null = null;
    try {
      renderVariant = session.landing_url ? new URL(session.landing_url).searchParams.get("variant") : null;
    } catch {
      renderVariant = null;
    }
    lander = { slug: page?.slug ?? null, render_variant: renderVariant };
  }

  let adCampaign: { id: string; name: string | null } | null = null;
  if (session.ad_campaign_id) {
    const { data: camp } = await admin
      .from("ad_campaigns")
      .select("id, name")
      .eq("id", session.ad_campaign_id)
      .maybeSingle();
    if (camp) adCampaign = { id: camp.id, name: camp.name ?? null };
  }

  // Experiment + arm, with human labels resolved from the assigned ids.
  const assignments = (session.experiment_assignments as Array<{ experiment_id: string; variant_id: string; arm: string; assigned_at?: string; surface?: string | null }> | null) || [];
  const experiments: Array<{ experiment_id: string; variant_id: string; arm: string; surface: string | null; assigned_at: string | null; lever: string | null; audience: string | null; variant_label: string | null; status: string | null }> = [];
  if (assignments.length) {
    const expIds = [...new Set(assignments.map((a) => a.experiment_id))];
    const varIds = [...new Set(assignments.map((a) => a.variant_id))];
    const { data: exps } = await admin
      .from("storefront_experiments")
      .select("id, lever, audience, status")
      .in("id", expIds);
    const { data: vars } = await admin
      .from("storefront_experiment_variants")
      .select("id, label")
      .in("id", varIds);
    const expById = new Map((exps || []).map((e) => [e.id, e]));
    const varById = new Map((vars || []).map((v) => [v.id, v]));
    for (const a of assignments) {
      const e = expById.get(a.experiment_id);
      const v = varById.get(a.variant_id);
      experiments.push({
        experiment_id: a.experiment_id,
        variant_id: a.variant_id,
        arm: a.arm,
        surface: a.surface ?? null,
        assigned_at: a.assigned_at ?? null,
        lever: e?.lever ?? null,
        audience: e?.audience ?? null,
        status: e?.status ?? null,
        variant_label: v?.label ?? null,
      });
    }
  }

  // Funnel steps from the session's events (capped; ordered).
  const { data: events } = await admin
    .from("storefront_events")
    .select("event_type, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(2000);
  const byType = new Map<string, JourneyStep>();
  for (const ev of (events as Array<{ event_type: string; created_at: string }>) || []) {
    const cur = byType.get(ev.event_type);
    if (cur) {
      cur.count += 1;
      if (ev.created_at > cur.last_at) cur.last_at = ev.created_at;
    } else {
      byType.set(ev.event_type, { event_type: ev.event_type, first_at: ev.created_at, last_at: ev.created_at, count: 1 });
    }
  }
  // Seed a synthetic "landing" step from the session's first_seen_at so the funnel
  // always starts at the landing touch even before the first tracked event.
  const steps: JourneyStep[] = [...byType.values()];
  if (session.first_seen_at) {
    steps.push({ event_type: "landing", first_at: session.first_seen_at, last_at: session.first_seen_at, count: 1 });
  }
  steps.sort((a, b) => {
    const oa = FUNNEL_ORDER[a.event_type] ?? 50;
    const ob = FUNNEL_ORDER[b.event_type] ?? 50;
    if (oa !== ob) return oa - ob;
    return new Date(a.first_at).getTime() - new Date(b.first_at).getTime();
  });

  return {
    session: {
      id: session.id,
      anonymous_id: session.anonymous_id,
      landing_url: session.landing_url,
      referrer: session.referrer,
      first_seen_at: session.first_seen_at,
      last_seen_at: session.last_seen_at,
      device: [session.device_type, session.os, session.browser].filter(Boolean).join(" · ") || null,
      geo: [session.ip_city, session.ip_region, session.ip_country].filter(Boolean).join(", ") || null,
      is_internal: session.is_internal,
      is_bot: session.is_bot,
    },
    source: {
      utm_source: session.utm_source,
      utm_medium: session.utm_medium,
      utm_campaign: session.utm_campaign,
      utm_content: session.utm_content,
      utm_term: session.utm_term,
      lander,
      ad_campaign: adCampaign,
    },
    experiments,
    steps,
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; orderId: string }> }
) {
  const { id: workspaceId, orderId } = await params;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();

  if (body.action === "resolve_sync") {
    // Get the order's Shopify ID
    const { data: order } = await admin
      .from("orders")
      .select("shopify_order_id")
      .eq("id", orderId)
      .eq("workspace_id", workspaceId)
      .single();

    if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

    // Mark fulfilled in Shopify (no customer notification)
    const { data: ws } = await admin
      .from("workspaces")
      .select("shopify_access_token_encrypted, shopify_myshopify_domain")
      .eq("id", workspaceId)
      .single();

    if (ws?.shopify_access_token_encrypted && ws?.shopify_myshopify_domain) {
      const accessToken = decrypt(ws.shopify_access_token_encrypted);
      const shopifyGid = `gid://shopify/Order/${order.shopify_order_id}`;

      // Step 1: Get fulfillment orders for this order
      const foQuery = `{ order(id: "${shopifyGid}") { fulfillmentOrders(first: 5) { edges { node { id status } } } } }`;
      const foRes = await fetch(`https://${ws.shopify_myshopify_domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({ query: foQuery }),
      });
      const foData = await foRes.json();
      const fulfillmentOrders = foData.data?.order?.fulfillmentOrders?.edges || [];

      // Step 2: Fulfill each open fulfillment order without notifying customer
      for (const edge of fulfillmentOrders) {
        const fo = edge.node;
        if (fo.status === "CLOSED" || fo.status === "CANCELLED") continue;

        const fulfillMutation = `
          mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
            fulfillmentCreateV2(fulfillment: $fulfillment) {
              fulfillment { id }
              userErrors { field message }
            }
          }
        `;

        await fetch(`https://${ws.shopify_myshopify_domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: "POST",
          headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
          body: JSON.stringify({
            query: fulfillMutation,
            variables: {
              fulfillment: {
                lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: fo.id }],
                notifyCustomer: false,
              },
            },
          }),
        });
      }
    }

    // Update our DB
    const { error } = await admin
      .from("orders")
      .update({
        sync_resolved_at: new Date().toISOString(),
        sync_resolved_note: body.note || null,
        fulfillment_status: "fulfilled",
      })
      .eq("id", orderId)
      .eq("workspace_id", workspaceId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
