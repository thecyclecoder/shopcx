/**
 * spec-review — the box-hosted spec-review agent ([[../specs/spec-review-agent]]).
 *
 * **Vale** reviews every newly-authored spec while it sits in the `in_review` column (status that sits
 * BEFORE `planned`, the hard-stop the build pipeline refuses to dispatch). One pass per cadence reads each
 * `in_review` spec against the authoring CHECKLIST and emits a verdict per spec: `approve` (sound + needed
 * now → flip status to `planned`), `defer` (sound but parked — flag `flags.deferred` + flip status to
 * `deferred`), or `needs_fix` (malformed — record the diagnosis as a director_activity row so the CEO sees
 * the defect; the spec stays in `in_review` until the corrections land).
 *
 * The actual review reasoning runs on the box as a `claude -p` pass (`runSpecReviewJob` in
 * `scripts/builder-worker.ts`); this module holds the typed verdict-applier the worker calls + the
 * enqueue helper the cron uses. The agent is read-only; only this writer mutates state.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  effectiveStatusFromState,
  markSpecCardDeferred,
  markSpecCardStatus,
  type SpecCardFlags,
} from "@/lib/spec-card-state";
import { recordDirectorActivity } from "@/lib/director-activity";

type Admin = ReturnType<typeof createAdminClient>;

/** Vale's per-spec verdict. The shape the worker hands to `applySpecReviewDecision`. */
export type SpecReviewVerdict = "approve" | "defer" | "needs_fix";

export interface SpecReviewDecision {
  slug: string;
  verdict: SpecReviewVerdict;
  /** One plain-text sentence — the reason the verdict reaches its conclusion (audited + shown to the CEO). */
  reason: string;
  /** Optional list of checklist items that failed (Owner missing, mangled phases, …) — surfaced on needs_fix. */
  defects?: string[];
}

/**
 * `(workspaceId, slug)` pairs in `in_review` for one workspace — Vale's queue per pass. Reads from
 * `spec_card_state` (the source of truth post-spec-status-db-driven). Empty if the row is missing — a
 * spec that has never had a card-state row written is treated as `planned` (its markdown default).
 */
export async function selectInReviewSpecs(admin: Admin, workspaceId: string): Promise<string[]> {
  const { data, error } = await admin
    .from("spec_card_state")
    .select("spec_slug, status, flags")
    .eq("workspace_id", workspaceId)
    .eq("status", "in_review");
  if (error || !data) return [];
  // effectiveStatusFromState honors flags.deferred (which wins over status), so a row marked deferred
  // doesn't slip into the in_review pool by accident.
  return data
    .map((r) => ({ slug: r.spec_slug as string, effective: effectiveStatusFromState({
      workspace_id: workspaceId,
      spec_slug: r.spec_slug as string,
      status: r.status as "in_review",
      phase_states: [],
      flags: (r.flags ?? {}) as SpecCardFlags,
      last_merge_sha: null,
      updated_at: "",
    }) }))
    .filter((r) => r.effective === "in_review")
    .map((r) => r.slug);
}

/**
 * Dedupe-aware enqueue: insert ONE `spec-review` job per workspace per cadence — only when there's ≥1
 * `in_review` spec AND no in-flight `spec-review` job already running. The Inngest cron + the on-ship
 * trigger both flow through here, so a cron tick that races an event no-ops the duplicate.
 */
export async function enqueueSpecReviewIfDue(
  workspaceId: string,
): Promise<{ enqueued: boolean; reason?: string; pending?: number }> {
  const admin = createAdminClient();

  const pending = await selectInReviewSpecs(admin, workspaceId);
  if (!pending.length) return { enqueued: false, reason: "no-in-review-specs", pending: 0 };

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
 * Apply ONE Vale decision to spec_card_state + record the audit trail. Approve flips to `planned`; defer
 * sets `flags.deferred` (which wins over status for display via `effectiveStatusFromState`) + a status
 * flip to `deferred` so the rollup is consistent; needs_fix leaves the spec in `in_review` and records the
 * defects as a director_activity row (the CEO sees the diagnosis on the activity feed).
 *
 * Best-effort + idempotent — re-running with the same verdict produces the same end state.
 */
export async function applySpecReviewDecision(
  workspaceId: string,
  decision: SpecReviewDecision,
): Promise<{ ok: boolean; reason?: string; applied?: SpecReviewVerdict }> {
  const admin = createAdminClient();
  const reason = (decision.reason || "").slice(0, 1000);
  const actor = "spec-review";
  const action_kind =
    decision.verdict === "approve"
      ? "spec_review_approved"
      : decision.verdict === "defer"
        ? "spec_review_deferred"
        : "spec_review_needs_fix";
  try {
    if (decision.verdict === "approve") {
      await markSpecCardStatus(workspaceId, decision.slug, "planned", undefined, { actor, reason });
    } else if (decision.verdict === "defer") {
      // Flip status + set the deferred flag so display + rollup agree.
      await markSpecCardStatus(workspaceId, decision.slug, "deferred", undefined, { actor, reason });
      await markSpecCardDeferred(workspaceId, decision.slug, true, { actor, reason });
    }
    // needs_fix leaves the spec in_review (the build hard-stop keeps holding). The defect surfaces via
    // the director_activity row so the CEO sees what Vale flagged.
    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: "platform",
      actionKind: action_kind,
      specSlug: decision.slug,
      reason,
      metadata: { defects: decision.defects ?? [] },
    });
    return { ok: true, applied: decision.verdict };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[spec-review] apply ${decision.verdict} for ${decision.slug} failed:`, msg);
    return { ok: false, reason: msg };
  }
}
