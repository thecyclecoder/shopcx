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
  // deploy-health-rollback-guardian Phase 1 — the Deploy Guardian (Reva) stamps one per evaluated deploy-watch.
  | "deploy_healthy" // a deploy's canary window closed clean — no new deploy-correlated regression.
  | "deploy_regressed" // a deploy introduced a clear deploy-correlated regression (a spike / a loop went red).
  | "deploy_unsure"; // a deploy's post-deploy signal was ambiguous → escalate, never auto-act.

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
