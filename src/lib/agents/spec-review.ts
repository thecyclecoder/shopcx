/**
 * spec-review — the box-hosted spec-review agent ([[../specs/spec-review-agent]]).
 *
 * **Vale** reviews every newly-authored spec while it sits in the `in_review` column (status that sits
 * BEFORE `planned`, the hard-stop the build pipeline refuses to dispatch). One pass per cadence reads each
 * `in_review` spec against the authoring CHECKLIST and emits ONE quality verdict per spec:
 *
 *   - `pass`       — the spec is well-formed (CHECKLIST clears). Sets `flags.vale_pass=true` on the card;
 *                    the spec stays in `in_review` to enter Ada's **director-disposition lane** (Phase 3).
 *                    **agent-mandate-hardening-spec-review Phase 1** — the Phase-3 rubric limits Vale
 *                    to QUALITY ONLY (`AGENT_RUBRICS["spec-review"]` is explicit); the run-job prompt +
 *                    the skill no longer ask for a `disposition` recommendation and repeated coaching
 *                    to leave planned/deferred to Ada is baked in. The applier still ACCEPTS the
 *                    optional `disposition` / `disposition_reason` fields for legacy / non-Phase-3
 *                    callers (they land on `specs.vale_disposition` + `vale_disposition_reason`), but
 *                    the box worker never emits them — Ada's sweep falls back to `intended_status`.
 *   - `needs_fix`  — the spec is malformed. The defects surface as a `director_activity` row so the CEO
 *                    sees the diagnosis; the spec stays in `in_review` until the corrections land.
 *
 * Phase 3 (governance: author proposes · Vale checks quality · the DIRECTOR disposes) narrowed Vale to
 * QUALITY ONLY — she no longer decides planned/deferred. The `approve`/`defer` legs that lived on Vale in
 * Phase 2 belong to Ada now. The legacy verdict strings still parse for back-compat (a Vale pass that
 * arrives as the old `approve` is auto-routed as `pass`; a legacy `defer` is treated as `pass` since
 * the deferred/planned call is no longer Vale's).
 *
 * The actual review reasoning runs on the box as a `claude -p` pass (`runSpecReviewJob` in
 * `scripts/builder-worker.ts`); this module holds the typed verdict-applier the worker calls + the
 * enqueue helper the cron uses. The agent is read-only; only this writer mutates state.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { markSpecCardValePassed, markSpecCardValeNeedsFix } from "@/lib/spec-card-state";
import { recordDirectorActivity } from "@/lib/director-activity";
import { listSpecs } from "@/lib/specs-table";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Vale's per-spec quality verdict (Phase 3 — narrowed). `pass` = well-formed (Ada's disposition lane
 * picks it up next); `needs_fix` = malformed (the diagnosis surfaces; the spec stays in_review).
 */
export type SpecReviewVerdict = "pass" | "needs_fix";

export interface SpecReviewDecision {
  slug: string;
  verdict: SpecReviewVerdict;
  /** One plain-text sentence — the reason the verdict reaches its conclusion (audited + shown to the CEO). */
  reason: string;
  /** Optional list of checklist items that failed (Owner missing, mangled phases, …) — surfaced on needs_fix. */
  defects?: string[];
  /**
   * vale-reasons-the-disposition Phase 1 — Vale's reasoned planned/deferred recommendation, emitted
   * ONLY on `verdict='pass'` (an ill-formed spec is not dispositionable yet). Persisted on
   * `specs.vale_disposition`; Ada's disposition sweep will consume it in Phase 2 (retiring the
   * trust-the-author stub). Absent on legacy passes → the sweep falls back to `intended_status`.
   */
  disposition?: "planned" | "deferred";
  /** vale-reasons-the-disposition Phase 1 — plain-text WHY paired with `disposition` (surfaced by Ada's
   *  asymmetric routing on the CEO Approval Request / notification). Required when `disposition` is set. */
  disposition_reason?: string;
}

/**
 * Slugs parked in `in_review` for one workspace THAT LACK A CURRENT VALE REVIEW — Vale's queue per pass.
 *
 * Reads `public.specs` directly (the CANONICAL source post-db-driven-specs). The legacy `spec_card_state`
 * mirror is NOT populated with `in_review` for newly-authored specs — a fresh spec lands as a `public.specs`
 * row with `status='in_review'` and may never get a card-state row — so reading the mirror silently missed
 * the whole queue and Vale never enqueued (the bug that motivated reading `specs` directly).
 * `specs.deferred=true` wins over status (mirrors the readers' projection), so a deferred spec doesn't slip
 * into the pool by accident.
 *
 * vale-reactive-spec-review Phase 1: additionally filters on `vale_pass`. The durable review signal keys to
 * spec CONTENT: `markSpecCardBackToReview` NULLs `vale_pass` on every re-open / re-author, and a fresh
 * authoring leaves it null (`upsertSpec` DB default).
 *
 * vale-instant-per-spec-review: the predicate is now `vale_pass IS NULL` (was `!== true`). The tri-state
 * carries BOTH review outcomes so a verdicted spec — pass OR needs_fix — leaves the queue:
 *   • `null`  = never verdicted → Vale's queue.
 *   • `true`  = passed → parked for Ada's disposition lane (not Vale's queue).
 *   • `false` = needs_fix (`markSpecCardValeNeedsFix`) → OUT until re-authored (NULLs it back to null).
 * Under the old `!== true` predicate a `needs_fix` spec (vale_pass=null) stayed in the pool and got
 * re-reviewed every cadence — harmless at the 15-min batch cron, a Max-session firehose at the ~30s
 * instant-per-spec poll. This gates the poll, the cron backstop, and the reactive event through one free
 * predicate — an expensive box `claude -p` only spins up on real, unreviewed work.
 */
export async function selectUnreviewedInReviewSpecs(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _admin: Admin,
  workspaceId: string,
): Promise<string[]> {
  // specs-status-overrides-only: `status='in_review'` is no longer STORED (in_review is DERIVED). Vale's
  // pool is now keyed off the durable review signal: a spec needs review iff Vale has NOT durably passed the
  // current content (`vale_review_passed_at == null` — NULLed on every re-open/re-author by
  // markSpecCardBackToReview). That also excludes a DISPOSED spec whose transient `vale_pass` Ada consumed —
  // the durable stamp survives, keeping it out of Vale's queue. folded/deferred are out; `vale_pass == null`
  // keeps only NEVER-verdicted specs (pass=true parks for Ada, needs_fix=false is out until re-authored —
  // vale-instant-per-spec-review). SDK read (pm-db-agent-toolkit).
  const rows = await listSpecs(workspaceId);
  return rows
    .filter((r) => r.status !== "folded")
    .filter((r) => !r.deferred)
    .filter((r) => r.vale_review_passed_at == null)
    .filter((r) => r.vale_pass == null)
    .map((r) => r.slug);
}

/**
 * vale-instant-per-spec-review — PER-SPEC enqueue: insert ONE `spec-review` job for EACH in_review spec that
 * lacks a current Vale verdict AND has no in-flight `spec-review` job of its own. This replaced the single
 * batch-sentinel job (`spec-review-sweep`, one Vale session sweeping the whole pool with global concurrency
 * 1). Per-spec jobs let distinct specs review IN PARALLEL (the box runs `MAX_SPEC_REVIEW` > 1) while the
 * per-slug dedup guarantees two sessions never examine the SAME spec — the "one-in-flight PER SPEC, not per
 * workspace" rule. Every enqueuer flows through here (the ~30s box poll, the Inngest 15-min cron backstop,
 * the reactive `spec-review/spec-mutated` event, the standing-pass + build claim-gate), so the per-slug
 * dedup makes them all idempotent against each other — a spec whose current content already passed Vale
 * no-ops for free (the free `listSpecs` predicate; never spins up a Max session).
 *
 * A legacy `spec-review-sweep` sentinel job still in flight (queued by the pre-hotfix code before deploy)
 * covers the whole pool, so we yield to it (`batch-in-flight`) to avoid double-reviewing during the window.
 *
 * `reason` disambiguates the no-enqueue cases so the callers can log them apart:
 *   • `no-in-review-specs`  — no non-deferred in_review specs exist at all.
 *   • `no-unreviewed-specs` — in_review pool is non-empty but every spec is already verdicted (pass/needs_fix).
 *   • `batch-in-flight`     — a legacy sentinel sweep is running; it covers the pool, so we hold.
 *   • `all-in-flight`       — every unreviewed spec already has its own live per-spec job.
 */
export async function enqueueSpecReviewIfDue(
  workspaceId: string,
): Promise<{ enqueued: boolean; enqueuedCount: number; pending: number; reason?: string }> {
  const admin = createAdminClient();

  // specs-status-overrides-only: the in_review pool is DERIVED (no stored `status='in_review'`). Read it via
  // the durable review signal — not-folded, not-deferred, never durably Vale-passed (`vale_review_passed_at
  // == null`, which excludes disposed specs whose transient `vale_pass` was consumed). `vale_pass == null`
  // then keeps only never-verdicted specs. Read ONCE so we can distinguish "nothing in the pool at all" from
  // "pool non-empty but every spec already verdicted".
  const rows = await listSpecs(workspaceId);
  const pool = rows.filter((r) => r.status !== "folded" && !r.deferred && r.vale_review_passed_at == null);
  const pending = pool.filter((r) => r.vale_pass == null).map((r) => r.slug);
  if (!pending.length) {
    return {
      enqueued: false,
      enqueuedCount: 0,
      pending: 0,
      reason: pool.length ? "no-unreviewed-specs" : "no-in-review-specs",
    };
  }

  // Per-spec in-flight guard: pull every live spec-review job's slug so we skip any spec that already has
  // one — and yield entirely to a legacy batch sentinel (it reviews the whole pool).
  const { data: inflightRows } = await admin
    .from("agent_jobs")
    .select("spec_slug")
    .eq("workspace_id", workspaceId)
    .eq("kind", "spec-review")
    .in("status", ["queued", "queued_resume", "building", "claimed"]);
  const inflight = new Set((inflightRows ?? []).map((r) => r.spec_slug as string));
  if (inflight.has("spec-review-sweep")) {
    return { enqueued: false, enqueuedCount: 0, pending: pending.length, reason: "batch-in-flight" };
  }
  const toEnqueue = pending.filter((slug) => !inflight.has(slug));
  if (!toEnqueue.length) {
    return { enqueued: false, enqueuedCount: 0, pending: pending.length, reason: "all-in-flight" };
  }

  const { data: insertedRows, error } = await admin
    .from("agent_jobs")
    .insert(
      toEnqueue.map((slug) => ({
        workspace_id: workspaceId,
        spec_slug: slug, // one job PER spec — Vale reviews just this slug (not a pool sweep)
        kind: "spec-review",
        status: "queued",
        created_by: null,
        instructions: JSON.stringify({ single_spec: true }),
      })),
    )
    .select("id, spec_slug");
  if (error) {
    return { enqueued: false, enqueuedCount: 0, pending: pending.length, reason: `insert-failed: ${error.message}` };
  }
  // spec-timecard-chokepoint-instrumentation Phase 3 — one `job_queued` per inserted spec-review row.
  // Best-effort: a timecard failure never blocks the enqueue.
  try {
    const { recordTimecardEvent } = await import("@/lib/spec-timecards");
    for (const row of (insertedRows ?? []) as Array<{ id: string; spec_slug: string }>) {
      await recordTimecardEvent(admin, {
        workspace_id: workspaceId,
        spec_slug: row.spec_slug,
        phase_index: null,
        event_kind: "job_queued",
        actor: "enqueueSpecReviewIfDue",
        metadata: { kind: "spec-review", job_id: row.id },
      });
    }
  } catch (e) {
    console.warn(`[timecards] job_queued emit failed for spec-review batch: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { enqueued: true, enqueuedCount: toEnqueue.length, pending: pending.length };
}

/**
 * Apply ONE Vale quality decision to spec_card_state + record the audit trail (Phase 3).
 *
 *   - `pass` sets `flags.vale_pass=true` (the spec stays in `in_review` for Ada's disposition lane);
 *   - `needs_fix` leaves the row untouched but records the defects as a director_activity row.
 *
 * Best-effort + idempotent — re-running with the same verdict produces the same end state.
 *
 * Back-compat: a legacy Phase-2 verdict (`approve` / `defer`) auto-routes as `pass` (the disposition is
 * Ada's call now). The director_activity action_kind reflects the live Phase-3 vocabulary so the audit
 * ledger doesn't carry orphaned legacy strings.
 */
export async function applySpecReviewDecision(
  workspaceId: string,
  decision:
    | SpecReviewDecision
    | {
        slug: string;
        verdict: string;
        reason: string;
        defects?: string[];
        disposition?: string;
        disposition_reason?: string;
      },
): Promise<{ ok: boolean; reason?: string; applied?: SpecReviewVerdict }> {
  const admin = createAdminClient();
  const reason = (decision.reason || "").slice(0, 1000);
  const actor = "spec-review";
  // Back-compat: a Phase-2 approve/defer arrives here from a stale skill prompt; treat both as `pass`
  // (the disposition is Ada's call now; Vale only decides quality).
  const verdict: SpecReviewVerdict =
    decision.verdict === "needs_fix"
      ? "needs_fix"
      : decision.verdict === "pass" || decision.verdict === "approve" || decision.verdict === "defer"
        ? "pass"
        : "needs_fix"; // unknown verdict → safest is no-op-of-state + diagnosis surfaced
  const action_kind = verdict === "pass" ? "spec_review_passed" : "spec_review_needs_fix";
  // vale-reasons-the-disposition Phase 1 — on a PASS, Vale MAY also emit a reasoned planned/deferred
  // recommendation ('hydrate once, extra verdict free'). Persist it when present; Ada's Phase-2 sweep
  // will consume it (retiring the trust-the-author stub). Absent → the sweep falls back to intended_status.
  const rawDisposition =
    "disposition" in decision && typeof decision.disposition === "string" ? decision.disposition : undefined;
  const rawDispositionReason =
    "disposition_reason" in decision && typeof decision.disposition_reason === "string"
      ? decision.disposition_reason.slice(0, 1000)
      : undefined;
  const disposition: "planned" | "deferred" | null =
    verdict === "pass" && (rawDisposition === "planned" || rawDisposition === "deferred")
      ? rawDisposition
      : null;
  const dispositionReason = disposition && rawDispositionReason ? rawDispositionReason : null;
  try {
    if (verdict === "pass") {
      await markSpecCardValePassed(
        workspaceId,
        decision.slug,
        { actor, reason },
        disposition && dispositionReason
          ? { disposition, disposition_reason: dispositionReason }
          : undefined,
      );
    } else {
      // vale-instant-per-spec-review — stamp the durable needs_fix marker (`vale_pass=false`) so the spec
      // LEAVES Vale's queue until it's re-authored. Without this, the ~30s instant-per-spec poll would
      // re-review the same malformed spec every cycle. The spec STAYS in_review (build hard-stop holds);
      // markSpecCardBackToReview NULLs the flag on re-author to re-admit it. See markSpecCardValeNeedsFix.
      await markSpecCardValeNeedsFix(workspaceId, decision.slug, { actor, reason });
    }
    // needs_fix leaves the spec in_review (the build hard-stop holds). The defect surfaces via the
    // director_activity row so the CEO sees what Vale flagged. On a pass, the disposition is recorded
    // on the same row (Ada's sweep + the grader read the audit ledger for the reasoning trail).
    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: "platform",
      actionKind: action_kind,
      specSlug: decision.slug,
      reason,
      metadata: {
        defects: decision.defects ?? [],
        ...(disposition
          ? { vale_disposition: disposition, vale_disposition_reason: dispositionReason }
          : {}),
      },
    });
    return { ok: true, applied: verdict };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[spec-review] apply ${verdict} for ${decision.slug} failed:`, msg);
    return { ok: false, reason: msg };
  }
}
