# shopify-checkout-extensions

The Shopify **checkout UI extensions** (and one discount function, § Free Cinnamon Roll Creamer discount function) in `shopify-extension/extensions/` — blocks that render inside Shopify's hosted checkout (not the theme). Each is a `purchase.checkout.block.render` target the merchant places in the checkout editor, and each reads from a ShopCX API route.

| Extension | Handle | Shows | Calls |
|---|---|---|---|
| Trust Card (was Money-Back Guarantee) | `guarantee-checkout` | The checkout's heading band (tinted, no border): "You're almost there[, {first name}]" (first name only when protected customer data allows, else omitted), then a side-by-side grid of the first cart line's product image and "★★★★★ 4.7 · 11,882 reviews" for the cart's most-reviewed product (the Shopify page's numbers: `display_rating` / `display_count`, shown exact), a rotating short 5★ quote (weight rail + "Results vary."), and the guarantee headline (policy-gated) plus an optional `trust_line` setting. Each part fails closed. | `GET /api/storefront/guarantee?shop=` + `GET /api/storefront/{workspace}/product-reviews?shopify_product_id=&limit=24` |
| Customer Reviews | `reviews-checkout` | Up to twelve short 5★ quotes across the cart (round-robin over products, one per reviewer), three on screen with prev/next arrows paged locally. A body ≤140 chars shows as written, a longer one shows its `summary` (Haiku one-liner); weight-loss rail applied to the shown line | `GET /api/storefront/{workspace}/product-reviews?shopify_product_id=&limit=24` (returns `summary` alongside `body`, and `aggregate.display_rating` / `display_count`) |
| Shipping Trust | `shipping-checkout` | Two quiet lines by the shipping options: "🚚 Estimated arrival Mon, Oct 12 – Thu, Oct 15" (today + `arrival_min_days`..`arrival_max_days`, defaults 6..9, a Sunday end moved to Monday) and USPS + DHL marks with "Tracked from our warehouse to your door". Every claim is measured; see § Shipping claims | Nothing (static). Logos load from `{api_endpoint}/checkout/usps.png` / `dhl.png` in the Next app's `public/` |
| Shipping Protection | `protection-checkout` | One checkbox + shield badge, ON by default, merchant-placed under the shipping address: "Shipping Protection ~~$9.95~~ $4.95 · Protect yourself against damage or loss. 100% replacement guarantee." Keeps exactly one protection line in the cart, subscription-aware; see § Shipping Protection toggle | Nothing (static). Writes cart lines via `applyCartLinesChange` and the `_shipping_protection` checkout attribute |
| Money-Back Guarantee Terms | `mbg-checkout` | Standalone guarantee block, centered on a tinted (`subdued`) card: the store's gold "100% Money Back Guarantee" seal at 112px (Shopify Files `money-back-guarantee.png`, or `badge_url`), heading "Love it, or your money back", "Try your first order for 30 days. If it's not for you, send it back for a refund.", and a "How the 30-day guarantee works" link opening an `s-modal` with the published Returns policy section by section. Shown to everyone, returning customers included | `GET /api/storefront/guarantee?shop=` (`terms`) |
| Loyalty Rewards | `loyalty-checkout` | Points balance + redeem-a-tier → discount code applied to checkout | `GET /api/loyalty/balance`, `POST /api/loyalty/redeem` |

## Shipping Protection toggle

`protection-checkout` treats the cart as its state and reconciles it on every render toward one desired line:

- **Exactly one protection line, quantity 1.** Lines of the live product (Shopify product `8356945952941`, handle `addons-first-101y98`) and of the two retired protection products (UpCart `7510145040557`, ShopWill `7634377900205`) all count, so an add from a cart drawer can't double it; extras are removed and quantity trimmed to 1.
- **Subscription-aware.** If any other line has a `sellingPlan`, protection is the **subscription variant on that same selling plan**, so it joins the same Appstle subscription and renews with it; otherwise the **one-time variant**. Gaining or losing a subscription line swaps the version. Both bill **$4.95**: one-time variant $4.95; subscription variant $6.60 with the "Superfood Subscription" plans' 25% off. The **$9.95** is a visual anchor drawn by the block only; there is no compare-at price in Shopify.
- **On by default.** Added on first render when missing. Unchecking writes checkout attribute `_shipping_protection=declined` (re-checking writes `accepted`), so the opt-out survives reloads. A cart with nothing but protection gets no protection.
- **Product setup (2026-10-06):** option `Type` on the live product: `Subscription` variant `45036181651629` at $6.60, `One-time` variant `67144482881709` at $4.95, both SKU `insure01`, inventory untracked. Re-pricing either one changes what the shopper pays; keep Subscription × 0.75 = One-time.
- **Variant ids are block settings** (`one_time_variant_id`, `subscription_variant_id`, numeric) with those production defaults in the code; `badge_url` overrides the shield image (default: the product's own image on the Shopify CDN). If the variant for the current cart type is missing, the block renders nothing.
- If the checkout can't add/remove lines or write attributes (`shopify.instructions`), it renders nothing and changes nothing.

## Guarantee terms modal

`mbg-checkout` shows only while the live `refunds` policy offers a money-back guarantee (the same gate as the trust card's line). Its modal content is the published **`returns`** policy (`getPolicyCustomerFacing(..., "returns").customer_summary`), which the guarantee route turns into plain-text `terms: [{ heading, blocks: [{ type: "paragraph" | "item", text }] }]`: `## ` opens a section, `- ` lines are list items, the `# ` title is dropped, and `**bold**` / `[label](href)` keep only their words. The policy's own words, never paraphrased, so editing the policy updates checkout with no deploy. No returns policy → no "See terms" link; the headline still shows.

The block's one sentence is narrow on purpose: the guarantee covers the **first order only** and the **return label cost is deducted**, so the copy says "your first order" and "a refund", never "risk-free" or "full refund". It shows for everyone, signed-in returning customers included (founder's call, 2026-10-06; it first shipped hiding itself for buyers with a past order, which hid it from every signed-in test checkout): "your first order" in the copy and the terms modal carry the scope.

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

## Review count: `display_rating` / `display_count`, never a literal

The product-reviews aggregate carries two scopes. `rating` / `count` are POOLED across the link group (Instant ↔ K-Cups), the true row numbers the review list pages through. `display_rating` / `display_count` are the **Shopify product page's** numbers: that product alone (plus its "(Free Gift)" fold, no link-group pooling), exactly what `buildReviewAggregates` publishes to the `reviews.rating` / `reviews.rating_count` metafields, with `workspaces.storefront_off_platform_review_count` (+10,000 for Superfoods, the Yotpo-era reviews whose rows are gone) added to the count server-side ([[../libraries/shopify-review-metafields]] § The +10,000 off-platform bump). The rating is never bumped. Never add a bump inside an extension; it double-counts.

**Display rule (founder, 2026-10-06):** display surfaces (PDP, in-house storefront, checkout blocks) show the exact count, e.g. "11,882 reviews". Only marketing and ad copy rounds it ("11K+").

Amazing Coffee, 2026-10-06: pooled 3,003 / 4.76; page scope 1,882 / 4.74, so `display_count` 11,882. The trust card shows "4.7 · 11,882 reviews", the exact count the PDP displays ("11,000+" appears only in the PDP's meta description, not on the page).

## Shipping claims: measured, never marketing

The Shipping Trust block makes three claims, each from `orders` (last 90 days to 2026-10-06, 5,938 orders). Re-measure before changing a default.

- **Arrival window:** order → `delivered_at` was 6.5 days at the median, 8.4 at p80 and 10.6 at p95 (calendar days). The block shows a window, today + 6 to today + 9, worded as an *estimate*. A hard "arrives by" date at p80 would be missed for one order in five and turn into "where is my order" tickets.
- **Unset settings fall back, never to 0.** A checkout-editor setting nobody filled arrives as `null` or `""`, and `Number(null)` is `0`, which shipped as "Estimated arrival Tue, Oct 6 – Tue, Oct 6" (today–today) in shopcx-122. `toDays` treats null/blank/<1 as unset and uses the measured default. Any numeric setting in a checkout block needs the same guard.
- **Alaska, Hawaii, Puerto Rico get their own window.** Once the shopper's address is in one of them (`shopify.shippingAddress` countryCode `PR`, or `US` + provinceCode `AK`/`HI`/`PR`), the block replaces the dated window with "Estimated arrival in 2–3 weeks" (founder's call, 2026-10-06) and adds "Orders to {region} ship USPS and take a little longer than the mainland.", USPS mark only. Measured on delivered orders, 12 months to 2026-10-06: mainland 7.0 median / 9.2 p80 (n 29,781); PR 9.8 / 15.0 (n 119); HI 14.0 / 19.7 (n 124); AK 15.6 / 25.3 (n 94). Those regions ship almost all USPS Ground Advantage. `shippingAddress` needs **protected customer data** access for the app (Partner Dashboard → API access → Protected customer data, address fields); without it, or before an address is entered, the value is undefined and the mainland default shows.
- **Carriers:** about 72% of fulfillments go out on OSM Priority Select or USPS Ground Advantage (USPS does final delivery), about 20% on DHL eCommerce Ground, and UPS is effectively 0. So the block shows USPS and DHL only. Never show a carrier we don't ship with.
- **Tracked:** all 5,804 shipped orders in the window carry an `amplifier_tracking_number`.
- **Ship speed** (order → `amplifier_shipped_at`: 37.5 h median, 61.5 h p80) is not shown as a claim; "ships in 24 hours" would be false.

The logos are the Simple Icons (CC0) USPS and DHL marks in brand colour, rendered to PNG.

## Fail-closed design

Guarantee and reviews render **nothing** until data arrives and nothing on any error — no skeleton, no hardcoded fallback. A guarantee is a legal promise sourced from [[../tables/policies]] via `getPolicyCustomerFacing`; reviews come from `product_reviews`, the same corpus as the PDP. Neither declares `block_progress`, so neither can stop a checkout.

## Free Cinnamon Roll Creamer discount function

`creamer-gift-discount` is not a UI block: it is a **Shopify discount function** (`type = "function"`, target `cart.lines.discounts.generate.run`, JS compiled to wasm by the CLI). Shopify runs it on every cart and checkout once an automatic app discount points at it, so the $0 shows in the cart drawer, cart page and checkout alike. Promo started 2026-10-08 (founder's call: subscriptions or 2+ boxes).

- **Rule.** The cart qualifies when any Amazing Coffee K-Cups line (product `7467749965997`) has a selling plan, or K-Cups quantities total 2+. Then **one unit** of the gift line is 100% off, message "Free Cinnamon Roll Creamer".
- **Gift line.** The real Amazing Creamer Cinnamon Roll variant (`43512521523373`, SKU `SC-CREAMER-CINNAROLL`, $69.95), one-time, carrying line property `_free_gift=cinnamon-roll-creamer`. Only that tagged one-time line is ever discounted, so a creamer bought on purpose or on subscription stays paid. Being one-time, it never joins the subscription contract and never repeats on renewals.
- **Who adds the line.** The function can only discount, never add. The theme cart script (`assets/cart-drawer-custom.js`, same pattern as the $140 mystery gift) adds and removes the tagged line as the cart starts or stops qualifying. Ship that only after the discount is live, or the creamer shows at full price.
- **Config.** Production ids are defaults in `src/cart_lines_discounts_generate_run.js`; the discount's `$app:function-configuration` JSON metafield overrides `qualifyingProductIds`, `giftVariantId`, `giftTag`, `minQuantity`, `message` with no redeploy.
- **Turning it on.** After `shopify app deploy`, create it with Admin `discountAutomaticAppCreate` (`functionHandle: "creamer-gift-discount"`, `discountClasses: [PRODUCT]`, `combinesWith` product/order/shipping all true so it stacks with Buy 2 and free shipping). End the promo by setting the discount's end date or deleting it.
- **Tests.** `cd shopify-extension/extensions/creamer-gift-discount && npm test` (plain `node --test`, no build); `npx shopify app function run` runs the compiled wasm on a JSON input.

## Deploy

`cd shopify-extension && npm install && npx shopify app deploy`. Network access for checkout extensions must also be approved for the app in the Partner Dashboard, or `fetch` is blocked at runtime. `api_endpoint` (and `workspace` for reviews) are merchant settings in the checkout editor; both default to production values.

## Related

- [[shopify]] — Admin API, app config (`shopify-extension/shopify.app.toml`)
- [[../tables/policies]] — source of the guarantee
- [[../lifecycles/customer-portal]] — the other extension in this app (theme app extension)
