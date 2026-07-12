/**
 * pre-merge-fix — fixes-as-phases: on a RED pre-merge spec-test for an in-flight build branch, APPEND the
 * failing checks as a `kind='fix'` PHASE on the ORIGIN spec + resume the origin's build to fix them
 * one-at-a-time. This RETIRES the old fix-<slug> spec model (a separate spec on a fresh branch/session that
 * cold-rebuilt the whole origin from scratch + spawned fix→fix-fix→fix-fix-fix chains — the 2026-07-02 mess).
 *
 * Appending a planned fix phase does two things for free (no explicit status write — `specs.status` stays
 * override-only NULL):
 *   1. breaks accumulation → the origin derives OUT of `in_testing` back to `in_progress` (a spec-test
 *      regression re-opens the spec — it now has more steps to finish);
 *   2. `queueNextChainedPhase` resumes the origin's Claude session on its `claude/build-{slug}` branch and
 *      builds the fix one-at-a-time (own commit); when the last phase ships the origin SELF-re-tests
 *      (`enqueueSpecTestIfDue` via `applyMergedBuildEffects`). Fully self-heal, reusing the chained-phase
 *      machinery — no new spec row, no cold re-hydration, no fix-<slug> chain to depth-guard.
 *
 * Loop-guard: at `PRE_MERGE_FIX_LOOP_GUARD_MAX` fix phases already on the origin, a still-red re-test
 * ESCALATES to the owner (a `director_activity` `escalated` row) instead of appending another Fix N — the
 * fixes aren't converging. Never throws — the auto-merge tests-gate fails CLOSED on a missing green signal,
 * so a failed spawn never lets a red PR slip past.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { getSpec, appendFixPhases } from "@/lib/specs-table";
import { recordDirectorActivity } from "@/lib/director-activity";
// vera-harness-error-is-not-a-code-regression Phase 2 — belt-and-suspenders on the pre-merge fix
// authoring path: filter HARNESS/COMMAND-signature failing checks out of the set that appends a Fix
// phase, so a slipped harness `fail` never wedges the origin's build chain with an unbuildable phase.
import { isHarnessCommandFailure } from "@/lib/spec-test-harness-classifier";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Fix-CYCLE cap per origin (fixes-as-phases): after this many `kind='fix'` phases already exist on the
 * origin and the pre-merge spec-test is STILL red, the next RED ESCALATES instead of appending another Fix N.
 * Bounded retry, no infinite churn. Mirrors [[../libraries/regression-agent]] `REGRESSION_LOOP_GUARD_MAX`.
 * Env-overridable.
 */
export const PRE_MERGE_FIX_LOOP_GUARD_MAX = Number(process.env.PRE_MERGE_FIX_LOOP_GUARD_MAX || 2);

export interface PreMergeFailingCheck {
  text: string;
  evidence?: string | null;
  check_key: string;
}

export interface SpawnPreMergeFixInput {
  workspaceId: string;
  /** The origin spec being built — the one whose pre-merge spec-test came back RED. */
  originSlug: string;
  /** The origin spec's human-readable title (retained for callers/log; the fix now lives ON the origin). */
  originTitle: string;
  /** The `claude/*` build branch the failing pre-merge spec-test ran against. */
  branch: string;
  /** Evidence-backed failing checks from the failing pre-merge spec_test_runs row. */
  failing: PreMergeFailingCheck[];
}

export type SpawnPreMergeFixResult =
  | { spawned: true; escalated: false; fixSlug: string; alreadyAuthored: boolean; buildQueued: boolean; attempts: number }
  | { spawned: false; escalated: true; attempts: number; reason: string; depth?: number }
  | { spawned: false; escalated: false; reason: string };

/**
 * The chokepoint: handle a RED pre-merge spec-test for an in-flight build branch by appending fix phases to
 * the origin + resuming its build. `fixSlug` in the result is the ORIGIN slug (the fix lives on the origin
 * now). Best-effort, never throws.
 */
export async function spawnPreMergeFix(admin: Admin, input: SpawnPreMergeFixInput): Promise<SpawnPreMergeFixResult> {
  const { workspaceId, originSlug, branch, failing } = input;
  try {
    // vera-harness-error-is-not-a-code-regression Phase 2 — strip HARNESS/COMMAND-signature checks
    // (missing npm script, command-not-found, ENOENT, missing binary) BEFORE any authoring. A harness
    // fail never ran an assertion, so it isn't a code regression; appending a Fix phase for it wedges
    // the origin's build chain (Bo can't build a nonexistent shell command). Phase 1's normalizer
    // downgrades these to `needs_human` before they reach this filter, but a slipped fail (legacy row,
    // race) still stops here — only genuine code fails can author a Bo fix phase.
    const cleanFailing = (failing || [])
      .filter((f) => f && f.check_key && f.text)
      .filter((f) => !isHarnessCommandFailure(f.evidence ?? null));
    if (cleanFailing.length === 0) {
      return { spawned: false, escalated: false, reason: "no evidence-backed failing checks — nothing to fix" };
    }

    const origin = await getSpec(workspaceId, originSlug);
    if (!origin) {
      return { spawned: false, escalated: false, reason: `origin spec ${originSlug} not found — cannot append fix phase` };
    }
    const existingFixPhases = (origin.phases || []).filter((p) => p.kind === "fix");

    // Loop-guard (fixes-as-phases): bound the fix CYCLES on this origin. At the cap, a still-red re-test
    // means the fixes aren't converging → ESCALATE, don't append another Fix N. The auto-merge tests-gate
    // keeps the PR held in_testing on red, so escalate-without-append never promotes a red build.
    if (existingFixPhases.length >= PRE_MERGE_FIX_LOOP_GUARD_MAX) {
      const reason = `Loop-guard: ${existingFixPhases.length} fix phase(s) already on ${originSlug} and the pre-merge spec-test is STILL red — a deeper issue than another Fix N can solve. Escalated to the owner; the PR stays held in_testing.`;
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: "platform",
        actionKind: "escalated",
        specSlug: originSlug,
        reason,
        metadata: {
          signature: "fixes-as-phases-loop-guard",
          branch,
          fix_phases: existingFixPhases.length,
          loop_guard_max: PRE_MERGE_FIX_LOOP_GUARD_MAX,
          failing_check_keys: cleanFailing.map((f) => f.check_key),
        },
      });
      console.log(`[pre-merge-fix] LOOP-GUARD escalation for ${originSlug} (branch ${branch}): ${existingFixPhases.length} fix phases already`);
      return { spawned: false, escalated: true, attempts: existingFixPhases.length, reason };
    }

    // Dedup: if an UNBUILT fix phase already covers these exact failing check keys, the fix is already
    // appended + its resumed build queued — converge (re-kick the chain, don't append a duplicate).
    const keySig = [...new Set(cleanFailing.map((f) => f.check_key))].sort().join(",");
    const pending = existingFixPhases.find(
      (p) =>
        p.status !== "shipped" &&
        p.status !== "rejected" &&
        !p.build_sha &&
        [...new Set(p.origin_check_keys || [])].sort().join(",") === keySig,
    );

    const checkKeys = cleanFailing.map((f) => f.check_key);
    const fixNum = existingFixPhases.length + 1;

    if (!pending) {
      const phaseBody = [
        `The pre-merge spec-test for [[${originSlug}]] on branch \`${branch}\` FAILED — ${cleanFailing.length} verification check${cleanFailing.length === 1 ? "" : "s"} returned \`fail\` against the per-build preview deploy. Fix them on THIS branch (resumed session); the origin re-spec-tests itself when this Fix phase ships.`,
        "",
        "Failing checks observed on the preview:",
        ...cleanFailing.map((c, i) => `${i + 1}. [check ${c.check_key}] ${c.text}${c.evidence ? `\n   evidence: ${c.evidence}` : ""}`),
        "",
        "Investigate each failure against the origin spec + the brain + the code, then land the smallest change",
        "that makes every failing check pass against the preview without regressing other shipped behaviour.",
      ].join("\n");
      const verification = [
        `- Re-running the box spec-test on [[${originSlug}]] once this Fix ships → every previously-failing check`,
        `  flips to \`pass\` (none of these check keys re-appear under \`verdict='fail'\` on the origin's next`,
        `  \`spec_test_runs\` row):`,
        ...cleanFailing.map((c, i) => `  ${i + 1}. [check ${c.check_key}] ${c.text}`),
      ].join("\n");
      const appended = await appendFixPhases(workspaceId, originSlug, [
        {
          title: `Fix ${fixNum} — resolve ${cleanFailing.length} pre-merge spec-test regression${cleanFailing.length === 1 ? "" : "s"}`,
          body: phaseBody,
          verification,
          origin_check_keys: checkKeys,
        },
      ]);
      if (appended.appended === 0) {
        return { spawned: false, escalated: false, reason: `appendFixPhases wrote 0 rows for ${originSlug}` };
      }
    }

    // Reactive resumed build: queueNextChainedPhase picks the first planned phase (this Fix), resolves the
    // resume candidate (the origin's build session), and enqueues a queued_resume build on the origin's
    // branch — dedup-guarded, so an in-flight build no-ops. This is the "instant resumed session build" the
    // fix concept requires; no separate fix-<slug> build.
    let buildQueued = false;
    try {
      const { queueNextChainedPhase } = await import("@/lib/agent-jobs");
      const queued = await queueNextChainedPhase(workspaceId, originSlug);
      buildQueued = !!queued;
    } catch (e) {
      console.warn(`[pre-merge-fix] queueNextChainedPhase for ${originSlug} threw (non-fatal): ${e instanceof Error ? e.message : e}`);
    }

    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: "platform",
      actionKind: "authored_fix",
      specSlug: originSlug,
      reason: pending
        ? `Pre-merge spec-test on ${originSlug} (branch ${branch}) RED — Fix phase for these checks already appended; re-kicked the resumed build.`
        : `Pre-merge spec-test on ${originSlug} (branch ${branch}) RED → appended Fix ${fixNum} phase (${cleanFailing.length} check${cleanFailing.length === 1 ? "" : "s"}) to the origin + resumed its build. The spec dropped back to in_progress and self-re-tests when the fix ships.`,
      metadata: {
        signature: "fixes-as-phases",
        branch,
        origin_slug: originSlug,
        fix_number: fixNum,
        failing_check_keys: checkKeys,
        loop_guard_max: PRE_MERGE_FIX_LOOP_GUARD_MAX,
      },
    });
    return { spawned: true, escalated: false, fixSlug: originSlug, alreadyAuthored: !!pending, buildQueued, attempts: existingFixPhases.length };
  } catch (e) {
    console.warn(`[pre-merge-fix] spawnPreMergeFix threw for ${input.originSlug}: ${e instanceof Error ? e.message : e}`);
    return { spawned: false, escalated: false, reason: `spawn threw: ${e instanceof Error ? e.message : e}` };
  }
}
