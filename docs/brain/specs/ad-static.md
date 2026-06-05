# Spec: static ads — a separate, design-led process

**Status:** ⏳ planned · **Owner:** Dylan · **Run with:** `/goal do everything in docs/brain/specs/ad-static.md`

## Why

A static ad is **not** a frozen video frame — it's a single scroll-stopping unit that lands the whole message in one look. It needs different inputs, layouts, and a different render than the video pipeline. Today the only "static" output is `AdStatic` (one brutalist shipping-label template, rendered as a frame alongside video) — that's wrong. Static gets its **own process, its own design-led templates, and its own render**, decoupled from the talking-head/b-roll/timeline machinery.

Scope (Dylan's choices): three **designed-template** archetypes — **review screenshot · offer card · benefit-stack/authority** — with a **hybrid** visual engine (Remotion-designed templates for precise on-brand layout + data; Nano Banana Pro only as an optional image backdrop). Native/UGC AI-image archetype is a later addition.

## Background (reuse, don't rebuild)

- Static ads attach to an existing **campaign** (reuse its product / angle / brand / hero / reviews) — no script/talking-head needed. Generated per **archetype × format** (1:1, 4:5, 9:16).
- Outputs persist as `ad_videos` rows (`media_kind='static'`, `static_jpg_url`, `meta.archetype` + `meta.copy`) so they show in the creative library + re-sign like video.
- Render runs on **Remotion Lambda** (`renderStillOnLambda`) — see [[../integrations/remotion-lambda]] — but the still path currently fails (see Phase 1).
- Copy comes from **product intelligence** (reviews/themes, offer, lead benefits, ingredient callouts, nutritionist endorsements + credentials) — the same sources the angle/script system uses.

## Phases

### Phase 1 — Fix static rendering on Lambda ⏳
`renderStillOnLambda` (AdStatic) fails: *"Error loading image with src: …supabase.co/…signed…"* — Remotion's `<Img>` can't fetch/decode the hero's signed URL inside the `delayRender` window on Lambda.
- Pass images to still templates as **public or long-TTL** URLs (or proxy through a public CDN path); add `<Img>` with explicit `pauseWhenLoading` + a generous `delayRender` timeout; preload via `prefetch`/`staticFile` where possible.
- **Acceptance:** a still renders on Lambda end-to-end and serves HTTP 200.

### Phase 2 — Copy + data resolvers ⏳
Pure functions (testable) that turn a campaign/product into each archetype's content:
- `resolveReviewAd(product)` → best real review(s): quote, reviewer name, ★ rating, count (from review themes / product intelligence).
- `resolveOfferAd(product, workspace)` → offer line (e.g. "40% OFF + FREE SHIPPING"), product title, isolated/hero image, urgency.
- `resolveBenefitAuthorityAd(product)` → either 3-5 lead benefits (+ ingredient callouts) OR a nutritionist endorsement quote + credentials (from the content section).
- All editable in the builder before render.
- **Acceptance:** resolvers return populated, on-brand copy for Amazing Coffee with no placeholders.

### Phase 3 — Three designed Remotion still templates ⏳
A small **design system** (brand fonts/colors, star glyphs, badges, rounded cards, shadows) + one composition per archetype, each laid out for 1:1 / 4:5 / 9:16:
- **`StaticReview`** — looks like a real 5★ review / testimonial card (Google-review or iMessage aesthetic): avatar, name, stars, quote, subtle product thumbnail. Social-proof first.
- **`StaticOffer`** — bold promo: big offer number, product hero, urgency, CTA chip, brand. High contrast, thumb-stopping.
- **`StaticBenefitAuthority`** — clean editorial: product + numbered benefits with ingredient icons, OR the nutritionist quote + credential line + headshot. Authority/credibility first.
- Registered in `remotion/Root.tsx`; **must look clearly designed, not like a video frame.**
- **Acceptance:** all three render on Lambda at all 3 formats, on-brand, legible in feed.

### Phase 4 — Hybrid image base (optional backdrops) ⏳
- Default visual = real product photo / isolated image / hero.
- Where a scene helps (e.g. offer card lifestyle backdrop), allow a **Nano Banana Pro** generated image as the template's background layer; Remotion overlays the precise text. Toggle per archetype.
- **Acceptance:** offer card can render with an NBP backdrop + crisp overlaid text.

### Phase 5 — Static-ad builder (separate process) ⏳
- New section/flow distinct from the video builder: pick campaign/product → pick archetype(s) → auto-filled editable copy (Phase 2) → optional image choice → **Generate static ads** → 3 formats each.
- API `POST /api/ads/campaigns/[id]/static {archetype, copy?, imageMode?}` → Inngest `ad-tool/static-requested` → `renderStillOnLambda` per format → `ad_videos` rows. Independent of `render-requested` (video).
- Show results in the campaign page (its own "Static ads" area, by archetype) with download + regenerate per archetype.
- **Acceptance:** operator generates all three archetypes from the dashboard; stills land ready with working URLs.

### Phase 6 — Brain docs + fold ⏳
- New [[../lifecycles/ad-static]] (the static process end-to-end) + library page for the templates/resolvers; update [[../inngest/ad-tool]], [[../integrations/remotion-lambda]], [[../tables/ad_videos]] (static meta shape). Delete this spec.

## Decisions / notes
- **Separate from video**: no talking head, b-roll, music, captions, or timeline. Different Inngest event, different compositions, different builder entry.
- **Designed-first**: precision + brand + real data beat AI for review/offer/benefit. NBP is a backdrop, not the whole ad (for these three).
- **Formats**: 1:1 (feed), 4:5 (feed, more real estate), 9:16 (stories). 
- Native/UGC AI-image archetype intentionally deferred.

## Definition of done
From the dashboard, an operator generates review / offer / benefit-authority static ads for a product — each a distinct, clearly-designed, on-brand image rendered on Lambda across 1:1/4:5/9:16, populated from real product data. Brain updated; spec folded + deleted.
