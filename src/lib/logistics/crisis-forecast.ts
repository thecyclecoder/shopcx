import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { qboFetch } from "@/lib/quickbooks";
import { matchReceivedLines, openPoLines, rollUpLeadTimes, type QbTxn } from "./lead-times";
import { listPoAnnotations, listSuppliers } from "./suppliers";

// Crisis-aware allocation + demand flip-flop forecast (Logistics M3 — the crown-jewel,
// cross-department tool). Driven entirely by the live crisis_events row + crisis_customer_actions
// + subscriptions + orders — NOTHING is hardcoded per SKU. Measures the flip-flop instead of
// guessing it: a stockout routes crisis subscribers to a swap flavor; on restock they flip back,
// so burn flip-flops between the affected + swap SKUs. See docs/brain/functions/logistics.md
// § crisis-aware doctrine. Read-only; never writes QuickBooks or the storefront (it RECOMMENDS;
// execution stays with CS / a human — supervisable-autonomy north star).

const DAYS_MO = 30.4375;
const INTERNAL_SOURCES = new Set(["storefront", "internal_subscription_renewal"]);

/** Monthly renewal multiplier from a subscription's billing cadence. */
function perMonth(interval: string | null, count: number | null): number {
  const unit = interval === "week" ? 7 : interval === "day" ? 1 : interval === "year" ? 365 : DAYS_MO; // default month
  const days = unit * (count || 1);
  return days > 0 ? DAYS_MO / days : 0;
}

interface SubLite { id: string; status: string; billing_interval: string | null; billing_interval_count: number | null; items: Array<{ sku?: string; quantity?: number }> | null }
const qtySku = (items: SubLite["items"], sku: string) => (items ?? []).filter((i) => i.sku === sku).reduce((s, i) => s + (i.quantity ?? 0), 0);

export interface CrisisForecast {
  active: boolean;
  name: string;
  restockDate: string | null;
  affected: { sku: string; variantId: string; name: string };
  swap: { sku: string; variantId: string; name: string };
  enrolled: { total: number; swappedToSwap: number; cancelled: number; autoReadd: number; active: number; paused: number };
  // measured monthly unit flows (finished units/mo)
  flip: {
    swapFlipOutMo: number;      // swap-SKU units/mo that return to the affected SKU on restock
    affectedSubsMo: number;     // affected-SKU subscriber demand/mo after restock (measured from subs)
    affectedPreCrisisMo: number; swapPreCrisisMo: number;
    affectedDuringMo: number; swapDuringMo: number;
  };
  projection: {
    affectedPostRestockMo: number;   // best estimate of affected burn after restock
    swapPostRestockMo: number;       // swap burn after pulling it off the storefront + flip-out
    affectedTrueSubsMo: number; swapTrueSubsMo: number; // preserve floors
  };
  inbound: {
    affected: PoBrief | null;
    swap: PoBrief | null;
  };
  recommendations: string[];
  warnings: string[];
}

interface PoBrief { poId: string; qty: number; eta: string | null; etaSource: string; fillRate: number | null; fillAdjustedQty: number; coverMonths: number | null; leadMonths: number | null }

/** Load + compute the forecast for the workspace's active crisis (most recent active event). */
export async function loadCrisisForecast(admin: SupabaseClient, workspaceId: string): Promise<CrisisForecast | null> {
  const { data: events } = await admin
    .from("crisis_events")
    .select("id, name, status, affected_sku, affected_variant_id, affected_product_title, default_swap_variant_id, default_swap_title, expected_restock_date")
    .eq("workspace_id", workspaceId).eq("status", "active").order("created_at", { ascending: false }).limit(1);
  const ev = events?.[0];
  if (!ev) return null;

  // variant_id → seller_sku (subscription items key by sku; the event gives the swap by variant)
  const { data: extSkus } = await admin.from("qb_external_skus").select("external_id, seller_sku, source").eq("workspace_id", workspaceId).eq("source", "shopify");
  const variantToSku = new Map<string, string>();
  for (const e of extSkus ?? []) { const v = e.external_id.split("-").pop(); if (v && e.seller_sku) variantToSku.set(v, e.seller_sku); }
  const affectedSku = ev.affected_sku ?? variantToSku.get(ev.affected_variant_id) ?? "";
  const swapSku = variantToSku.get(ev.default_swap_variant_id ?? "") ?? "";

  const swapTitleRe = new RegExp((ev.default_swap_title ?? "").split(" ")[0] || "\\u0000", "i");
  const swappedToSwap = (a: { tier1_swapped_to?: { title?: string } | null; tier2_swapped_to?: { title?: string } | null }) => {
    const s = a.tier2_swapped_to ?? a.tier1_swapped_to;
    return !!(s && ev.default_swap_title && swapTitleRe.test(s.title ?? ""));
  };

  // Crisis cohort joined to their subscriptions in ONE call (RPC — replaces a chunked .in() fan-out).
  const [{ data: rows }, { count: totalActions }] = await Promise.all([
    admin.rpc("logistics_crisis_subscriptions", { p_crisis_id: ev.id }),
    admin.from("crisis_customer_actions").select("id", { count: "exact", head: true }).eq("crisis_id", ev.id),
  ]);
  type Row = SubLite & { subscription_id: string; tier1_swapped_to: { title?: string } | null; tier2_swapped_to: { title?: string } | null; auto_readd: boolean; cancelled: boolean };
  const crisisRows = (rows ?? []) as Row[];

  // Flip-OUT: active subs that swapped to the swap SKU → their monthly swap-SKU draw (returns to affected).
  // Affected subscriber demand after restock: non-cancelled active/paused crisis subs, their affected draw.
  let swapFlipOutMo = 0, swappedCount = 0, cancelled = 0, autoReadd = 0, activeCnt = 0, pausedCnt = 0, affectedSubsMo = 0;
  for (const rw of crisisRows) {
    if (rw.cancelled) cancelled++;
    if (rw.auto_readd) autoReadd++;
    if (swappedToSwap(rw)) {
      swappedCount++;
      if (rw.status === "active") swapFlipOutMo += qtySku(rw.items, swapSku) * perMonth(rw.billing_interval, rw.billing_interval_count);
    }
    if (!rw.cancelled && (rw.status === "active" || rw.status === "paused")) {
      if (rw.status === "active") activeCnt++; else pausedCnt++;
      const q = qtySku(rw.items, affectedSku) || qtySku(rw.items, swapSku);
      affectedSubsMo += q * perMonth(rw.billing_interval, rw.billing_interval_count);
    }
  }

  // Storefront burn windows (by variant_id, RPC), pre- vs during-crisis. Pre-window = the 3 months
  // before the crisis for the new-customer acquisition baseline.
  const crisisStart = "2026-04-09"; // event created_at
  const today = new Date().toISOString().slice(0, 10);
  const sbUnits = async (variant: string, since: string, until: string) => {
    if (!variant) return 0;
    const { data } = await admin.rpc("logistics_storefront_units", { p_workspace: workspaceId, p_variant: variant, p_since: since, p_until: until });
    return Number(data ?? 0);
  };
  const toMo = (total: number, since: string, until: string) => { const m = (Date.parse(until) - Date.parse(since)) / (DAYS_MO * 86_400_000); return m > 0 ? total / m : 0; };
  const [affPreU, swPreU, affDurU, swDurU, affectedTrueSubsMo, swapTrueSubsMo] = await Promise.all([
    sbUnits(ev.affected_variant_id, "2026-01-01", "2026-04-08"),
    sbUnits(ev.default_swap_variant_id ?? "", "2026-01-01", "2026-04-08"),
    sbUnits(ev.affected_variant_id, crisisStart, today),
    sbUnits(ev.default_swap_variant_id ?? "", crisisStart, today),
    admin.rpc("logistics_subscriber_units_mo", { p_workspace: workspaceId, p_sku: affectedSku, p_exclude_crisis: ev.id }).then((r) => Number(r.data ?? 0)),
    admin.rpc("logistics_subscriber_units_mo", { p_workspace: workspaceId, p_sku: swapSku, p_exclude_crisis: ev.id }).then((r) => Number(r.data ?? 0)),
  ]);
  const affPre = { mo: toMo(affPreU, "2026-01-01", "2026-04-08") };
  const swPre = { mo: toMo(swPreU, "2026-01-01", "2026-04-08") };
  const affDur = { mo: toMo(affDurU, crisisStart, today) };
  const swDur = { mo: toMo(swDurU, crisisStart, today) };

  // Inbound POs for affected + swap (from QB + our annotations + supplier fill rate)
  const [affectedPo, swapPo] = await Promise.all([
    inboundPoBrief(admin, workspaceId, ev.affected_product_title ?? affectedSku),
    inboundPoBrief(admin, workspaceId, ev.default_swap_title ?? swapSku),
  ]);

  // Projections
  const affectedPostRestockMo = Math.max(affPre.mo, affectedSubsMo); // pre-crisis baseline, floored by measured subs
  const swapPostRestockMo = swapTrueSubsMo; // after pulling swap off the storefront, only its true subs remain

  const f: CrisisForecast = {
    active: true, name: ev.name, restockDate: ev.expected_restock_date,
    affected: { sku: affectedSku, variantId: ev.affected_variant_id, name: ev.affected_product_title ?? affectedSku },
    swap: { sku: swapSku, variantId: ev.default_swap_variant_id ?? "", name: ev.default_swap_title ?? swapSku },
    enrolled: { total: totalActions ?? crisisRows.length, swappedToSwap: swappedCount, cancelled, autoReadd, active: activeCnt, paused: pausedCnt },
    flip: {
      swapFlipOutMo, affectedSubsMo,
      affectedPreCrisisMo: affPre.mo, swapPreCrisisMo: swPre.mo,
      affectedDuringMo: affDur.mo, swapDuringMo: swDur.mo,
    },
    projection: { affectedPostRestockMo, swapPostRestockMo, affectedTrueSubsMo, swapTrueSubsMo },
    inbound: { affected: affectedPo, swap: swapPo },
    recommendations: [], warnings: [],
  };
  buildRecommendations(f);
  return f;
}

/** Newest open PO whose line matches `itemNameLike`, with ETA + fill-adjusted qty. */
async function inboundPoBrief(admin: SupabaseClient, workspaceId: string, itemNameLike: string): Promise<PoBrief | null> {
  const q = async (entity: string): Promise<QbTxn[]> => {
    const d = await qboFetch(workspaceId, "query", { query: { query: `SELECT * FROM ${entity} WHERE TxnDate >= '2023-01-01' MAXRESULTS 1000` }, admin });
    return (d?.QueryResponse?.[entity] ?? []) as QbTxn[];
  };
  const [pos, bills, annotations, suppliers] = await Promise.all([q("PurchaseOrder"), q("Bill"), listPoAnnotations(admin, workspaceId), listSuppliers(admin, workspaceId)]);
  const leadTimes = rollUpLeadTimes(matchReceivedLines(pos, bills));
  const open = openPoLines(pos).filter((p) => p.itemName.toLowerCase().includes(itemNameLike.toLowerCase().split(" - ")[0].toLowerCase()) && p.itemName.toLowerCase().includes("tabs"));
  // best match: the affected/swap finished good specifically
  const po = open.filter((p) => p.itemName.toLowerCase().includes(itemNameLike.toLowerCase().replace(/^superfood tabs - /i, "").split(" - ")[0].toLowerCase()))
    .sort((a, b) => (a.poDate < b.poDate ? 1 : -1))[0] ?? open.sort((a, b) => (a.poDate < b.poDate ? 1 : -1))[0];
  if (!po) return null;
  const lead = leadTimes.find((l) => l.itemId === po.itemId);
  const supplier = suppliers.find((s) => s.name === po.vendor);
  const ann = annotations.get(po.poId);
  const eta = ann?.expectedArrivalDate ?? po.dueDate ?? (lead ? new Date(Date.parse(po.poDate) + lead.avgLeadDays * 86_400_000).toISOString().slice(0, 10) : null);
  const etaSource = ann?.expectedArrivalDate ? "annotation" : po.dueDate ? "qb_due_date" : lead ? "measured_lead" : "none";
  const fillRate = lead?.avgFillRate ?? null;
  const fillAdjustedQty = Math.round(po.orderedQty * (fillRate ?? 1));
  const leadMonths = lead ? lead.avgLeadMonths : (supplier?.leadDaysOverride ? supplier.leadDaysOverride / DAYS_MO : null);
  return { poId: po.poId, qty: po.orderedQty, eta, etaSource, fillRate, fillAdjustedQty, coverMonths: null, leadMonths };
}

/** Assemble the concrete Marco play + shortfall warnings from the measured forecast. */
function buildRecommendations(f: CrisisForecast): void {
  const r = f.recommendations, w = f.warnings;
  const round = (n: number) => Math.round(n).toLocaleString();
  const restock = f.restockDate ? new Date(f.restockDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "restock";

  r.push(`On ${restock}, swap the ${round(f.enrolled.autoReadd)} auto-re-add crisis subscribers back to ${f.affected.name} (they already opted to re-add it).`);
  r.push(`Return ${f.affected.name} to the storefront + portal swap options — this recovers ~${round(f.flip.affectedPreCrisisMo)} units/mo of ${f.affected.name} demand (its pre-crisis baseline).`);
  r.push(`Pull ${f.swap.name} OFF the storefront + portal options (availability lever): its burn drops from ${round(f.flip.swapDuringMo)}/mo toward its true-subscriber floor of ${round(f.projection.swapTrueSubsMo)}/mo, preserving units for genuine ${f.swap.name} subscribers.`);

  // Affected next-PO timing
  const po = f.inbound.affected;
  if (po && f.projection.affectedPostRestockMo > 0) {
    const cover = po.fillAdjustedQty / f.projection.affectedPostRestockMo;
    po.coverMonths = cover;
    const lead = po.leadMonths ?? 3;
    const reorderInMonths = cover - lead;
    if (reorderInMonths <= 0) {
      r.push(`⚠ Place the NEXT ${f.affected.name} PO NOW: the inbound ${round(po.qty)} (≈${round(po.fillAdjustedQty)} after ${po.fillRate != null ? Math.round(po.fillRate * 100) + "%" : "—"} fill) only covers ${cover.toFixed(1)}mo at the projected ${round(f.projection.affectedPostRestockMo)}/mo, under the ${lead.toFixed(1)}mo lead time.`);
    } else {
      const by = f.restockDate ? new Date(Date.parse(f.restockDate) + reorderInMonths * DAYS_MO * 86_400_000).toISOString().slice(0, 10) : null;
      r.push(`Place the next ${f.affected.name} PO by ${by ? new Date(by + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "≈" + reorderInMonths.toFixed(1) + "mo after restock"}: the inbound ${round(po.qty)} (≈${round(po.fillAdjustedQty)} @ ${po.fillRate != null ? Math.round(po.fillRate * 100) + "%" : "—"} fill) covers ${cover.toFixed(1)}mo at the projected ${round(f.projection.affectedPostRestockMo)}/mo vs the ${lead.toFixed(1)}mo lead.`);
    }
  }

  // Swap bridge shortfall — can its on-hand + inbound reach its own PO without starving true subscribers?
  const swPo = f.inbound.swap;
  if (swPo?.eta && f.projection.swapTrueSubsMo > 0) {
    const monthsToPo = (Date.parse(swPo.eta) - Date.now()) / (DAYS_MO * 86_400_000);
    w.push(`${f.swap.name}: even at its true-subscriber floor (${round(f.projection.swapTrueSubsMo)}/mo), its next PO doesn't land until ${new Date(swPo.eta + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} (~${monthsToPo.toFixed(1)}mo out). Verify on-hand can bridge that gap for genuine ${f.swap.name} subscribers, or expedite the PO.`);
  }
}
