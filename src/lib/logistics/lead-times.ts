// Logistics — supplier lead-time engine. Pure functions over QuickBooks PurchaseOrder +
// Bill JSON (no I/O). Matches each PO to its receiving Bill via QBO's native LinkedTxn
// link, so lead time = Bill.TxnDate − PO.TxnDate with no fuzzy heuristics; fill rate
// (received ÷ ordered) is tracked separately because manufacturers under-produce (~5%).
// See docs/brain/functions/logistics.md § Crisis-aware replenishment & allocation.

export interface QbLine {
  Amount?: number;
  ItemBasedExpenseLineDetail?: { ItemRef?: { value?: string; name?: string }; Qty?: number };
}
export interface QbTxn {
  Id: string;
  TxnDate: string;
  DueDate?: string;
  VendorRef?: { value?: string; name?: string };
  Memo?: string;
  PrivateNote?: string;
  Line?: QbLine[];
  LinkedTxn?: Array<{ TxnType?: string; TxnId?: string }>;
}

/** One received PO line → its Bill: the atom of a measured lead time. */
export interface ReceivedLine {
  poId: string;
  billId: string;
  itemId: string;
  itemName: string;
  vendor: string | null;
  poDate: string;
  billDate: string;
  leadDays: number;
  orderedQty: number;
  receivedQty: number;
  fillRate: number | null; // received ÷ ordered
}

/** An open (unreceived) PO line = inbound replenishment in flight. */
export interface OpenPoLine {
  poId: string;
  itemId: string;
  itemName: string;
  vendor: string | null;
  poDate: string;
  dueDate: string | null; // QB rarely sets this — ETA usually lives in our own annotation
  orderedQty: number;
  amount: number | null;
  memo: string | null;
}

const DAY = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const itemLines = (t: QbTxn) => (t.Line ?? []).filter((l) => l.ItemBasedExpenseLineDetail?.ItemRef?.value);
const shortName = (n?: string) => (n ? n.split(":").pop() ?? n : "");

/**
 * Match POs to their receiving Bills via LinkedTxn (authoritative). For each PO line
 * that references an item, find the linked Bill's matching line and emit a ReceivedLine.
 * Only itemIds in `filter` are kept when provided.
 */
export function matchReceivedLines(pos: QbTxn[], bills: QbTxn[], filter?: Set<string>): ReceivedLine[] {
  const billById = new Map(bills.map((b) => [b.Id, b]));
  const out: ReceivedLine[] = [];
  for (const po of pos) {
    const linkedBillIds = (po.LinkedTxn ?? []).filter((x) => x.TxnType === "Bill").map((x) => x.TxnId!);
    if (linkedBillIds.length === 0) continue;
    for (const poLine of itemLines(po)) {
      const d = poLine.ItemBasedExpenseLineDetail!;
      const itemId = String(d.ItemRef!.value);
      if (filter && !filter.has(itemId)) continue;
      const orderedQty = Number(d.Qty ?? 0);
      // find the linked Bill that received this item; sum its matching-item qty
      for (const billId of linkedBillIds) {
        const bill = billById.get(billId);
        if (!bill) continue;
        const billQty = itemLines(bill)
          .filter((l) => String(l.ItemBasedExpenseLineDetail!.ItemRef!.value) === itemId)
          .reduce((s, l) => s + Number(l.ItemBasedExpenseLineDetail!.Qty ?? 0), 0);
        if (billQty === 0) continue;
        out.push({
          poId: po.Id, billId, itemId, itemName: shortName(d.ItemRef!.name),
          vendor: po.VendorRef?.name ?? null,
          poDate: po.TxnDate, billDate: bill.TxnDate, leadDays: daysBetween(po.TxnDate, bill.TxnDate),
          orderedQty, receivedQty: billQty, fillRate: orderedQty > 0 ? billQty / orderedQty : null,
        });
      }
    }
  }
  return out.sort((a, b) => Date.parse(b.billDate) - Date.parse(a.billDate));
}

/** POs with no linked Bill = still inbound. One entry per item line. */
export function openPoLines(pos: QbTxn[], filter?: Set<string>): OpenPoLine[] {
  const out: OpenPoLine[] = [];
  for (const po of pos) {
    if ((po.LinkedTxn ?? []).some((x) => x.TxnType === "Bill")) continue;
    for (const line of itemLines(po)) {
      const d = line.ItemBasedExpenseLineDetail!;
      const itemId = String(d.ItemRef!.value);
      if (filter && !filter.has(itemId)) continue;
      out.push({
        poId: po.Id, itemId, itemName: shortName(d.ItemRef!.name), vendor: po.VendorRef?.name ?? null,
        poDate: po.TxnDate, dueDate: po.DueDate ?? null, orderedQty: Number(d.Qty ?? 0),
        amount: line.Amount ?? null, memo: po.Memo ?? po.PrivateNote ?? null,
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.poDate) - Date.parse(a.poDate));
}

export interface ItemLeadTime {
  itemId: string;
  itemName: string;
  vendor: string | null;
  avgLeadDays: number;
  avgLeadMonths: number;
  avgFillRate: number | null;
  cycles: number; // sample size — small early, firms up as POs close
  lastReceivedDate: string;
}

/** Roll received lines up to a per-item average lead time + fill rate. */
export function rollUpLeadTimes(received: ReceivedLine[]): ItemLeadTime[] {
  const byItem = new Map<string, ReceivedLine[]>();
  for (const r of received) (byItem.get(r.itemId) ?? byItem.set(r.itemId, []).get(r.itemId)!).push(r);
  const out: ItemLeadTime[] = [];
  for (const [itemId, rows] of byItem) {
    const avgLeadDays = rows.reduce((s, r) => s + r.leadDays, 0) / rows.length;
    const fills = rows.filter((r) => r.fillRate != null).map((r) => r.fillRate!);
    out.push({
      itemId, itemName: rows[0].itemName, vendor: rows[0].vendor,
      avgLeadDays: Math.round(avgLeadDays),
      avgLeadMonths: Math.round((avgLeadDays / 30.44) * 10) / 10,
      avgFillRate: fills.length ? fills.reduce((s, f) => s + f, 0) / fills.length : null,
      cycles: rows.length,
      lastReceivedDate: rows[0].billDate,
    });
  }
  return out.sort((a, b) => b.avgLeadDays - a.avgLeadDays);
}
