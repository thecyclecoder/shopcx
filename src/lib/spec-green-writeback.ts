/**
 * spec-green-writeback — reflect a spec's green verification state back onto its markdown file
 * (spec-test-maximize-machine-coverage Phase 3).
 *
 * A `## Verification` bullet is green when its latest-agent check is `pass` OR the owner marked it
 * `✓ Tested` (see deriveGreenBullets in spec-test-runs.ts). This writer annotates each green bullet in
 * `docs/brain/specs/{slug}.md` with a **leading ✅** (and strips it from any non-green bullet, so an
 * owner re-open clears it), then commits to `main` via the GitHub Contents API — a content writeback
 * gated like other box commits. It only ever rewrites the leading ✅ of a verification bullet; it never
 * touches the spec's logic. Fires from two triggers: the box `runSpecTestJob` after a run lands, and
 * the owner-gated human-queue POST when the owner marks/clears a check.
 *
 * Runs in BOTH runtimes — the box worker (GITHUB_TOKEN in the worker env) and the Vercel API route
 * (same token, same Contents-API pattern as improve-plan-executor). Best-effort: it returns a result
 * object and never throws — a failed commit must not break the owner's ✓ Tested click or the box run.
 */
import {
  GREEN_CHECK,
  getLatestSpecTestRuns,
  getHumanCheckResolutions,
  parseVerificationBullets,
  deriveGreenBullets,
} from "@/lib/spec-test-runs";

const REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";
function ghToken() {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}

async function gh(method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

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
 * Recompute the green state of every `## Verification` bullet for `slug` and reflect it onto the spec
 * markdown on `main` (prepend/strip the leading ✅). Idempotent — a no-op if the file already matches.
 */
export async function reflectSpecGreenChecks(workspaceId: string, slug: string): Promise<GreenWritebackResult> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return SKIP("invalid slug");
  if (!ghToken()) return SKIP("no GitHub token");

  const path = `docs/brain/specs/${slug}.md`;
  let raw: string;
  let sha: string | undefined;
  try {
    const get = await gh("GET", `/repos/${REPO}/contents/${path}?ref=main`);
    if (!get.ok) return SKIP(`spec not on main (${get.status})`);
    sha = (get.json as { sha?: string }).sha;
    raw = Buffer.from(String((get.json as { content?: string }).content || "").replace(/\s/g, ""), "base64").toString("utf8");
  } catch (e) {
    return SKIP(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const bullets = parseVerificationBullets(raw);
  if (bullets.length === 0) return { ok: true, changed: false, allGreen: false, greenCount: 0, total: 0, reason: "no verification bullets" };

  const [runs, resolutions] = await Promise.all([
    getLatestSpecTestRuns(workspaceId),
    getHumanCheckResolutions(workspaceId),
  ]);
  const run = runs[slug] ?? null;
  const green = deriveGreenBullets(bullets.map((b) => b.text), run, resolutions, slug);
  const greenCount = green.filter((g) => g.green).length;
  const allGreen = greenCount === bullets.length;

  // Rewrite each bullet's first line: ensure a leading ✅ iff green, strip it iff not green. Idempotent.
  const lines = raw.split("\n");
  const greenRe = new RegExp(`^${GREEN_CHECK}\\s+`);
  let changed = false;
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    const isGreen = green[i].green;
    if (isGreen === b.hasCheck) continue; // already in the right state
    const line = lines[b.startLine];
    const m = /^- (.*)$/.exec(line);
    if (!m) continue;
    const body = m[1].replace(greenRe, "");
    lines[b.startLine] = isGreen ? `- ${GREEN_CHECK} ${body}` : `- ${body}`;
    changed = true;
  }

  if (!changed) return { ok: true, changed: false, allGreen, greenCount, total: bullets.length };

  const newContent = lines.join("\n");
  try {
    const put = await gh("PUT", `/repos/${REPO}/contents/${path}`, {
      message: `spec-test: reflect ${greenCount}/${bullets.length} green checks on ${slug}`,
      content: Buffer.from(newContent, "utf8").toString("base64"),
      sha,
      branch: "main",
    });
    if (!put.ok) return { ok: false, changed: false, allGreen, greenCount, total: bullets.length, reason: `commit failed (${put.status})` };
  } catch (e) {
    return { ok: false, changed: false, allGreen, greenCount, total: bullets.length, reason: `commit failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  return { ok: true, changed: true, allGreen, greenCount, total: bullets.length };
}
