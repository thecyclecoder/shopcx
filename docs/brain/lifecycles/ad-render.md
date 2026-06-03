# Ad render lifecycle

The in-app ad studio. An admin opens `/dashboard/marketing/ads/new`, picks an avatar + product + angle + length, and the system turns the Product Intelligence Engine's structured data into a direct-response paid-social ad — avatar holding the product, talking to camera with lip-sync, intercut with b-roll, Hormozi word-level captions, an always-on credibility row — rendered in **four formats** (Reels MP4, Feed-4:5 MP4, Stories JPG, Feed-4:5 JPG) ready to drop into Meta Ads Manager / TikTok.

Business outcome: ~$3.50 marginal cost per ad after the one-time character (vs. ~$200 for a freelancer), turnaround in minutes not days. This is the creative-iteration engine that feeds the ROAS dashboard at `/dashboard/analytics/roas`.

The whole pipeline runs on one vendor for generation ([[../integrations/higgsfield]] — Soul images, DoP b-roll, Speak talking-head, TTS audio), [[../integrations/openai]] Whisper for word timestamps, and Remotion for the final composition.

## The data-source contract (hard rule)

Every claim in every ad must trace back to a structured row in the Product Intelligence Engine. The angle generator and validator read **only** these tiers — never any free-form markdown. (A legacy `product_intelligence.content` markdown blob was removed 2026-06-03; the ad tool design always assumed it absent.)

| Tier | Source | Role |
|---|---|---|
| 1 | [[../tables/product_page_content]] latest published: `hero_headline`, `hero_subheadline`, `benefit_bar[]`, `guarantee_copy`, `expectation_timeline[]` | THE leading promise. Every angle anchors here. |
| 2 | [[../tables/product_benefit_selections]] WHERE `role='lead' AND science_confirmed=true` | Lead benefits + `customer_phrases[]` + `ingredient_research_ids[]` |
| 3 | [[../tables/product_ingredient_research]] WHERE `ai_confidence >= 0.6` | Mechanism + clinical citations (science substrate) |
| 4 | [[../tables/product_reviews]] WHERE `rating >= 4` | **Quotable proof only** — cited, never the central promise |
| 5 | `products.certifications[]` / `allergen_free[]` / `awards[]` / `target_customer`, aggregate review stats, clinical-study count, `workspaces.social_brand_proof_points`, `product_page_content.guarantee_copy` | Always-on credibility row |

`loadAngleInputs(productId)` in [[../libraries/ad-angles]] hydrates all five tiers in one parallelized pass into the typed `AngleGeneratorInput`. Reviews can CITE a benefit established in tiers 1-2; they can never BE the angle.

## Direct-response philosophy — the spine

**Nobody scrolls their feed looking for your product. They scroll looking for something that will fix their life.** Every output obeys that. The system is *opinionated* and refuses to generate "safe" / "polished" / pastel-wellness ads — those die under the ~20% hook-rate floor. Encoded frameworks (all in [[../libraries/ad-tool-config]]):

- **Life Force 8** (Cashvertising) — 8 biological desires; each angle targets 1-2 LF8 slots, never the product's features. `lf8_allowed` is workspace-configurable (slot #4 sexual companionship off by default).
- **12 hook formulas** — `problem_now`, `contrarian`, `results_first`, `callout`, `enemy`, `secret_reveal`, `urgent_question`, `social_proof_shock`, `visual_shock`, `story_in_progress`, `keeping_up`, `loved_one_at_risk`. The script writer picks one per ad, never a warm intro.
- **Pattern interrupt in 2 seconds** — hook lands in frame 1. No "Hey/Hi/Welcome/Introducing", no brand-name opener, no logo reveal. (Frameworks defined in [[../libraries/ad-tool-config]].)
- **Problem → Agitation → Solution** — open on the customer's pain *now*, agitate, then position the product as the escape. Benefits first; ingredients only as later supporting evidence.
- **Anti-wellness-pastel visuals** — oversaturated colors, brutalist sans (Anton/Druk/Inter Black), asymmetric crops, paper/scanned/halftone texture, hand-drawn arrows, "shocked / mid-sentence" faces. `vibe_tags`: `ugly` / `loud` / `weird` / `phone_recorded` / `clinical`.

## End-to-end trace

```
/dashboard/marketing/ads/new
  │
  ├─0 (prereq) variant.isolated_image_url + product/variant.physical_dimensions   [Phase 0, /dashboard/storefront/products/[id]]
  │
  ├─1 pick PRODUCT + variant   (FIRST — the avatar is built from this product's buyers; variant must have an isolated image or the hero hard-blocks)
  │
  ├─2 pick/confirm AVATAR   (gated on product; pick from library OR generate from THIS product's buyers)
  │     getProductArchetypes(productId) pre-fills gender/age from the product's dominant buyer archetype
  │     → set gender/age/health/ethnicity → generate 3 faces (Soul text2image, ~3cr each, ASYNC via
  │       Inngest ad-tool/face-requested — rows start status=generating, UI polls until available)
  │     → saved face library (ad_avatar_candidates) → pick one → avatar stores the face image
  │     [photo upload + Opus archetype proposals are optional alternatives]
  │
  ├─0.5 pick ANGLE   (product_ad_angles, anchored to a tier-1/2 verbatim benefit)
  │
  ├─  pick LENGTH    (15s / 30s)
  │
  ├─3 SCRIPT   generateScript + DR validator (≤3 retries on fatal violations)
  │
  ├─3 HERO     Seedream COMBINE(avatar face + product isolated_image → "holding product"), 9:16, quality=high   ~4cr
  │              (both images uploaded to Higgsfield first; Nano Banana would do this too but isn't API-enabled)
  │
  ├─3 AUDIO    Higgsfield TTS                                                                          ~1cr
  │
  ├─4 TALKING-HEAD   Speak(hero + audio)   1 clip @15s · 2 clips @30s (15s max/gen)                   ~$0.10/s
  │
  ├─4 B-ROLL   N parallel DoP clips from product_media (jarring motions)   9cr / $0.56 each
  │
  ├─5 TRANSCRIBE   Whisper word-level timestamps
  │
  ├─5 RENDER   Remotion × 4 formats → 4 ad_videos rows linked by format_variant_of_id
  │     Reels MP4 (9:16) · Feed-4:5 MP4 · Stories JPG (9:16) · Feed-4:5 JPG
  │
  └─  Supabase private bucket (ad-tool) → library at /dashboard/marketing/ads
```

### Phase 0 — product asset prep (prereq)

The hero is only as good as the product reference. Two operator-confirmed inputs, surfaced on `/dashboard/storefront/products/[id]` (see [[../dashboard/products]]):

- **`product_variants.isolated_image_url`** — the variant photographed alone, transparent/white bg, no shadow. Passed as `reference_image_urls[]` to Soul so it renders the actual SKU, not a hallucinated mockup. **Without it, the builder hard-blocks Generate Hero.**
- **`physical_dimensions` jsonb** on [[../tables/products]] (and optionally per-variant on [[../tables/product_variants]] — variant wins) — `{ length_in, width_in, height_in, weight_oz?, shape }`. Baked into the Soul prompt so the model scales a coffee bag correctly instead of shrinking it to drink-can size.

### Phase 0.5 — angle generation

[[../libraries/ad-angles]] `generateAngles(productId, count=12)`:
1. `loadAngleInputs` hydrates the five-tier contract.
2. Claude Opus (`OPUS_MODEL`) generates a spread — for each relevant LF8 slot, 3-4 angles across different hook formulas.
3. Each candidate runs through `validateAngle` ([[../libraries/ad-validator]]): `lead_benefit_anchor` must be **verbatim** from `benefit_bar[].text` or `lead_benefits[].name`; meta copy respects caps (headline ≤40, primary ≤125, description ≤30); banned soft words rejected.
4. Survivors insert into [[../tables/product_ad_angles]]. Re-runs **archive** prior active rows (`is_active=false`) and append fresh ones.

### Phase 2 — avatar (demographic-driven)

The avatar is a deliberate match for the *actual buyer*, read from the demographic-enrichment pipeline. [[../libraries/ad-avatar-proposals]] `generateAvatarProposals(productId)` is a **read-only** consumer of [[demographic-enrichment]] — it uses only four fields: `inferred_gender`, `inferred_age_range`, `inferred_life_stage`, `zip_income_bracket`. Explicitly NOT `health_priorities`, `buyer_type`, or geo fields (the angle owns the script; the avatar just owns the face).

Flow: resolve the product's buyer cohort (link-group deduped) → top **5** archetypes by share → Opus brief per archetype → insert [[../tables/ad_avatar_proposals]] rows (`status='proposed'`, **no Higgsfield spend**). Cohort < 30 falls back to the workspace-wide [[../tables/demographics_snapshots]]; the JOINT archetype tuples are write-through cached on `demographics_snapshots.archetype_tuples` (recompute only when absent / stale >7 days / forced).

**No photo upload required.** Operator picks a proposal → sets the four controls **gender, age, health level, ethnicity** (gender + age pre-filled from the archetype tuple) → **"Generate 3 faces"** via `generateSoulPortrait` (Soul text-to-image, ~3cr each). Every generated face is persisted to the reusable [[../tables/ad_avatar_candidates]] library (private `ad-tool` bucket, re-signed on read, deletable) so the operator never re-spends Soul credits on the same look. They pick one face + name it → `createCharacter` mints a Higgsfield character (40cr / $2.50) → [[../tables/ad_avatars]] row, lineage via `proposed_from_id`, chosen candidate tagged `used`. Uploading 1-5 reference photos remains an **optional fallback**. Cap: **10 avatars/workspace**.

### Phase 3 — script + hero + audio

- **Script** — [[../libraries/ad-script]] `generateScript(args, maxAttempts=3)` calls Opus for a HOOK/BODY/CTA script and runs `validateAdScript` ([[../libraries/ad-validator]]) — retries up to 3× on fatal violations before surfacing them.
- **Hero** — [[../inngest/ad-tool]] `ad-tool/hero-requested`: Soul with `character_id` + the signed isolated image as reference + `buildSoulPrompt` (dims + vibe tags). Writes `ad_campaigns.hero_image_url`. NSFW jobs surface, don't silently fall through.
- **Audio** — `ad-tool/audio-requested`: Higgsfield TTS over `script_text`, writes `ad_campaigns.audio_url`.

### Phase 4 — talking-head + b-roll

- **Talking-head** — `ad-tool/talking-head-requested`: Speak from hero + audio. 15s ads = 1 gen; 30s = 2 gens (Speak max 15s/gen). Writes to [[../tables/ad_videos]].
- **B-roll** — `ad-tool/broll-requested`: up to 3 non-hero images from [[../tables/product_media]] → parallel DoP clips with `eligibleMotions(vibe)` (jarring presets — parallax/snap-zoom/dolly — for loud/ugly/weird vibes).

### Phase 5 — captions + render (4 formats)

`ad-tool/render-requested`:
1. **Whisper** transcribes the audio once ([[../libraries/ad-transcribe]]) — reused across all formats.
2. `composeCredibility` builds the always-on row from Tier-5 data ([[../libraries/ad-render]]) — **no hardcoded badge text**; ordered by the operator's `pinned_badges`.
3. For each of the 4 outputs, `buildCompositionProps` assembles caption groups (1-3 words, Hormozi color-flip), the cut plan, ingredient-image pops (fire on word-timestamps from [[../tables/product_ingredients]] / `product_media` ingredient slots), and the **safe-zone core**. `renderAdFormat` dynamically imports `@remotion/*` and renders MP4 (`renderMedia`) or still JPG (`renderStill`).
4. Each output is one [[../tables/ad_videos]] row; siblings link to the first via `format_variant_of_id`. Finals upload to the private `ad-tool` bucket; campaign status → `ready`.

**Meta safe zones** ([[../libraries/ad-tool-config]] `FORMAT_SPECS` / `safeCore`): Reels 14% top / **35% bottom** / 6% sides (most aggressive — passing Reels passes all); Feed-4:5 14% all sides; Stories 20% bottom. All captions, badges, faces, CTA, and key product must land inside the safe core — the renderer asserts this pre-encode.

## Cost

~$2.50 one-time character + ~$0.20 hero + ~$1.50 talking-head + ~$1.50 (3× b-roll) + cents (Whisper + Opus) ≈ **$3.50 marginal per ad** after the character exists. `$1 = 16 Higgsfield credits`. Every Higgsfield call logs to [[../tables/ad_jobs]] for cost-audit/replay. Default cost cap $10/ad (`ad_tool_settings.cost_cap_cents`).

## Safety / invariants

- **Per-workspace encrypted credentials** — `higgsfield_api_key_encrypted` + `higgsfield_secret_encrypted` on `workspaces` (AES-256-GCM, [[../libraries/crypto]]). No global Higgsfield account.
- **No public buckets** — reference photos + finals private; Higgsfield gets 1h signed URLs.
- **NSFW jobs bill but surface** — `status='nsfw'` shown to the operator, job preserved on `ad_jobs`.
- **Inngest concurrency** — `[{ limit: 3, key: "event.data.workspace_id" }]` on every ad-tool function.
- **Gated behind `workspaces.ad_tool_enabled`** (default false) — user-initiated only, no cron.

## Status / open work

**✅ Shipped (built + typechecks):**
- Schema: [[../tables/ad_avatars]], [[../tables/ad_avatar_proposals]], [[../tables/ad_avatar_candidates]], [[../tables/ad_campaigns]], [[../tables/ad_videos]], [[../tables/ad_jobs]], [[../tables/product_ad_angles]] + new columns (`product_variants.isolated_image_url`/`physical_dimensions`, `products.physical_dimensions`, `demographics_snapshots.archetype_tuples`, `workspaces.higgsfield_*_encrypted`/`ad_tool_enabled`/`ad_tool_settings`).
- **Photo-free avatar creation:** demographic proposals (5) → four-attribute (gender/age/health/ethnicity) Soul text-to-image face generation → **saved face library** ([[../tables/ad_avatar_candidates]]) persisting every generation for reuse → pick → mint character. Upload is an optional fallback. APIs: `POST/GET/DELETE /api/ads/avatars/candidates`; `POST /api/ads/avatars` accepts `candidateId`. The builder's avatar step offers both pick-from-library and "generate from buyer demographics".
- Libraries: `ad-angles`, `ad-script`, `ad-validator`, `ad-render`, `ad-tool-config`, `ad-avatar-proposals`, `ad-transcribe`, `ad-storage`, `higgsfield`.
- APIs: `/api/ads/*` (campaigns, avatars, angles, proposals, validate, hero/audio/talking-head/render) + `/api/workspaces/{id}/ad-tool-settings` + product dimensions / variant isolated-image.
- UI: builder wizard + avatars + proposals + angle library + library + settings + storefront-product asset cards + Higgsfield integration card.
- Inngest: [[../inngest/ad-tool]] (hero / audio / talking-head / b-roll / render).
- Remotion composition `/remotion/AdComposition.tsx` (excluded from app tsc; dynamic-imported).

**✅ Verified live against the DB (2026-06-03):**
- Migrations 1-4 applied (`scripts/apply-ad-tool-migration.ts`): all 6 tables + new columns + `ad_product_cohort` RPC confirmed present; private `ad-tool` storage bucket provisioned.
- Phase 0.5: 12 angles generated for **Amazing Coffee** (`ea433e56-…`) — 12/12 anchored to a verbatim `benefit_bar`/lead-benefit, 12/12 within Meta caps (`scripts/generate-amazing-coffee-angles.ts`).
- Phase 2: 4 archetype proposals from the joint four-field tuple; `demographic_basis` clean — no `health_priorities`/`buyer_type`/geo (`scripts/generate-amazing-coffee-proposals.ts`).
- Validator gate tests pass (`scripts/test-ad-validator.ts`): rejects "safe" + review-only scripts, accepts anchored DR scripts.

- **Migration 5** `20260604140000_ad_tool_archetype_cache.sql` (per-product joint-archetype write-through cache on `demographics_snapshots.archetype_tuples`) + **Migration 6** `20260604150000_ad_avatar_candidates.sql` (saved face library) shipped. `ad-avatar-proposals.ts` degrades gracefully without the cache (always live-computes, cache write is best-effort).
- The saved-face library persists every Soul text-to-image generation in [[../tables/ad_avatar_candidates]] for reuse — the two unpicked faces (and any faces from abandoned sessions) stay available instead of orphaning + re-burning credits.

**✅ Proven model stack (end-to-end, 2026-06-03 — Dylan-approved "perfect" 21.5s ad):**
This is the locked-in creative pipeline, confirmed by building a real Amazing Coffee ad:
- **Face** — Higgsfield **Soul** text-to-image (`generateSoulPortrait`), four-attribute, photo-free.
- **Holding-product shot** — Gemini **Nano Banana Pro** (`gemini-3-pro-image`, `generateNanoBananaProCombine` in [[../libraries/gemini]]): face + product isolated image → identity-locked composite, sharp packaging text, correct anatomy. Replaced Higgsfield Seedream (six fingers / blurry text) and Soul-combine.
- **Talking head** — Gemini **Veo 3.1 Fast** (`veo-3.1-fast-generate-preview`, `generateVeoVideo`). Veo's native audio (real ambience/voice) beats polished TTS. **Veo 3.1 (non-fast) is Tier-1 capped at 10 req/day** — Fast has separate quota and was the unblock. Prompt each ~8s segment with "say ONLY these exact words" to suppress hallucinated filler.
- **Audio architecture** — ONE continuous VO spine = the talking segments' own audio. B-roll laid over the visual is **muted or ASMR-ducked low** (never its own music). One low Gemini **Lyria** music bed under everything.
- **Stitch + trim** — multiple ~8s Veo segments (different script each) cut at the last-word timing (Whisper) to kill Veo's end-of-clip dead air.
- **B-roll** — Gemini Veo Fast or Higgsfield **DoP** image-to-video; prompt for ASMR (cracks/pours/splashes).
- **Hormozi captions** — Whisper word-timing, one-at-a-time (each caption's `end` = next caption's `start`, no stacking), Anton font, emoji stickers. `proofread()` drops Veo filler words; `NUMWORDS` keeps numbers (twelve↔12); **"40% off" renders correctly even when Whisper emits an empty word for "percent"** (% attached to the number's beat from the script). Reference composition: `remotion/ExampleAd.tsx` + `_render-example.ts` (local dev driver, not committed).

**✅ Proven stack wired into production (2026-06-03):**
- **Gemini settings card** — Settings → Ad tool → "Google AI Studio (Gemini)" card writes `workspaces.gemini_api_key_encrypted` + `gemini_project_id`, Verify via `probeGeminiAuth`. `getGeminiCredentials` falls back to `env GEMINI_API_KEY`. (Superfoods workspace already seeded.)
- **Veo talking-head** — `adToolTalkingHeadRequested` splits the script into ~8s beats (`splitScriptIntoSegments`), generates each as a Veo 3.1 Fast clip from the holding-product hero, Whisper sets the trim, persists each as an [[../tables/ad_segments]] row (with its script). Replaced Higgsfield Speak/TTS.
- **Creative library** — every piece persists: talking beats, b-roll, music ([[../tables/ad_segments]]) + the stitch recipe (`ad_campaigns.composition`, [[../libraries/ad-segments]]). Render's `assemble` step loads active segments → `buildComposition` → `saveComposition` → resolves signed URLs + proofread VO captions → renders the canonical `remotion/ExampleAd.tsx` (VO spine + muted/ASMR b-roll + Lyria bed). Music (Lyria) is generated in `assemble` if missing.
- **Re-launch refresh** — regenerate ONE talking beat + re-stitch (`adToolSegmentRegenerate`, `regenerateTalkingSegment`). See [[../recipes/ad-relaunch-refresh]]. UI: the campaign page's **Creative library** section ("Refresh this hook").
- **Example ad backfilled** — the approved Amazing Coffee 22s ad is a live campaign in the library (face → avatar → hero → 3 talking + 2 b-roll + 1 music segments → composition → final MP4). `scripts/backfill-example-ad.ts`. `ad_tool_enabled=true` flipped for Superfoods.

**⏳ Open:**
- **Live end-to-end Veo render not yet run from the app** — the pipeline is code-complete + typechecks, but a full wizard→Veo→render pass hasn't run against live quota (Veo 3.1 Fast daily cap). The proven artifacts were produced via one-off scripts and backfilled.
- **Static path** still renders the hero+headline `AdStatic` (unchanged); only the video path uses the VO-spine composition.
- **B-roll/music refresh** — only talking beats are refreshable via the UI; b-roll + music are reused as-is.

Verification scripts: `scripts/test-ad-validator.ts`, `scripts/generate-amazing-coffee-angles.ts`, `scripts/generate-amazing-coffee-proposals.ts`, `scripts/test-higgsfield-auth.ts`.

## Files touched

| File | Purpose |
|---|---|
| `src/lib/ad-tool-config.ts` | Frameworks: LF8, 12 hooks, banned words, format matrix, safe zones, settings shape |
| `src/lib/ad-types.ts` | `AngleGeneratorInput`, `ProductAdAngle` types |
| `src/lib/ad-angles.ts` | Tier hydration + Opus angle generation + validation |
| `src/lib/ad-script.ts` | HOOK/BODY/CTA script generator + 3× retry |
| `src/lib/ad-validator.ts` | Direct-response refuse-to-ship gate (angle + script) |
| `src/lib/ad-avatar-proposals.ts` | Demographic archetype proposals (read-only) + write-through archetype cache (5 default) |
| `src/app/api/ads/avatars/candidates/route.ts` | Generate/list/delete saved avatar faces (Soul text-to-image → [[../tables/ad_avatar_candidates]]) |
| `src/lib/ad-render.ts` | Caption grouping, credibility, cut plan, safe-zone, Remotion invocation |
| `src/lib/ad-transcribe.ts` | Whisper word-level transcription |
| `src/lib/ad-storage.ts` | Private `ad-tool` bucket upload + signed URLs |
| `src/lib/higgsfield.ts` | Higgsfield client (Soul/DoP/Speak/TTS/character) + `ad_jobs` logging |
| `src/lib/inngest/ad-tool.ts` | Async hero/audio/talking-head/b-roll/render functions |
| `remotion/AdComposition.tsx` | Remotion composition (video + static) |
| `src/app/dashboard/marketing/ads/**` | Builder wizard, avatars, proposals, angle library, library |
| `src/app/api/ads/**` | All ad APIs |
| `src/app/api/workspaces/[id]/ad-tool-settings/route.ts` | Settings get/patch |
| `src/app/api/workspaces/[id]/products/[productId]/dimensions/route.ts` | Product dimensions |
| `src/app/api/workspaces/[id]/products/[productId]/variants/[variantId]/isolated-image/route.ts` | Variant isolated image |

## Related

[[demographic-enrichment]] · [[product-intelligence]] · [[../tables/product_ad_angles]] · [[../tables/ad_campaigns]] · [[../tables/ad_videos]] · [[../tables/ad_jobs]] · [[../tables/ad_avatars]] · [[../tables/ad_avatar_proposals]] · [[../tables/ad_avatar_candidates]] · [[../integrations/higgsfield]] · [[../integrations/openai]] · [[../libraries/ad-angles]] · [[../libraries/ad-validator]] · [[../libraries/ad-render]] · [[../inngest/ad-tool]] · [[../dashboard/marketing__ads]] · [[../dashboard/marketing__ads__new]] · [[../dashboard/marketing__ads__avatars]] · [[../dashboard/settings__ad-tool]]
