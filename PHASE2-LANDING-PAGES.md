# Phase 2 — Landing Page System · Implementation Spec

## Overview

A single Next.js template renders all products as high-conversion landing pages. All content pulled from the database — zero hardcoded product content. Mobile-first design (80-90% of traffic is mobile). Target: faster than AMP.

This spec is self-contained. A developer should be able to implement it from a worktree without asking questions.

---

## Speed Requirements — Non-Negotiable

These are not aspirational. These are build-blocking. Fail any of these = do not ship.

| Metric | Target | How |
|---|---|---|
| TTFB | < 50ms | SSG served from Vercel Edge CDN |
| LCP | < 1.2s | Zero JS above fold, priority hero image, self-hosted fonts |
| CLS | 0 | Explicit dimensions on everything, reserved section heights |
| FID/INP | < 100ms | Progressive hydration, no main-thread blocking |
| Lighthouse | 95+ | Mobile score, not desktop |
| Total JS | < 50kb | Only interactive leaf components hydrate |

### Speed Rules (enforce in every component)

1. **Page-level component is a React Server Component** — no `"use client"` on the page itself. Ever.
2. **Zero JavaScript above the fold** — hero section is pure HTML + CSS. No hydration, no useEffect, no client state.
3. **Images**: `next/image` with explicit `width`/`height`, WebP/AVIF via Vercel Image Optimization, `priority` on hero image only, `loading="lazy"` on everything else, blur placeholder via `placeholder="blur"`.
4. **Fonts**: `next/font/google` or `next/font/local` — self-hosted, no external requests. Subset to latin. `display: swap` with size-adjust to prevent layout shift.
5. **No third-party scripts in `<head>`** — pixel, analytics, chat all load AFTER paint via `next/script` with `strategy="afterInteractive"` or `"lazyOnload"`.
6. **No CSS-in-JS runtime** — Tailwind only. Compiled at build time.
7. **No client-side data fetching on page load** — all data fetched at build time (SSG) or revalidation time (ISR). The page renders with zero network requests.
8. **No loading spinners, skeletons, or suspense boundaries visible on initial load** — the page is complete HTML from the edge.
9. **Every section has explicit min-height on mobile** to prevent CLS during image/font load.
10. **Lighthouse CI gate**: run `npx lhci` on every deploy. Fail build if mobile score < 95 or LCP > 2.5s.

---

## Mobile-First Design Rules

80-90% of traffic is mobile. Design for a thumb, not a mouse.

1. **Default styles are mobile** — use `sm:`, `md:`, `lg:` for desktop overrides, never the reverse.
2. **Touch targets: minimum 44x44px** — buttons, links, pills. No tiny tap targets.
3. **Full-width sections** — no side margins on mobile. Edge-to-edge content.
4. **Font sizes**: body 16px minimum (prevents iOS zoom), headlines 24-32px on mobile.
5. **CTA buttons: full-width on mobile** — fixed bottom bar or inline, always thumb-reachable.
6. **Images: aspect ratio locked** — use `aspect-[4/3]` or `aspect-square` containers. Never let images dictate layout.
7. **Horizontal scroll: never** — if content overflows, stack vertically or truncate. Exception: benefit pills in floating bar (intentional horizontal scroll with scroll-snap).
8. **Sticky CTA on mobile** — after scrolling past the hero, a slim sticky bar with price + "Order Now" stays at the bottom. Always accessible.
9. **No hover states as primary interaction** — everything works with tap.
10. **Test on real devices** — iPhone SE (375px), iPhone 14 (390px), Android mid-range. Not just Chrome DevTools.

---

## Architecture

### Route Structure

```
src/app/(storefront)/
  layout.tsx                     — minimal layout: no sidebar, no dashboard, viewport meta
  [workspace]/
    [slug]/
      page.tsx                   — THE template. SSG + ISR. Renders all 10 sections.
      opengraph-image.tsx        — OG image generation (product hero + headline)
    [slug]/for-[angle]/
      page.tsx                   — (Phase 2b) benefit-focused variant, re-exports base with angle prop
```

### Middleware (storefront routing)

Extend existing `src/lib/supabase/middleware.ts` to detect storefront requests:

```
shopcx.ai/store/superfoods/amazing-coffee     → (storefront)/superfoods/amazing-coffee
shop.superfoodscompany.com/amazing-coffee      → (storefront)/[resolved-workspace]/amazing-coffee
superfoodscompany.com/amazing-coffee           → (storefront)/[resolved-workspace]/amazing-coffee
```

Domain → workspace resolution: check `workspaces` table for matching `storefront_domain` or `shopify_domain`. Cache the mapping at the edge via Vercel Edge Config or a simple in-memory map refreshed every 60s.

### Data Flow

```
Build time (SSG):
  generateStaticParams() → list all published products across all workspaces
  page.tsx fetches from Supabase at build time → full HTML rendered → cached at edge

Request time:
  Edge CDN serves cached HTML → 50ms TTFB
  Browser renders HTML + CSS → hero visible in < 1s
  JS hydrates interactive components → price toggle, review filter work
  Pixel fires → async, never blocks

Content update:
  Admin edits content in ShopCX dashboard → saves to DB
  Webhook/API call triggers ISR revalidation → Vercel rebuilds that one page
  Next request gets fresh HTML from edge → no full rebuild needed
```

### ISR Revalidation

```typescript
// In page.tsx
export const revalidate = 3600; // revalidate every hour by default

// On-demand revalidation when content is edited:
// POST /api/revalidate?path=/superfoods/amazing-coffee&secret=REVALIDATION_SECRET
```

Add a revalidation trigger to the content PATCH/publish endpoints so changes appear within seconds, not an hour.

---

## Database

### New Tables

```sql
-- Pricing tiers for the price table section
CREATE TABLE public.product_pricing_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL,                    -- Shopify variant ID (for checkout)
  tier_name TEXT NOT NULL,                     -- "1 Bag", "3 Bags", "6 Bags"
  quantity INTEGER NOT NULL DEFAULT 1,
  price_cents INTEGER NOT NULL,               -- one-time price
  subscribe_price_cents INTEGER,              -- subscription price (null = no sub option)
  subscribe_discount_pct INTEGER DEFAULT 25,  -- "Save 25%"
  per_unit_cents INTEGER,                     -- for "just $X.XX/bag" display
  badge TEXT,                                 -- "Most Popular", "Best Value", null
  is_highlighted BOOLEAN DEFAULT false,       -- middle column highlight
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id, variant_id)
);

-- How It Works steps (section 3)
CREATE TABLE public.product_how_it_works (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,               -- 1, 2, 3
  icon_hint TEXT,                             -- icon name or emoji
  headline TEXT NOT NULL,                     -- "The Problem", "The Solution", "The Result"
  body TEXT NOT NULL,                         -- 1-2 sentences
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Benefit angles (for Phase 2b — create now, populate later)
CREATE TABLE public.product_benefit_angles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  benefit_key TEXT NOT NULL,                  -- "energy", "joint-health", "weight"
  hero_headline TEXT,                         -- override headline for this angle
  hero_subheadline TEXT,
  featured_ingredient_ids UUID[] DEFAULT '{}',-- ingredients to float first
  lead_review_keywords TEXT[] DEFAULT '{}',   -- reviews matching these surface first
  comparison_row_order INTEGER[] DEFAULT '{}',-- reorder comparison rows
  faq_priority_ids UUID[] DEFAULT '{}',       -- FAQ items to float first
  is_active BOOLEAN DEFAULT true,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id, benefit_key)
);

-- Add storefront domain to workspaces
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS storefront_domain TEXT,
  ADD COLUMN IF NOT EXISTS storefront_slug TEXT;

-- RLS on all new tables (same pattern as existing)
ALTER TABLE public.product_pricing_tiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read product_pricing_tiers" ON public.product_pricing_tiers
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full on product_pricing_tiers" ON public.product_pricing_tiers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.product_how_it_works ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read product_how_it_works" ON public.product_how_it_works
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full on product_how_it_works" ON public.product_how_it_works
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.product_benefit_angles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read product_benefit_angles" ON public.product_benefit_angles
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full on product_benefit_angles" ON public.product_benefit_angles
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Public read policies for storefront (no auth required)
CREATE POLICY "Public read product_pricing_tiers" ON public.product_pricing_tiers
  FOR SELECT TO anon USING (true);
CREATE POLICY "Public read product_how_it_works" ON public.product_how_it_works
  FOR SELECT TO anon USING (true);
CREATE POLICY "Public read product_benefit_angles" ON public.product_benefit_angles
  FOR SELECT TO anon USING (true);
```

### Public Read Policies for Storefront

The storefront fetches data at build time using the service role. But for ISR revalidation and edge-cached pages, we need anon read access on storefront-related tables:

```sql
-- These tables also need public read for storefront SSG
CREATE POLICY "Public read products" ON public.products
  FOR SELECT TO anon USING (true);
CREATE POLICY "Public read product_page_content" ON public.product_page_content
  FOR SELECT TO anon USING (true);
CREATE POLICY "Public read product_ingredients" ON public.product_ingredients
  FOR SELECT TO anon USING (true);
CREATE POLICY "Public read product_ingredient_research" ON public.product_ingredient_research
  FOR SELECT TO anon USING (true);
CREATE POLICY "Public read product_benefit_selections" ON public.product_benefit_selections
  FOR SELECT TO anon USING (true);
CREATE POLICY "Public read product_review_analysis" ON public.product_review_analysis
  FOR SELECT TO anon USING (true);
CREATE POLICY "Public read product_reviews" ON public.product_reviews
  FOR SELECT TO anon USING (true);
CREATE POLICY "Public read product_media" ON public.product_media
  FOR SELECT TO anon USING (true);
```

---

## The 10-Section Template

File: `src/app/(storefront)/[workspace]/[slug]/page.tsx`

This is a **React Server Component**. No `"use client"`. All data fetched at build/revalidation time.

### Data Fetching

```typescript
// generateStaticParams — pre-render all published products
export async function generateStaticParams() {
  const admin = createAdminClient();
  const { data: workspaces } = await admin.from("workspaces")
    .select("storefront_slug").not("storefront_slug", "is", null);
  
  const params = [];
  for (const ws of workspaces || []) {
    const { data: products } = await admin.from("products")
      .select("handle").eq("workspace_id", ws.id)
      .eq("intelligence_status", "published");
    for (const p of products || []) {
      params.push({ workspace: ws.storefront_slug, slug: p.handle });
    }
  }
  return params;
}

// Page data — one query to get everything
async function getPageData(workspaceSlug: string, productSlug: string) {
  const admin = createAdminClient();
  // Resolve workspace from slug or domain
  // Fetch: product, page_content, ingredients, research, benefit_selections,
  //        pricing_tiers, how_it_works, reviews, media
  // Return as a single typed object
}
```

### Section Components (all Server Components unless noted)

Each section is its own file for readability. None are `"use client"` except where noted.

```
src/app/(storefront)/_sections/
  HeroSection.tsx              — headline, subheadline, benefit bar chips, social proof, CTA
  MechanismSection.tsx         — "Why this works" copy
  HowItWorksSection.tsx        — 3-step visual
  PriceTableSection.tsx        — ⚡ CLIENT COMPONENT — subscribe toggle, quantity selection
  UGCSection.tsx               — customer photos + featured reviews
  ComparisonSection.tsx        — us vs alternative table
  IngredientsSection.tsx       — ingredient cards with research
  ReviewsSection.tsx           — ⚡ CLIENT COMPONENT — filterable reviews, "load more"
  FAQSection.tsx               — ⚡ CLIENT COMPONENT — accordion expand/collapse
  FinalCTASection.tsx          — guarantee + repeat CTA
  StickyMobileCTA.tsx          — ⚡ CLIENT COMPONENT — fixed bottom bar on mobile
```

Only 4 client components. Everything else is static HTML.

### Section Details

**1. Hero Section** (Server Component)

```
Mobile layout (default):
┌─────────────────────────┐
│ [Hero image, full-width,│
│  aspect-[4/3], priority]│
├─────────────────────────┤
│ ★★★★★ 2,847 reviews     │
│                         │
│ The Energy Your Body    │
│ Has Been Missing        │
│                         │
│ Subtitle text here      │
│                         │
│ [Energy] [Focus] [Anti-]│  ← benefit chips (static, not interactive yet)
│                         │
│ ┌─────────────────────┐ │
│ │   Try It Now — $X   │ │  ← full-width CTA, scrolls to price table
│ └─────────────────────┘ │
│                         │
│ [press logo] [logo] [l] │  ← grayscale press logos row
│ 🔒 30-Day Money Back    │
└─────────────────────────┘

Desktop override (md:):
- Hero image on right (50%), text on left (50%)
- Benefit chips inline
- CTA not full-width
```

- Hero image: `next/image` with `priority`, `sizes="100vw"`, explicit width/height
- CTA `<a href="#pricing">` — native anchor scroll, no JS
- Review count from `product_reviews` count query at build time
- Press logos from `product_media` slots `press_1`, `press_2`, etc.

**2. Mechanism Section** (Server Component)

- `mechanism_copy` from `product_page_content`, rendered as HTML
- Full-width background color block on mobile
- Max-width prose container on desktop

**3. How It Works** (Server Component)

- 3 cards from `product_how_it_works` table
- Mobile: vertical stack, numbered circles
- Desktop: horizontal 3-column with connecting arrows
- Icons via inline SVG (no icon library — that's JS)

**4. Price Table** (Client Component — needs toggle interaction)

```
Mobile layout:
┌─────────────────────────┐
│ ○ One-Time  ● Subscribe │  ← toggle, subscribe selected by default
│        Save 25%!        │
├─────────────────────────┤
│ ┌─────────────────────┐ │
│ │ 🏆 MOST POPULAR     │ │  ← badge on highlighted tier
│ │                     │ │
│ │ 3 Bags              │ │
│ │ $XX.XX/bag          │ │
│ │ $XXX.XX total       │ │
│ │ Free Shipping       │ │
│ │                     │ │
│ │ [Add to Cart]       │ │
│ └─────────────────────┘ │
│ (other tiers below)     │
└─────────────────────────┘

Desktop: 3-column side-by-side, middle column slightly elevated
```

- `id="pricing"` for hero CTA anchor
- Toggle is the ONLY interactive element — switches displayed prices
- "Add to Cart" navigates to checkout (Phase 4) or Shopify cart (interim)
- All prices pre-rendered for both states (subscribe + one-time), CSS toggles visibility
  - This means NO client-side price calculation. Both price sets are in the HTML.

**5. UGC / Real People** (Server Component)

- Top 4-6 reviews from `product_reviews` with photos (if available)
- Customer name, rating stars (SVG, not icon font), review excerpt
- Mobile: horizontal scroll carousel with scroll-snap
- Photos from `product_media` ugc slots

**6. Comparison Table** (Server Component)

- `comparison_table_rows` from `product_page_content`
- Mobile: two-column (us vs them), sticky header row
- Checkmarks/X marks as inline SVG
- Green highlights on "us" column

**7. Ingredients Deep Dive** (Server Component)

- Cards from `product_ingredient_research` filtered to lead + supporting benefits
- Each card: ingredient name, benefit headline, mechanism (truncated), confidence badge, citation count
- Mobile: vertical stack, expandable on tap (CSS-only with `<details>/<summary>`)
- No client JS needed — `<details>` is native HTML accordion

**8. More Reviews** (Client Component — needs filter + load more)

- Initial render: 6 reviews server-rendered
- "Load more" button fetches next page client-side
- Filter pills by benefit tag (client interaction)
- Lazy-loaded — not critical for LCP

**9. FAQ** (Client Component — accordion)

- `faq_items` from `product_page_content`
- Could use `<details>/<summary>` for zero-JS accordion
- But client component allows smooth height animation
- Schema.org FAQ structured data in `<script type="application/ld+json">`

**10. Final CTA** (Server Component)

- Guarantee copy + repeat price CTA
- Mobile: full-width button
- "30-Day Money-Back Guarantee" badge
- Trust signals: secure checkout, free shipping threshold

**Sticky Mobile CTA** (Client Component)

- Appears after scrolling past the hero (IntersectionObserver)
- Fixed to bottom of viewport, 60px height
- Shows: product name, price, "Order Now" button
- Dismissible (X button, stores in sessionStorage)
- `z-50` so it's above everything

---

## Layout

File: `src/app/(storefront)/layout.tsx`

```typescript
import { Metadata, Viewport } from "next";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#ffffff",
};

export const metadata: Metadata = {
  robots: { index: true, follow: true },
};

export default function StorefrontLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-zinc-900 antialiased">
        {children}
      </body>
    </html>
  );
}
```

No sidebar, no nav, no dashboard components, no workspace context provider. Completely isolated from ShopCX dashboard code.

---

## SEO

- `generateMetadata` per product page — title, description, OG image
- `opengraph-image.tsx` — dynamically generated OG image with product photo + headline
- Schema.org structured data:
  - `Product` schema with price, availability, reviews aggregate
  - `FAQPage` schema from FAQ items
  - `Organization` schema
- Canonical URL set per page
- `sitemap.ts` — dynamic sitemap from published products

---

## API Routes

### Revalidation Webhook

**`POST /api/revalidate`**

Called when content is updated in the dashboard. Triggers ISR revalidation for the specific page.

```typescript
// Request
{ path: "/superfoods/amazing-coffee", secret: "REVALIDATION_SECRET" }
// Response
{ revalidated: true }
```

Wire into: content PATCH, content publish, pricing tier update, review sync.

### Storefront Data (for client components)

**`GET /api/storefront/[workspace]/[slug]/reviews`**

Public endpoint for "load more" reviews. Paginated.

```typescript
// Query params: offset, limit, benefit_filter
// Response
{ reviews: [...], total: number, has_more: boolean }
```

---

## Admin UI Additions

### Pricing Tiers Editor

Add to the storefront product detail page (`/dashboard/storefront/products/[id]`):

- Table of pricing tiers: tier name, quantity, one-time price, subscribe price, badge, highlighted
- Add/edit/delete tiers
- Preview of how the price table will look

### How It Works Editor

Add to the product intelligence page as a new section, or to the storefront product detail page:

- 3 steps: icon, headline, body
- Drag to reorder

---

## File Structure

### New files:
```
src/app/(storefront)/
  layout.tsx
  [workspace]/
    [slug]/
      page.tsx
      opengraph-image.tsx
  _sections/
    HeroSection.tsx
    MechanismSection.tsx
    HowItWorksSection.tsx
    PriceTableSection.tsx          (client component)
    UGCSection.tsx
    ComparisonSection.tsx
    IngredientsSection.tsx
    ReviewsSection.tsx             (client component)
    FAQSection.tsx                 (client component)
    FinalCTASection.tsx
    StickyMobileCTA.tsx            (client component)
  _components/
    StarRating.tsx                 (server component — SVG stars)
    BenefitChip.tsx                (server component)
    TrustBadge.tsx                 (server component)
    PressLogos.tsx                 (server component)

src/app/api/storefront/[workspace]/[slug]/reviews/route.ts
src/app/api/revalidate/route.ts

supabase/migrations/XXXXXXXX_storefront_tables.sql
```

### Modify:
```
src/lib/supabase/middleware.ts              (add storefront domain routing)
src/app/dashboard/storefront/products/[id]/page.tsx  (add pricing + how-it-works editors)
```

---

## Implementation Sequence

1. **Migration** — pricing tiers, how it works, benefit angles tables + storefront columns + anon read policies
2. **Layout** — `(storefront)/layout.tsx`, clean viewport, no dashboard code
3. **Middleware** — storefront domain routing (workspace resolution from domain)
4. **Data fetching** — `getPageData()` function that loads everything for a product
5. **Template** — `page.tsx` with `generateStaticParams`, ISR, metadata
6. **Sections top-down** — Hero first (this is the LCP section, get it perfect), then Mechanism, How It Works, Price Table, UGC, Comparison, Ingredients, Reviews, FAQ, Final CTA
7. **Sticky Mobile CTA** — after all sections work
8. **SEO** — structured data, sitemap, OG image
9. **Revalidation** — webhook endpoint, wire into dashboard save actions
10. **Lighthouse audit** — run mobile audit, fix until 95+
11. **Admin editors** — pricing tiers + how it works in dashboard

### What NOT to build yet (Phase 2b):
- Adaptive benefit focus (floating bar, content reweighting)
- A/B testing (edge middleware, variant generation)
- Email capture modal
- Pixel integration (Phase 3)

These are designed to slot in without refactoring because:
- Sections use `data-section` attributes for reweighting
- Each section accepts an optional `benefitAngle` prop (ignored for now)
- The static page structure supports edge middleware rewriting
- No client-side state that would conflict with A/B variants

---

## Performance Checklist (run before shipping)

- [ ] Lighthouse mobile score ≥ 95
- [ ] LCP < 1.2s on 4G throttled
- [ ] CLS = 0
- [ ] Zero JS execution before hero paint
- [ ] Hero image loads in first network request (priority + preload)
- [ ] Total page JS < 50kb (check with `next build` output)
- [ ] No third-party requests before LCP
- [ ] Tap targets ≥ 44x44px on mobile
- [ ] Body text ≥ 16px on mobile
- [ ] CTA visible without scrolling on iPhone SE (375px)
- [ ] Price table toggle works without JS (both prices in HTML, CSS toggles)
- [ ] FAQ works without JS (`<details>/<summary>` fallback)
- [ ] Page loads and is fully readable with JS disabled
