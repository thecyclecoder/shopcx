"use client";

import { useMemo, useState } from "react";
import type { PageData, PricingTier } from "../_lib/page-data";

/**
 * Price table — the only section that needs user interaction.
 *
 * Both the one-time and subscribe prices are pre-rendered into the DOM
 * so there's no calculation on the client. The toggle just swaps
 * visibility via a CSS data-attribute on the section.
 */
export function PriceTableSection({ data }: { data: PageData }) {
  const [mode, setMode] = useState<"subscribe" | "onetime">(
    data.pricing_tiers.some((t) => t.subscribe_price_cents) ? "subscribe" : "onetime",
  );

  const tiers = useMemo(
    () => [...data.pricing_tiers].sort((a, b) => a.display_order - b.display_order),
    [data.pricing_tiers],
  );

  if (tiers.length === 0) return null;

  const hasAnySubscribe = tiers.some((t) => t.subscribe_price_cents != null);

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
              className={`flex-1 rounded-full px-4 py-2.5 text-sm font-semibold transition-colors ${
                mode === "subscribe"
                  ? "bg-zinc-900 text-white"
                  : "text-zinc-700"
              }`}
            >
              Subscribe · Save
            </button>
            <button
              type="button"
              aria-pressed={mode === "onetime"}
              onClick={() => setMode("onetime")}
              className={`flex-1 rounded-full px-4 py-2.5 text-sm font-semibold transition-colors ${
                mode === "onetime" ? "bg-zinc-900 text-white" : "text-zinc-700"
              }`}
            >
              One-time
            </button>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-3 md:items-stretch">
          {tiers.map((tier) => (
            <PriceCard key={tier.id} tier={tier} mode={mode} />
          ))}
        </div>
      </div>
    </section>
  );
}

function PriceCard({ tier, mode }: { tier: PricingTier; mode: "subscribe" | "onetime" }) {
  const showSubscribe = mode === "subscribe" && tier.subscribe_price_cents != null;
  const price = showSubscribe ? tier.subscribe_price_cents! : tier.price_cents;
  const perUnit = tier.per_unit_cents ?? Math.round(price / tier.quantity);

  const subDiscount = tier.subscribe_discount_pct ?? 25;

  return (
    <div
      className={`relative flex flex-col rounded-2xl border p-6 transition-all ${
        tier.is_highlighted
          ? "border-zinc-900 bg-white shadow-lg md:-mt-4 md:mb-4"
          : "border-zinc-200 bg-white"
      }`}
    >
      {tier.badge && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-zinc-900 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-white">
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
        <li className="flex items-center gap-2">
          <CheckIcon /> Free shipping
        </li>
        <li className="flex items-center gap-2">
          <CheckIcon /> 30-day money-back
        </li>
        {showSubscribe && (
          <li className="flex items-center gap-2">
            <CheckIcon /> Cancel anytime
          </li>
        )}
      </ul>

      <a
        href={`#buy-${tier.variant_id}`}
        data-variant-id={tier.variant_id}
        data-mode={mode}
        className={`mt-6 inline-flex h-12 w-full items-center justify-center rounded-full text-sm font-semibold transition-colors ${
          tier.is_highlighted
            ? "bg-zinc-900 text-white hover:bg-zinc-800"
            : "border border-zinc-300 bg-white text-zinc-900 hover:border-zinc-900"
        }`}
      >
        Add to cart
      </a>
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
