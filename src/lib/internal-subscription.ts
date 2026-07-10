/**
 * Internal subscription engine.
 *
 * Subscriptions with `is_internal = true` are managed entirely by
 * shopcx — no Appstle in the loop. Every Appstle helper checks the
 * flag and, if set, delegates to one of the handlers below. Same
 * function signatures + return shape as Appstle so callers don't
 * branch (the existing portal UI, the action_executor's direct
 * actions, the Sonnet-orchestrator paths — all work unchanged).
 *
 * State the handlers mutate:
 *   subscriptions.status                 active | paused | cancelled
 *   subscriptions.next_billing_date      ISO date string
 *   subscriptions.billing_interval       day | week | month | year (lowercase per our DB convention)
 *   subscriptions.billing_interval_count integer
 *   subscriptions.items                  JSONB array of line items
 *   subscriptions.applied_discounts      JSONB array
 *   subscriptions.pause_resume_at        ISO timestamp (for timed pauses)
 *
 * Anything that requires a Braintree charge (attemptBilling) is
 * stubbed for now — the renewal scheduler lands in a future commit.
 */
import { createAdminClient } from "@/lib/supabase/admin";

type ActionResult = { success: boolean; error?: string };

interface SubRow {
  id: string;
  status: string;
  next_billing_date: string | null;
  billing_interval: string | null;
  billing_interval_count: number | null;
  items: Array<Record<string, unknown>> | null;
  applied_discounts: Array<Record<string, unknown>> | null;
  customer_id: string | null;
}

async function loadInternalSub(workspaceId: string, contractId: string): Promise<SubRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("subscriptions")
    .select(
      "id, status, next_billing_date, billing_interval, billing_interval_count, items, applied_discounts, customer_id, is_internal",
    )
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .maybeSingle();
  if (!data) return null;
  if (!data.is_internal) return null;
  // is_internal is in the select but we don't carry it on SubRow
  return {
    id: data.id as string,
    status: data.status as string,
    next_billing_date: data.next_billing_date as string | null,
    billing_interval: data.billing_interval as string | null,
    billing_interval_count: data.billing_interval_count as number | null,
    items: (data.items as Array<Record<string, unknown>>) || [],
    applied_discounts: (data.applied_discounts as Array<Record<string, unknown>>) || [],
    customer_id: data.customer_id as string | null,
  };
}

/**
 * Returns true if this subscription is managed internally (no Appstle
 * round-trip needed). Cheap — used as a guard at the top of every
 * Appstle helper. Returns false when the sub isn't found so the legacy
 * Appstle path is the safe default.
 */
export async function isInternalSubscription(workspaceId: string, contractId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("subscriptions")
    .select("is_internal")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .maybeSingle();
  return !!data?.is_internal;
}

// Bump the customer's overall subscription_status to reflect the
// active/paused/cancelled mix on their account. Mirrors what
// appstleSubscriptionAction does so the customer page stays accurate.
async function syncCustomerSubscriptionStatus(customerId: string): Promise<void> {
  const admin = createAdminClient();
  const { data: subs } = await admin
    .from("subscriptions")
    .select("status")
    .eq("customer_id", customerId);
  const statuses = new Set((subs || []).map((s) => s.status));
  const next = statuses.has("active") ? "active"
    : statuses.has("paused") ? "paused"
    : statuses.has("cancelled") ? "cancelled"
    : "never";
  await admin
    .from("customers")
    .update({ subscription_status: next, updated_at: new Date().toISOString() })
    .eq("id", customerId);
}

// ────────────────────────────────────────────────────────────────────
// Status: pause / resume / cancel
// ────────────────────────────────────────────────────────────────────

export async function internalSubscriptionAction(
  workspaceId: string,
  contractId: string,
  action: "pause" | "cancel" | "resume",
): Promise<ActionResult> {
  const admin = createAdminClient();
  const sub = await loadInternalSub(workspaceId, contractId);
  if (!sub) return { success: false, error: "Internal subscription not found" };

  const statusMap: Record<string, string> = { pause: "paused", cancel: "cancelled", resume: "active" };
  await admin
    .from("subscriptions")
    .update({ status: statusMap[action], updated_at: new Date().toISOString() })
    .eq("id", sub.id);
  if (sub.customer_id) await syncCustomerSubscriptionStatus(sub.customer_id);
  return { success: true };
}

// ────────────────────────────────────────────────────────────────────
// Schedule mutations
// ────────────────────────────────────────────────────────────────────

export async function internalSubSkipNextOrder(workspaceId: string, contractId: string): Promise<ActionResult> {
  const admin = createAdminClient();
  const sub = await loadInternalSub(workspaceId, contractId);
  if (!sub) return { success: false, error: "Internal subscription not found" };

  const interval = (sub.billing_interval || "month").toLowerCase();
  const count = sub.billing_interval_count || 1;
  const base = sub.next_billing_date ? new Date(sub.next_billing_date) : new Date();
  const next = advanceDate(base, interval, count);
  await admin
    .from("subscriptions")
    .update({ next_billing_date: next.toISOString(), updated_at: new Date().toISOString() })
    .eq("id", sub.id);
  return { success: true };
}

export async function internalSubUpdateBillingInterval(
  workspaceId: string,
  contractId: string,
  interval: "DAY" | "WEEK" | "MONTH" | "YEAR",
  intervalCount: number,
): Promise<ActionResult> {
  const admin = createAdminClient();
  const sub = await loadInternalSub(workspaceId, contractId);
  if (!sub) return { success: false, error: "Internal subscription not found" };

  const normalized = String(interval).toUpperCase();
  if (!["DAY", "WEEK", "MONTH", "YEAR"].includes(normalized)) {
    return { success: false, error: `Invalid interval: ${interval}` };
  }
  await admin
    .from("subscriptions")
    .update({
      billing_interval: normalized.toLowerCase(),
      billing_interval_count: intervalCount,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sub.id);
  return { success: true };
}

export async function internalSubUpdateNextBillingDate(
  workspaceId: string,
  contractId: string,
  date: string,
): Promise<ActionResult> {
  const admin = createAdminClient();
  const sub = await loadInternalSub(workspaceId, contractId);
  if (!sub) return { success: false, error: "Internal subscription not found" };

  const iso = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`).toISOString() : new Date(date).toISOString();
  await admin
    .from("subscriptions")
    .update({ next_billing_date: iso, updated_at: new Date().toISOString() })
    .eq("id", sub.id);
  return { success: true };
}

// ────────────────────────────────────────────────────────────────────
// Item mutations
// ────────────────────────────────────────────────────────────────────

type Item = {
  /** Canonical = product_variants.id (UUID). We never store Shopify variant ids
   *  on internal subs; Shopify is being sunset. */
  variant_id?: string | number;
  product_id?: string;
  title?: string;
  variant_title?: string;
  quantity?: number;
  /** Grandfathered locked base (pre-discount). Absent → price derived live from
   *  the catalog + pricing rule by the engine (src/lib/pricing.ts). */
  price_override_cents?: number | null;
  /** @deprecated baked price — no longer written; the pricing engine derives it. */
  price_cents?: number;
  sku?: string;
  selling_plan?: string | null;
  line_id?: string;
  /** True → a $0 gift line. The pricing engine forces `unit_cents: 0`. */
  is_gift?: boolean;
  /** True → rides the next renewal order, then the renewal engine drops it. */
  one_time_next_renewal?: boolean;
};

const VARIANT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ResolvedVariant {
  id: string;
  product_id: string;
  title: string;
  variant_title: string;
  sku: string | null;
}

/**
 * Resolve a variant the catalog way: accept either our UUID (`product_variants.id`)
 * or a legacy Shopify variant id, and always return the canonical UUID + catalog
 * metadata. Internal sub items reference the UUID — never the Shopify id.
 */
async function resolveVariant(variantIdOrShopify: string): Promise<ResolvedVariant | null> {
  const admin = createAdminClient();
  const raw = String(variantIdOrShopify || "");
  if (!raw) return null;
  const col = VARIANT_UUID_RE.test(raw) ? "id" : "shopify_variant_id";
  const { data: v } = await admin
    .from("product_variants")
    .select("id, product_id, title, sku")
    .eq(col, raw)
    .maybeSingle();
  if (!v) return null;
  // Resolve the product title with a direct lookup rather than a PostgREST
  // embed — the `products(title)` embed intermittently returned null (the gift
  // line then displayed as a bare "Gift"), so a two-step read is more reliable.
  let productTitle: string | undefined;
  if (v.product_id) {
    const { data: p } = await admin.from("products").select("title").eq("id", v.product_id).maybeSingle();
    productTitle = (p?.title as string) || undefined;
  }
  return {
    id: v.id as string,
    product_id: v.product_id as string,
    title: productTitle || "Item",
    variant_title: (v.title as string) || "",
    sku: (v.sku as string) || null,
  };
}

export async function internalSubAddItem(
  workspaceId: string,
  contractId: string,
  variantId: string,
  quantity: number,
): Promise<ActionResult> {
  const admin = createAdminClient();
  const sub = await loadInternalSub(workspaceId, contractId);
  if (!sub) return { success: false, error: "Internal subscription not found" };

  // Normalize the incoming id to the canonical variant UUID up front.
  const resolved = await resolveVariant(String(variantId));
  const canonicalId = resolved?.id || String(variantId);

  const items: Item[] = (sub.items as Item[]) || [];
  const existing = items.find((i) => String(i.variant_id) === canonicalId);
  let nextItems: Item[];
  if (existing) {
    nextItems = items.map((i) =>
      String(i.variant_id) === canonicalId ? { ...i, quantity: (i.quantity || 0) + quantity } : i,
    );
  } else {
    // Store the catalog REFERENCE only — no baked price. The pricing engine
    // derives the charged/displayed price live from the catalog + rule.
    nextItems = [
      ...items,
      {
        variant_id: canonicalId,
        product_id: resolved?.product_id,
        title: resolved?.title || "Item",
        variant_title: resolved?.variant_title || undefined,
        sku: resolved?.sku || undefined,
        quantity,
      },
    ];
  }
  await admin
    .from("subscriptions")
    .update({ items: nextItems, updated_at: new Date().toISOString() })
    .eq("id", sub.id);
  return { success: true };
}

/**
 * Build the internal `subscriptions.items[]` record for a ONE-TIME add-on
 * (gift or paid) that rides the NEXT renewal then drops off. Pure — no I/O.
 *
 * `one_time_next_renewal: true` is the flag the internal renewal engine
 * ([[inngest/internal-subscription-renewals]]) filters out after the order
 * ships (see its "Drop any one_time_next_renewal items now that they've
 * shipped" step), so the item appears on exactly one order.
 *
 * FREE gift (`free: true`): `is_gift: true` — the pricing engine
 * (src/lib/pricing.ts) unconditionally prices a gift line at `unit_cents: 0`,
 * so no price fields are needed to guarantee $0.
 *
 * PAID one-time (`free: false`): when `priceCents` is given it becomes the
 * grandfathered `price_override_cents` base; otherwise the field is omitted
 * and the pricing engine derives the live catalog price at renewal.
 */
export function buildOneTimeGiftItem(
  resolved: ResolvedVariant | null,
  fallbackVariantId: string,
  quantity: number,
  opts: { free?: boolean; priceCents?: number | null } = {},
): Item {
  const free = opts.free !== false; // default true — the gift case
  const item: Item = {
    variant_id: resolved?.id || String(fallbackVariantId),
    product_id: resolved?.product_id,
    title: resolved?.title || "Gift",
    variant_title: resolved?.variant_title || undefined,
    sku: resolved?.sku || undefined,
    quantity: Math.max(1, Math.floor(quantity || 1)),
    one_time_next_renewal: true,
  };
  if (free) {
    item.is_gift = true;
  } else if (opts.priceCents != null) {
    item.price_override_cents = Math.max(0, Math.round(opts.priceCents));
  }
  return item;
}

/**
 * Append a ONE-TIME gift (or paid) item to an internal subscription's next
 * renewal. The item ships once then drops off. Internal subs are OUR DB — no
 * Appstle round-trip. See [[buildOneTimeGiftItem]] for the record shape.
 *
 * Always appends a NEW line (never merges into an existing recurring line) so
 * the one-time gift sits alongside any recurring line for the same variant.
 */
export async function internalSubAddOneTimeGift(
  workspaceId: string,
  contractId: string,
  variantId: string,
  quantity: number,
  opts: { free?: boolean; priceCents?: number | null } = {},
): Promise<ActionResult> {
  const admin = createAdminClient();
  const sub = await loadInternalSub(workspaceId, contractId);
  if (!sub) return { success: false, error: "Internal subscription not found" };
  if (sub.status !== "active") return { success: false, error: `Subscription is ${sub.status}, not active` };

  const resolved = await resolveVariant(String(variantId));
  const items: Item[] = (sub.items as Item[]) || [];
  const giftItem = buildOneTimeGiftItem(resolved, String(variantId), quantity, opts);
  const nextItems = [...items, giftItem];
  await admin
    .from("subscriptions")
    .update({ items: nextItems, updated_at: new Date().toISOString() })
    .eq("id", sub.id);
  return { success: true };
}

export async function internalSubRemoveItem(
  workspaceId: string,
  contractId: string,
  variantId: string,
): Promise<ActionResult> {
  const admin = createAdminClient();
  const sub = await loadInternalSub(workspaceId, contractId);
  if (!sub) return { success: false, error: "Internal subscription not found" };

  const resolved = await resolveVariant(String(variantId));
  const key = resolved?.id || String(variantId);
  const items: Item[] = (sub.items as Item[]) || [];
  const nextItems = items.filter((i) => String(i.variant_id) !== key && String(i.variant_id) !== String(variantId));
  await admin
    .from("subscriptions")
    .update({ items: nextItems, updated_at: new Date().toISOString() })
    .eq("id", sub.id);
  return { success: true };
}

export async function internalSubSwapVariant(
  workspaceId: string,
  contractId: string,
  oldVariantId: string,
  newVariantId: string,
  quantity?: number,
): Promise<ActionResult> {
  const admin = createAdminClient();
  const sub = await loadInternalSub(workspaceId, contractId);
  if (!sub) return { success: false, error: "Internal subscription not found" };

  // Match the old line by canonical UUID or (transitional) whatever id it stored.
  const oldResolved = await resolveVariant(String(oldVariantId));
  const oldKey = oldResolved?.id || String(oldVariantId);
  const items: Item[] = (sub.items as Item[]) || [];
  const oldItem = items.find((i) => String(i.variant_id) === oldKey || String(i.variant_id) === String(oldVariantId));
  if (!oldItem) return { success: false, error: `Variant ${oldVariantId} not on subscription` };

  // Resolve the NEW variant to its canonical UUID + catalog metadata. Store the
  // reference only — no baked price; a swap also drops any grandfathered override
  // (it's a different product, so the old lock no longer applies).
  const resolved = await resolveVariant(String(newVariantId));
  const nextItems = items.map((i) =>
    i === oldItem
      ? {
          ...i,
          variant_id: resolved?.id || String(newVariantId),
          product_id: resolved?.product_id || i.product_id,
          title: resolved?.title || i.title,
          variant_title: resolved?.variant_title ?? i.variant_title,
          sku: resolved?.sku ?? i.sku,
          quantity: quantity ?? i.quantity,
          price_cents: undefined,
          price_override_cents: undefined,
        }
      : i,
  );
  await admin
    .from("subscriptions")
    .update({ items: nextItems, updated_at: new Date().toISOString() })
    .eq("id", sub.id);
  return { success: true };
}

export async function internalSubUpdateLineItemPrice(
  workspaceId: string,
  contractId: string,
  variantId: string,
  basePriceCents: number,
): Promise<ActionResult> {
  const admin = createAdminClient();
  const sub = await loadInternalSub(workspaceId, contractId);
  if (!sub) return { success: false, error: "Internal subscription not found" };

  // Grandfather lock: store the override BASE (pre-discount). The pricing engine
  // applies the quantity break + S&S on top — so we keep the locked base, not a
  // baked post-discount value (which is what the old Appstle-mirroring code did).
  const resolved = await resolveVariant(String(variantId));
  const key = resolved?.id || String(variantId);
  const items: Item[] = (sub.items as Item[]) || [];
  const nextItems = items.map((i) =>
    String(i.variant_id) === key || String(i.variant_id) === String(variantId)
      ? { ...i, price_override_cents: basePriceCents, price_cents: undefined }
      : i,
  );
  await admin
    .from("subscriptions")
    .update({ items: nextItems, updated_at: new Date().toISOString() })
    .eq("id", sub.id);
  return { success: true };
}

// ────────────────────────────────────────────────────────────────────
// Discount mutations — Appstle's apply/remove discount endpoints map
// to applied_discounts JSONB on our side. Storefront pricing engine
// already reads from this column.
// ────────────────────────────────────────────────────────────────────

export async function internalSubApplyDiscount(
  workspaceId: string,
  contractId: string,
  discountCode: string,
): Promise<ActionResult> {
  const admin = createAdminClient();
  const sub = await loadInternalSub(workspaceId, contractId);
  if (!sub) return { success: false, error: "Internal subscription not found" };

  const existing = (sub.applied_discounts as Array<{ title?: string }>) || [];
  if (existing.some((d) => d.title === discountCode)) {
    return { success: true }; // already applied — idempotent
  }
  const nextDiscounts = [...existing, { title: discountCode }];
  await admin
    .from("subscriptions")
    .update({ applied_discounts: nextDiscounts, updated_at: new Date().toISOString() })
    .eq("id", sub.id);
  return { success: true };
}

export async function internalSubRemoveDiscount(
  workspaceId: string,
  contractId: string,
  discountCodeOrId: string,
): Promise<ActionResult> {
  const admin = createAdminClient();
  const sub = await loadInternalSub(workspaceId, contractId);
  if (!sub) return { success: false, error: "Internal subscription not found" };

  const existing = (sub.applied_discounts as Array<{ title?: string; id?: string }>) || [];
  const nextDiscounts = existing.filter(
    (d) => d.title !== discountCodeOrId && d.id !== discountCodeOrId,
  );
  await admin
    .from("subscriptions")
    .update({ applied_discounts: nextDiscounts, updated_at: new Date().toISOString() })
    .eq("id", sub.id);
  return { success: true };
}

// ────────────────────────────────────────────────────────────────────
// Stubs — these wrap Appstle endpoints whose internal-mode equivalent
// hasn't been wired yet. They return success=false with a clear error
// so callers know to surface a "manual operator action needed" note
// instead of pretending the action succeeded.
// ────────────────────────────────────────────────────────────────────

export function internalSubNotYetSupported(action: string): ActionResult {
  return {
    success: false,
    error: `Internal subscription engine doesn't support "${action}" yet — agent must handle manually.`,
  };
}

// ────────────────────────────────────────────────────────────────────
// Date arithmetic — Appstle stores billing dates per cycle; for our
// internal mode we compute the next date by adding (interval × count).
// ────────────────────────────────────────────────────────────────────
export function advanceDate(base: Date, interval: string, count: number): Date {
  const d = new Date(base);
  const i = interval.toLowerCase();
  if (i === "day") d.setUTCDate(d.getUTCDate() + count);
  else if (i === "week") d.setUTCDate(d.getUTCDate() + count * 7);
  else if (i === "month") d.setUTCMonth(d.getUTCMonth() + count);
  else if (i === "year") d.setUTCFullYear(d.getUTCFullYear() + count);
  else d.setUTCDate(d.getUTCDate() + count * 28);  // fallback ~ monthly
  return d;
}
