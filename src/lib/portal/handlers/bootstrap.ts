import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

export const bootstrap: RouteHandler = async ({ auth, route }) => {
  const admin = createAdminClient();

  // Enrich with dunning + linked account info if we have a workspace
  let dunningCount = 0;
  let linkedAccountCount = 0;

  if (auth.workspaceId && auth.loggedInCustomerId) {
    const { data: customer } = await admin.from("customers")
      .select("id")
      .eq("workspace_id", auth.workspaceId)
      .eq("shopify_customer_id", auth.loggedInCustomerId)
      .single();

    if (customer) {
      // Active dunning cycles
      const { count } = await admin.from("dunning_cycles")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", auth.workspaceId)
        .eq("customer_id", customer.id)
        .in("status", ["active", "skipped"]);
      dunningCount = count || 0;

      // Linked accounts
      const { data: link } = await admin.from("customer_links")
        .select("group_id")
        .eq("customer_id", customer.id)
        .single();
      if (link?.group_id) {
        const { count: linkCount } = await admin.from("customer_links")
          .select("id", { count: "exact", head: true })
          .eq("group_id", link.group_id);
        linkedAccountCount = Math.max(0, (linkCount || 1) - 1);
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
  });
};
