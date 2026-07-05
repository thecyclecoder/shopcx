/**
 * Portal mini-site entry point.
 *
 * Server-side responsibilities:
 *   1. Auth check via cookie (magic-link session OR legacy session).
 *   2. Resolve the active customer, expand to all linked profiles
 *      (so all sections show the customer's full history).
 *   3. Load workspace branding so the client doesn't need to re-fetch.
 *   4. Pass a hydrated initial payload to PortalClient — the client
 *      can render its first frame without an extra API hop.
 */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { enrichLineItemImages } from "@/lib/portal/helpers/image-fallback";
import PortalClient from "./portal-client";

export default async function PortalHome({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ section?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;

  // ── Auth ──
  const cookieStore = await cookies();
  const headerStore = await headers();
  // Read the host so we can decide which redirect target keeps the
  // URL bar clean: on the customer-facing portal subdomain (e.g.
  // portal.superfoodscompany.com) middleware rewrites /login →
  // /portal/{slug}/login server-side, so we redirect to "/login"
  // and the browser shows just /login. On shopcx.ai admin preview
  // the prefix has to stay since there's no middleware rewrite.
  const host = headerStore.get("host") || "";
  const isOnCustomDomain = !host.endsWith("shopcx.ai") && !host.includes("localhost") && !host.includes("127.0.0.1");
  const loginRedirect = isOnCustomDomain ? "/login" : `/portal/${slug}/login`;
  const magicCustomerId = cookieStore.get("portal_customer_id")?.value;
  const magicWorkspaceId = cookieStore.get("portal_workspace_id")?.value;
  const legacySession = cookieStore.get("portal_session")?.value;

  let customerId: string | null = null;
  let workspaceId: string | null = null;

  if (magicCustomerId && magicWorkspaceId) {
    customerId = magicCustomerId;
    workspaceId = magicWorkspaceId;
  } else if (legacySession) {
    try {
      const session = JSON.parse(decrypt(legacySession));
      if (session && Date.now() <= session.exp) {
        const admin2 = createAdminClient();
        const { data: cust } = await admin2.from("customers")
          .select("id, workspace_id")
          .eq("shopify_customer_id", session.shopify_customer_id)
          .limit(1).single();
        if (cust) {
          customerId = cust.id;
          workspaceId = cust.workspace_id;
        }
      }
    } catch { /* invalid session */ }
  }

  if (!customerId || !workspaceId) {
    return redirect(loginRedirect);
  }

  const admin = createAdminClient();

  // ── Customer + linked accounts ──
  const { data: customer } = await admin
    .from("customers")
    .select("id, first_name, last_name, email, phone, shopify_customer_id")
    .eq("id", customerId)
    .single();
  if (!customer) return redirect(`/portal/${slug}/login`);

  // Expand linked accounts so every section sees the full identity.
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customerId)
    .maybeSingle();
  let linkedIds = [customerId];
  // Linked-account list for the Account section (name + email + which is
  // primary). Only the OTHER accounts in the group are shown to the customer.
  let linkedAccounts: Array<{ id: string; name: string; email: string; isPrimary: boolean }> = [];
  if (link?.group_id) {
    const { data: g } = await admin
      .from("customer_links")
      .select("customer_id, is_primary, customers(id, first_name, last_name, email)")
      .eq("group_id", link.group_id);
    linkedIds = (g || []).map((r) => r.customer_id as string);
    if (!linkedIds.includes(customerId)) linkedIds.push(customerId);
    linkedAccounts = (g || [])
      .filter((r) => r.customer_id !== customerId)
      .map((r) => {
        const c = r.customers as unknown as { id: string; first_name: string | null; last_name: string | null; email: string | null };
        return {
          id: c.id,
          name: [c.first_name, c.last_name].filter(Boolean).join(" ") || "(no name)",
          email: c.email || "",
          isPrimary: !!r.is_primary,
        };
      });
  }

  // ── Workspace branding ──
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, name, portal_config, storefront_logo_url, storefront_primary_color")
    .eq("id", workspaceId)
    .single();
  if (!workspace) return redirect(`/portal/${slug}/login`);

  const portalConfig = (workspace.portal_config || {}) as Record<string, unknown>;
  const minisite = (portalConfig.minisite || {}) as Record<string, unknown>;
  const logoUrl =
    (minisite.logo_url as string) ||
    (workspace.storefront_logo_url as string | null) ||
    "";
  const primaryColor =
    (minisite.primary_color as string) ||
    (workspace.storefront_primary_color as string | null) ||
    "#18181b";

  // Self-healing migration guard: if any Appstle subs remain and the customer has
  // a working default Braintree card, sweep them onto internal billing before we
  // render. Cheap no-op once everything's migrated. Best-effort — never block the
  // portal on it.
  try {
    const { ensureGroupMigratedIfBillable } = await import("@/lib/migrate-to-internal");
    await ensureGroupMigratedIfBillable(workspaceId, customerId);
  } catch (err) {
    console.warn("[portal] ensureGroupMigratedIfBillable threw (non-fatal):", err instanceof Error ? err.message : err);
  }

  // ── Initial subscriptions list (small payload, drives the
  //    Subscriptions section's first paint).
  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, status, items, billing_interval, billing_interval_count, next_billing_date, applied_discounts, is_internal, delivery_price_cents")
    .eq("workspace_id", workspaceId)
    .in("customer_id", linkedIds)
    .in("status", ["active", "paused", "cancelled"])
    .order("created_at", { ascending: false });

  // ── Recent orders for the Orders section.
  const { data: orders } = await admin
    .from("orders")
    .select("id, order_number, created_at, total_cents, financial_status, line_items, source_name, amplifier_tracking_number, amplifier_carrier, amplifier_status, amplifier_shipped_at, shipping_address")
    .eq("workspace_id", workspaceId)
    .in("customer_id", linkedIds)
    .order("created_at", { ascending: false })
    .limit(50);

  // Hydrate line-item images from the products catalog so the cards
  // never render a gray placeholder when we have a Shopify image
  // available. Cheap — one products + one product_media query, both
  // covered by partial indexes.
  const imagedSubs = await enrichLineItemImages(admin, workspaceId, subs || []);
  const enrichedOrders = await enrichLineItemImages(admin, workspaceId, orders || []);

  // Layer live pricing onto each sub — per-line charged + strikethrough base, and
  // the per-delivery total + qualified-discount pills. Internal subs price via the
  // engine; Appstle subs keep baked prices and just get the coupon reflected.
  const { priceSubscription } = await import("@/lib/commerce/price");
  const enrichedSubs = await Promise.all(
    (imagedSubs as Array<Record<string, unknown>>).map(async (sub) => {
      const { priced, pricing } = await priceSubscription(workspaceId, sub);
      const items = (Array.isArray(sub.items) ? sub.items : []).map((it: Record<string, unknown>) => {
        const p = priced.get(String(it.line_id || "")) || priced.get(String(it.variant_id ?? ""));
        if (!p) return it;
        return { ...it, price_cents: p.unit_cents, base_price_cents: p.base_cents > p.unit_cents ? p.base_cents : null };
      });
      return { ...sub, items, pricing };
    }),
  );

  return (
    <PortalClient
      slug={slug}
      initialSection={normalizeSection(sp?.section)}
      workspace={{
        id: workspace.id as string,
        name: (workspace.name as string) || "",
        logoUrl,
        primaryColor,
      }}
      customer={{
        id: customer.id as string,
        firstName: (customer.first_name as string | null) || "",
        lastName: (customer.last_name as string | null) || "",
        email: (customer.email as string | null) || "",
        phone: (customer.phone as string | null) || "",
        linkedIds,
        linkedAccounts,
      }}
      subscriptions={enrichedSubs as unknown as PortalSubscription[]}
      orders={enrichedOrders as unknown as PortalOrder[]}
    />
  );
}

function normalizeSection(raw: string | undefined): "home" | "subscriptions" | "orders" | "rewards" | "payment_methods" | "support" | "help" | "account" | "resources" {
  if (raw === "subscriptions") return "subscriptions";
  if (raw === "orders") return "orders";
  if (raw === "rewards") return "rewards";
  if (raw === "payment-methods" || raw === "payment_methods") return "payment_methods";
  if (raw === "support") return "support";
  if (raw === "help") return "help";
  if (raw === "account") return "account";
  if (raw === "resources") return "resources";
  return "home";
}

// Re-export shapes the client expects so we can keep types in sync.
export interface PortalOrder {
  id: string;
  order_number: string;
  created_at: string;
  total_cents: number;
  financial_status: string | null;
  line_items: Array<{
    title: string;
    variant_title?: string | null;
    quantity: number;
    /** Per-unit price as stored on the order line (checkout + renewals write this). */
    price_cents?: number;
    unit_price_cents?: number;
    line_total_cents?: number;
    image_url?: string | null;
    is_gift?: boolean;
    variant_id?: string;
    sku?: string | null;
  }>;
  source_name: string | null;
  amplifier_tracking_number: string | null;
  amplifier_carrier: string | null;
  amplifier_status: string | null;
  amplifier_shipped_at: string | null;
  shipping_address: {
    first_name?: string;
    last_name?: string;
    address1?: string;
    address2?: string | null;
    city?: string;
    province_code?: string;
    zip?: string;
  } | null;
}

export interface PortalSubscription {
  id: string;
  shopify_contract_id: string;
  status: string;
  items: Array<{
    title: string;
    variant_title?: string | null;
    quantity: number;
    price_cents: number;
    /** Strikethrough "full" price per unit (when a discount applies). */
    base_price_cents?: number | null;
    sku?: string | null;
    image_url?: string | null;
    is_gift?: boolean;
  }>;
  billing_interval: string;
  billing_interval_count: number;
  next_billing_date: string | null;
  applied_discounts: Array<{ title?: string; value?: number; valueType?: string }> | null;
  is_internal: boolean | null;
  delivery_price_cents: number | null;
  /** Live per-delivery pricing + qualified-discount pills. */
  pricing?: {
    subtotal_cents: number;
    discount_cents: number;
    shipping_cents: number;
    total_cents: number;
    free_shipping: boolean;
    pills: Array<{ kind: string; label: string }>;
  };
}
