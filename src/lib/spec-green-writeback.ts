/**
 * spec-green-writeback — computes the green state of a spec's verification checks from the DB.
 *
 * Historically ONE OF THE SIX git-committing status writers that PUT `docs/brain/specs/{slug}.md`
 * to main; all six were retired to DB writes in `spec-status-db-driven` (Phases 1–4). This surface
 * kept its name for callers but is COMPUTED-ONLY — a check's "green" state derives from
 * `spec_test_runs` + `spec_test_human_checks` (see `deriveGreenBullets` in spec-test-runs.ts), and
 * the dashboard renders that DB-derived state directly. Under retire-md-spec-writers-db-is-sole-spec
 * Phase 2 the "DB is the spec" invariant is closed: this file has NO git write path.
 *
 * pm-structured-intent-and-refs Phase 3/4: the check source is now `spec_phase_checks` rows via
 * `listSpecPhaseChecks(spec)` — no parse of the rendered spec body. The rendered markdown from
 * `getSpec()` remains display-only.
 */
import { getLatestSpecTestRuns, getHumanCheckResolutions, deriveGreenBullets } from "@/lib/spec-test-runs";
import { getSpec } from "@/lib/specs-table";
import { listSpecPhaseChecks } from "@/lib/spec-phase-checks-table";
import { getActiveWorkspaceId } from "@/lib/workspace";

export interface GreenWritebackResult {
  ok: boolean;
  changed: boolean;
  allGreen: boolean;
  greenCount: number;
  total: number;
  reason?: string;
}

const SKIP = (reason: string): GreenWritebackResult => ({ ok: false, changed: false, allGreen: false, greenCount: 0, total: 0, reason });

/**
 * Recompute the green state of every verification check for `slug`. Returns green/total counts so the
 * caller can hand off to fold/archive on all-green. Under `spec-status-db-driven` Phase 2 + pm-
 * structured-intent-and-refs Phase 3 this reads `spec_phase_checks` rows straight from the DB (falling
 * back to the `spec_phases.verification` column only when rows haven't been backfilled yet — still a
 * column read, never a markdown parse). `changed` is always false (no markdown mutation).
 */
export async function reflectSpecGreenChecks(workspaceId: string, slug: string): Promise<GreenWritebackResult> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return SKIP("invalid slug");
  const wsId = workspaceId || (await getActiveWorkspaceId());
  if (!wsId) return SKIP("no workspace");
  let bullets: string[];
  try {
    const spec = await getSpec(wsId, slug);
    if (!spec) return SKIP("spec not in DB");
    const checks = await listSpecPhaseChecks({
      phases: spec.phases.map((p) => ({ id: p.id, position: p.position, verification: p.verification })),
    });
    bullets = checks.map((c) => c.text);
  } catch (e) {
    return SKIP(`spec read failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (bullets.length === 0) {
    return { ok: true, changed: false, allGreen: false, greenCount: 0, total: 0, reason: "no verification checks" };
  }

  const [runs, resolutions] = await Promise.all([
    getLatestSpecTestRuns(wsId),
    getHumanCheckResolutions(wsId),
  ]);
  const run = runs[slug] ?? null;
  const green = deriveGreenBullets(bullets, run, resolutions, slug);
  const greenCount = green.filter((g) => g.green).length;
  const allGreen = greenCount === bullets.length;

  return { ok: true, changed: false, allGreen, greenCount, total: bullets.length };
}
