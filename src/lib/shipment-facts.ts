/**
 * Shared shipment fact pack — the read-side rail every agent-facing surface goes
 * through when it wants to claim where a shipment is or how long it has been
 * stalled. Phase 1 of the "director shipment claims must cite a live tracker
 * read" spec (owner cs).
 *
 * The wedge: the cached `orders.easypost_*` columns hold the LATEST scan we saw
 * as of the last poll, but they carry NO per-event timestamp — only
 * `easypost_checked_at`, which is when WE last asked. An agent reading those
 * columns can tell you where a package was, never how long it has been sitting
 * there. On ticket 8e2c87d6 (Suzanne Ross, 2026-08-24) that exact gap turned
 * into a customer-facing "still in transit, wait a few more days" on a shipment
 * nothing had scanned in eleven days.
 *
 * This module returns a computed pack from a LIVE call to `lookupTracking`
 * (`src/lib/easypost.ts:452`): ordered events with real datetime, last scan
 * timestamp, derived days since that scan, live status, and whether an
 * estimated-delivery date is present. When the live call fails the reader
 * falls back to the cached columns and clearly LABELS the values as cached
 * with their `easypost_checked_at` age, so downstream renderers never present
 * cached data as current.
 *
 * Metered-call discipline: `createShipmentFactPackReader` returns a scoped
 * reader that dedupes by (tracking_number, carrier) — one live call per
 * distinct tracking number per brief, never a loop over an order list.
 */

import type { TrackingStatus } from "@/lib/easypost";
import { errText } from "@/lib/error-text";

/** One tracker event, normalized (city+state joined into a single `location`). */
export interface ShipmentEvent {
  status: string;
  message: string;
  datetime: string;
  location: string | null;
}

/** Live tracker read succeeded — the source of truth for every stall claim. */
export interface ShipmentFactPackLive {
  source: "live";
  tracking_number: string;
  carrier: string | null;
  status: string;
  events: ShipmentEvent[];
  /** ISO datetime of the most recent tracker event, or null if there are no events yet. */
  last_scan_at: string | null;
  /** Whole days between the most recent event's datetime and `now`; null when no events exist. */
  days_since_last_scan: number | null;
  estimated_delivery: string | null;
  has_estimated_delivery: boolean;
}

/** Live tracker read failed; downstream MUST label cached values as cached with their age. */
export interface ShipmentFactPackCachedFallback {
  source: "cached_fallback";
  tracking_number: string;
  carrier: string | null;
  cached_status: string | null;
  cached_detail: string | null;
  cached_location: string | null;
  /** `orders.easypost_checked_at` — when we LAST ASKED. NOT the scan time. */
  checked_at: string | null;
  cached_age_days: number | null;
  /** Why the live call fell through (e.g. no EasyPost key, EasyPost 4xx, timeout). */
  reason: string;
}

/** No tracking number to look up — surface says so instead of guessing. */
export interface ShipmentFactPackUnavailable {
  source: "unavailable";
  tracking_number: null;
  carrier: string | null;
  reason: string;
}

export type ShipmentFactPack =
  | ShipmentFactPackLive
  | ShipmentFactPackCachedFallback
  | ShipmentFactPackUnavailable;

export interface ShipmentFactPackInput {
  tracking_number: string | null;
  carrier?: string | null;
  /** Cached `orders.easypost_*` columns, used only if the live call fails. */
  cached?: {
    status?: string | null;
    detail?: string | null;
    location?: string | null;
    checked_at?: string | null;
  };
}

export interface ShipmentFactPackReader {
  read(input: ShipmentFactPackInput): Promise<ShipmentFactPack>;
}

export interface ShipmentFactPackReaderOptions {
  /** Injected clock for tests. */
  now?: () => Date;
  /**
   * Injected tracker lookup for tests. Production callers omit this and the reader
   * imports `lookupTracking` from `@/lib/easypost` under the covers.
   */
  lookupTracking?: (
    trackingNumber: string,
    carrier: string | undefined,
  ) => Promise<TrackingStatus>;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Stall threshold (Phase 2 of director-shipment-claims-must-cite-a-live-tracker-read).
 * A live tracker read that shows a shipment has not been scanned in ≥ STALL_THRESHOLD_DAYS
 * is DARK — the "still in transit, give it a few more days" reassurance is not permitted
 * and the flow routes to the replacement path (what the Returns Policy prescribes for a
 * carrier-lost or never-received shipment).
 *
 * Chosen at **7 days**: USPS Ground Advantage typically delivers in 2-5 days, so a full
 * calendar week with no carrier scan means the package has stopped moving — the reassurance
 * "give it a few more days" is a lie at that point. Suzanne's shipment (ticket 8e2c87d6,
 * 2026-08-24) was 11 days dark when the orchestrator told her to wait, well past this line.
 * Pinned as a named constant here (not embedded in a prompt) so it is reviewable in code;
 * see [[docs/brain/lifecycles/return-pipeline.md]] § Dark shipment for the reasoning and
 * [[docs/brain/customer-voice.md]] § Dark shipments for the wording rule.
 */
export const STALL_THRESHOLD_DAYS = 7;

/**
 * True when a live tracker read has measured a shipment as dark for at least
 * STALL_THRESHOLD_DAYS. Returns false when `daysSinceLastScan` is null/undefined —
 * absence of evidence never trips the gate (we route to replacement only on a
 * MEASURED stall, never on missing data).
 */
export function isShipmentDark(daysSinceLastScan: number | null | undefined): boolean {
  if (daysSinceLastScan === null || daysSinceLastScan === undefined) return false;
  return daysSinceLastScan >= STALL_THRESHOLD_DAYS;
}

function toWholeDays(fromIso: string | null | undefined, now: Date): number | null {
  if (!fromIso) return null;
  const parsed = Date.parse(fromIso);
  if (Number.isNaN(parsed)) return null;
  const ms = now.getTime() - parsed;
  return Math.max(0, Math.floor(ms / MS_PER_DAY));
}

function normalizeEvents(status: TrackingStatus): ShipmentEvent[] {
  const events = status.events
    .filter(e => !!e.datetime)
    .map(e => ({
      status: e.status,
      message: e.message,
      datetime: e.datetime,
      location: [e.city, e.state].filter(Boolean).join(", ") || null,
    }));
  events.sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
  return events;
}

/**
 * Build a shipment fact pack reader scoped to one session (a director brief,
 * an order-tracking workflow run). Two `read()`s with the same tracking number
 * return the SAME cached fact pack — one metered `lookupTracking` call per
 * distinct tracking number per session.
 */
export function createShipmentFactPackReader(
  workspaceId: string,
  opts: ShipmentFactPackReaderOptions = {},
): ShipmentFactPackReader {
  const nowFn = opts.now ?? (() => new Date());
  const cache = new Map<string, Promise<ShipmentFactPack>>();

  const lookupFn = opts.lookupTracking ?? (async (trackingNumber, carrier) => {
    const { lookupTracking } = await import("@/lib/easypost");
    return lookupTracking(workspaceId, trackingNumber, carrier);
  });

  async function build(input: ShipmentFactPackInput): Promise<ShipmentFactPack> {
    const carrier = (input.carrier ?? null) || null;
    const trackingNumber = (input.tracking_number ?? "").trim();
    if (!trackingNumber) {
      return {
        source: "unavailable",
        tracking_number: null,
        carrier,
        reason: "no tracking number",
      };
    }

    try {
      const tracking = await lookupFn(trackingNumber, carrier || undefined);
      const events = normalizeEvents(tracking);
      const lastEvent = events.length > 0 ? events[events.length - 1] : null;
      const lastScanAt = lastEvent?.datetime ?? null;
      const daysSinceLastScan = toWholeDays(lastScanAt, nowFn());
      const estimatedDelivery = tracking.estimatedDelivery ?? null;
      const hasEstimatedDelivery = !!(estimatedDelivery && String(estimatedDelivery).trim() !== "");
      return {
        source: "live",
        tracking_number: trackingNumber,
        carrier,
        status: tracking.status || "unknown",
        events,
        last_scan_at: lastScanAt,
        days_since_last_scan: daysSinceLastScan,
        estimated_delivery: estimatedDelivery,
        has_estimated_delivery: hasEstimatedDelivery,
      };
    } catch (err) {
      const cached = input.cached ?? {};
      const checkedAt = cached.checked_at ?? null;
      return {
        source: "cached_fallback",
        tracking_number: trackingNumber,
        carrier,
        cached_status: cached.status ?? null,
        cached_detail: cached.detail ?? null,
        cached_location: cached.location ?? null,
        checked_at: checkedAt,
        cached_age_days: toWholeDays(checkedAt, nowFn()),
        reason: errText(err),
      };
    }
  }

  return {
    read(input: ShipmentFactPackInput): Promise<ShipmentFactPack> {
      const trackingNumber = (input.tracking_number ?? "").trim();
      if (!trackingNumber) {
        // No dedup key when there is nothing to look up — every caller gets its own miss.
        return build({ ...input, tracking_number: null });
      }
      const key = `${trackingNumber}|${(input.carrier ?? "").trim() || "*"}`;
      const existing = cache.get(key);
      if (existing) return existing;
      const p = build(input);
      cache.set(key, p);
      return p;
    },
  };
}

/**
 * Plain-text renderer for the CS Director brief and any other agent-facing
 * surface that wants ONE line per tracked shipment. Cited to prove the claim
 * came from a live read (or was labeled as cached with age) — never a bare
 * cached status string masquerading as current.
 */
export function formatShipmentFactForBrief(label: string, pack: ShipmentFactPack): string {
  const carrierPart = pack.carrier ? ` · carrier ${pack.carrier}` : "";
  if (pack.source === "unavailable") {
    return `  - ${label}: shipment fact pack UNAVAILABLE (${pack.reason})${carrierPart}`;
  }
  if (pack.source === "cached_fallback") {
    const ageStr = pack.cached_age_days != null ? `${pack.cached_age_days}d ago` : "unknown age";
    const checked = pack.checked_at ? String(pack.checked_at).slice(0, 19) : "never";
    const details = [
      pack.cached_status ? `status ${pack.cached_status}` : null,
      pack.cached_detail || null,
      pack.cached_location || null,
    ].filter(Boolean).join(" · ");
    return `  - ${label}: LIVE READ FAILED (${pack.reason}) → CACHED FALLBACK (last polled ${checked} UTC, ${ageStr}) — NOT a current scan time${carrierPart} · tracking ${pack.tracking_number}${details ? ` · ${details}` : ""}`;
  }
  const lastScan = pack.last_scan_at ? String(pack.last_scan_at).slice(0, 19) : "no scan yet";
  const daysStr = pack.days_since_last_scan != null
    ? `${pack.days_since_last_scan}d since last scan`
    : "days since last scan unknown";
  const edd = pack.has_estimated_delivery
    ? `EDD ${String(pack.estimated_delivery).slice(0, 10)}`
    : "no estimated delivery date";
  const lastEvent = pack.events.length > 0 ? pack.events[pack.events.length - 1] : null;
  const lastEventStr = lastEvent
    ? ` · last event: "${lastEvent.message}"${lastEvent.location ? ` @ ${lastEvent.location}` : ""}`
    : "";
  return `  - ${label}: LIVE TRACKER READ · status ${pack.status} · ${daysStr} (last scan ${lastScan} UTC) · ${edd}${carrierPart} · tracking ${pack.tracking_number}${lastEventStr}`;
}
