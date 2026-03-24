import { createAdminClient } from "@/lib/supabase/admin";

interface CustomerForScore {
  last_order_at: string | null;
  total_orders: number;
  ltv_cents: number;
  subscription_status: string;
}

export function calculateRetentionScore(customer: CustomerForScore): number {
  // Purchase recency (30%)
  let recencyScore = 10;
  if (customer.last_order_at) {
    const daysSince = Math.floor(
      (Date.now() - new Date(customer.last_order_at).getTime()) /
        (1000 * 60 * 60 * 24)
    );
    if (daysSince < 30) recencyScore = 100;
    else if (daysSince <= 90) recencyScore = 70;
    else if (daysSince <= 180) recencyScore = 40;
    else recencyScore = 10;
  }

  // Purchase frequency (25%)
  let frequencyScore = 0;
  const orders = customer.total_orders;
  if (orders > 10) frequencyScore = 100;
  else if (orders >= 5) frequencyScore = 70;
  else if (orders >= 2) frequencyScore = 40;
  else if (orders === 1) frequencyScore = 20;
  else frequencyScore = 0;

  // LTV (25%)
  let ltvScore = 20;
  const ltvDollars = customer.ltv_cents / 100;
  if (ltvDollars > 500) ltvScore = 100;
  else if (ltvDollars >= 200) ltvScore = 70;
  else if (ltvDollars >= 50) ltvScore = 40;
  else ltvScore = 20;

  // Subscription status (20%)
  let subScore = 30;
  switch (customer.subscription_status) {
    case "active":
      subScore = 100;
      break;
    case "paused":
      subScore = 50;
      break;
    case "cancelled":
      subScore = 20;
      break;
    case "never":
    default:
      subScore = 30;
      break;
  }

  const weighted =
    recencyScore * 0.3 +
    frequencyScore * 0.25 +
    ltvScore * 0.25 +
    subScore * 0.2;

  return Math.round(weighted);
}

export async function updateRetentionScores(
  workspaceId: string
): Promise<void> {
  const admin = createAdminClient();

  const { data: customers, error } = await admin
    .from("customers")
    .select("id, last_order_at, total_orders, ltv_cents, subscription_status")
    .eq("workspace_id", workspaceId);

  if (error || !customers) return;

  for (const customer of customers) {
    const score = calculateRetentionScore(customer);
    await admin
      .from("customers")
      .update({
        retention_score: score,
        updated_at: new Date().toISOString(),
      })
      .eq("id", customer.id);
  }
}
