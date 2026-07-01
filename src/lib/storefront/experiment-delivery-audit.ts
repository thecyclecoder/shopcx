/**
 * Storefront experiment delivery audit — Phase 1 of
 * [[../../../docs/brain/specs/growth-storefront-experiment-delivery-verification.md]].
 *
 * Ground-truth that a `status='running' | 'promoted'` experiment is ACTUALLY being
 * served to real shoppers. Per the goal's audit invariant ("never trust a tool's
 * self-report"), the bandit refresh + Director brief should refuse to act on an
 * experiment whose status claims delivery but whose delivery signals are silent.
 *
 * Per experiment, the audit counts:
 *   (a) `storefront_sessions` rows whose `experiment_assignments` jsonb contains
 *       the experiment id, in the last `sinceMs` window, EXCLUDING `is_internal=true`
 *       and `is_bot=true` (the report-layer exclusion — internal/bot are stamped, just
 *       not counted). This is the canonical session-stamped attribution signal
 *       ([[../storefront/experiment-attribution]] § attribution spine).
 *   (b) `storefront_events` rows of `event_type='experiment_exposure'` whose `meta`
 *       contains the experiment id, in the same window. The pixel route already drops
 *       these for internal/bot sessions ([[../../app/api/pixel/route]] —
 *       `SKIP_FOR_INTERNAL_BOT`), so events on disk are already filtered.
 *
 * Verdict:
 *   • Younger than `MIN_AUDIT_AGE_HOURS` (default 6) → `delivered:null, flags:[]` —
 *     a freshly-promoted row that has had no traffic yet is NOT a delivery failure.
 *   • Otherwise, zero on BOTH counts → `delivered:false, flags:['failed_to_deliver']`.
 *   • Otherwise → `delivered:true, flags:[]`.
 *
 * Pure read. The Phase-2 sweep ([[../inngest/storefront-experiments]]) hooks this into
 * the refresh to stamp `last_decision.delivery_flag` + emit a `director_activity` row.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export const MIN_AUDIT_AGE_HOURS = 6;
export const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;

export type DeliveryFlag = "failed_to_deliver";

export interface ExperimentDeliveryAuditRow {
  experiment_id: string;
  lander_type: string;
  sessions_count: number;
  exposures_count: number;
  /** `null` when the experiment is younger than `MIN_AUDIT_AGE_HOURS` (excluded from
   *  the delivery verdict); otherwise `true` if at least one signal landed, `false`
   *  on a zero-on-both with the experiment older than the floor. */
  delivered: boolean | null;
  flags: DeliveryFlag[];
}

/** Pure verdict from the two delivery counts + experiment age. Extracted so the unit
 *  test can exercise the three cases the spec names without stubbing Supabase. */
export function computeDeliveryVerdict(input: {
  sessionsCount: number;
  exposuresCount: number;
  hoursSinceStart: number;
  minAuditAgeHours?: number;
}): { delivered: boolean | null; flags: DeliveryFlag[] } {
  const floor = input.minAuditAgeHours ?? MIN_AUDIT_AGE_HOURS;
  if (input.hoursSinceStart < floor) return { delivered: null, flags: [] };
  if (input.sessionsCount === 0 && input.exposuresCount === 0) {
    return { delivered: false, flags: ["failed_to_deliver"] };
  }
  return { delivered: true, flags: [] };
}

interface ExperimentRow {
  id: string;
  lander_type: string;
  started_at: string | null;
  created_at: string;
}

/**
 * Audit delivery of every `status='running' | 'promoted'` experiment for a workspace.
 * Returns ONE row per experiment, in input order — never silently drops one (the
 * Phase-1 verification asserts this against the live workspace).
 */
export async function auditExperimentDelivery(
  admin: Admin,
  opts: { workspaceId: string; sinceMs?: number; nowMs?: number; minAuditAgeHours?: number },
): Promise<ExperimentDeliveryAuditRow[]> {
  const sinceMs = opts.sinceMs ?? DEFAULT_SINCE_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const minAuditAgeHours = opts.minAuditAgeHours ?? MIN_AUDIT_AGE_HOURS;
  const since = new Date(nowMs - sinceMs).toISOString();

  const { data: experiments } = await admin
    .from("storefront_experiments")
    .select("id, lander_type, started_at, created_at")
    .eq("workspace_id", opts.workspaceId)
    .in("status", ["running", "promoted"]);

  const rows = (experiments as ExperimentRow[] | null) || [];
  const out: ExperimentDeliveryAuditRow[] = [];
  for (const exp of rows) {
    const startedAt = exp.started_at ?? exp.created_at;
    const hoursSinceStart = startedAt ? (nowMs - new Date(startedAt).getTime()) / 3_600_000 : Infinity;

    const [sessionsCount, exposuresCount] = await Promise.all([
      countStampedSessions(admin, opts.workspaceId, exp.id, since),
      countExposureEvents(admin, opts.workspaceId, exp.id, since),
    ]);

    const verdict = computeDeliveryVerdict({ sessionsCount, exposuresCount, hoursSinceStart, minAuditAgeHours });
    out.push({
      experiment_id: exp.id,
      lander_type: exp.lander_type,
      sessions_count: sessionsCount,
      exposures_count: exposuresCount,
      delivered: verdict.delivered,
      flags: verdict.flags,
    });
  }
  return out;
}

async function countStampedSessions(
  admin: Admin,
  workspaceId: string,
  experimentId: string,
  since: string,
): Promise<number> {
  const { count } = await admin
    .from("storefront_sessions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("is_internal", false)
    .eq("is_bot", false)
    .gte("created_at", since)
    .contains("experiment_assignments", JSON.stringify([{ experiment_id: experimentId }]));
  return count ?? 0;
}

async function countExposureEvents(
  admin: Admin,
  workspaceId: string,
  experimentId: string,
  since: string,
): Promise<number> {
  const { count } = await admin
    .from("storefront_events")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("event_type", "experiment_exposure")
    .gte("created_at", since)
    .contains("meta", { experiment_id: experimentId });
  return count ?? 0;
}

export interface UndeliveredExperiment {
  experiment_id: string;
  lander_type: string;
  status: string;
  started_at: string | null;
  hours_since_start: number | null;
  promoted_variant_id: string | null;
  last_decision: Record<string, unknown> | null;
}

/**
 * Director-brief reader — every running/promoted experiment whose `last_decision.delivery_flag`
 * the Phase-2 sweep stamped `failed_to_deliver`. Returns enough context for the brief to
 * surface the failure: experiment id + lander_type, age in hours, the variant the system
 * last tried to serve (`promoted_variant_id`, null for a multi-arm running experiment), and
 * the prior decision snapshot. Pure read; never throws.
 */
export async function loadUndeliveredExperiments(
  admin: Admin,
  workspaceId: string,
  opts?: { nowMs?: number },
): Promise<UndeliveredExperiment[]> {
  const nowMs = opts?.nowMs ?? Date.now();
  const { data } = await admin
    .from("storefront_experiments")
    .select("id, lander_type, status, started_at, created_at, promoted_variant_id, last_decision")
    .eq("workspace_id", workspaceId)
    .in("status", ["running", "promoted"])
    .eq("last_decision->>delivery_flag", "failed_to_deliver");

  const rows = (data as
    | {
        id: string;
        lander_type: string;
        status: string;
        started_at: string | null;
        created_at: string;
        promoted_variant_id: string | null;
        last_decision: Record<string, unknown> | null;
      }[]
    | null) ?? [];
  return rows.map((r) => {
    const startedAt = r.started_at ?? r.created_at;
    const hours = startedAt ? (nowMs - new Date(startedAt).getTime()) / 3_600_000 : null;
    return {
      experiment_id: r.id,
      lander_type: r.lander_type,
      status: r.status,
      started_at: r.started_at,
      hours_since_start: hours,
      promoted_variant_id: r.promoted_variant_id,
      last_decision: r.last_decision,
    };
  });
}
