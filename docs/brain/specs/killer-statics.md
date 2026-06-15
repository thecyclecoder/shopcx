# Killer statics — cold-50+ archetypes, both formats 🚧

Status: 🚧 code-complete (P1–P4 built + typechecked on branch `killer-statics-iso`) · owner: Dylan · created 2026-06-15

> **Remaining operational steps before this is fully shipped (then fold + delete this spec):**
> 1. Apply the migration `supabase/migrations/20260615120000_ad_campaigns_landing_url.sql` (adds `ad_campaigns.landing_url`). Helper: `scripts/_apply-landing-url.ts <region> <prefix>` (needs the correct Supabase pooler region).
> 2. Re-run `scripts/deploy-remotion-lambda.ts` so the Lambda site has the updated `remotion/StaticArchetypes.tsx` (9:16 testimonial fix) + `remotion/AdStatic.tsx` (SafeImg).
> 3. Verify a render in-app: open an Amazing Coffee campaign → generate each killer archetype → confirm 4:5 + 9:16 land on Lambda (the SafeImg + fresh-signed-URL fix should clear the old static-on-Lambda failure).
> 4. Seed the publish-ready campaigns: `npx tsx scripts/seed-killer-statics.ts` (creates angles + campaigns + landing_url, fires renders, pre-generates Meta copy) → open each + click Publish.
> 5. Dylan design pass on the five archetype components (visual iteration in `remotion/StaticAdvertorial.tsx` + `remotion/StaticArchetypes.tsx`).

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
- ✅ **P1 — Productionize the 5 archetype components** — components built + registered in `remotion/Root.tsx`; 9:16 testimonial sparse-middle fixed (`StaticTestimonial` now header / growing-centered-middle / footer + portrait product anchor); 9:16 safe-zone insets applied per `KILLER_FORMATS` (`safeTopPct`/`safeBottomPct`); `AdStatic.tsx` got the SafeImg fix.
- ✅ **P2 — Copy + hero generators** — new `src/lib/ad-statics-copy.ts` (advertorial / big_claim / before_after via Opus, gated through `validateAdScript` for banned words; testimonial/authority use REAL review/endorsement text) + `src/lib/ad-statics.ts` (`loadKillerAssets`, hero auto-select by angle, ingredient/face hero gen via `gemini` with reuse-if-present, `buildKillerStatic` → fresh signed URLs). Review counts = real + 10,000; badges from PI certs.
- ✅ **P3 — Wire into the render path** — `adToolStaticRequested` (`ad-tool/static-requested`) branches killer vs legacy; killer renders both 4:5 + 9:16 → `ad_videos` (`media_kind='static'`, `meta.archetype`, `format_variant_of_id`); fresh signed URLs + SafeImg components clear the Lambda static failure; campaign-page archetype picker (`KILLER_STATIC_DEFS`) + grouped outputs; static route accepts the killer archetypes.
- ✅ **P4 — Publish path + seed** — `meta-ads.ts` `createAdCreative` supports `imageHash` → `object_story_spec.image_data`; `adToolPublishToMeta` branches on `media_kind` (static → `uploadAdImage` → image creative); publish route dropped the `media_kind='video'` filter; `ad_campaigns.landing_url` migration + PublishToMeta pre-fills from it; `scripts/seed-killer-statics.ts` seeds angles + campaigns + landing_url + fires renders + pre-generates Meta copy. ([[../lifecycles/ad-publish]]) **Operational run pending — see the steps at the top.**

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
