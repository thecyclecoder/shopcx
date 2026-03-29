import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

export const dunningStatus: RouteHandler = async ({ auth, route, url }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const contractId = url.searchParams.get("contractId") || "";
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);

  const admin = createAdminClient();

  // Latest dunning cycle for this contract
  const { data: cycle } = await admin.from("dunning_cycles")
    .select("*")
    .eq("workspace_id", auth.workspaceId)
    .eq("shopify_contract_id", contractId)
    .order("cycle_number", { ascending: false })
    .limit(1)
    .single();

  if (!cycle) {
    return jsonOk({ ok: true, route, contractId, in_recovery: false });
  }

  // Payment failures for timeline
  const { data: failures } = await admin.from("payment_failures")
    .select("payment_method_last4, attempt_type, succeeded, created_at")
    .eq("workspace_id", auth.workspaceId)
    .eq("shopify_contract_id", contractId)
    .order("created_at", { ascending: false })
    .limit(10);

  const inRecovery = ["active", "skipped"].includes(cycle.status);
  const failed = ["paused", "exhausted"].includes(cycle.status);

  // Payment update URL
  const { data: ws } = await admin.from("workspaces")
    .select("shopify_myshopify_domain")
    .eq("id", auth.workspaceId)
    .single();

  return jsonOk({
    ok: true, route, contractId,
    in_recovery: inRecovery,
    recovery_failed: failed,
    recovered: cycle.status === "recovered",
    cycle: {
      cycle_number: cycle.cycle_number,
      status: cycle.status,
      cards_tried: cycle.cards_tried,
      payment_update_sent: cycle.payment_update_sent,
      payment_update_sent_at: cycle.payment_update_sent_at,
      skipped_at: cycle.skipped_at,
      paused_at: cycle.paused_at,
      recovered_at: cycle.recovered_at,
    },
    payment_failures: failures || [],
    payment_update_url: ws?.shopify_myshopify_domain ? `https://${ws.shopify_myshopify_domain}/account` : null,
  });
};
