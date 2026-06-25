/**
 * Fleet spend governor — the SUPERVISOR on the metered-cost proxy ([[fleet-cost]]).
 *
 * Phase 1: the BUDGET-config side — read + upsert fleet_budgets rows.
 * Phase 2 (this file, added): runFleetSpendGovernor — reads each effective budget
 * against rollupFleetCost() and ESCALATES on overrun via approval-router (a live+
 * autonomous director, else the CEO inbox) + a director_activity row. Loop-guard
 * deduped on dashboard_notifications (one OPEN breach per lane at a time; the next
 * sweep re-surfaces it after the operator dismisses it but the breach persists).
 * NEVER auto-throttles or pauses a lane (operational-rules § North star). Phase 3
 * surfaces the spend-to-budget line.
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
import { rollupFleetCost, type FleetCostBucket } from "@/lib/fleet-cost";
import { resolveApproverLive, CEO } from "@/lib/agents/approval-router";
import { recordDirectorActivity } from "@/lib/director-activity";
import { APPROVAL_REQUEST_TYPE } from "@/lib/agents/inbox";

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
  /** auth.users.id of the editor — best-effort attribution. */
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

// ── Phase 2 — track spend-to-budget + escalate on overrun ──────────────────────────

/** A single breach detected this sweep — the bucket spend exceeded the budget ceiling on one axis. */
export interface FleetBudgetBreach {
  /** The budget that was breached. */
  budget: FleetBudget;
  /** The matched cost rollup bucket (by `kind` or `byFunction`, depending on scope). */
  bucket: FleetCostBucket;
  /** Token ceiling exceeded? */
  tokenOver: boolean;
  /** USD ceiling exceeded? Only ever true on buckets carrying genuine API-billed `usd_cents`. */
  usdOver: boolean;
  /** Stable per-lane key the dashboard_notifications dedup holds on. */
  dedupeKey: string;
  /** Human "how far over" used in the notification body + the activity ledger reason. */
  reason: string;
}

export interface FleetSpendGovernorResult {
  /** Distinct (scope, key) budgets evaluated this run. */
  evaluated: number;
  /** Budgets currently OVER (a token OR usd ceiling exceeded). */
  breaches: number;
  /** Newly-emitted escalations (a notification + a director_activity row written). */
  escalations: number;
  /** Already-open breaches whose notification was bumped (no new escalation, no re-page). */
  reSurfaced: number;
  /** Per-breach details (for the cron heartbeat + the test verification). */
  details: FleetBudgetBreach[];
}

/** The dashboard_notifications metadata blob carried on a fleet-budget-breach escalation. */
interface BreachNotifMeta {
  routed_to_function: string;
  raised_by_function: string;
  escalated_by_director: string;
  escalation_kind: "fleet_budget_breach";
  escalation_reason: string;
  dedupe_key: string;
  deep_link: string;
  approve_action_id: null;
  /** The scope axis the breach is on — `kind` or `owner_function`. */
  breach_scope: BudgetScope;
  /** The lane/function key that breached. */
  breach_key: string;
  /** Token usage in the window (always recorded, even when only `$` overran). */
  tokens_used: number;
  token_ceiling: number | null;
  /** `$` cents in the window — null on Max-only buckets where no API-billed row contributed. */
  usd_cents_used: number | null;
  usd_ceiling_cents: number | null;
}

/** Build the per-breach reason string used by both the notification body + the activity ledger. */
function breachReason(breach: { budget: FleetBudget; bucket: FleetCostBucket; tokenOver: boolean; usdOver: boolean }): string {
  const b = breach.budget;
  const lane = b.kind ? `kind=${b.kind}` : `function=${b.ownerFunction}`;
  const parts: string[] = [];
  if (breach.tokenOver && b.tokenCeiling != null) {
    const pct = Math.round((breach.bucket.total_tokens / b.tokenCeiling) * 100);
    parts.push(`tokens ${breach.bucket.total_tokens.toLocaleString()} / ceiling ${b.tokenCeiling.toLocaleString()} (${pct}%)`);
  }
  if (breach.usdOver && b.usdCeilingCents != null && breach.bucket.usd_cents != null) {
    const pct = Math.round((breach.bucket.usd_cents / b.usdCeilingCents) * 100);
    parts.push(`$${(breach.bucket.usd_cents / 100).toFixed(2)} / ceiling $${(b.usdCeilingCents / 100).toFixed(2)} (${pct}%)`);
  }
  return `Fleet budget breach: ${lane} over its ${b.windowDays}d ceiling — ${parts.join(" · ")}.`;
}

/** Deep-link target for a breach — the Control Tower spend line surfaces in Phase 3. */
const BREACH_DEEP_LINK = "/dashboard/developer/control-tower";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Surface one budget breach to the routed approver's inbox + the director_activity ledger.
 * Loop-guarded: while an undismissed notification exists for the same `dedupeKey`, no new
 * row + no new activity entry are written (the existing notification's body/title are bumped
 * so a fresh sweep refreshes "how far over" without spamming). Once dismissed, a persistent
 * breach re-surfaces on the next sweep — mirrors the control-tower dedup-while-red pattern.
 */
async function escalateBudgetBreach(
  admin: Admin,
  args: { workspaceId: string; breach: FleetBudgetBreach; routedTo: string },
): Promise<{ emitted: boolean; reSurfaced: boolean }> {
  const { workspaceId, breach, routedTo } = args;
  const title = `Fleet budget breach: ${breach.budget.kind ?? breach.budget.ownerFunction}`.slice(0, 200);
  const body = breach.reason.slice(0, 4000);
  const meta: BreachNotifMeta = {
    routed_to_function: routedTo,
    raised_by_function: "platform",
    escalated_by_director: "platform",
    escalation_kind: "fleet_budget_breach",
    escalation_reason: breach.reason.slice(0, 2000),
    dedupe_key: breach.dedupeKey,
    deep_link: BREACH_DEEP_LINK,
    approve_action_id: null,
    breach_scope: breach.budget.kind ? "kind" : "owner_function",
    breach_key: (breach.budget.kind ?? breach.budget.ownerFunction) as string,
    tokens_used: breach.bucket.total_tokens,
    token_ceiling: breach.budget.tokenCeiling,
    usd_cents_used: breach.bucket.usd_cents,
    usd_ceiling_cents: breach.budget.usdCeilingCents,
  };

  // Loop-guard: an OPEN (undismissed) notification with the same dedupe_key already represents
  // this breach — bump its body/title to refresh the "how far over" snapshot, but emit NO new
  // notification + write NO new activity row (the spec's "one open breach per lane at a time").
  const { data: open } = await admin
    .from("dashboard_notifications")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("type", APPROVAL_REQUEST_TYPE)
    .eq("metadata->>dedupe_key", breach.dedupeKey)
    .eq("dismissed", false)
    .limit(1);
  if ((open ?? []).length > 0) {
    await admin
      .from("dashboard_notifications")
      .update({ title, body, metadata: meta })
      .eq("id", (open as Array<{ id: string }>)[0].id);
    return { emitted: false, reSurfaced: true };
  }

  // No open notification — emit. Notification FIRST (checked) so the audit ledger never claims
  // an escalation the inbox never showed (mirrors escalateDiagnosisToCeo's reliability order).
  const { error: notifErr } = await admin.from("dashboard_notifications").insert({
    workspace_id: workspaceId,
    type: APPROVAL_REQUEST_TYPE,
    title,
    body,
    link: BREACH_DEEP_LINK,
    metadata: meta,
    read: false,
    dismissed: false,
  });
  if (notifErr) {
    console.warn(`[fleet-spend-governor] dashboard_notifications insert failed for ${breach.dedupeKey}: ${notifErr.message}`);
    return { emitted: false, reSurfaced: false };
  }

  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: "platform",
    actionKind: "budget_breach",
    specSlug: null,
    reason: breach.reason,
    metadata: {
      escalation_kind: "fleet_budget_breach",
      dedupe_key: breach.dedupeKey,
      routed_to_function: routedTo,
      breach_scope: meta.breach_scope,
      breach_key: meta.breach_key,
      tokens_used: meta.tokens_used,
      token_ceiling: meta.token_ceiling,
      usd_cents_used: meta.usd_cents_used,
      usd_ceiling_cents: meta.usd_ceiling_cents,
      window_days: breach.budget.windowDays,
      autonomous: true,
    },
  });
  return { emitted: true, reSurfaced: false };
}

/**
 * Read the EFFECTIVE budgets visible to one workspace, the cost rollup over each budget's window,
 * and ESCALATE any lane/function over its ceiling — once. Loop-guarded: a still-open breach
 * notification suppresses re-emit (its body is bumped instead). NEVER throttles or pauses a lane.
 *
 * The workspace-scoped pass mirrors how every other box cron iterates build-console workspaces;
 * the cron caller (inngest/fleet-spend-governor) sweeps each workspace in turn.
 */
export async function runFleetSpendGovernor({ workspaceId }: { workspaceId: string }): Promise<FleetSpendGovernorResult> {
  const admin = createAdminClient();

  // Effective budgets — global defaults UNION the workspace's overrides; pick the most-specific row
  // per (scope, key). Mirrors getEffectiveBudget's "workspace beats default" but for the whole set.
  const all = await listFleetBudgets(workspaceId);
  type ScopeKey = string; // "kind:<value>" | "fn:<value>"
  const effective = new Map<ScopeKey, FleetBudget>();
  for (const b of all) {
    const sk: ScopeKey = b.kind ? `kind:${b.kind}` : `fn:${b.ownerFunction}`;
    const cur = effective.get(sk);
    if (!cur || (b.workspaceId && !cur.workspaceId)) effective.set(sk, b);
  }
  if (effective.size === 0) return { evaluated: 0, breaches: 0, escalations: 0, reSurfaced: 0, details: [] };

  // Roll up cost per DISTINCT window — most deployments use the seeded 7-day default so this is one
  // round-trip; a workspace with a custom window adds at most one more.
  const windowDays = new Set<number>();
  for (const b of effective.values()) windowDays.add(b.windowDays);
  const rollupsByWindow = new Map<number, Awaited<ReturnType<typeof rollupFleetCost>>>();
  for (const w of windowDays) {
    rollupsByWindow.set(w, await rollupFleetCost({ workspaceId, sinceDays: w }));
  }

  // Walk each effective budget; detect breaches; collect for the escalation pass.
  const details: FleetBudgetBreach[] = [];
  for (const b of effective.values()) {
    const rollup = rollupsByWindow.get(b.windowDays);
    if (!rollup) continue;
    const buckets = b.kind ? rollup.byKind : rollup.byFunction;
    const value = (b.kind ?? b.ownerFunction) as string;
    const bucket = buckets.find((x) => x.key === value);
    if (!bucket) continue; // no spend on this lane/function in the window — not a breach
    const tokenOver = b.tokenCeiling != null && bucket.total_tokens > b.tokenCeiling;
    const usdOver = b.usdCeilingCents != null && bucket.usd_cents != null && bucket.usd_cents > b.usdCeilingCents;
    if (!tokenOver && !usdOver) continue;
    const scope: BudgetScope = b.kind ? "kind" : "owner_function";
    const dedupeKey = `fleet_budget_breach:${scope}:${value}`;
    const partial = { budget: b, bucket, tokenOver, usdOver };
    details.push({ ...partial, dedupeKey, reason: breachReason(partial) });
  }

  if (details.length === 0) return { evaluated: effective.size, breaches: 0, escalations: 0, reSurfaced: 0, details };

  // Approval routing — one resolve (it's invariant for the governor's "platform" raise) reused per breach.
  // resolveApproverLive returns 'platform' iff live+autonomous, else falls through to the CEO.
  const routedTo = await resolveApproverLive("platform");

  let escalations = 0;
  let reSurfaced = 0;
  for (const breach of details) {
    const r = await escalateBudgetBreach(admin, { workspaceId, breach, routedTo });
    if (r.emitted) escalations++;
    else if (r.reSurfaced) reSurfaced++;
  }
  return { evaluated: effective.size, breaches: details.length, escalations, reSurfaced, details };
}

/** The seat the governor routes to right now — exported so the cron / dashboards can show "routed to X". */
export async function resolveFleetSpendApprover(): Promise<string> {
  return resolveApproverLive("platform");
}

/** Re-export the CEO sentinel so callers don't have to import approval-router separately. */
export { CEO as FLEET_SPEND_CEO_FALLBACK };
