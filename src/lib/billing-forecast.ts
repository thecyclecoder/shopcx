// Billing forecast: one pending row per subscription
// Event-driven updates from Appstle webhooks

import { createAdminClient } from "@/lib/supabase/admin";

interface ForecastItem {
  title: string;
  sku: string | null;
  quantity: number;
  price_cents: number;
  variant_title?: string | null;
}

// ── Calculate expected revenue from line items (excludes shipping protection) ──
export function calculateExpectedRevenue(items: ForecastItem[]): number {
  return items
    .filter(i => i.sku !== "Insure01")
    .reduce((sum, i) => sum + (i.price_cents || 0) * (i.quantity || 1), 0);
}

// ── Get the pending forecast for a contract ──
export async function getPendingForecast(workspaceId: string, contractId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("billing_forecasts")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .eq("status", "pending")
    .maybeSingle();
  return data;
}

// ── Create a new pending forecast ──
export async function createForecast(params: {
  workspaceId: string;
  contractId: string;
  subscriptionId?: string | null;
  customerId?: string | null;
  expectedDate: string; // ISO date or datetime
  items: ForecastItem[];
  billingInterval?: string | null;
  billingIntervalCount?: number | null;
  createdFrom: string;
  source?: string; // webhook, seed, portal, agent, system, dunning
}) {
  const admin = createAdminClient();
  const revenueCents = calculateExpectedRevenue(params.items);
  const dateOnly = params.expectedDate.slice(0, 10); // YYYY-MM-DD

  // Check for existing pending — upsert to enforce one-per-contract
  const existing = await getPendingForecast(params.workspaceId, params.contractId);
  if (existing) {
    // Update instead of insert
    await admin.from("billing_forecasts").update({
      expected_date: dateOnly,
      expected_revenue_cents: revenueCents,
      expected_items: params.items,
      billing_interval: params.billingInterval?.toLowerCase() || existing.billing_interval,
      billing_interval_count: params.billingIntervalCount || existing.billing_interval_count,
      updated_at: new Date().toISOString(),
    }).eq("id", existing.id);
    return;
  }

  // Look up subscription_id if not provided
  let subId = params.subscriptionId;
  if (!subId) {
    const { data: sub } = await admin.from("subscriptions")
      .select("id")
      .eq("workspace_id", params.workspaceId)
      .eq("shopify_contract_id", params.contractId)
      .maybeSingle();
    subId = sub?.id || null;
  }

  await admin.from("billing_forecasts").insert({
    workspace_id: params.workspaceId,
    shopify_contract_id: params.contractId,
    subscription_id: subId,
    customer_id: params.customerId,
    expected_date: dateOnly,
    expected_revenue_cents: revenueCents,
    expected_items: params.items,
    billing_interval: params.billingInterval?.toLowerCase() || null,
    billing_interval_count: params.billingIntervalCount || null,
    created_from: params.createdFrom,
    source: params.source || "webhook",
    status: "pending",
  });
}

// ── Mark forecast as collected (billing success) ──
export async function forecastCollected(params: {
  workspaceId: string;
  contractId: string;
  actualRevenueCents: number;
  orderId?: string | null;
  orderNumber?: string | null;
  billingAttemptId?: string | null;
  nextBillingDate?: string | null;
  items?: ForecastItem[];
  billingInterval?: string | null;
  billingIntervalCount?: number | null;
  source?: string;
}) {
  const admin = createAdminClient();
  const forecast = await getPendingForecast(params.workspaceId, params.contractId);

  if (forecast) {
    await admin.from("billing_forecasts").update({
      status: "collected",
      actual_revenue_cents: params.actualRevenueCents,
      collected_at: new Date().toISOString(),
      order_id: params.orderId || null,
      order_number: params.orderNumber || null,
      billing_attempt_id: params.billingAttemptId || null,
      updated_at: new Date().toISOString(),
    }).eq("id", forecast.id);
  }

  // Create next forecast if we know the next billing date
  if (params.nextBillingDate && params.items) {
    // Look up sub for customer_id
    const { data: sub } = await admin.from("subscriptions")
      .select("id, customer_id")
      .eq("workspace_id", params.workspaceId)
      .eq("shopify_contract_id", params.contractId)
      .maybeSingle();

    await createForecast({
      workspaceId: params.workspaceId,
      contractId: params.contractId,
      subscriptionId: sub?.id,
      customerId: sub?.customer_id,
      expectedDate: params.nextBillingDate,
      items: params.items,
      billingInterval: params.billingInterval,
      billingIntervalCount: params.billingIntervalCount,
      createdFrom: "billing_success",
      source: params.source || "webhook",
    });
  }
}

// ── Mark forecast as failed (billing failure) ──
export async function forecastFailed(params: {
  workspaceId: string;
  contractId: string;
  failureReason?: string | null;
  billingAttemptId?: string | null;
}) {
  const admin = createAdminClient();
  const forecast = await getPendingForecast(params.workspaceId, params.contractId);
  if (!forecast) return;

  await admin.from("billing_forecasts").update({
    status: "failed",
    failure_reason: params.failureReason || null,
    billing_attempt_id: params.billingAttemptId || null,
    updated_at: new Date().toISOString(),
  }).eq("id", forecast.id);
}

// ── Mark forecast as cancelled ──
export async function forecastCancelled(workspaceId: string, contractId: string) {
  const admin = createAdminClient();
  const forecast = await getPendingForecast(workspaceId, contractId);
  if (!forecast) return;

  await admin.from("billing_forecasts").update({
    status: "cancelled",
    change_type: "cancellation",
    updated_at: new Date().toISOString(),
  }).eq("id", forecast.id);
}

// ── Mark forecast as paused ──
export async function forecastPaused(workspaceId: string, contractId: string) {
  const admin = createAdminClient();
  const forecast = await getPendingForecast(workspaceId, contractId);
  if (!forecast) return;

  await admin.from("billing_forecasts").update({
    status: "paused",
    change_type: "pause",
    updated_at: new Date().toISOString(),
  }).eq("id", forecast.id);
}

// ── Update forecast date (next order date changed) ──
export async function forecastDateChanged(workspaceId: string, contractId: string, newDate: string) {
  const admin = createAdminClient();
  const forecast = await getPendingForecast(workspaceId, contractId);
  if (!forecast) return;

  const newDateOnly = newDate.slice(0, 10);
  if (forecast.expected_date === newDateOnly) return; // No change

  await admin.from("billing_forecasts").update({
    previous_date: forecast.expected_date,
    expected_date: newDateOnly,
    change_type: "date_change",
    updated_at: new Date().toISOString(),
  }).eq("id", forecast.id);
}

// ── Update forecast items/amount (subscription updated) ──
export async function forecastItemsChanged(workspaceId: string, contractId: string, items: ForecastItem[], nextBillingDate?: string | null) {
  const admin = createAdminClient();
  const forecast = await getPendingForecast(workspaceId, contractId);
  if (!forecast) return;

  const newRevenue = calculateExpectedRevenue(items);
  const updates: Record<string, unknown> = {
    expected_items: items,
    updated_at: new Date().toISOString(),
  };

  if (newRevenue !== forecast.expected_revenue_cents) {
    updates.previous_revenue_cents = forecast.expected_revenue_cents;
    updates.expected_revenue_cents = newRevenue;
    updates.change_type = "item_change";
  }

  if (nextBillingDate) {
    const newDateOnly = nextBillingDate.slice(0, 10);
    if (forecast.expected_date !== newDateOnly) {
      updates.previous_date = forecast.expected_date;
      updates.expected_date = newDateOnly;
      if (!updates.change_type) updates.change_type = "date_change";
    }
  }

  await admin.from("billing_forecasts").update(updates).eq("id", forecast.id);
}
