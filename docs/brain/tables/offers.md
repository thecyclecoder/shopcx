# `offers` — admin-layer attach-extra-items over pricing rules

One row per **(workspace, variant) offer** that attaches extra included products — physical or digital — to a variant. When that variant is added to the cart (Phase 2), the offer's included items ride along as `$0` lines. Distinct from [[pricing_rule_offers]] (dynamic renewal-price overlays): this table adds EXTRA line items, not a per-unit price override. Distinct from [[pricing_rules]]`.free_gift_variant_id` too — a rule's free gift is a single variant; an offer is a **bundle** of items, and when `overrides_pricing_rule_gifts=true` it replaces that gift for cart-build.

Phase 1 of [[../specs/offer-creator]]: the table + admin UI at `/dashboard/settings/offers` (beside pricing rules). Phase 2 will wire cart-build (`src/lib/cart-gifts.ts`) to attach the included items; Phase 3 strips them on subscription renewals when `scope='checkout_only'`; Phase 4 configures the Superfoods Starter Kit. Migration `20260925120000_create_offers.sql`. RLS: service-role write only.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | offer id (referenced by cart-build in Phase 2) |
| `workspace_id` | uuid → workspaces | cascade |
| `variant_id` | uuid → [[product_variants]] | cascade — the "anchor" variant that triggers the offer at cart-build |
| `name` | text | nullable — admin-facing label (e.g. "Starter Kit bundle") |
| `included` | jsonb | array of `{ ref_id, kind: 'physical' \| 'digital', quantity }` — see below |
| `scope` | text | `checkout_only` \| `checkout_and_renewals` (CHECK), default `checkout_only` |
| `overrides_pricing_rule_gifts` | bool | NOT NULL, default `false` — when true, replaces the pricing_rules free_gift |
| `is_active` | bool | NOT NULL, default `true` |
| `created_at` / `updated_at` | timestamptz | |

**CHECK — `included` is an array:** `offers_included_is_array` (`jsonb_typeof(included) = 'array'`) — richer per-row shape validation lives in the admin route + [[../libraries/offers]] `normalizeIncluded` (so a malformed draft is rejected at write time, not with a DB constraint that would need a migration to change).

**Indexes:** partial `(workspace_id, variant_id) WHERE is_active` — the Phase 2 cart-build lookup (`getActiveOfferForVariant`); plus `(workspace_id)` for the admin list.

## `included` shape
```jsonc
[
  { "ref_id": "…product_variants.id…", "kind": "physical", "quantity": 1 },
  { "ref_id": "…digital_goods.id…",    "kind": "digital",  "quantity": 1 }
]
```
- **physical** → `ref_id` points at [[product_variants]]`.id`. The Phase 2 cart line carries the variant's real sku, so [[integrations/amplifier]] fulfills it.
- **digital** → `ref_id` points at [[digital_goods]]`.id`. The Phase 2 cart line carries NO sku, so Amplifier's own sku filter drops it and the [[inngest/digital-goods-delivery]] Inngest function emails the asset.

## Scope
- `checkout_only` — items ship with the first (checkout) order and are **stripped from every subscription renewal** by the Phase 3 renewal builder. This is the Starter Kit shape.
- `checkout_and_renewals` — items ship with every renewal too. Use sparingly (turns the extras into recurring COGS).

## `overrides_pricing_rule_gifts`
When `true`, the Phase 2 cart-build layer skips the [[pricing_rules]]`.free_gift_variant_id` line for this variant and uses the offer's `included` list instead. When `false`, the pricing-rule free_gift still fires alongside the offer.

## SDK
[[../libraries/offers]] — typed `Offer` / `OfferIncluded` shape + `listOffersForWorkspace`, `getOffer`, `getActiveOfferForVariant`, `createOffer`, `updateOffer`, `deleteOffer`. Every read/write flows through this SDK (never raw `.from('offers').update/insert/delete` outside it).

## Admin UI
`/dashboard/settings/offers` (Phase 1, this spec). Listed on the Settings index beside Pricing Rules (Storefront & Subscriptions section). API at `/api/workspaces/[id]/offers` (list + create) and `/api/workspaces/[id]/offers/[offerId]` (patch + delete). Admin/owner role required for writes.

## Status / open work
- ✅ **Phase 1** — table + SDK + admin UI (this page).
- ✅ **Phase 2** — cart-build attaches offer items as `$0` lines, overriding pricing-rule free_gift per the flag. `ensureOfferItems` + `ensureCartAttachments` in [[../libraries/cart-gifts]] run at `/api/cart`, the checkout page, and the customize page; a digital include lands with `digital_good_id` (drives [[../inngest/digital-goods-delivery]]) and NO sku (Amplifier's sku filter drops it); a physical include lands with the anchor's variant sku (Amplifier fulfills). Verification test: `src/lib/cart-gifts.test.ts`.
- ⏳ **Phase 3** — the renewal order-build path detects renewal vs first order and strips offer-sourced lines when `scope='checkout_only'`. The `offer_source_variant_id` field written by Phase 2 is the signal.
- ⏳ **Phase 4** — wire the Superfoods Starter Kit variant + `$10` auto-coupon + offer (frother + mug + e-guide).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
