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

## Adopters (Phase 2 — separate PR)

Every enumeration point that spends on or generates advertising must call the helper:

- [[../inngest/playbook-compiler]] + the builder-worker dr-content lane (Carrie)
- [[../inngest/ad-creative-cadence]] + [[../libraries/creative-agent]] `src/lib/ads/creative-agent.ts` product-enumeration (Dahlia)
- product angle / research generation so attachment SKUs never get angles
- the media-buyer product fan-out (composes with [[../specs/media-buyer-product-scoped-test-rail]])

Direct `.eq("is_advertised", true)` at call sites is discouraged — call the helper so the gate stays a single-owner surface.

## Tests

- `src/lib/advertised-products.test.ts` (`npm run test:advertised-products`) — asserts
  `listAdvertisedProductIds` returns only true-flagged ids in the workspace, `isAdvertisedProduct`
  is false for an attachment id and a missing id, true for a hero id.

---

[[../README]] · [[../../CLAUDE]]
