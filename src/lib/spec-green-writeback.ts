/**
 * spec-green-writeback — used to commit a leading ✅ on each green `## Verification` bullet of
 * `docs/brain/specs/{slug}.md` (one of the six git-committing status writers). spec-status-db-driven
 * Phase 2 retired the commit: a bullet's "green" state is already derivable from spec_test_runs +
 * spec_test_human_checks (see `deriveGreenBullets` in spec-test-runs.ts), and the dashboard renders
 * that DB-derived state directly. So the writeback reports the computed counts (useful for the
 * "all-green → archive" hand-off) but never commits to `main`. Zero deploys.
 *
 * spec-pm-markdown-purge (2026-06-25): the spec body is now read from the DB (`getSpec` →
 * `public.specs` + `public.spec_phases`, reconstructing the `## Verification` section) instead of
 * `docs/brain/specs/{slug}.md`. This was the LAST per-spec markdown reader; the .md files are gone.
 */
import { getLatestSpecTestRuns, getHumanCheckResolutions, parseVerificationBullets, deriveGreenBullets } from "@/lib/spec-test-runs";
import { getSpec } from "@/lib/brain-roadmap";

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
 * Recompute the green state of every `## Verification` bullet for `slug`. Returns the green/total
 * counts so the caller can hand off to fold/archive on all-green. spec-status-db-driven Phase 2: this
 * no longer commits to `main` — the dashboard derives green from spec_test_runs + human_checks
 * directly. `changed` is always false (no markdown mutation).
 */
export async function reflectSpecGreenChecks(workspaceId: string, slug: string): Promise<GreenWritebackResult> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return SKIP("invalid slug");
  // Read the spec body from the DB (getSpec reconstructs the markdown — incl. the `## Verification`
  // section — from `public.specs` + `public.spec_phases`). Replaces the old docs/brain/specs/{slug}.md
  // read (spec-pm-markdown-purge).
  let raw: string;
  try {
    const spec = await getSpec(slug, workspaceId);
    if (!spec) return SKIP("spec not in DB");
    raw = spec.raw;
  } catch (e) {
    return SKIP(`spec read failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const bullets = parseVerificationBullets(raw);
  if (bullets.length === 0) {
    return { ok: true, changed: false, allGreen: false, greenCount: 0, total: 0, reason: "no verification bullets" };
  }

  const [runs, resolutions] = await Promise.all([
    getLatestSpecTestRuns(workspaceId),
    getHumanCheckResolutions(workspaceId),
  ]);
  const run = runs[slug] ?? null;
  const green = deriveGreenBullets(bullets.map((b) => b.text), run, resolutions, slug);
  const greenCount = green.filter((g) => g.green).length;
  const allGreen = greenCount === bullets.length;

  return { ok: true, changed: false, allGreen, greenCount, total: bullets.length };
}
