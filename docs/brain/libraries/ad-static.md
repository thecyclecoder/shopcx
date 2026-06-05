# `src/lib/ad-static.ts` — static-ad resolvers + design data

Hydrates product intelligence into the three static-ad archetypes and builds the props the Remotion still templates (`remotion/StaticAds.tsx`) consume. The data half of the static process — see [[../lifecycles/ad-static]].

## Exports

| Export | Notes |
|---|---|
| `STATIC_ARCHETYPES` / `StaticArchetype` | `review` \| `offer` \| `benefit_authority` |
| `DEFAULT_BRAND` / `Brand` | palette (bg/fg/accent/accentFg/muted). **Edit here for brand restyle.** |
| `loadStaticInputs(productId)` | DB: best featured 5★ `product_reviews`, `product_page_content.endorsements` (nutritionist + creds), `product_benefit_selections` / benefit_bar, product isolated image. → `StaticInputs`. |
| `buildReviewProps(inp, brand?, index?)` | PURE → review-card props (reviewer, rating, quote, verified, product image). |
| `buildOfferProps(inp, brand?, offer?, backdropUrl?)` | PURE → offer props (discount/subline/urgency/CTA defaults overridable; optional NBP backdrop). |
| `buildBenefitAuthorityProps(inp, brand?, prefer?)` | PURE → authority (endorsement) or benefits mode. |

Prop interfaces (`ReviewProps`/`OfferProps`/`BenefitAuthorityProps`) are mirrored inline in `remotion/StaticAds.tsx` (kept separate so the Remotion bundle never imports server code).

## Callers

- `src/lib/inngest/ad-tool.ts` — `adToolStaticRequested` (resolve → render per format).

## Related

[[../lifecycles/ad-static]] · [[ad-render]] (`renderStillCompositionTo`) · [[ad-storage]] · [[../inngest/ad-tool]] · [[../integrations/remotion-lambda]]
