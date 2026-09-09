/**
 * Handler for Shopify's `subscription_billing_attempts/{success,failure,challenged}` webhooks.
 *
 * ⭐ RECORDS ONLY — deliberately does NOT drive dunning yet.
 *
 * Dunning's sole failure trigger today is APPSTLE's webhook relay
 * (`/api/webhooks/appstle/[workspaceId]`).
 *
 * The EXPECTATION (CEO, 2026-09-09) is that these webhooks are scoped to the app that CREATED
 * the contract, so Appstle's contracts will never reach us and there is no double-trigger risk.
 * That is well supported: `subscriptionContracts` already returns EMPTY to us because the scope
 * is `read_OWN_subscription_contracts`, and the same app-ownership model governs the topic.
 *
 * But "expected" is not "measured", and the failure mode if it is wrong — every Appstle failure
 * dunned twice, cards re-rotated, customers re-emailed mid-cycle — is bad enough to be worth one
 * cheap observation window. Appstle contracts fail constantly (387 cycles are in dunning right
 * now), so the answer arrives on its own within hours: any row here whose
 * `resolved_subscription_id` is NULL is an Appstle contract reaching us, and the expectation was
 * wrong. No rows with a null resolution = confirmed, and dunning can be wired straight through.
 *
 * Once ShopCX owns billing, this becomes the real dunning entry point and the provenance
 * trail for every renewal outcome. See docs/brain/lifecycles/shopcx-subscriptions.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";

/** Strip a Shopify GID down to its numeric id — our mirror stores the bare id. */
function bareId(gid: unknown): string | null {
  if (!gid) return null;
  const s = String(gid);
  const m = s.match(/\/(\d+)(?:\?|$)/);
  return m ? m[1] : s;
}

export async function handleBillingAttemptEvent(
  workspaceId: string,
  payload: Record<string, unknown>,
  topic: string,
): Promise<void> {
  const admin = createAdminClient();

  const contractGid =
    (payload.admin_graphql_api_subscription_contract_id as string | undefined) ??
    (payload.subscription_contract_id as string | undefined) ??
    null;
  const contractId = bareId(contractGid);

  // Resolve to OUR subscription if we have one. A miss is information, not an error.
  let resolvedSubscriptionId: string | null = null;
  if (contractId) {
    const { data: sub } = await admin
      .from("subscriptions")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId)
      .maybeSingle();
    resolvedSubscriptionId = sub?.id ?? null;
  }

  const { error } = await admin.from("shopify_billing_attempt_events").insert({
    workspace_id: workspaceId,
    topic,
    shopify_contract_id: contractId,
    billing_attempt_id: bareId(payload.id),
    admin_graphql_api_id: (payload.admin_graphql_api_id as string | undefined) ?? null,
    order_id: bareId(payload.order_id ?? payload.admin_graphql_api_order_id),
    error_code: (payload.error_code as string | undefined) ?? null,
    error_message: (payload.error_message as string | undefined) ?? null,
    resolved_subscription_id: resolvedSubscriptionId,
    payload,
  });
  if (error) {
    console.error(`[billing-attempt-webhook] insert failed for ${topic} contract=${contractId}:`, error.message);
    return;
  }

  // Loud on purpose: this line is how we learn whether Appstle-owned contracts reach us.
  console.log(
    `[billing-attempt-webhook] ${topic} contract=${contractId ?? "?"} ` +
      `ours=${resolvedSubscriptionId ? "YES" : "no"} err=${payload.error_code ?? "-"} ` +
      `— RECORDED ONLY, dunning not triggered`,
  );
}
