/**
 * director-activity — the tiny writer behind the `director_activity` table ([[docs/brain/tables/director_activity.md]]).
 *
 * Every director (and every worker a director supervises) writes ONE timestamped row here on each
 * action it takes — the single log that is the substrate for (1) the autonomous-approval audit
 * history, (2) the gamified #directors board posts, and (3) the EOD recap (a read over today's rows).
 * See [[docs/brain/goals/devops-director.md]].
 *
 * The FIRST concrete writer is the Regression Agent ([[docs/brain/specs/regression-agent.md]]) — it
 * records every detect / dismiss / author / escalate action so the operator (and, once live, the
 * Platform/DevOps Director that supervises it) can audit what the worker did and why.
 *
 * Best-effort + never throws: an audit write that crashes the action it records is worse than the gap
 * (mirrors `enqueueRepairJob`). If the table isn't present yet, this no-ops with a warning.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The action kinds the Regression Agent emits (open vocabulary — the live directors add more). */
export type DirectorActionKind =
  | "detected_regression" // a regression entered the queue (the detector enqueued a review).
  | "dismissed_regression" // reviewed → transient/foreign/false/already-fixed, recorded reasoning, no spec.
  | "authored_fix" // reviewed → real regression, authored the fix spec directly + routed to the inbox.
  | "escalated" // loop-guard: a regression fix that didn't hold after N attempts → escalated to CEO.
  // regression-backlog-reconciliation Phase 1 — the standing re-verification sweep (close the coverage gap).
  | "reconciled_coverage" // a shipped spec not re-verified within the freshness window → queued a spec-test re-run.
  // regression-backlog-reconciliation Phase 2 — drive every detected regression to a terminal state.
  | "reconciled_regression" // an unresolved spec-test fail with no live regression job → enqueued Remi (or escalated a stuck fix).
  // deploy-health-rollback-guardian Phase 1 — the Deploy Guardian (Reva) stamps one per evaluated deploy-watch.
  | "deploy_healthy" // a deploy's canary window closed clean — no new deploy-correlated regression.
  | "deploy_regressed" // a deploy introduced a clear deploy-correlated regression (a spike / a loop went red).
  | "deploy_unsure" // a deploy's post-deploy signal was ambiguous → escalate, never auto-act.
  // deploy-health-rollback-guardian Phase 2 — Reva acts on `regressed`.
  | "deploy_rolled_back" // a regressed deploy was auto-reverted to the prior good build (+ escalated to the CEO).
  // spec-review-agent Phase 2 — Vale stamps one per in_review spec it processes (LEGACY Phase-2 vocabulary
  // kept for ledger continuity — `spec_review_approved`/`spec_review_deferred` are no longer emitted by
  // the live writer; the Phase 3 narrow-to-quality replaces them with `spec_review_passed`).
  | "spec_review_approved" // (legacy) sound + needed now → spec flipped from in_review to planned.
  | "spec_review_deferred" // (legacy) sound but parked per the spec's own directive → flipped to deferred + flags.deferred set.
  | "spec_review_needs_fix" // checklist failed (mangled phases / missing owner / parent / verification / blockers / db-companion) — diagnosis recorded; spec stays in_review.
  // spec-review-agent Phase 3 — Vale narrowed to QUALITY ONLY; one verdict per in_review spec.
  | "spec_review_passed" // well-formed (CHECKLIST cleared) → flags.vale_pass=true; spec stays in_review for Ada's disposition lane.
  // spec-review-agent Phase 3 — Ada's director-disposition lane (autonomous, with asymmetric check vs the
  // author's `flags.intended_status`). One row per Vale-passed spec she disposes.
  | "spec_dispose_same" // suggestion == decision (planned→planned OR deferred→deferred) — autonomous flip, applied silently.
  | "spec_dispose_downgrade" // author suggested `planned`, Ada deferred — autonomous flip + a CEO notification (one-click override to planned).
  | "spec_dispose_upgrade_proposed" // author suggested `deferred`, Ada wants `planned` — GATED, parks a CEO approval card (Planned / Deferred + reason).
  // spec-review-agent Phase 4 — any agent (Vale on re-check, Bo, Ada, repair/regression, the CEO via the
  // board control) that flips a malformed/off spec BACK to `in_review` so it returns to Vale's queue.
  // The `actor` on the row records WHO sent it back; the `reason` records WHAT was off.
  | "spec_sent_back_to_review" // a malformed/off spec was returned to the in_review column; the build pipeline refuses to dispatch it until Vale clears it again.
  // goal-greenlight-button-and-author-writes-db Phase 1 — the CEO's one-click DB-flag actions on a goal
  // card. `greenlit_goal` activates a proposed goal (proposed → greenlit); `ungreenlit_goal` reverts
  // (greenlit → proposed, only while no milestone has rolled past planned); `declined_goal` flips a
  // proposed goal to folded (the row stays for audit; the mirror-md lane reflects the new status).
  | "greenlit_goal"
  | "ungreenlit_goal"
  | "declined_goal"
  // repurpose-spec-drift-reconciler Phase 1 — the spec-drift reconciler (supervising Bo) stamps phase(s)
  // shipped after the box no-op'd a build as "already merged via #N" (work on main, phase left planned by
  // a backfill). One row per healed spec; metadata carries { actor:'reconciler:spec-drift', pr, phases }.
  | "healed_built_unstamped"
  // repurpose-spec-drift-reconciler Phase 2 — the reconciler's read-only sweep over `spec_phases` for
  // genuine anomalies it can't auto-heal: orphan rows (FK parent missing), duplicate (spec_id, position)
  // clusters (unique index missing/dropped), or shipped phases with no pr + no merge_sha (provenance
  // gap). One row per spec/kind; metadata carries { kind:'orphan'|'duplicate_position'|'provenance_gap',
  // actor:'reconciler:spec-drift', … }.
  | "spec_phases_anomaly"
  // re-author-re-opens-dismissed — `clearDirectorSpecDismissals` writes one row when a RE-AUTHORED spec's
  // standing init/groom `*_dismissed` ledger rows are cleared (the corrected content must be re-investigated,
  // not carried under the stale verdict). metadata: { cleared_dismissals, cleared_keys, autonomous:true }.
  | "spec_reopened_after_reauthor"
  // no-silent-spec-defer invariant — EVERY programmatic (non-human) flip of a spec to `deferred` writes one
  // of these via `auditedProgrammaticDefer` ([[spec-defer-audit]]). The row records WHO parked it (`actor`)
  // and a CONCRETE reason (for a loop-repair defer: which loop/signature + WHY — resolved/superseded/
  // pending-deploy), and the same helper emits a CEO "Spec deferred — <why>" notification with one-click
  // un-defer. No silent parks: a programmatic defer with no audit row + no surface is the gap this closes.
  | "spec_deferred_programmatic";

export interface DirectorActivityInput {
  workspaceId: string;
  /** the function slug whose objective owns the action; a WORKER action carries its SUPERVISING director. */
  directorFunction: string;
  actionKind: DirectorActionKind | string;
  /** the spec the action touched (null for a non-spec action). */
  specSlug?: string | null;
  /** the plain-text "why" — the reasoning the recap/audit reads back. */
  reason: string;
  /** structured per-action context: { job_id?, signature?, failing?, attempt?, verdict?, ... }. */
  metadata?: Record<string, unknown>;
}

/** The function slug whose init/groom lanes own the dismissal ledger (mirrors `PLATFORM` in platform-director). */
const PLATFORM_FUNCTION = "platform";

/**
 * re-author-re-opens-dismissed invariant — clear a spec's STANDING init/groom dismissal ledger rows so a
 * corrected-after-rejection spec re-enters the build pipeline instead of sitting dead under the stale verdict.
 *
 * Ada's `dismiss_candidate` (and the groom-lane equivalent) is PERSISTED as a `director_activity` row whose
 * `metadata.init_key` / `metadata.groom_key` the dedup readers (`alreadyInitiated` / `alreadyGroomed` in
 * [[platform-director]]) scan for to SKIP the spec on the next pass — the row IS the dedup, there is no
 * separate skip-flag. So once a spec is dismissed it is silently excluded forever. When the spec is
 * RE-AUTHORED with changed content the prior dismissal applied to the OLD (premise-wrong) content and is
 * stale; this DELETES those consumed dedup rows for the slug so the init/groom lanes re-investigate the new
 * content, and writes ONE `spec_reopened_after_reauthor` audit row recording the re-open + the keys cleared.
 *
 * Scope: only the `*_dismissed` dedup rows (`init_dismissed` / `groomed_dismissed`). We deliberately do NOT
 * touch `escalated` / `*_authored_spec` rows — those are not "this spec was rejected" dispositions and their
 * audit value outweighs the dedup cost. `director_activity` is NOT a PM table (specs/spec_phases/goals/
 * goal_milestones), so this delete is OUTSIDE the PM-SDK guard — it's ledger hygiene, not a spec mutation.
 *
 * Best-effort + never throws (mirrors `recordDirectorActivity`). Returns the count of dismissal rows cleared.
 */
export async function clearDirectorSpecDismissals(
  admin: Admin,
  workspaceId: string,
  slug: string,
  reason: string,
): Promise<{ cleared: number }> {
  try {
    const { data, error: readErr } = await admin
      .from("director_activity")
      .select("id, action_kind, metadata")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", slug)
      .in("action_kind", ["init_dismissed", "groomed_dismissed"]);
    if (readErr) {
      console.warn(`[director-activity] clearDirectorSpecDismissals read failed (${slug}):`, readErr.message);
      return { cleared: 0 };
    }
    const rows = (data ?? []) as { id: string; action_kind: string; metadata: Record<string, unknown> | null }[];
    if (!rows.length) return { cleared: 0 };

    const ids = rows.map((r) => r.id);
    const clearedKeys = rows
      .map((r) => (r.metadata?.["init_key"] ?? r.metadata?.["groom_key"]) as string | undefined)
      .filter((k): k is string => !!k);

    const { error: delErr } = await admin.from("director_activity").delete().in("id", ids);
    if (delErr) {
      console.warn(`[director-activity] clearDirectorSpecDismissals delete failed (${slug}):`, delErr.message);
      return { cleared: 0 };
    }

    // One audit row records the re-open + which dedup keys it superseded (the deleted rows are gone, this row
    // is now the trail). It carries NO init_key/groom_key of its own, so it never re-triggers a dedup skip.
    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: PLATFORM_FUNCTION,
      actionKind: "spec_reopened_after_reauthor",
      specSlug: slug,
      reason,
      metadata: { cleared_dismissals: rows.length, cleared_keys: clearedKeys, autonomous: true },
    });
    return { cleared: rows.length };
  } catch (err) {
    console.warn("[director-activity] clearDirectorSpecDismissals threw:", err instanceof Error ? err.message : err);
    return { cleared: 0 };
  }
}

/**
 * Insert one `director_activity` row. Best-effort + idempotent-safe to call from any action path.
 * Returns `{ recorded }` so a caller can log it, but NEVER throws.
 */
export async function recordDirectorActivity(admin: Admin, input: DirectorActivityInput): Promise<{ recorded: boolean; reason?: string }> {
  try {
    const { error } = await admin.from("director_activity").insert({
      workspace_id: input.workspaceId,
      director_function: input.directorFunction,
      action_kind: input.actionKind,
      spec_slug: input.specSlug ?? null,
      reason: (input.reason || "").slice(0, 4000),
      metadata: input.metadata ?? {},
    });
    if (error) {
      console.warn(`[director-activity] insert failed (${input.actionKind}):`, error.message);
      return { recorded: false, reason: error.message };
    }
    return { recorded: true };
  } catch (err) {
    console.warn("[director-activity] recordDirectorActivity threw:", err instanceof Error ? err.message : err);
    return { recorded: false, reason: "threw" };
  }
}
