import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, logPortalAction } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

export const bootstrap: RouteHandler = async ({ auth, route }) => {
  const admin = createAdminClient();

  let dunningCount = 0;
  let linkedAccountCount = 0;
  let customerFirstName = "";
  let customerLastName = "";
  let customerEmail = "";
  let portalBanned = false;

  if (auth.workspaceId && auth.loggedInCustomerId) {
    const { data: customer } = await admin
      .from("customers")
      .select("id, first_name, last_name, email, portal_banned")
      .eq("workspace_id", auth.workspaceId)
      .eq("shopify_customer_id", auth.loggedInCustomerId)
      .single();

    if (customer) {
      customerFirstName = customer.first_name || "";
      customerLastName = customer.last_name || "";
      customerEmail = customer.email || "";
      portalBanned = !!customer.portal_banned;

      // Log portal session
      logPortalAction({
        workspaceId: auth.workspaceId,
        customerId: customer.id,
        eventType: "portal.bootstrap",
        summary: "Portal session started",
      }).catch(() => {}); // fire and forget

      // Active dunning cycles
      const { count } = await admin
        .from("dunning_cycles")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", auth.workspaceId)
        .eq("customer_id", customer.id)
        .in("status", ["active", "skipped"]);
      dunningCount = count || 0;

      // Linked accounts
      const { data: link } = await admin
        .from("customer_links")
        .select("group_id")
        .eq("customer_id", customer.id)
        .single();
      if (link?.group_id) {
        const { count: linkCount } = await admin
          .from("customer_links")
          .select("id", { count: "exact", head: true })
          .eq("group_id", link.group_id);
        linkedAccountCount = Math.max(0, (linkCount || 1) - 1);
      }
    }
  }

  // Load portal config from workspace
  let portalConfig: Record<string, unknown> = {};
  if (auth.workspaceId) {
    const { data: ws } = await admin
      .from("workspaces")
      .select("portal_config")
      .eq("id", auth.workspaceId)
      .single();

    if (ws?.portal_config && typeof ws.portal_config === "object") {
      portalConfig = ws.portal_config as Record<string, unknown>;
    }
  }

  // Build product catalog for add/swap (from synced products table)
  const general = (portalConfig.general || {}) as Record<string, unknown>;
  const productIds = Array.isArray(general.products_available_to_add)
    ? general.products_available_to_add.filter(Boolean)
    : [];

  let catalog: unknown[] = [];
  if (productIds.length && auth.workspaceId) {
    const { data: products } = await admin
      .from("products")
      .select(
        "shopify_product_id, title, handle, image_url, variants, rating, rating_count"
      )
      .eq("workspace_id", auth.workspaceId)
      .in("shopify_product_id", productIds);

    if (products) {
      catalog = products.map((p) => ({
        productId: p.shopify_product_id,
        title: p.title,
        handle: p.handle,
        image: { src: p.image_url || "", alt: p.title },
        rating: { value: p.rating || 0, count: p.rating_count || 0 },
        variants: (Array.isArray(p.variants) ? p.variants : []).filter(
          (v: { inventory_quantity?: number }) => v.inventory_quantity == null || v.inventory_quantity > 0
        ),
      })).filter(p => (p.variants as unknown[]).length > 0);
    }
  }

  // Filter shipping protection variant IDs to only those with selling plans
  let shippingProtectionVariantIds: string[] = [];
  const rawSpIds = Array.isArray(general.shipping_protection_product_ids)
    ? general.shipping_protection_product_ids
    : [];

  if (rawSpIds.length && auth.workspaceId) {
    // Look up products that contain these variant IDs and check for selling plans
    const { data: spProducts } = await admin
      .from("products")
      .select("variants")
      .eq("workspace_id", auth.workspaceId);

    if (spProducts) {
      const rawSpIdSet = new Set(rawSpIds.map(String));
      for (const p of spProducts) {
        const variants = Array.isArray(p.variants) ? p.variants : [];
        for (const v of variants as { id?: string; selling_plan_group_ids?: string[] }[]) {
          const vid = String(v.id || "");
          if (rawSpIdSet.has(vid)) {
            // Only include if variant has selling plans
            const hasSellingPlans = Array.isArray(v.selling_plan_group_ids) && v.selling_plan_group_ids.length > 0;
            if (hasSellingPlans) {
              shippingProtectionVariantIds.push(vid);
            }
          }
        }
      }
    }

    // If no variants with selling plans found, fall through to raw IDs
    // (Appstle may handle subscription additions without selling plans)
    if (!shippingProtectionVariantIds.length) {
      shippingProtectionVariantIds = rawSpIds.map(String);
    }
  }

  // Check for unlinked account matches
  let unlinkMatches: { id: string; email: string; first_name: string | null; last_name: string | null; default_address: unknown }[] = [];
  if (auth.workspaceId && auth.loggedInCustomerId) {
    const { data: cust } = await admin.from("customers").select("id").eq("workspace_id", auth.workspaceId).eq("shopify_customer_id", auth.loggedInCustomerId).single();
    if (cust) {
      const { findUnlinkedMatches } = await import("@/lib/account-matching");
      const rawMatches = await findUnlinkedMatches(auth.workspaceId, cust.id, admin);
      if (rawMatches.length) {
        // Get full details for each match
        const matchIds = rawMatches.map(m => m.id).filter(Boolean);
        if (matchIds.length) {
          const { data: matchDetails } = await admin.from("customers")
            .select("id, email, first_name, last_name, default_address")
            .in("id", matchIds);
          unlinkMatches = (matchDetails || []).map(m => ({
            id: m.id,
            email: m.email,
            first_name: m.first_name,
            last_name: m.last_name,
            default_address: m.default_address,
          }));
        }
      }
    }
  }

  return jsonOk({
    ok: true,
    shop: auth.shop,
    logged_in_customer_id: auth.loggedInCustomerId,
    route,
    dunning_count: dunningCount,
    linked_account_count: linkedAccountCount,
    banned: portalBanned,
    customer: {
      firstName: customerFirstName,
      lastName: customerLastName,
      email: customerEmail,
    },
    config: {
      lockDays: Number(general.lock_days) || 7,
      shippingProtectionProductIds: shippingProtectionVariantIds,
      catalog,
      rewardsUrl: String(general.rewards_url || ""),
    },
    unlinked_matches: unlinkMatches,
  });
};
