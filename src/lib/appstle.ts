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
): Promise<{ success: boolean; error?: string }> {
  const creds = await getAppstleCredentials(workspaceId);
  if (!creds) return { success: false, error: "Appstle not configured" };

  // Appstle v2 API: PUT with query params
  const statusMap: Record<string, string> = { pause: "PAUSED", cancel: "CANCELLED", resume: "ACTIVE" };
  const appstleStatus = statusMap[action];
  const endpoint = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-status?contractId=${contractId}&status=${appstleStatus}`;

  try {
    const res = await fetch(endpoint, {
      method: "PUT",
      headers: {
        "X-API-Key": creds.apiKey,
      },
    });

    // 204 = success (no content body)
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
