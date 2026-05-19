"use client";

/**
 * Customize worksheet — the post-Shopify funnel's "finalize your order"
 * step. Reads as a worksheet, not a cart view. Per cart-product group:
 *
 *   1. Linked-product chips      Swap Instant ↔ K-Cups inline.
 *   2. Variant allocation        Tap chips when qty=1, drag bars when qty>1.
 *                                Drag rebalances against the largest peer.
 *   3. Quantity pills            1 / 2 / 3 — drives total per product.
 *   4. (Coming) Subscribe toggle Per item. Off by default for one-time carts.
 *
 * Plus order-level:
 *   - Frequency picker (when subscribing and the rule offers > 1 option)
 *   - Sticky total + continue CTA
 *   - "Back to {originating PDP}" link
 *
 * Every change POSTs to /api/cart with the new line_items shape and
 * the server re-validates pricing. Local state is optimistic but the
 * server return value always wins.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { initPixel, track } from "@/lib/storefront-pixel";
import { HeroFeaturedReviews } from "../../_components/HeroFeaturedReviews";
import type { Review } from "../../_lib/page-data";

// ── Shared types ───────────────────────────────────────────────────

export interface CartDraft {
  id: string;
  workspace_id: string;
  token: string;
  anonymous_id: string | null;
  customer_id: string | null;
  line_items: StoredLineItem[];
  subscription_frequency_days: number | null;
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
  status: string;
  email: string | null;
  phone: string | null;
  expires_at: string;
  source_product_handle?: string | null;
}

export interface StoredLineItem {
  variant_id: string;
  product_id: string;
  shopify_variant_id: string | null;
  title: string;
  variant_title: string | null;
  image_url: string | null;
  quantity: number;
  unit_price_cents: number;
  unit_msrp_cents: number;
  line_total_cents: number;
  mode: "subscribe" | "onetime";
  frequency_days: number | null;
}

export interface ProductCatalogEntry {
  product: {
    id: string;
    handle: string;
    title: string;
    image_url: string | null;
  };
  variants: Array<{
    id: string;
    shopify_variant_id: string | null;
    title: string;
    image_url: string | null;
    price_cents: number;
    position: number;
  }>;
  pricing_rule: {
    subscribe_discount_pct: number;
    available_frequencies: Array<{ interval_days: number; label: string; default?: boolean }>;
    quantity_breaks: Array<{ quantity: number; discount_pct: number; label: string }>;
    free_gift_variant_id: string | null;
    free_gift_product_title: string | null;
    free_gift_image_url: string | null;
    free_gift_min_quantity: number;
    free_gift_subscription_only: boolean;
    free_gift_price_cents: number | null;
  } | null;
  linked_products: Array<{
    product_id: string;
    handle: string;
    title: string;
    image_url: string | null;
    value: string;
    display_order: number;
    variants: Array<{
      id: string;
      shopify_variant_id: string | null;
      title: string;
      image_url: string | null;
      price_cents: number;
      position: number;
    }>;
  }>;
  linked_group_name: string | null;
}

export interface UpsellCandidate {
  product_id: string;
  handle: string;
  title: string;
  image_url: string | null;
  variant_id: string | null;
  shopify_variant_id: string | null;
  variant_title: string | null;
  price_cents: number;
}

interface Workspace {
  id: string;
  name: string;
  logo_url: string | null;
  primary_color: string;
  storefront_domain: string | null;
  storefront_slug: string | null;
}

// ── Component ──────────────────────────────────────────────────────

export function CustomizeClient({
  cart: initialCart,
  productCatalog,
  upsells: _upsells,
  workspace,
  sourceProductHandle,
  featuredReviews,
  primaryProductHandle,
}: {
  cart: CartDraft;
  productCatalog: Record<string, ProductCatalogEntry>;
  upsells: UpsellCandidate[];
  workspace: Workspace;
  sourceProductHandle: string | null;
  featuredReviews: Review[];
  primaryProductHandle: string | null;
}) {
  const [cart, setCart] = useState(initialCart);
  const [continueBusy, setContinueBusy] = useState(false);
  const [, setBusyKey] = useState<string | null>(null);

  // Fire customize_view once on mount.
  useEffect(() => {
    initPixel({
      workspaceId: workspace.id,
      customerId: cart.customer_id,
    });
    track("customize_view", {
      cart_token: cart.token,
      line_item_count: cart.line_items.length,
      total_cents: cart.total_cents,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Group lines by product_id ───────────────────────────────────
  // The cart's line_items array can hold multiple entries per product
  // (one per variant). The worksheet treats those collectively: a
  // "group" is "all the boxes of this product" with a per-variant
  // breakdown inside.
  const groups = useMemo(() => groupLinesByProduct(cart.line_items), [cart.line_items]);

  // ── Order-level subscribe + frequency ───────────────────────────
  // Single source of truth on the cart for now (the upsell pass will
  // make subscribe per-product). Pull the dominant rule's frequencies
  // — most carts have one product so this is unambiguous.
  const subscribing = cart.line_items.some((l) => l.mode === "subscribe");
  const orderFrequencyDays = cart.subscription_frequency_days;
  const orderFrequencyLabel = useMemo(
    () => pickFrequencyLabel(groups, productCatalog, orderFrequencyDays),
    [groups, productCatalog, orderFrequencyDays],
  );

  // Savings vs MSRP. Each cart line carries unit_msrp_cents and
  // unit_price_cents (post-subscription-discount). The footer shows
  // the running gap so subscribers see what they're getting today.
  const orderSavingsCents = useMemo(() => {
    return cart.line_items.reduce((sum, l) => {
      const msrp = l.unit_msrp_cents * l.quantity;
      return sum + Math.max(0, msrp - l.line_total_cents);
    }, 0);
  }, [cart.line_items]);
  const availableFrequencies = useMemo(() => {
    // Use the first product with a rule that has options — same
    // logic as orderFrequencyLabel.
    for (const g of groups) {
      const rule = productCatalog[g.product_id]?.pricing_rule;
      if (rule && rule.available_frequencies?.length > 1) return rule.available_frequencies;
    }
    return [];
  }, [groups, productCatalog]);

  // ── Mutation helper ──────────────────────────────────────────────
  // All edits flow through a single POST to /api/cart so the server is
  // the price authority. Returns the fresh cart; never trust the
  // optimistic local state for totals.
  async function mutate(
    nextLines: Array<{ variant_id: string; quantity: number }>,
    opts?: { mode?: "subscribe" | "onetime"; frequency_days?: number | null },
    busyKey?: string,
  ) {
    if (busyKey) setBusyKey(busyKey);
    try {
      const res = await fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          workspace_id: workspace.id,
          anonymous_id: cart.anonymous_id,
          line_items: nextLines,
          mode: opts?.mode ?? (subscribing ? "subscribe" : "onetime"),
          frequency_days: opts?.frequency_days ?? cart.subscription_frequency_days,
          email: cart.email,
          phone: cart.phone,
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as { cart: CartDraft };
        setCart(json.cart);
      }
    } finally {
      if (busyKey) setBusyKey(null);
    }
  }

  // ── Group mutations ──────────────────────────────────────────────

  function applyGroupChange(
    productId: string,
    nextAllocation: Record<string, number>, // variant_id -> qty
  ) {
    // Replace just this product's lines, preserve others.
    const nextLines: Array<{ variant_id: string; quantity: number }> = [];
    const productIds = new Set(groups.map((g) => g.product_id));
    for (const g of groups) {
      if (g.product_id === productId) {
        for (const [vid, q] of Object.entries(nextAllocation)) {
          if (q > 0) nextLines.push({ variant_id: vid, quantity: q });
        }
      } else {
        for (const a of g.allocation) {
          if (a.quantity > 0) nextLines.push({ variant_id: a.variant_id, quantity: a.quantity });
        }
      }
    }
    // Defensive: if for any reason we lost a productId, drop nothing.
    void productIds;
    return mutate(nextLines, undefined, `group:${productId}`);
  }

  function swapLinkedProduct(currentProductId: string, targetProductId: string) {
    // Preserve flavor when possible: if the current allocation has
    // 2x Hazelnut + 1x Cocoa and the target product has Hazelnut +
    // Cocoa variants, the swap maps Hazelnut→Hazelnut and Cocoa→Cocoa.
    // Anything that doesn't match falls onto the target's first
    // variant.
    const currentGroup = groups.find((g) => g.product_id === currentProductId);
    const currentCatalog = productCatalog[currentProductId];
    const target = currentCatalog?.linked_products.find((p) => p.product_id === targetProductId);
    if (!currentGroup || !target || target.variants.length === 0) return;

    // Title -> variant lookup on the target side (case-insensitive,
    // matches on substring so "Hazelnut French Roast" finds "Hazelnut").
    const targetVariants = target.variants;
    function mapToTarget(currentVariantId: string): string {
      const cur = currentCatalog?.variants.find((v) => v.id === currentVariantId);
      const curTitle = (cur?.title || "").toLowerCase();
      // Exact match first
      const exact = targetVariants.find((tv) => tv.title.toLowerCase() === curTitle);
      if (exact) return exact.id;
      // Substring either direction
      const sub = targetVariants.find((tv) => {
        const t = tv.title.toLowerCase();
        return curTitle && (t.includes(curTitle) || curTitle.includes(t));
      });
      if (sub) return sub.id;
      // Fallback: first variant
      return targetVariants[0].id;
    }

    // Aggregate by target variant since multiple source variants might
    // collapse to the same target (rare, but defensive).
    const targetAlloc = new Map<string, number>();
    for (const a of currentGroup.allocation) {
      if (a.quantity <= 0) continue;
      const mapped = mapToTarget(a.variant_id);
      targetAlloc.set(mapped, (targetAlloc.get(mapped) || 0) + a.quantity);
    }

    const nextLines: Array<{ variant_id: string; quantity: number }> = [];
    for (const g of groups) {
      if (g.product_id === currentProductId) {
        for (const [vid, q] of targetAlloc) {
          if (q > 0) nextLines.push({ variant_id: vid, quantity: q });
        }
      } else {
        for (const a of g.allocation) {
          if (a.quantity > 0) nextLines.push({ variant_id: a.variant_id, quantity: a.quantity });
        }
      }
    }

    track("linked_product_swapped", {
      cart_token: cart.token,
      from_product: currentProductId,
      to_product: targetProductId,
    });
    // After the cart is mutated, reload so the server fetches the target
    // product's catalog (variants, pricing rule, reciprocal linked-
    // products). Without this, the worksheet card would render with no
    // catalog entry for the new product and stick on "Loading…".
    return mutate(nextLines, undefined, `swap:${currentProductId}`).then(() => {
      window.location.reload();
    });
  }

  // ── Order-level mutations ────────────────────────────────────────

  function changeFrequency(intervalDays: number) {
    const nextLines = cart.line_items.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity }));
    return mutate(nextLines, { mode: "subscribe", frequency_days: intervalDays }, "frequency");
  }

  // ── Continue → checkout ──────────────────────────────────────────

  async function onContinue() {
    setContinueBusy(true);
    track("checkout_redirect", {
      cart_token: cart.token,
      total_cents: cart.total_cents,
      line_item_count: cart.line_items.length,
    });
    // STUB until /checkout ships. Send the customer there directly;
    // they'll get bounced back to / if the route doesn't exist yet.
    window.location.href = `/checkout?token=${encodeURIComponent(cart.token)}`;
  }

  // ── Render ───────────────────────────────────────────────────────

  const themeStyle = {
    "--storefront-primary": workspace.primary_color,
  } as React.CSSProperties;

  const backLink = sourceProductHandle ? `/${sourceProductHandle}` : null;

  return (
    <div style={themeStyle} className="mx-auto max-w-3xl px-4 pb-32 pt-6 sm:pt-10">
      <header className="mb-6 flex items-center justify-between">
        {workspace.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={workspace.logo_url} alt={workspace.name} className="h-8" />
        ) : (
          <span className="text-lg font-semibold">{workspace.name}</span>
        )}
        {backLink && (
          <a href={backLink} className="text-sm text-zinc-500 hover:text-zinc-800">
            ← Back
          </a>
        )}
      </header>

      <h1 className="text-3xl font-bold text-zinc-900 sm:text-4xl">Build your order</h1>
      <p className="mt-2 text-base text-zinc-600">
        Customize each item, then checkout. Tap or drag — your changes save automatically.
      </p>

      {/* Per-product worksheet cards */}
      <div className="mt-8 space-y-6">
        {groups.map((group) => (
          <ProductWorksheetCard
            key={group.product_id}
            group={group}
            catalog={productCatalog[group.product_id]}
            primaryColor={workspace.primary_color}
            subscribing={subscribing}
            onAllocationChange={(allocation) => applyGroupChange(group.product_id, allocation)}
            onSwap={(targetProductId) => swapLinkedProduct(group.product_id, targetProductId)}
          />
        ))}
      </div>

      {/* Order-level frequency — subtle inline select. The default
          reflects what the customer chose on the PDP (carried via
          cart.subscription_frequency_days). Click to open and pick a
          different cadence. Hidden when not subscribing or when the
          rule offers only one option. */}
      {subscribing && availableFrequencies.length > 1 && (
        <div className="mt-5 flex items-center gap-2 text-sm text-zinc-600">
          <span>Delivers</span>
          <div className="relative">
            <select
              value={orderFrequencyDays ?? ""}
              onChange={(e) => changeFrequency(Number(e.target.value))}
              className="appearance-none rounded-md border border-zinc-300 bg-white py-1 pl-2.5 pr-7 text-sm font-medium text-zinc-800 hover:border-zinc-400 focus:border-zinc-500 focus:outline-none"
            >
              {availableFrequencies.map((f) => (
                <option key={f.interval_days} value={f.interval_days}>
                  {f.label.toLowerCase()}
                </option>
              ))}
            </select>
            <svg
              className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>
      )}

      {/* Featured reviews — purchase-confidence boost. Hidden when no
          featured reviews are available for the cart's products. */}
      {featuredReviews.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-4 text-center text-sm font-semibold uppercase tracking-wider text-zinc-500">
            What customers are saying
          </h2>
          <HeroFeaturedReviews
            reviews={featuredReviews}
            workspaceSlug={workspace.storefront_slug || undefined}
            slug={primaryProductHandle || undefined}
          />
        </section>
      )}

      {/* Sticky bottom CTA */}
      <section className="fixed inset-x-0 bottom-0 z-10 border-t border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur sm:relative sm:mt-8 sm:rounded-2xl sm:border sm:px-6 sm:py-4 sm:shadow-lg">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          <div>
            <div className="text-2xl font-bold leading-tight text-zinc-900">{fmt(cart.total_cents)}</div>
            {orderSavingsCents > 0 && (
              <div className="mt-0.5 text-xs font-semibold text-emerald-700">
                Save {fmt(orderSavingsCents)}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onContinue}
            disabled={continueBusy || cart.line_items.length === 0}
            style={{ backgroundColor: workspace.primary_color }}
            className="rounded-full px-7 py-3 text-sm font-extrabold uppercase tracking-wider text-white shadow-md disabled:opacity-50"
          >
            {continueBusy ? "One moment…" : "Continue →"}
          </button>
        </div>
      </section>
    </div>
  );
}

// ── Product worksheet card ─────────────────────────────────────────

interface GroupedProduct {
  product_id: string;
  totalQty: number;
  allocation: Array<{ variant_id: string; quantity: number; title: string; variant_title: string | null; image_url: string | null; unit_price_cents: number; unit_msrp_cents: number }>;
  productTitle: string;
  primaryImage: string | null;
}

function ProductWorksheetCard({
  group,
  catalog,
  primaryColor,
  subscribing,
  onAllocationChange,
  onSwap,
}: {
  group: GroupedProduct;
  catalog: ProductCatalogEntry | undefined;
  primaryColor: string;
  subscribing: boolean;
  onAllocationChange: (allocation: Record<string, number>) => void;
  onSwap: (targetProductId: string) => void;
}) {
  // Build local allocation state keyed by variant_id. Server is source
  // of truth — when the parent rerenders the group prop, we sync.
  const initialAllocation = useMemo(() => {
    const out: Record<string, number> = {};
    for (const a of group.allocation) out[a.variant_id] = a.quantity;
    return out;
  }, [group.allocation]);
  const [allocation, setAllocation] = useState<Record<string, number>>(initialAllocation);
  const [totalQty, setTotalQty] = useState<number>(group.totalQty);
  useEffect(() => {
    setAllocation(initialAllocation);
    setTotalQty(group.totalQty);
  }, [initialAllocation, group.totalQty]);

  if (!catalog) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
        <p className="text-sm text-zinc-600">Loading {group.productTitle}…</p>
      </div>
    );
  }

  const variants = catalog.variants;
  const hasVariants = variants.length > 1;
  const linked = catalog.linked_products;
  const lineSubtotal = group.allocation.reduce((s, a) => s + a.unit_price_cents * a.quantity, 0);
  const lineMsrp = group.allocation.reduce((s, a) => s + a.unit_msrp_cents * a.quantity, 0);

  function setVariantQty(variantId: string, next: Record<string, number>) {
    setAllocation(next);
    void variantId;
    onAllocationChange(next);
  }

  function changeQty(nextTotal: number) {
    setTotalQty(nextTotal);
    // Redistribute the new total across the existing chosen variants,
    // preserving proportions where possible. Simplest correct behavior:
    // if exactly one variant has weight, dump everything there; else
    // proportionally scale, then fix the rounding remainder on the
    // largest entry.
    const currentTotal = Object.values(allocation).reduce((s, v) => s + v, 0);
    const next: Record<string, number> = {};
    if (currentTotal === 0) {
      // Nothing selected — put everything on the first variant.
      const first = variants[0]?.id;
      if (first) next[first] = nextTotal;
    } else if (hasVariants) {
      const entries = Object.entries(allocation);
      let remaining = nextTotal;
      // Initial proportional pass with floor
      for (const [vid, q] of entries) {
        const scaled = Math.floor((q / currentTotal) * nextTotal);
        next[vid] = scaled;
        remaining -= scaled;
      }
      // Distribute the remainder onto largest current
      const sortedDesc = [...entries].sort((a, b) => b[1] - a[1]);
      let i = 0;
      while (remaining > 0 && sortedDesc.length > 0) {
        next[sortedDesc[i % sortedDesc.length][0]] += 1;
        remaining -= 1;
        i += 1;
      }
    } else {
      // No variant choice — single variant takes the full count.
      const only = variants[0]?.id || Object.keys(allocation)[0];
      if (only) next[only] = nextTotal;
    }
    setAllocation(next);
    onAllocationChange(next);
  }

  return (
    <section className="overflow-hidden rounded-3xl border border-zinc-200 bg-white shadow-sm">
      {/* Header: image + title + line total */}
      <div className="flex items-center gap-4 border-b border-zinc-100 p-4 sm:p-5">
        {group.primaryImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={group.primaryImage}
            alt={group.productTitle}
            className="h-16 w-16 flex-shrink-0 rounded-2xl object-cover sm:h-20 sm:w-20"
          />
        ) : (
          <div className="h-16 w-16 flex-shrink-0 rounded-2xl bg-zinc-100 sm:h-20 sm:w-20" />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-lg font-bold text-zinc-900 sm:text-xl">{group.productTitle}</h3>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="text-base font-semibold text-zinc-900">{fmt(lineSubtotal)}</span>
            {lineMsrp > lineSubtotal && (
              <span className="text-xs text-zinc-400 line-through">{fmt(lineMsrp)}</span>
            )}
          </div>
        </div>
      </div>

      {/* Linked-product swap */}
      {linked.length > 0 && (
        <div className="border-b border-zinc-100 px-4 py-4 sm:px-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            {catalog.linked_group_name || "Format"}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {/* Current product as a selected chip */}
            <Chip selected primaryColor={primaryColor}>
              {currentLinkedValue(linked, group.product_id) || group.productTitle}
            </Chip>
            {linked
              .filter((p) => p.product_id !== group.product_id)
              .map((p) => (
                <button
                  key={p.product_id}
                  type="button"
                  onClick={() => onSwap(p.product_id)}
                  className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50"
                >
                  {p.value || p.title}
                </button>
              ))}
          </div>
        </div>
      )}

      {/* Quantity pills — show tier discount + free-gift indicator */}
      <div className="border-b border-zinc-100 px-4 py-4 sm:px-5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">How many?</p>
        <div className="mt-2 flex gap-2">
          {[1, 2, 3].map((q) => {
            const selected = totalQty === q;
            const discountPct = discountPctForQty(catalog.pricing_rule, q);
            const giftUnlocked = giftAppliesAtQty(catalog.pricing_rule, q, subscribing);
            return (
              <button
                key={q}
                type="button"
                onClick={() => changeQty(q)}
                style={{
                  backgroundColor: selected ? primaryColor : undefined,
                  borderColor: selected ? primaryColor : undefined,
                }}
                className={`relative flex-1 rounded-2xl border-2 px-3 py-3 text-center transition ${selected ? "text-white" : "border-zinc-200 text-zinc-700 hover:border-zinc-300"}`}
              >
                <div className="text-base font-bold leading-tight">{q} Pack</div>
                {discountPct > 0 && (
                  <div
                    className={`mt-0.5 text-[11px] font-semibold ${selected ? "text-white/90" : "text-emerald-700"}`}
                  >
                    {discountPct}% OFF
                  </div>
                )}
                {giftUnlocked && (
                  <div
                    className={`mt-0.5 text-[10px] font-semibold uppercase tracking-wide ${selected ? "text-white/90" : "text-amber-700"}`}
                  >
                    + Free Gift
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Variant picker / allocation */}
      {hasVariants && (
        <div className="border-b border-zinc-100 px-4 py-4 sm:px-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            {totalQty === 1 ? "Pick your flavor" : `Pick your ${totalQty} flavors`}
          </p>
          {totalQty === 1 ? (
            <FlavorChips
              variants={variants}
              selectedVariantId={topAllocatedVariantId(allocation)}
              onPick={(vid) => setVariantQty(vid, { [vid]: 1 })}
              primaryColor={primaryColor}
            />
          ) : (
            <AllocationBars
              variants={variants}
              totalQty={totalQty}
              allocation={allocation}
              onChange={(next) => {
                setAllocation(next);
                onAllocationChange(next);
              }}
              primaryColor={primaryColor}
            />
          )}
        </div>
      )}

      {/* Free gift unlocked card — shows the actual gift image + value.
          Sits below the flavor picker so customers finish their core
          decisions first; the gift then reads as "here's what you
          earned" rather than "here's another thing to think about". */}
      {(() => {
        const giftActive = giftAppliesAtQty(catalog.pricing_rule, totalQty, subscribing);
        const rule = catalog.pricing_rule;
        if (!giftActive || !rule || !rule.free_gift_product_title) return null;
        const valueLabel = rule.free_gift_price_cents
          ? `$${(rule.free_gift_price_cents / 100).toFixed(2)} value, yours free`
          : "Yours free with this order";
        return (
          <div className="px-4 py-4 sm:px-5">
            <div
              className="flex items-center gap-3 rounded-2xl border-2 border-amber-200 bg-amber-50 p-3"
              style={{ borderStyle: "dashed" }}
            >
              {rule.free_gift_image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={rule.free_gift_image_url}
                  alt={rule.free_gift_product_title}
                  className="h-14 w-14 flex-shrink-0 rounded-xl object-cover"
                />
              ) : (
                <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl bg-amber-100 text-2xl">
                  🎁
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-bold uppercase tracking-wider text-amber-700">
                  Unlocked at {totalQty} Pack
                </div>
                <div className="truncate text-sm font-bold text-zinc-900">
                  {prettyVariantTitle(rule.free_gift_product_title)}
                </div>
                <div className="text-xs font-semibold text-emerald-700">{valueLabel}</div>
              </div>
            </div>
          </div>
        );
      })()}
    </section>
  );
}

// ── Pricing-rule helpers ──────────────────────────────────────────

function discountPctForQty(
  rule: ProductCatalogEntry["pricing_rule"] | null,
  qty: number,
): number {
  if (!rule || !rule.quantity_breaks?.length) return 0;
  // quantity_breaks are typically [{quantity:1,discount_pct:0}, {quantity:2,discount_pct:8}, ...].
  // Pick the break that matches exactly; fall back to the highest break <= qty.
  const exact = rule.quantity_breaks.find((b) => b.quantity === qty);
  if (exact) return exact.discount_pct || 0;
  const sorted = [...rule.quantity_breaks].sort((a, b) => b.quantity - a.quantity);
  const fallback = sorted.find((b) => b.quantity <= qty);
  return fallback?.discount_pct || 0;
}

function giftAppliesAtQty(
  rule: ProductCatalogEntry["pricing_rule"] | null,
  qty: number,
  subscribing: boolean,
): boolean {
  if (!rule || !rule.free_gift_variant_id) return false;
  if (rule.free_gift_subscription_only && !subscribing) return false;
  return qty >= (rule.free_gift_min_quantity || 1);
}


// ── Subcomponents ──────────────────────────────────────────────────

function FlavorChips({
  variants,
  selectedVariantId,
  onPick,
  primaryColor,
}: {
  variants: ProductCatalogEntry["variants"];
  selectedVariantId: string | null;
  onPick: (variantId: string) => void;
  primaryColor: string;
}) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
      {variants.map((v) => {
        const selected = v.id === selectedVariantId;
        return (
          <button
            key={v.id}
            type="button"
            onClick={() => onPick(v.id)}
            style={{
              borderColor: selected ? primaryColor : undefined,
              boxShadow: selected ? `0 0 0 2px ${primaryColor} inset` : undefined,
            }}
            className={`flex items-center gap-2 rounded-2xl border-2 bg-white p-2 text-left transition ${selected ? "" : "border-zinc-200 hover:border-zinc-300"}`}
          >
            {v.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={v.image_url} alt={v.title} className="h-10 w-10 flex-shrink-0 rounded-lg object-cover" />
            ) : (
              <div className="h-10 w-10 flex-shrink-0 rounded-lg bg-zinc-100" />
            )}
            <span className="min-w-0 flex-1 text-sm font-semibold text-zinc-900">
              {prettyVariantTitle(v.title)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AllocationBars({
  variants,
  totalQty,
  allocation,
  onChange,
  primaryColor,
}: {
  variants: ProductCatalogEntry["variants"];
  totalQty: number;
  allocation: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
  primaryColor: string;
}) {
  // Track which variant the user last touched — releasing a unit goes
  // back to the most-recent peer for a "drag/undo" feel.
  const lastTouched = useRef<string | null>(null);

  function setForVariant(vid: string, nextValue: number) {
    nextValue = Math.max(0, Math.min(totalQty, Math.round(nextValue)));
    const current = allocation[vid] || 0;
    if (nextValue === current) return;

    const next = { ...allocation };
    // Ensure all variants have an entry
    for (const v of variants) if (!(v.id in next)) next[v.id] = 0;

    const delta = nextValue - current;
    next[vid] = nextValue;

    if (delta > 0) {
      // Steal from the largest other(s) until we balance.
      let needed = delta;
      while (needed > 0) {
        const other = Object.entries(next)
          .filter(([id]) => id !== vid)
          .sort((a, b) => b[1] - a[1])[0];
        if (!other || other[1] <= 0) break;
        next[other[0]] = other[1] - 1;
        needed -= 1;
      }
    } else {
      // Released units → most-recently-touched OTHER variant first;
      // falls back to the first variant that has room.
      let extra = -delta;
      const preferred = lastTouched.current && lastTouched.current !== vid ? lastTouched.current : null;
      while (extra > 0) {
        const target =
          (preferred && (next[preferred] ?? 0) < totalQty ? preferred : null) ||
          Object.keys(next).find((id) => id !== vid && (next[id] ?? 0) < totalQty);
        if (!target) break;
        next[target] = (next[target] ?? 0) + 1;
        extra -= 1;
      }
    }

    // Snap any negatives to 0 (paranoia)
    for (const k of Object.keys(next)) if (next[k] < 0) next[k] = 0;

    lastTouched.current = vid;
    onChange(next);
  }

  // Stacked summary bar at the top of the section.
  const summarySegments = variants
    .map((v) => ({ id: v.id, value: allocation[v.id] || 0, title: v.title, image: v.image_url }))
    .filter((s) => s.value > 0);

  return (
    <div className="mt-3 space-y-3">
      {/* Live stacked summary */}
      <div className="flex h-3 overflow-hidden rounded-full bg-zinc-100">
        {summarySegments.map((s, idx) => (
          <div
            key={s.id}
            style={{
              width: `${(s.value / totalQty) * 100}%`,
              backgroundColor: idx === 0 ? primaryColor : tintColor(primaryColor, idx),
            }}
          />
        ))}
      </div>

      {/* Per-variant draggable rows */}
      <div className="space-y-2">
        {variants.map((v) => {
          const value = allocation[v.id] || 0;
          return (
            <VariantSliderRow
              key={v.id}
              variant={v}
              value={value}
              totalQty={totalQty}
              primaryColor={primaryColor}
              onChange={(next) => setForVariant(v.id, next)}
            />
          );
        })}
      </div>
    </div>
  );
}

function VariantSliderRow({
  variant,
  value,
  totalQty,
  primaryColor,
  onChange,
}: {
  variant: ProductCatalogEntry["variants"][number];
  value: number;
  totalQty: number;
  primaryColor: string;
  onChange: (next: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);

  function pointerToValue(clientX: number): number {
    const el = trackRef.current;
    if (!el) return value;
    const r = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    return Math.round(pct * totalQty);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    onChange(pointerToValue(e.clientX));
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (e.buttons !== 1 && e.pressure === 0) return;
    onChange(pointerToValue(e.clientX));
  }

  const fillPct = totalQty > 0 ? (value / totalQty) * 100 : 0;

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-2">
      {variant.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={variant.image_url} alt={variant.title} className="h-12 w-12 flex-shrink-0 rounded-xl object-cover" />
      ) : (
        <div className="h-12 w-12 flex-shrink-0 rounded-xl bg-zinc-100" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-zinc-900">{prettyVariantTitle(variant.title)}</span>
          <span className="text-sm font-bold tabular-nums text-zinc-900">
            {value} / {totalQty}
          </span>
        </div>
        <div
          ref={trackRef}
          role="slider"
          aria-valuemin={0}
          aria-valuemax={totalQty}
          aria-valuenow={value}
          aria-label={`${variant.title} quantity`}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowDown") onChange(value - 1);
            if (e.key === "ArrowRight" || e.key === "ArrowUp") onChange(value + 1);
          }}
          className="relative mt-2 h-7 cursor-pointer touch-none select-none rounded-full bg-zinc-100"
        >
          {/* Filled portion */}
          <div
            className="absolute left-0 top-0 h-full rounded-full transition-[width] duration-100 ease-out"
            style={{
              width: `${fillPct}%`,
              backgroundColor: primaryColor,
            }}
          />
          {/* Tick marks — one per integer stop. Clickable via the
              parent's pointer handler since they sit inside the track.
              Skip 0 and totalQty so the knob isn't fighting an edge
              tick at the extremes. */}
          {Array.from({ length: Math.max(0, totalQty - 1) }, (_, i) => {
            const stop = i + 1;
            const pct = (stop / totalQty) * 100;
            const reached = stop <= value;
            return (
              <span
                key={stop}
                aria-hidden
                className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{
                  left: `${pct}%`,
                  width: 4,
                  height: 4,
                  backgroundColor: reached ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.18)",
                }}
              />
            );
          })}
          {/* Knob — right edge tracks the fill end, clamped to stay
              inside the track. At our integer stops (0, 1/N, 2/N, …,
              1) on a typical track width this lands cleanly so the
              knob sits flush against the fill on the right and at
              left:0 only when value=0 (fill invisible anyway). */}
          <div
            className="absolute top-1/2 -translate-y-1/2 rounded-full bg-white shadow-md transition-[left] duration-100 ease-out"
            style={{
              left: `max(0%, calc(${fillPct}% - 22px))`,
              width: 22,
              height: 22,
              border: `3px solid ${primaryColor}`,
            }}
          />
        </div>
      </div>
    </div>
  );
}

function Chip({
  selected,
  primaryColor,
  children,
}: {
  selected: boolean;
  primaryColor: string;
  children: React.ReactNode;
}) {
  return (
    <span
      style={{
        backgroundColor: selected ? primaryColor : undefined,
        borderColor: selected ? primaryColor : undefined,
      }}
      className={`inline-flex items-center rounded-full border-2 px-4 py-2 text-sm font-semibold ${selected ? "text-white" : "border-zinc-200 text-zinc-700"}`}
    >
      {children}
    </span>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function groupLinesByProduct(lines: StoredLineItem[]): GroupedProduct[] {
  const map = new Map<string, GroupedProduct>();
  for (const l of lines) {
    if (!map.has(l.product_id)) {
      map.set(l.product_id, {
        product_id: l.product_id,
        totalQty: 0,
        allocation: [],
        productTitle: l.title,
        primaryImage: l.image_url,
      });
    }
    const g = map.get(l.product_id)!;
    g.totalQty += l.quantity;
    g.allocation.push({
      variant_id: l.variant_id,
      quantity: l.quantity,
      title: l.title,
      variant_title: l.variant_title,
      image_url: l.image_url,
      unit_price_cents: l.unit_price_cents,
      unit_msrp_cents: l.unit_msrp_cents,
    });
  }
  return [...map.values()];
}

function topAllocatedVariantId(allocation: Record<string, number>): string | null {
  let best: { id: string; q: number } | null = null;
  for (const [id, q] of Object.entries(allocation)) {
    if (q > 0 && (!best || q > best.q)) best = { id, q };
  }
  return best?.id || null;
}

function currentLinkedValue(
  linked: ProductCatalogEntry["linked_products"],
  productId: string,
): string | null {
  const me = linked.find((p) => p.product_id === productId);
  return me?.value || null;
}

function pickFrequencyLabel(
  groups: GroupedProduct[],
  catalog: Record<string, ProductCatalogEntry>,
  intervalDays: number | null,
): string | null {
  if (!intervalDays) return null;
  for (const g of groups) {
    const rule = catalog[g.product_id]?.pricing_rule;
    if (!rule) continue;
    const f = rule.available_frequencies?.find((x) => x.interval_days === intervalDays);
    if (f?.label) return f.label.toLowerCase();
  }
  return null;
}

function prettyVariantTitle(title: string | null | undefined): string {
  if (!title) return "Select";
  // "Default Title" is Shopify's placeholder for products with no variants —
  // never surface that text to customers.
  if (title === "Default Title") return "Original";
  return title;
}

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// Lightweight color tint helper — darkens the brand color N steps for
// summary-bar segments after the primary one. Pure visual variety, not
// a designed palette.
function tintColor(hex: string, step: number): string {
  // Strip "#", parse rgb, blend toward black by 12% per step.
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;
  const f = Math.max(0, 1 - step * 0.12);
  r = Math.round(r * f);
  g = Math.round(g * f);
  b = Math.round(b * f);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}
