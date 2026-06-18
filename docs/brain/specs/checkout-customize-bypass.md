# Checkout customize-bypass (straight PDP → checkout) ✅

**Owner:** [[../functions/growth]] · **Parent:** Growth mandate "Storefront CRO"

Status: 🚧 built (pending live verify) · owner: Dylan · created 2026-06-16

## Context
The funnel today is **PDP → pack-select → /customize → /checkout**. The `/customize`
worksheet (variant/flavor picker, qty, Instant↔K-Cups swap, sub/one-time, frequency)
is an extra step most buyers don't need — every choice already has a sensible default
baked into the cart. Forcing it adds friction between intent (pack-select) and payment.

**Goal:** pack-select goes **straight to /checkout**. Customize becomes an opt-in
escape hatch via a "Customize your order" button on checkout — not a default funnel step.
Add-to-cart / Meta CAPI events must keep firing.

(A prior session built this and crashed with no surviving work — rebuilding from spec.)

## Key facts (from the flow map)
- **Cart is created on pack-select**, not on customize: `StorefrontPixelInit.tsx` (~L183) POSTs `/api/cart` with the tier's variant + qty + `mode` (default `subscribe`) + default frequency, then navigates to `/customize?token=…`.
- **`add_to_cart` (→ Meta `AddToCart` CAPI) already fires at pack-select** (`StorefrontPixelInit.tsx` ~L166-170), BEFORE cart create + navigation. Skipping customize does NOT drop it. ✅
- **Checkout is standalone**: loads the cart by token, fully formed; it does not depend on customize having run. `checkout_view` (→ `InitiateCheckout`) fires on checkout mount (`CheckoutClient.tsx` ~L239).
- **Customize is non-load-bearing**: all defaults (variant by position, `subscribe`, default frequency from `pricing_rule.available_frequencies[].default`) are set by `/api/cart`.

## Decisions
1. **Pack-select → `/checkout?token=…`** instead of `/customize?token=…`. One-line nav change in `StorefrontPixelInit.tsx`.
2. **"Customize your order" link/button on checkout**, near the cart-items summary → `/customize?token=…`. The customize page already loads standalone by token and its "Continue" returns to `/checkout?token=…`, so the round-trip works unchanged.
3. **Events**: `add_to_cart` keeps firing at pack-select (no change). `customize_view` simply stops firing on the default path (it becomes a rare event for users who opt in) — acceptable; the funnel dashboard already treats chapters/steps as optional.
4. **De-dupe `checkout_view`**: checkout is now the first page AND the return target from customize, so guard the `checkout_view`/`InitiateCheckout` fire to **once per cart token** (sessionStorage) so a customize round-trip doesn't double-count `InitiateCheckout`.
5. **Reversible**: gate the bypass on a workspace setting `storefront_skip_customize` (default **true** for Superfoods) so it's A/B-toggleable without a deploy. The customize button shows whenever the bypass is on.

## Files to touch
- `src/app/(storefront)/_components/StorefrontPixelInit.tsx` — nav target on cart-create success (`/checkout` vs `/customize`), gated on the setting.
- `src/app/(storefront)/checkout/_components/CheckoutClient.tsx` — "Customize your order" button near cart items; `checkout_view` once-per-token guard.
- `src/app/(storefront)/checkout/page.tsx` — pass the customize URL / setting through to the client (already has the token).
- `src/app/(storefront)/_lib/page-data.ts` (or the PDP data load) — surface `storefront_skip_customize` to `StorefrontPixelInit`.
- migration: `workspaces.storefront_skip_customize boolean default false` (set true for Superfoods).

## Verification
- PDP → select pack → lands directly on `/checkout` with the cart populated (right variant/qty/mode/freq).
- Network: `add_to_cart` event still POSTs at pack-select (check `storefront_events` + Meta CAPI `AddToCart`).
- `checkout_view`/`InitiateCheckout` fires once on first checkout load; clicking **Customize your order** → `/customize` → edit → Continue → back on `/checkout` does NOT fire a second `InitiateCheckout`.
- Order completes; `order_placed`/`Purchase` fires as before.
- Flip `storefront_skip_customize=false` → flow reverts to PDP→customize→checkout.

## Out of scope
- Redesigning the customize worksheet itself.
- Any change to cart pricing / gifts / OTP / payment.

## Related
[[../lifecycles/storefront-checkout]] · [[../dashboard/storefront__funnel]] · [[../tables/cart_drafts]] · [[../integrations/meta]] · [[../inngest/meta-capi-dispatch]]
