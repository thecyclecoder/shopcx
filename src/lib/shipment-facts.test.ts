/**
 * Pins the shipment fact pack contract:
 *   - live tracker read produces days_since_last_scan from the LATEST event's
 *     datetime (never the ship date), plus estimated-delivery presence.
 *   - a failed live read falls back to the cached easypost_* columns AND
 *     labels them as cached with age (never as current).
 *   - one `lookupTracking` call per distinct tracking number per session
 *     (metered-call discipline; deduped across repeated reads).
 *
 * Ticket 8e2c87d6 (Suzanne Ross, 2026-08-24) is the derived-from case: cached
 * status "in_transit" at a Nevada facility while the last real scan was
 * eleven days old.
 *
 * Run: npx tsx --test src/lib/shipment-facts.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createShipmentFactPackReader,
  formatShipmentFactForBrief,
  STALL_THRESHOLD_DAYS,
  isShipmentDark,
} from "./shipment-facts";
import type { TrackingStatus } from "./easypost";

const FIXED_NOW = new Date("2026-08-24T12:00:00.000Z");

function fakeTracking(overrides: Partial<TrackingStatus> = {}): TrackingStatus {
  return {
    status: "in_transit",
    estimatedDelivery: null,
    events: [
      {
        status: "pre_transit",
        message: "Shipping label created, USPS awaiting item",
        datetime: "2026-08-10T06:00:00Z",
      },
      {
        status: "in_transit",
        message: "In Transit to Next Facility",
        datetime: "2026-08-13T00:00:00Z",
        city: "Reno",
        state: "NV",
      },
    ],
    ...overrides,
  };
}

test("live read: days_since_last_scan is from the LATEST event, not the ship date", async () => {
  let calls = 0;
  const reader = createShipmentFactPackReader("ws", {
    now: () => FIXED_NOW,
    lookupTracking: async () => {
      calls += 1;
      return fakeTracking();
    },
  });
  const pack = await reader.read({ tracking_number: "9400111899560000000001", carrier: "USPS" });
  assert.equal(pack.source, "live");
  if (pack.source !== "live") return;
  assert.equal(pack.status, "in_transit");
  // Suzanne case: 2026-08-13 → 2026-08-24 = 11 days, NOT the 14-day distance from the pre_transit event.
  assert.equal(pack.days_since_last_scan, 11);
  assert.equal(pack.last_scan_at, "2026-08-13T00:00:00Z");
  assert.equal(pack.has_estimated_delivery, false);
  assert.equal(calls, 1);
});

test("live read: estimated_delivery presence is derived from the response, not from cached columns", async () => {
  const reader = createShipmentFactPackReader("ws", {
    now: () => FIXED_NOW,
    lookupTracking: async () => fakeTracking({ estimatedDelivery: "2026-08-26" }),
  });
  const pack = await reader.read({ tracking_number: "1Z999AA10123456784", carrier: "UPS" });
  assert.equal(pack.source, "live");
  if (pack.source !== "live") return;
  assert.equal(pack.has_estimated_delivery, true);
  assert.equal(pack.estimated_delivery, "2026-08-26");
});

test("dedup: repeated reads of the same tracking number hit lookupTracking exactly once", async () => {
  let calls = 0;
  const reader = createShipmentFactPackReader("ws", {
    now: () => FIXED_NOW,
    lookupTracking: async () => {
      calls += 1;
      return fakeTracking();
    },
  });
  const a = await reader.read({ tracking_number: "abc", carrier: "USPS" });
  const b = await reader.read({ tracking_number: "abc", carrier: "USPS" });
  const c = await reader.read({ tracking_number: "abc" }); // no carrier — different dedup key
  assert.equal(calls, 2);
  assert.equal(a.source, "live");
  assert.equal(b.source, "live");
  assert.equal(c.source, "live");
});

test("live read failure falls back to cached columns and labels them as cached with age", async () => {
  const reader = createShipmentFactPackReader("ws", {
    now: () => FIXED_NOW,
    lookupTracking: async () => {
      throw new Error("EasyPost 402 no funds");
    },
  });
  const pack = await reader.read({
    tracking_number: "abc",
    carrier: "USPS",
    cached: {
      status: "in_transit",
      detail: "In Transit to Next Facility",
      location: "Reno, NV",
      checked_at: "2026-08-13T00:00:00Z",
    },
  });
  assert.equal(pack.source, "cached_fallback");
  if (pack.source !== "cached_fallback") return;
  assert.equal(pack.cached_status, "in_transit");
  assert.equal(pack.cached_age_days, 11);
  assert.match(pack.reason, /EasyPost 402/);
  const formatted = formatShipmentFactForBrief("order #SC1", pack);
  assert.match(formatted, /CACHED FALLBACK/);
  assert.match(formatted, /11d ago/);
  assert.match(formatted, /NOT a current scan time/);
});

test("no tracking number → unavailable (never a live call)", async () => {
  let calls = 0;
  const reader = createShipmentFactPackReader("ws", {
    now: () => FIXED_NOW,
    lookupTracking: async () => {
      calls += 1;
      return fakeTracking();
    },
  });
  const pack = await reader.read({ tracking_number: null });
  assert.equal(pack.source, "unavailable");
  assert.equal(calls, 0);
});

test("Phase 2 stall gate: a shipment dark ≥ STALL_THRESHOLD_DAYS is 'dark'; under-threshold is not", () => {
  // Suzanne (ticket 8e2c87d6, 2026-08-24) was 11 days dark — the derived-from case for this gate.
  assert.equal(isShipmentDark(11), true, "11 days dark must trip the stall gate");
  assert.equal(isShipmentDark(STALL_THRESHOLD_DAYS), true, "boundary: exactly threshold is dark");
  assert.equal(isShipmentDark(STALL_THRESHOLD_DAYS - 1), false, "one day under threshold is NOT dark");
  assert.equal(isShipmentDark(0), false, "0 days since last scan is not dark");
});

test("Phase 2 stall gate: unknown scan age (null) does NOT trip the gate — never block on missing data", () => {
  // A missing days_since_last_scan means we could not measure — refuse to route to
  // replacement on absence of evidence. The gate fires ONLY on measured darkness.
  assert.equal(isShipmentDark(null), false);
  assert.equal(isShipmentDark(undefined), false);
});

test("Phase 2 pinned constant: STALL_THRESHOLD_DAYS is the review-in-source value referenced by the brain page", () => {
  // The spec explicitly requires a named source-level constant (not a prompt embedding),
  // and the brain page (docs/brain/lifecycles/return-pipeline.md § Dark shipment) MUST
  // state the value. If this changes, update the brain page in the same PR.
  assert.equal(STALL_THRESHOLD_DAYS, 7);
});

test("format: live read line cites days since last scan and EDD presence", async () => {
  const reader = createShipmentFactPackReader("ws", {
    now: () => FIXED_NOW,
    lookupTracking: async () => fakeTracking(),
  });
  const pack = await reader.read({ tracking_number: "abc", carrier: "USPS" });
  const line = formatShipmentFactForBrief("order #SC1", pack);
  assert.match(line, /LIVE TRACKER READ/);
  assert.match(line, /11d since last scan/);
  assert.match(line, /no estimated delivery date/);
});
