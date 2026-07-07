# libraries/utm

Shared UTM helpers for the **Meta ad-source family**. Meta itself stamps
`facebook` or `fb` or `ig` on many click destinations, our publish path stamps
`meta`, operators occasionally paste `instagram` — the attribution sensor and
its callers must READ the whole family, or the per-creative ROAS signal dies.
Non-destructive: the stored `utm_source` / `attributed_utm_source` value is
untouched — this is read-side widening only.

**File:** `src/lib/utm.ts`

## Exports

### `isMetaUtm` — function

```ts
function isMetaUtm(src: string | null | undefined): boolean
```

True when `src` names any member of the Meta ad family (case-insensitive):
`meta*`, `*facebook*`, `*instagram*`, `fb`, `ig`. Used by in-memory filters
after a fetch (see [[shopify-internal-revenue]]).

### `metaFamilyOr` — function

```ts
function metaFamilyOr(column: string): string
```

Returns the argument for a PostgREST `.or()` call that matches the Meta family
on `column`, case-insensitive. Drop-in for a hardcoded `.eq(column, 'meta')`:

```ts
admin.from("orders").select("…").or(metaFamilyOr("attributed_utm_source"))
```

PostgREST has no case-insensitive `eq`, so the short members `fb` / `ig` are
matched with an anchored `ilike` (no wildcards). That mirrors `isMetaUtm('FB')`
returning true after lowercasing, but at the DB layer.

## Callers

- [[meta__attribution]] — `computeVariantAttribution` sessions weight query,
  orders query, and first-touch session query all filter with `metaFamilyOr(…)`.
- [[shopify-internal-revenue]] — `getShopifyInternalNonRenewalRevenue` in-memory
  `metaOnlyUtm` filter uses `isMetaUtm(…)`.

## Gotchas

- **Read-side only.** The stored raw source value is untouched (this is a
  widening of what we READ, not a rewrite of what we WRITE). A `utm_source` of
  `fb` stays `fb` — nothing normalizes it to `meta`.
- **Spend is still conserved.** Widening the read only pulls more rows INTO the
  bucketed attribution; the `(unresolved)` sink is unchanged, so spend
  conservation and ROAS semantics are the same.

---

[[../README]] · [[../../CLAUDE]]
