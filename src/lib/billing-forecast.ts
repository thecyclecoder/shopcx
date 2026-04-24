// Billing forecast: one pending row per subscription
// Event-driven updates from Appstle webhooks ONLY (all mutations go through Appstle → webhook)

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

// ── Log a forecast change event (append-only audit trail) ──
export async function logForecastEvent(params: {
  workspaceId: string;
  forecastId: string;
  contractId: string;
  forecastDate: string; // YYYY-MM-DD
  eventType: string;
  deltaCents: number;
  description?: string;
}) {
  const admin = createAdminClient();
  await admin.from("billing_forecast_events").insert({
    workspace_id: params.workspaceId,
    forecast_id: params.forecastId,
    shopify_contract_id: params.contractId,
    forecast_date: params.forecastDate,
    event_type: params.eventType,
    delta_cents: params.deltaCents,
    description: params.description || null,
  });
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
  expectedDate: string;
  items: ForecastItem[];
  billingInterval?: string | null;
  billingIntervalCount?: number | null;
  createdFrom: string;
  source?: string;
  forecastType?: string; // renewal, dunning, paused
}) {
  const admin = createAdminClient();
  const revenueCents = calculateExpectedRevenue(params.items);
  const dateOnly = params.expectedDate.slice(0, 10);

  // Check for existing pending — upsert to enforce one-per-contract
  const existing = await getPendingForecast(params.workspaceId, params.contractId);
  if (existing) {
    await admin.from("billing_forecasts").update({
      expected_date: dateOnly,
      expected_revenue_cents: revenueCents,
      expected_items: params.items,
      billing_interval: params.billingInterval?.toLowerCase() || existing.billing_interval,
      billing_interval_count: params.billingIntervalCount || existing.billing_interval_count,
      updated_at: new Date().toISOString(),
    }).eq("id", existing.id);
    return existing.id;
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

  const { data: inserted } = await admin.from("billing_forecasts").insert({
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
    forecast_type: params.forecastType || "renewal",
    status: "pending",
    static_revenue_cents: revenueCents,
    static_date: dateOnly,
  }).select("id").single();

  return inserted?.id || null;
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

    // Log collection event
    await logForecastEvent({
      workspaceId: params.workspaceId,
      forecastId: forecast.id,
      contractId: params.contractId,
      forecastDate: forecast.expected_date,
      eventType: "billing_success",
      deltaCents: 0, // Not a delta — it's a resolution
      description: `Collected $${(params.actualRevenueCents / 100).toFixed(2)} (order ${params.orderNumber || "unknown"})`,
    });
  }

  // Create next forecast if we know the next billing date
  if (params.nextBillingDate && params.items) {
    const { data: sub } = await admin.from("subscriptions")
      .select("id, customer_id")
      .eq("workspace_id", params.workspaceId)
      .eq("shopify_contract_id", params.contractId)
      .maybeSingle();

    const newId = await createForecast({
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

    // Log the new forecast as a new_subscription event on that date
    if (newId) {
      await logForecastEvent({
        workspaceId: params.workspaceId,
        forecastId: newId,
        contractId: params.contractId,
        forecastDate: params.nextBillingDate.slice(0, 10),
        eventType: "new_subscription",
        deltaCents: calculateExpectedRevenue(params.items),
        description: "Next renewal forecast set after successful billing",
      });
    }
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
  if (forecast.status !== "pending") return; // Already resolved

  await admin.from("billing_forecasts").update({
    status: "failed",
    failure_reason: params.failureReason || null,
    billing_attempt_id: params.billingAttemptId || null,
    updated_at: new Date().toISOString(),
  }).eq("id", forecast.id);

  await logForecastEvent({
    workspaceId: params.workspaceId,
    forecastId: forecast.id,
    contractId: params.contractId,
    forecastDate: forecast.expected_date,
    eventType: "billing_failure",
    deltaCents: -(forecast.expected_revenue_cents || 0),
    description: params.failureReason || "Payment failed",
  });
}

// ── Mark forecast as cancelled ──
export async function forecastCancelled(workspaceId: string, contractId: string) {
  const admin = createAdminClient();
  const forecast = await getPendingForecast(workspaceId, contractId);
  if (!forecast) return; // Already resolved or doesn't exist — dedup

  await admin.from("billing_forecasts").update({
    status: "cancelled",
    change_type: "cancellation",
    updated_at: new Date().toISOString(),
  }).eq("id", forecast.id);

  await logForecastEvent({
    workspaceId,
    forecastId: forecast.id,
    contractId,
    forecastDate: forecast.expected_date,
    eventType: "cancellation",
    deltaCents: -(forecast.expected_revenue_cents || 0),
    description: "Subscription cancelled",
  });
}

// ── Mark forecast as paused ──
export async function forecastPaused(workspaceId: string, contractId: string) {
  const admin = createAdminClient();
  const forecast = await getPendingForecast(workspaceId, contractId);
  if (!forecast || forecast.status !== "pending") return;

  await admin.from("billing_forecasts").update({
    status: "paused",
    change_type: "pause",
    updated_at: new Date().toISOString(),
  }).eq("id", forecast.id);

  await logForecastEvent({
    workspaceId,
    forecastId: forecast.id,
    contractId,
    forecastDate: forecast.expected_date,
    eventType: "pause",
    deltaCents: -(forecast.expected_revenue_cents || 0),
    description: "Subscription paused",
  });
}

// ── Update forecast date (next order date changed) ──
export async function forecastDateChanged(workspaceId: string, contractId: string, newDate: string) {
  const admin = createAdminClient();
  const forecast = await getPendingForecast(workspaceId, contractId);
  if (!forecast || forecast.status !== "pending") return;

  const newDateOnly = newDate.slice(0, 10);
  if (forecast.expected_date === newDateOnly) return;

  const revCents = forecast.expected_revenue_cents || 0;

  // Log removal from old date
  await logForecastEvent({
    workspaceId,
    forecastId: forecast.id,
    contractId,
    forecastDate: forecast.expected_date,
    eventType: "date_change_out",
    deltaCents: -revCents,
    description: `Moved to ${newDateOnly}`,
  });

  // Update forecast
  await admin.from("billing_forecasts").update({
    previous_date: forecast.expected_date,
    expected_date: newDateOnly,
    change_type: "date_change",
    updated_at: new Date().toISOString(),
  }).eq("id", forecast.id);

  // Log addition to new date
  await logForecastEvent({
    workspaceId,
    forecastId: forecast.id,
    contractId,
    forecastDate: newDateOnly,
    eventType: "date_change_in",
    deltaCents: revCents,
    description: `Moved from ${forecast.expected_date}`,
  });
}

// ── Update forecast items/amount (subscription updated) ──
export async function forecastItemsChanged(workspaceId: string, contractId: string, items: ForecastItem[], nextBillingDate?: string | null) {
  const admin = createAdminClient();
  const forecast = await getPendingForecast(workspaceId, contractId);
  if (!forecast || forecast.status !== "pending") return;

  const newRevenue = calculateExpectedRevenue(items);
  const updates: Record<string, unknown> = {
    expected_items: items,
    updated_at: new Date().toISOString(),
  };

  if (newRevenue !== forecast.expected_revenue_cents) {
    const delta = newRevenue - (forecast.expected_revenue_cents || 0);
    updates.previous_revenue_cents = forecast.expected_revenue_cents;
    updates.expected_revenue_cents = newRevenue;
    updates.change_type = "item_change";

    await logForecastEvent({
      workspaceId,
      forecastId: forecast.id,
      contractId,
      forecastDate: forecast.expected_date,
      eventType: "item_change",
      deltaCents: delta,
      description: `Items changed: $${((forecast.expected_revenue_cents || 0) / 100).toFixed(2)} → $${(newRevenue / 100).toFixed(2)}`,
    });
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
