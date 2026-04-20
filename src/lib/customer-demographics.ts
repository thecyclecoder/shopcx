/**
 * Customer demographic analysis — pure logic (no AI, no external calls).
 * Derives buyer_type, health_priorities, and spend stats from order and
 * subscription history. Life stage is left to the orchestrator (needs
 * name inference age range).
 */

export type BuyerType =
  | "value_buyer"
  | "cautious_buyer"
  | "committed_subscriber"
  | "new_subscriber"
  | "lapsed_subscriber"
  | "one_time_buyer";

export type LifeStage =
  | "young_adult"
  | "family"
  | "empty_nester"
  | "retirement_age"
  | "unknown";

export type AgeRange =
  | "under_25"
  | "25-34"
  | "35-44"
  | "45-54"
  | "55-64"
  | "65+";

export interface OrderInput {
  total_cents?: number | null;
  created_at: string;
  line_items?: Array<{
    title?: string | null;
    sku?: string | null;
    quantity?: number | null;
  }> | null;
}

export interface SubscriptionInput {
  status?: string | null;
  created_at?: string | null;
  items?: unknown;
}

export interface OrderDemographics {
  buyer_type: BuyerType;
  health_priorities: string[];
  total_orders: number;
  total_spend_cents: number;
  subscription_tenure_days: number;
}

/**
 * Keyword → priority map. Matches against lowercased product title + SKU.
 * First match wins per priority (a product can contribute to multiple
 * priorities). Priorities are returned in insertion order by frequency.
 */
export const HEALTH_PRIORITY_KEYWORDS: Array<{
  priority: string;
  keywords: string[];
}> = [
  { priority: "energy", keywords: ["energy", "coffee", "instantco", "tabs", "creamer", "matcha", "b12"] },
  { priority: "inflammation", keywords: ["tabs", "turmeric", "curcumin", "omega", "fish oil", "anti-inflamm"] },
  { priority: "joint_health", keywords: ["joint", "collagen", "glucosamine", "mobility"] },
  { priority: "stress", keywords: ["ashwagandha", "ashw", "stress", "calm", "adaptogen"] },
  { priority: "sleep", keywords: ["sleep", "melatonin", "rest", "magnesium"] },
  { priority: "cognitive", keywords: ["focus", "brain", "nootropic", "mind", "memory", "ashwagandha"] },
  { priority: "immunity", keywords: ["immune", "defense", "elderberry", "zinc", "vitamin c"] },
  { priority: "weight_management", keywords: ["weight", "metabolism", "lean", "burn"] },
  { priority: "gut_health", keywords: ["gut", "probiotic", "digestive", "greens"] },
];

function matchPriorities(productText: string): string[] {
  const text = productText.toLowerCase();
  const matches = new Set<string>();
  for (const { priority, keywords } of HEALTH_PRIORITY_KEYWORDS) {
    if (keywords.some((k) => text.includes(k))) {
      matches.add(priority);
    }
  }
  return Array.from(matches);
}

export function analyzeOrderHistory(
  orders: OrderInput[],
  subscriptions: SubscriptionInput[],
): OrderDemographics {
  const now = Date.now();

  // Spend + order stats
  const total_orders = orders.length;
  const total_spend_cents = orders.reduce((sum, o) => sum + (o.total_cents || 0), 0);

  // Subscription tenure + status signals
  const activeSub = subscriptions.find(
    (s) => (s.status || "").toLowerCase() === "active",
  );
  const hadSub = subscriptions.length > 0;
  const anyCancelled = subscriptions.some((s) =>
    ["cancelled", "canceled", "inactive", "expired"].includes((s.status || "").toLowerCase()),
  );

  // Use first order date for tenure (subscription created_at can be stale from re-syncs)
  const firstOrderDate = orders
    .map((o) => o.created_at)
    .filter((c) => c && c.length > 0)
    .sort()[0];

  const subscription_tenure_days = firstOrderDate && hadSub
    ? Math.max(
        0,
        Math.floor((now - new Date(firstOrderDate).getTime()) / 86400000),
      )
    : 0;

  // Bundle preference (3+ unit orders / total orders)
  const bundleOrders = orders.filter((o) =>
    (o.line_items || []).some((li) => (li.quantity || 0) >= 3),
  );
  const bundleRate = total_orders > 0 ? bundleOrders.length / total_orders : 0;

  // Buyer type decision tree
  let buyer_type: BuyerType;
  if (activeSub) {
    buyer_type = subscription_tenure_days > 180 ? "committed_subscriber" : "new_subscriber";
  } else if (hadSub && anyCancelled) {
    buyer_type = "lapsed_subscriber";
  } else if (total_orders === 1) {
    buyer_type = "one_time_buyer";
  } else if (bundleRate > 0.6) {
    buyer_type = "value_buyer";
  } else {
    buyer_type = "cautious_buyer";
  }

  // Health priorities — aggregate across every line item, rank by frequency
  const priorityCounts = new Map<string, number>();
  for (const order of orders) {
    for (const li of order.line_items || []) {
      const text = `${li.title || ""} ${li.sku || ""}`;
      const matched = matchPriorities(text);
      for (const p of matched) {
        priorityCounts.set(p, (priorityCounts.get(p) || 0) + (li.quantity || 1));
      }
    }
  }
  const health_priorities = Array.from(priorityCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([priority]) => priority);

  return {
    buyer_type,
    health_priorities,
    total_orders,
    total_spend_cents,
    subscription_tenure_days,
  };
}

export function lifeStageFromAgeRange(age: AgeRange | null | undefined): LifeStage {
  switch (age) {
    case "65+":
      return "retirement_age";
    case "55-64":
      return "empty_nester";
    case "45-54":
    case "35-44":
      return "family";
    case "25-34":
    case "under_25":
      return "young_adult";
    default:
      return "unknown";
  }
}
