# libraries/funnel-tree

The **single source of truth** for the rebuilt storefront funnel — one computation that powers both the Growth Director (Max) and the funnel-page card, so the number Max acts on and the number Dylan sees are identical. Replaces the per-route inline aggregation that let the funnel, the chapter table, and Max's reads silently drift.

**File:** `src/lib/storefront/funnel-tree.ts` · Reads [[../tables/storefront_events]] (funnel-step events in window) + [[../tables/storefront_sessions]] (`landing_url` first-touch + exclusion flags) + [[../tables/products]] (handle→title, the slice key) + [[../tables/advertorial_pages]] (slug→headline, **enrichment only**) + [[../tables/customers]] (`is_internal` set). Read-only — never writes. Takes UTC instants, so it runs unchanged in a Next.js route handler AND in Max's agent runtime.

## The tree (per product, variable depth)

```
Amazing Coffee                ← PRODUCT  (rollup of PDP + All Landers)
├── Product Page (bare PDP)       ← leaf
└── All Landers                   ← rollup of every variant  (PDP-vs-targeted comparison)
    ├── Advertorial                   ← VARIANT (rollup of its angles)
    │   └── {angle} …                     ← angle (leaf — atomic)
    ├── Listicle / Reasons            ← VARIANT
    └── Before/After                  ← VARIANT
```

When no product slice is applied the top level is a **forest** of product nodes; slicing to one product returns just that subtree.

## Bucketing keys (URL-param-first; locked 2026-06-30)

- **PRODUCT** ← the `products.handle` segment of `landing_url`'s path (first segment matching a known handle). Universal — resolves PDP and lander alike, first-touch. Robust to path shape (`/amazing-coffee`, `/store/superfoods/amazing-coffee`).
- **PDP vs LANDER** ← presence of the **`?variant=` param** in `landing_url`. Absent = bare PDP; present = lander. Keyed on the PARAM, **not `advertorial_page_id`** — the param captures intent and survives angle-resolution misses that would otherwise leak a lander into PDP. (Validated 2026-06-30: this also correctly flips ~14/30d cookie-/heal-stamped paid-PDP sessions back to PDP.)
- **VARIANT** ← the VALUE of `?variant=` (`reasons` → "Listicle / Reasons", `advertorial`, `beforeafter`). No join.
- **ANGLE** ← the VALUE of `?angle=` — the atomic leaf. `advertorial_pages` join (by slug) is **pure enrichment** (headline / hero_kind / page id for display), never bucketing.

## Exports

### `computeFunnelTree({ admin, workspaceId, startIso, endIso, productHandle?, utmSource? })` → `FunnelTreeResult`
`utmSource` is an optional **traffic-source slice** (a `utm_source` value, or `DIRECT_UTM` = `"(direct)"` for sessions with no source). It **composes** with `productHandle` — a session must pass both. Omit/null = All sources.
1. Pull **ALL** events in `[startIso,endIso]`, paginated → the **visit universe** (every session that fired any event = the page loaded) + the per-session reached-step set (engaged/pack/checkout/order/atc).
2. Fetch the visit-universe sessions (chunked `.in("id")`, 300/page); drop `is_internal`, `is_bot`, internal-customer-stitched — same real-traffic exclusion as the legacy funnel.
3. Bucket each session into one leaf via the keys above; **force `visit`** for every universe session, accumulate deeper-step counts from the events it fired.
4. Roll up **bottom-up by summation** (leaf session sets are mutually exclusive — first-touch), **recomputing rates at every node** from summed counts (never averaging child %).

**Visit definition:** top-of-funnel `visit` = a session that fired ANY event in the window, **not** strictly a `pdp_view` event. pdp_view's first-flush delivery drops ~17% ([[../specs/pixel-pdp-view-delivery]]), so counting it undercounts visits and inflates every downstream rate. This intentionally makes `visit` EXCEED the legacy funnel's pdp_view top line by the dropped ~17%.
- Returns `products` (forest), `unattributedEntry` (non-product landings e.g. `/checkout` — surfaced separately but **included in `grandTotal`** so it reconciles), and `grandTotal` (all sessions combined). Each node carries `FunnelNodeMetrics`: the 5 step counts + `add_to_cart`, plus `engagement_rate` (engaged/visit), `conversion_rate` (order/visit), `atc_rate`.

### `listFunnelProducts({ admin, workspaceId, startIso, endIso })` → `{ handle, title, sessions }[]`
The product slice-dropdown source: products with real sessions in the window (resolution-based, so dead SKUs never appear), ordered by volume. Dynamic + self-pruning.

### `listUtmSources({ admin, workspaceId, startIso, endIso })` → `{ source, label, sessions }[]`
The traffic-source slice-dropdown source: distinct `utm_source` values present in real sessions, ordered by volume. Sessions with no source collapse into one `DIRECT_UTM` row (label "Direct / none"). Dynamic — a new or stray source (e.g. `facebook` alongside `meta`) appears on its own, never hidden.

### `parseLanding(landingUrl)` → `{ segments, variant, angle }`
Exported helper — tolerant URL parse (absolute / relative / malformed).

## Invariants & gotchas
- **Pack-selected ↔ Checkout-started are 1:1 by design** (the customize page is optional). The 100% step is structural, not a tracking gap. `checkout_view` is the reliable "reached checkout" signal.
- **`grandTotal` intentionally exceeds the legacy `GET /api/workspaces/[id]/storefront-funnel` top line** (which counts pdp_view) by the dropped ~17% — the SDK is the corrected number. `grandTotal` self-reconciles with an independent any-event count (verified via `scripts/_probe-funnel-tree-verify.ts`); deeper steps still match the legacy event-based counts exactly.
- **No silent drops:** an unknown `variant` value gets its own visible row; a variant present without an `angle` becomes a visible `(no angle)` leaf.
- **Caller owns Central-time boundary math** (`centralBoundary`) — the SDK takes UTC instants so it stays presentation-agnostic.

## Consumers
- `GET /api/workspaces/[id]/funnel-tree` (auth + Central-time boundaries) → the funnel page's top card ("Funnel by product & concept") + the page-level universal slice filters (**Product × Source**, composing) — [[../dashboard/storefront__funnel]]. The card carries two pills (⚡ SDK-powered · ◫ Slice-aware) marking it as rebuilt onto this SDK; legacy cards on that page are NOT yet reworked (one-at-a-time migration). The route also returns `productOptions` + `utmSourceOptions` (from `listFunnelProducts` / `listUtmSources`) computed over a wide launch→today window so the slice dropdowns stay stable across date ranges.
- (planned) Max's performance-data assembly — the Growth Director reads the same tree he directs agents on.

## Related
- Fixes the same un-segmented-by-variant root issue logged in [[../specs/chapter-performance-variant-dimension]].
- Distinct from [[storefront-experiment-funnel]] (per-experiment-arm rollup, bandit-keyed) — this is the product/page-type/variant/angle hierarchy keyed on first-touch landing.
