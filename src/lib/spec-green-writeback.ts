/**
 * spec-green-writeback — computes the green state of a spec's `## Verification` bullets from the DB.
 *
 * Historically ONE OF THE SIX git-committing status writers that PUT `docs/brain/specs/{slug}.md`
 * to main; all six were retired to DB writes in `spec-status-db-driven` (Phases 1–4). This surface
 * kept its name for callers but is COMPUTED-ONLY — a bullet's "green" state derives from
 * `spec_test_runs` + `spec_test_human_checks` (see `deriveGreenBullets` in spec-test-runs.ts), and
 * the dashboard renders that DB-derived state directly. Under retire-md-spec-writers-db-is-sole-spec
 * Phase 2 the "DB is the spec" invariant is closed: this file has NO git write path.
 *
 * The spec body itself is read from the DB (`getSpec` → `public.specs` + `public.spec_phases`,
 * reconstructing the `## Verification` section). No per-spec markdown reader survives.
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
