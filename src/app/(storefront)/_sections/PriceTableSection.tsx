"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PageData, PricingRule, PricingTier } from "../_lib/page-data";
import { TrustChipRow } from "../_components/TrustChipRow";
import { ShopCTA } from "../_components/ShopCTA";
import { PackageStack } from "../_components/PackageStack";

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

        {hasAnySubscribe && <SubscribeToggle mode={mode} setMode={setMode} />}

        {/* Frequency picker — only when subscribing AND the rule
            defines available frequencies. Subtle inline dropdown
            (selected label + chevron) keeps friction low; the other
            options live a click away. */}
        {mode === "subscribe" && frequencies.length > 1 && (
          <div className="mb-12 flex justify-center">
            <FrequencyPicker
              frequencies={frequencies}
              value={freqDays}
              onChange={setFreqDays}
            />
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
              variantImageUrl={data.base_variant?.image_url || null}
              servingsPerPack={data.base_variant?.servings || null}
              servingsUnit={data.base_variant?.servings_unit || null}
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

/**
 * Defensive scrub for the saved free_gift_product_title — strips a
 * trailing "— Default Title" / "- Default Title" left over from when
 * the dashboard concatenated product + variant titles without
 * guarding the Shopify placeholder. New rules saved through the
 * updated dashboard never carry it; this catches the pre-fix data.
 */
function stripDefaultTitle(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/\s*[—–\-]\s*Default Title\s*$/i, "").trim();
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
  /**
   * MSRP for the whole tier (base variant price × quantity, with no
   * discounts applied). The "Save N%" badge and the strikethrough
   * compare against this so quantity + subscribe discounts stack.
   * Null when we can't infer base price (legacy tiers).
   */
  msrp_total_cents: number | null;
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
      msrp_total_cents: subtotal,
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
    // Legacy tiers don't carry an MSRP. The savings badge will hide
    // for these unless we infer it from per_unit × quantity.
    msrp_total_cents: null,
  };
}

function PriceCard({
  tier,
  mode,
  rule,
  freqDays,
  variantImageUrl,
  servingsPerPack,
  servingsUnit,
}: {
  tier: DisplayTier;
  mode: "subscribe" | "onetime";
  rule: PricingRule | null;
  freqDays: number | null;
  variantImageUrl: string | null;
  servingsPerPack: number | null;
  servingsUnit: string | null;
}) {
  const showSubscribe = mode === "subscribe" && tier.subscribe_price_cents != null;
  const price = showSubscribe ? tier.subscribe_price_cents! : tier.price_cents;
  const perUnit = showSubscribe && tier.subscribe_price_cents != null
    ? Math.round(tier.subscribe_price_cents / Math.max(1, tier.quantity))
    : tier.per_unit_cents;

  // Total savings vs MSRP: combines the quantity-break discount AND
  // (when subscribing) the subscribe-save discount. We compare the
  // current displayed price against MSRP (base × quantity) so a
  // 3-pack subscribe shows the real ~36% off, not just the bare 25%
  // subscribe discount.
  const msrp = tier.msrp_total_cents;
  const savingsCents = msrp != null ? msrp - price : 0;
  const savingsPct = msrp != null && msrp > 0
    ? Math.round(((msrp - price) / msrp) * 100)
    : 0;
  const showSavings = msrp != null && savingsCents > 0;

  // Perk visibility — the rule decides whether free shipping / free
  // gift apply only when subscribing, and the gift further requires
  // the tier qty to meet the rule's min-quantity gate.
  //
  // We render in three states per perk:
  //   - exists + appliesNow → green check + plain label
  //   - exists + sub-only + onetime mode → red X + "Only with
  //     Subscribe & Save" annotation (motivates the upsell)
  //   - doesn't exist OR fails a non-subscription gate (e.g. min qty)
  //     → hide the row entirely
  const freeShipExists = !!rule?.free_shipping;
  const freeShipApplies = freeShipExists
    && (!rule?.free_shipping_subscription_only || showSubscribe);
  const freeShipSubLocked = freeShipExists
    && !!rule?.free_shipping_subscription_only
    && !showSubscribe;

  const giftQtyOk = tier.quantity >= (rule?.free_gift_min_quantity || 1);
  const giftExists = !!rule?.free_gift_variant_id && giftQtyOk;
  const giftApplies = giftExists
    && (!rule?.free_gift_subscription_only || showSubscribe);
  const giftSubLocked = giftExists
    && !!rule?.free_gift_subscription_only
    && !showSubscribe;

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

      {variantImageUrl && (
        <div className="mb-4 flex h-40 items-end justify-center sm:h-44">
          <PackageStack imageUrl={variantImageUrl} count={tier.quantity} />
        </div>
      )}

      <div className="text-lg font-semibold text-zinc-900">{tier.tier_name}</div>

      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-4xl font-bold text-zinc-900">
          ${(price / 100).toFixed(2)}
        </span>
        {showSavings && msrp != null && (
          <span className="text-sm text-zinc-500 line-through">
            ${(msrp / 100).toFixed(2)}
          </span>
        )}
      </div>

      <div className="mt-1 text-sm text-zinc-600">
        ${(perUnit / 100).toFixed(2)} each · {tier.quantity} pack
        {servingsPerPack && servingsPerPack > 0 && (() => {
          // Per-serving breakdown: divide the current displayed total
          // by total servings (servings/pack × pack count). Helps the
          // customer compare against $/cup of regular coffee.
          const totalServings = servingsPerPack * tier.quantity;
          const perServing = price / totalServings;
          const unit = (servingsUnit || "serving").trim() || "serving";
          return (
            <>
              {" · "}
              <span className="whitespace-nowrap">
                ${(perServing / 100).toFixed(2)}/{unit}
              </span>
            </>
          );
        })()}
      </div>

      {showSavings && (
        <div className="mt-2 inline-flex w-fit rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
          Save {savingsPct}%
          {" · $"}
          {(savingsCents / 100).toFixed(2)}
        </div>
      )}

      <ul className="mt-5 space-y-2.5 text-sm text-zinc-700">
        {(freeShipApplies || freeShipSubLocked) && (
          <li className="flex items-start gap-2">
            {freeShipApplies ? <CheckIcon /> : <XIcon />}
            <span>
              Free shipping
              {freeShipSubLocked && (
                <span className="ml-1 text-xs text-zinc-500">
                  (Only with Subscribe &amp; Save)
                </span>
              )}
            </span>
          </li>
        )}
        {(giftApplies || giftSubLocked) && rule?.free_gift_product_title && (
          <li className="flex items-start gap-2">
            {giftApplies ? <CheckIcon /> : <XIcon />}
            {rule.free_gift_image_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={rule.free_gift_image_url}
                alt=""
                className="h-8 w-8 flex-shrink-0 rounded-md object-cover"
              />
            )}
            <span className="flex-1">
              Free {stripDefaultTitle(rule.free_gift_product_title)}
              {giftSubLocked && (
                <span className="ml-1 text-xs text-zinc-500">
                  (Only with Subscribe &amp; Save)
                </span>
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

function SubscribeToggle({
  mode,
  setMode,
}: {
  mode: "subscribe" | "onetime";
  setMode: (m: "subscribe" | "onetime") => void;
}) {
  const [helperOpen, setHelperOpen] = useState(false);

  return (
    <div className="mx-auto mb-8 max-w-md">
      <div className="mx-auto flex max-w-xs items-center rounded-full border border-zinc-200 bg-white p-1 shadow-sm">
        <button
          type="button"
          aria-pressed={mode === "subscribe"}
          onClick={() => setMode("subscribe")}
          style={mode === "subscribe" ? { backgroundColor: "var(--storefront-primary)" } : undefined}
          className={`flex-1 rounded-full px-4 py-2.5 text-sm font-semibold transition-colors ${
            mode === "subscribe" ? "text-white" : "text-zinc-700"
          }`}
        >
          Subscribe &amp; Save
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

      {/* Collapsible explainer — closed by default, click to reveal
          why subscribe-save is framed as the recommended choice. */}
      <button
        type="button"
        onClick={() => setHelperOpen(!helperOpen)}
        aria-expanded={helperOpen}
        className="mx-auto mt-4 flex w-full items-center justify-center gap-1.5 text-center text-sm font-medium text-zinc-700 hover:text-zinc-900"
      >
        <span>80% of customers choose Subscribe &amp; Save</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`flex-shrink-0 text-zinc-500 transition-transform ${helperOpen ? "rotate-180" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {helperOpen && (
        <p className="mx-auto mt-3 max-w-md text-center text-sm leading-relaxed text-zinc-700 sm:text-base">
          The best results come with at least 2-3 months of use, so Subscribe
          &amp; Save helps you save money while you reach your goals. Your
          first order comes with a 30-day money-back guarantee, so there&apos;s
          no risk in trying it.
        </p>
      )}
    </div>
  );
}

function FrequencyPicker({
  frequencies,
  value,
  onChange,
}: {
  frequencies: Array<{ interval_days: number; label: string; default?: boolean }>;
  value: number | null;
  onChange: (days: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = frequencies.find((f) => f.interval_days === value) || frequencies[0];
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape so the menu doesn't sit open if
  // the user moves on without picking. No portal needed since the
  // menu only ever floats over the row directly beneath the toggle.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block text-sm">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 font-medium text-zinc-700 transition-colors hover:bg-zinc-100"
      >
        <span className="text-zinc-500">Deliver</span>
        <span className="font-semibold text-zinc-900">{selected?.label || "Monthly"}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute left-1/2 top-full z-10 mt-2 min-w-[180px] -translate-x-1/2 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg"
        >
          {frequencies.map((f) => {
            const active = f.interval_days === value;
            return (
              <li key={f.interval_days}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(f.interval_days);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-50 ${
                    active ? "font-semibold text-zinc-900" : "text-zinc-700"
                  }`}
                >
                  <span>{f.label}</span>
                  {active && (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      className="text-emerald-600"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
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
      className="mt-0.5 flex-shrink-0 text-emerald-600"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// Red X for perks that exist on the rule but aren't granted on this
// mode — pairs with the "(Only with Subscribe & Save)" annotation so
// the lock-out reads as an upsell, not a missing feature.
function XIcon() {
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
      className="mt-0.5 flex-shrink-0 text-rose-500"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
