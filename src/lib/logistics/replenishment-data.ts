import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { qboFetch } from "@/lib/quickbooks";
import { matchReceivedLines, openPoLines, rollUpLeadTimes, type QbTxn, type ItemLeadTime, type OpenPoLine } from "./lead-times";
import { computeCover, type CoverRow } from "./cover";
import { listSuppliers, listPoAnnotations, type Supplier } from "./suppliers";
import { loadCrisisForecast, type CrisisForecast } from "./crisis-forecast";

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

/** Resolved expected-arrival for an open PO. `source` records where the date came from so the UI
 *  can distinguish a confirmed ETA from a measured-lead estimate. */
export interface ResolvedEta {
  date: string | null;
  status: "estimated" | "confirmed" | "delayed" | "received" | null;
  source: "annotation" | "qb_due_date" | "measured_lead" | "none";
  note: string | null;
}

export interface ReplenishmentData {
  leadTimes: ItemLeadTime[];
  openPos: OpenPoLine[];
  cover: CoverByFinishedGood[];
  suppliers: Supplier[];
  etaByPo: Record<string, ResolvedEta>;
  crisis: CrisisForecast | null;
  burnWindow: { since: string; until: string; months: number };
  poCount: number;
  billCount: number;
  since: string;
}

// ── Suppliers view (the Suppliers page) ─────────────────────────────────────────────────
export interface SupplierView extends Supplier {
  items: ItemLeadTime[];        // finished goods this supplier makes, with measured lead/fill
  openPos: OpenPoLine[];        // its currently-unreceived POs
  measuredLeadDaysMin: number | null;
  measuredLeadDaysMax: number | null;
  avgFillRate: number | null;   // units received ÷ ordered, averaged across its items
}

/** Suppliers joined with their live measured lead times (QB PO→Bill LinkedTxn) + open POs,
 *  matched by vendor name. Powers /dashboard/logistics/suppliers. */
export async function loadSupplierView(workspaceId: string, since = "2023-01-01"): Promise<SupplierView[]> {
  const admin = createAdminClient();
  const q = async (entity: string): Promise<QbTxn[]> => {
    const data = await qboFetch(workspaceId, "query", { query: { query: `SELECT * FROM ${entity} WHERE TxnDate >= '${since}' MAXRESULTS 1000` }, admin });
    return (data?.QueryResponse?.[entity] ?? []) as QbTxn[];
  };
  const [pos, bills, suppliers] = await Promise.all([q("PurchaseOrder"), q("Bill"), listSuppliers(admin, workspaceId)]);
  const leadTimes = rollUpLeadTimes(matchReceivedLines(pos, bills));
  const openPos = openPoLines(pos);

  return suppliers.map((s) => {
    const items = leadTimes.filter((l) => l.vendor === s.name);
    const sOpen = openPos.filter((p) => p.vendor === s.name);
    const leads = items.map((i) => i.avgLeadDays).filter((n): n is number => n != null);
    const fills = items.map((i) => i.avgFillRate).filter((n): n is number => n != null);
    return {
      ...s,
      items,
      openPos: sOpen,
      measuredLeadDaysMin: leads.length ? Math.min(...leads) : null,
      measuredLeadDaysMax: leads.length ? Math.max(...leads) : null,
      avgFillRate: fills.length ? fills.reduce((a, b) => a + b, 0) / fills.length : null,
    };
  });
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

  const [pos, bills, coverRows, suppliers, annotations, crisis] = await Promise.all([
    q("PurchaseOrder"),
    q("Bill"),
    computeCover(admin, workspaceId, [...bundleToFgQbId.keys()].map((b) => ({ bundleQbId: b })), sinceBurn, until, 3),
    listSuppliers(admin, workspaceId),
    listPoAnnotations(admin, workspaceId),
    loadCrisisForecast(admin, workspaceId).catch(() => null),
  ]);
  const received = matchReceivedLines(pos, bills, itemFilter);
  const leadTimes = rollUpLeadTimes(received);
  const openPos = openPoLines(pos, itemFilter);

  // Resolve each open PO's ETA: our annotation wins (it's the confirmed reality), then QB DueDate,
  // then a measured-lead estimate off the PO date. Distinct `source` so the UI marks estimates.
  const leadByItem = new Map(leadTimes.map((l) => [l.itemId, l]));
  const etaByPo: Record<string, ResolvedEta> = {};
  for (const po of openPos) {
    const ann = annotations.get(po.poId);
    if (ann?.expectedArrivalDate) {
      etaByPo[po.poId] = { date: ann.expectedArrivalDate, status: ann.etaStatus ?? "confirmed", source: "annotation", note: ann.note };
    } else if (po.dueDate) {
      etaByPo[po.poId] = { date: po.dueDate, status: "confirmed", source: "qb_due_date", note: null };
    } else {
      const lead = leadByItem.get(po.itemId);
      etaByPo[po.poId] = lead
        ? { date: new Date(Date.parse(po.poDate) + lead.avgLeadDays * 86_400_000).toISOString().slice(0, 10), status: "estimated", source: "measured_lead", note: null }
        : { date: null, status: null, source: "none", note: null };
    }
  }

  return {
    leadTimes,
    openPos,
    cover: coverRows
      .map((r) => ({ ...r, finishedGoodQbId: bundleToFgQbId.get(r.bundleQbId) ?? "" }))
      .filter((r) => r.finishedGoodQbId),
    suppliers,
    etaByPo,
    crisis,
    burnWindow: { since: sinceBurn, until, months: 3 },
    poCount: pos.length,
    billCount: bills.length,
    since,
  };
}
