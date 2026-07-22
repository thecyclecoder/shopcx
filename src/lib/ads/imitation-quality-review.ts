/**
 * flag-a-competitor-ad-do-not-use — Phase 3: Max's per-sweep imitation-quality review of
 * newly-ingested competitor ads. Reads each new `creative_skeletons` row (image +
 * hook/mechanism/proof) and returns a coarse `usable | not_usable` verdict; a not_usable
 * verdict AUTO-flags the row via `setSkeletonDoNotUse({..., reason:'max_weak_imitation_base',
 * by:'max'})` (the sole write chokepoint from Phase 2) so Dahlia's `queryProvenAngles` skips
 * it (Phase 1). The CEO sees ONE `dashboard_notifications` review card per sweep to
 * confirm/override — never a silent proxy-optimizer (north-star, [[../../CLAUDE.md]] § North
 * star).
 *
 * The bar is DELIBERATELY COARSE — Max flags ONLY the obvious junk:
 *   • auto-generated Shopify product/packshot ad
 *   • bland packshot that says nothing (no hook, no benefit, no story)
 * and KEEPS anything with a real hook / benefit callouts / dynamic composition (e.g. the
 * Onnit "Lock in when it matters most" ad KEEPS; the Magic Mind display-box packshot
 * DROPS). Few-shot-anchored on the CEO's manual `do_not_use=true` (by='ceo') flags as
 * ground-truth exemplars — Max learns the taste, the CEO stays the objective owner.
 *
 * Deterministic-Node applier — this module never runs an LLM. The Max box session (in
 * `scripts/builder-worker.ts` `runImitationQualityReviewJob`) is the only LLM caller; this
 * module owns the persist path from Max's verdicts. Same shape as `applyBoxGapGrade` /
 * `applyBoxMediaBuyerGrade` / `applyBoxCsDirectorCall`.
 *
 * Node-completeness trio (CLAUDE.md hard rule):
 *   • OWNER — 'imitation-quality-review' is registered under `growth` in
 *     [[../control-tower/node-registry]] `KIND_OWNER_FALLBACK` (Max under the ad-creative
 *     line), so the org chart + approval router + agent-grader owner-scoping all agree.
 *   • KILL-SWITCH ANCESTRY — inherits Growth's ancestry via the node registry
 *     (`parentIdForOwner('growth')` → `director:growth`), so a `dept:growth` /
 *     `director:growth` `kill_switches` row cascades to this lane.
 *   • HEARTBEAT — `runImitationQualityReviewJob` emits
 *     `emitAgentHeartbeat('imitation-quality-review', …)` from an end-of-run try/finally so
 *     a throw still beats `ok:false`.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { setSkeletonDoNotUse } from "@/lib/creative-skeleton";

export type ImitationQualityVerdict = "usable" | "not_usable";

export interface ImitationQualityCandidate {
  skeletonId: string;
  advertiser: string | null;
  hook: string | null;
  mechanismClaim: string | null;
  proof: string | null;
  offer: string | null;
  format: string | null;
  thumbUrl: string | null;
}

export interface ImitationQualityBoxVerdict {
  skeleton_id: string;
  verdict: ImitationQualityVerdict;
  reason: string;
}

export interface ImitationQualityApplied {
  flagged: number;
  kept: number;
  skipped: number; // verdicts whose skeleton_id wasn't in the input batch (defense-in-depth)
  notFound: number; // skeleton not in this workspace at write time (setSkeletonDoNotUse false)
  notificationInserted: boolean;
}

const IMITATION_QUALITY_KIND = "imitation-quality-review" as const;
export const IMITATION_QUALITY_REVIEW_KIND = IMITATION_QUALITY_KIND;
export const IMITATION_QUALITY_FLAG_REASON = "max_weak_imitation_base" as const;
export const IMITATION_QUALITY_FLAG_BY = "max" as const;

/**
 * Enqueue ONE Max box-session review of a sweep's newly-ingested skeleton ids. Called at the
 * end of `sweepWorkspace` in `src/lib/inngest/creative-scout.ts`. No-op when `skeletonIds` is
 * empty (a sweep that ingested nothing new has nothing for Max to review). The instructions
 * payload is a tight `{skeletonIds: string[]}` — the worker re-reads each row from the DB.
 */
export async function enqueueImitationQualityReview(input: {
  workspaceId: string;
  skeletonIds: string[];
}): Promise<{ enqueued: boolean; jobId: string | null }> {
  const ids = Array.from(new Set(input.skeletonIds.filter((s) => typeof s === "string" && s.length > 0)));
  if (ids.length === 0) return { enqueued: false, jobId: null };
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: input.workspaceId,
      spec_slug: "flag-a-competitor-ad-do-not-use-manual-ceo-then-max-graded",
      kind: IMITATION_QUALITY_KIND,
      status: "queued",
      instructions: JSON.stringify({ skeletonIds: ids }),
    })
    .select("id")
    .single();
  if (error) throw new Error(`imitation-quality-review enqueue failed: ${error.message}`);
  return { enqueued: true, jobId: (data as { id: string }).id };
}

/**
 * Apply Max's per-ad verdicts. Iterates the batch, calls `setSkeletonDoNotUse` for every
 * `not_usable` verdict (the ONLY chokepoint that touches `do_not_use_*`), and inserts one
 * CEO review card summarizing the pass so the CEO can confirm/override. Compare-and-set
 * guards live inside `setSkeletonDoNotUse` (workspace_id + id) — this module trusts nothing
 * from the LLM: verdicts whose skeleton_id isn't in the requested batch are SKIPPED (Coaching
 * #11/#12: never let a session-declared row bypass the enumeration source), and a stale row
 * (deleted / cross-workspace) counts as `notFound` rather than a silent success.
 */
export async function applyBoxImitationQualityReview(input: {
  workspaceId: string;
  jobId: string;
  requestedSkeletonIds: string[];
  verdicts: ImitationQualityBoxVerdict[];
}): Promise<ImitationQualityApplied> {
  const requested = new Set(input.requestedSkeletonIds);
  const applied: ImitationQualityApplied = {
    flagged: 0,
    kept: 0,
    skipped: 0,
    notFound: 0,
    notificationInserted: false,
  };
  const flaggedIds: string[] = [];
  for (const v of input.verdicts) {
    if (!v || typeof v.skeleton_id !== "string" || (v.verdict !== "usable" && v.verdict !== "not_usable")) {
      applied.skipped += 1;
      continue;
    }
    if (!requested.has(v.skeleton_id)) {
      // Defense-in-depth: the LLM can only vote on rows we sent it.
      applied.skipped += 1;
      continue;
    }
    if (v.verdict === "usable") {
      applied.kept += 1;
      continue;
    }
    // not_usable — auto-flag via the sole chokepoint.
    const ok = await setSkeletonDoNotUse({
      workspaceId: input.workspaceId,
      skeletonId: v.skeleton_id,
      doNotUse: true,
      reason: IMITATION_QUALITY_FLAG_REASON,
      by: IMITATION_QUALITY_FLAG_BY,
    });
    if (ok) {
      applied.flagged += 1;
      flaggedIds.push(v.skeleton_id);
    } else {
      applied.notFound += 1;
    }
  }
  applied.notificationInserted = await insertCeoReviewCard({
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    flaggedIds,
    reviewedCount: input.requestedSkeletonIds.length,
    keptCount: applied.kept,
  });
  return applied;
}

/**
 * One CEO review card per sweep so the CEO can confirm / override — north-star supervisable
 * autonomy: Max PROPOSED the flag, the CEO owns the judgment. No-op when Max flagged nothing
 * (the sweep was clean — there's nothing for the CEO to review). Deduped per job_id so a
 * worker retry doesn't spam the inbox.
 */
async function insertCeoReviewCard(input: {
  workspaceId: string;
  jobId: string;
  flaggedIds: string[];
  reviewedCount: number;
  keptCount: number;
}): Promise<boolean> {
  if (input.flaggedIds.length === 0) return false;
  const admin = createAdminClient();
  const dedupeKey = `imitation_quality_review:${input.jobId}`;
  const { data: prior } = await admin
    .from("dashboard_notifications")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("metadata->>dedupe_key", dedupeKey)
    .limit(1);
  if ((prior ?? []).length > 0) return false;
  const body =
    `Max reviewed ${input.reviewedCount} newly-ingested competitor ad${input.reviewedCount === 1 ? "" : "s"} ` +
    `and flagged ${input.flaggedIds.length} as a weak imitation base (reason: ${IMITATION_QUALITY_FLAG_REASON}). ` +
    `Flagged ads are now skipped by Dahlia's angle selection. Confirm or override each on ` +
    `/dashboard/research/ads (use the "Use again" button to un-flag).\n\n` +
    `Kept: ${input.keptCount} · Flagged: ${input.flaggedIds.length} of ${input.reviewedCount}.`;
  const { error } = await admin.from("dashboard_notifications").insert({
    workspace_id: input.workspaceId,
    type: "agent_review_request",
    title: `Max flagged ${input.flaggedIds.length} weak competitor ad${input.flaggedIds.length === 1 ? "" : "s"}`,
    body: body.slice(0, 4000),
    link: "/dashboard/research/ads",
    metadata: {
      routed_to_function: "ceo",
      escalated_by_director: "growth",
      escalation_kind: "imitation_quality_review",
      job_id: input.jobId,
      flagged_skeleton_ids: input.flaggedIds,
      flag_reason: IMITATION_QUALITY_FLAG_REASON,
      flag_by: IMITATION_QUALITY_FLAG_BY,
      dedupe_key: dedupeKey,
    },
    read: false,
    dismissed: false,
  });
  return !error;
}
