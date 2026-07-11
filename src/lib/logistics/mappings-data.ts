import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

// Read-only view of the qb_* SKU resolver: per finished good / bundle / component,
// resolve which external SKUs (Amazon ASIN, 3PL, Shopify, manual) map onto it and
// list its BOM components. Powers /dashboard/logistics/mappings.
//
// Every read is paginated (.range() loop) because PostgREST silently caps `.select()`
// at 1000 rows; the qb_* tables run into that (measured 2026-07: qb_external_skus
// approaches the cap once Shopify variants are indexed).

const PAGE = 1000;

/** Return every row for a workspace, paginating past the PostgREST 1000-row cap. */
async function paginate<T>(
  admin: SupabaseClient,
  table: string,
  columns: string,
  workspaceId: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from(table)
      .select(columns)
      .eq("workspace_id", workspaceId)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const chunk = (data ?? []) as T[];
    out.push(...chunk);
    if (chunk.length < PAGE) return out;
  }
}

export interface MappingExternalRef {
  externalId: string;
  source: string;              // 'amazon' | '3pl' | 'shopify' | 'manual'
  label: string | null;        // qb_sku_mappings.label (fallback)
  unitMultiplier: number;
  active: boolean;
  // Joined from qb_external_skus (nullable — an id may not have a row yet)
  title: string | null;
  imageUrl: string | null;
  sellerSku: string | null;
}

export interface MappingBomComponent {
  componentQbId: string;       // qb_items.id
  componentName: string;
  componentSku: string | null;
  quantity: number;
}

export interface MappingItemView {
  qbId: string;                // qb_items.id
  quickbooksId: string;        // qb_items.quickbooks_id (the numeric QBO id)
  name: string;                // qb_items.quickbooks_name
  sku: string | null;
  category: string | null;
  itemType: string;            // 'inventory' | 'bundle'
  productCategory: string | null; // 'finished_good' | 'component' | null
  imageUrl: string | null;
  active: boolean;
  externalRefsBySource: Record<string, MappingExternalRef[]>;
  bom: MappingBomComponent[];
  totalExternalRefs: number;
}

export interface MappingsView {
  items: MappingItemView[];
  counts: {
    qbItems: number;
    activeMappings: number;
    externalSkus: number;
    bomEdges: number;
  };
}

/** Read the qb_* mapping tables read-only and shape them into a per-item view. */
export async function loadMappings(workspaceId: string, admin?: SupabaseClient): Promise<MappingsView> {
  const client = admin ?? createAdminClient();

  const [items, mappings, extSkus, bom] = await Promise.all([
    paginate<{
      id: string;
      quickbooks_id: string;
      quickbooks_name: string;
      sku: string | null;
      category: string | null;
      item_type: string;
      product_category: string | null;
      image_url: string | null;
      active: boolean | null;
    }>(client, "qb_items", "id, quickbooks_id, quickbooks_name, sku, category, item_type, product_category, image_url, active", workspaceId),
    paginate<{
      product_id: string;
      external_id: string;
      source: string;
      label: string | null;
      unit_multiplier: number;
      active: boolean;
    }>(client, "qb_sku_mappings", "product_id, external_id, source, label, unit_multiplier, active", workspaceId),
    paginate<{
      external_id: string;
      source: string;
      title: string | null;
      image_url: string | null;
      seller_sku: string | null;
    }>(client, "qb_external_skus", "external_id, source, title, image_url, seller_sku", workspaceId),
    paginate<{
      parent_id: string;
      component_id: string;
      quantity: number;
    }>(client, "qb_item_bom", "parent_id, component_id, quantity", workspaceId),
  ]);

  // external_id + source → row (the join key for the mapping resolver).
  const extBy = new Map<string, { title: string | null; imageUrl: string | null; sellerSku: string | null }>();
  for (const e of extSkus) {
    extBy.set(`${e.source}::${e.external_id}`, { title: e.title, imageUrl: e.image_url, sellerSku: e.seller_sku });
  }
  const itemById = new Map(items.map((i) => [i.id, i]));

  // qb_items.id → external-refs grouped by source
  const refsByItem = new Map<string, MappingExternalRef[]>();
  let activeMappings = 0;
  for (const m of mappings) {
    if (m.active) activeMappings++;
    const ref: MappingExternalRef = {
      externalId: m.external_id,
      source: m.source,
      label: m.label,
      unitMultiplier: m.unit_multiplier,
      active: m.active,
      title: null,
      imageUrl: null,
      sellerSku: null,
    };
    const ext = extBy.get(`${m.source}::${m.external_id}`);
    if (ext) { ref.title = ext.title; ref.imageUrl = ext.imageUrl; ref.sellerSku = ext.sellerSku; }
    const arr = refsByItem.get(m.product_id);
    if (arr) arr.push(ref); else refsByItem.set(m.product_id, [ref]);
  }

  // qb_items.id → BOM components (resolved into names / skus)
  const bomByItem = new Map<string, MappingBomComponent[]>();
  for (const b of bom) {
    const c = itemById.get(b.component_id);
    const comp: MappingBomComponent = {
      componentQbId: b.component_id,
      componentName: c?.quickbooks_name ?? b.component_id,
      componentSku: c?.sku ?? null,
      quantity: b.quantity,
    };
    const arr = bomByItem.get(b.parent_id);
    if (arr) arr.push(comp); else bomByItem.set(b.parent_id, [comp]);
  }

  // Sort: finished-goods + bundles first, then the rest, alpha within a group.
  const rank = (i: (typeof items)[number]) => {
    if (i.product_category === "finished_good") return 0;
    if (i.item_type === "bundle") return 1;
    if (i.product_category === "component") return 2;
    return 3;
  };
  const sorted = [...items].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return (a.quickbooks_name ?? "").localeCompare(b.quickbooks_name ?? "");
  });

  const itemViews: MappingItemView[] = sorted.map((i) => {
    const refs = refsByItem.get(i.id) ?? [];
    const bySource: Record<string, MappingExternalRef[]> = {};
    for (const r of refs) (bySource[r.source] ??= []).push(r);
    for (const src of Object.keys(bySource)) {
      bySource[src].sort((a, b) => (a.externalId ?? "").localeCompare(b.externalId ?? ""));
    }
    return {
      qbId: i.id,
      quickbooksId: i.quickbooks_id,
      name: i.quickbooks_name,
      sku: i.sku,
      category: i.category,
      itemType: i.item_type,
      productCategory: i.product_category,
      imageUrl: i.image_url,
      active: i.active !== false,
      externalRefsBySource: bySource,
      bom: bomByItem.get(i.id) ?? [],
      totalExternalRefs: refs.length,
    };
  });

  return {
    items: itemViews,
    counts: {
      qbItems: items.length,
      activeMappings,
      externalSkus: extSkus.length,
      bomEdges: bom.length,
    },
  };
}
