# Ad creative rules (statics + advertorials)

Durable brand-creative conventions for the ad tool. These outlive any single spec — the [[specs/killer-statics]] spec + the shipped [[lifecycles/advertorial-landers]] flow reference this page, and fold INTO it (not over it) when they ship. Audience context: Superfoods' paid social skews **cold 50+** (good CPM from creative-audience congruence).

## Angle anchoring (what buyers actually want)
Anchor every angle to the product's **core desires**, never to functional/secondary benefits:

- ✅ **Weight loss · fighting aging · being the best version of yourself · being noticed/liked (social approval).** (PDP hero is literally "Brew. Sip. Shed Pounds & Fight Aging"; the timeline + reviews are weight/appearance/social.)
- ❌ **Never lead with** energy, "clean energy", "no jitters", "no 2pm crash", focus. Energy is at most a supporting mechanism — never the promise. (Dylan, 2026-06-15: "nobody cares about 2pm slump.")

## Copy rules
- **Review counts display as actual + 10,000.** `displayCount = realReviewCount + 10000` (2,291 → **12,291**). Applies everywhere a count is shown — statics, advertorials, landers, Meta copy.
- **AI Meta copy must match the specific ad's angle** — generate from the campaign's `angle_id` (`product_ad_angles`: `hook_one_liner`, `lead_benefit_anchor`, `desired_outcome`), not generic product copy.
- Plain, legible, one idea per asset, one CTA. Big type for 50+.

## Image rules
- **NEVER product-on-white.** A product shot on a white/light background reads as a cheap ad and destroys trust.
- **Advertorial heroes = avatars (holding-product) OR ingredient shots, only.** Map by angle: testimonial/weight/best-self → avatar (`ad_campaigns.hero_image_url`); mechanism/anti-aging → ingredient shot (flat-lay / hands-holding-superfood).
- **Where a product image IS needed** (authority, testimonial thumb, big-claim) use the **isolated transparent cutout** (`product_variants.isolated_image_url`) so the bag floats cleanly on any background.
- **Reuse real `product_media` assets** when present: `endorsement_N_avatar` (real endorser photos), `before`/`after` (real customer transformation), `ingredient_*`, `lifestyle_*`, `hero`. Generate only what's missing.

## Archetypes (cold-50+ trust-first set)
| Archetype | Font | Hero | Default landing |
|---|---|---|---|
| **Advertorial** (editorial article) | **editorial serif** (Playfair) — must NOT look branded | avatar OR ingredient | **advertorial lander** |
| **Testimonial** (real review + face) | branded (Montserrat) | lifestyle face + isolated product | PDP |
| **Authority** (real endorser + product) | branded | real endorser photo + isolated product | PDP |
| **Big-claim — contrarian hook** | branded | isolated product cutout | PDP |
| **Before / After** | branded | real `before`/`after` photos | **before/after lander** |

- **Advertorial is the only un-branded archetype** — editorial serif + "Sponsored" label + brand-owned masthead (never impersonate real press). All others use the storefront font (Montserrat) — they're overt brand creative.
- **Big-claim = contrarian/shock HOOK poster**, never a bland stat. Pattern-interrupt statement attacking an assumption, one fragment highlighted, then a turn line. Generate a **rotating set** of hooks (e.g. "Your coffee is aging you" · "Stop dieting. Fix your coffee." · "There are mushrooms in this coffee.").

## Formats
- Every asset renders **4:5 (feed) AND 9:16 (stories/reels)** from the same parametric component.
- 9:16 uses Meta safe-zone insets (`safeTopPct` ~0.08 / `safeBottomPct` ~0.14) so the masthead clears the top overlay and the CTA clears the bottom nav. Assert content inside `safeCore` (`FORMAT_SPECS`) pre-encode.

## Lander rendering rules
- **Internally-created landers live on the in-house storefront domain** (`storefront_domain`, e.g. `shop.superfoodscompany.com/{handle}?variant=…`), NEVER the Shopify store (`superfoodscompany.com/products/…` has no lander code).
- **No storefront chrome on advertorial/before-after landers.** The fixed brand nav header is suppressed (`render-page.tsx` gates `StorefrontHeader` on `!advertorial`) — a brand nav bar breaks the native-editorial illusion. The AdvertorialHero masthead stands in for it.
- **Advertorial avatar hero = an avatar-holding-product shot**, never a UGC lifestyle model. A real slim model under "lost 30 lbs" copy reads false; a 50s avatar holding the product is believable. The generator borrows a product ad campaign's `hero_image_url` when the campaign has none.

## Landing routing (ad → page scent-match)
- **Testimonial · Authority · Big-claim → existing PDP.**
- **Advertorial → advertorial lander** ([[lifecycles/advertorial-landers]]).
- **Before/After → before/after lander** (before/after hero + weight-loss testimonials + rest of PDP — [[lifecycles/advertorial-landers]]).

## Meta policy
- **Before/after IS publishable for this ad account** (Dylan, 2026-06-15 — his account is cleared for it). Treat Before/After like any other archetype: publishable Meta ad → routes to the before/after lander. (Meta's general before/after restriction does not apply here; don't re-add it as a blocker.)
- **No specific weight-loss numbers as ad claims/headlines** ("32 lbs in 9 weeks") — keep those inside real testimonial quotes, not as the ad's own claim.

## Related
[[lifecycles/ad-static]] · [[lifecycles/ad-render]] · [[lifecycles/ad-publish]] · [[specs/killer-statics]] · [[lifecycles/advertorial-landers]] · [[customer-voice]] · [[tables/product_ad_angles]]
