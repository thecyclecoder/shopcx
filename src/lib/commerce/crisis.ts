/**
 * commerce/crisis.ts — Display ops for out-of-stock crises.
 *
 * A crisis is an event ([[../../docs/brain/tables/crisis_events]]) + per-customer
 * tier state ([[../../docs/brain/tables/crisis_customer_actions]]) — the Display
 * op rolls them into one view so surfaces don't re-join. See
 * [[../../docs/brain/lifecycles/crisis-campaign]].
 *
 * Ships with zero call-site consumers — the M3 harness compares parity before
 * any surface migrates.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { CrisisView, CrisisContextView, CrisisCustomerActionView } from "./types";

export type { CrisisView, CrisisCustomerActionView, CrisisContextView } from "./types";

const CRISIS_COLUMNS =
  "id, workspace_id, name, status, affected_variant_id, affected_sku, affected_product_title, default_swap_variant_id, tier2_coupon_code, tier2_coupon_percent, expected_restock_date, lead_time_days, tier_wait_days, created_at";

const CRISIS_ACTION_COLUMNS =
  "id, crisis_id, workspace_id, subscription_id, customer_id, segment, current_tier, tier1_sent_at, tier1_response, tier2_sent_at, original_item";

interface RawCrisisRow {
  id: string;
  workspace_id: string;
  name: string | null;
  status: string | null;
  affected_variant_id: string | null;
  affected_sku: string | null;
  affected_product_title: string | null;
  default_swap_variant_id: string | null;
  tier2_coupon_code: string | null;
  tier2_coupon_percent: number | null;
  expected_restock_date: string | null;
  lead_time_days: number | null;
  tier_wait_days: number | null;
  created_at: string;
}

interface RawActionRow {
  id: string;
  crisis_id: string;
  workspace_id: string;
  subscription_id: string | null;
  customer_id: string | null;
  segment: string | null;
  current_tier: number | null;
  tier1_sent_at: string | null;
  tier1_response: string | null;
  tier2_sent_at: string | null;
  original_item: Record<string, unknown> | null;
}

function buildAction(row: RawActionRow): CrisisCustomerActionView {
  return {
    id: row.id,
    crisis_id: row.crisis_id,
    workspace_id: row.workspace_id,
    subscription_id: row.subscription_id,
    customer_id: row.customer_id,
    segment: row.segment ?? "",
    current_tier: Number(row.current_tier ?? 0),
    tier1_sent_at: row.tier1_sent_at,
    tier1_response: row.tier1_response,
    tier2_sent_at: row.tier2_sent_at,
    original_item: row.original_item,
  };
}

function buildCrisis(
  row: RawCrisisRow,
  actions: CrisisCustomerActionView[],
): CrisisView {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name ?? "",
    status: row.status ?? "draft",
    affected_variant_id: row.affected_variant_id ?? "",
    affected_sku: row.affected_sku,
    affected_product_title: row.affected_product_title,
    default_swap_variant_id: row.default_swap_variant_id,
    tier2_coupon_code: row.tier2_coupon_code,
    tier2_coupon_percent: Number(row.tier2_coupon_percent ?? 0),
    expected_restock_date: row.expected_restock_date,
    lead_time_days: Number(row.lead_time_days ?? 7),
    tier_wait_days: Number(row.tier_wait_days ?? 3),
    actions,
    created_at: row.created_at,
  };
}

/**
 * Per-customer crisis context — every crisis affecting the customer PLUS
 * their per-crisis tier state. Reads
 * [[../../docs/brain/tables/crisis_customer_actions]] for the customer, then
 * hydrates each linked [[../../docs/brain/tables/crisis_events]] with its
 * action rows.
 */
export async function getCrisisContext(
  workspaceId: string,
  customerId: string,
): Promise<CrisisContextView> {
  const admin = createAdminClient();
  const { data: actions, error: actErr } = await admin
    .from("crisis_customer_actions")
    .select(CRISIS_ACTION_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId);
  if (actErr) throw actErr;
  const actionRows = (actions ?? []) as RawActionRow[];
  if (actionRows.length === 0) {
    return { workspace_id: workspaceId, customer_id: customerId, crises: [] };
  }

  const crisisIds = Array.from(new Set(actionRows.map((a) => a.crisis_id)));
  const { data: crises, error: crisErr } = await admin
    .from("crisis_events")
    .select(CRISIS_COLUMNS)
    .eq("workspace_id", workspaceId)
    .in("id", crisisIds);
  if (crisErr) throw crisErr;
  const crisisRows = (crises ?? []) as RawCrisisRow[];

  const actionsByCrisis = new Map<string, CrisisCustomerActionView[]>();
  for (const a of actionRows) {
    const view = buildAction(a);
    const arr = actionsByCrisis.get(a.crisis_id) ?? [];
    arr.push(view);
    actionsByCrisis.set(a.crisis_id, arr);
  }

  return {
    workspace_id: workspaceId,
    customer_id: customerId,
    crises: crisisRows.map((c) => buildCrisis(c, actionsByCrisis.get(c.id) ?? [])),
  };
}
