/**
 * Fleet spend governor — the SUPERVISOR on the metered-cost proxy ([[fleet-cost]]).
 *
 * Phase 1 (this file): the BUDGET-config side — read + upsert fleet_budgets rows.
 * Phase 2 will read these vs. rollupFleetCost() and ESCALATE on a trending overrun
 * (per the north star: an autonomous tool hits its rail → routes UP to its supervisor,
 * never auto-throttles a lane). Phase 3 surfaces the spend-to-budget line.
 *
 * Two scope axes — exactly ONE per row (DB-enforced):
 *   - kind: an agent_jobs.kind lane (e.g. 'build', 'spec-chat')
 *   - owner_function: an org-chart function envelope (e.g. 'platform', 'cs')
 *
 * Units mirror docs/brain/libraries/fleet-cost.ts:
 *   - tokens (the honest Max-lane proxy — Max lanes carry no per-token $)
 *   - usd_cents (only meaningful where genuinely API-billed rows contribute)
 *
 * Read-only over the cost rollup — this surface NEVER mutates cost data and NEVER
 * caps / parks / kills a lane. It expresses INTENT (the ceiling); Phase 2 reads it.
 */
import { createAdminClient } from "@/lib/supabase/admin";

/** Scope axis — DB constraint enforces exactly one is set per row. */
export type BudgetScope = "kind" | "owner_function";

export interface FleetBudget {
  id: string;
  workspaceId: string | null;
  /** Set iff scope === 'kind' — the agent_jobs.kind this budget caps. */
  kind: string | null;
  /** Set iff scope === 'owner_function' — the org-chart function this budget envelopes. */
  ownerFunction: string | null;
  /** Days the spend window is summed over (matches rollupFleetCost). Default 7. */
  windowDays: number;
  /** Token ceiling for the window — null = no token guardrail. */
  tokenCeiling: number | null;
  /** USD ceiling in CENTS — null = no $ guardrail (the Max-lane default). */
  usdCeilingCents: number | null;
  notes: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertBudgetParams {
  workspaceId?: string | null;
  /** Either `kind` OR `ownerFunction` — supply exactly one. */
  kind?: string | null;
  ownerFunction?: string | null;
  windowDays?: number;
  tokenCeiling?: number | null;
  usdCeilingCents?: number | null;
  notes?: string | null;
  /** workspace_members.user_id of the editor — best-effort attribution. */
  updatedBy?: string | null;
}

interface BudgetRow {
  id: string;
  workspace_id: string | null;
  kind: string | null;
  owner_function: string | null;
  window_days: number;
  token_ceiling: number | string | null; // bigint round-trips as string from PostgREST
  usd_ceiling_cents: number | string | null; // numeric round-trips as string
  notes: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

function toBudget(row: BudgetRow): FleetBudget {
  const tc = row.token_ceiling;
  const uc = row.usd_ceiling_cents;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    ownerFunction: row.owner_function,
    windowDays: row.window_days,
    tokenCeiling: tc == null ? null : typeof tc === "string" ? Number(tc) : tc,
    usdCeilingCents: uc == null ? null : typeof uc === "string" ? Number(uc) : uc,
    notes: row.notes,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * List every fleet_budgets row visible to the given workspace — the global defaults
 * (workspace_id IS NULL) UNION the workspace's overrides. The Phase 2 governor picks
 * the most-specific row (workspace override beats global default) per scope key.
 */
export async function listFleetBudgets(workspaceId?: string | null): Promise<FleetBudget[]> {
  const admin = createAdminClient();
  let q = admin.from("fleet_budgets").select("*");
  if (workspaceId) {
    // The OR encodes "global default (NULL ws) OR this workspace's row".
    q = q.or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`);
  }
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map((r) => toBudget(r as BudgetRow));
}

/**
 * The EFFECTIVE budget for a (workspace, scope, value) tuple — workspace override if
 * present, else the global default. Returns null when neither exists.
 */
export async function getEffectiveBudget(
  workspaceId: string | null,
  scope: BudgetScope,
  value: string,
): Promise<FleetBudget | null> {
  const admin = createAdminClient();
  const col = scope === "kind" ? "kind" : "owner_function";
  let q = admin.from("fleet_budgets").select("*").eq(col, value);
  if (workspaceId) {
    q = q.or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`);
  } else {
    q = q.is("workspace_id", null);
  }
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data || []).map((r) => toBudget(r as BudgetRow));
  if (!rows.length) return null;
  // workspace-specific beats global default
  return rows.sort((a, b) => (a.workspaceId ? -1 : 1) - (b.workspaceId ? -1 : 1))[0];
}

/**
 * Owner-editable upsert. The on-conflict target is (workspace_id, kind) for kind-scoped
 * budgets and (workspace_id, owner_function) for function-scoped budgets — matched by the
 * partial unique indexes defined in the migration. Supply exactly ONE of (kind, ownerFunction).
 */
export async function upsertFleetBudget(p: UpsertBudgetParams): Promise<FleetBudget> {
  if (!p.kind && !p.ownerFunction) {
    throw new Error("upsertFleetBudget: supply exactly one of (kind, ownerFunction)");
  }
  if (p.kind && p.ownerFunction) {
    throw new Error("upsertFleetBudget: supply exactly one of (kind, ownerFunction) — not both");
  }
  const admin = createAdminClient();
  const row: Record<string, unknown> = {
    workspace_id: p.workspaceId ?? null,
    kind: p.kind ?? null,
    owner_function: p.ownerFunction ?? null,
    window_days: p.windowDays ?? 7,
    token_ceiling: p.tokenCeiling ?? null,
    usd_ceiling_cents: p.usdCeilingCents ?? null,
    notes: p.notes ?? null,
    updated_by: p.updatedBy ?? null,
  };
  // No PostgREST `upsert` with a partial unique index — do it as SELECT + INSERT/UPDATE.
  const scopeCol = p.kind ? "kind" : "owner_function";
  const scopeVal = (p.kind ?? p.ownerFunction) as string;
  let lookup = admin.from("fleet_budgets").select("id").eq(scopeCol, scopeVal);
  lookup = p.workspaceId ? lookup.eq("workspace_id", p.workspaceId) : lookup.is("workspace_id", null);
  const { data: existing, error: lookupErr } = await lookup.maybeSingle();
  if (lookupErr) throw lookupErr;
  if (existing) {
    const { data, error } = await admin
      .from("fleet_budgets")
      .update(row)
      .eq("id", (existing as { id: string }).id)
      .select("*")
      .single();
    if (error) throw error;
    return toBudget(data as BudgetRow);
  }
  const { data, error } = await admin.from("fleet_budgets").insert(row).select("*").single();
  if (error) throw error;
  return toBudget(data as BudgetRow);
}

/**
 * Delete one budget (an owner pruning a stale guardrail). Returns true on a delete,
 * false when the row didn't exist.
 */
export async function deleteFleetBudget(id: string): Promise<boolean> {
  const admin = createAdminClient();
  const { error, count } = await admin.from("fleet_budgets").delete({ count: "exact" }).eq("id", id);
  if (error) throw error;
  return (count ?? 0) > 0;
}
