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
import PortalClient from "./portal-client";

export default async function PortalHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

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
  if (link?.group_id) {
    const { data: g } = await admin
      .from("customer_links")
      .select("customer_id")
      .eq("group_id", link.group_id);
    linkedIds = (g || []).map((r) => r.customer_id as string);
    if (!linkedIds.includes(customerId)) linkedIds.push(customerId);
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

  // ── Initial subscriptions list (small payload, drives the
  //    Subscriptions section's first paint).
  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, status, items, billing_interval, billing_interval_count, next_billing_date, applied_discounts, is_internal, total_price_cents, delivery_price_cents")
    .eq("workspace_id", workspaceId)
    .in("customer_id", linkedIds)
    .in("status", ["active", "paused"])
    .order("created_at", { ascending: false });

  return (
    <PortalClient
      slug={slug}
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
      }}
      subscriptions={(subs || []) as unknown as PortalSubscription[]}
    />
  );
}

// Re-export the shape the client expects so we can keep types in sync.
export interface PortalSubscription {
  id: string;
  shopify_contract_id: string;
  status: string;
  items: Array<{
    title: string;
    variant_title?: string | null;
    quantity: number;
    price_cents: number;
    sku?: string | null;
    image_url?: string | null;
    is_gift?: boolean;
  }>;
  billing_interval: string;
  billing_interval_count: number;
  next_billing_date: string | null;
  applied_discounts: Array<{ title?: string; value?: number; valueType?: string }> | null;
  is_internal: boolean | null;
  total_price_cents: number | null;
  delivery_price_cents: number | null;
}
