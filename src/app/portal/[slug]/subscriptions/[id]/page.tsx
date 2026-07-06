/**
 * Subscription detail page — `/subscriptions/{uuid}` on the portal
 * subdomain. The middleware rewrites the bare path to this route.
 *
 * `id` is our internal `subscriptions.id` (UUID), not a Shopify or
 * Appstle contract ID — keeps the URL stable across the eventual
 * Shopify cutover. The page resolves the UUID to the contract row,
 * authorizes against the logged-in customer (and linked profiles),
 * then delegates to PortalClient with detailSubscriptionId set.
 *
 * The shell (sidebar + nav + branding) is shared with the rest of
 * the portal so the customer doesn't experience a context switch.
 */
import { cookies, headers } from "next/headers";
import { redirect, notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { enrichLineItemImages } from "@/lib/portal/helpers/image-fallback";
import PortalClient from "../../portal-client";
import type { PortalSubscription, PortalOrder } from "../../page";

export default async function SubscriptionDetailPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;

  // ── Auth (same shape as /portal/[slug]/page.tsx) ──
  const cookieStore = await cookies();
  const headerStore = await headers();
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

  if (!customerId || !workspaceId) return redirect(loginRedirect);

  const admin = createAdminClient();

  const { data: customer } = await admin
    .from("customers")
    .select("id, first_name, last_name, email, phone, shopify_customer_id")
    .eq("id", customerId)
    .single();
  if (!customer) return redirect(loginRedirect);

  // Linked accounts — the requested subscription might sit on a sibling
  // profile in the customer's link group. The portal treats all linked
  // profiles as one identity for read access.
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

  // ── Authorize the requested subscription ──
  // notFound on no row OR if it belongs to someone outside the link
  // group — never leak the existence of someone else's subscription.
  const { data: subRow } = await admin
    .from("subscriptions")
    .select("id, customer_id, workspace_id")
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!subRow || !linkedIds.includes(subRow.customer_id)) return notFound();

  // ── Workspace branding (same shape as the home page) ──
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, name, portal_config, storefront_logo_url, storefront_primary_color")
    .eq("id", workspaceId)
    .single();
  if (!workspace) return redirect(loginRedirect);

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

  // Initial subscriptions + orders so the rest of the portal nav has
  // hydrated data if the customer clicks into another section without
  // a hard reload.
  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, status, items, billing_interval, billing_interval_count, next_billing_date, applied_discounts, is_internal, delivery_price_cents")
    .eq("workspace_id", workspaceId)
    .in("customer_id", linkedIds)
    .in("status", ["active", "paused", "cancelled"])
    .order("created_at", { ascending: false });

  const { data: orders } = await admin
    .from("orders")
    .select("id, order_number, created_at, total_cents, financial_status, line_items, source_name, amplifier_tracking_number, amplifier_carrier, amplifier_status, amplifier_shipped_at, shipping_address")
    .eq("workspace_id", workspaceId)
    .in("customer_id", linkedIds)
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <PortalClient
      slug={slug}
      initialSection="subscriptions"
      detailSubscriptionId={id}
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
      subscriptions={(await enrichLineItemImages(admin, workspaceId, subs || [])) as unknown as PortalSubscription[]}
      orders={(await enrichLineItemImages(admin, workspaceId, orders || [])) as unknown as PortalOrder[]}
    />
  );
}
