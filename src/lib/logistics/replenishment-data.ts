import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { qboFetch } from "@/lib/quickbooks";
import { matchReceivedLines, openPoLines, rollUpLeadTimes, type QbTxn, type ItemLeadTime, type OpenPoLine } from "./lead-times";
import { computeCover, type CoverRow } from "./cover";

// Server-side loader for the Logistics Replenishment view. Reads live QuickBooks
// PurchaseOrders + Bills (ShopCX has its own QBO connection — same realm we reconcile
// the close against) and derives measured lead times + inbound (open) POs. Days-of-cover
// (burn rate vs on-hand) is computed from the canonical inventory_levels + native sales
// and reconciles exact vs Shopify/Shoptics (SL June = 1049 Shopify units).

// Finished goods we actively track, by QBO item id (the manufactured "-F" rollups referenced
// on POs/Bills). Days-of-cover keys off these; the list grows as SKUs are onboarded.
const TRACKED_FG = ["136", "137", "298"]; // SL-30, Berry-30, Berry-10

/** A CoverRow joined back to the tracked finished good's QBO item id (POs/lead times key on it). */
export type CoverByFinishedGood = CoverRow & { finishedGoodQbId: string };

export interface ReplenishmentData {
  leadTimes: ItemLeadTime[];
  openPos: OpenPoLine[];
  cover: CoverByFinishedGood[];
  burnWindow: { since: string; until: string; months: number };
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

  // Bridge the tracked -F finished goods to their sellable bundles (cover keys off the bundle,
  // whose qb_sku_mappings carry the channel refs) so burn/on-hand can join back to lead times.
  const [fgItems, bom] = await Promise.all([
    admin.from("qb_items").select("id, quickbooks_id").eq("workspace_id", workspaceId).in("quickbooks_id", TRACKED_FG),
    admin.from("qb_item_bom").select("parent_id, component_id").eq("workspace_id", workspaceId),
  ]);
  const fgUuidToQbId = new Map((fgItems.data ?? []).map((i) => [i.id, i.quickbooks_id as string]));
  const bundleByComponent = new Map((bom.data ?? []).map((b) => [b.component_id, b.parent_id]));
  // finished-good UUID → its bundle UUID; then bundle UUID → finished-good QBO id (for the join back)
  const bundleToFgQbId = new Map<string, string>();
  for (const [fgUuid, qbId] of fgUuidToQbId) {
    const bundleUuid = bundleByComponent.get(fgUuid);
    if (bundleUuid) bundleToFgQbId.set(bundleUuid, qbId);
  }

  // Trailing 3 full-ish months smooths monthly variance for the burn baseline.
  const until = new Date().toISOString().slice(0, 10);
  const sinceBurn = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);

  const [pos, bills, coverRows] = await Promise.all([
    q("PurchaseOrder"),
    q("Bill"),
    computeCover(admin, workspaceId, [...bundleToFgQbId.keys()].map((b) => ({ bundleQbId: b })), sinceBurn, until, 3),
  ]);
  const received = matchReceivedLines(pos, bills, itemFilter);
  return {
    leadTimes: rollUpLeadTimes(received),
    openPos: openPoLines(pos, itemFilter),
    cover: coverRows
      .map((r) => ({ ...r, finishedGoodQbId: bundleToFgQbId.get(r.bundleQbId) ?? "" }))
      .filter((r) => r.finishedGoodQbId),
    burnWindow: { since: sinceBurn, until, months: 3 },
    poCount: pos.length,
    billCount: bills.length,
    since,
  };
}
