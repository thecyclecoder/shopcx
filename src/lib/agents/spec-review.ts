/**
 * spec-review — RETIRED.
 *
 * The Vale LLM spec-review lane is retired ([[../specs/retire-vale-spec-review-becomes-deterministic-
 * authoring-gate]] Phase 2). The DETERMINISTIC spec-review gate at the authoring chokepoint
 * ([[../libraries/spec-review-gate]]) is the replacement — every spec that reaches `public.specs`
 * has passed the checklist by construction, so 'reviewed' is TRUE the instant a row exists. The build
 * pipeline no longer refuses on `in_review` (`queueRoadmapBuild` + `enqueueBuildIfDue` + `deriveSpecCard
 * Status` all drop the in_review guardrail).
 *
 * This module is kept as a RUNTIME NO-OP stub so any lingering importer (dashboards, migration scripts,
 * one-off `_watch-review.ts`) resolves without a hard TS error. Every exported function returns the
 * "nothing to do" shape it used to; every writer is a documented no-op. Phase 3 deletes this file
 * outright + removes the last references.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** Vale's per-spec quality verdict — kept as a type export for pre-retirement callers. */
export type SpecReviewVerdict = "pass" | "needs_fix";

export interface SpecReviewDecision {
  slug: string;
  verdict: SpecReviewVerdict;
  reason: string;
  defects?: string[];
  disposition?: "planned" | "deferred";
  disposition_reason?: string;
}

/** Retired — the deterministic gate at authoring makes this queue permanently empty. */
export async function selectUnreviewedInReviewSpecs(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _admin: Admin,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _workspaceId: string,
): Promise<string[]> {
  return [];
}

/** Retired — the LLM lane no longer enqueues jobs. Returns the same shape callers expect for compat. */
export async function enqueueSpecReviewIfDue(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _workspaceId: string,
): Promise<{ enqueued: boolean; enqueuedCount: number; pending: number; reason?: string }> {
  return { enqueued: false, enqueuedCount: 0, pending: 0, reason: "retired-deterministic-gate" };
}

/** Retired — no LLM verdicts to apply. */
export async function applySpecReviewDecision(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _workspaceId: string,
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
  const applied: SpecReviewVerdict = decision.verdict === "needs_fix" ? "needs_fix" : "pass";
  return { ok: true, applied, reason: "retired-deterministic-gate" };
}

export interface ValeReviewPassReconcilerResult {
  scanned: number;
  healed: number;
  skipped: number;
  failed: number;
}

/** Retired — no LLM passes to reconcile. */
export async function runValeReviewPassReconciler(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _admin: Admin,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _workspaceId: string,
): Promise<ValeReviewPassReconcilerResult> {
  return { scanned: 0, healed: 0, skipped: 0, failed: 0 };
}

/** Retired — no per-slug pass to reconcile. */
export async function reconcileValeReviewPassStampFor(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _admin: Admin,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _workspaceId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _slug: string,
): Promise<"healed" | "skipped" | "no_spec"> {
  return "skipped";
}
