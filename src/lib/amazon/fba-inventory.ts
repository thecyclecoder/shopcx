import { spApiRequest } from "./auth";

// FBA Inventory (SP-API GET /fba/inventory/v1/summaries) — fulfillable + inbound on-hand
// per ASIN. Reuses the existing spApiRequest/getAccessToken auth. Two load-bearing gotchas
// (confirmed against Shoptics' working sync): the API returns per SELLER-SKU and one ASIN
// can span several seller SKUs, so we ACCUMULATE per ASIN; and results paginate via
// nextToken. Note spApiRequest returns a raw Response — you must .json() it.

export interface FbaAsinInventory {
  asin: string;
  sellerSku: string | null; // a representative seller SKU (first seen)
  onHand: number;            // Σ fulfillableQuantity across seller SKUs of this ASIN
  inbound: number;           // Σ inbound (working + shipping + receiving)
  reserved: number;          // Σ reserved
}

export async function fetchFbaInventoryByAsin(connectionId: string, marketplaceId: string): Promise<FbaAsinInventory[]> {
  const byAsin = new Map<string, FbaAsinInventory>();
  let nextToken: string | null = null;
  let pages = 0;
  do {
    const p = new URLSearchParams({ details: "true", granularityType: "Marketplace", granularityId: marketplaceId, marketplaceIds: marketplaceId });
    if (nextToken) p.set("nextToken", nextToken);
    const res = await spApiRequest(connectionId, marketplaceId, "GET", `/fba/inventory/v1/summaries?${p.toString()}`);
    const data = await (res as Response).json();
    for (const s of data?.payload?.inventorySummaries ?? []) {
      const asin = s.asin as string | undefined;
      if (!asin) continue;
      const d = s.inventoryDetails ?? {};
      const inbound = (d.inboundWorkingQuantity ?? 0) + (d.inboundShippingQuantity ?? 0) + (d.inboundReceivingQuantity ?? 0);
      const cur = byAsin.get(asin) ?? { asin, sellerSku: s.sellerSku ?? null, onHand: 0, inbound: 0, reserved: 0 };
      cur.onHand += d.fulfillableQuantity ?? s.totalQuantity ?? 0;
      cur.inbound += inbound;
      cur.reserved += d.reservedQuantity?.totalReservedQuantity ?? 0;
      byAsin.set(asin, cur);
    }
    nextToken = data?.pagination?.nextToken ?? null;
    pages++;
  } while (nextToken && pages < 50);
  return Array.from(byAsin.values());
}
