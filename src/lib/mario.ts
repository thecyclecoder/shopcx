/**
 * mario — Mario's M3 SDK (detector cron's core). One deterministic call —
 * `evaluateStalledSpecs` — turns the M1 [[spec_timecard_events]] ledger + the M2
 * wait-span vocabulary + every spec's uncleared blockedBy into "is THIS spec
 * genuinely stalled?" candidates, and `enqueueMarioJob` files a kind='mario'
 * [[agent_jobs]] row (dedupe-guarded) so exactly one live mario job exists per
 * spec_slug at a time.
 *
 * Owns THE legit-wait discriminator: a spec is a STALL only when NOTHING is
 * blocking it — no uncleared blocker, no in-flight wait status on its active
 * job, and it isn't a folded row that stopped emitting events on purpose. Every
 * "drop" below is a legit wait, not a stall.
 *
 * Reads:
 *   - [[../../docs/brain/tables/mario_thresholds]] via the workspace-scoped SELECT —
 *     one `sla_ms` per (from_event, to_event) pair. The M4 self-tuner is the sole
 *     writer of `sla_ms`.
 *   - [[../../docs/brain/tables/spec_timecard_events]] via
 *     [[./spec-timecards]] `listStalledCandidates` per-threshold-row.
 *   - Each candidate's [[./brain-roadmap]] `getSpecBlockers` (uncleared → drop) +
 *     spec status (folded → drop).
 *   - The candidate's current active [[agent_jobs]] row (wait status → drop).
 *
 * Writes:
 *   - `enqueueMarioJob` INSERTs one row into [[agent_jobs]] (kind='mario') gated on
 *     "no active mario row for this spec_slug already exists".
 *
 * The cron in [[./inngest/mario-stall-cron]] wires these into the once-per-minute tick.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { listStalledCandidates } from "@/lib/spec-timecards";
import { getSpecBlockers } from "@/lib/brain-roadmap";
import { getSpec as getSpecFromDb } from "@/lib/specs-table";
import { ACTIVE_STATUSES } from "@/lib/agent-jobs";

type Admin = SupabaseClient;

/**
 * The threshold row shape — one per (workspace_id, from_event, to_event) in
 * [[../../docs/brain/tables/mario_thresholds]]. The evaluator reads every row for a
 * workspace and turns each into an `older_than_ms` input to `listStalledCandidates`.
 */
export interface MarioThreshold {
  workspace_id: string;
  from_event: string;
  to_event: string;
  sla_ms: number;
  min_count: number;
}

/**
 * The brief attached to every StalledCandidate — the payload the M4 reasoning
 * agent picks up off `agent_jobs.instructions` so it can reason WITHOUT
 * re-reading the ledger. Bounded (last 10 events).
 */
export interface MarioBrief {
  /** the last 10 [[spec_timecard_events]] rows for this spec, newest-first */
  last_events: Array<{
    event_kind: string;
    phase_index: number | null;
    actor: string;
    at: string;
    wait_kind: string | null;
    waiting_on: string | null;
  }>;
  /** every entry from [[./brain-roadmap]] `getSpecBlockers` — used by M4 to explain
   *  why THIS spec is a stall (every blocker cleared) rather than a legit wait */
  blocked_by_state: Array<{ slug: string; cleared: boolean }>;
  /** the current active [[agent_jobs]] row's status (or `null` when the spec has no
   *  live job) — set to a wait status only when M4 is about to look at a candidate
   *  that just transitioned; the evaluator's own filter would drop a wait status */
  current_job_status: string | null;
}

/**
 * One stalled spec surfaced by `evaluateStalledSpecs`. Carries which
 * (from_event, to_event) pair was overshot, the actual gap, the SLA it broke,
 * and the full MarioBrief so the M4 reasoning agent picks it up off
 * `agent_jobs.instructions` without another read.
 */
export interface StalledCandidate {
  workspace_id: string;
  spec_slug: string;
  from_event: string;
  to_event: string;
  gap_ms: number;
  sla_ms: number;
  brief: MarioBrief;
}

/**
 * The [[agent_jobs]] statuses that mean "there is already a live mario job on
 * this spec — do not enqueue another". Mirrors {@link ACTIVE_STATUSES} but is
 * inlined as a Set for the SELECT filter — the SDK owns Mario's dedupe
 * definition explicitly (a widened status set would silently skip stalls).
 */
export const ACTIVE_MARIO_STATUSES: ReadonlySet<string> = new Set(ACTIVE_STATUSES);

const BRIEF_EVENT_LIMIT = 10;

/**
 * Read every (from_event, to_event) threshold row for a workspace. The evaluator
 * makes one `listStalledCandidates` scan per row.
 */
async function readThresholds(admin: Admin, workspace_id?: string): Promise<MarioThreshold[]> {
  let q = admin
    .from("mario_thresholds")
    .select("workspace_id, from_event, to_event, sla_ms, min_count")
    .order("from_event", { ascending: true })
    .order("to_event", { ascending: true });
  if (workspace_id) q = q.eq("workspace_id", workspace_id);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    workspace_id: string;
    from_event: string;
    to_event: string;
    sla_ms: number | string;
    min_count: number;
  }>;
  // `sla_ms` is a bigint in Postgres; postgrest returns it as string OR number depending on client version.
  return rows.map((r) => ({
    workspace_id: r.workspace_id,
    from_event: r.from_event,
    to_event: r.to_event,
    sla_ms: typeof r.sla_ms === "string" ? Number.parseInt(r.sla_ms, 10) : r.sla_ms,
    min_count: r.min_count,
  }));
}

/**
 * Read the last N timecard events for a spec, newest-first. Powers the MarioBrief.
 */
async function readLastEvents(
  admin: Admin,
  workspace_id: string,
  spec_slug: string,
): Promise<MarioBrief["last_events"]> {
  const { data, error } = await admin
    .from("spec_timecard_events")
    .select("event_kind, phase_index, actor, at, wait_kind, waiting_on")
    .eq("workspace_id", workspace_id)
    .eq("spec_slug", spec_slug)
    .order("at", { ascending: false })
    .limit(BRIEF_EVENT_LIMIT);
  if (error) throw error;
  return (data ?? []) as MarioBrief["last_events"];
}

/**
 * Read the CURRENT active agent_jobs row for a spec (the live build/fold lane).
 * "Active" = any status in {@link ACTIVE_STATUSES}. `null` when nothing is live.
 */
async function readCurrentJobStatus(
  admin: Admin,
  workspace_id: string,
  spec_slug: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("agent_jobs")
    .select("status")
    .eq("workspace_id", workspace_id)
    .eq("spec_slug", spec_slug)
    .in("status", Array.from(ACTIVE_STATUSES))
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.status ?? null;
}

/**
 * The legit-wait discriminator's job-side statuses. A live job in ANY of these
 * is waiting on a real signal (a human answer, an approval, an upstream spec, or
 * usage reset) — DROP the candidate.
 */
const LEGIT_WAIT_JOB_STATUSES: ReadonlySet<string> = new Set([
  "blocked_on_dependency",
  "blocked_on_usage",
  "needs_input",
  "needs_approval",
]);

/**
 * `evaluateStalledSpecs` — the M3 detector cron's core. Returns EXACTLY the specs
 * whose next lifecycle step is genuinely overdue.
 *
 * Steps (mirrors the spec's a-e):
 *  (a) reads every mario_thresholds row for the workspace and, per row, calls
 *      `listStalledCandidates(admin, { older_than_ms: sla_ms })` — filtered to
 *      the candidates whose `last_event_kind === from_event`, so a stall against
 *      this threshold means "the last event WAS from_event and to_event has not
 *      landed within sla_ms".
 *  (b) DROPS a candidate whose `getSpecBlockers` shows any entry with
 *      `cleared:false` — an uncleared blocker is a legit wait (blockers gate a
 *      build; a gated build cannot stall by definition).
 *  (c) DROPS a candidate whose current active agent_jobs.status is in
 *      { blocked_on_dependency, blocked_on_usage, needs_input, needs_approval } —
 *      the job is intentionally paused; the ledger's silence is expected, not a
 *      stall.
 *  (d) DROPS a candidate whose spec status is `folded` (fold-cooldown) — a
 *      folded row stopped emitting events on purpose.
 *  (e) attaches a MarioBrief to every surviving candidate so the M4 reasoning
 *      agent picks up the last 10 events + blockedBy state + current job status
 *      without another read.
 *
 * Idempotent (read-only). Safe to call every minute from the cron.
 */
export async function evaluateStalledSpecs(
  admin: Admin,
  workspace_id?: string,
): Promise<StalledCandidate[]> {
  const thresholds = await readThresholds(admin, workspace_id);
  if (thresholds.length === 0) return [];

  // (a) per-threshold scans. Same `(workspace_id, spec_slug)` pair can surface
  // under multiple thresholds — first hit (in threshold read order) wins; a
  // subsequent hit for the same spec is dropped so the M4 lane never sees two
  // candidates for one spec.
  const seen = new Set<string>();
  const initial: StalledCandidate[] = [];
  for (const t of thresholds) {
    const rows = await listStalledCandidates(admin, {
      workspace_id: t.workspace_id,
      older_than_ms: t.sla_ms,
    });
    for (const r of rows) {
      // The threshold's `from_event` is the opening side — only surface the
      // candidate under this threshold when the LAST event equals `from_event`.
      // A stalled candidate whose last event is anything else belongs to a
      // different threshold (or is unmapped — handled by future thresholds).
      if (r.last_event_kind !== t.from_event) continue;
      const key = `${r.workspace_id}::${r.spec_slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      initial.push({
        workspace_id: r.workspace_id,
        spec_slug: r.spec_slug,
        from_event: t.from_event,
        to_event: t.to_event,
        gap_ms: r.gap_ms,
        sla_ms: t.sla_ms,
        // brief filled in below after the drop filters — no point paying the
        // three-read cost on a candidate we're about to drop.
        brief: { last_events: [], blocked_by_state: [], current_job_status: null },
      });
    }
  }

  const survivors: StalledCandidate[] = [];
  for (const c of initial) {
    // (b) uncleared blockedBy → legit wait, drop.
    const blockers = await getSpecBlockers(c.spec_slug);
    if (blockers.some((b) => !b.cleared)) continue;

    // (c) active job in a wait status → legit wait, drop.
    const currentJobStatus = await readCurrentJobStatus(admin, c.workspace_id, c.spec_slug);
    if (currentJobStatus !== null && LEGIT_WAIT_JOB_STATUSES.has(currentJobStatus)) continue;

    // (d) fold-cooldown / explicitly-deferred → the spec stopped emitting events
    // on purpose; drop. Reads through the specs-table getSpec (which carries the
    // raw override statuses, unlike the derived brain-roadmap SpecStatus that
    // normalizes `folded` → `shipped`).
    const specRow = await getSpecFromDb(c.workspace_id, c.spec_slug);
    if (specRow && (specRow.status === "folded" || specRow.status === "deferred")) continue;

    // (e) fill the brief now that the candidate survived every filter.
    const lastEvents = await readLastEvents(admin, c.workspace_id, c.spec_slug);
    survivors.push({
      ...c,
      brief: {
        last_events: lastEvents,
        blocked_by_state: blockers.map((b) => ({ slug: b.slug, cleared: b.cleared })),
        current_job_status: currentJobStatus,
      },
    });
  }

  return survivors;
}

/**
 * `enqueueMarioJob` — file a kind='mario' [[agent_jobs]] row for a stalled
 * candidate, gated on "no active mario row for this spec_slug already exists".
 *
 * Dedupe contract (from the spec): SELECT any active mario row on `spec_slug`
 * with status in the ACTIVE set; if one exists, return
 * `{ enqueued: false, reason: 'active_mario_exists' }`, else INSERT a fresh
 * row with the MarioBrief JSON-encoded on `instructions` so the M4 reasoning
 * agent picks it up.
 *
 * This is app-layer dedupe (SELECT-then-INSERT) — safe under the once-per-minute
 * cron because at most one tick evaluates a given spec at a time. A cross-cron
 * race would insert a second row; M4's own claim step is designed to no-op on
 * that (the FIRST claim wins; the second becomes a no-op mario tick).
 */
export async function enqueueMarioJob(
  admin: Admin,
  candidate: StalledCandidate,
): Promise<{ enqueued: boolean; job_id?: string; reason?: string }> {
  // SELECT for an active mario row on this spec_slug. Filter by workspace_id
  // AND kind AND spec_slug — never rely on spec_slug alone (cross-workspace
  // spec-slug collisions do happen for the same brain page under two tenants).
  const { data: existing, error: selectErr } = await admin
    .from("agent_jobs")
    .select("id, status")
    .eq("workspace_id", candidate.workspace_id)
    .eq("kind", "mario")
    .eq("spec_slug", candidate.spec_slug)
    .in("status", Array.from(ACTIVE_MARIO_STATUSES))
    .limit(1)
    .maybeSingle();
  if (selectErr) throw selectErr;
  if (existing) return { enqueued: false, reason: "active_mario_exists" };

  const { data: inserted, error: insertErr } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: candidate.workspace_id,
      kind: "mario",
      status: "queued",
      spec_slug: candidate.spec_slug,
      instructions: JSON.stringify(candidate.brief),
    })
    .select("id")
    .single();
  if (insertErr) throw insertErr;
  return { enqueued: true, job_id: inserted.id };
}

/**
 * Convenience: read the workspace-scoped thresholds without going through the
 * evaluator. Handy for the M4 self-tuner (which reads to widen an SLA).
 */
export async function readMarioThresholds(admin: Admin, workspace_id: string): Promise<MarioThreshold[]> {
  return readThresholds(admin, workspace_id);
}

/**
 * Default admin factory — the cron passes its own client to
 * `evaluateStalledSpecs` and `enqueueMarioJob`; a caller from a route can grab a
 * client here without importing `@/lib/supabase/admin` directly.
 */
export function marioAdmin(): SupabaseClient {
  return createAdminClient();
}
