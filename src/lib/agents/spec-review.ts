/**
 * spec-review — the box-hosted spec-review agent ([[../specs/spec-review-agent]]).
 *
 * **Vale** reviews every newly-authored spec while it sits in the `in_review` column (status that sits
 * BEFORE `planned`, the hard-stop the build pipeline refuses to dispatch). One pass per cadence reads each
 * `in_review` spec against the authoring CHECKLIST and emits ONE quality verdict per spec:
 *
 *   - `pass`       — the spec is well-formed (CHECKLIST clears). Sets `flags.vale_pass=true` on the card;
 *                    the spec stays in `in_review` to enter Ada's **director-disposition lane** (Phase 3).
 *                    **vale-reasons-the-disposition Phase 1** — a pass MAY also carry a reasoned
 *                    planned/deferred recommendation (Vale hydrated once for quality + emitted the
 *                    disposition at ~zero extra cost); when present it lands on
 *                    `specs.vale_disposition` + `vale_disposition_reason` and Ada's Phase-2 sweep
 *                    consumes it (retiring the trust-the-author stub). Absent on a legacy pass — the
 *                    sweep falls back to `intended_status`.
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
import { markSpecCardValePassed } from "@/lib/spec-card-state";
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
 * vale-reactive-spec-review Phase 1: additionally filters `vale_pass !== true`. The durable review signal
 * keys to spec CONTENT: `markSpecCardBackToReview` NULLs `vale_pass` on every re-open / re-author, and a
 * fresh authoring leaves it null (`upsertSpec` DB default). So `vale_pass === true` reliably means "Vale
 * already reviewed the CURRENT content" — those specs sit in `in_review` parked for Ada's disposition lane,
 * not Vale's queue. Filtering them out here gates BOTH the 15-min cron backstop and the reactive
 * `spec-review/spec-mutated` event through the same free predicate — an expensive box `claude -p` only spins
 * up when there is real, unreviewed work.
 */
export async function selectUnreviewedInReviewSpecs(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _admin: Admin,
  workspaceId: string,
): Promise<string[]> {
  // Read the in_review pool through the specs-table SDK (no raw PM SQL — pm-db-agent-toolkit).
  const rows = await listSpecs(workspaceId, { status: "in_review" });
  return rows
    .filter((r) => !r.deferred) // a deferred spec is out of the in_review pool even if status still reads it
    .filter((r) => r.vale_pass !== true) // and a Vale-passed spec is out of Vale's queue (parked for Ada)
    .map((r) => r.slug);
}

/**
 * Dedupe-aware enqueue: insert ONE `spec-review` job per workspace per cadence — only when ≥1 in_review spec
 * LACKS a current Vale review AND no in-flight `spec-review` job is already running. The Inngest cron + the
 * reactive `spec-review/spec-mutated` event both flow through here, so a cron tick that races an event no-ops
 * the duplicate, and a mutation on a spec whose current content already passed Vale no-ops for free (never
 * spinning up a Max session).
 *
 * `reason` disambiguates the empty-pool cases so the cron heartbeat + build claim-gate can log them apart:
 *   • `no-in-review-specs`  — no non-deferred in_review specs exist at all.
 *   • `no-unreviewed-specs` — in_review pool is non-empty but every spec already carries `vale_pass=true`
 *                             (they are parked for Ada's disposition lane, not Vale's queue).
 *   • `in-flight`           — a spec-review job is already queued/running for this workspace.
 */
export async function enqueueSpecReviewIfDue(
  workspaceId: string,
): Promise<{ enqueued: boolean; reason?: string; pending?: number }> {
  const admin = createAdminClient();

  // vale-reactive-spec-review Phase 1 — read the in_review pool ONCE so we can distinguish "nothing to
  // review, nothing in_review at all" from "nothing to review, every in_review spec already passed Vale".
  const rows = await listSpecs(workspaceId, { status: "in_review" });
  const nonDeferred = rows.filter((r) => !r.deferred);
  const pending = nonDeferred.filter((r) => r.vale_pass !== true).map((r) => r.slug);
  if (!pending.length) {
    return {
      enqueued: false,
      reason: nonDeferred.length ? "no-unreviewed-specs" : "no-in-review-specs",
      pending: 0,
    };
  }

  // One-in-flight guard: don't pile up Vale passes.
  const { data: inflight } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "spec-review")
    .in("status", ["queued", "queued_resume", "building", "claimed"])
    .limit(1);
  if (inflight && inflight.length) return { enqueued: false, reason: "in-flight", pending: pending.length };

  const { error } = await admin.from("agent_jobs").insert({
    workspace_id: workspaceId,
    spec_slug: "spec-review-sweep", // sentinel — Vale sweeps the queue, not one spec
    kind: "spec-review",
    status: "queued",
    created_by: null,
    instructions: JSON.stringify({ pending_count: pending.length }),
  });
  if (error) return { enqueued: false, reason: `insert-failed: ${error.message}`, pending: pending.length };
  return { enqueued: true, pending: pending.length };
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
