# bundle-cta.ts — bundle CTA target resolution

`src/lib/bundle-cta.ts` · pure function that resolves the (variant, coupon) pair the Starter Kit Select Bundle CTA should attach. Phase 4 of [[../specs/offer-creator]]. Kept out of the React component so the two-line-of-logic is unit-testable without a JSX runtime.

## Export

```ts
resolveBundleCtaTargets({
  bundle_variant?: { id: string | null } | null;
  base_variant?:   { id: string | null } | null;
  bundle_coupon_code?: string | null;
}): { variantId: string | null; couponCode: string | null };
```

## Rules

1. **Variant** — prefer `bundle_variant.id` ([[../tables/products]]`.bundle_variant_id`); fall back to `base_variant.id` so an unwired workspace still gets a working CTA. When both are null, `variantId` is null and the caller renders `#pricing` (scroll-to).
2. **Coupon** — return `bundle_coupon_code` only when a `variantId` was resolved. A coupon without a variant target is meaningless (no cart-add fires), so we suppress it to avoid mystifying analytics.

## Callers

- `src/app/(storefront)/_sections/HeroSection.tsx` (bundle mode) — writes the resolved variant + coupon onto the CTA's data-attributes so the storefront click handler forwards them to `/api/cart`.

## Test

`src/lib/bundle-cta.test.ts` — pins the four cases: Starter Kit set, fallback to base, coupon suppressed when no variant, both null.

---

[[../README]] · [[../tables/offers]] · [[../tables/products]]
