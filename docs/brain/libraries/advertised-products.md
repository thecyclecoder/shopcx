# advertised-products

The hero-product advertising gate. Single source of truth every ad / DR / creative pipeline reads
to decide whether a product is one of the 6 hero SKUs the workspace actually advertises, or an
attachment SKU that should NEVER enter the advertising pipeline.

**File:** `src/lib/advertised-products.ts`
**Spec:** [[../specs/hero-product-advertising-gate]] (Phase 1)
**Table:** [[../tables/products]] (`is_advertised` column, seeded by
`supabase/migrations/20261015000000_products_is_advertised.sql`)

## Why the gate exists

ShopCX auto-enumerates ALL products in the advertising pipelines (DR-content, Dahlia creative,
product angle/research generation, media-buyer fan-out), but only 6 SKUs are actually advertised:
Superfood Tabs, Amazing Coffee, Amazing Creamer, Ashwavana Guru Focus, Ashwavana Zen Relax,
Creatine Prime+. Every other product (Sleep Gummies, Superfoods Tumbler, Handheld Drink Mixer,
Bamboo Coffee Mug, …) is an attachment SKU. Before this gate, Carrie's DR-content lane generated
content for Tumbler + Sleep Gummies (parked + CEO-dismissed 2026-07-11) because the enumerations
had no way to tell heroes from attachments.

## Exports

| Symbol | Signature | Use |
|---|---|---|
| `listAdvertisedProductIds` | `(admin, workspaceId) => Promise<string[]>` | Filter an enumeration (e.g. Dahlia's all-products select). Empty array ⇒ workspace has no heroes flagged; advertising pipelines should no-op, NEVER fall back to "all products". |
| `isAdvertisedProduct` | `(admin, productId) => Promise<boolean>` | Gate a per-product dispatch (e.g. the DR-content lane inspecting one queued blueprint). Missing/deleted product returns false so the caller safely skips. |

## Adopters (Phase 2 — LIVE)

Every enumeration point that spends on or generates advertising calls the helper:

| Adopter | File | Call | Effect |
|---|---|---|---|
| Cleo (DR-content product selection) | `src/lib/cleo-blueprint.ts` — `listActiveProducts` | `listAdvertisedProductIds` | Only advertised products are candidates for `matchProductToTeardown` → no attachment SKU can be a teardown target → no `dr-content` job for one. This closes the parked Tumbler + Sleep-Gummies leak CEO-dismissed 2026-07-11. |
| Dahlia (cadence enumeration) | `src/lib/inngest/ad-creative-cadence.ts` — `dispatchAdCreativeCadence` | `listAdvertisedProductIds` | The angle-backed product list is intersected with the advertised set before dispatch — a stray `product_ad_angles` row on an attachment SKU never earns a Dahlia job. |
| Dahlia (all-products loop) | `src/lib/ads/creative-agent.ts` — `runAdCreativeLoop` | `listAdvertisedProductIds` (all-products branch), `isAdvertisedProduct` (per-product branch) | Same intersect on the no-productId branch; per-product jobs are gated on the single target — a stray `productId` snuck into an ad-creative job produces zero creatives. |
| Angle generation | `src/lib/ad-angles.ts` — `generateAngles` | `isAdvertisedProduct` | Gates BEFORE the Opus call — an attachment SKU angle-gen returns `{ok:false, reason:"not_advertised"}` at 0 tokens. Closes the upstream feeder to the Dahlia cadence. |

### Not-yet-gated (composed elsewhere)

- **Media-buyer product fan-out** — the current [[../inngest/media-buyer-cadence]] enumerates cohorts (`media_buyer_test_cohorts`), not products. Product-level fan-out belongs to the separate [[../specs/media-buyer-product-scoped-test-rail]] spec; when that spec builds, its product enumeration composes with this gate.

Direct `.eq("is_advertised", true)` at call sites is discouraged — call the helper so the gate stays a single-owner surface.

## Tests

- `src/lib/advertised-products.test.ts` (`npm run test:advertised-products`) — asserts
  `listAdvertisedProductIds` returns only true-flagged ids in the workspace, `isAdvertisedProduct`
  is false for an attachment id and a missing id, true for a hero id.

---

[[../README]] · [[../../CLAUDE]]
