# `src/lib/amazon/pack-dimensions.ts`

Resolves a product's **real printed pack size** from the Amazon catalog and lands it on
[[../tables/product_variants]] `package_{width,height,depth}_mm`, which the ad renderer reads via
[[creative-generate]] `formatPackageDimensionsClause`.

**Owner:** [[../functions/growth]] · **Why it exists:** ad renders were reproducing the Amazing
Coffee pouch visibly narrower than the physical product (CEO, 2026-08-17, ad `dcd6d536`). Nano
Banana was inferring a silhouette from a packshot; nothing ever told it the proportions. We already
held the answer — [[../tables/amazon_asins]] maps ASIN → product, and SP-API's Catalog Items API
publishes dimensions.

## Two facts about the Amazon data this module is built around

Both observed live on `B0BKR169VT` (our mapped Amazing Coffee ASIN):

1. **A mapped ASIN is often a `VARIATION_PARENT`, and parents carry NO dimensions.** You must walk
   `relationships` to the child ASINs and read theirs. A naive `getCatalogItem` on the mapped ASIN
   returns `dimensions: [{ marketplaceId }]` — present but empty, which reads as "no data" rather
   than "wrong ASIN".
2. **Children disagree, and some are self-contradictory.** `B08KYMN52M` reported ITEM dimensions
   *larger than its own PACKAGE dimensions*. Taking the first child is therefore wrong; a selection
   rule is required.

## Exports

- **`measureToMm(m)`** — one Amazon measure → mm. Handles inches / mm / cm; returns `null` for a
  missing value or an **unknown unit** rather than guessing. A wrong unit is a 25× error in the
  render prompt, so guessing is never safe.
- **`toStandingPouchMm(set)`** — one dimension set → a standing-pouch triple. **Sorts the three axes
  instead of trusting Amazon's labels**: largest = height standing up, middle = width, smallest =
  depth. Amazon measures a flat pouch lying down, so its `height` is really the gusset. Needs all
  three axes; returns `null` otherwise.
- **`isSelfContradictory(item, pkg)`** — true when the bare item measures larger than the package it
  ships in. Such a reading is dropped, not averaged in.
- **`selectConsensusDimensions(candidates, tolerancePct = 0.1)`** — pure. Groups candidates whose
  height AND width agree within tolerance, takes the largest group, and returns the per-axis median.
  A lone disagreeing child is **outvoted**, never averaged. One candidate returns itself (one
  reading beats none, and the caller records provenance). Empty → `null`, never a guess.
- **`resolvePackDimensionsForProduct(admin, workspaceId, productId)`** — read-only. Expands every
  mapped ASIN to itself + children, reads dimensions, drops contradictory readings, and returns
  `{ parentAsins, candidates, chosen, reason }`. The `reason` names the ASINs that formed the
  consensus so an audit line can cite them.
- **`persistPackDimensions(admin, workspaceId, productId, dims, { overwrite })`** — writes to every
  variant of the product. **Will not overwrite a variant that already has a width** unless
  `overwrite` is passed: a hand-measured value outranks a scraped one.

## Why product-level, not variant-level

`amazon_asins` maps ASIN → `product_id` only. That is sufficient: variants of one product share a
pouch — only the flavour differs — so a resolved size applies to all of them. If a product ever
ships genuinely different pack sizes per variant, this mapping becomes the constraint to fix first.

## Runnable

`scripts/resolve-pack-dimensions.ts` — dry-run by default over every advertised product;
`--apply` persists, `--overwrite` forces past hand-set values, `--product <uuid>` scopes to one.

## Ground truth (2026-08-17)

```
B08C47SJ5B  package  9.65 × 7.80 × 2.13 in  → 245 × 198 × 54 mm
B0BV4XY3L7  package  9.69 × 7.83 × 2.01 in  → 246 × 199 × 51 mm
B08KYMN52M  item larger than its package    → DROPPED (self-contradictory)
```

Consensus 198 × 245 × 53 mm, width:height **0.81:1**. Renders had been landing nearer 0.55–0.6 —
the "pack is too narrow" the CEO flagged. Set on all three Amazing Coffee variants the same day.

## Related

[[creative-generate]] (`formatPackageDimensionsClause` — the consumer) ·
[[product-intelligence]] (`packageDimensions`) · [[../tables/amazon_asins]] ·
[[../tables/product_variants]] · [[amazon__auth]] (`spApiRequest`) ·
[[../lifecycles/ad-creative]]
