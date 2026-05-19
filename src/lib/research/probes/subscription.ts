/**
 * Subscription state probe — used by verify_subscription_changes and
 * any future recipe that needs the live, OG-source-of-truth view of a
 * customer's subscriptions.
 *
 * Returns our DB shape (kept fresh by Appstle webhooks) PLUS, for any
 * contract_id explicitly requested, a forced refresh from Appstle to
 * catch webhook lag.
 */

import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface SubState {
  contract_id: string;
  status: string;                                  // 'active' | 'paused' | 'cancelled'
  billing_interval: string;                        // 'day' | 'week' | 'month' | 'year'
  billing_interval_count: number;
  next_billing_date: string | null;
  pause_resume_at: string | null;
  items: Array<{
    variant_id?: string;
    title?: string;
    variant_title?: string;
    quantity?: number;
    price_cents?: number;
    sku?: string;
  }>;
  applied_discount_codes: string[];
  /** Source: 'db' (subscriptions table) or 'appstle_live' (forced refresh). */
  source: "db" | "appstle_live";
}

export async function getSubsForCustomer(workspaceId: string, customerId: string): Promise<SubState[]> {
  const admin = createAdminClient();
  const linkedIds = await resolveLinkedIds(admin, customerId);
  const { data } = await admin.from("subscriptions")
    .select("shopify_contract_id, status, billing_interval, billing_interval_count, next_billing_date, pause_resume_at, items, applied_discounts")
    .eq("workspace_id", workspaceId)
    .in("customer_id", linkedIds);
  return (data || []).map(rowToSubState);
}

/**
 * Force-refresh a single contract from Appstle. Use when our DB might
 * be stale (recent webhook hasn't fired yet) and the verification needs
 * to be definitive.
 */
export async function getLiveSubFromAppstle(workspaceId: string, contractId: string): Promise<SubState | null> {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", workspaceId).single();
  if (!ws?.appstle_api_key_encrypted) return null;
  const { decrypt } = await import("@/lib/crypto");
  const apiKey = decrypt(ws.appstle_api_key_encrypted as string);
  try {
    const r = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${apiKey}`,
      { headers: { "X-API-Key": apiKey } },
    );
    if (!r.ok) return null;
    const d = await r.json();
    return {
      contract_id: String(d.id || contractId),
      status: String(d.status || "").toLowerCase(),
      billing_interval: String(d.billingPolicy?.interval || "").toLowerCase(),
      billing_interval_count: Number(d.billingPolicy?.intervalCount || 0),
      next_billing_date: d.nextBillingDate || null,
      pause_resume_at: d.pauseResumeAt || null,
      items: (d.lines?.nodes || d.lines || []).map((l: Record<string, unknown>) => ({
        variant_id: (l.variantId as string)?.split("/").pop() || undefined,
        title: l.title as string,
        variant_title: l.variantTitle as string,
        quantity: Number(l.quantity) || undefined,
        price_cents: l.currentPrice ? Math.round(Number((l.currentPrice as { amount?: number }).amount || 0) * 100) : undefined,
        sku: l.sku as string,
      })),
      applied_discount_codes: (d.discounts?.nodes || d.discounts || []).map((x: { title?: string }) => x.title).filter(Boolean) as string[],
      source: "appstle_live",
    };
  } catch {
    return null;
  }
}

function rowToSubState(s: Record<string, unknown>): SubState {
  return {
    contract_id: s.shopify_contract_id as string,
    status: (s.status as string) || "unknown",
    billing_interval: (s.billing_interval as string) || "",
    billing_interval_count: Number(s.billing_interval_count) || 0,
    next_billing_date: (s.next_billing_date as string) || null,
    pause_resume_at: (s.pause_resume_at as string) || null,
    items: (s.items as SubState["items"]) || [],
    applied_discount_codes: ((s.applied_discounts as Array<{ title?: string }>) || []).map(d => d.title).filter(Boolean) as string[],
    source: "db",
  };
}

async function resolveLinkedIds(admin: Admin, customerId: string): Promise<string[]> {
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", customerId).maybeSingle();
  if (!link?.group_id) return [customerId];
  const { data: g } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
  return (g || []).map(r => r.customer_id as string);
}
