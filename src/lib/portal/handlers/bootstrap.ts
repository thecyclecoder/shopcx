import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

export const bootstrap: RouteHandler = async ({ auth, route }) => {
  const admin = createAdminClient();

  // Enrich with dunning + linked account info if we have a workspace
  let dunningCount = 0;
  let linkedAccountCount = 0;
  let customerFirstName = "";
  let customerLastName = "";
  let customerEmail = "";

  if (auth.workspaceId && auth.loggedInCustomerId) {
    const { data: customer } = await admin
      .from("customers")
      .select("id, first_name, last_name, email")
      .eq("workspace_id", auth.workspaceId)
      .eq("shopify_customer_id", auth.loggedInCustomerId)
      .single();

    if (customer) {
      customerFirstName = customer.first_name || "";
      customerLastName = customer.last_name || "";
      customerEmail = customer.email || "";

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
        "shopify_product_id, title, handle, image_url, variants"
      )
      .eq("workspace_id", auth.workspaceId)
      .in("shopify_product_id", productIds);

    if (products) {
      catalog = products.map((p) => ({
        productId: p.shopify_product_id,
        title: p.title,
        handle: p.handle,
        image: { src: p.image_url || "", alt: p.title },
        variants: Array.isArray(p.variants) ? p.variants : [],
      }));
    }
  }

  return jsonOk({
    ok: true,
    shop: auth.shop,
    logged_in_customer_id: auth.loggedInCustomerId,
    route,
    dunning_count: dunningCount,
    linked_account_count: linkedAccountCount,
    customer: {
      firstName: customerFirstName,
      lastName: customerLastName,
      email: customerEmail,
    },
    config: {
      lockDays: Number(general.lock_days) || 7,
      shippingProtectionProductIds:
        Array.isArray(general.shipping_protection_product_ids)
          ? general.shipping_protection_product_ids
          : [],
      catalog,
      rewardsUrl: String(general.rewards_url || ""),
    },
  });
};
