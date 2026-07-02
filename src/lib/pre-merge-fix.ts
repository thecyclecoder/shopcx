/**
 * pre-merge-fix — Phase 2 of [[../specs/promote-on-green-merge-gate]]: on a RED pre-merge spec-test,
 * spawn a fix-spec via the existing fix-spec mechanism + apply a loop-guard so a stuck build escalates
 * to the owner instead of churning tokens. The auto-merge gate's tests-gate (Phase 1) already HOLDS the
 * PR `in_testing` on red; this module is the "spawns a fix" half — what the spec calls "the same
 * mechanism that re-tests an origin after a fix lands" ([[../libraries/agent-jobs]] `retestOriginIfFixMerged`
 * reads `specs.regression_of_slug`, which this module sets on every fix-spec it authors).
 *
 *   1. Loop-guard FIRST — `countPreMergeFixAttempts` counts distinct prior fix-specs for THIS origin
 *      via `specs.regression_of_slug = origin`. At `PRE_MERGE_FIX_LOOP_GUARD_MAX` the next call
 *      ESCALATES (a `director_activity` `escalated` row, no new fix-spec). Mirrors
 *      [[../libraries/regression-agent]] `REGRESSION_LOOP_GUARD_MAX`, [[../libraries/deploy-guardian]]
 *      `DEPLOY_GUARDIAN_LOOP_GUARD_MAX`, and [[github-pr-resolve]] `MAX_PR_RESOLVE_ATTEMPTS`. Hitting
 *      the rail = escalate, not execute.
 *   2. Otherwise — author a deterministic `fix-{origin}-{hash}` spec (UPSERT — a re-spawn against the
 *      SAME failing-check set converges on the SAME slug, idempotent), carrying `regression_of_slug =
 *      origin` so `retestOriginIfFixMerged` re-runs the ORIGIN's spec-test once the fix lands. Mark the
 *      card `in_review`, then enqueue ONE `kind='build'` job (dedup against any existing build row for
 *      the slug — convergent on a re-spawn).
 *
 * Never throws — the auto-merge gate's tests-gate fails CLOSED on a missing green signal anyway, so a
 * failed spawn never lets a red PR slip past the gate.
 */
import { createHash } from "crypto";
import type { createAdminClient } from "@/lib/supabase/admin";
import { authorSpecRowStructured } from "@/lib/author-spec";
import { markSpecCardForReview } from "@/lib/spec-card-state";
import { getSpec } from "@/lib/specs-table";
import { recordDirectorActivity } from "@/lib/director-activity";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Pre-merge spec-test RED → fix-spec loop-guard cap. After this many distinct fix-specs already exist
 * for the origin, the next RED spawn ESCALATES (a `director_activity` `escalated` row) instead of
 * authoring another fix — bounded retry, no infinite churn. Mirrors
 * [[../libraries/regression-agent]] `REGRESSION_LOOP_GUARD_MAX` (2),
 * [[../libraries/deploy-guardian]] `DEPLOY_GUARDIAN_LOOP_GUARD_MAX` (2), and
 * [[github-pr-resolve]] `MAX_PR_RESOLVE_ATTEMPTS` (3). Env-overridable.
 */
export const PRE_MERGE_FIX_LOOP_GUARD_MAX = Number(process.env.PRE_MERGE_FIX_LOOP_GUARD_MAX || 2);

/**
 * Depth cap on the `regression_of_slug` CHAIN — the fix-of-fix escalation rail. The existing breadth
 * guard (`PRE_MERGE_FIX_LOOP_GUARD_MAX`) counts DIRECT siblings under ONE origin (`regression_of_slug =
 * origin`), so when `fix-X`'s own pre-merge spec-test goes red the caller re-invokes `spawnPreMergeFix`
 * with `originSlug=fix-X`, and `countPreMergeFixAttempts('fix-X')` counts `fix-fix-X` starting at 0 —
 * DEPTH is never consulted and the fix→fix-fix→fix-fix-fix chain is unbounded (observed live 2026-07-02
 * on `fix-vault-post-merge-diff-backstop` → `fix-fix-vault-post-merge-diff-backstop`). At depth 1 = allow
 * ONE generation of fix (a fix of an origin); a fix-of-fix (depth ≥ 2) ESCALATES instead of authoring
 * `fix-fix-...`. Env-overridable.
 */
export const PRE_MERGE_FIX_MAX_DEPTH = Number(process.env.PRE_MERGE_FIX_MAX_DEPTH || 1);

/**
 * Hard cap on the chain walk hops — even if the DB carries a cyclic `regression_of_slug` fixture,
 * `preMergeFixChainDepth` never infinite-loops. 10 is an order of magnitude past the useful cap
 * (`PRE_MERGE_FIX_MAX_DEPTH` = 1); a real chain never reaches this.
 */
const PRE_MERGE_FIX_CHAIN_HOP_CAP = 10;

/**
 * Walk the `regression_of_slug` chain from `originSlug` upward and return the number of hops until the
 * column is null (a true origin) OR the chain self-references (`origin === slug`, the same stop
 * `retestOriginIfFixMerged` uses at [[../libraries/agent-jobs]]:1975) OR a slug repeats (defensive
 * against cyclic data) OR the hop cap fires. So for the chain `X ← fix-X ← fix-fix-X`:
 *   - `preMergeFixChainDepth(admin, ws, 'X')` → 0 (no regression_of_slug)
 *   - `preMergeFixChainDepth(admin, ws, 'fix-X')` → 1 (one hop to X)
 *   - `preMergeFixChainDepth(admin, ws, 'fix-fix-X')` → 2 (two hops to X)
 *
 * Read-only + best-effort — a DB read error terminates the walk at the current depth (returns what it's
 * counted so far) so a transient blip never blocks the first spawn AND never accidentally allows an
 * unbounded chain by returning 0. Uses `admin` directly (one-column read) rather than `getSpec` (which
 * would extra-round-trip the phases) — same underlying `specs` row.
 */
export async function preMergeFixChainDepth(
  admin: Admin,
  workspaceId: string,
  originSlug: string,
): Promise<number> {
  if (!originSlug || !workspaceId) return 0;
  let depth = 0;
  let current = originSlug;
  const seen = new Set<string>([current]);
  for (let hop = 0; hop < PRE_MERGE_FIX_CHAIN_HOP_CAP; hop++) {
    try {
      const { data, error } = await admin
        .from("specs")
        .select("regression_of_slug")
        .eq("workspace_id", workspaceId)
        .eq("slug", current)
        .maybeSingle();
      if (error) {
        console.warn(`[pre-merge-fix] preMergeFixChainDepth read failed for ${current}: ${error.message}`);
        return depth;
      }
      const parent = (data?.regression_of_slug ?? null) as string | null;
      // A true origin — the walk terminates naturally.
      if (!parent) return depth;
      // Self-referential stop: mirrors `retestOriginIfFixMerged` at agent-jobs.ts:1975 — a row whose
      // `regression_of_slug` points at itself is not a fix, it's a data artifact; treat it as an origin.
      if (parent === current) return depth;
      // Defensive: a cyclic chain (A → B → A) that never self-references at a single hop; the hop cap
      // would also catch this, but re-seeing a slug is a clearer signal to stop.
      if (seen.has(parent)) return depth + 1;
      seen.add(parent);
      depth += 1;
      current = parent;
    } catch (e) {
      console.warn(`[pre-merge-fix] preMergeFixChainDepth threw at ${current}: ${e instanceof Error ? e.message : e}`);
      return depth;
    }
  }
  return depth;
}

/**
 * Deterministic fix-spec slug = `fix-{origin}-{6hex of failing-check-key set}`. Same origin + same set
 * of failing checks → same slug → UPSERT (author) + dedup (enqueue) converge on a re-spawn (no churn).
 * A NEW failing check on the same origin → different hash → a new fix-spec (a genuinely new break gets
 * its own attempt + counts toward the loop-guard). Mirrors the inline owner Request-a-fix route
 * ([[../app/api/roadmap/spec-test/request-fix/route]]) so a click + an autonomous spawn on the SAME
 * break converge to one slug. Capped to keep the slug addressable as a kebab spec.
 */
export function buildPreMergeFixSlug(originSlug: string, failingKeys: string[]): string {
  const keys = [...new Set(failingKeys.map((k) => String(k || "").trim()).filter(Boolean))].sort();
  const hash = createHash("sha1").update(keys.join("|")).digest("hex").slice(0, 6);
  const trimmedOrigin = originSlug.length > 80 ? originSlug.slice(0, 80) : originSlug;
  return `fix-${trimmedOrigin}-${hash}`;
}

/**
 * Loop-guard ledger: distinct fix-specs already authored for THIS origin (specs.regression_of_slug =
 * origin). One spec = one fix attempt regardless of whether its build merged, failed, or is still
 * in-flight — what the loop-guard caps is the number of times we *tried*, not how many landed.
 * Read-only + best-effort: a DB read error returns 0 so a transient blip never blocks the first spawn.
 */
export async function countPreMergeFixAttempts(admin: Admin, originSlug: string): Promise<number> {
  if (!originSlug) return 0;
  try {
    const { data, error } = await admin
      .from("specs")
      .select("slug")
      .eq("regression_of_slug", originSlug);
    if (error) {
      console.warn(`[pre-merge-fix] countPreMergeFixAttempts read failed for ${originSlug}: ${error.message}`);
      return 0;
    }
    return (data ?? []).length;
  } catch (e) {
    console.warn(`[pre-merge-fix] countPreMergeFixAttempts threw for ${originSlug}: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

export interface PreMergeFailingCheck {
  text: string;
  evidence?: string | null;
  check_key: string;
}

export interface SpawnPreMergeFixInput {
  workspaceId: string;
  /** The origin spec being built — the one whose pre-merge spec-test came back RED. */
  originSlug: string;
  /** The origin spec's human-readable title (used in the fix-spec title; degrades to the slug). */
  originTitle: string;
  /** The `claude/*` build branch the failing pre-merge spec-test ran against. */
  branch: string;
  /** Evidence-backed failing checks from the failing pre-merge spec_test_runs row. */
  failing: PreMergeFailingCheck[];
}

export type SpawnPreMergeFixResult =
  | { spawned: true; escalated: false; fixSlug: string; alreadyAuthored: boolean; buildQueued: boolean; attempts: number }
  // Escalated by EITHER the depth guard (`depth != null`) or the breadth guard (`depth` absent). The
  // depth-guard case populates `attempts: 0` because it fires BEFORE the attempts read.
  | { spawned: false; escalated: true; attempts: number; reason: string; depth?: number }
  | { spawned: false; escalated: false; reason: string };

/**
 * The Phase-2 chokepoint: handle a RED pre-merge spec-test for an in-flight build branch.
 *
 *   - Loop-guard hit (`attempts >= PRE_MERGE_FIX_LOOP_GUARD_MAX`) → ESCALATE (record a
 *     `director_activity` `escalated` row, no new fix-spec). The auto-merge gate's tests-gate still
 *     holds the origin's PR `in_testing` (Phase 1 fails CLOSED on missing-green), so a no-spawn never
 *     promotes a red build.
 *   - Otherwise → author a deterministic `fix-{origin}-{hash}` spec carrying `regression_of_slug =
 *     origin` (so [[../libraries/agent-jobs]] `retestOriginIfFixMerged` re-runs the origin's spec-test
 *     once the fix's build merges to main, closing the loop), mark the card `in_review`, and enqueue
 *     ONE `kind='build'` job (dedup against any existing build for the slug — convergent re-spawn).
 *
 * Best-effort, never throws. Returns a typed result the caller logs.
 */
export async function spawnPreMergeFix(admin: Admin, input: SpawnPreMergeFixInput): Promise<SpawnPreMergeFixResult> {
  const { workspaceId, originSlug, originTitle, branch, failing } = input;
  try {
    const cleanFailing = (failing || []).filter((f) => f && f.check_key && f.text);
    if (cleanFailing.length === 0) {
      return { spawned: false, escalated: false, reason: "no evidence-backed failing checks — nothing to fix" };
    }

    // DEPTH guard FIRST — bounds the fix-of-fix chain (`X ← fix-X ← fix-fix-X`). The BREADTH guard
    // below counts direct siblings under ONE origin (`regression_of_slug = origin`), so when `fix-X`'s
    // own pre-merge spec-test goes red the caller re-invokes with `originSlug=fix-X` and the breadth
    // count starts back at 0 — DEPTH was never consulted and the chain was unbounded (observed live
    // 2026-07-02). At depth ≥ `PRE_MERGE_FIX_MAX_DEPTH` we ESCALATE (a `director_activity` `escalated`
    // row with `metadata.signature='pre-merge-fix-depth-guard'`, differentiated from the breadth
    // guard's `'pre-merge-fix-loop-guard'`) instead of authoring another fix. The origin PR stays held
    // in_testing by the independent tests-gate above, so escalating-without-spawning never promotes a
    // red build — it just stops the recursion + puts the call on the CEO's ledger.
    const depth = await preMergeFixChainDepth(admin, workspaceId, originSlug);
    if (depth >= PRE_MERGE_FIX_MAX_DEPTH) {
      const reason = `Depth-guard: pre-merge fix-of-fix chain reached depth ${depth} (max ${PRE_MERGE_FIX_MAX_DEPTH}) at ${originSlug} — this is a DEEPER issue than another fix-of-fix can solve. Escalated to the owner; the build's PR stays held in_testing.`;
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: "platform",
        actionKind: "escalated",
        specSlug: originSlug,
        reason,
        metadata: {
          signature: "pre-merge-fix-depth-guard",
          branch,
          depth,
          max_depth: PRE_MERGE_FIX_MAX_DEPTH,
          failing_check_keys: cleanFailing.map((f) => f.check_key),
        },
      });
      console.log(`[pre-merge-fix] DEPTH-GUARD escalation for ${originSlug} (branch ${branch}): chain depth ${depth} >= ${PRE_MERGE_FIX_MAX_DEPTH}`);
      return { spawned: false, escalated: true, attempts: 0, depth, reason };
    }

    // Loop-guard FIRST — never even author the (N+1)th attempt.
    const attempts = await countPreMergeFixAttempts(admin, originSlug);
    if (attempts >= PRE_MERGE_FIX_LOOP_GUARD_MAX) {
      const reason = `Loop-guard: ${attempts} prior pre-merge fix-spec(s) for ${originSlug} did not bring the branch green — this is a DEEPER issue. Escalated to the owner; the build's PR stays held in_testing.`;
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: "platform",
        actionKind: "escalated",
        specSlug: originSlug,
        reason,
        metadata: {
          signature: "pre-merge-fix-loop-guard",
          branch,
          attempts,
          loop_guard_max: PRE_MERGE_FIX_LOOP_GUARD_MAX,
          failing_check_keys: cleanFailing.map((f) => f.check_key),
        },
      });
      console.log(`[pre-merge-fix] LOOP-GUARD escalation for ${originSlug} (branch ${branch}): ${attempts} prior fix attempts`);
      return { spawned: false, escalated: true, attempts, reason };
    }

    // Author a deterministic fix-spec carrying `regression_of_slug = origin`. `retestOriginIfFixMerged`
    // reads that column after the fix's build merges to re-test the origin (closes the loop).
    const fixSlug = buildPreMergeFixSlug(originSlug, cleanFailing.map((f) => f.check_key));
    const origin = await getSpec(workspaceId, originSlug);
    const parent = origin?.parent ?? "";
    const checkKeysJoined = cleanFailing.map((f) => f.check_key).join(", ");

    const phaseBody = [
      `The pre-merge spec-test for [[${originSlug}]] on branch \`${branch}\` FAILED — ${cleanFailing.length} verification check${cleanFailing.length === 1 ? "" : "s"} returned \`fail\` against the per-build preview deploy.`,
      "",
      `**Regression-of:** [[${originSlug}]]`,
      `**Fixes:** ${originSlug} (check ${checkKeysJoined})`,
      "",
      "Failing checks observed on the preview:",
      ...cleanFailing.map((c, i) => `${i + 1}. [check ${c.check_key}] ${c.text}${c.evidence ? `\n   evidence: ${c.evidence}` : ""}`),
      "",
      "Investigate each failure against the origin spec + the brain + the code, then land the smallest change that",
      "makes every failing check pass against the preview without regressing other shipped behaviour. The auto-merge",
      "gate holds the origin's PR `in_testing` until BOTH the spec-test green AND security green signals settle",
      "for the branch.",
    ].join("\n");

    const verification = [
      `- After this fix ships, re-running the box spec-test on [[${originSlug}]] → expect every previously-failing`,
      `  check to flip to \`pass\` (none of these check keys re-appear under \`verdict='fail'\` on the next`,
      `  \`spec_test_runs\` row for the origin):`,
      ...cleanFailing.map((c, i) => `  ${i + 1}. [check ${c.check_key}] ${c.text}`),
      `- On the origin's pre-merge promote gate → expect \`isSpecTestGreenForBranch(${branch})\` to flip true once`,
      `  the origin's spec-test re-runs clean against the refreshed preview (Phase 1 gate then promotes the PR).`,
    ].join("\n");

    const title = `Fix: ${originTitle || originSlug}`.slice(0, 200);
    const summary = `Pre-merge regression fix for [[${originSlug}]] — restore the ${cleanFailing.length} failing \`## Verification\` check${cleanFailing.length === 1 ? "" : "s"} the box's pre-merge spec-test recorded on branch \`${branch}\`.`;

    let authored = false;
    try {
      authored = await authorSpecRowStructured(
        workspaceId,
        fixSlug,
        {
          title,
          summary,
          owner: "platform",
          parent,
          blocked_by: [],
          critical: false,
          autoBuild: false,
          phases: [
            {
              title: `Fix the pre-merge regression on ${originSlug}`,
              body: phaseBody,
              verification,
              status: "planned",
            },
          ],
        },
        "planned",
        {
          intendedStatusSetBy: "spec-test:pre-merge-red",
          regressionOfSlug: originSlug,
        },
      );
    } catch (e) {
      console.warn(`[pre-merge-fix] authoring ${fixSlug} threw: ${e instanceof Error ? e.message : e}`);
      authored = false;
    }
    if (!authored) {
      return { spawned: false, escalated: false, reason: `authoring ${fixSlug} failed — fix-spec not enqueued` };
    }

    // Mirror the card-state marker every other authoring surface (planner, regression agent,
    // request-fix-inline) sets — keeps the in_review surfaces consistent.
    try {
      await markSpecCardForReview(workspaceId, fixSlug, "planned", {
        actor: "spec-test:pre-merge-red",
        reason: `Auto-spawned by pre-merge spec-test on branch ${branch} for ${originSlug}`,
      });
    } catch (e) {
      console.warn(`[pre-merge-fix] markSpecCardForReview failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    }

    // Build-job dedup: any prior build row (live or terminal) on the same slug means the previous spawn
    // already queued/ran the build; converge to a single build per fix-slug (mirrors the inline
    // Request-a-fix route's idempotency check).
    const { data: existingBuild } = await admin
      .from("agent_jobs")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", fixSlug)
      .eq("kind", "build")
      .limit(1)
      .maybeSingle();
    if (existingBuild) {
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: "platform",
        actionKind: "authored_fix",
        specSlug: fixSlug,
        reason: `Pre-merge spec-test on ${originSlug} (branch ${branch}) RED — converged to existing fix [[${fixSlug}]] (attempt ${attempts + 1}/${PRE_MERGE_FIX_LOOP_GUARD_MAX}); existing build row reused.`,
        metadata: {
          signature: "pre-merge-fix",
          branch,
          attempts,
          origin_slug: originSlug,
          fix_slug: fixSlug,
          loop_guard_max: PRE_MERGE_FIX_LOOP_GUARD_MAX,
        },
      });
      return { spawned: true, escalated: false, fixSlug, alreadyAuthored: true, buildQueued: false, attempts };
    }

    // intentional override of enqueueBuildIfDue (bo-reactive-gated-build-enqueue Phase 1): a pre-merge
    // spec-test RED authored a regression fix spec ONE line above (authorSpecRowStructured), and the
    // fix ships as fast as the box can build it — Vale reviews it after, not before. Routing through
    // the gated chokepoint would return `not-review-passed` and drop the fix on the floor. The
    // claim-time backstop (evaluateClaimTimeBuildGate) still holds if Vale hasn't caught up by claim.
    const { error: insertErr } = await admin.from("agent_jobs").insert({
      workspace_id: workspaceId,
      spec_slug: fixSlug,
      kind: "build",
      status: "queued",
      created_by: null,
      instructions: `Auto-spawned by pre-merge spec-test RED on ${originSlug} (branch ${branch}) — build the regression fix. Follow the spec exactly; tsc-clean; open a PR.`,
    });
    if (insertErr) {
      return { spawned: false, escalated: false, reason: `enqueue build failed: ${insertErr.message}` };
    }

    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: "platform",
      actionKind: "authored_fix",
      specSlug: fixSlug,
      reason: `Pre-merge spec-test on ${originSlug} (branch ${branch}) RED → authored fix [[${fixSlug}]] (attempt ${attempts + 1}/${PRE_MERGE_FIX_LOOP_GUARD_MAX}) + queued its build. Origin PR stays held in_testing until the fix lands + the origin's spec-test re-runs green.`,
      metadata: {
        signature: "pre-merge-fix",
        branch,
        attempts,
        origin_slug: originSlug,
        fix_slug: fixSlug,
        loop_guard_max: PRE_MERGE_FIX_LOOP_GUARD_MAX,
      },
    });
    return { spawned: true, escalated: false, fixSlug, alreadyAuthored: false, buildQueued: true, attempts };
  } catch (e) {
    console.warn(`[pre-merge-fix] spawnPreMergeFix threw for ${input.originSlug}: ${e instanceof Error ? e.message : e}`);
    return { spawned: false, escalated: false, reason: `spawn threw: ${e instanceof Error ? e.message : e}` };
  }
}
