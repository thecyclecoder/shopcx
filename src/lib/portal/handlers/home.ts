import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { findCustomer } from "@/lib/portal/helpers";

export const home: RouteHandler = async ({ auth, route }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);

  let activeSubCount = 0;
  let needsAttentionCount = 0;

  if (customer && auth.workspaceId) {
    const admin = createAdminClient();
    const { count: active } = await admin.from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", auth.workspaceId)
      .eq("customer_id", customer.id)
      .eq("status", "active");
    activeSubCount = active || 0;

    const { count: failed } = await admin.from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", auth.workspaceId)
      .eq("customer_id", customer.id)
      .eq("last_payment_status", "failed");
    needsAttentionCount = failed || 0;
  }

  return jsonOk({
    ok: true,
    shop: auth.shop,
    logged_in_customer_id: auth.loggedInCustomerId,
    route,
    active_sub_count: activeSubCount,
    needs_attention_count: needsAttentionCount,
  });
};
