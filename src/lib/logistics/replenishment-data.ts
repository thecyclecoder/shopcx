import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { qboFetch } from "@/lib/quickbooks";
import { matchReceivedLines, openPoLines, rollUpLeadTimes, type QbTxn, type ItemLeadTime, type OpenPoLine } from "./lead-times";

// Server-side loader for the Logistics Replenishment view. Reads live QuickBooks
// PurchaseOrders + Bills (ShopCX has its own QBO connection — same realm we reconcile
// the close against) and derives measured lead times + inbound (open) POs. Burn-rate /
// days-of-cover joins in once the channel sales + inventory feeds are wired (Milestone 1.5).

export interface ReplenishmentData {
  leadTimes: ItemLeadTime[];
  openPos: OpenPoLine[];
  poCount: number;
  billCount: number;
  since: string;
}

/** Pull POs + Bills since `since` and compute lead times + open POs. Finished-goods only
 *  when `itemFilter` is given (QBO item ids). */
export async function loadReplenishment(workspaceId: string, since = "2024-01-01", itemFilter?: Set<string>): Promise<ReplenishmentData> {
  const admin = createAdminClient();
  const q = async (entity: string): Promise<QbTxn[]> => {
    const data = await qboFetch(workspaceId, "query", { query: { query: `SELECT * FROM ${entity} WHERE TxnDate >= '${since}' MAXRESULTS 1000` }, admin });
    return (data?.QueryResponse?.[entity] ?? []) as QbTxn[];
  };
  const [pos, bills] = await Promise.all([q("PurchaseOrder"), q("Bill")]);
  const received = matchReceivedLines(pos, bills, itemFilter);
  return {
    leadTimes: rollUpLeadTimes(received),
    openPos: openPoLines(pos, itemFilter),
    poCount: pos.length,
    billCount: bills.length,
    since,
  };
}
