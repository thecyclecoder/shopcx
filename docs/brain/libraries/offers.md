# offers.ts — offer-creator SDK

`src/lib/offers.ts` · typed reads/writes over the [[../tables/offers]] table. Phase 1 of [[../specs/offer-creator]]: an admin layer that attaches extra included products (physical or digital) to a variant. Every read/write goes through this SDK — never raw `.from('offers')` outside it.

## Shape

```ts
type OfferKind = "physical" | "digital";
type OfferScope = "checkout_only" | "checkout_and_renewals";

interface OfferIncluded {
  ref_id: string;    // physical → product_variants.id, digital → digital_goods.id
  kind: OfferKind;
  quantity: number;
}

interface Offer {
  id: string;
  workspace_id: string;
  variant_id: string;                    // anchor: adding this variant triggers the offer
  name: string | null;
  included: OfferIncluded[];
  scope: OfferScope;
  overrides_pricing_rule_gifts: boolean; // replace pricing_rules.free_gift when true
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
```

## Exports

- `listOffersForWorkspace(workspaceId)` — admin list (created-at desc).
- `getOffer(workspaceId, offerId)` — one offer.
- `getActiveOfferForVariant(workspaceId, variantId)` — Phase 2 cart-build lookup: the newest active offer whose anchor matches this variant.
- `createOffer(workspaceId, input)` / `updateOffer(workspaceId, offerId, patch)` / `deleteOffer(workspaceId, offerId)` — admin mutations.
- `normalizeIncluded(raw)` / `normalizeScope(raw)` — write-time shape validation (drops malformed rows so the DB's `offers_included_is_array` check never has to catch them).

## Callers

- `src/app/dashboard/settings/offers/page.tsx` — Phase 1 admin UI.
- `src/app/api/workspaces/[id]/offers/route.ts` + `.../[offerId]/route.ts` — Phase 1 API.
- Phase 2 wiring: cart-build (`src/lib/cart-gifts.ts`) calls `getActiveOfferForVariant` per anchor variant, then attaches each `included` row as a `$0` line (physical → variant sku, digital → sku-less line that triggers [[../inngest/digital-goods-delivery]]).
- Phase 3 wiring: the renewal builder calls the same helper to identify offer-sourced lines and strips them when `scope='checkout_only'`.

---

[[../README]] · [[../tables/offers]]
