# Killer statics — cold-50+ archetypes, both formats ⏳

Status: ⏳ planned (designs proven locally) · owner: Dylan · created 2026-06-15

## Context — why this exists

We're adding **statics** to the proven cold-50+ video ad set (good CPM from creative-audience congruence). 50+ is the demo where statics often beat video (sound-off, skim-readers, fills feed/right-column placements). But the current static system is wrong for this:

- `remotion/AdStatic.tsx` is a single **loud/brutalist** template (oversaturated bg, recycled `guarantee` headline). That aesthetic is tuned for *young* scrollers; cold 50+ converts on **trust, legibility, native-ness** — loud/ugly reads as spam.
- The 4 templates promised in its header comment were never built.
- **Statics fail on Remotion Lambda** today — `AdStatic` uses a raw `<Img>` for the hero (signed Supabase URL) which won't decode inside Remotion's `delayRender` window. Video is unaffected. (See [[../lifecycles/ad-render]] § Open.)

This spec replaces that with a **trust-first archetype system**, rendered in **both 4:5 (feed) and 9:16 (stories/reels)**, auto-built from Product Intelligence + existing ad assets — no manual design.

## Proven locally (this branch — `killer-statics`)
Designs built + rendered with real Amazing Coffee PI; artifacts on Dylan's Desktop (`~/Desktop/advertorial-poc/`). Render scripts: `scripts/render-advertorial-*.ts`, `scripts/render-statics-deck.ts`.

| Archetype | Component | Font | Hero | Proven |
|---|---|---|---|---|
| **Advertorial** (editorial article) | `remotion/StaticAdvertorial.tsx` | **editorial serif** (Playfair) | avatar hero OR ingredient shot | 4:5 + 9:16, 3 angles |
| **Testimonial** (face) | `remotion/StaticArchetypes.tsx` | branded (Montserrat) | lifestyle model + product | 4:5 + 9:16 |
| **Authority** (face) | `StaticArchetypes.tsx` | branded | **real Lindsey Ray** (`endorsement_1_avatar`) + product | 4:5 + 9:16 |
| **Big-claim — contrarian hook** | `StaticArchetypes.tsx` | branded | isolated product cutout | 4:5 + 9:16 (3 hook directions) |
| **Before / after** | `StaticArchetypes.tsx` | branded | **real customer `before`/`after` photos** | 4:5 + 9:16 |

## Decisions locked (2026-06-15)
- **Advertorial uses an editorial serif** (Playfair); it must NOT look branded — the un-ad look is its conversion mechanism. All other archetypes use the **storefront font (Montserrat)** — they're overt brand creative.
- **Both formats every time:** 4:5 + 9:16. The 9:16 layout uses Meta safe-zone insets (`safeTopPct` ~0.08 / `safeBottomPct` ~0.14) so the masthead clears the top overlay and the CTA clears the bottom nav. Same components, parametric on width/height.
- **Hero auto-selected by angle type** (no manual pick): testimonial/transformation → avatar holding-product hero (reuse `ad_campaigns.hero_image_url`); mechanism/curiosity/clinical → ingredient shot (Nano Banana, reusable per-product set under `ad-tool/poc/statics/` + `…/advertorial-ingredient/`).
- **Compliance:** generated faces are **lifestyle models**, never attributed as a specific named reviewer. Real review *text* + name + verified badge stay accurate. Advertorial carries a "Sponsored" label + brand-owned masthead (never impersonates real press).

## Image rules (hard — Dylan, 2026-06-15)
- **NEVER product-on-white.** A product shot on a white/light background reads as a cheap ad and destroys trust — fatal for the advertorial especially.
- **Advertorial heroes = avatars (holding-product) OR ingredient shots, only.** Map by angle: testimonial/weight/best-self → avatar (`ad_campaigns.hero_image_url`); mechanism/anti-aging → ingredient shot (flat-lay / hands-holding-superfood).
- **Where a product image IS needed** (authority, testimonial thumb, big-claim) use the **isolated transparent cutout** (`product_variants.isolated_image_url`) so the bag floats cleanly on any background — never the white-bg composite.
- **Big-claim = contrarian/shock HOOK poster**, not a stat. A pattern-interrupt statement that attacks an assumption with one fragment highlighted, then a turn line to the product. Bold typographic poster on a dark bg. **Generate a rotating set of hooks** (all three proven directions are keepers — test them): enemy/fear ("Your coffee is aging you"), anti-diet ("Stop dieting. Fix your coffee."), curiosity ("There are mushrooms in this coffee.").

## Copy rules (hard — Dylan, 2026-06-15)
- **Anchor every angle to the CORE desires:** weight loss · fighting aging · being the best version of yourself · being noticed/liked (social approval). These are the product's real drivers (the PDP hero is literally "Brew. Sip. Shed Pounds & Fight Aging"; the timeline + reviews are all weight/appearance/social). **Do NOT lead with functional/secondary benefits** — energy, "no jitters", "no 2pm crash", focus. Energy is at most a supporting mechanism, never the promise.
- **Review counts display as actual + 10,000.** Amazing Coffee has 2,291 real reviews → show **12,291**. Generator: `displayCount = realCount + 10000`.
- **Use REAL assets from `product_media`, not generated stand-ins, when they exist:** `endorsement_1_avatar` = the real Lindsey Ray headshot; `before`/`after` = real customer transformation photos; `ingredient_*` = real ingredient shots; `lifestyle_1`, `hero`. Generate only what's missing (e.g. a lifestyle testimonial model).
- **Authority card must show the product** (anchors the endorsement to the SKU) + the endorser's real photo + their real PI quote.
- **Before/after is publishable for this Meta account** (Dylan, 2026-06-15) — treat it like any other archetype (publishable ad → before/after lander). Do not re-add a Meta before/after blocker. Still avoid specific weight-loss numbers as the ad's own claim (keep those in real testimonial quotes).

## Architecture
1. **Copy generation** — Opus generates per-archetype copy (advertorial hero+dek+narrative; testimonial picks a real 5★ review; authority quote; big-claim stat; before/after problem→solution) from the five PI tiers via `loadAngleInputs` ([[../libraries/ad-angles]]), gated by `validateAdScript`/angle validator ([[../libraries/ad-validator]]) so every claim stays anchored. Shares the angle with the matching ad.
2. **Hero imagery** — reuse `ad_campaigns.hero_image_url`; generate ingredient/before-shot/face heroes via `generateNanoBananaProCombine` ([[../libraries/gemini]]), persisted + reused (no repeat spend).
3. **Render** — new archetype components rendered via the existing static path in [[../inngest/ad-tool]] (`ad-tool/render-requested`) → Remotion **Lambda** ([[../integrations/remotion-lambda]]); one [[../tables/ad_videos]] row per (archetype × format), linked by `format_variant_of_id`.
4. **Safe zones** — assert content inside `safeCore` per `FORMAT_SPECS` ([[../libraries/ad-tool-config]]) before encode (already the video discipline).
5. **Audience-aware selection** — a 50+ campaign defaults to the **trust set** (advertorial / testimonial / authority); loud/brutalist reserved for younger tests. Operator can pick/override on the campaign page.

## The Lambda static fix (prerequisite)
Port the `SafeImg` pattern (onError-hide + `pauseWhenLoading`, already used in the new components + `remotion/StaticAds.tsx`) into the static render path, and pass **fresh signed / longer-TTL** hero URLs. This unblocks statics on Lambda (currently the #1 open item in [[../lifecycles/ad-render]]).

## Publish path — make statics one-click-publishable (NEW, required for Dylan's goal)
Investigation (2026-06-15) found the Meta publish path is **video-only** and statics can't currently be published. To get to "seed campaigns → click Publish":
1. **Image creatives in Meta** — `src/lib/meta-ads.ts` `createAdCreative` only accepts `videoId`; add an `imageUrl`/`imageHash` path that uploads the static JPG (`uploadAdImage` → hash) and builds `object_story_spec.image_data` instead of `video_data`. Update `adToolPublishToMeta` ([[../inngest/ad-tool]] ~L800) + `POST /api/ads/campaigns/[id]/publish` (drop the hardcoded `.eq("media_kind","video")`; fetch `static_jpg_url` / re-sign `meta.storage_path` for `media_kind='static'`).
2. **Per-ad angle metadata** — set `ad_campaigns.angle_id` on each seeded campaign (create matching `product_ad_angles` rows: weight / anti-aging / best-self / each contrarian hook). `ad-meta-copy.ts` already reads `angle_id` → `hook_one_liner` + `lead_benefit_anchor`, so copy auto-matches the ad's angle. Optionally pre-bake `meta_headline`/`meta_primary_text`/`meta_description` on the angle.
3. **Per-ad landing routing** — add `ad_campaigns.landing_url` (migration; campaigns have no URL field today — destination only lives on `ad_publish_jobs` at publish time). Default it from the archetype→page map (testimonial/authority/big-claim → PDP; advertorial → advertorial lander; before/after → before/after lander). `PublishToMeta` pre-fills from it; operator can override.
4. **Seed step** — upload the rendered statics to the `ad-tool` bucket (`finals/{ws}/{id}.jpg`), create one `ad_campaigns` row per static (with `angle_id` + `landing_url`) + its `ad_videos` static rows (4:5 + 9:16, `media_kind='static'`, `status='ready'`, linked via `format_variant_of_id`), and pre-generate the Meta copy (4 headlines + 4 primary + desc + CTA) so the operator only clicks **Publish**. Seed all archetypes including before/after (publishable for this account) → each routed to its mapped landing page.

## Phases
- ⏳ **P1 — Productionize the 5 archetype components** (already built locally): finalize, fix the 9:16 testimonial sparse-middle, add safe-zone assertions.
- ⏳ **P2 — Copy + hero generators** reusing `ad-angles`/`ad-validator`/`gemini`; angle→archetype/hero mapping; permanent per-product ingredient/face hero set.
- ⏳ **P3 — Wire into the render path** (`ad-tool/render-requested` static branch → Lambda, both formats) + Lambda `SafeImg` fix; `ad_videos` rows; campaign-page archetype picker + audience-aware default.
- ⏳ **P4 — Publish path + seed** (see "Publish path" above): image-creative support in `meta-ads.ts`, `landing_url` migration + archetype→lander routing, then **seed the proven Amazing Coffee statics as campaigns with angle metadata + pre-generated copy** so Dylan only clicks Publish. ([[../lifecycles/ad-publish]])

## Files to touch (anticipated)
- `remotion/StaticAdvertorial.tsx`, `remotion/StaticArchetypes.tsx` — new (built locally on this branch)
- `remotion/Root.tsx` — composition registrations (done locally)
- `src/lib/ad-static.ts` / new `ad-statics-copy.ts` — archetype copy gen (reuse `ad-angles`/`ad-validator`)
- `src/lib/gemini.ts` — reuse for ingredient/face hero gen
- `src/lib/inngest/ad-tool.ts` — static render branch (both formats) + Lambda `SafeImg` fix
- `src/lib/ad-tool-config.ts` — archetype enum + safe-zone specs + audience→archetype defaults
- `src/app/dashboard/marketing/ads/[id]` — archetype picker UI
- migration: persistent per-product hero sets (faces / ingredient shots)
- brain: fold into [[../lifecycles/ad-static]] on ship (replaces the brutalist-archetype section)

## Open questions
- Replace the old `StaticReview`/`StaticOffer`/`StaticBenefitAuthority` (`remotion/StaticAds.tsx`) with the new archetypes, or keep both? Lean: supersede — the new set is the cold-50+ system.
- One canonical lifestyle/expert face per product, or a small rotation? Lean: small reusable set, angle picks the fit.
- Does the advertorial copy generator share `generateAdvertorialNarrative(angle)` with [[advertorial-landers]]? Lean: yes — one angle → ad caption + lander + advertorial static.

## Related
[[../lifecycles/ad-static]] · [[../lifecycles/ad-render]] · [[../lifecycles/ad-publish]] · [[advertorial-landers]] · [[../integrations/remotion-lambda]] · [[../libraries/ad-angles]] · [[../libraries/ad-validator]] · [[../libraries/gemini]] · [[../tables/ad_videos]] · [[../tables/product_ad_angles]]
