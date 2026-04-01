import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

async function getAppstleCredentials(workspaceId: string): Promise<{ apiKey: string; shop: string } | null> {
  const admin = createAdminClient();
  const { data: workspace } = await admin
    .from("workspaces")
    .select("appstle_api_key_encrypted, shopify_myshopify_domain")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.appstle_api_key_encrypted || !workspace?.shopify_myshopify_domain) {
    return null;
  }

  return {
    apiKey: decrypt(workspace.appstle_api_key_encrypted),
    shop: workspace.shopify_myshopify_domain,
  };
}

export async function appstleSubscriptionAction(
  workspaceId: string,
  contractId: string,
  action: "pause" | "cancel" | "resume",
  cancelReason?: string,
  cancelledBy?: string,
): Promise<{ success: boolean; error?: string }> {
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    let res: Response;

    if (action === "cancel") {
      // Use DELETE endpoint with cancellationFeedback for proper reason tracking
      const params = new URLSearchParams();
      if (cancelReason) params.set("cancellationFeedback", cancelReason);
      const byLine = cancelledBy ? `by ${cancelledBy} on ShopCX.ai` : "via ShopCX.ai";
      params.set("cancellationNote", `Cancelled ${byLine} — ${cancelReason || "manual"}`);
      const endpoint = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/${contractId}?${params}`;
      res = await fetch(endpoint, {
        method: "DELETE",
        headers: { "X-API-Key": creds.apiKey },
      });
    } else {
      // Pause / Resume use the update-status PUT endpoint
      const statusMap: Record<string, string> = { pause: "PAUSED", resume: "ACTIVE" };
      const endpoint = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-status?contractId=${contractId}&status=${statusMap[action]}`;
      res = await fetch(endpoint, {
        method: "PUT",
        headers: { "X-API-Key": creds.apiKey },
      });
    }

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle ${action} error for contract ${contractId}:`, text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }

    // Update local subscription status
    const admin = createAdminClient();
    const localStatusMap: Record<string, string> = { pause: "paused", cancel: "cancelled", resume: "active" };
    await admin
      .from("subscriptions")
      .update({ status: localStatusMap[action], updated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId);

    return { success: true };
  } catch (err) {
    console.error(`Appstle ${action} failed:`, err);
    return { success: false, error: String(err) };
  }
}

export async function appstleSkipNextOrder(
  workspaceId: string,
  contractId: string,
): Promise<{ success: boolean; error?: string }> {
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-skip?contractId=${contractId}&api_key=${creds.apiKey}`,
      { method: "PUT", headers: { "X-API-Key": creds.apiKey } }
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle skip error for contract ${contractId}:`, text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error("Appstle skip failed:", err);
    return { success: false, error: String(err) };
  }
}

export async function appstleUpdateBillingInterval(
  workspaceId: string,
  contractId: string,
  interval: "DAY" | "WEEK" | "MONTH" | "YEAR",
  intervalCount: number,
): Promise<{ success: boolean; error?: string }> {
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-billing-interval?contractId=${contractId}&interval=${interval}&intervalCount=${intervalCount}&api_key=${creds.apiKey}`,
      { method: "PUT", headers: { "X-API-Key": creds.apiKey } }
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle frequency update error for contract ${contractId}:`, text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }

    // Update local record
    const admin = createAdminClient();
    await admin
      .from("subscriptions")
      .update({
        billing_interval: interval.toLowerCase(),
        billing_interval_count: intervalCount,
        updated_at: new Date().toISOString(),
      })
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId);

    return { success: true };
  } catch (err) {
    console.error("Appstle frequency update failed:", err);
    return { success: false, error: String(err) };
  }
}

// ── Dunning endpoints ──

export async function appstleGetUpcomingOrders(
  workspaceId: string,
  contractId: string,
): Promise<{ success: boolean; orders?: { id: string; billingDate: string; status: string }[]; error?: string }> {
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-billing-attempts/top-orders?contractId=${contractId}`,
      { method: "GET", headers: { "X-API-Key": creds.apiKey } }
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(`Appstle get upcoming orders error for contract ${contractId}:`, text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }

    const data = await res.json();
    return { success: true, orders: Array.isArray(data) ? data : [] };
  } catch (err) {
    console.error("Appstle get upcoming orders failed:", err);
    return { success: false, error: String(err) };
  }
}

export async function appstleAttemptBilling(
  workspaceId: string,
  billingAttemptId: string,
): Promise<{ success: boolean; error?: string }> {
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-billing-attempts/attempt-billing/${billingAttemptId}`,
      { method: "PUT", headers: { "X-API-Key": creds.apiKey } }
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle attempt billing error for ${billingAttemptId}:`, text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error("Appstle attempt billing failed:", err);
    return { success: false, error: String(err) };
  }
}

export async function appstleSkipUpcomingOrder(
  workspaceId: string,
  contractId: string,
): Promise<{ success: boolean; error?: string }> {
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-billing-attempts/skip-upcoming-order?subscriptionContractId=${contractId}&shop=${creds.shop}`,
      { method: "PUT", headers: { "X-API-Key": creds.apiKey } }
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle skip upcoming order error for contract ${contractId}:`, text);
      return { success: false, error: text || `Appstle API error: ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error("Appstle skip upcoming order failed:", err);
    return { success: false, error: String(err) };
  }
}

export async function appstleUnskipOrder(
  workspaceId: string,
  billingAttemptId: string,
): Promise<{ success: boolean; error?: string }> {
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-billing-attempts/unskip-order/${billingAttemptId}`,
      { method: "PUT", headers: { "X-API-Key": creds.apiKey } }
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle unskip order error for ${billingAttemptId}:`, text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error("Appstle unskip order failed:", err);
    return { success: false, error: String(err) };
  }
}

export async function appstleSwitchPaymentMethod(
  workspaceId: string,
  contractId: string,
  paymentMethodId: string,
): Promise<{ success: boolean; error?: string }> {
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-existing-payment-method?contractId=${contractId}&paymentMethodId=${encodeURIComponent(paymentMethodId)}`,
      {
        method: "PUT",
        headers: { "X-API-Key": creds.apiKey },
      }
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle switch payment method error for contract ${contractId}:`, text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error("Appstle switch payment method failed:", err);
    return { success: false, error: String(err) };
  }
}

export async function appstleSendPaymentUpdateEmail(
  workspaceId: string,
  contractId: string,
): Promise<{ success: boolean; error?: string }> {
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-payment-method?contractId=${contractId}`,
      { method: "PUT", headers: { "X-API-Key": creds.apiKey } }
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle send payment update email error for contract ${contractId}:`, text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error("Appstle send payment update email failed:", err);
    return { success: false, error: String(err) };
  }
}

export async function appstleAddFreeProduct(
  workspaceId: string,
  contractId: string,
  variantId: string,
  quantity: number = 1,
): Promise<{ success: boolean; error?: string }> {
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const params = new URLSearchParams({
      contractId,
      variantId,
      quantity: String(quantity),
      price: "0",
      isOneTimeProduct: "true",
    });
    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contract-add-line-item?${params}`,
      { method: "PUT", headers: { "X-API-Key": creds.apiKey } }
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle add free product error for contract ${contractId}:`, text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error("Appstle add free product failed:", err);
    return { success: false, error: String(err) };
  }
}

export async function appstleSwapProduct(
  workspaceId: string,
  contractId: string,
  oldVariantId: string,
  newVariantId: string,
): Promise<{ success: boolean; error?: string }> {
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  try {
    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-swap?contractId=${contractId}&oldVariantId=${oldVariantId}&newVariantId=${newVariantId}&api_key=${creds.apiKey}`,
      { method: "PUT", headers: { "X-API-Key": creds.apiKey } }
    );

    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      console.error(`Appstle swap error for contract ${contractId}:`, text);
      return { success: false, error: `Appstle API error: ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error("Appstle swap failed:", err);
    return { success: false, error: String(err) };
  }
}
