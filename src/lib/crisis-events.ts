/**
 * crisis_events write SDK — the one place a crisis row is created or has its status flipped.
 *
 * Before this, the only creator was the dashboard POST route's inline insert, so an agent or script
 * that needed to stand up a crisis (2026-11-24: Sleep Gummies Berry at 0 on hand with 16 stuck orders)
 * had to hand-roll a raw `.from("crisis_events").insert(...)` (CLAUDE.md: raw `.from(...)` with no SDK
 * → STOP). The dashboard route and agents now share this chokepoint, so defaults and validation can't
 * drift between them.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient;

export interface CrisisSwapOption {
  title: string;
  variantId: string;
}

export interface CreateCrisisInput {
  name: string;
  affected_variant_id: string;
  affected_sku?: string | null;
  affected_product_title?: string | null;
  default_swap_variant_id?: string | null;
  default_swap_title?: string | null;
  available_flavor_swaps?: CrisisSwapOption[];
  available_product_swaps?: CrisisSwapOption[];
  tier2_coupon_code?: string | null;
  tier2_coupon_percent?: number | null;
  expected_restock_date?: string | null;
  lead_time_days?: number | null;
  tier_wait_days?: number | null;
}

export type CrisisStatus = "draft" | "active" | "resolved";

/** Defaults the dashboard form has always applied. Exported so a test can pin them. */
export const CRISIS_DEFAULTS = {
  status: "draft" as CrisisStatus,
  tier2_coupon_percent: 20,
  lead_time_days: 7,
  tier_wait_days: 3,
};

/**
 * PURE: validate + normalize a create input into the row we insert. Throws on a missing name or
 * affected variant (the two fields every downstream crisis reader keys on).
 */
export function buildCrisisRow(workspaceId: string, input: CreateCrisisInput): Record<string, unknown> {
  const name = (input.name ?? "").trim();
  const affected = String(input.affected_variant_id ?? "").trim();
  if (!workspaceId) throw new Error("createCrisisEvent: workspaceId is required");
  if (!name) throw new Error("createCrisisEvent: name is required");
  if (!affected) throw new Error("createCrisisEvent: affected_variant_id is required");
  return {
    workspace_id: workspaceId,
    name,
    status: CRISIS_DEFAULTS.status,
    affected_variant_id: affected,
    affected_sku: input.affected_sku || null,
    affected_product_title: input.affected_product_title || null,
    default_swap_variant_id: input.default_swap_variant_id || null,
    default_swap_title: input.default_swap_title || null,
    available_flavor_swaps: input.available_flavor_swaps || [],
    available_product_swaps: input.available_product_swaps || [],
    tier2_coupon_code: input.tier2_coupon_code || null,
    tier2_coupon_percent: input.tier2_coupon_percent ?? CRISIS_DEFAULTS.tier2_coupon_percent,
    expected_restock_date: input.expected_restock_date || null,
    lead_time_days: input.lead_time_days ?? CRISIS_DEFAULTS.lead_time_days,
    tier_wait_days: input.tier_wait_days ?? CRISIS_DEFAULTS.tier_wait_days,
  };
}

/** Create a crisis in `draft`. Returns the inserted row. */
export async function createCrisisEvent(
  admin: Admin,
  workspaceId: string,
  input: CreateCrisisInput,
): Promise<Record<string, unknown>> {
  const row = buildCrisisRow(workspaceId, input);
  const { data, error } = await admin.from("crisis_events").insert(row).select().single();
  if (error) throw new Error(`createCrisisEvent: ${error.message}`);
  return data as Record<string, unknown>;
}

/**
 * Activate a draft crisis (draft → active). Compare-and-set on `status='draft'` so a crisis that was
 * already activated or resolved is never flipped back. Returns true when exactly this call moved it.
 * Resolving stays on the dashboard's `action=resolve` path, which also restores enrolled subs.
 */
export async function activateCrisisEvent(admin: Admin, workspaceId: string, crisisId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("crisis_events")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", crisisId)
    .eq("workspace_id", workspaceId)
    .eq("status", "draft")
    .select("id");
  if (error) throw new Error(`activateCrisisEvent: ${error.message}`);
  return ((data as unknown[]) ?? []).length === 1;
}
