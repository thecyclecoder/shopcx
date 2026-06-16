# Homepage rebuild — direct-response, Tabs-led

**Goal:** rebuild the Shopify homepage as a direct-response trust-and-routing engine for its two audiences — (1) ad-aware brand searchers (saw a Meta ad → Googled us → need scent-match + trust + a fast path to product), and (2) repeat customers reordering (need a fast shop/reorder lane). Built end-to-end by ShopCX via the theme pipeline ([[shopify-theme-via-shopcx]]), staged on a preview theme, **zero manual uploads or customizer work from Dylan.**

Phase legend: ⏳ planned · 🚧 in progress · ✅ shipped

**Status (2026-06-16): v1 built, on preview branch.** 9 custom DR sections + `templates/index.json` + 4 press-logo assets committed to theme branch `homepage-rebuild` (`c7e2f67f`); live `master` untouched. Awaiting Dylan to connect the branch as a Shopify preview theme + approve, then merge → master to go live. Lib gained `ensureBranch`. Sections (brand green `#006540` / orange CTA `#f16033`): dr-hero, dr-trust (press+badges), dr-bestsellers (6 products, Tabs first), dr-goals, dr-why (+founder), dr-reviews, dr-offer (S&S+guarantee), dr-faq, dr-reorder (reorder+capture).

## Decisions (settled with Dylan 2026-06-16)

- **Hero leads with Superfood Tabs** — best seller + best organic seller.
- **Merchandise the full catalog**, including non-advertised movers **Ashwavana Zen Relax** and **Creatine Prime+** (bestsellers grid + goal router).
- **Images: auto-sourced, no uploads.** Product shots from each product's Shopify `featuredImage` (CDN); hero/lifestyle from the Files library (`superfood-tabs-lifestyle.*`, `Superfood_Tabs-Family`, banners); logos from Files; theme `assets/` as backup; Nano Banana Pro generation only to fill a genuine gap.
- **Stage on an unpublished preview theme** (duplicate of MAIN), hand Dylan a preview URL, publish on approval (commit final files to GitHub `master` so MAIN stays GitHub-managed).
- **Copy:** reuse language already live on PDPs/ads (pre-approved claims) — no invented health/compliance claims.
- **Trust specifics (settled):** **30-day money-back guarantee** · **third-party tested** · **"As seen on" press bar** = ABC, CBS, NBC, FOX (brand-green logos). The 4 logos came from Dylan's desktop (FOX = `Untitled_design…`, NBC/CBS/ABC = the `gempages_…` files); not findable in the Files library and the token lacks `write_files`, so they're added as **theme assets** (`assets/dr-press-{abc,cbs,nbc,fox}.avif`) via `themeFilesUpsert` (`write_themes`) and referenced with `asset_url`.

## Chapters (top → bottom)

1. **Sticky utility/announcement bar** — offer (S&S 25% + free shipping) · money-back guarantee · nav (Shop · Bestsellers · Reviews · **Account/Reorder**). Repeat-customer fast lane lives here.
2. **Hero — Superfood Tabs.** Benefit headline (not "welcome"), Tabs lifestyle/product image, primary CTA "Shop Superfood Tabs" + secondary "Shop all", inline ★ + customer count.
3. **Trust bar** — press/as-seen-in, badges (made in USA / third-party tested / money-back), aggregate ★ + review count. Kills brand-searcher skepticism in screen one-and-a-half.
4. **Bestsellers grid** — Tabs first, then Coffee, Ashwavana Zen Relax, Creatine Prime+, Creamer, ACV. Each card: featuredImage, ★, price, S&S badge, Shop CTA. The core routing section.
5. **"What's your goal?" router** — Energy/Focus → Coffee/Guru Focus · Rest & recovery / stress → **Zen Relax** · Strength/performance → **Creatine Prime+** · Gut health → ACV. Routes undecided searchers + pushes non-advertised SKUs.
6. **Why us / the big idea** — functional superfoods, clean, no crash. One idea + visual.
7. **Social proof** — aggregate rating + specific testimonials + UGC wall (reuse Files/PDP UGC).
8. **Founder / mission** — brief, authenticity for the skeptic.
9. **Offer + Subscribe & Save value stack** — 25% off, free shipping, flexible, cancel anytime.
10. **Guarantee** — 30-day money-back, loud (risk reversal).
11. **FAQ** — subscription, shipping, taste, ingredients, returns (also brand-query SEO).
12. **Repeat-customer lane + email/SMS capture** — "Sign in to reorder" + first-order discount capture for new visitors.
13. **Footer** — full nav, policies, loyalty link, guarantee, social.

## Build approach

- **Compose, don't reinvent:** new `templates/index.json` ordering a small set of **purpose-built DR sections** (hero, trust bar, goal router, guarantee, founder, value stack) + reuse existing theme sections where they're already good (featured-collection for the grid, reviews, FAQ).
- **Bake curated content as section defaults** (image URLs + copy in the schema defaults / index settings) so it renders correct with zero customizer work.
- **Preview-theme staging** (lib additions): duplicate MAIN → unpublished theme, write files via Shopify `themeFilesUpsert` (`write_themes`), return preview URL. On approval, commit final files to GitHub `master` (MAIN auto-deploys).

## Files (planned)

| File | Change |
|---|---|
| `src/lib/shopify-theme.ts` | + `duplicateTheme`, `upsertThemeFiles`, `previewUrl` (Shopify themeFiles write for preview staging) |
| `scripts/build-homepage.ts` | author sections + index.json, stage to preview theme |
| theme: `sections/dr-*.liquid` + `templates/index.json` | the homepage |
| `docs/brain/recipes/edit-shopify-theme.md` | note the preview-staging flow |

## Open questions

- Hard claims/press logos to feature (default: reuse live PDP language).
- Goal router vs. bestsellers as the dominant above-the-fold CTA (default: bestsellers-first, router as ch.5).

## Related

[[shopify-theme-via-shopcx]] · [[../recipes/edit-shopify-theme]] · [[../integrations/shopify]] · [[../lifecycles/storefront-checkout]]
