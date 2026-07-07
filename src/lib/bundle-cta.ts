/**
 * Bundle CTA target resolution — Phase 4 of offer-creator.
 *
 * The bundle PDP's Select Bundle CTA and the reasons-lander offer CTA both
 * need to know two things at click time:
 *   1. Which variant to add to the cart. Prefer the Starter Kit variant
 *      (`products.bundle_variant_id` → resolved to `data.bundle_variant.id`);
 *      fall back to the base variant so an unwired workspace still gets a
 *      working CTA.
 *   2. Which discount code to auto-apply. `products.bundle_coupon_code` (the
 *      $10 recurring_cycle_limit=1 for Superfoods) rides as data-coupon-code
 *      on the CTA and the storefront click handler forwards it as
 *      `discount_code` on the /api/cart POST.
 *
 * Kept out of the React component so the logic is unit-testable without a
 * JSX runtime.
 */
export interface BundleCtaTargets {
  /** The variant to add to the cart, or null when there's nothing to add. */
  variantId: string | null;
  /** The auto-applied coupon code, or null when none is configured. */
  couponCode: string | null;
}

export interface BundleCtaInput {
  bundle_variant?: { id: string | null } | null;
  base_variant?: { id: string | null } | null;
  bundle_coupon_code?: string | null;
}

export function resolveBundleCtaTargets(input: BundleCtaInput): BundleCtaTargets {
  const variantId =
    input.bundle_variant?.id ?? input.base_variant?.id ?? null;
  const couponCode = variantId ? input.bundle_coupon_code || null : null;
  return { variantId, couponCode };
}
