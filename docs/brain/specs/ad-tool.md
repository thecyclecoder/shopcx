# Ad tool — avatar-driven video + static ads with Hormozi captions

Build an in-app studio for spinning up paid-social ads in minutes. The studio composes: (1) a workspace-owned **AI avatar** holding the brand's product, (2) the avatar **talking to camera** with lip-sync from a script, (3) **b-roll** image-to-video clips of product / lifestyle shots, (4) **Hormozi-style word-level captions** synced to the audio. Output: a single MP4 (and a static-frame JPG variant for image-ad surfaces) ready for Meta Ads Manager / TikTok / YouTube Shorts.

Business outcome: cut per-ad creative cost from ~$200 (freelancer) to ~$2 (Higgsfield credits + a few cents Whisper + a few cents Anthropic), and cut turnaround from days to ~5 minutes per ad. Enables ROAS-driven creative iteration at the cadence the Meta ads dashboard needs.

## Vendor decision

| Vendor | Role | Why |
|---|---|---|
| **Higgsfield Cloud API** (`cloud.higgsfield.ai`) | Image gen (Soul), image-to-video (DoP), talking head (Speak) | One vendor for character consistency + talking-head + b-roll. Pay-per-credit pricing ($1 = 16 credits). Soul Mode with `reference_image_urls` is the exact "avatar + product" surface we want. |
| **OpenAI Whisper** (existing `OPENAI_API_KEY`) | Word-level transcription of the talking-head audio for captions | Best-in-class word-level timestamps. We already have the API key. |
| **ElevenLabs OR Higgsfield Audio** | Text-to-speech for the script | TBD in Phase 2. Higgsfield Audio is part of the Higgsfield bill; ElevenLabs is higher quality but separate billing. Default: Higgsfield Audio (one vendor, one bill). |
| **Remotion** (npm: `remotion`) | Server-side video composition (talking head + b-roll + caption overlay) | React-based video renderer, runs on Node. Battle-tested for caption overlays. Alternative: ffmpeg + drawtext, but Hormozi-style animated word pops are painful in pure ffmpeg. |
| **Supabase Storage** (existing) | Avatar reference photos, product images, generated audio, intermediate clips, final MP4 | Same auth, same bucket pattern. |

**NOT** using: third-party MCP wrappers (we want HTTP straight to Higgsfield for cost + control), Captions.ai or other SaaS caption tools (Remotion gives us full styling control + no per-render fee), Veo / Sora / Runway (Higgsfield's DoP + Speak cover our shapes).

References gathered during research:
- [Higgsfield Cloud dashboard + API key issuance](https://cloud.higgsfield.ai/)
- [Higgsfield API how-to](https://apidog.com/blog/higgsfield-api/) — base auth, endpoint shapes
- [geopopos/higgsfield_ai_mcp](https://github.com/geopopos/higgsfield_ai_mcp) — confirms `HF_API_KEY` + `HF_SECRET` dual-credential pattern, model IDs (Soul / DoP), character creation flow, credit pricing
- [Higgsfield Speech-2-Video schema (via Segmind)](https://www.segmind.com/models/higgsfield-speech2video/api) — talking-head parameter shape
- [Higgsfield Lipsync Studio](https://higgsfield.ai/lipsync-studio) — product surface we're replicating server-side
- [Higgsfield Speak product page](https://higgsfield.cc/higgsfield-speak) — 40-language support, expression control
- [Higgsfield pricing](https://higgsfield.ai/pricing) — $1 = 16 credits

## End-to-end pipeline

```
admin opens /dashboard/marketing/ads/new
   │
   ▼
1. Pick or create avatar (one-time per workspace, persistent character_id)
   │   Higgsfield create_character  ── 40 credits ($2.50) one-time
   ▼
2. Pick product (from existing [[../tables/products]])
   │
   ▼
3. Write script  (or paste Hormozi-style hook + body + CTA)
   │
   ▼
4. Generate "avatar holding product" hero shot
   │   Higgsfield Soul with character_id + product image as reference_image_url
   │   ── 3 credits (1080p)
   ▼
5. Generate audio from script
   │   Higgsfield Audio TTS (or ElevenLabs)
   ▼
6. Generate talking-head video from hero shot + audio
   │   Higgsfield Speak speech2video
   │   ── ~$0.10/sec × 15s = $1.50
   ▼
7. (Optional) Generate b-roll: 2-4 image-to-video clips of product / lifestyle
   │   Higgsfield DoP image-to-video
   │   ── 9 credits ($0.56) per 5s clip
   ▼
8. Transcribe audio for word-level timestamps
   │   OpenAI Whisper word-level mode
   ▼
9. Render final MP4 in Remotion
   │   Composition: talking-head + b-roll cuts + Hormozi caption overlay
   ▼
10. Save to Supabase Storage + write ad_videos row + show in library
```

Per-ad cost estimate: ~$2.50 (one-time character) + ~$0.20 (hero) + ~$1.50 (talking head) + ~$1.50 (3× b-roll) + cents (Whisper + Anthropic) = **~$3.50 marginal cost per ad** after the character is created.

## Where it lives in the dashboard

**Sidebar location:** `Marketing → Ads` (third sibling under the existing collapsible Marketing group, alongside `Text` and the `Email` coming-soon slot). Single-line edit to `src/app/dashboard/sidebar.tsx`:

```ts
{ href: "/dashboard/marketing/ads", label: "Ads", icon: ICONS.marketing },
```

**All routes namespaced under `/dashboard/marketing/ads/`:**

| Route | Purpose |
|---|---|
| `/dashboard/marketing/ads` | Landing: split layout — Avatars · Campaigns · Library |
| `/dashboard/marketing/ads/avatars` | Avatar manager (Phase 2 — proposals on top, active avatars below) |
| `/dashboard/marketing/ads/avatars/new` | Photo upload + character creation (from proposal or scratch) |
| `/dashboard/marketing/ads/avatars/proposals/new` | Operator-initiated "Suggest avatars for product X" |
| `/dashboard/marketing/ads/new` | The builder (angle → length → script → hero → audio → talking-head → b-roll → render) |
| `/dashboard/marketing/ads/[id]` | Per-ad detail: video + static previews, download buttons, sister-cut links |
| `/dashboard/marketing/ads/angles/[productId]` | Angle library for a product (Phase 0.5) + "Generate fresh angles" |

**Settings page:** `/dashboard/settings/ad-tool` — its own card on Settings landing, matching the existing settings convention. Holds banned-words list, LF8 toggles, ugly-mode intensity, default caption style, default urgency lever per category, cost cap per render.

**Phase 0 (variant isolated images + product dimensions) UI does NOT live under `marketing/ads/`** — it lives on the existing `/dashboard/storefront/products/[id]` page under the `Storefront` sidebar group. That's product-catalog data, not ad data. The ad builder just consumes those columns when generating heroes.

**Rationale:**
- Paid social is conceptually a marketing channel like SMS and email; living under Marketing groups all three together.
- The Marketing sidebar group is already collapsible and currently underweighted (one live entry); adding `Ads` gives it usable weight.
- A top-level "Ads" item would clutter the sidebar without semantic gain.
- `/dashboard/analytics/roas` already exists under Analytics — performance attribution flows there naturally, no UI restructure needed.

## Direct response philosophy — the system's spine

Everything below is a tactical implementation of this principle: **nobody scrolls past their feed to look at your product. They scroll past their feed looking for something that will fix their life.** Every output of this tool must obey that. "Safe" ads, "soft" ads, "polished" ads die at <20% hook rate (the floor below which we kill an ad in 48-72h per industry benchmarks). The system is **opinionated** about this and refuses to generate inputs that would yield safe ads — see Phase 0.5 below.

### The frameworks we encode

1. **Life Force 8 (Cashvertising, Whitman).** Eight biological desires drive the majority of purchase decisions. Every Superfoods product sits primarily in 1-2 of these — the ad script targets that exact LF8 slot, never the product's features:
   1. Survival, enjoyment of life, life extension
   2. Enjoyment of food and beverages
   3. Freedom from fear, pain, and danger
   4. Sexual companionship
   5. Comfortable living conditions
   6. **To be superior, winning, keeping up with the Joneses**
   7. Care and protection of loved ones
   8. Social approval
2. **Pattern interrupt in the first 2 seconds.** TikTok decides in 1.5-3 seconds; Meta in 5-7. Hook lands in frame 1 or the ad is dead. No "Hey guys" intros, no brand-name openers, no logo reveals.
3. **Problem → Agitation → Solution.** Classic direct response. We open on the customer's existing pain (now, not theoretical), make them feel it, then position the product as the only escape.
4. **Specificity beats vibe.** "Sleep 47 minutes longer" beats "sleep better." "97% of women who tried this" beats "many women." Numbers anchor attention.
5. **Urgency + scarcity + social proof.** "Limited batch," "selling out," "300 people bought this in the last hour," "as featured in [reviews]" — these go into the CTA and the captions, not the spoken script.
6. **Ugly, raw, loud.** Polished kills conversion. Phone-recorded vibes, weird crops, oversaturated colors, hand-held wobble, jump cuts every 1-2 seconds. Hormozi captions are LOUD on purpose. The "wellness" category is drowning in pastel pink minimalist beige — we go the other direction.

### The hook formulas we encode (Cashvertising + 2026 UGC playbook)

Each hook formula is a template the system uses to generate the first 2-3 seconds. The script writer in Phase 3 picks one per ad, never improvises a "warm intro":

| Slug | Template | Psychological lever | Best for LF8 |
|---|---|---|---|
| `problem_now` | "If you wake up and [pain] before [time]…" | Immediate self-recognition | 3 (freedom from fear/pain) |
| `contrarian` | "You've been [common habit] completely wrong." | Pattern break + curiosity | 1, 5 |
| `results_first` | "I [outcome] in [unrealistic short time] doing this." | Anchors on proof before explanation | 1, 6 |
| `callout` | "If you're a [demographic] over [age], stop scrolling." | Self-targeting via identity | 6, 8 |
| `enemy` | "The [industry] doesn't want you to know this." | Establishes shared enemy | 6, 7 |
| `secret_reveal` | "Nobody talks about why [problem]. Here's the truth." | Curiosity gap | 1, 3 |
| `urgent_question` | "Do you [behavior]? Then this is killing you." | Implicit threat | 1, 3 |
| `social_proof_shock` | "300 [demographic] just bought this in the last hour." | FOMO + bandwagon | 6, 8 |
| `visual_shock` | (no spoken hook — open on weird/satisfying/jarring visual) | Stops scroll pre-cognition | any |
| `story_in_progress` | "So I'm at [unexpected place] and this happens…" | Native, story-driven curiosity | 8 |
| `keeping_up` | "Everyone you know is [doing X] except you." | LF8 #6 directly | 6 |
| `loved_one_at_risk` | "Your [child/spouse/parent] is [doing X] and you have no idea." | LF8 #7 | 7 |

Sources:
- [Cashvertising / Life Force 8 summary](https://www.marketingmehn.com/cashvertising-summary-and-cashvertising-pdf/)
- [Cashvertising 17 hot-buttons](https://cashvertising.wordpress.com/2010/03/03/do-you-know-the-17-human-hot-buttons/)
- [UGC hook formulas + 2026 hook-rate benchmarks](https://www.hustlermarketing.com/blog/how-to-write-ugc-ad-hooks-that-stop-the-scroll-on-meta-and-tiktok/)
- [TikTok 1.5-3s decision window](https://www.stackmatix.com/blog/tiktok-hook-first-3-seconds)
- [TikTok 2026 creative best practices](https://www.stackmatix.com/blog/tiktok-ad-creative-best-practices-2026)

### The visual style we encode

Static + video. Both lean **anti-wellness-pastel**:

- Oversaturated colors (turmeric orange, neon green, electric blue, hot pink), NEVER muted earth tones.
- Hard text overlays on shipping-label backgrounds, brutalist sans-serif (Anton, Druk, Inter Black), no soft serifs.
- Asymmetric crops — product cut off at the edge, text crammed in a corner, headroom feels "wrong."
- Texture: paper, scanned print, halftone overlays. Looks like 1970s direct mail, not 2020s SaaS.
- Hand-drawn arrows, circles, scribbles pointing at the product.
- Faces with expressions that read as "shocked / disgusted / mid-sentence" — never the calm-smile stock vibe.
- Phone-recorded handheld feel for video — not tripod-steady, not color-corrected.

The static-ad render in Phase 5 has these as preset templates the operator picks from; the video render injects them as overlays + crop choices.

### What the system REFUSES to generate

Phase 0.5 (new — see below) is a hard gate. The system refuses to ship an ad where:
- No LF8 slot is selected.
- The hook is "Introducing [product]" or any variant of brand-first opening.
- The script is feature-led (talks about ingredients before talking about what the customer feels).
- The CTA is a soft suggestion ("learn more") rather than a directive with urgency ("Get yours before the next batch sells out").
- The visual style is "polished e-commerce" — generic studio shot, white background, no overlay, no text. (Static ads can't ship without overlay text and a non-default background.)

These rules are enforced both at script-generation time (the Claude prompt is strict) and at render time (Phase 5 validates the composition before encoding).

## Phase 0 — product asset prep (isolated images + physical dimensions) ⏳

The hero generation in Phase 3 is only as good as the product reference we feed it. Catalog images are often packaging mockups with backgrounds + shadows + reflections; the Soul model interprets those as "draw the avatar holding a flat rendered mockup of a bag," not "draw the avatar holding an actual bag." Two upstream additions fix this.

### A. Per-variant isolated image

On [[../tables/product_variants]] add:

- `isolated_image_url text` — Supabase Storage URL of the variant photographed alone, on transparent or pure-white background, centered, no shadow. This is what gets passed as `reference_image_urls[]` to Higgsfield Soul in Phase 3.
- `isolated_image_uploaded_at timestamptz`
- `isolated_image_uploaded_by uuid → workspace_members.user_id`

### B. Per-product physical dimensions

On [[../tables/products]] add:

- `physical_dimensions jsonb` — `{ length_in: number, width_in: number, height_in: number, weight_oz: number?, shape: 'bag'|'box'|'bottle'|'jar'|'pouch'|'other' }`

Variants inherit from product unless overridden — most workspaces have one physical SKU per product. (If a workspace has, say, a 12oz bag vs a 5lb bag of the same coffee, dimensions go on the variant, not the product. So add a nullable `physical_dimensions` to `product_variants` too — variant-level wins when set, product-level is the fallback.)

These get baked into the Soul prompt during Phase 3. Example prompt template (Phase 3 will use this):

> `{avatar name} holding a 7-inch by 12-inch coffee bag of {product title}, studio lighting, clean background, mid-shot, looking at camera, smiling, photorealistic, the bag is approximately {length_in}" × {width_in}" so size it proportionally in the avatar's hand`

The dimensions matter because Soul + most diffusion models default to "drink-can-sized" objects when not constrained — coffee bags come out as the size of a sandwich; jars come out as the size of a phone.

### Storefront UI changes

Existing `/dashboard/products/[id]` gets:

1. **Per-product "Physical dimensions" card** — four numeric inputs (length / width / height / weight) + a shape dropdown. Save button POSTs to `/api/products/{id}/dimensions`.
2. **Per-variant "Isolated image" upload** — a separate image upload widget under each variant row, with a thumbnail preview. Replaces existing isolated image if any. Stored in Supabase Storage at `products/{workspace_id}/{product_id}/variants/{variant_id}/isolated.png`. POSTs to `/api/products/{id}/variants/{variant_id}/isolated-image`.
3. **Optional per-variant dimension override** — same four inputs, collapsible, defaults to "inherit from product."

Both upload UIs accept PNG / JPG / WEBP, max 10 MB. Server-side: validate the image, store, write the column. No image resizing on upload — Higgsfield works fine with high-res sources.

### Completion criteria — Phase 0

- Migration adds `isolated_image_url` + `isolated_image_uploaded_at` + `isolated_image_uploaded_by` to `product_variants`.
- Migration adds `physical_dimensions jsonb` to both `products` and `product_variants`.
- Upload card on `/dashboard/products/[id]` works for both surfaces.
- For at least one Superfoods product (manual test): upload the variant's isolated image + the product's dimensions, then verify the values land in the DB.

This phase ships BEFORE Phase 1 so the avatar/character pipeline has clean product references to consume from day one.

## Phase 0.5 — product intelligence → ad angles (LF8 mapping + DR validator) ⏳

The existing [[../tables/product_intelligence]] table is benefit-led + science-backed (great for explainer copy and PDP) but the way it's written today is too **soft** for paid social — too many "supports healthy ..." phrasings, not enough "fix this NOW" energy. This phase bridges the two.

### A. New table: `product_ad_angles`

Per (product, hook_slug, lf8_slot) — one row is one tested angle the system can spin variants from.

- `id`, `workspace_id`, `product_id → products`
- `hook_slug text` — one of the 12 hook formulas in the direct-response section above
- `lf8_slot int 1..8` — which Life Force 8 desire this targets
- `pain_now text` — the customer's existing pain in their language (NOT the product's marketing language)
- `desired_outcome text` — the LF8-aligned outcome the customer actually wants
- `hook_one_liner text` — the populated hook for this product (≤ 15 words, plug-and-play into the script)
- `proof_anchor text` — specific number / claim / review snippet that backs the outcome (e.g. "97% of 4.8-star reviews mention more energy by day 3")
- `urgency_lever text` — `limited_batch` / `selling_out` / `price_increase_soon` / `seasonal` / `none` — the CTA frame
- `enemy text` — optional, who/what the ad is positioned against ("the supplement industry," "fake wellness," "Big Coffee")
- `vibe_tags text[]` — `ugly` / `loud` / `weird` / `phone_recorded` / `clinical` / `etc` for the render preset
- `generated_by text` — `ai` / `agent` / `imported`
- `times_used int` — how many ads pulled this angle
- `last_performance jsonb` — placeholder for future Meta Ads tie-in
- `created_at`, `updated_at`

### B. Angle generator

`src/lib/ad-angles.ts`:

`generateAngles(productId, count = 12)`:

1. Load the product's [[../tables/product_intelligence]] (benefits, science citations) + top 20 [[../tables/product_reviews]] (especially the "smart_featured" + 5-star ones).
2. Load all 12 hook formulas + Life Force 8 framework as a static system prompt.
3. Call Claude Opus with a strict generation schema:
   - For each LF8 slot relevant to this product (typically 2-3 of the 8), generate 3-4 angles using different hook formulas.
   - Pain language must come from the actual review corpus (Opus is forced to cite reviewer phrases verbatim where possible — that's where the realness comes from).
   - No marketing words: ban "supports," "promotes," "helps," "may aid," "natural," "wellness." Reject the angle if any of those appear.
4. Insert N rows into `product_ad_angles`. These become the angle picker on `/dashboard/marketing/ads/new`.

This runs once per product (admin clicks "Generate angles" on the product detail page), with a re-run button to refresh as reviews accumulate.

### C. Direct Response Validator (the refuse-to-ship gate)

`src/lib/ad-validator.ts`:

`validateAdScript(script, angle)` → `{ ok, violations[] }`. Refuses scripts that:
- Contain banned soft words (regex list above).
- Start with the brand name OR "Hey" / "Hi" / "Welcome" / "Introducing."
- Lead with features (ingredients, sourcing, certifications) in the first 5 seconds.
- Have a CTA softer than imperative + urgency ("learn more" rejected; "Grab yours before this batch sells out at midnight" accepted).
- Are >30 seconds total (per Phase 4 cap).

The script generator (Phase 3) calls this internally and retries up to 3 times before surfacing the violations to the operator. The final render (Phase 5) calls it one more time as a hard gate — no ad ships that fails validation.

### D. Settings page

`/dashboard/settings/ad-tool` — operator can:
- Edit the banned-words list per workspace.
- Adjust the LF8 slots their brand is allowed to play in (some brands can't credibly target LF8 #4 sexual companionship; that gets toggled off).
- Toggle the "ugly mode" intensity (mild / heavy / extreme).
- Pin a default `urgency_lever` per product category if seasonal patterns repeat.

### Completion criteria — Phase 0.5

- `product_ad_angles` table exists with at least 12 angles generated for one Superfoods product.
- The angles read like they could go on TikTok tomorrow — not like benefit copy from a wellness brand site.
- Validator rejects a deliberately "safe" script in a runnable test (`scripts/test-ad-validator.ts`).
- Settings page works.

## Phase 1 — Higgsfield integration (auth, helpers, persistence) ⏳

### Schema

New tables (all RLS-scoped to workspace, service-role write):

- **`ad_avatars`** — per-workspace persistent characters.
  - `id uuid pk`
  - `workspace_id uuid → workspaces`
  - `name text` (admin-facing)
  - `higgsfield_character_id text` (returned by `create_character`)
  - `reference_image_urls text[]` (the photos we trained on)
  - `created_by uuid → workspace_members.user_id`
  - `created_at, updated_at`
  - `status text` — `active` / `archived`
  - `last_used_at timestamptz`

- **`ad_campaigns`** — one row per ad concept (script + product + avatar).
  - `id`, `workspace_id`, `name`, `product_id → products`, `avatar_id → ad_avatars`
  - `script_text text` (full script, including hook / body / CTA)
  - `voice_id text` (TTS voice id — Higgsfield or ElevenLabs)
  - `hero_image_url text` (Supabase Storage URL)
  - `status text` — `draft` / `rendering` / `ready` / `failed`
  - `created_by`, `created_at`, `updated_at`

- **`ad_videos`** — one row per rendered output.
  - `id`, `workspace_id`, `campaign_id → ad_campaigns`
  - `final_mp4_url text` (Supabase Storage URL)
  - `static_jpg_url text` (frame extract for image-ad surfaces)
  - `talking_head_url text` (intermediate Higgsfield output)
  - `audio_url text` (Higgsfield Audio / ElevenLabs output)
  - `b_roll_urls jsonb` (array of `{image_url, video_url, prompt, motion_id}`)
  - `transcript_json jsonb` (Whisper word-level timestamps)
  - `caption_style text` — `hormozi_yellow` / `hormozi_white` / `clean_white` (extensible)
  - `duration_sec int`
  - `cost_cents int` (sum of all credits + Whisper + TTS, for ROAS dashboard later)
  - `meta jsonb` (per-clip job_set_ids, render attempts, errors)
  - `created_at`

- **`ad_jobs`** — Higgsfield async job tracking.
  - `id`, `workspace_id`, `campaign_id`, `video_id` (nullable until finalized)
  - `job_type text` — `soul_image` / `dop_video` / `speak_video` / `tts_audio`
  - `higgsfield_job_set_id text`
  - `status text` — `queued` / `in_progress` / `completed` / `failed` / `nsfw`
  - `request_payload jsonb`
  - `response_payload jsonb`
  - `output_url text`
  - `cost_credits int`
  - `polled_at timestamptz`, `completed_at timestamptz`
  - `error text`

### Workspaces columns

- `higgsfield_api_key_encrypted` (AES-256-GCM, see [[../libraries/crypto]])
- `higgsfield_secret_encrypted`
- `ad_tool_enabled boolean default false`
- `default_avatar_id uuid → ad_avatars` (optional shortcut)
- `default_caption_style text default 'hormozi_yellow'`

### Library

`src/lib/higgsfield.ts` — typed client, mirrors the integration page that will land in Phase 5:

- `getHiggsfieldCredentials(workspaceId)` → `{ apiKey, secret }` or `null`
- `createCharacter({ workspaceId, name, imageUrls })` → `{ characterId }`
- `generateSoulImage({ workspaceId, characterId, prompt, referenceImageUrls?, quality })` → `{ jobSetId }`
- `generateDopVideo({ workspaceId, imageUrl, motionId, prompt?, quality })` → `{ jobSetId }`
- `generateSpeakVideo({ workspaceId, imageUrl, audioUrl, prompt, duration, quality })` → `{ jobSetId }`
- `getJobStatus({ workspaceId, jobSetId })` → `{ status, outputUrls[] }`
- `listMotions()`, `listStyles()` — static catalogs from Higgsfield resources (cached)

All requests go through `loggedHiggsfieldFetch()` wrapper that writes to `ad_jobs` for replay. Same pattern as [[../libraries/appstle-call-log]].

### Settings page

`/dashboard/settings/integrations` gets a new Higgsfield card. Same UX as Klaviyo/Resend: paste API key + secret, click Save, server verifies by calling `GET /v1/account` (or whatever Higgsfield's auth-probe endpoint is).

### Completion criteria — Phase 1

- Migration applied via `scripts/apply-ad-tool-migration.ts`.
- Higgsfield card on Settings → Integrations connects + saves encrypted credentials.
- `npx tsx scripts/test-higgsfield-auth.ts` calls `getHiggsfieldCredentials` + makes one cheap probe call (e.g. list motions) and prints the result.

## Phase 2 — avatar manager + character creation ⏳

The avatar isn't generic — it's a deliberate match for the **actual buyer** of the product the avatar will sell. The system reads who buys each product from existing demographic tables and proposes archetype briefs the operator confirms before any photos are uploaded or characters are minted on Higgsfield.

### Demographic-driven archetype proposals

The mechanism here piggybacks on the existing demographic-enrichment pipeline. See [[../lifecycles/demographic-enrichment]] for the canonical trace of how [[../tables/customer_demographics]] gets populated (Haiku name inference → Census ZIP lookup → snapshot builder). This phase is a **read-only consumer** of that pipeline; it never writes to those tables.

**Demographic fields we use (and only these four):**

| Field | Source | Why we use it |
|---|---|---|
| `inferred_gender` | [[../tables/customer_demographics]] (Haiku name inference) | Avatar gender match |
| `inferred_age_range` | same (`under_25` / `25-34` / `35-44` / `45-54` / `55-64` / `65+`) | Avatar apparent-age band |
| `inferred_life_stage` | derived from age_range (`young_adult` / `family` / `empty_nester` / `retirement_age`) | Wardrobe + setting cues, scene framing |
| `zip_income_bracket` | Census ACS via [[../libraries/census]] (`under_40k` / `40-60k` / `60-80k` / `80-100k` / `100-125k` / `125-150k` / `150k+`) | Wardrobe quality, setting upgrade level, prop choice (Whole Foods kitchen vs. apartment kitchen) |

**Fields we explicitly DO NOT use:**

- `health_priorities[]` — NOT used. The whole point of Phase 0.5's `product_ad_angles` is that the angle already knows the customer's pain. Stacking health priorities on top of the angle would just bias the avatar toward "yoga mat in frame" stereotypes when the angle already says the pain. The angle owns the script; the avatar just owns the face.
- `buyer_type` — NOT used. We're targeting the demographic of the buyer, not their purchase pattern. Whether they're a `lapsed_subscriber` vs. `new_subscriber` doesn't change what they look like.
- `zip_urban_classification`, `zip_owner_pct`, `zip_college_pct` — NOT used. Income bracket already covers most of the signal these would add, and the more dimensions we pull in, the more the proposals get over-specified.
- `versium_*` — NOT used. Per [[../lifecycles/demographic-enrichment]], Superfoods doesn't have a Versium key so these are NULL anyway.

**Flow:**

When the operator clicks "Suggest avatars for [product]":

1. Load buyer data for the product, using the **product cohort query pattern documented in [[../lifecycles/demographic-enrichment]]** ("Querying the cohort behind a product" — title-text `ILIKE` against `orders.line_items[].title` since `line_items` JSONB has no `product_id`):
   ```sql
   SELECT DISTINCT o.customer_id
   FROM orders o, jsonb_array_elements(o.line_items) li
   WHERE o.workspace_id = $1::uuid
     AND o.customer_id IS NOT NULL
     AND li->>'title' ILIKE '%{product title or stem}%';
   ```
   Then for each `customer_id`, expand to the [[../tables/customer_links]] group so one real person counts once.
2. Pull the four-field tuple from [[../tables/customer_demographics]] for those customers: `inferred_gender`, `inferred_age_range`, `inferred_life_stage`, `zip_income_bracket`. Skip rows where `inferred_gender` is `unknown` or where Haiku flagged low gender_confidence (`< 0.6` per the enrichment lifecycle) — those just dilute the cohort.
3. Compute the top 2-4 archetypes by buyer share. Each archetype is a tuple of `(inferred_gender, inferred_age_range, inferred_life_stage, zip_income_bracket)`. Example for a coffee product whose buyers skew female, 35-44, family life stage, 80-100k bracket: archetype = "Female, 35-44, family life stage, upper-middle income — 41% of buyers."
4. For each archetype, call Claude Opus with the demographic tuple + the product's `product_ad_angles` from Phase 0.5 → returns an `archetype_brief`:
   - Suggested name (used for `ad_avatars.name`).
   - Wardrobe + setting cues, anchored to the income bracket + life stage (NOT pulled from health_priorities). Example: family life stage + 80-100k → "casual athleisure, modern kitchen, mid-morning light, family photos visible in background."
   - Hook delivery style match — some archetypes deliver `contrarian` hooks better than `keeping_up`. The match comes from the four-field tuple, not from health interests.
   - Sourcing direction for reference photos — describes the photoshoot brief the operator can give a friend, a UGC creator, or feed into a stock-photo search.
5. Insert N rows into `ad_avatar_proposals` (new table — schema below). These appear as a card grid on `/dashboard/marketing/ads/avatars`.

If the cohort is too sparse to derive archetypes (< 30 unique customers after the link-group dedup), the proposal generator falls back to the workspace-level all-customers snapshot from [[../tables/demographics_snapshots]] (`product_id = NULL`), using the same four-field tuple. The proposal card surfaces this fallback clearly: "This product has only N buyers — using workspace-wide demographics instead."

The operator confirms a proposal → moves to the photo-upload step → that's when 40 credits get spent on Higgsfield. **No proposal auto-spends credits.**

### New table: `ad_avatar_proposals`

- `id`, `workspace_id`, `product_id → products`
- `archetype_brief jsonb` — full brief returned by Opus
- `demographic_basis jsonb` — `{ cohort_size, gender_share, age_range_share, life_stage_share, income_bracket_share, used_fallback_snapshot: bool }`. Only the four-field demographic tuple — no `health_priorities`, no `buyer_type`, no urban/geo fields. Reproducibility anchor: a future re-run with the same enrichment_version should produce the same tuple.
- `status text` — `proposed` / `confirmed` / `rejected` / `archived`
- `confirmed_avatar_id uuid → ad_avatars` — set when the operator runs the photo-upload step on a proposal
- `created_at`, `created_by`

### Dashboard

New route group:

- `/dashboard/ads` — landing page, links to Avatars + Campaigns + Library
- `/dashboard/marketing/ads/avatars` — split layout:
  - **Top: Proposals** — cards from `ad_avatar_proposals` where `status='proposed'`. Each card shows: archetype name, suggested wardrobe/setting, demographic basis ("This archetype represents 38% of [Product] buyers — age 35-44, female, suburban"), and a "Confirm + upload photos" button.
  - **Bottom: Active avatars** — list of `ad_avatars` rows with thumbnails, last-used date, and an archive button.
- `/dashboard/marketing/ads/avatars/new` — upload 1-5 reference photos, name the avatar, click Create. Reachable two ways:
  - From a confirmed proposal (most common path) — the avatar name + brief are prefilled from the proposal.
  - From scratch (operator just wants to add an avatar without a demographic basis).
- `/dashboard/marketing/ads/avatars/proposals/new` — operator-initiated "suggest avatars for a product" form.

### Flow

1. Operator picks a product → clicks "Suggest avatars" → archetype proposals appear (no Higgsfield cost yet — just an Opus call, single-digit cents).
2. Operator picks one proposal → "Confirm + upload photos" → photo-upload page prefilled with the brief.
3. Browser uploads reference photos to Supabase Storage bucket `ad-tool/avatars/{workspace_id}/...`
4. POST `/api/ads/avatars` with `{ name, imageUrls[], proposalId? }` → calls `createCharacter()` → writes `ad_avatars` row → if `proposalId` provided, sets `ad_avatar_proposals.confirmed_avatar_id` + `status='confirmed'`.
5. Higgsfield charges 40 credits ($2.50). Cost recorded on the row.

The `ad_avatars` row gets a new column `proposed_from_id uuid → ad_avatar_proposals` so the lineage is queryable later (e.g. "show me avatars built for buyers of Mixed Berry Tabs").

### Safety

- **Max 10 avatars per workspace** — characters cost real money. UI surfaces archive-to-replace rather than letting infinite avatars accumulate.
- Reference photos stay private (not public bucket URLs after creation — but Higgsfield needs public URLs at creation time; we sign 1-hour URLs for the API call then revoke).
- Admin/owner role only — agent / social / marketing roles can SEE the avatar list but can't create or delete.

### Completion criteria — Phase 2

- Avatar list + create page functional.
- A real avatar exists at the end (verify in Higgsfield dashboard).
- Avatar appears in the picker on /dashboard/marketing/ads/new (Phase 3).

## Phase 3 — script + hero image + audio generation ⏳

### Dashboard

`/dashboard/marketing/ads/new`:
1. **Avatar picker** (radio cards from `ad_avatars`)
2. **Product picker** (search [[../tables/products]] + show image)
3. **Angle picker** — grid of cards from `product_ad_angles` (Phase 0.5). Each card shows: hook formula slug, LF8 slot badge, the populated `hook_one_liner`, the `proof_anchor` snippet, and a vibe-tag chip row. Operator picks ONE. A "Generate fresh angles" button calls the Phase 0.5 generator on demand.
4. **Length picker** — radio: `15s` (TikTok / Reels) vs `30s` (TikTok / Reels / Meta feed). The script generator targets the picked length minus 1 second for buffer (14s / 29s talk time). Two variants of the SAME ad can be generated in parallel (same angle, two lengths) — checkbox: "Also produce a 15s cut."
5. **Script editor** — auto-populated from the picked angle + length. Three sections: Hook (≤ 2 seconds spoken), Body (problem → agitation → solution, ≤ 60% of total), CTA (imperative + urgency lever from the angle row). Char counters with hard caps. Edits are validated live via the DR Validator from Phase 0.5 — violations highlight inline. "Regenerate" button re-runs the script generator with the same angle but a different seed.
4. **Voice picker** — list of TTS voices (Higgsfield catalog or ElevenLabs if we wire it).
5. **Hero shot preview** — auto-generated once avatar + product + script are all set.

   **Inputs (all from Phase 0):**
   - `character_id` from the avatar — locks the face.
   - **`reference_image_urls = [variant.isolated_image_url]`** — the bg-free product shot so Soul renders the actual SKU (not a generic mockup it hallucinates).
   - `physical_dimensions` from the product/variant — get baked into the prompt as explicit size constraints so the model doesn't shrink a coffee bag to drink-can size.

   **Soul prompt template:**
   ```
   {avatar.name} holding a {dims.length_in}-inch by {dims.height_in}-inch
   {dims.shape} of {product.title}, studio lighting, clean background,
   mid-shot, looking at camera, smiling, photorealistic. The {dims.shape}
   measures approximately {dims.length_in}" × {dims.width_in}" × {dims.height_in}",
   so size it proportionally in the avatar's hand — not as a small handheld
   item, but realistically scaled.
   ```

   If `variant.isolated_image_url` is null, the builder hard-blocks Generate with a "Upload an isolated image of this variant first" link to `/dashboard/products/{product_id}`. Phase 0 is non-optional for ad generation.
7. **Generate hero** button → POST `/api/ads/campaigns` → kicks off Higgsfield Soul → writes `ad_campaigns.hero_image_url` when ready. **Hero is generated with the picked angle's vibe_tags injected into the prompt** — `ugly` adds "asymmetric framing, oversaturated color grading, slight motion blur, phone-camera look"; `clinical` adds "harsh fluorescent lighting, lab-counter background"; etc. The hero is NOT a polished e-commerce photo.
8. **Generate audio** button → POST `/api/ads/campaigns/{id}/audio` → kicks off TTS → writes `ad_campaigns.audio_url`. Plays back inline. Voice picker excludes any voice tagged `calm` / `soothing` — defaults to voices tagged `urgent` / `direct` / `energetic` for direct response.

### Inngest

`src/lib/inngest/ad-tool.ts`:
- `ad-tool/hero-requested` — async Soul gen + poll → writes `hero_image_url` + fires `ad-tool/hero-completed`
- `ad-tool/audio-requested` — async TTS + poll
- `ad-tool/talking-head-requested` — async Speak (waits for hero + audio)
- `ad-tool/broll-requested` — N parallel DoP generations (waits for product images)
- `ad-tool/render-requested` — invokes the Remotion render Lambda / local renderer (Phase 5)
- All write to `ad_jobs` for retry + UI status polling.

### Completion criteria — Phase 3

- Hero image generation works end-to-end. Image shows the actual avatar holding the actual product variant photo.
- Audio TTS works end-to-end. Plays back in-browser.
- Both are persisted on `ad_campaigns` and shown in the builder UI.

## Phase 4 — talking head + b-roll ⏳

### Talking head

- POST `/api/ads/campaigns/{id}/talking-head` fires `ad-tool/talking-head-requested`.
- Calls Higgsfield Speak speech2video with `input_image=hero_image_url`, `input_audio=audio_url`, `prompt=script_text`, `duration` matched to audio length (rounded to 5/10/15s per Higgsfield's allowed values).
- For **30s ads**: we chain two consecutive Speak generations (15s + 15s, joined seamlessly using the same `character_id`), or render with `duration=15` and intercut more b-roll. Default for 30s ads is talk-broll-talk-broll-CTA pattern, so the talking-head segment is actually ~18s of net spoken content split into 2-3 clips, NOT a single 30s clip. Higgsfield Speak max is 15s per generation per its API; the renderer in Phase 5 handles the stitching.
- For **15s ads**: single Speak generation at duration=15.
- Polls until complete. Writes `ad_videos.talking_head_url` (or `talking_head_segments_url[]` for multi-clip).

### B-roll

- B-roll source images: per-product, we pull 3-4 high-res images from [[../tables/product_media]] (lifestyle shots first, packshots second). If a product has < 3 images, the builder warns + allows manual upload.
- For each source image, call Higgsfield DoP with a randomized `motion_id` (panning, zoom, parallax) — keep clips visually different so the cut feels like b-roll, not slideshow.
- Each clip = 5s, 9 credits ($0.56). 3 clips per ad default. Configurable max.
- Writes `ad_videos.b_roll_urls` as `[{image_url, video_url, motion_id}]`.

### Completion criteria — Phase 4

- Builder shows: hero, audio waveform, talking-head preview, b-roll thumbnails. All playable inline.
- All Higgsfield job statuses surface in the UI (no silent failures).

## Phase 5 — captions + final render ⏳

### Whisper transcription

- After audio is ready, call OpenAI `audio/transcriptions` with `response_format=verbose_json` + `timestamp_granularities=["word"]` → `{ words: [{word, start, end}, ...] }`.
- Persist on `ad_videos.transcript_json`.

### Hormozi caption style spec

| Aspect | Value |
|---|---|
| Font | Anton (700 weight) — bundled with Remotion |
| Size | 96px on a 1080×1920 vertical canvas (~5% of width) |
| Color | `#FFFF00` (yellow) for default style; `#FFFFFF` for clean variant |
| Stroke | Black, 8px |
| Drop shadow | `rgba(0,0,0,0.6)` 4px y-offset |
| Words on screen | 1-3 (1 word for ≤4-letter words, 2 words for medium, never split a phrasal verb) |
| Per-word duration | exact Whisper start/end |
| Animation | Pop-in: scale 0.6 → 1.0 over 80ms with overshoot to 1.05 → 1.0 |
| Position | Vertical center, 60% down the frame |
| Color flips | Every 3-5 caption groups, alternate yellow → white for visual rhythm (configurable: off / subtle / vibe-shifts) |
| Emphasis | Detect ALL-CAPS words from script → render larger (1.3×) + always yellow |

### Pre-render validation (hard gate)

Before encoding starts, run `validateAdScript()` from Phase 0.5 one more time. If the operator edited the script post-generation to add banned soft language, the render is REJECTED with violations surfaced inline. No "are you sure" override — the gate is opinionated by design.

Then validate the composition itself:
- Hook beat (first 2s) is talking-head with **caption already on screen by frame 30** (1s @ 30fps). If captions don't land in 2s, reject.
- At least one b-roll cut in the first 8s of any ad — no 8 seconds of unbroken talking head.
- CTA caption is visible on the last 1.5 seconds with the urgency word styled brighter (auto-enforced).

### Render

`src/lib/ad-render.ts`:

- Remotion composition `<AdComposition>` with props `{talkingHeadSegments[], brollClips[], captions[], style, durationSec, vibeTags}`.
- **Cut plan per length:**
  - **15s ad** (TikTok / Reels): hook talking-head 0-3s → b-roll 3-4.5s → talking-head 4.5-9s → b-roll 9-11s (proof shot) → talking-head 11-13s → CTA caption-only over a static product shot 13-15s. 3 b-roll clips used.
  - **30s ad** (Meta feed / TikTok / Reels): hook 0-3s talking-head → b-roll 3-5s → talk segment A 5-12s → b-roll 12-15s (proof) → talk segment B 15-22s (problem agitation) → b-roll 22-26s (transformation) → CTA 26-30s. 4-5 b-roll clips used.
- B-roll selection is randomized by `motion_id` but **biased toward jarring choices** (parallax_zoom, snap_zoom, dolly_in) — not the calm pans. The `vibeTags` on the angle determine which motion presets are eligible.
- Audio track: the stitched talking-head segments' native audio. No music bed by default — silence between cuts is jarring on purpose. Operator can toggle "Add UGC ambient bed" but it's off by default for V1.
- Caption layout overrides per vibe:
  - `ugly` → captions placed in random screen quadrants per group (not always centered), with slight rotation (±3°).
  - `loud` → caption color flips MORE aggressively (every 1-2 groups instead of every 3-5), bigger font (110px instead of 96px).
  - `weird` → throw in 1-2 "wrong-word" caption typos that get corrected mid-frame as a pattern interrupt.
- Render via `@remotion/renderer` `renderMedia()` server-side (Inngest function, 5-min execution budget).
- Output: 1080×1920 MP4, ~10-20MB, uploaded to Supabase Storage `ad-tool/finals/{workspace_id}/{video_id}.mp4`.
- **Sister 15s cut** auto-renders if the operator checked the box on the builder. Same angle, same talking head, just trimmed + recaptioned. Saves a second `ad_videos` row linked to the parent via `parent_video_id`.

### Static ad output

Static = NOT just a frame extract from the video. The Phase 5 renderer also produces a dedicated static ad composition (1080×1080 for feed + 1080×1920 for stories) using the hero shot from Phase 3 + caption layout from a separate set of static templates:

- **Templates** (pickable on the builder, with the same `ugly` / `loud` / `weird` / `clinical` switch):
  1. **Shipping-label brutalist** — solid color background (turmeric / electric blue / hot pink), product offset-bottom-right, Hook in Anton Black wrapping at the top, proof anchor in a smaller "yellow highlighter" rectangle.
  2. **Scanned-receipt** — paper-texture bg, hand-drawn red arrow + circle scribble pointing at the product, hook handwritten-style, proof anchor as a "REAL CUSTOMER:" quote block with star rating.
  3. **Headline newspaper** — high-contrast B&W, "ALERT:" pretitle, hook as headline, product photo with halftone overlay, CTA at the bottom red banner.
  4. **Comparison meme** — left side "BEFORE" with strikethrough generic product, right side "AFTER" with the actual product + green checkmarks, big yes/no visual.
- Operator picks 1-3 templates per campaign. Each template gets its own render → `ad_videos.static_variants[] = [{template_slug, image_url, format: '1080x1080'|'1080x1920'}]`.
- These are real static-ad-grade compositions, not video frame grabs. Frame grabs of the video still get saved as `static_jpg_url` for thumbnail purposes.

### Library + download

- `/dashboard/ads` — grid of completed `ad_videos`, click for fullscreen player + download button.
- Download MP4 + download static JPG.

### Completion criteria — Phase 5

- A single click in the builder goes from "all parts ready" → final MP4 in Supabase Storage within ~3 minutes.
- Captions are visually Hormozi-style (1-3 words, big yellow Anton, pop-in animation, word-perfectly synced).
- A real end-to-end ad is rendered for one Superfoods product and visually reviewed.

## Phase 6 — brain docs ⏳

Per [[../project-management]]:

- New: `lifecycles/ad-render.md` — end-to-end trace of the pipeline above with "Status / open work" block.
- New: `tables/ad_avatars.md`, `tables/ad_avatar_proposals.md`, `tables/ad_campaigns.md`, `tables/ad_videos.md`, `tables/ad_jobs.md`, `tables/product_ad_angles.md`.
- New: `libraries/ad-angles.md`, `libraries/ad-validator.md`.
- Update: `tables/products.md` (new `physical_dimensions` column), `tables/product_variants.md` (new `isolated_image_url` + `physical_dimensions` columns).
- Update: `dashboard/products.md` (new dimensions + isolated-image upload surfaces).
- New: `inngest/ad-tool.md`.
- New: `integrations/higgsfield.md` — auth model, key endpoints, rate limits, gotchas.
- New: `libraries/higgsfield.md`, `libraries/ad-render.md`.
- New: `dashboard/ads.md`, `dashboard/ads__new.md`, `dashboard/ads__avatars.md`, `dashboard/settings__integrations.md` (extend existing).
- New: `recipes/create-avatar.md`, `recipes/generate-ad.md`.
- Update: README counts.

## Phase 7 — fold + delete spec ⏳

Once all six prior phases land:
- Update lifecycles/ad-render.md "Status / open work" with shipped state + recent commit hashes.
- `git rm docs/brain/specs/ad-tool.md`.

## Safety / invariants

1. **Per-workspace credentials, encrypted.** No global Higgsfield account — Phase 1's settings card is the only path to a connected workspace. AES-256-GCM via [[../libraries/crypto]].
2. **No silent NSFW.** Higgsfield jobs can return `status='nsfw'`. The UI surfaces this clearly and credits the customer (we eat the cost; failed jobs don't bill — but NSFW does bill on Higgsfield's side, so we eat ~$0.50 to admin's surprise). Show "Generation flagged — please refine prompt" with the failed job preserved on `ad_jobs`.
3. **No public buckets.** Reference photos + final MP4s live in private Supabase Storage; signed URLs only. Higgsfield needs signed-URL inputs; the signature TTL is 1h, which is more than enough for the job to read it.
4. **Cost cap per render.** Default: $10/ad max. Configurable per workspace. If estimated cost > cap (e.g. user requests 10 b-roll clips), the builder warns + requires explicit confirm.
5. **Rate cap on character creation.** Max 10 avatars per workspace. The avatar manager surfaces archive-to-replace.
6. **Inngest concurrency.** `concurrency: [{ limit: 3, key: "event.data.workspace_id" }]` on all ad-tool functions so a single workspace doesn't monopolize Higgsfield rate limits.
7. **Cron NOT in scope.** This is user-initiated only — no daily ad generation, no background regeneration. Phase 7 of [[../specs/]] (future) might add "regenerate ad on product image change."
8. **Audit log.** Every Higgsfield call writes to `ad_jobs` with full request + response. Replayable for debugging + cost-audit.

## Open questions to resolve during Phase 1

- **TTS vendor**: Higgsfield Audio (cheaper, single bill) vs ElevenLabs (clearly better voice quality). Probe Higgsfield Audio quality first; if it's "good enough" for ads, ship that; if not, default to ElevenLabs and require a separate API key.
- **Remotion runtime**: pure Inngest function (Vercel serverless 5-min budget) vs deploy a Remotion Lambda on AWS? Try Inngest first — most ads will be 15-20s @ 1080p which renders in well under 5 minutes. Fall back to Lambda if we run into limits.
- **Voice cloning later?** Higgsfield supports voice swap. Out of scope for V1.
- **Multi-language ads later?** Higgsfield Speak supports 40+ languages. Out of scope for V1.
- **Static-only path?** For Meta image ads we can skip the video pipeline entirely and just ship the Soul hero shot + caption overlay as a static image. Phase 3's hero shot IS that static image — V1 will export both formats by default.

## Completion criteria

- ⏳ Phase 0: `product_variants.isolated_image_url` upload UI works; `products.physical_dimensions` + variant-override input UI works; at least one Superfoods product has both populated end-to-end.
- ⏳ Phase 0.5: `product_ad_angles` populated for one Superfoods product with at least 12 angles spanning 2-3 LF8 slots and 4+ hook formulas; DR validator test passes; banned-words list editable in settings.
- ⏳ Phase 2: archetype proposals derived from the four-field demographic tuple (gender, age range, life stage, income bracket — see [[../lifecycles/demographic-enrichment]]) surface on `/dashboard/marketing/ads/avatars` BEFORE any photo upload happens; at least 2 proposals exist for one Superfoods product; one proposal is confirmed into a real `ad_avatars` row; the `demographic_basis` JSONB does NOT contain `health_priorities` or `buyer_type` fields.
- ⏳ Schema applied via supabase migration + apply script.
- ⏳ Higgsfield integration card on Settings → Integrations connects + saves credentials.
- ⏳ `ad_avatars` flow creates a real avatar in Higgsfield.
- ⏳ `/dashboard/marketing/ads/new` produces a hero image showing the actual avatar holding the actual product.
- ⏳ Talking-head video renders from Higgsfield Speak.
- ⏳ B-roll clips render from Higgsfield DoP.
- ⏳ Final MP4 renders in Remotion with Hormozi-style word-level captions, talking-head + b-roll cuts woven together, native audio.
- ⏳ A static JPG (one frame of the hero) ships alongside the MP4 for image-ad surfaces.
- ⏳ Brain pages written per Phase 6, spec deleted per Phase 7.
- ⏳ No workspace has `ad_tool_enabled=true` at the end of the build — flip per-workspace via SQL once Dylan reviews the first ad on /dashboard/ads.
