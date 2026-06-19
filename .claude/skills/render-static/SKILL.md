---
name: render-static
description: Use to render or restyle ShopCX static ads — the design-led Remotion still templates (legacy review/offer/benefit_authority + the cold-50+ "killer" archetypes advertorial/testimonial/authority/big_claim/before_after) rendered across 1:1 / 4:5 / 9:16. The genre of the 8 scripts/render-*.ts. Edit a remotion/Static*.tsx template, render local samples, then redeploy the Lambda site. Triggered by "render a static ad", "restyle the {archetype} static", or iterating on a Remotion still template.
---

# render-static

Static ads are single, design-led, scroll-stopping **stills** — not frozen video frames. A separate process from the video pipeline ([[generate-ad]]): no talking head, b-roll, music, captions, or timeline. Each archetype is a precise Remotion **still** template (brand palette + fonts, stars/badges/cards) populated from product intelligence, rendered across **1:1 / 4:5 / 9:16**. Full narrative in docs/brain/lifecycles/ad-static.md.

The production path is UI-driven (`POST /api/ads/campaigns/[id]/static {archetype}` → Inngest → Lambda → `ad_videos`). This skill is for the **other** path: iterating on a template's *design* and rendering local sample images to eyeball before you redeploy — the genre of the 8 `scripts/render-*.ts`.

## Where the pieces live

| Piece | File |
|---|---|
| Legacy archetype templates (`StaticReview`/`StaticOffer`/`StaticBenefitAuthority`) | `remotion/StaticAds.tsx` |
| Cold-50+ killer templates | `remotion/StaticAdvertorial.tsx` (Playfair serif — must NOT look branded) + `remotion/StaticArchetypes.tsx` (Montserrat) |
| Brand palette (`DEFAULT_BRAND`) + legacy prop resolvers (`loadStaticInputs` / `build*Props`) | `src/lib/ad-static.ts` |
| Killer asset loaders + builders (`loadKillerAssets` / `buildKillerStatic`) + Opus copy | `src/lib/ad-statics.ts` + `src/lib/ad-statics-copy.ts` |
| Composition registry | `remotion/index.ts` (the bundle entrypoint) / `remotion/Root.tsx` |
| Lambda render helper used in prod | `renderStillCompositionTo` in `src/lib/ad-render.ts` |

## Procedure

1. **Edit the template** (the *visual design* is the only thing that should change here — the pipeline + data are done). Touch a `remotion/Static*.tsx` component and/or the `DEFAULT_BRAND` palette in `src/lib/ad-static.ts`. No migration, no API change.
2. **Render local samples** to eyeball the look. The repeatable shape (see `scripts/render-statics-deck.ts`, `render-advertorial-*.ts`, `render-bigclaim-options.ts`):
   ```ts
   const serveUrl = await bundle({ entryPoint: path.resolve(process.cwd(), "remotion/index.ts") });
   const composition = await selectComposition({ serveUrl, id: "StaticTestimonial", inputProps: props });
   await renderStill({ composition, serveUrl, output: "/tmp/static-….png", inputProps: props, frame: 0, overwrite: true });
   ```
   Render every archetype in **both 4:5 + 9:16** (9:16 carries Meta safe-zone insets — `safeTopPct`/`safeBottomPct`); the killer set is designed for both.
3. **Reuse generated imagery — never re-spend.** Faces/before-shots come from Nano Banana Pro (`gemini-3-pro-image`); the `ensure(key, …)` reuse-if-present pattern signs an existing `ad-tool` storage object before generating a new one. Authority + before/after pull **real** `product_media` assets (no generation).
4. **Redeploy the Lambda site** once the design is approved: `npx tsx scripts/deploy-remotion-lambda.ts` (see [[deploy]] § Remotion site deploy). Lambda renders the *deployed* bundle — skip this and prod renders the stale template. The script does function + site; re-running is safe and idempotent.

## Guardrails

- **NEVER product-on-white.** Use the isolated (transparent-bg) cutout only — `product_variants.isolated_image_url`. Product-on-white reads as a catalog shot, not an ad.
- **SafeImg, fresh signed URLs.** Templates use `<SafeImg>` (a Remotion `<Img>` that hides on load error instead of crashing the still — Lambda hard-fails on "Error loading image"). Pass freshly-signed `ad-tool` URLs (≥1h TTL).
- **Trust-first for cold 50+.** Loud/brutalist reads as spam to older buyers — the killer archetypes are deliberately editorial; the advertorial (Playfair serif) must **not** look branded.
- **Review counts = real + 10,000**, never invented; claims trace to PI (real review/endorsement text for testimonial/authority).
- **Edit `remotion/` ⇒ redeploy the site.** The #1 "my change didn't show up" cause — same failure mode as [[build-portals]] for portals.
- **Local renders only here.** Rendering a sample to `/tmp` needs Gemini creds (for any generation) but writes nothing customer-facing; the gated step is the Lambda redeploy + any publish, not the sample render.

## Related
`scripts/render-statics-deck.ts` · `scripts/render-advertorial-*.ts` · `scripts/render-bigclaim-options.ts` · `scripts/render-ingredient-breakdown.ts` · `scripts/deploy-remotion-lambda.ts` · docs/brain/lifecycles/ad-static.md · docs/brain/libraries/ad-static.md · docs/brain/libraries/ad-statics.md · docs/brain/integrations/remotion-lambda.md · skills: `generate-ad`, `deploy`, `build-portals`
