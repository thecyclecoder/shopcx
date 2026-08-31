# libraries/shipment-facts

The shared **shipment fact pack** helper — the read-side rail every agent-facing surface goes through when it wants to claim where a shipment is or how long it has been stalled. See [[../integrations/easypost]] and [[../specs/director-shipment-claims-must-cite-a-live-tracker-read]] Phase 1.

**File:** `src/lib/shipment-facts.ts`

## Why this exists

The cached `orders.easypost_status` / `easypost_detail` / `easypost_location` columns hold the LATEST scan we saw as of the last poll — but they carry NO per-event timestamp. The only time on the row is `easypost_checked_at`, which is when WE last asked. An agent reading those columns can tell you where a package was, never how long it has been sitting there — and the difference is the entire question when a customer says a package never arrived.

Derived-from ticket **8e2c87d6** (Suzanne Ross, 2026-08-24): cached row said `in_transit` at a Nevada facility → the orchestrator told the customer to wait a few more days → the live tracker read showed the last scan was **eleven days old with no estimated delivery date**. The founder caught a second instance in the same sweep where a stall duration was inferred from `amplifier_shipped_at` (the handoff date, not the last carrier scan) and the figure was wrong by three days.

## Exports

### `createShipmentFactPackReader` — function

```ts
function createShipmentFactPackReader(
  workspaceId: string,
  opts?: {
    now?: () => Date;
    lookupTracking?: (trackingNumber: string, carrier: string | undefined) => Promise<TrackingStatus>;
  },
): ShipmentFactPackReader
```

Returns a scoped reader that dedupes by `(tracking_number, carrier)` — one metered `lookupTracking` call per distinct tracking number per session (metered-call discipline: never a loop over an order list).

### `formatShipmentFactForBrief` — function

```ts
function formatShipmentFactForBrief(label: string, pack: ShipmentFactPack): string
```

Plain-text one-liner for the CS Director brief and any other agent-facing surface. Live packs cite `days_since_last_scan` + last scan datetime + EDD presence; cached fallbacks are LABELED cached with age; unavailable packs say so.

### `ShipmentFactPack` — discriminated union

- `source: 'live'` — real `lookupTracking` result: ordered `events[]` with real `datetime`, `last_scan_at`, `days_since_last_scan` (derived from the LATEST event, never the ship date), `status`, `estimated_delivery`, `has_estimated_delivery`.
- `source: 'cached_fallback'` — live call failed; carries the cached column values PLUS `checked_at` and `cached_age_days` so the renderer never presents cached data as current. `reason` carries the live-call error.
- `source: 'unavailable'` — no tracking number to look up; `reason` explains.

## Rules the helper enforces

- **Live-first.** Every read attempts a `lookupTracking` call first. Cached columns are consulted only when the live call throws.
- **Never infer stall from ship date.** `days_since_last_scan` is the CARRIER's last-scan datetime minus `now`. `amplifier_shipped_at` (the handoff date) is off-limits for this claim.
- **Labeled fallback.** A `cached_fallback` pack rendered via `formatShipmentFactForBrief` cites `last polled` (not `last scanned`) and the age, so an agent reading it never mistakes cached data for a current scan.
- **Metered.** Repeated reads of the same tracking number within one session hit `lookupTracking` exactly once (per-session cache keyed by `tracking_number|carrier`).

## Callers

- `scripts/builder-worker.ts` `loadCsDirectorCallBrief` — the **LIVE SHIPMENT FACT PACKS** section of the CS Director brief.
- `src/lib/workflow-executor.ts` `executeOrderTracking` — the order-tracking workflow's EasyPost tier; replaces the inline `lookupTracking` call so internal notes cite the live scan age (and cleanly label cached fallbacks on live failure).

## Tests

`src/lib/shipment-facts.test.ts` pins:
- `days_since_last_scan` is derived from the LATEST tracker event's `datetime`, NOT from the ship date.
- `estimated_delivery` presence comes from the response, not from cached columns.
- Repeated reads dedup to one live call per `(tracking, carrier)`.
- Live-read failure yields a `cached_fallback` pack that `formatShipmentFactForBrief` labels with age.
- No tracking number → `unavailable` with no live call.

## Related

[[../integrations/easypost]] · [[cs-director]] · [[../specs/director-shipment-claims-must-cite-a-live-tracker-read]]

---

[[../README]] · [[../../CLAUDE]]
