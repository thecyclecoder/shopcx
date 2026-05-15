# Landing Pages Spec

Custom landing pages on our own infrastructure for promo campaigns, value-track content, cross-sell flows, and VIP destinations. Bridges to Shopify's Storefront API for cart + checkout while we're still on Shopify; cart bridge swaps to our own checkout (per `STOREFRONT.md`) when we cut over. UI is permanent; bridge is the only throwaway.

The landing pages become the destination for **shortcodes from the perpetual campaigns engine** (`PERPETUAL-CAMPAIGNS-SPEC.md`) — currently those shortcodes redirect to Shopify product pages, which are fine for single-product clicks but limiting for promo campaigns that need custom layout, multi-product selection, prominent coupon display, etc.

## Why now

The "we'll throw this away post-Shopify" framing is wrong. What we build:

- **Reusable (90% of effort):** page builder UI, section templates, product cards with quantity breaks + subscribe toggle, our pixel integration, the page authoring data in `landing_pages`
- **Throwaway (10% of effort):** Shopify Storefront API client (~200-500 lines wrapping cart mutations) + cart-bridge route handler

The reusable portion is the actual asset. The bridge is a small cost for getting the asset in production months earlier than waiting for our own checkout.

## What this enables

| Use case | Today | With landing pages |
|---|---|---|
| Promo SMS lands somewhere | Shopify collection page (rigid) | Custom promo page with headline + product picker + coupon callout |
| Value-track SMS lands somewhere | Help center article (text only) | Rich content with embedded testimonials, social proof, CTAs |
| Cross-sell post-purchase | Email link to Shopify product page | "After Coffee" landing page with creamer flavors + bundle pricing |
| VIP-only access | Manually unlisted collection | Tier-gated landing page (requires `sx_customer` cookie + VIP flag) |
| A/B test promo copy | Theme branching (slow) | Page variants by visitor cohort |

## Architecture

```
Customer clicks SMS shortlink
       │
       ▼
superfd.co/ASDF/7K2m9 (our shortcode redirect)
       │
       ▼
302 → /promo/spring-sale (our landing page, our infra)
       │
       ▼
Landing page renders:
   • hero image / headline
   • coupon callout
   • product cards w/ on-page add-to-cart (qty break + subscribe toggle)
   • FAQ / terms
       │
       ▼
Customer clicks "Add to Cart" on a product card
       │
       ▼
Cart bridge:
   • Today: Shopify Storefront API cartLinesAdd
   • Post-Shopify: our /api/cart from STOREFRONT.md
       │
       ▼
Customer clicks "Checkout"
       │
       ▼
Today: redirect to Shopify cart.checkoutUrl (Shopify hosted)
Post-Shopify: redirect to our /checkout (Braintree)
```

## Data model

### `landing_pages` table

```sql
CREATE TABLE landing_pages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL,                    -- URL slug, e.g. "spring-sale"
  path_prefix     TEXT NOT NULL DEFAULT 'promo',    -- "promo" | "learn" | "vip"
  title           TEXT NOT NULL,
  meta_description TEXT,
  og_image_url    TEXT,
  sections        JSONB NOT NULL DEFAULT '[]',      -- ordered array of section configs
  status          TEXT NOT NULL DEFAULT 'draft',    -- draft | published | archived
  published_at    TIMESTAMPTZ,
  -- Optional gating: only render to identified customers in a tier
  tier_gate       TEXT,                              -- null | "vip" | "active_sub"
  -- A/B test grouping (later)
  variant_group_id UUID,                             -- pages sharing this id are variants
  variant_weight  INTEGER NOT NULL DEFAULT 100,      -- traffic split when variants exist
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, path_prefix, slug)
);
```

URL pattern: `{shopify_domain or shopcx_subdomain}/{path_prefix}/{slug}` — e.g. `superfoodscompany.com/promo/spring-sale`, `superfoodscompany.com/learn/why-cordyceps`.

### `sections` JSONB shape

Each section is a `{ type, config }` pair, rendered in order. Section types map 1:1 to React components.

**V1 section types:**

| Type | Config | Rendered as |
|---|---|---|
| `hero_image` | `{ image_url, alt, headline, subheadline, cta_label, cta_action }` | Full-width hero with overlay text |
| `headline` | `{ text, level: "h1"|"h2"|"h3", align }` | Standalone heading |
| `body_copy` | `{ html }` | Sanitized rich-text block |
| `coupon_callout` | `{ code, discount_label, terms }` | Big monospace code + copy-to-clipboard |
| `product_card` | `{ product_id, default_variant_id, quantity_breaks: [{qty, discount_pct}], subscribe_default, selling_plan_ids }` | Image + name + qty picker + subscribe toggle + add to cart |
| `product_grid` | `{ product_ids[], layout: "2col"|"3col" }` | Multiple product cards in a grid |
| `quantity_break_offer` | `{ product_id, breaks: [{qty, price_cents, badge}] }` | Tiered pricing display ("Buy 3 = $20 each") |
| `subscribe_toggle` | `{ default_state, copy: { sub_label, otp_label, savings_label } }` | Standalone subscribe/one-time toggle that applies to all products on the page |
| `testimonial` | `{ image_url, quote, attribution, rating }` | Social proof card |
| `testimonial_grid` | `{ testimonials[] }` | Multiple testimonials |
| `faq` | `{ items: [{question, answer}] }` | Accordion |
| `terms` | `{ html }` | Smaller-text legal section |
| `countdown` | `{ ends_at, label_running, label_expired }` | Promo expiry countdown |
| `image` | `{ url, alt, width, link_href }` | Inline image |
| `divider` | `{ style }` | Visual break |

Section configs reference our `products` and `product_variants` tables by internal UUID. Storefront API fetches live pricing/inventory at render time (or via a server-side cache).

## Cart bridge

### Shopify Storefront API path (current state)

```typescript
// src/lib/shopify-cart.ts

const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;
const SHOPIFY_DOMAIN = workspace.shopify_myshopify_domain;

export async function createCart(): Promise<{ cartId: string; checkoutUrl: string }> {
  const res = await fetch(`https://${SHOPIFY_DOMAIN}/api/2024-10/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `mutation { cartCreate { cart { id checkoutUrl } } }`,
    }),
  });
  const { data } = await res.json();
  return { cartId: data.cartCreate.cart.id, checkoutUrl: data.cartCreate.cart.checkoutUrl };
}

export async function addLine(cartId: string, variantId: string, quantity: number, sellingPlanId?: string) {
  // cartLinesAdd mutation — supports subscription via sellingPlanId
}

export async function applyDiscount(cartId: string, code: string) {
  // cartDiscountCodesUpdate
}
```

### Post-Shopify path

The same function signatures call `/api/cart` from `STOREFRONT.md` instead. Page components import from `@/lib/cart` which conditionally dispatches based on `workspace.checkout_provider` (`shopify` | `native`). The page UI doesn't change at cutover — only the dispatch target.

### Cart state

- **Today:** Shopify owns the cart. We store the `cartId` in a `sx_cart` cookie (matching their `cart` cookie pattern).
- **Post-Shopify:** Our `cart_drafts` table owns the cart per STOREFRONT.md, same cookie name.

## URL routing

Two URL forms supported:

1. **Subdomain on shopcx.ai:** `superfoods.shopcx.ai/promo/spring-sale` — uses existing subdomain routing middleware
2. **Custom domain proxy:** `superfoodscompany.com/promo/spring-sale` — requires reverse-proxy config (Vercel rewrite + Shopify CNAME exclude)

The second is the better UX (single brand URL) but needs DNS work per workspace. V1 ships option 1; option 2 is a settings page in Phase 2.

Next.js route: `src/app/(landing)/[prefix]/[slug]/page.tsx` — server-rendered, with cached product/pricing fetches from Storefront API.

## Authoring UI

`/dashboard/marketing/landing-pages` — admin section.

- **List view:** all pages with status, last edited, views, conversion rate
- **Editor:** left rail = section types you can add, center = visual stack of current sections (drag to reorder, click to edit config), right rail = page meta + preview button
- **Preview:** opens the page in a new tab with `?preview=true` (renders draft state)
- **Publish:** flips `status='published'`, sets `published_at`
- **Templates:** "duplicate from existing" — clone a high-performing promo as a starting point for the next one

## Pixel + attribution

The landing pages run our pixel (per `STOREFRONT.md`). Every section interaction can fire targeted events:

| Event | Trigger |
|---|---|
| `pdp_view` | Page mount (existing event, repurposed for landing pages) |
| `pdp_engaged` | Scroll past 50% or 30s dwell |
| `add_to_cart_click` | Product card add-to-cart click |
| `coupon_copied` | Copy-to-clipboard on coupon callout |
| `checkout_click` | Customer hits the checkout CTA |

Combined with the shortcode-resolved `customer_id` (per Component 1 of perpetual campaigns spec), every page interaction is attributable to the specific customer who clicked the specific SMS that sent them.

## Migration to native checkout

When `/api/cart` + Braintree checkout land:

1. Add `workspace.checkout_provider` column with values `shopify` | `native`
2. Cart bridge dispatch: `import { addLine } from "@/lib/cart"` which routes based on provider
3. Per-workspace migration: flip the flag, test, monitor
4. Once stable, delete `src/lib/shopify-cart.ts`

The landing-page UI, section components, page authoring data, and admin UI are all unchanged.

## Phased build

| Phase | Scope | Time |
|---|---|---|
| **V1 — core builder** | `landing_pages` table, 5-6 must-have section types (hero, product_card, coupon_callout, body_copy, faq, terms), Shopify cart bridge, basic admin editor | ~1.5 weeks |
| **V2 — full section library** | All V1 section types listed above, page preview, template duplication, custom-domain proxy | ~1 week |
| **V3 — A/B testing** | Variant groups, traffic split, conversion attribution per variant | ~1 week |
| **V4 — personalization** | Benefit-token substitution in copy (per perpetual campaigns spec), tier-gated pages, per-visitor section visibility | ~1 week |
| **V5 — native cart cutover** | Swap Shopify Storefront API to `/api/cart` from STOREFRONT.md | ~3 days (mostly testing) |

## Where this fits in the broader roadmap

Per `PERPETUAL-CAMPAIGNS-SPEC.md` § "Phased build":

1. Phase 0 (in flight) — Received SMS backfill + case-control analysis
2. Phase 1 — V1 segment toggle in existing campaign builder
3. Phase 2 — Single-series MVP of perpetual engine
4. **Landing pages V1-V2 — slot in HERE before Phase 3, because cross-sell really needs custom pages**
5. Phase 3 — Multi-series + priority + sunset
6. Phase 4 — Cross-sell layer (uses the landing pages)

## Key files (Phase V1 estimate)

| File | Purpose |
|---|---|
| `supabase/migrations/XXX_landing_pages.sql` | Table + indexes |
| `src/lib/shopify-cart.ts` | Storefront API client (throwaway post-Shopify) |
| `src/lib/cart.ts` | Provider-dispatching cart bridge (`shopify` vs `native`) |
| `src/lib/landing-page-renderer.ts` | Server-side section renderer |
| `src/app/(landing)/[prefix]/[slug]/page.tsx` | Public landing page route |
| `src/app/dashboard/marketing/landing-pages/page.tsx` | Admin list view |
| `src/app/dashboard/marketing/landing-pages/[id]/page.tsx` | Admin editor |
| `src/components/landing/sections/*.tsx` | Individual section components (one per type) |
| `src/components/landing/admin/SectionEditor.tsx` | Inline section config editor |

## Trade-offs we accept

- **Shopify Storefront API rate limits.** ~2 req/s per IP on free tier, more on plus. With server-side caching (5-min TTL on product/price queries) + CDN on the rendered page, fine.
- **Cart state lives on Shopify, not our DB.** Until cutover, we can't query "show me all abandoned carts in our admin." That's fine — Shopify abandoned-cart reports still work.
- **Pricing drift risk.** Our `products` table has prices; Shopify Storefront API has the true price at any moment. We resolve at render time via Storefront API, not from our DB. Slight render latency (~100-200ms) but eliminates drift bugs.
- **No subscription contract creation in our DB until checkout.** Customer adds a "subscribe and save" product → we just pass `sellingPlanId` to Shopify's cart. Subscription contract is created post-checkout by Appstle. Same as today.

## Open questions

- Does the shortcode redirect to the landing page directly (302 chain: `superfd.co/ASDF/7K2m9` → `/promo/spring-sale`), or does the shortcode redirect handler render the landing page itself? Direct redirect is cleaner; the customer code cookie gets set on the redirect step.
- For value-track pages on `/learn/[slug]`, do we use the same landing-page builder, or extend the existing help-center infrastructure? Currently spec says help-center first (per perpetual campaigns spec § 6b); could consolidate everything into `landing_pages` if that's simpler.
- For VIP-gated pages: if a non-VIP hits a `tier_gate='vip'` page, what do they see? Options: 404 / signup CTA / "this page is for VIPs, you'll get access at $X LTV." Probably the third — turns a dead-end into a motivation.
