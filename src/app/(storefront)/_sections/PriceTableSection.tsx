"use client";

import { useMemo, useState } from "react";
import type { PageData, PricingRule, PricingTier } from "../_lib/page-data";
import { TrustChipRow } from "../_components/TrustChipRow";
import { ShopCTA } from "../_components/ShopCTA";

/**
 * Price table — rule-driven.
 *
 * Reads the assigned pricing_rule and applies its quantity_breaks to
 * the product's base variant price to produce tiers. Subscribe vs
 * one-time is toggled at the top; the subscribe price is the same
 * tier total minus the rule's `subscribe_discount_pct`. Frequency
 * picker shows when the rule defines available_frequencies.
 *
 * Falls back to the legacy product_pricing_tiers payload when no rule
 * is assigned so older products keep rendering during the migration.
 *
 * Free shipping + free gift bullets respect the rule's
 * `_subscription_only` toggles, and the gift line further checks the
 * selected tier quantity against `free_gift_min_quantity`.
 */
export function PriceTableSection({ data }: { data: PageData }) {
  const rule = data.pricing_rule;
  const baseVariant = data.base_variant;

  // Build tiers either from the rule (preferred) or from the legacy
  // product_pricing_tiers payload. Both code paths produce the same
  // shape so the renderer below doesn't need to branch.
  const tiers = useMemo<DisplayTier[]>(() => {
    if (rule && baseVariant && (rule.quantity_breaks || []).length > 0) {
      return buildTiersFromRule(rule, baseVariant.price_cents, baseVariant.shopify_variant_id);
    }
    return [...data.pricing_tiers]
      .sort((a, b) => a.display_order - b.display_order)
      .map(legacyToDisplay);
  }, [rule, baseVariant, data.pricing_tiers]);

  const hasAnySubscribe = tiers.some((t) => t.subscribe_price_cents != null);
  const [mode, setMode] = useState<"subscribe" | "onetime">(
    hasAnySubscribe ? "subscribe" : "onetime",
  );

  // Default frequency = the one flagged default, else the first one.
  const frequencies = rule?.available_frequencies || [];
  const defaultFreq = frequencies.find((f) => f.default) || frequencies[0] || null;
  const [freqDays, setFreqDays] = useState<number | null>(
    defaultFreq?.interval_days ?? null,
  );

  if (tiers.length === 0) return null;

  return (
    <section
      id="pricing"
      data-section="pricing"
      data-mode={mode}
      className="w-full scroll-mt-6 bg-zinc-50 py-12 sm:py-16"
    >
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        <h2 className="mb-4 text-center text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl md:text-4xl">
          Choose your pack
        </h2>

        {hasAnySubscribe && (
          <div className="mx-auto mb-8 flex max-w-xs items-center rounded-full border border-zinc-200 bg-white p-1 shadow-sm">
            <button
              type="button"
              aria-pressed={mode === "subscribe"}
              onClick={() => setMode("subscribe")}
              style={mode === "subscribe" ? { backgroundColor: "var(--storefront-primary)" } : undefined}
              className={`flex-1 rounded-full px-4 py-2.5 text-sm font-semibold transition-colors ${
                mode === "subscribe" ? "text-white" : "text-zinc-700"
              }`}
            >
              Subscribe · Save
            </button>
            <button
              type="button"
              aria-pressed={mode === "onetime"}
              onClick={() => setMode("onetime")}
              style={mode === "onetime" ? { backgroundColor: "var(--storefront-primary)" } : undefined}
              className={`flex-1 rounded-full px-4 py-2.5 text-sm font-semibold transition-colors ${
                mode === "onetime" ? "text-white" : "text-zinc-700"
              }`}
            >
              One-time
            </button>
          </div>
        )}

        {/* Frequency picker — only when subscribing AND the rule
            defines available frequencies. Compact pill-radio strip. */}
        {mode === "subscribe" && frequencies.length > 1 && (
          <div className="mx-auto mb-8 flex max-w-xl flex-wrap items-center justify-center gap-2">
            <span className="text-sm font-semibold text-zinc-600">Deliver</span>
            {frequencies.map((f) => {
              const active = freqDays === f.interval_days;
              return (
                <button
                  key={f.interval_days}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFreqDays(f.interval_days)}
                  style={active ? { backgroundColor: "var(--storefront-primary)", borderColor: "var(--storefront-primary)" } : undefined}
                  className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                    active
                      ? "text-white"
                      : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-400"
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-3 md:items-stretch">
          {tiers.map((tier) => (
            <PriceCard
              key={tier.id}
              tier={tier}
              mode={mode}
              rule={rule}
              freqDays={freqDays}
            />
          ))}
        </div>

        {((data.product.certifications || []).length > 0 ||
          (data.product.allergen_free || []).length > 0) && (
          <div className="mt-10">
            <TrustChipRow
              certifications={data.product.certifications}
              allergenFree={data.product.allergen_free}
              align="center"
            />
          </div>
        )}
      </div>
    </section>
  );
}

/** Display tier — common shape for rule-driven + legacy tiers. */
interface DisplayTier {
  id: string;
  variant_id: string | null;
  tier_name: string;
  quantity: number;
  price_cents: number;
  subscribe_price_cents: number | null;
  per_unit_cents: number;
  badge: string | null;
  is_highlighted: boolean;
  /** Cached % off for the "Save N%" pill in subscribe mode. */
  subscribe_discount_pct: number | null;
}

function buildTiersFromRule(
  rule: PricingRule,
  basePriceCents: number,
  shopifyVariantId: string | null,
): DisplayTier[] {
  const subDiscount = rule.subscribe_discount_pct || 0;
  // Highlight the middle break by default; if there's a label like
  // "Most Popular" the admin can leverage that, but the visual lift
  // hangs off display_order regardless.
  const middle = Math.floor((rule.quantity_breaks.length - 1) / 2);
  return rule.quantity_breaks.map((b, i) => {
    const subtotal = basePriceCents * b.quantity;
    const tierTotal = Math.round(subtotal * (1 - (b.discount_pct || 0) / 100));
    const subscribeTotal = subDiscount > 0
      ? Math.round(tierTotal * (1 - subDiscount / 100))
      : null;
    const perUnit = Math.round(tierTotal / b.quantity);
    return {
      id: `rule-${rule.id}-${i}`,
      variant_id: shopifyVariantId,
      tier_name: b.label || `${b.quantity}-pack`,
      quantity: b.quantity,
      price_cents: tierTotal,
      subscribe_price_cents: subscribeTotal,
      subscribe_discount_pct: subDiscount || null,
      per_unit_cents: perUnit,
      badge: i === middle && rule.quantity_breaks.length >= 3 ? "Most Popular" : null,
      is_highlighted: i === middle && rule.quantity_breaks.length >= 3,
    };
  });
}

function legacyToDisplay(t: PricingTier): DisplayTier {
  return {
    id: t.id,
    variant_id: t.variant_id,
    tier_name: t.tier_name,
    quantity: t.quantity,
    price_cents: t.price_cents,
    subscribe_price_cents: t.subscribe_price_cents,
    subscribe_discount_pct: t.subscribe_discount_pct,
    per_unit_cents: t.per_unit_cents ?? Math.round(t.price_cents / Math.max(1, t.quantity)),
    badge: t.badge,
    is_highlighted: t.is_highlighted,
  };
}

function PriceCard({
  tier,
  mode,
  rule,
  freqDays,
}: {
  tier: DisplayTier;
  mode: "subscribe" | "onetime";
  rule: PricingRule | null;
  freqDays: number | null;
}) {
  const showSubscribe = mode === "subscribe" && tier.subscribe_price_cents != null;
  const price = showSubscribe ? tier.subscribe_price_cents! : tier.price_cents;
  const perUnit = showSubscribe && tier.subscribe_price_cents != null
    ? Math.round(tier.subscribe_price_cents / Math.max(1, tier.quantity))
    : tier.per_unit_cents;

  const subDiscount = tier.subscribe_discount_pct ?? 25;

  // Perk visibility — rule decides whether free shipping / free gift
  // apply only when subscribing, and the gift further requires the
  // tier qty to meet the rule's min-quantity gate.
  const freeShipApplies = rule?.free_shipping
    ? rule.free_shipping_subscription_only
      ? showSubscribe
      : true
    : false;
  const giftApplies = !!rule?.free_gift_variant_id
    && tier.quantity >= (rule.free_gift_min_quantity || 1)
    && (!rule.free_gift_subscription_only || showSubscribe);

  return (
    <div
      style={tier.is_highlighted ? { borderColor: "var(--storefront-primary)" } : undefined}
      className={`relative flex flex-col rounded-2xl border p-6 transition-all ${
        tier.is_highlighted
          ? "bg-white shadow-lg md:-mt-4 md:mb-4"
          : "border-zinc-200 bg-white"
      }`}
    >
      {tier.badge && (
        <span
          style={{ backgroundColor: "var(--storefront-primary)" }}
          className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider text-white"
        >
          {tier.badge}
        </span>
      )}

      <div className="text-lg font-semibold text-zinc-900">{tier.tier_name}</div>

      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-4xl font-bold text-zinc-900">
          ${(price / 100).toFixed(2)}
        </span>
        {showSubscribe && (
          <span className="text-sm text-zinc-500 line-through">
            ${(tier.price_cents / 100).toFixed(2)}
          </span>
        )}
      </div>

      <div className="mt-1 text-sm text-zinc-600">
        ${(perUnit / 100).toFixed(2)} each · {tier.quantity} pack
      </div>

      {showSubscribe && (
        <div className="mt-2 inline-flex w-fit rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
          Save {subDiscount}%
        </div>
      )}

      <ul className="mt-5 space-y-2 text-sm text-zinc-700">
        {freeShipApplies && (
          <li className="flex items-center gap-2">
            <CheckIcon /> Free shipping
            {rule?.free_shipping_subscription_only && (
              <span className="text-xs text-zinc-500">(on subscriptions)</span>
            )}
          </li>
        )}
        {giftApplies && rule?.free_gift_product_title && (
          <li className="flex items-center gap-2">
            <CheckIcon />
            <span>
              Free {rule.free_gift_product_title}
              {rule.free_gift_subscription_only && (
                <span className="ml-1 text-xs text-zinc-500">(on subscriptions)</span>
              )}
            </span>
          </li>
        )}
        <li className="flex items-center gap-2">
          <CheckIcon /> 30-day money-back
        </li>
        {showSubscribe && (
          <li className="flex items-center gap-2">
            <CheckIcon /> Cancel anytime
          </li>
        )}
      </ul>

      <div className="mt-6">
        <ShopCTA
          href={`#buy-${tier.variant_id}`}
          label="Add to cart"
          size="compact"
          variant={tier.is_highlighted ? "primary" : "inverse"}
          showTrust={false}
          align="center"
          dataAttributes={{
            "variant-id": tier.variant_id,
            mode,
            "frequency-days": mode === "subscribe" ? freqDays : null,
          }}
        />
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-shrink-0 text-emerald-600"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
