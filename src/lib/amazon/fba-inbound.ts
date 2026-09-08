import { spApiRequest } from "./auth";

// FBA Inbound shipments (SP-API /fba/inbound/v0) — units SHIPPED to Amazon but not yet RECEIVED.
//
// The close needs this because a unit on an FBA replenishment is invisible to both of the other
// physical sources: the 3PL has already decremented it, and /fba/inventory/v1/summaries reports
// nothing for it until Amazon starts receiving. See docs/brain/tables/qb_inbound_shipment_snapshots.md.
//
// ⭐ Point-in-time only. `QuantityShipped - QuantityReceived` collapses to zero once a shipment
// finishes receiving, so a missed day is a permanently unrecoverable in-transit position — the
// same rule that already governs the daily FBA/3PL snapshots.

/** Statuses where stock is en route or landing but not yet fully on Amazon's books. */
const OPEN_STATUSES = ["WORKING", "READY_TO_SHIP", "SHIPPED", "IN_TRANSIT", "DELIVERED", "CHECKED_IN", "RECEIVING"] as const;

export interface InboundShipmentLine {
  shipmentId: string;
  shipmentName: string | null;
  shipmentStatus: string;
  sellerSku: string;
  quantityShipped: number;
  quantityReceived: number;
  /** max(0, shipped − received). Floored: Amazon can receive MORE than was declared. */
  inTransit: number;
}

/**
 * Every open inbound shipment's per-SKU position. Returns `ok` SEPARATELY from the rows so a
 * broken query is never read as "nothing in transit" — the distinction that turned a real
 * receipt into a $67,131 phantom gain elsewhere in this pipeline.
 */
export async function fetchOpenInboundShipments(
  connectionId: string,
  marketplaceId: string,
): Promise<{ lines: InboundShipmentLine[]; ok: boolean }> {
  const shipments: { id: string; name: string | null; status: string }[] = [];
  let ok = true;

  for (const status of OPEN_STATUSES) {
    try {
      const p = new URLSearchParams({ MarketplaceId: marketplaceId, ShipmentStatusList: status, QueryType: "SHIPMENT" });
      const res = await spApiRequest(connectionId, marketplaceId, "GET", `/fba/inbound/v0/shipments?${p.toString()}`);
      const data = await (res as Response).json();
      for (const s of data?.payload?.ShipmentData ?? [])
        if (s?.ShipmentId) shipments.push({ id: String(s.ShipmentId), name: s.ShipmentName ?? null, status: String(s.ShipmentStatus ?? status) });
    } catch {
      // One bad status must not zero the whole position.
      ok = false;
    }
  }

  const lines: InboundShipmentLine[] = [];
  const seen = new Set<string>();
  for (const sh of shipments) {
    if (seen.has(sh.id)) continue; // a shipment can surface under more than one status query
    seen.add(sh.id);
    try {
      const res = await spApiRequest(connectionId, marketplaceId, "GET", `/fba/inbound/v0/shipments/${sh.id}/items?MarketplaceId=${marketplaceId}`);
      const data = await (res as Response).json();
      for (const it of data?.payload?.ItemData ?? []) {
        const sellerSku = it?.SellerSKU ? String(it.SellerSKU) : null;
        if (!sellerSku) continue;
        const shipped = Number(it.QuantityShipped ?? 0);
        const received = Number(it.QuantityReceived ?? 0);
        lines.push({
          shipmentId: sh.id, shipmentName: sh.name, shipmentStatus: sh.status,
          sellerSku, quantityShipped: shipped, quantityReceived: received,
          inTransit: Math.max(0, shipped - received),
        });
      }
    } catch {
      ok = false;
    }
  }
  return { lines, ok };
}
