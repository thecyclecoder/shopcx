"use client";

/**
 * Bundle pricing table — appears directly below the primary
 * PriceTableSection when the product has an upsell partner configured.
 * Two cards only:
 *
 *   Bundle-1 = 1 primary + 1 upsell  (2 total units)
 *   Bundle-2 = 2 primary + 2 upsell  (4 total units)
 *
 * Pricing math is intentionally simple — no bundle-specific rules:
 *
 *   - Total qty = (1 or 2) × 2  (one of each per bundle pack)
 *   - Lookup the primary's pricing_rule quantity_break whose
 *     `quantity` equals total_qty (falling back to the largest break
 *     <= total_qty when no exact match exists).
 *   - Discount % from that break is applied to the combined MSRP of
 *     (primary base price × N) + (upsell base price × N).
 *   - Subscribe & Save discount stacks on top using the primary's
 *     `subscribe_discount_pct`, same as the single-product table.
 *
 * Subscribe mode + frequency are read from the shared PricingModeContext
 * so they always match the primary table.
 */

import type { PageData } from "../_lib/page-data";
import { useActiveProductData } from "../_lib/active-member-context";
import { usePricingMode } from "../_lib/pricing-mode-context";
import { PackageStack } from "../_components/PackageStack";
import { ShopCTA } from "../_components/ShopCTA";
import {
  FormatToggle,
  SubscribeToggle,
  FrequencyPicker,
} from "./PriceTableSection";

export function BundlePriceTableSection({ data }: { data: PageData }) {
  const { pricingRule: rule, baseVariant } = useActiveProductData(data);
  const upsell = data.upsell;
  const shared = usePricingMode();

  if (!upsell) return null;
  if (!rule || !baseVariant) return null;
  if (!upsell.base_variant) return null;

  // Bundle table only makes sense when both products have known prices
  // (otherwise we can't compute the combined MSRP).
  const primaryPrice = baseVariant.price_cents;
  const upsellPrice = upsell.base_variant.price_cents;
  if (primaryPrice <= 0 || upsellPrice <= 0) return null;

  const breaks = rule.quantity_breaks || [];
  if (breaks.length === 0) return null;

  // Resolve the discount % for a given total unit count by finding the
  // highest break whose quantity is <= total. This matches how single-
  // product tier math works when a customer "lands between" two breaks.
  const discountForTotal = (total: number): number => {
    const eligible = breaks.filter(b => b.quantity <= total);
    if (eligible.length === 0) return 0;
    return eligible.reduce((max, b) => (b.discount_pct > max ? b.discount_pct : max), 0);
  };

  const subDiscount = rule.subscribe_discount_pct || 0;
  const showSubscribe = shared?.mode === "subscribe" && subDiscount > 0;
  const mode = shared?.mode ?? "subscribe";
  const setMode = shared?.setMode ?? (() => {});
  const freqDays = shared?.freqDays ?? null;
  const setFreqDays = shared?.setFreqDays ?? (() => {});
  const frequencies = rule.available_frequencies || [];
  const hasAnySubscribe = subDiscount > 0;

  const cards = [1, 2].map(n => {
    const totalUnits = n * 2;
    const msrp = primaryPrice * n + upsellPrice * n;
    const qtyDiscount = discountForTotal(totalUnits);
    const afterQty = Math.round(msrp * (1 - qtyDiscount / 100));
    const finalPrice = showSubscribe
      ? Math.round(afterQty * (1 - subDiscount / 100))
      : afterQty;
    const savingsCents = msrp - finalPrice;
    const savingsPct = msrp > 0 ? Math.round((savingsCents / msrp) * 100) : 0;
    return { n, totalUnits, msrp, qtyDiscount, finalPrice, savingsCents, savingsPct };
  });

  // No real savings on either card? Don't bother rendering the table —
  // it'd look like a duplicate of the single-product price table.
  if (cards.every(c => c.savingsCents <= 0)) return null;

  return (
    <section
      id="bundle-pricing"
      data-section="bundle-pricing"
      data-mode={mode}
      className="w-full scroll-mt-6 overflow-x-clip bg-white py-10 sm:py-14"
    >
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        {(() => {
          // Subtitle mentions "and free gifts" only when (a) the primary's
          // rule actually has a gift configured AND (b) at least one of
          // the bundle sizes meets the gift's min-quantity threshold.
          // Largest bundle = 4 units (2 primary + 2 upsell), so a min-qty
          // up to 4 keeps the gift in play; anything higher and we'd be
          // promising a gift no bundle can unlock.
          const giftAvailableForAnyBundle =
            !!rule.free_gift_variant_id
            && (rule.free_gift_min_quantity || 1) <= 4;
          const subtitle = giftAvailableForAnyBundle
            ? `Bundle ${data.product.title} & ${upsell.product.title} for even bigger discounts and free gifts.`
            : `Bundle ${data.product.title} & ${upsell.product.title} for even bigger discounts.`;
          return (
            <div className="mx-auto mb-6 max-w-2xl text-center">
              <span className="inline-flex rounded-full bg-orange-100 px-3 py-1 text-[11px] font-extrabold uppercase tracking-[0.18em] text-orange-700">
                Bundle &amp; Save
              </span>
              <h2 className="mt-3 text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl md:text-4xl">
                {data.product.bundle_name || `Add ${upsell.product.title}`}
              </h2>
              <p className="mt-2 text-[15px] text-zinc-600">{subtitle}</p>
            </div>
          );
        })()}

        {/* Same controls as the primary price table — kept in sync via
            the shared pricing-mode + active-member contexts. Customer
            can pick K-Cups/Instant, Subscribe/One-time, and frequency
            from either table; both update together. */}
        {data.link_group && data.link_group.members.length > 1 && (
          <FormatToggle linkGroup={data.link_group} data={data} />
        )}
        {hasAnySubscribe && <SubscribeToggle mode={mode} setMode={setMode} />}
        {mode === "subscribe" && frequencies.length > 1 && (
          <div className="mb-8 flex justify-center">
            <FrequencyPicker
              frequencies={frequencies}
              value={freqDays}
              onChange={setFreqDays}
            />
          </div>
        )}

        <div className="mx-auto grid max-w-4xl gap-4 md:grid-cols-2 md:items-stretch">
          {cards.map(card => (
            <BundleCard
              key={card.n}
              n={card.n}
              totalUnits={card.totalUnits}
              msrpTotalCents={card.msrp}
              finalPriceCents={card.finalPrice}
              savingsCents={card.savingsCents}
              savingsPct={card.savingsPct}
              qtyDiscountPct={card.qtyDiscount}
              subDiscountPct={showSubscribe ? subDiscount : 0}
              primaryImageUrl={baseVariant.image_url}
              primaryTitle={data.product.title}
              primaryVariantId={baseVariant.shopify_variant_id}
              upsellImageUrl={upsell.base_variant!.image_url}
              upsellTitle={upsell.product.title}
              upsellVariantId={upsell.base_variant!.shopify_variant_id}
              isHighlighted={card.n === 2}
              freqDays={shared?.mode === "subscribe" ? (shared?.freqDays ?? null) : null}
              mode={shared?.mode === "subscribe" ? "subscribe" : "onetime"}
              // Perks pulled from the primary's pricing_rule — same
              // gating logic as the single-product card so bundles
              // qualify for shipping/gift on the same terms.
              freeShipping={!!rule.free_shipping}
              freeShippingSubOnly={!!rule.free_shipping_subscription_only}
              freeGiftTitle={rule.free_gift_product_title || null}
              freeGiftImageUrl={rule.free_gift_image_url || null}
              freeGiftPriceCents={rule.free_gift_price_cents || null}
              freeGiftMinQty={rule.free_gift_min_quantity || 1}
              freeGiftSubOnly={!!rule.free_gift_subscription_only}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function BundleCard({
  n,
  totalUnits,
  msrpTotalCents,
  finalPriceCents,
  savingsCents,
  savingsPct,
  qtyDiscountPct,
  subDiscountPct,
  primaryImageUrl,
  primaryTitle,
  primaryVariantId,
  upsellImageUrl,
  upsellTitle,
  upsellVariantId,
  isHighlighted,
  freqDays,
  mode,
  freeShipping,
  freeShippingSubOnly,
  freeGiftTitle,
  freeGiftImageUrl,
  freeGiftPriceCents,
  freeGiftMinQty,
  freeGiftSubOnly,
}: {
  n: number;
  totalUnits: number;
  msrpTotalCents: number;
  finalPriceCents: number;
  savingsCents: number;
  savingsPct: number;
  qtyDiscountPct: number;
  subDiscountPct: number;
  primaryImageUrl: string | null;
  primaryTitle: string;
  primaryVariantId: string | null;
  upsellImageUrl: string | null;
  upsellTitle: string;
  upsellVariantId: string | null;
  isHighlighted: boolean;
  freqDays: number | null;
  mode: "subscribe" | "onetime";
  freeShipping: boolean;
  freeShippingSubOnly: boolean;
  freeGiftTitle: string | null;
  freeGiftImageUrl: string | null;
  freeGiftPriceCents: number | null;
  freeGiftMinQty: number;
  freeGiftSubOnly: boolean;
}) {
  const perUnitCents = Math.round(finalPriceCents / Math.max(1, totalUnits));
  const isSubscribing = mode === "subscribe";

  // Free shipping eligibility — same gating as the primary card.
  const freeShipApplies = freeShipping && (!freeShippingSubOnly || isSubscribing);
  const freeShipSubLocked = freeShipping && freeShippingSubOnly && !isSubscribing;

  // Free gift eligibility — totalUnits is the count that gates the
  // gift, exactly like a 2-pack or 3-pack of a single product would.
  // Bundle-1 = 2 units, Bundle-2 = 4 units, so a min-qty of 2 unlocks
  // both bundles, and a min-qty of 4 unlocks only Bundle-2.
  const giftConfigured = !!freeGiftTitle;
  const giftQtyOk = totalUnits >= freeGiftMinQty;
  const giftSubOk = !freeGiftSubOnly || isSubscribing;
  const giftApplies = giftConfigured && giftQtyOk && giftSubOk;
  const giftBlocked = giftConfigured && !giftApplies;
  const giftBlockedReason = (() => {
    if (!giftBlocked) return null;
    const subPart = !giftSubOk ? "Subscribe & Save" : null;
    const qtyPart = !giftQtyOk ? `${freeGiftMinQty}+ items` : null;
    if (subPart && qtyPart) return `Only with ${subPart} on ${qtyPart}`;
    if (subPart) return `Only with ${subPart}`;
    if (qtyPart) return `On ${qtyPart}`;
    return null;
  })();

  // Strip the "— Default Title" suffix some older saved gift titles
  // carry (mirrors PriceTableSection's stripDefaultTitle helper).
  const cleanGiftTitle = (freeGiftTitle || "").replace(/\s*[—–\-]\s*Default Title\s*$/i, "").trim();

  return (
    <div
      style={isHighlighted ? { borderColor: "var(--storefront-primary)" } : undefined}
      className={`relative flex min-w-0 flex-col overflow-x-clip rounded-2xl border p-6 transition-all ${
        isHighlighted
          ? "bg-white shadow-lg md:-mt-3 md:mb-3"
          : "border-zinc-200 bg-white"
      }`}
    >
      {isHighlighted && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-orange-500 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-white">
          Best Value
        </span>
      )}

      <div className="mb-4 flex h-44 items-end justify-center sm:h-48">
        <PackageStack
          variants={[
            { imageUrl: primaryImageUrl, count: n },
            { imageUrl: upsellImageUrl, count: n },
          ]}
        />
      </div>

      <div className="text-lg font-semibold text-zinc-900">
        Bundle of {n}
      </div>
      <div className="text-sm text-zinc-600">
        {n} × {primaryTitle} + {n} × {upsellTitle}
      </div>

      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-4xl font-bold text-zinc-900">
          ${(finalPriceCents / 100).toFixed(2)}
        </span>
        <span className="text-sm font-semibold text-red-500 line-through">
          ${(msrpTotalCents / 100).toFixed(2)}
        </span>
      </div>

      <div className="mt-1 text-sm text-zinc-600">
        ${(perUnitCents / 100).toFixed(2)} per item · {totalUnits} items total
      </div>

      {savingsPct > 0 && (
        <div className="mt-2 inline-flex w-fit rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
          Save {savingsPct}%
          {" · $"}
          {(savingsCents / 100).toFixed(2)}
        </div>
      )}

      <ul className="mt-5 space-y-2.5 text-sm text-zinc-700">
        <li className="flex items-start gap-2">
          <CheckIcon />
          <span>
            <strong className="text-zinc-900">{n} × {primaryTitle}</strong>
          </span>
        </li>
        <li className="flex items-start gap-2">
          <CheckIcon />
          <span>
            <strong className="text-zinc-900">{n} × {upsellTitle}</strong>
          </span>
        </li>
        {qtyDiscountPct > 0 && (
          <li className="flex items-start gap-2">
            <CheckIcon />
            <span>
              {qtyDiscountPct}% quantity discount on both items
            </span>
          </li>
        )}
        {subDiscountPct > 0 && (
          <li className="flex items-start gap-2">
            <CheckIcon />
            <span>
              {subDiscountPct}% subscribe &amp; save stacked on top
            </span>
          </li>
        )}
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
        {(giftApplies || giftBlocked) && cleanGiftTitle && (
          <li className="flex items-start gap-2">
            {giftApplies ? <CheckIcon /> : <XIcon />}
            <span className="flex-1">
              Free {cleanGiftTitle}
              {giftBlockedReason && (
                <span className="ml-1 text-xs text-zinc-500">
                  ({giftBlockedReason})
                </span>
              )}
            </span>
          </li>
        )}
        <li className="flex items-center gap-2">
          <CheckIcon /> 30-day money-back
        </li>
        {mode === "subscribe" && (
          <li className="flex items-center gap-2">
            <CheckIcon /> Cancel anytime
          </li>
        )}
      </ul>

      {/* Big free-gift callout — only when the gift actually applies
          to this bundle + mode. Mirrors the primary card's treatment. */}
      {giftApplies && cleanGiftTitle && (
        <div className="mt-5 flex items-center gap-3 rounded-xl bg-amber-100 p-3 ring-1 ring-amber-200">
          {freeGiftImageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={freeGiftImageUrl}
              alt=""
              className="h-16 w-16 flex-shrink-0 rounded-lg bg-white object-contain p-1.5 shadow-sm sm:h-20 sm:w-20"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-extrabold uppercase tracking-wider text-amber-700 sm:text-xs">
              Plus a free gift
            </div>
            <div className="mt-0.5 text-sm font-bold leading-tight text-zinc-900 sm:text-base">
              {cleanGiftTitle}
            </div>
            {freeGiftPriceCents != null && freeGiftPriceCents > 0 && (
              <div className="mt-1 inline-flex items-baseline gap-1 text-xs font-semibold text-amber-700 sm:text-sm">
                <span className="text-zinc-500 line-through">
                  ${(freeGiftPriceCents / 100).toFixed(2)}
                </span>
                <span>value · yours free</span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mt-6">
        <ShopCTA
          href={`#buy-bundle-${n}`}
          label="Select bundle"
          size="compact"
          variant="primary"
          showTrust={false}
          align="center"
          dataAttributes={{
            "bundle-size": n,
            "primary-variant-id": primaryVariantId,
            "primary-quantity": n,
            "upsell-variant-id": upsellVariantId,
            "upsell-quantity": n,
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
    <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
