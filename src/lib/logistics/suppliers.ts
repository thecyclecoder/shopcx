import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Suppliers + purchase-order-annotation SDK (Logistics M2). Durable metadata the accounting
// system doesn't hold: what kind of partner a vendor is, MOQ / lead override, and — crucially —
// the expected-arrival date on an open PO (QuickBooks leaves DueDate blank). MEASURED lead time
// + fill rate stay derived live from QB PO->Bill LinkedTxn (lead-times.ts) and are joined by
// qb_vendor_id; this never duplicates them. All writes go through the admin (service-role) client.

export interface Supplier {
  id: string;
  name: string;
  qbVendorId: string | null;
  kind: "manufacturer" | "component" | "3pl" | "other";
  leadDaysOverride: number | null;
  minOrderQty: number | null;
  notes: string | null;
  active: boolean;
}

export interface PoAnnotation {
  qbPoId: string;
  supplierId: string | null;
  expectedArrivalDate: string | null; // ISO date
  etaStatus: "estimated" | "confirmed" | "delayed" | "received" | null;
  note: string | null;
}

/** All active suppliers for a workspace, ordered by name. */
export async function listSuppliers(admin: SupabaseClient, workspaceId: string): Promise<Supplier[]> {
  const { data } = await admin
    .from("suppliers")
    .select("id, name, qb_vendor_id, kind, lead_days_override, min_order_qty, notes, active")
    .eq("workspace_id", workspaceId)
    .eq("active", true)
    .order("name");
  return (data ?? []).map((s) => ({
    id: s.id, name: s.name, qbVendorId: s.qb_vendor_id, kind: s.kind,
    leadDaysOverride: s.lead_days_override, minOrderQty: s.min_order_qty, notes: s.notes, active: s.active,
  }));
}

/** Upsert a supplier by (workspace, name). Returns the row id. */
export async function upsertSupplier(
  admin: SupabaseClient, workspaceId: string,
  s: { name: string; qbVendorId?: string | null; kind?: Supplier["kind"]; leadDaysOverride?: number | null; minOrderQty?: number | null; notes?: string | null; active?: boolean },
): Promise<string> {
  const { data, error } = await admin
    .from("suppliers")
    .upsert({
      workspace_id: workspaceId, name: s.name, qb_vendor_id: s.qbVendorId ?? null,
      kind: s.kind ?? "manufacturer", lead_days_override: s.leadDaysOverride ?? null,
      min_order_qty: s.minOrderQty ?? null, notes: s.notes ?? null, active: s.active ?? true,
      updated_at: new Date().toISOString(),
    }, { onConflict: "workspace_id,name" })
    .select("id").single();
  if (error) throw error;
  return data.id;
}

/** All PO annotations for a workspace, keyed by qb_po_id. */
export async function listPoAnnotations(admin: SupabaseClient, workspaceId: string): Promise<Map<string, PoAnnotation>> {
  const { data } = await admin
    .from("purchase_order_annotations")
    .select("qb_po_id, supplier_id, expected_arrival_date, eta_status, note")
    .eq("workspace_id", workspaceId);
  const m = new Map<string, PoAnnotation>();
  for (const a of data ?? []) m.set(a.qb_po_id, {
    qbPoId: a.qb_po_id, supplierId: a.supplier_id, expectedArrivalDate: a.expected_arrival_date,
    etaStatus: a.eta_status, note: a.note,
  });
  return m;
}

/** Upsert a PO annotation by (workspace, qb_po_id). */
export async function upsertPoAnnotation(
  admin: SupabaseClient, workspaceId: string,
  a: { qbPoId: string; supplierId?: string | null; expectedArrivalDate?: string | null; etaStatus?: PoAnnotation["etaStatus"]; note?: string | null },
): Promise<void> {
  const { error } = await admin
    .from("purchase_order_annotations")
    .upsert({
      workspace_id: workspaceId, qb_po_id: a.qbPoId, supplier_id: a.supplierId ?? null,
      expected_arrival_date: a.expectedArrivalDate ?? null, eta_status: a.etaStatus ?? null,
      note: a.note ?? null, updated_at: new Date().toISOString(),
    }, { onConflict: "workspace_id,qb_po_id" });
  if (error) throw error;
}
