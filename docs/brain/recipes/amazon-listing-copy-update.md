# Recipe: update Amazon listing copy (`amazon-listing-copy-update`)

Rewrite the **title / bullet points / description** of an Amazon listing via the SP-API **Listings Items API** — the path used to strip prohibited disease/detox/weight-loss claims after an Amazon policy enforcement (e.g. the CEO's July 2026 "Detox Cleanse" takedown of ASIN B08C1R4HG3 and the catalog-wide sweep that followed).

The [[../libraries/amazon__auth]] `spApiRequest(connectionId, marketplaceId, method, path, body?)` helper is a **generic** SP-API caller — it already carries the LWA `Bearer` + `x-amz-access-token` headers and handles 429 retries — so no new library is needed for writes. This recipe is the PATCH shape + the identifiers you must resolve first.

## Prereqs / identifiers

The Listings Items API keys on **seller SKU**, not ASIN. Resolve everything from our tables:

| Need | Source |
|---|---|
| `connectionId`, `seller_id`, `marketplace_id` | [[../tables/amazon_connections]] (Superfoods: `is_active=true`, marketplace `ATVPDKIKX0DER` = US) |
| `sku` for an ASIN | [[../tables/amazon_asins]] `.select("sku, amazon_connection_id").eq("asin", ASIN)` — populated by [[../inngest/amazon-sync]] `amazon-sync-asins` from `GET_MERCHANT_LISTINGS_ALL_DATA` |
| `productType` (required in the PATCH body) | `GET /listings/2021-08-01/items/{sellerId}/{sku}?includedData=summaries` → `summaries[0].productType` (e.g. `NUTRITIONAL_SUPPLEMENT`, `COFFEE`, `NON_DAIRY_CREAM`) — **fetch it live per SKU; don't hardcode** |

Superfoods workspace id: `fdc11e10-b89f-4989-8b73-ed6526c4d906`.

## Read the current copy first

```ts
const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`
  + `?marketplaceIds=${MKT}&includedData=summaries,attributes,issues,offers`;
const res = await spApiRequest(connectionId, MKT, "GET", path);
const j = await res.json();
const title   = j.attributes.item_name?.[0]?.value;
const bullets = (j.attributes.bullet_point || []).map((b) => b.value);
const desc    = j.attributes.product_description?.[0]?.value;
```

## PATCH the copy

`PATCH /listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds={MKT}` with a JSON-Patch-style body. Only include the fields you're changing (omit `product_description` if the listing has none):

```ts
const enUS = (value: string) => ({ value, language_tag: "en_US", marketplace_id: MKT });
const res = await spApiRequest(connectionId, MKT, "PATCH",
  `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?marketplaceIds=${MKT}`,
  {
    productType,                              // from summaries[0].productType
    patches: [
      { op: "replace", path: "/attributes/item_name",           value: [enUS(newTitle)] },
      { op: "replace", path: "/attributes/bullet_point",        value: newBullets.map(enUS) },
      { op: "replace", path: "/attributes/product_description", value: [enUS(newDesc)] },
    ],
  },
);
const body = await res.json();
// → { sku, status: "ACCEPTED", submissionId: "…", issues: [] }
```

`status: "ACCEPTED"` with `issues: []` means the submission passed validation and is queued. **Save the `submissionId`** — it's the reference for the Seller Central reinstatement appeal.

## Reference scripts (this session, `scripts/_*.ts`)

- `_probe-amazon-listing.ts <ASIN>` — resolve connection + SKU and dump the live listing JSON.
- `_dump-amazon-copy.ts <ASIN...>` — print title/bullets/description for one or more ASINs (to rewrite accurately: flavor, pack count, per-variant ingredient list).
- `_audit-amazon-listings.ts` — scan **every active** mapped ASIN's copy against prohibited dietary-supplement claim patterns (HIGH = detox/cleanse/toxin/flush/cure/treat/prevent/disease; MED = weight-loss/metabolism/bloat/skin/immunity/fat-burn; LOW = energy/gut-health borderline). Read-only.
- `_push-amazon-batch.ts` — batch PATCH: `{ asin, title, bullets, description? }[]`, fetches `productType` per SKU, reports `ACCEPTED`/issues + `submissionId`.

## Gotchas

- **SKU, not ASIN.** The Listings API 404s on an ASIN. Map through [[../tables/amazon_asins]] first.
- **`productType` is required and per-SKU.** Fetch it from `summaries` at run time — the same family mixes types (tabs = `NUTRITIONAL_SUPPLEMENT`, coffee = `COFFEE`, creamer = `NON_DAIRY_CREAM`).
- **`summaries.itemName` lags the write.** After a PATCH, `attributes.item_name` reflects the new value immediately, but `summaries.itemName` (the search/display index) can lag several minutes. Verify against `attributes.*`, not `summaries.*`. Re-run `_audit-amazon-listings.ts` to confirm.
- **The FDA disclaimer is a false-positive magnet.** The compliant bullet "…not intended to diagnose, **treat**, **cure**, or **prevent** any disease…" trips a naive treat/cure/prevent scan. That sentence is REQUIRED, not a violation — keep it; don't count it.
- **Variation parent + inactive children carry their own copy.** A fix on a child SKU does NOT clean the variation parent's title (its own `item_name` contribution) or sibling variants — audit + patch the whole family. Inactive/empty children may accept a fresh title contribution (Amazon took ours), but their catalog display can still inherit — verify per SKU.
- **Write scope.** The PATCH needs the app's LWA token to carry the **Product Listing** role. A missing role returns 403 — if so, grant it in the SP-API app authorization; it's not a code bug.
- **Copy is compliance-sensitive + public-facing.** Draft the rewrite, get founder sign-off on the exact new strings, THEN push (CEO owns brand voice + which claims to keep). Removing claims is low-risk/reversible; adding them is not. See [[../operational-rules]] § North star (supervisable autonomy) and [[../customer-voice]].
- **Not reachable via SP-API:** on-package label claims and browse-node keywords (e.g. `item_type_keyword: detox-and-cleanse-weight-loss-products`). Amazon warns on-label disease claims can block reinstatement regardless of the detail-page copy — that's a packaging decision, escalate to the founder.

## Related

[[../libraries/amazon__auth]] · [[../tables/amazon_connections]] · [[../tables/amazon_asins]] · [[../inngest/amazon-sync]] · [[../integrations/shopify]] (sunsetting origin; Amazon is a first-class channel) · [[../operational-rules]]
