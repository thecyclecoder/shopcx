/**
 * Shared cart pricing + handoff (docs/brain/libraries/shopping-agent.md · Phase 3).
 *
 * The server-side price-validation that used to live inline in src/app/api/cart/route.ts POST is
 * extracted here as `priceCartLines` so BOTH the storefront cart route AND the MCP `build_cart` tool
 * price carts through ONE code path — no duplicated pricing. `buildCartForAgent` wraps it for the
 * MCP tool: pick the product's primary variant, price it, write a `cart_drafts` row, and return a
 * storefront checkout URL UTM-tagged per AI app so orders / new subscriptions / CAC split by AI
 * channel (utm_source=<chatgpt|claude|grok>, utm_medium=ai_agent).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { findVariant } from "@/lib/product-variants";
import { ensureCartAttachments } from "@/lib/cart-gifts";
import crypto from "crypto";

type Admin = ReturnType<typeof createAdminClient>;

/** The storefront funnel channel for any session/order that arrived via an AI shopping agent. */
export const AI_AGENT_MEDIUM = "ai_agent";

export type AiAgentPlatform = "chatgpt" | "claude" | "grok" | "other";

/** A stored, server-priced cart line (canonical cart_drafts.line_items shape). */
export interface StoredLineItem {
  variant_id: string;
  product_id: string;
  shopify_variant_id: string | null;
  sku: string | null;
  title: string;
  variant_title: string | null;
  image_url: string | null;
  quantity: number;
  unit_price_cents: number;
  unit_msrp_cents: number;
  price_cents_at_add: number;
  line_total_cents: number;
  mode: "subscribe" | "onetime";
  frequency_days: number | null;
  is_gift?: boolean;
  gift_source_product_id?: string;
}

/** Input to {@link priceCartLines} — a variant ref + quantity. */
export interface PriceLineInput {
  variant_id?: string;
  shopify_variant_id?: string;
  quantity: number;
}

export interface PricedLinesResult {
  /** Priced lines (pre-gift). Empty when `error` is set. */
  lines: StoredLineItem[];
  /** The frequency actually applied to subscribe lines (defaulted from the rule when invalid). */
  resolvedFreqDays: number | null;
  error?: { code: string; variant_id?: string };
}

/** Highest quantity-break % whose threshold is met by the cart-wide total. */
function qtyBreakPct(breaks: Array<{ quantity: number; discount_pct: number }>, total: number): number {
  const eligible = (breaks || []).filter((b) => b.quantity <= total);
  return eligible.length ? eligible.reduce((m, b) => (b.discount_pct > m ? b.discount_pct : m), 0) : 0;
}

/**
 * Resolve every variant against the DB and price each line. unit = msrp × (1 − qty break) ×
 * (1 − subscribe), with the quantity break resolved at the CART-WIDE total so cross-product bundles
 * unlock the same break the storefront showed. THE single pricing chokepoint (route + MCP tool).
 */
export async function priceCartLines(
  admin: Admin,
  workspaceId: string,
  inputs: PriceLineInput[],
  mode: "subscribe" | "onetime",
  freqDays: number | null,
): Promise<PricedLinesResult> {
  let resolvedFreqDays: number | null = freqDays;

  interface Prepped {
    variant: { id: string; product_id: string; shopify_variant_id: string | null; sku: string | null; title: string | null; image_url: string | null; price_cents: number };
    qty: number;
    subDiscountPct: number;
    breaks: Array<{ quantity: number; discount_pct: number }>;
    title: string;
  }

  const prepped: Prepped[] = [];
  let totalQty = 0;
  for (const li of inputs) {
    const qty = Math.max(1, Math.floor(li.quantity || 0));
    if (qty === 0) continue;

    const variant = await findVariant(workspaceId, { id: li.variant_id, shopifyVariantId: li.shopify_variant_id });
    if (!variant) return { lines: [], resolvedFreqDays, error: { code: "variant_not_found", variant_id: li.variant_id || li.shopify_variant_id } };

    const { data: ruleAssignment } = await admin
      .from("product_pricing_rule")
      .select("pricing_rule_id")
      .eq("workspace_id", workspaceId)
      .eq("product_id", variant.product_id)
      .maybeSingle();
    let subDiscountPct = 0;
    let breaks: Array<{ quantity: number; discount_pct: number }> = [];
    if (ruleAssignment?.pricing_rule_id) {
      const { data: rule } = await admin
        .from("pricing_rules")
        .select("subscribe_discount_pct, available_frequencies, quantity_breaks")
        .eq("id", ruleAssignment.pricing_rule_id)
        .maybeSingle();
      subDiscountPct = rule?.subscribe_discount_pct || 0;
      breaks = (rule?.quantity_breaks as Array<{ quantity: number; discount_pct: number }> | null) || [];
      if (mode === "subscribe") {
        const freqs = (rule?.available_frequencies as Array<{ interval_days: number; default?: boolean }> | null) || [];
        const valid = resolvedFreqDays != null && freqs.some((f) => f.interval_days === resolvedFreqDays);
        if (!valid && freqs.length > 0) resolvedFreqDays = (freqs.find((f) => f.default) || freqs[0]).interval_days;
      }
    }

    const { data: product } = await admin.from("products").select("title").eq("id", variant.product_id).single();
    prepped.push({ variant, qty, subDiscountPct, breaks, title: product?.title || "Item" });
    totalQty += qty;
  }

  const lines: StoredLineItem[] = [];
  for (const p of prepped) {
    const msrp = p.variant.price_cents;
    const afterQty = Math.round(msrp * (1 - qtyBreakPct(p.breaks, totalQty) / 100));
    const unit = mode === "subscribe" && p.subDiscountPct > 0 ? Math.round(afterQty * (1 - p.subDiscountPct / 100)) : afterQty;
    lines.push({
      variant_id: p.variant.id,
      product_id: p.variant.product_id,
      shopify_variant_id: p.variant.shopify_variant_id,
      sku: p.variant.sku || null,
      title: p.title,
      variant_title: p.variant.title || null,
      image_url: p.variant.image_url,
      quantity: p.qty,
      unit_price_cents: unit,
      unit_msrp_cents: msrp,
      price_cents_at_add: unit,
      line_total_cents: unit * p.qty,
      mode,
      frequency_days: mode === "subscribe" ? resolvedFreqDays : null,
    });
  }
  return { lines, resolvedFreqDays };
}

/**
 * Build the storefront checkout URL for a cart token, UTM-tagged per AI app. Mirrors `ourLanderUrl`:
 * a custom `storefront_domain` wins, else the `shopcx.ai/store/{slug}` path.
 */
export function buildAgentCheckoutUrl(
  domain: string | null,
  slug: string | null,
  token: string,
  platform: AiAgentPlatform,
): string {
  const qs = `token=${encodeURIComponent(token)}&utm_source=${encodeURIComponent(platform)}&utm_medium=${AI_AGENT_MEDIUM}`;
  if (domain) return `https://${domain}/checkout?${qs}`;
  if (slug) return `https://shopcx.ai/store/${slug}/checkout?${qs}`;
  return `https://shopcx.ai/checkout?${qs}`;
}

/** Pick a product's primary purchasable variant (available first, lowest position). */
async function primaryVariant(admin: Admin, workspaceId: string, productId: string): Promise<{ id: string } | null> {
  const { data } = await admin
    .from("product_variants")
    .select("id, available, position")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .order("available", { ascending: false })
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data ? { id: data.id as string } : null;
}

/**
 * Resolve the shopper's chosen flavor/option (e.g. "Berry") to one of the product's variants by a
 * case-insensitive match on `title` / `option1..3`. Null when no flavor was given or none matches —
 * the caller then falls back to the primary variant and reports the available flavors.
 */
async function variantByFlavor(
  admin: Admin,
  workspaceId: string,
  productId: string,
  flavor: string | null | undefined,
): Promise<{ id: string } | null> {
  const want = (flavor ?? "").trim().toLowerCase();
  if (!want) return null;
  const { data } = await admin
    .from("product_variants")
    .select("id, title, option1, option2, option3, available, position")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .order("available", { ascending: false })
    .order("position", { ascending: true });
  const rows = (data ?? []) as Array<{ id: string; title: string | null; option1: string | null; option2: string | null; option3: string | null }>;
  const hit = pickFlavorMatch(rows, want);
  return hit ? { id: hit.id } : null;
}

/**
 * Rank a shopper's flavor words against variant labels: exact label > whole-word match > substring.
 * Whole-word first so "berry" picks "Mixed Berry", not "Strawberry Lemonade" (a substring hit that
 * sorts earlier by position). Exported for the unit test.
 */
export function pickFlavorMatch<T extends { title: string | null; option1: string | null; option2: string | null; option3: string | null }>(
  rows: T[],
  want: string,
): T | null {
  const w = want.trim().toLowerCase();
  if (!w) return null;
  const labels = (r: T) => [r.title, r.option1, r.option2, r.option3].map((v) => (v ?? "").toLowerCase()).filter(Boolean);
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`);
  return (
    rows.find((r) => labels(r).some((l) => l === w)) ??
    rows.find((r) => labels(r).some((l) => word.test(l))) ??
    rows.find((r) => labels(r).some((l) => l.includes(w))) ??
    null
  );
}

/** The product's distinct variant titles (flavors), for telling the shopper what they can pick. */
export async function listFlavors(admin: Admin, workspaceId: string, productId: string): Promise<string[]> {
  const { data } = await admin
    .from("product_variants")
    .select("title, position")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .order("position", { ascending: true });
  return [...new Set(((data ?? []) as Array<{ title: string | null }>).map((r) => (r.title ?? "").trim()).filter(Boolean))];
}

export interface BuildCartForAgentInput {
  productId: string;
  packTier: number;
  /** Optional flavor/option the shopper picked (matched to a variant); falls back to the primary variant. */
  flavor?: string | null;
  mode: "subscribe" | "onetime";
  frequencyDays: number | null;
  platform: AiAgentPlatform;
}

export interface AgentCartResult {
  token: string;
  checkout_url: string;
  subtotal: string;
  total: string;
  line_items: Array<{ title: string; variant_title: string | null; quantity: number; unit_price: string }>;
  error?: string;
}

/**
 * MCP `build_cart`: price the product's primary variant at the requested pack tier via the shared
 * `priceCartLines`, write a `cart_drafts` row, and return a UTM-tagged checkout URL. Reuses Braintree/
 * Avalara/OTP/subscription vaulting/CAPI unchanged — checkout finishes on our own storefront.
 */
export async function buildCartForAgent(
  admin: Admin,
  workspaceId: string,
  input: BuildCartForAgentInput,
): Promise<AgentCartResult> {
  const variant = (await variantByFlavor(admin, workspaceId, input.productId, input.flavor)) ?? (await primaryVariant(admin, workspaceId, input.productId));
  if (!variant) return { token: "", checkout_url: "", subtotal: "$0.00", total: "$0.00", line_items: [], error: "no purchasable variant" };

  const priced = await priceCartLines(admin, workspaceId, [{ variant_id: variant.id, quantity: input.packTier }], input.mode, input.frequencyDays);
  if (priced.error) return { token: "", checkout_url: "", subtotal: "$0.00", total: "$0.00", line_items: [], error: priced.error.code };

  const lines = await ensureCartAttachments(workspaceId, priced.lines);
  const subtotalCents = lines.reduce((sum, l) => sum + l.line_total_cents, 0);

  const token = crypto.randomBytes(24).toString("hex");
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();

  const { data: cart, error } = await admin
    .from("cart_drafts")
    .upsert(
      {
        workspace_id: workspaceId,
        token,
        line_items: lines,
        subscription_frequency_days: input.mode === "subscribe" ? priced.resolvedFreqDays : null,
        subtotal_cents: subtotalCents,
        discount_cents: 0,
        shipping_cents: 0,
        tax_cents: 0,
        total_cents: subtotalCents,
        status: "open",
        expires_at: expiresAt,
        updated_at: nowIso,
      },
      { onConflict: "token" },
    )
    .select("token")
    .single();
  if (error || !cart) return { token: "", checkout_url: "", subtotal: "$0.00", total: "$0.00", line_items: [], error: error?.message || "cart_write_failed" };

  const { data: ws } = await admin.from("workspaces").select("storefront_domain, storefront_slug").eq("id", workspaceId).maybeSingle();
  const checkoutUrl = buildAgentCheckoutUrl(
    (ws?.storefront_domain as string | null) ?? null,
    (ws?.storefront_slug as string | null) ?? null,
    token,
    input.platform,
  );

  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  return {
    token,
    checkout_url: checkoutUrl,
    subtotal: money(subtotalCents),
    total: money(subtotalCents),
    line_items: lines
      .filter((l) => !l.is_gift)
      .map((l) => ({ title: l.title, variant_title: l.variant_title, quantity: l.quantity, unit_price: money(l.unit_price_cents) })),
  };
}
