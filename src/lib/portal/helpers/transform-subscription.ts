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
  line_id?: string;
}

interface VariantInfo {
  id: string;
  image_url?: string;
}

interface ProductInfo {
  productImage: string;
  // variant_title → { id, image_url }
  variantsByTitle: Record<string, VariantInfo>;
  // sku → { id, image_url }
  variantsBySku: Record<string, VariantInfo>;
}

interface ProductMap {
  [productId: string]: ProductInfo;
}

export function transformSubscription(
  sub: Record<string, unknown>,
  productMap: ProductMap = {}
) {
  const items = Array.isArray(sub.items) ? (sub.items as DbItem[]) : [];

  const lines = items.map(item => {
    const pid = item.product_id || "";
    const product = productMap[pid];

    // Resolve variant ID: try direct → by SKU → by variant title
    let resolvedVariantId = item.variant_id || "";
    if (!resolvedVariantId && item.sku && product?.variantsBySku?.[item.sku]) {
      resolvedVariantId = product.variantsBySku[item.sku].id;
    }
    if (!resolvedVariantId && item.variant_title && product?.variantsByTitle?.[item.variant_title]) {
      resolvedVariantId = product.variantsByTitle[item.variant_title].id;
    }

    // Resolve variant image: by title → by SKU → product image
    const variantByTitle = product?.variantsByTitle?.[item.variant_title || ""];
    const variantBySku = product?.variantsBySku?.[item.sku || ""];
    const imageUrl = variantByTitle?.image_url || variantBySku?.image_url || product?.productImage || "";

    return {
      id: item.line_id || "",
      title: item.title || "Item",
      variantTitle: item.variant_title || "",
      quantity: item.quantity || 1,
      variantId: resolvedVariantId,
      productId: pid,
      sku: item.sku || "",
      currentPrice: {
        amount: String(((item.price_cents || 0) / 100).toFixed(2)),
        currencyCode: "USD",
      },
      variantImage: {
        transformedSrc: imageUrl,
      },
    };
  });

  return {
    id: sub.shopify_contract_id || sub.id,
    shopify_contract_id: sub.shopify_contract_id,
    status: String(sub.status || "active").toUpperCase(),
    lastPaymentStatus: String(sub.last_payment_status || "SUCCEEDED").toUpperCase(),
    billingPolicy: {
      interval: String(sub.billing_interval || "WEEK").toUpperCase(),
      intervalCount: Number(sub.billing_interval_count) || 4,
    },
    nextBillingDate: sub.next_billing_date || null,
    pause_resume_at: sub.pause_resume_at || null,
    lines,
    createdAt: sub.created_at,
    updatedAt: sub.updated_at,
    deliveryMethod: sub.delivery_method || null,
  };
}

interface DbVariant {
  id?: string;
  title?: string;
  sku?: string;
  image_url?: string;
}

export async function getProductMap(
  admin: ReturnType<typeof import("@/lib/supabase/admin").createAdminClient>,
  workspaceId: string,
  productIds: string[]
): Promise<ProductMap> {
  if (!productIds.length) return {};

  const { data: products } = await admin
    .from("products")
    .select("shopify_product_id, image_url, variants")
    .eq("workspace_id", workspaceId)
    .in("shopify_product_id", productIds);

  const map: ProductMap = {};
  for (const p of products || []) {
    const variantsByTitle: Record<string, VariantInfo> = {};
    const variantsBySku: Record<string, VariantInfo> = {};
    const variants = Array.isArray(p.variants) ? (p.variants as DbVariant[]) : [];

    for (const v of variants) {
      const info: VariantInfo = { id: v.id || "", image_url: v.image_url };
      if (v.title) variantsByTitle[v.title] = info;
      if (v.sku) variantsBySku[v.sku] = info;
    }

    map[p.shopify_product_id] = {
      productImage: p.image_url || "",
      variantsByTitle,
      variantsBySku,
    };
  }
  return map;
}
