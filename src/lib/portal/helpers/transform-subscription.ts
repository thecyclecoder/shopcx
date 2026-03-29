// Transform our DB subscription shape into the contract shape the portal frontend expects
// This bridges: DB (snake_case, items[], price_cents) → Frontend (camelCase, lines[], MoneyV2)

interface DbItem {
  sku?: string;
  title?: string;
  quantity?: number;
  product_id?: string;
  variant_id?: string;
  price_cents?: number;
  selling_plan?: string;
  variant_title?: string;
}

interface ProductImageMap {
  [productId: string]: string; // product_id → image_url
}

export function transformSubscription(
  sub: Record<string, unknown>,
  productImages: ProductImageMap = {}
) {
  const items = Array.isArray(sub.items) ? (sub.items as DbItem[]) : [];

  // Transform items → lines (the shape the frontend card expects)
  const lines = items.map(item => ({
    title: item.title || "Item",
    variantTitle: item.variant_title || "",
    quantity: item.quantity || 1,
    variantId: item.variant_id || "",
    productId: item.product_id || "",
    sku: item.sku || "",
    currentPrice: {
      amount: String(((item.price_cents || 0) / 100).toFixed(2)),
      currencyCode: "USD",
    },
    variantImage: {
      transformedSrc: productImages[item.product_id || ""] || "",
    },
  }));

  return {
    // Identity
    id: sub.shopify_contract_id || sub.id,
    shopify_contract_id: sub.shopify_contract_id,

    // Status
    status: String(sub.status || "active").toUpperCase(),
    lastPaymentStatus: String(sub.last_payment_status || "SUCCEEDED").toUpperCase(),

    // Billing
    billingPolicy: {
      interval: String(sub.billing_interval || "WEEK").toUpperCase(),
      intervalCount: Number(sub.billing_interval_count) || 4,
    },
    nextBillingDate: sub.next_billing_date || null,

    // Pause
    pause_resume_at: sub.pause_resume_at || null,

    // Lines (transformed from items)
    lines,

    // Timestamps
    createdAt: sub.created_at,
    updatedAt: sub.updated_at,

    // Delivery (stub for address card)
    deliveryMethod: sub.delivery_method || null,
  };
}

export async function getProductImageMap(
  admin: ReturnType<typeof import("@/lib/supabase/admin").createAdminClient>,
  workspaceId: string,
  productIds: string[]
): Promise<ProductImageMap> {
  if (!productIds.length) return {};

  const { data: products } = await admin
    .from("products")
    .select("shopify_product_id, image_url")
    .eq("workspace_id", workspaceId)
    .in("shopify_product_id", productIds);

  const map: ProductImageMap = {};
  for (const p of products || []) {
    if (p.image_url) map[p.shopify_product_id] = p.image_url;
  }
  return map;
}
