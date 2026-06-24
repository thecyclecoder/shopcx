/**
 * spec-green-writeback — used to commit a leading ✅ on each green `## Verification` bullet of
 * `docs/brain/specs/{slug}.md` (one of the six git-committing status writers). spec-status-db-driven
 * Phase 2 retires the commit: a bullet's "green" state is already derivable from spec_test_runs +
 * spec_test_human_checks (see `deriveGreenBullets` in spec-test-runs.ts), and the dashboard renders
 * that DB-derived state directly. So the writeback now reports the computed counts (useful for the
 * "all-green → archive" hand-off) but never commits to `main`. Zero deploys.
 */
import { getLatestSpecTestRuns, getHumanCheckResolutions, parseVerificationBullets, deriveGreenBullets } from "@/lib/spec-test-runs";
import { promises as fs } from "fs";
import path from "path";

const SPECS_DIR = path.join(process.cwd(), "docs", "brain", "specs");

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
  let raw: string;
  try {
    raw = await fs.readFile(path.join(SPECS_DIR, `${slug}.md`), "utf8");
  } catch (e) {
    return SKIP(`spec not on disk: ${e instanceof Error ? e.message : String(e)}`);
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
