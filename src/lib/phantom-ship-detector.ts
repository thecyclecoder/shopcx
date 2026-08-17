/**
 * phantom-ship-detector — the standing audit that surfaces phases marked `shipped` whose real code
 * ISN'T on the target branch ([[../specs/merge-gate-verifies-real-phase-checks-not-status-flags]]
 * Phase 3).
 *
 * Complements the existing [[spec-audit]] (origin/main-only, status_history-driven). This scans
 * EVERY active spec, resolves its target branch (`origin/goal/{goal-slug}` for a goal-bound spec,
 * `origin/main` otherwise), and for every phase marked `shipped` runs its grep checks against that
 * branch HEAD via [[specs-table]] `verifyPhaseAccumulatedOnBranch`. A phase whose verifier reports
 * `accumulated:false` on the branch is a PHANTOM (status flag says shipped, code isn't there — the
 * v3 factor-rollup-sdk-with-significance-gate class the spec cites).
 *
 * Read-only. Chained into `predeploy` via `scripts/_check-phantom-shipped-phases.ts` so a phantom
 * fails the pipeline gate red instead of silently sitting on the board.
 */
import {
  verifyPhaseAccumulatedOnBranch,
  listSpecs,
  type VerifyPhaseDeps,
} from "@/lib/specs-table";
import { resolveGoalSlugForSpec } from "@/lib/agent-jobs";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Resolve the BRANCH NAME (bare — no `origin/` prefix) a spec's shipped phases MUST have their code on:
 *  - a goal-bound spec merges to its goal branch first (M4) and stays there until the atomic goal→main
 *    promotion (M5), so its shipped-on-branch signal lives on branch `goal/{goal-slug}`;
 *  - a one-off (non-goal-bound) spec ships direct to main, so its target branch is `main`.
 *
 * ⭐ [[../specs/a-merge-stamps-only-the-phases-whose-code-it-actually-contains]] Phase 4 (Fix 2) —
 * this helper returns the BARE branch name (not the `origin/{name}` remote-tracking ref). The
 * accumulation verifier's [[specs-table]] `resolveBranchRefForVerification` prepends `origin/`
 * itself as part of the origin-first refresh contract; a `origin/`-prefixed input here would
 * double-prefix to `origin/origin/main` and blow up as `fatal: couldn't find remote ref
 * refs/heads/origin/main` — exactly the failing state Phase 4 was named to fix. The wire test in
 * `phantom-ship-detector.test.ts` pins that the return value MUST NOT start with `origin/`.
 *
 * PURE — no I/O. Callers pass the already-resolved goal slug (or null). The full-DB resolver is
 * `resolvePhantomShipTargetBranch` below; this pure helper is what the detector's tests drive.
 */
export function branchForGoal(goalSlug: string | null): string {
  return goalSlug && goalSlug.trim() ? `goal/${goalSlug.trim()}` : "main";
}

/**
 * DB-backed resolver — resolves the spec's goal slug via [[agent-jobs]] `resolveGoalSlugForSpec` and
 * returns the target branch. Used as the default `resolveTargetBranch` dep; unit tests inject their
 * own resolver so no DB is required.
 */
export async function resolvePhantomShipTargetBranch(
  workspaceId: string,
  slug: string,
): Promise<string> {
  const goalSlug = await resolveGoalSlugForSpec(workspaceId, slug);
  return branchForGoal(goalSlug);
}

export interface PhantomShipReport {
  /** Total number of shipped phases the detector actually verified against a branch. */
  scanned: number;
  /** Total number of specs the detector opened (across every workspace). */
  specsScanned: number;
  /** Workspaces the detector enumerated. */
  workspacesScanned: number;
  /** Phases marked `shipped` whose verifier reported `accumulated:false` on the target branch. */
  phantoms: Array<{
    workspaceId: string;
    slug: string;
    position: number;
    branch: string;
    reason: string;
  }>;
}

export interface DetectorDeps {
  /** Enumerate every workspace that has ≥1 spec — the detector fans out over each. */
  listWorkspaces: () => Promise<string[]>;
  /** Return the ACTIVE (non-folded) specs for a workspace with their phase positions + statuses. */
  listActiveSpecsFor: (
    workspaceId: string,
  ) => Promise<
    Array<{ slug: string; phases: Array<{ position: number; status: string }> }>
  >;
  /** Resolve the target branch a spec's shipped phases must have their code on. */
  resolveTargetBranch: (workspaceId: string, slug: string) => Promise<string>;
  /** DI hook forwarded to `verifyPhaseAccumulatedOnBranch` — tests inject a mock verifier. */
  verifyDeps?: VerifyPhaseDeps;
}

async function defaultListWorkspaces(): Promise<string[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("specs").select("workspace_id");
  if (error) throw error;
  const seen = new Set<string>();
  for (const r of (data ?? []) as { workspace_id: string }[]) {
    if (r.workspace_id) seen.add(r.workspace_id);
  }
  return [...seen];
}

async function defaultListActiveSpecsFor(
  workspaceId: string,
): Promise<Array<{ slug: string; phases: Array<{ position: number; status: string }> }>> {
  // ⭐ ACTIVE-scope only (coaching guardrail): the enumeration source must be filtered to non-folded
  // specs so the detector never chases a phantom on an archived spec. The guard on this fan-out lives
  // HERE, not at the mutation site (there is no mutation — the detector only READS + reports).
  const rows = await listSpecs(workspaceId, { scope: "active" });
  return rows.map((r) => ({
    slug: r.slug,
    phases: r.phases.map((p) => ({ position: p.position, status: p.status as string })),
  }));
}

export const defaultDetectorDeps: DetectorDeps = {
  listWorkspaces: defaultListWorkspaces,
  listActiveSpecsFor: defaultListActiveSpecsFor,
  resolveTargetBranch: resolvePhantomShipTargetBranch,
};

/**
 * detectPhantomShippedPhases — for every ACTIVE spec × every phase marked `shipped`, verify its grep
 * checks pass on the target branch HEAD (goal branch for goal-bound specs, `origin/main` otherwise).
 * A phase whose verifier reports `accumulated:false` is recorded as a PHANTOM.
 *
 * Best-effort per spec — a failing branch resolve / listing throws are caught at the CLI wrapper; the
 * detector itself surfaces every phantom it can find without shortcuts. No mutations anywhere on this
 * path (the wedge is that mutations HAVE already happened — flipping a phase shipped without code —
 * so surfacing them is the fix).
 */
export async function detectPhantomShippedPhases(
  deps: DetectorDeps = defaultDetectorDeps,
): Promise<PhantomShipReport> {
  const workspaces = await deps.listWorkspaces();
  const report: PhantomShipReport = {
    scanned: 0,
    specsScanned: 0,
    workspacesScanned: workspaces.length,
    phantoms: [],
  };
  for (const workspaceId of workspaces) {
    const specs = await deps.listActiveSpecsFor(workspaceId);
    for (const spec of specs) {
      report.specsScanned++;
      const shipped = spec.phases.filter((p) => p.status === "shipped");
      if (!shipped.length) continue;
      // Bare branch name from `branchForGoal` — `verifyPhaseAccumulatedOnBranch`'s runGitGrepOnBranch
      // routes through `resolveBranchRefForVerification`, which prepends `origin/` and refuses a
      // pre-prefixed input (Phase 4 fix). Display in the phantom report keeps the `origin/{name}`
      // form so a human reads "on origin/main" — the ref actually grepped.
      const branch = await deps.resolveTargetBranch(workspaceId, spec.slug);
      for (const p of shipped) {
        report.scanned++;
        const v = await verifyPhaseAccumulatedOnBranch(
          workspaceId,
          spec.slug,
          p.position,
          branch,
          deps.verifyDeps,
        );
        if (!v.accumulated) {
          report.phantoms.push({
            workspaceId,
            slug: spec.slug,
            position: p.position,
            branch: `origin/${branch}`,
            reason: v.reason,
          });
        }
      }
    }
  }
  return report;
}
