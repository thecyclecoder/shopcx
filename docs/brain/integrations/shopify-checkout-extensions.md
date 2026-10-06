# shopify-checkout-extensions

The three Shopify **checkout UI extensions** in `shopify-extension/extensions/` — blocks that render inside Shopify's hosted checkout (not the theme). Each is a `purchase.checkout.block.render` target the merchant places in the checkout editor, and each reads from a ShopCX API route.

| Extension | Handle | Shows | Calls |
|---|---|---|---|
| Trust Card (was Money-Back Guarantee) | `guarantee-checkout` | Compact card at the top of checkout: first cart line's product image, "★★★★★ 4.8 · 13,003 reviews" for the cart's most-reviewed product (`display_count`, off-platform bump included), a rotating short 5★ quote (weight rail + "Results vary."), and the guarantee headline (policy-gated) plus an optional `trust_line` setting. Each part fails closed. | `GET /api/storefront/guarantee?shop=` + `GET /api/storefront/{workspace}/product-reviews?shopify_product_id=&limit=24` |
| Customer Reviews | `reviews-checkout` | Up to twelve short 5★ quotes across the cart (round-robin over products, one per reviewer), three on screen with prev/next arrows paged locally. A body ≤140 chars shows as written, a longer one shows its `summary` (Haiku one-liner); weight-loss rail applied to the shown line | `GET /api/storefront/{workspace}/product-reviews?shopify_product_id=&limit=24` (returns `summary` alongside `body`, and `aggregate.display_count`) |
| Loyalty Rewards | `loyalty-checkout` | Points balance + redeem-a-tier → discount code applied to checkout | `GET /api/loyalty/balance`, `POST /api/loyalty/redeem` |

## Runtime: Preact + Polaris web components (API 2025-10+)

All three target `api_version = "2025-10"`. From 2025-10 Shopify checkout extensions are **Preact + Polaris web components** (`<s-stack>`, `<s-text>`, `<s-box>` …) with checkout state on the `shopify` global (`shopify.settings.value`, `shopify.shop`, `shopify.lines.value`, `shopify.buyerIdentity.customer.value`, `shopify.applyDiscountCodeChange`). Entry shape:

```jsx
import "@shopify/ui-extensions/preact";
import { render } from "preact";
export default function extension() { render(<Block />, document.body); }
```

**`@shopify/ui-extensions-react` has no 2025.10 release** (last is 2025.7.x). The guarantee and reviews blocks originally shipped (#3015, #3016) as React on 2025-10, which could not install or render — the guarantee block sat on the checkout page showing nothing while its API returned `enabled: true`. Ported 2026-10-06.

Per-extension files: `package.json` (`@shopify/ui-extensions` 2025.10.x, `preact`, `@preact/signals`), `tsconfig.json` (jsxImportSource preact, `checkJs`), `shopify.d.ts` (types the `shopify` global for the target). Typecheck one with `cd shopify-extension/extensions/<handle> && npx -p typescript@5 tsc --noEmit -p tsconfig.json` — it validates `s-*` props and icon names (e.g. `shield-check` is not in the checkout icon set; the guarantee uses `check-circle`). The root `tsconfig.json` excludes `shopify-extension/`.

## Backend contract

- Every route a checkout extension calls must send `Access-Control-Allow-Origin: *` — extensions run in a Web Worker with a **null origin**, so an allowlist can't match.
- It must also be public in `src/lib/supabase/middleware.ts` `PUBLIC_ROUTES`, or anonymous checkout requests get redirected to `/login`.
- `/api/storefront/*` satisfies both. **`/api/loyalty/*` satisfies neither**, so the loyalty block cannot load its balance in checkout yet. Making it public is not enough on its own: `POST /api/loyalty/redeem` trusts the `workspace_id` + `shopify_customer_id` in the body, so opening it would let anyone spend a customer's points. It needs Shopify session-token verification (`shopify.sessionToken.get()` on the client, verified server-side) before it is exposed.

## Review count: `display_count`, never a literal

`aggregate.display_count` = true count + `workspaces.storefront_off_platform_review_count` (10,000 for Superfoods, the Yotpo-era reviews whose rows are gone), added server-side in the product-reviews route. It is the same number the Shopify PDP shows via the `reviews.rating_count` metafield ([[../libraries/shopify-review-metafields]] § The +10,000 off-platform bump). The rating is never bumped. Never add a bump inside an extension; it double-counts.

## Fail-closed design

Guarantee and reviews render **nothing** until data arrives and nothing on any error — no skeleton, no hardcoded fallback. A guarantee is a legal promise sourced from [[../tables/policies]] via `getPolicyCustomerFacing`; reviews come from `product_reviews`, the same corpus as the PDP. Neither declares `block_progress`, so neither can stop a checkout.

## Deploy

`cd shopify-extension && npm install && npx shopify app deploy`. Network access for checkout extensions must also be approved for the app in the Partner Dashboard, or `fetch` is blocked at runtime. `api_endpoint` (and `workspace` for reviews) are merchant settings in the checkout editor; both default to production values.

## Related

- [[shopify]] — Admin API, app config (`shopify-extension/shopify.app.toml`)
- [[../tables/policies]] — source of the guarantee
- [[../lifecycles/customer-portal]] — the other extension in this app (theme app extension)
