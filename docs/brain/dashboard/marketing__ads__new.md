# Dashboard · marketing/ads/new

The ad builder wizard. Walks the operator through **product → avatar** → angle → length → script → voice → hero/audio, then kicks off the async generation pipeline. **Product is picked first** because the avatar is generated from THAT product's buyer demographics, not overall demographics. See the full trace in [[../lifecycles/ad-render]].

**Route:** `/dashboard/marketing/ads/new`

## Features

**Page title:** New ad

**Wizard steps:**
1. **Product + variant picker** — search [[../tables/products]]; pick a variant. **First step** — the avatar is built from this product's buyers.
2. **Avatar picker** — gated on a product being selected. Offers BOTH paths: (a) pick an existing avatar (radio cards from [[../tables/ad_avatars]]), or (b) **"generate a new avatar from this product's buyers"** — links to `/dashboard/marketing/ads/avatars/new?productId={selected}`, which pre-fills the gender/age dropdowns from that product's dominant demographic archetype (via `GET /api/ads/avatars/archetypes`). Product-specific, not overall demographics.
3. **Angle picker** — cards from [[../tables/product_ad_angles]] (hook slug, LF8 badge, `hook_one_liner`, `proof_anchor`, vibe chips). "Generate fresh angles" calls the Phase 0.5 generator.
4. **Length** — 15s / 30s (optionally also produce the 15s cut).
5. **Script editor** — auto-populated from the angle; live-validated against the DR validator ([[../libraries/ad-validator]]); "Regenerate" re-runs with a new seed.
6. **Voice picker** — TTS voices.
7. **Hero + audio** — generate the avatar-holding-product hero, then audio.

**Hard block:** the **Generate hero** step refuses to run if the chosen variant lacks `isolated_image_url` — it links to `/dashboard/storefront/products/{product_id}` to upload one first. Phase 0 is non-optional.

**Rendering:** `"use client"` component (client-side state + fetch).

## API endpoints called

- `GET /api/ads/avatars` — avatar picker
- `GET /api/workspaces/{id}/products` — product/variant picker
- `GET /api/ads/angles?productId=…` — angle picker
- `POST /api/ads/angles` — generate fresh angles
- `POST /api/ads/campaigns` — create the campaign (and kick off hero)
- `POST /api/ads/validate` — live DR-validate the edited script
- `PATCH /api/ads/campaigns/{id}` — save script / voice / length edits
- `POST /api/ads/campaigns/{id}/hero` — fire `ad-tool/hero-requested`
- `POST /api/ads/campaigns/{id}/audio` — fire `ad-tool/audio-requested`
- `POST /api/ads/campaigns/{id}/talking-head` — fire `ad-tool/talking-head-requested`
- `POST /api/ads/campaigns/{id}/render` — fire `ad-tool/render-requested` (4 formats)

## Permissions

Owner / admin.

## Files touched

- `src/app/dashboard/marketing/ads/new/page.tsx` — the builder

## Related

[[../lifecycles/ad-render]] · [[../tables/ad_campaigns]] · [[../tables/product_ad_angles]] · [[../tables/ad_avatars]] · [[../libraries/ad-validator]] · [[../inngest/ad-tool]] · [[marketing__ads]]

---

[[../README]] · [[../../CLAUDE]]
