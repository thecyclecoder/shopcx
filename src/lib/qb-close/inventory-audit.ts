// Shoptics → ShopCX migration, Phase 2/3 (shadow). Faithful port of the inventory-audit
// variance computation (Shoptics api/inventory-audit/route.ts, "monthly" mode) + the
// month-end InventoryAdjustment line builder (api/qb/month-end-closing route Step 2).
// Computes per-item shrinkage variance = actual physical (FBA+3PL+manual) − expected
// (QB start − sales burn + received), across multi-parent BOMs, then rounds each to a
// whole-unit QtyDiff for the shrinkage adjustment. Pure function — all inputs passed in
// (QB/FBA/3PL/manual snapshots, sales burn, and the live-QB `received` term). Posts
// nothing. See docs/brain/lifecycles/shoptics-migration.md.

export interface AuditProduct {
  id: string; quickbooks_id: string; name: string; sku: string | null;
  item_type: string; product_category: string | null;
}
export interface AuditMapping { external_id: string; source: string; product_id: string; multiplier: number; }
export interface AuditBomRow { parent_id: string; component_id: string; quantity: number; }

export interface AuditInputs {
  products: AuditProduct[];
  mappings: AuditMapping[];
  bom: AuditBomRow[];
  qbInventory: Map<string, number>;       // product_id → QB book qty (prior-month month_end_post)
  fbaByAsin: Map<string, { fulfillable: number; transit: number }>;
  tplBySku: Map<string, number>;
  manualByProduct: Map<string, number>;   // product_id → summed manual qty
  amzSalesByAsin: Map<string, number>;
  shopSalesByVariant: Map<string, number>;
  internalSalesByProduct: Map<string, number>;
  receivedByProduct: Map<string, number>; // product_id → QB receipts (Bill/ItemReceipt/Purchase) in period
}

export interface VarianceRow { product_id: string; quickbooks_id: string; variance: number; }
export interface AuditResult { bomComponents: VarianceRow[]; standalone: VarianceRow[]; }

/** Reproduce the monthly-mode audit variances. Mirrors the route's getChannelInventory /
 *  getSalesBurn / componentTotalBurn / componentTotalImplied / -F rollup logic exactly. */
export function computeAuditVariances(inp: AuditInputs): AuditResult {
  const productById = new Map(inp.products.map((p) => [p.id, p]));
  const mappingsByProduct = new Map<string, AuditMapping[]>();
  for (const m of inp.mappings) { const l = mappingsByProduct.get(m.product_id) || []; l.push(m); mappingsByProduct.set(m.product_id, l); }

  const parentToComponents = new Map<string, Array<{ component_id: string; quantity: number }>>();
  const componentToParents = new Map<string, Array<{ parent_id: string; quantity: number }>>();
  const componentIds = new Set<string>();
  for (const row of inp.bom) {
    (parentToComponents.get(row.parent_id) || parentToComponents.set(row.parent_id, []).get(row.parent_id)!).push({ component_id: row.component_id, quantity: Number(row.quantity) });
    (componentToParents.get(row.component_id) || componentToParents.set(row.component_id, []).get(row.component_id)!).push({ parent_id: row.parent_id, quantity: Number(row.quantity) });
    componentIds.add(row.component_id);
  }

  const getChannelInventory = (productId: string) => {
    const pm = mappingsByProduct.get(productId) || [];
    let fba = 0, fbaTransit = 0, tpl = 0;
    for (const m of pm) {
      if (m.source === "amazon") { const s = inp.fbaByAsin.get(m.external_id); fba += Math.max(0, s?.fulfillable || 0) * m.multiplier; fbaTransit += Math.max(0, s?.transit || 0) * m.multiplier; }
      else if (m.source === "3pl") { tpl += Math.max(0, inp.tplBySku.get(m.external_id) || 0) * m.multiplier; }
    }
    const manual = inp.manualByProduct.get(productId) || 0;
    return { fba, fba_transit: fbaTransit, tpl, manual, total: fba + fbaTransit + tpl + manual };
  };
  const getSalesBurn = (productId: string) => {
    const pm = mappingsByProduct.get(productId) || [];
    let amz = 0, shop = 0;
    for (const m of pm) {
      if (m.source === "amazon") amz += (inp.amzSalesByAsin.get(m.external_id) || 0) * m.multiplier;
      else if (m.source === "shopify") shop += (inp.shopSalesByVariant.get(m.external_id) || 0) * m.multiplier;
    }
    const intSold = inp.internalSalesByProduct.get(productId) || 0;
    return { total_sold: amz + shop + intSold };
  };
  const getReceived = (productId: string) => inp.receivedByProduct.get(productId) || 0;

  // total component burn + implied across ALL parents
  const componentTotalBurn = new Map<string, number>();
  const componentTotalImplied = new Map<string, number>();
  for (const [compId, parents] of componentToParents) {
    let burn = 0, fba = 0, transit = 0, tpl = 0, manual = 0;
    for (const { parent_id, quantity } of parents) {
      burn += getSalesBurn(parent_id).total_sold * quantity;
      const pinv = getChannelInventory(parent_id);
      fba += pinv.fba * quantity; transit += pinv.fba_transit * quantity; tpl += pinv.tpl * quantity; manual += pinv.manual * quantity;
    }
    componentTotalBurn.set(compId, burn);
    componentTotalImplied.set(compId, Math.max(0, fba + transit + tpl + manual));
  }

  // Bundle qb_starting from the "-F" rollup component (mirrors the route): min over
  // rollup components of floor(compQb / bomQty). Used only for the bundle activity filter.
  const bundleQbStart = (bundle: AuditProduct): number => {
    const components = parentToComponents.get(bundle.id) || [];
    const rollup = components.filter(({ component_id }) => productById.get(component_id)?.sku?.endsWith("-F"));
    if (rollup.length === 0) return 0;
    return Math.min(...rollup.map(({ component_id, quantity }) => Math.floor((inp.qbInventory.get(component_id) || 0) / quantity)));
  };
  const compActualTotal = (compId: string): number => {
    const totalImplied = componentTotalImplied.get(compId) || 0;
    return Math.max(0, totalImplied + getChannelInventory(compId).total);
  };

  const bomComponents: VarianceRow[] = [];
  const seen = new Set<string>();
  for (const bundle of inp.products.filter((p) => p.item_type === "bundle")) {
    const components = parentToComponents.get(bundle.id) || [];
    // Bundle activity filter (route filters finished_goods_with_bom before Step 2 reads it):
    // keep iff finished_good_units>0 OR qb_starting>0 OR any component actual_total>0.
    const fgUnits = Math.max(0, getChannelInventory(bundle.id).total);
    const active = fgUnits > 0 || bundleQbStart(bundle) > 0 || components.some(({ component_id }) => compActualTotal(component_id) > 0);
    if (!active) continue;
    for (const { component_id } of components) {
      const comp = productById.get(component_id);
      if (!comp || seen.has(comp.id)) continue;
      seen.add(comp.id);
      const compQbStart = inp.qbInventory.get(comp.id) || 0;
      const compExpected = compQbStart - (componentTotalBurn.get(comp.id) || 0) + getReceived(comp.id);
      bomComponents.push({ product_id: comp.id, quickbooks_id: comp.quickbooks_id, variance: compActualTotal(comp.id) - compExpected });
    }
  }

  const standalone: VarianceRow[] = [];
  for (const p of inp.products) {
    if (p.item_type === "bundle" || componentIds.has(p.id)) continue;
    if (p.product_category === "component") continue; // unattached components → no adjustment
    const inv = getChannelInventory(p.id);
    const qbStart = inp.qbInventory.get(p.id) || 0;
    // standalone filter (route filters standalone_finished_goods): keep iff total>0 OR qb_starting>0.
    if (!(inv.total > 0 || qbStart > 0)) continue;
    const expected = qbStart - getSalesBurn(p.id).total_sold + getReceived(p.id);
    standalone.push({ product_id: p.id, quickbooks_id: p.quickbooks_id, variance: Math.max(0, inv.total) - expected });
  }
  return { bomComponents, standalone };
}

export interface AdjustmentLine { itemRef: string; qtyDiff: number; }

/** Build the InventoryAdjustment lines: round each variance to a whole unit, drop zeros,
 *  dedupe components (already deduped in the audit), BOM components first then standalone —
 *  mirroring the month-end-closing Step 2 ordering. */
export function buildInventoryAdjustmentLines(audit: AuditResult): AdjustmentLine[] {
  const lines: AdjustmentLine[] = [];
  for (const row of [...audit.bomComponents, ...audit.standalone]) {
    const rounded = Math.round(row.variance);
    if (rounded !== 0) lines.push({ itemRef: row.quickbooks_id, qtyDiff: rounded });
  }
  return lines;
}
