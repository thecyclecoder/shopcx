/**
 * spec-drift — keep a spec's phase status in sync with shipped code (spec-drift-agent spec).
 *
 * Builds keep merging without their `spec_phases.status` advancing to `shipped`, so shipped work parks
 * in the Planned/In-progress columns. This module is the per-phase, EVIDENCE-GATED reconciler that closes
 * that drift. It NEVER guesses "merged ⇒ done": for each phase it weighs two independent signals —
 *
 *   1. a merged `kind='build'` agent_job for the spec (the work was actually shipped), and
 *   2. the phase's claimed code is verifiably on `main` (every file path / migration its body names exists).
 *
 * and acts per-phase:
 *   - merged build  AND all named code on main, status still planned/in_progress → AUTO-STAMP shipped
 *     (via `stampPhaseShipped` — the only status-write surface).
 *   - all named code on main but NO merged build on record (can't be confident it was this phase's
 *     deliberate ship) → SURFACE it as drift for a one-tap owner flip (never a wrong auto-flip).
 *   - code not fully on main, or the phase names no verifiable paths → LEAVE it (genuinely unbuilt:
 *     a fan-out phase, a deferred follow-on). This is the guardrail against over-flagging multi-phase
 *     specs with real pending later phases.
 *
 * DB-only data flow (retire-md-reads-from-pm-flow Phase 2): reads the spec via [[specs-table]] `getSpec`
 * — `spec_phases[i].body` for code-path extraction, `spec_phases[i].status` for the per-phase decision.
 * NO `docs/brain/specs/*.md` HTTP fetch, NO markdown parse. The status writeback is `stampPhaseShipped`
 * on the canonical `spec_phases` row; nothing rewrites a markdown body anymore. The spec's column then
 * follows from the rollup readers (`rollupPhaseStatus` over the post-stamp phase set) — a spec is
 * "shipped" only when EVERY phase is shipped.
 *
 * Two triggers (same engine): the build-merge path ([[agent-jobs]] `applyMergedBuildEffects`, the root
 * fix — Part A) and a Control-Tower self-audit cron backstop (spec-drift-reconcile — Part B). Surfaced
 * drift lands in the `spec_drift` table, rendered on the Control Tower for a one-tap flip. See
 * docs/brain/libraries/spec-drift.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { listArchivedSlugs, phaseEmoji, type Phase, type SpecStatus } from "@/lib/brain-roadmap";
import { rollupPhaseStatus } from "@/lib/spec-card-state";
import {
  getSpec,
  listSpecs,
  listSpecPhaseAnomalies,
  setSpecStatus,
  stampPhaseShipped,
  type SpecPhaseRow,
} from "@/lib/specs-table";
import { listGoals, type GoalRow } from "@/lib/goals-table";

const REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";
function ghToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}

async function gh(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
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

// ── Goal-aware guard (reese-goal-aware-drift Phase 1) ───────────────────────────────────────────
//
// A goal member spec's `claude/build-{slug}` branch merges onto `goal/{goal-slug}` (M4 — stamps
// `specs.goal_branch_sha`), NOT onto `main`. The goal's `claude/goal-{slug}` branch only lands on
// main atomically at M5 (stamps `goals.main_merge_sha`). Between M4 and M5 the phase's code is on
// the goal branch, not main — a shipped phase in that window looks "code missing from main" to a
// naive path check, and the reconciler would open a reverse-drift row against a phase that is
// accumulating normally.
//
// This guard says: if the spec is a goal member whose owning goal has not promoted to main yet
// (`goals.main_merge_sha === null`), do NOT classify the phase as reverse-drift. Once the goal
// promotes, the normal on-main check applies and a genuine post-merge revert still surfaces.
//
// Pure helper — takes the loaded goal list and the spec's milestone_id. Feeds both the reconciler's
// suspect-set filter and the pre-filter's short-circuit. Testable without DB or GitHub.

export interface GoalPendingVerdict {
  /** True iff the spec belongs to a goal whose atomic goal→main promotion has not landed. */
  pending: boolean;
  /** The owning goal's slug when `pending` is true (for the reasoning line the caller emits). */
  goalSlug: string | null;
  /** The owning goal's title when `pending` is true. */
  goalTitle: string | null;
}

/**
 * Is this spec a member of a goal whose `goals.main_merge_sha` is still null? Pure — a
 * standalone spec (no `milestone_id`) always returns `pending: false`. A milestone whose parent
 * goal isn't in `goals` (stale, deleted) returns `pending: false` — the guard fails safe (never
 * suppresses a real drift). Once the goal promotes (`main_merge_sha` set) the return flips to
 * `pending: false` and the normal on-main check applies.
 */
export function isGoalPendingPromotion(
  milestoneId: string | null | undefined,
  goals: readonly GoalRow[],
): GoalPendingVerdict {
  if (!milestoneId) return { pending: false, goalSlug: null, goalTitle: null };
  for (const g of goals) {
    for (const m of g.milestones) {
      if (m.id !== milestoneId) continue;
      if (g.main_merge_sha === null) {
        return { pending: true, goalSlug: g.slug, goalTitle: g.title };
      }
      return { pending: false, goalSlug: g.slug, goalTitle: g.title };
    }
  }
  return { pending: false, goalSlug: null, goalTitle: null };
}

// ── Phase shape (DB row → drift-reconciler view) ─────────────────────────────────────────────────

/** One phase as the reconciler sees it — the typed `spec_phases` row projected to the fields drift work uses. */
export interface DriftPhase {
  index: number; // 0-based — matches the board parser order + /api/roadmap/spec-drift phaseIndex
  position: number; // 1-based — the canonical `spec_phases.position` for the writeback stamp
  title: string;
  status: Phase;
  body: string; // the phase's text — what we scan for code paths
  // The commit that shipped this phase (from `stampPhaseShipped`). Carried through so the pre-filter
  // can answer "is the phase's code on main?" immediately-consistently via the git commits/compare API
  // (reverse-drift-verify-merge-sha-on-main-before-escalating-code-missing) — GitHub's search index is
  // eventually consistent and lags a fresh merge, false-flagging just-shipped phases as reverted.
  merge_sha: string | null;
}

function driftPhasesFromRows(rows: SpecPhaseRow[]): DriftPhase[] {
  return rows
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((p, i) => ({ index: i, position: p.position, title: p.title, status: p.status, body: p.body, merge_sha: p.merge_sha }));
}

// ── Code-on-main verification ────────────────────────────────────────────────────────────────────

// Path-like tokens the phase body names. We require a known top-level dir so prose doesn't false-match,
// plus bare migration filenames (referenced without the supabase/migrations/ prefix).
// Only the repo's real top-level dirs — a bare `lib/x.ts` (no such root here) would never exist on main
// and would wrongly drag a phase's allOnMain to false, suppressing a legit flip. Keep this tight.
const PATH_RE = /(?:src|supabase|scripts|remotion|shopify-extension|public|docs)\/[\w./@-]+\.[a-z]{1,5}/gi;
const MIGRATION_RE = /\b(\d{14}_[\w-]+\.sql)\b/g;

/** Distinct code paths a phase claims to have shipped (file paths + bare migration filenames). */
export function extractCodePaths(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(PATH_RE)) {
    const p = m[0];
    // Exclude disposable one-off scripts (`scripts/_*`): per the `_author-*` / `_analyze-*` / `_probe-*`
    // convention these are per-task THROWAWAY scaffolding (a scout's competitor-analysis run, an authoring
    // one-off) — never the durable capability a phase ships. A phase referencing one, usually in its
    // verification ("run scripts/_analyze-erth-lander.ts to check the deconstruction"), must NOT have it
    // counted as shipped code: it's uncommitted BY DESIGN, so it always looks "missing on main" and
    // false-flags a high-confidence revert (the funnel-teardown-scout + adlibrary-search-freshness-gate
    // alarms, 2026-07-02 — the REAL deliverables landing-page-scout.ts/landing-page-snapshot.ts were on
    // main the whole time). Durable deliverables (src/, migrations, brain, committed non-`_` scripts like
    // scripts/landing-page-snapshot.ts) are still checked.
    if (/^scripts\/_/.test(p)) continue;
    // Skip PLACEHOLDER/template paths — a phase body routinely quotes the migration NAMING CONVENTION
    // verbatim (`supabase/migrations/YYYYMMDDNNNNNN_description.sql`) or a `<slug>` / `{name}` template.
    // These are illustrative, never real files, so they always 404 on main and false-flag a revert (the
    // adlibrary-search-freshness-gate P1 alarm — its real migration `20260810120000_adlibrary_searches.sql`
    // WAS on main; the body just cited the YYYYMMDDNNNNNN template).
    if (/YYYYMMDD|NNNNNN|[<>{}]/.test(p)) continue;
    // Trim trailing punctuation the regex's char class might have swept up (none here) — keep as-is.
    out.add(p);
  }
  for (const m of body.matchAll(MIGRATION_RE)) {
    out.add(`supabase/migrations/${m[1]}`);
  }
  return [...out];
}

// Backtick-quoted identifiers a phase body names — function/const/module/table names that a rename or
// refactor tends to KEEP, so grepping for them on main distinguishes "moved/renamed" (still findable)
// from "genuinely reverted" (nothing found anywhere). Length ≥ 4 keeps English filler out.
const SYMBOL_RE = /`([A-Za-z_][A-Za-z0-9_]{3,})`/g;
// Very common words that appear in every codebase and would light up as false positives on grep.
const SYMBOL_STOP = new Set([
  "true", "false", "null", "undefined", "main", "spec", "phase", "role", "code", "path",
  "type", "kind", "status", "table", "row", "data", "text", "file", "job", "user", "self",
]);

/**
 * Symbols named in a phase body — backtick-quoted identifiers referencing the code the phase claims
 * to have shipped. Also includes each declared path's basename + stem (module name) so a moved-not-
 * renamed file still registers. Feeds the drift pre-filter's grep leg — a symbol hit anywhere on main
 * distinguishes a renamed/moved artifact from a genuine revert.
 */
export function extractSymbols(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(SYMBOL_RE)) out.add(m[1]);
  for (const p of extractCodePaths(body)) {
    const base = p.split("/").pop() ?? "";
    if (base.length >= 4) out.add(base); // full basename (e.g. `spec-drift.ts`)
    const stem = base.replace(/\.[a-z]{1,5}$/i, "");
    if (stem.length >= 4) out.add(stem); // stem — the module name that survives a directory move
  }
  return [...out].filter((s) => !SYMBOL_STOP.has(s.toLowerCase()));
}

/** Does a path exist on `main`? Cached per-run so repeated paths across phases hit GitHub once. */
async function pathExistsOnMain(path: string, cache: Map<string, boolean>): Promise<boolean> {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  let exists = false;
  try {
    const res = await gh("GET", `/repos/${REPO}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=main`);
    exists = res.ok;
  } catch {
    exists = false;
  }
  cache.set(path, exists);
  return exists;
}

// ── Immediately-consistent merge_sha-on-main check (reverse-drift-verify-merge-sha…) ────────────
//
// The reverse-drift reconciler was escalating just-merged phases as 'code-missing' because its
// symbol grep uses GitHub's `/search/code` API — an EVENTUALLY-consistent index that lags a merge
// by minutes to hours. During that window a genuinely-shipped phase reads as "code missing from
// main" and lands in the CEO inbox as a possible revert. The antidote is already in hand: each
// shipped phase stamps a `spec_phases.merge_sha` (the M5 commit that put it on main). The git
// commits/compare API answers "is that commit reachable from main?" IMMEDIATELY-consistently, so
// consulting it BEFORE the search-index leg closes the false-positive class.
//
// The check is split for testability: the pure `isMergeShaAncestorOfMain` classifies a compare-
// API status string; the async `mergeShaOnMain` wraps the fetch. Fail-open by construction — a
// GitHub read failure returns `null` so the caller falls through to the existing escalation
// (never suppress a real revert on an API hiccup).

/**
 * Pure classifier for the GitHub compare-API `status` field. `GET /repos/{owner}/{repo}/compare/
 * {merge_sha}...main` returns one of `ahead` | `behind` | `identical` | `diverged`:
 *
 *   - `ahead`     → main is AHEAD of merge_sha → merge_sha IS an ancestor of main (code shipped);
 *   - `identical` → main IS merge_sha (main hasn't moved past the merge) → also on main;
 *   - `behind`    → main is BEHIND merge_sha → merge_sha is a DESCENDANT of main (shouldn't
 *                    happen for a real merge but harmless — NOT on main);
 *   - `diverged`  → merge_sha is on a discarded branch → NOT on main.
 *
 * Pure — assertable from tests without touching GitHub or the DB.
 */
export function isMergeShaAncestorOfMain(compareStatus: string | null | undefined): boolean {
  return compareStatus === "ahead" || compareStatus === "identical";
}

/**
 * Immediately-consistent ancestry check: is `merge_sha` reachable from `main`? Uses the git
 * commits/compare API (NOT the eventually-consistent `/search/code` index) — so a phase that
 * merged seconds ago answers correctly, closing the search-lag false-positive class.
 *
 * Returns:
 *   - `true`  → compare answered and merge_sha is an ancestor of (or IS) main → code shipped;
 *   - `false` → compare answered and merge_sha is genuinely NOT on main → real revert;
 *   - `null`  → couldn't verify (missing token, non-200, malformed payload, exception). The
 *               caller falls through to the existing escalation — fail-open so a GitHub hiccup
 *               can't suppress a real revert.
 */
async function mergeShaOnMain(mergeSha: string): Promise<boolean | null> {
  if (!ghToken()) return null;
  try {
    // `compare/{base}...{head}` semantics: `status: 'ahead'` ⇔ head (main) is ahead of base
    // (merge_sha) ⇔ merge_sha is an ancestor of main. Encode the sha to be safe (real merge shas
    // are hex, but a caller-passed value goes into the URL path).
    const res = await gh("GET", `/repos/${REPO}/compare/${encodeURIComponent(mergeSha)}...main`);
    if (!res.ok) return null;
    const status = typeof res.json.status === "string" ? res.json.status : null;
    if (status === null) return null;
    return isMergeShaAncestorOfMain(status);
  } catch {
    return null;
  }
}

// ── Reconciler ─────────────────────────────────────────────────────────────────────────────────────

export interface SpecDriftRow {
  id: string;
  spec_slug: string;
  phase_index: number;
  phase_title: string;
  current_emoji: string;
  detail: string;
  status: "open" | "resolved";
  opened_at: string;
  last_seen_at: string;
}

/** Mark a spec_drift row resolved (e.g. after the director confirms the phase shipped + flips it ✅). */
export async function resolveDriftRow(admin: ReturnType<typeof createAdminClient>, id: string): Promise<void> {
  await admin.from("spec_drift").update({ status: "resolved", last_seen_at: new Date().toISOString() }).eq("id", id);
}

// ── Drift pre-filter (ada-standing-pass-reasoning-gate Phase 1) ────────────────────────────────────

/** Repo-wide grep on main via the GitHub code-search API — does `symbol` appear anywhere? Cached. */
async function symbolExistsOnMain(symbol: string, cache: Map<string, boolean>): Promise<boolean> {
  const hit = cache.get(symbol);
  if (hit !== undefined) return hit;
  const token = ghToken();
  if (!token) { cache.set(symbol, false); return false; }
  let exists = false;
  try {
    // Quote for an EXACT-phrase match — avoids tokenised false hits on short/common identifiers.
    const q = encodeURIComponent(`"${symbol}" repo:${REPO}`);
    const res = await fetch(`https://api.github.com/search/code?q=${q}&per_page=1`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    });
    if (res.ok) {
      const j = (await res.json()) as { total_count?: number };
      exists = (j.total_count ?? 0) > 0;
    }
  } catch { exists = false; }
  cache.set(symbol, exists);
  return exists;
}

export type DriftPreFilterVerdict =
  | { verdict: "code-present"; reasoning: string; symbolsFound: string[]; pathsMissing: string[] }
  | { verdict: "code-missing"; reasoning: string; symbolsFound: string[]; pathsMissing: string[] }
  | { verdict: "ambiguous"; reasoning: string; symbolsFound: string[]; pathsMissing: string[] };

/**
 * DETERMINISTIC pre-filter for the spec-drift supervision lane (ada-standing-pass-reasoning-gate P1).
 *
 * The reconciler surfaces a `spec_drift` row when a shipped phase's declared paths look missing on main.
 * Before spawning a Max session to re-decide it, resolve the two easy classes deterministically:
 *
 *   1. path check — all declared paths ARE on main? → `code-present` (stale surface, auto-resolve).
 *   2. symbol grep — every backtick identifier / basename / stem still findable somewhere on main?
 *      → `code-present` (moved/renamed — the false-positive class the Max prompt itself names).
 *   3. path 404 + ZERO symbols found anywhere → `code-missing` (high-confidence revert, escalate no-session).
 *
 * Anything else (paths 404 + partial symbol survival, or no symbols to grep) returns `ambiguous` — the
 * caller falls through to the Max session for the residual judgment. Returns `null` when we lack the
 * inputs to decide (no token / no spec row / no phase / no declared paths).
 *
 * Best-effort — a read/grep failure falls through to `ambiguous` (the safer default: still verified
 * by the session).
 */
export async function driftPreFilterPhase(
  workspaceId: string,
  slug: string,
  phaseIndex: number,
): Promise<DriftPreFilterVerdict | null> {
  if (!ghToken()) return null;
  const spec = await getSpec(workspaceId, slug);
  if (!spec) return null;
  const phase = driftPhasesFromRows(spec.phases).find((p) => p.index === phaseIndex);
  if (!phase) return null;

  // Goal-aware guard (reese-goal-aware-drift Phase 1): a shipped phase whose spec is a member of a
  // goal that has not yet promoted to main lives on the goal branch, not main. Report it as
  // `code-present` with a goal-pending reasoning so the caller auto-resolves any stale drift row
  // without a Max session and without escalation. Fail-open — a listGoals read failure falls
  // through to the normal path check (never suppress a real drift on a hiccup).
  if (spec.milestone_id) {
    try {
      const goals = await listGoals(workspaceId);
      const gp = isGoalPendingPromotion(spec.milestone_id, goals);
      if (gp.pending) {
        return {
          verdict: "code-present",
          reasoning: `goal-pending: spec is a member of goal ${gp.goalSlug ?? ""} whose atomic goal→main promotion has not landed (main_merge_sha is null) — the phase's code lives on the goal branch, not main; not reverse-drift`,
          symbolsFound: [],
          pathsMissing: [],
        };
      }
    } catch { /* fall through to normal path/symbol checks */ }
  }

  const paths = extractCodePaths(phase.body);
  if (!paths.length) return null; // nothing to verify → let the session decide (rare — reverse-drift phases usually name paths)
  const symbols = extractSymbols(phase.body);

  const pathCache = new Map<string, boolean>();
  const pathChecks = await Promise.all(paths.map((p) => pathExistsOnMain(p, pathCache)));
  const pathsMissing = paths.filter((_, i) => !pathChecks[i]);

  // (1) All declared paths on main → the reverse-drift is stale; auto-resolve without a session.
  if (pathsMissing.length === 0) {
    return {
      verdict: "code-present",
      reasoning: `all ${paths.length} declared path(s) exist on main — reverse-drift is stale`,
      symbolsFound: [],
      pathsMissing: [],
    };
  }

  // Only grep symbols when the path check DIDN'T settle it — saves GitHub search quota for the ambiguous case.
  const symCache = new Map<string, boolean>();
  const symChecks = symbols.length ? await Promise.all(symbols.map((s) => symbolExistsOnMain(s, symCache))) : [];
  const symbolsFound = symbols.filter((_, i) => symChecks[i]);

  const fmtPaths = (xs: string[]) => `${xs.slice(0, 3).join(", ")}${xs.length > 3 ? " …" : ""}`;
  const fmtSyms = (xs: string[]) => `${xs.slice(0, 5).join(", ")}${xs.length > 5 ? " …" : ""}`;

  // (2) Any declared symbol still surfaces on main → the file was moved/renamed (the very false-positive
  //     class the Max prompt itself names). Auto-resolve without a session.
  if (symbolsFound.length > 0) {
    return {
      verdict: "code-present",
      reasoning: `moved/renamed: symbol(s) still found on main (${fmtSyms(symbolsFound)}); paths gone (${fmtPaths(pathsMissing)})`,
      symbolsFound,
      pathsMissing,
    };
  }

  // (3) Paths 404 AND we DID have symbols to grep, but none survived → high-confidence code-missing.
  //     Escalate without a session. If we had NO symbols to grep at all, fall through to `ambiguous`
  //     (a body that names paths but no identifiers can't rule out a rename — let the session judge).
  if (symbols.length > 0) {
    // MERGE-SHA ANCESTRY SHORT-CIRCUIT (reverse-drift-verify-merge-sha-on-main-before-escalating-
    // code-missing): before we escalate a "code-missing" verdict on the back of the eventually-
    // consistent search index, ask the IMMEDIATELY-consistent commits/compare API whether the
    // phase's stamped merge_sha is actually on main. A recent merge whose search index hasn't
    // caught up would otherwise be flagged as a revert — the lf8-live-ad-gate CEO false-positive
    // shape. If the compare API confirms the commit is on main, the code shipped: return
    // `code-present` so the drift row auto-resolves. If the compare API confirms it is NOT on
    // main, this is a real revert → fall through to the existing escalation. If we can't verify
    // (no token / API failure / no merge_sha stamped) also fall through — fail-open, never
    // suppress a real revert on a hiccup.
    if (phase.merge_sha) {
      const onMain = await mergeShaOnMain(phase.merge_sha);
      if (onMain === true) {
        return {
          verdict: "code-present",
          reasoning: `merge_sha ${phase.merge_sha.slice(0, 7)} is on main (verified via commits/compare API — immediately consistent, unlike the search index) — the phase's code shipped; search-index-lag false positive on the symbol grep`,
          symbolsFound: [],
          pathsMissing,
        };
      }
      // onMain === false → merge_sha genuinely not on main → real revert → fall through.
      // onMain === null → GitHub read failed or no token → fall through (never suppress on a hiccup).
    }
    return {
      verdict: "code-missing",
      reasoning: `paths not on main (${fmtPaths(pathsMissing)}) AND ${symbols.length} declared symbol(s) not found anywhere on main — high-confidence revert`,
      symbolsFound: [],
      pathsMissing,
    };
  }

  // (4) Ambiguous — paths gone but no symbols to grep. Kick to the session (rare).
  return {
    verdict: "ambiguous",
    reasoning: `paths gone (${pathsMissing.length}) but no backtick-declared symbols to grep — needs judgment`,
    symbolsFound: [],
    pathsMissing,
  };
}

export interface ReconcileResult {
  slug: string;
  flipped: { index: number; title: string }[]; // phases auto-stamped shipped this run
  surfaced: { index: number; title: string }[]; // phases left for a one-tap owner flip (open drift rows)
  status: SpecStatus; // derived spec status after any stamps
  reason?: string; // why nothing happened (no token / no spec row / no phases)
}

interface ReconcileOpts {
  /** Pre-fetched map of spec slug → merged build PR # for the cron sweep (a single `agent_jobs` query). */
  mergedBuildBySlug?: Map<string, { pr: number | null }>;
}

/** Look up the most recent merged `kind='build'` job for this spec — returns its PR # (or null). */
async function findMergedBuild(workspaceId: string, slug: string): Promise<{ pr: number | null } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("agent_jobs")
    .select("pr_number")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("kind", "build")
    .eq("status", "merged")
    .order("created_at", { ascending: false })
    .limit(1);
  if (!data || !data.length) return null;
  const pr = (data[0] as { pr_number: number | null }).pr_number;
  return { pr: typeof pr === "number" ? pr : null };
}

/**
 * Reconcile ONE spec's phase status against code-on-main + merged-build evidence (the engine both
 * triggers share). Reads the spec from the DB ([[specs-table]] `getSpec`), auto-stamps confident phases
 * via `stampPhaseShipped`, upserts/clears `spec_drift` rows for the ambiguous ones, and returns what
 * it did. Never throws — best-effort, returns a reason on skip.
 */
export async function reconcileSpecDrift(workspaceId: string, slug: string, opts: ReconcileOpts = {}): Promise<ReconcileResult> {
  const empty = (reason: string): ReconcileResult => ({ slug, flipped: [], surfaced: [], status: "planned", reason });
  if (!/^[a-z0-9-]+$/i.test(slug)) return empty("invalid slug");
  if (!ghToken()) return empty("no GitHub token");

  // DB-only spec read (retire-md-reads-from-pm-flow Phase 2). `spec_phases[i].body` is the code-path
  // source; `spec_phases[i].status` is the seed. No `docs/brain/specs/*.md` HTTP fetch / markdown parse.
  const spec = await getSpec(workspaceId, slug);
  if (!spec) return empty("spec not in DB");
  if (spec.status === "folded") return empty("spec folded — nothing to reconcile");
  const phases = driftPhasesFromRows(spec.phases);
  // A one-shot spec (no phases) has nothing to reconcile per-phase. The status it already carries IS
  // the truth (the merge hook wrote it). Coerce to the brain-roadmap SpecStatus shape — `folded` was
  // filtered above, so the remaining values overlap exactly.
  if (!phases.length) return { slug, flipped: [], surfaced: [], status: spec.status as SpecStatus, reason: "no phases" };

  const mergedBuild =
    opts.mergedBuildBySlug !== undefined ? (opts.mergedBuildBySlug.get(slug) ?? null) : await findMergedBuild(workspaceId, slug);

  const cache = new Map<string, boolean>();
  const flipped: { index: number; title: string; position: number }[] = [];
  const surfaced: { index: number; phase: DriftPhase }[] = [];

  // Decide per stale phase (anything not already shipped and not an explicit `rejected` cut).
  for (const phase of phases) {
    if (phase.status === "shipped" || phase.status === "rejected") continue;
    const paths = extractCodePaths(phase.body);
    if (paths.length === 0) continue; // nothing to verify → can't be confident → leave (genuinely unbuilt)
    const checks = await Promise.all(paths.map((p) => pathExistsOnMain(p, cache)));
    const allOnMain = checks.every(Boolean);
    if (!allOnMain) continue; // code not (fully) on main → genuinely unbuilt / fan-out / mid-build → leave

    if (mergedBuild) {
      flipped.push({ index: phase.index, title: phase.title, position: phase.position }); // confident: stamp shipped
    } else {
      surfaced.push({ index: phase.index, phase }); // code on main but no merged build on record → surface
    }
  }

  // Stamp each confident phase shipped on the canonical `spec_phases` row. Best-effort per phase so a
  // single failure doesn't block the rest — the next sweep re-attempts the remainder. Provenance: the
  // merged build's PR # + the resolved merge SHA when we can fetch it. Falling back to nulls is safe
  // because a phase whose status isn't shipped also has no prior pr/merge_sha to clobber.
  const mergeSha = mergedBuild?.pr ? await resolvePrMergeSha(mergedBuild.pr) : null;
  for (const f of flipped) {
    try {
      await stampPhaseShipped(workspaceId, slug, f.position, { pr: mergedBuild?.pr ?? null, merge_sha: mergeSha });
    } catch {
      /* leaf write failed — leave it for the next sweep */
    }
  }

  await syncDriftRows(workspaceId, slug, surfaced);

  // Roll the post-stamp phase set up to a derived status — the same shape the board renderer reads.
  const postStampPhases = phases.map((p) =>
    flipped.some((f) => f.position === p.position) ? { ...p, status: "shipped" as Phase } : p,
  );
  const status: SpecStatus = rollupPhaseStatus(
    postStampPhases.map((p) => ({ index: p.index, title: p.title, status: p.status })),
  );

  return { slug, flipped: flipped.map((f) => ({ index: f.index, title: f.title })), surfaced: surfaced.map((s) => ({ index: s.phase.index, title: s.phase.title })), status };
}

/** Upsert open `spec_drift` rows for the surfaced phases; resolve any open row no longer surfaced. */
async function syncDriftRows(workspaceId: string, slug: string, surfaced: { index: number; phase: DriftPhase }[]): Promise<void> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const keep = new Set(surfaced.map((s) => s.phase.index));

  for (const s of surfaced) {
    const detail = `${slug} — P${s.phase.index + 1} (${s.phase.title}) code is on main but still ${phaseEmoji(s.phase.status)} — no merged build on record, owner confirm.`;
    // Upsert one open row per (workspace, slug, phase): bump if it exists, insert if not.
    const { data: existing } = await admin
      .from("spec_drift")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", slug)
      .eq("phase_index", s.phase.index)
      .eq("status", "open")
      .limit(1);
    if (existing && existing.length) {
      await admin
        .from("spec_drift")
        .update({ last_seen_at: nowIso, phase_title: s.phase.title, current_emoji: phaseEmoji(s.phase.status), detail })
        .eq("id", (existing[0] as { id: string }).id);
    } else {
      await admin
        .from("spec_drift")
        .insert({
          workspace_id: workspaceId,
          spec_slug: slug,
          phase_index: s.phase.index,
          phase_title: s.phase.title,
          current_emoji: phaseEmoji(s.phase.status),
          detail,
          status: "open",
        })
        .then(undefined, () => {}); // partial-unique race backstop — ignore a 23505
    }
  }

  // Resolve open rows for this spec that are no longer drifting (flipped / now on main with a build).
  const { data: open } = await admin
    .from("spec_drift")
    .select("id, phase_index")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("status", "open");
  for (const row of (open ?? []) as { id: string; phase_index: number }[]) {
    if (keep.has(row.phase_index)) continue;
    await admin.from("spec_drift").update({ status: "resolved", resolved_at: nowIso }).eq("id", row.id);
  }
}

export interface DriftSweepResult {
  specsScanned: number;
  flipped: number;
  surfaced: number;
}

// ── Self-heal "built-unstamped" phases (repurpose-spec-drift-reconciler P1) ─────────────────────────

/**
 * The strong, single signal that a spec is "built but unstamped": the box's build/fold job no-op'd as
 * "already-shipped" — it found the WHOLE spec's work already merged on `main` (via a sibling build) and
 * terminated WITHOUT opening a PR or touching files. The error/log_tail carries `already merged via #N`
 * (the build claim-dedup at builder-worker.ts `findMergedSiblingBuild`, and the dirty-PR duplicate close).
 * That outcome IS Bo's implicit report: the spec is on main, the phase just never got stamped (a backfill
 * seeded it `planned`). We only trust THIS message — never the looser "no changes" outcome (which matched a
 * genuinely-empty-phase spec, agents-hub-role-inboxes), so an incomplete spec is never over-stamped.
 */
// Matches the whole-spec "this spec's work already shipped via PR #N" signal in EITHER of Bo's wordings:
//   "already merged via #826"  — the original auto-merge / dedup phrasing, and
//   "already built — PR #891 (commit 6cafd65d) implemented both phases of this spec"  — Bo's pre-flight
//      no-delta finding when the code merged via a SIBLING/duplicate PR (the live appstle-attempt-billing-
//      coerce-string-id wedge: a healthy-box build found both phases already on main via #891, made zero
//      edits, and the no-change reconcile marked the job completed without ever stamping the phases).
// Captures the PR number so the heal can resolve that PR's merge SHA and stamp the spec's phases shipped.
const ALREADY_MERGED_VIA_RE = /already (?:merged via|built|shipped|on main)[^\n]*?(?:PR\s*)?#(\d+)/i;

/**
 * The SECOND built-unstamped signal — the RE-QUEUE case. When an owner re-queues an ALREADY-BUILT phase,
 * Bo's pre-flight state-check finds every artifact for that phase already on `main`, makes zero edits, and
 * the build terminates `status='needs_attention'` with a PHASE-SPECIFIC report like:
 *
 *   "All Phase-5 artifacts already exist on main: src/app/dashboard/agents/…"
 *
 * (Bo's emitted `no_changes_reason`/`summary`, surfaced into the job's `error`/`log_tail` at the no-PR/
 * no-change path in builder-worker.ts — line ~10672. This is what happened to agents-hub-role-inboxes.)
 *
 * Unlike the `already merged via #N` signal (whole spec, carries a PR), this one is per-PHASE and carries
 * NO PR — the heal IS the point. We match ONLY this explicit phase-specific wording (never a looser "no
 * changes") and capture the phase NUMBER N, then stamp ONLY position N. Conservative + idempotent: a re-run
 * finds the phase already shipped (so it never re-stamps), and a malformed/looser report never matches.
 */
const PHASE_ARTIFACTS_EXIST_RE = /All Phase[\s-]?(\d+)[\s-]?artifacts already exist on main/i;

/**
 * The THIRD, GENERAL built-unstamped signal — heal-any-box-parked-already-built. Bo parks a re-built
 * phase `needs_attention` with VARYING wordings beyond the two specific ones above: "Phase 2 already on
 * main — …", "already-shipped: {slug} already merged via #X", "All Phase-5 artifacts already exist on
 * main: …", "no changes" / "no file changes", etc. This broad matcher catches the whole family so a
 * parked-already-built job no longer slips through to pile up as needs_attention (→ Ada re-escalates →
 * operator hand-stamps). It is INTENTIONALLY loose on the SIGNAL but STRICT on the ACTION: a match only
 * triggers a stamp of the ONE phase the build was dispatched for (parsed from the job's `instructions`,
 * never a blanket all-non-shipped stamp — a real incident came from over-stamping a multi-phase spec, so
 * per-phase precision is the hard guardrail here).
 */
const ALREADY_BUILT_BROAD_RE = /already (on main|merged|built|shipped)|artifacts already exist|no (file )?changes/i;

/**
 * Parse the DISPATCHED phase number from a build job's text. PRIMARY source is the job's `instructions`
 * (the build was dispatched FOR that phase — `phaseScopedInstructions` embeds `"Phase N — <title>"`);
 * FALLBACK is the parked log message. We take the FIRST `Phase <N>` either yields (regex ported from
 * builder-worker.ts `derivePhase`). Returns null when neither names a phase — the caller then SKIPS the
 * job (never guesses / never defaults to position 1), the per-phase-precision guard.
 */
function dispatchedPhaseNumber(instructions: string | null | undefined, log: string | null | undefined): number | null {
  const PHASE_RE = /\bPhase\s+(\d+)\b/i;
  const fromInstr = instructions ? PHASE_RE.exec(instructions) : null;
  if (fromInstr) return Number(fromInstr[1]);
  const fromLog = log ? PHASE_RE.exec(log) : null;
  if (fromLog) return Number(fromLog[1]);
  return null;
}

/** Cheap PR → merge-commit SHA resolution via the existing GitHub REST helper. Null on any miss. */
async function resolvePrMergeSha(pr: number): Promise<string | null> {
  try {
    const res = await gh("GET", `/repos/${REPO}/pulls/${pr}`);
    if (!res.ok) return null;
    const sha = res.json.merge_commit_sha;
    return typeof sha === "string" && sha ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Self-heal "built-unstamped" phases — the supervising-agent half of the box's "already-shipped" no-op.
 *
 * THE LOOP THIS CLOSES: after the db-driven-specs cutover, spec status is DERIVED from `spec_phases`. The
 * backfill seeded some phases `planned` even though their work had already merged. When the box later builds
 * such a phase, `runJob` finds the work already on `main`, terminates "already merged via #N" with NO file
 * changes — and the phase STAYS `planned`. The board keeps showing it un-built and re-invites a phantom
 * rebuild (the box starts, finds nothing, stops). Forever.
 *
 * THE FIX (conservative — only the strong signal): a spec qualifies iff (a) it has ≥1 `spec_phases` row whose
 * status is NOT 'shipped'/'rejected', AND (b) it has a recent `agent_jobs` row (kind build|fold, status
 * merged|completed) whose `error`/`log_tail` matches `already merged via #N` — the box CONFIRMING the whole
 * spec is already on main. For each match we stamp EVERY non-shipped, non-rejected phase `shipped` via
 * `stampPhaseShipped` (the canonical leaf write that advances the DERIVED status — the rollup trigger is
 * gone), tagging `pr` (the key provenance) + a best-effort `merge_sha`, and log ONE supervisor-visible
 * `director_activity` row per healed spec. Idempotent: a second run finds no qualifying phases.
 *
 * SINGLE-WORKSPACE by contract — the caller passes the canonical PM workspace; this never iterates workspaces.
 */
export async function healBuiltUnstampedPhases(workspaceId: string): Promise<{ slug: string; phases: number[]; pr: number }[]> {
  const admin = createAdminClient();

  // (a) Candidate specs: any with ≥1 phase NOT IN ('shipped','rejected'). Read the specs (phases joined)
  //     through the specs-table SDK (no raw PM SQL — pm-db-agent-toolkit) and filter in memory.
  const specs = await listSpecs(workspaceId);
  const unstampedBySlug = new Map<string, number[]>();
  for (const spec of specs) {
    if (spec.status === "folded") continue; // folded specs are archived — don't re-heal their phases
    const positions = spec.phases
      .filter((p) => p.status !== "shipped" && p.status !== "rejected")
      .map((p) => p.position);
    if (positions.length) unstampedBySlug.set(spec.slug, positions);
  }
  if (!unstampedBySlug.size) return [];

  // (b) For each candidate, find a recent build/fold job the box no-op'd as "already merged via #N".
  const healed: { slug: string; phases: number[]; pr: number }[] = [];
  for (const [slug, positions] of unstampedBySlug) {
    const { data: jobs } = await admin
      .from("agent_jobs")
      .select("error, log_tail, status")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", slug)
      .in("kind", ["build", "fold"])
      .in("status", ["merged", "completed"])
      .order("created_at", { ascending: false })
      .limit(5);
    let pr: number | null = null;
    for (const j of (jobs ?? []) as { error: string | null; log_tail: string | null }[]) {
      const m = `${j.error ?? ""}\n${j.log_tail ?? ""}`.match(ALREADY_MERGED_VIA_RE);
      if (m) {
        pr = Number(m[1]);
        break;
      }
    }
    if (pr === null) continue; // no strong "already-shipped" signal → leave (could be genuinely incomplete)

    // Stamp every non-shipped, non-rejected phase shipped — the leaf write that advances the derived status.
    const mergeSha = await resolvePrMergeSha(pr);
    const stamped: number[] = [];
    for (const position of positions.sort((a, b) => a - b)) {
      try {
        await stampPhaseShipped(workspaceId, slug, position, { pr, merge_sha: mergeSha });
        stamped.push(position);
      } catch {
        /* a single phase write failing must not block the rest; the next sweep re-attempts the remainder */
      }
    }
    if (!stamped.length) continue;
    healed.push({ slug, phases: stamped, pr });

    // Supervisor-visible report: one director_activity row naming the spec + phases healed + the PR.
    try {
      const { recordDirectorActivity } = await import("@/lib/director-activity");
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: "platform",
        actionKind: "healed_built_unstamped",
        specSlug: slug,
        reason: `reconciler:spec-drift stamped ${stamped.length} built-but-unstamped phase(s) (P${stamped.join(", P")}) of ${slug} shipped — the box confirmed the whole spec already merged via #${pr} (no file changes), so the backfilled-planned phase(s) were never advanced. Self-healed the derived status.`,
        metadata: { actor: "reconciler:spec-drift", pr, merge_sha: mergeSha, phases: stamped },
      });
    } catch {
      /* audit is best-effort — the stamp already landed */
    }
  }

  // (c) SECOND signal — the RE-QUEUE case. For each candidate, look for a recent build job the box parked
  // `needs_attention` because Bo found a SPECIFIC phase's artifacts already on main ("All Phase-N artifacts
  // already exist on main: …"). Per-phase, carries no PR — stamp ONLY position N, then clear the stuck card.
  for (const [slug, positions] of unstampedBySlug) {
    const unstamped = new Set(positions);
    const { data: naJobs } = await admin
      .from("agent_jobs")
      .select("id, error, log_tail")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", slug)
      .eq("kind", "build")
      .eq("status", "needs_attention")
      .order("created_at", { ascending: false })
      .limit(5);
    for (const j of (naJobs ?? []) as { id: string; error: string | null; log_tail: string | null }[]) {
      const m = `${j.error ?? ""}\n${j.log_tail ?? ""}`.match(PHASE_ARTIFACTS_EXIST_RE);
      if (!m) continue;
      const n = Number(m[1]);
      // Only stamp if N is a real, still-unstamped phase for this spec (idempotent: a re-run finds it shipped
      // and unstamped no longer holds N → we skip + still clear the card). This signal carries no PR.
      if (!unstamped.has(n)) {
        // Phase already shipped (idempotent re-run) — but the needs_attention card may still be stuck. Clear it.
        await admin.from("agent_jobs").update({ status: "completed" }).eq("id", j.id).then(undefined, () => {});
        continue;
      }
      let ok = false;
      try {
        await stampPhaseShipped(workspaceId, slug, n, { pr: null, merge_sha: null });
        ok = true;
      } catch {
        /* stamp failed — leave the card; the next sweep re-attempts */
      }
      if (!ok) continue;
      unstamped.delete(n);

      // Clear the stuck needs_attention card now that its phase is reconciled.
      await admin.from("agent_jobs").update({ status: "completed" }).eq("id", j.id).then(undefined, () => {});

      const existing = healed.find((h) => h.slug === slug);
      if (existing) existing.phases.push(n);
      else healed.push({ slug, phases: [n], pr: -1 });

      // Supervisor-visible report — same shape as the already-merged branch, naming the re-queue signal.
      try {
        const { recordDirectorActivity } = await import("@/lib/director-activity");
        await recordDirectorActivity(admin, {
          workspaceId,
          directorFunction: "platform",
          actionKind: "healed_built_unstamped",
          specSlug: slug,
          reason: `reconciler:spec-drift stamped built-but-unstamped phase P${n} of ${slug} shipped — a re-queued build hit Bo's "All Phase-${n} artifacts already exist on main" no-op (status=needs_attention, no PR, no file changes), so the backfilled-planned phase was never advanced. Self-healed the derived status and cleared the stuck card.`,
          metadata: { actor: "reconciler:spec-drift", signal: "phase-artifacts-already-exist", pr: null, merge_sha: null, phase: n, job_id: j.id },
        });
      } catch {
        /* audit is best-effort — the stamp already landed */
      }
    }
  }

  // (d) THIRD signal — the GENERAL parked-already-built case. The two branches above match only two
  // specific wordings; Bo parks an already-built rebuild `needs_attention` with many OTHER wordings
  // ("Phase 2 already on main — …", "already merged via #X", "no changes", …). Catch the whole family
  // with ALREADY_BUILT_BROAD_RE so none slip through to pile up as needs_attention. PER-PHASE PRECISION
  // is the hard rule: stamp ONLY the phase the build was DISPATCHED for (parsed from the job's
  // `instructions`, log as fallback) — NEVER a blanket all-non-shipped stamp (a real over-stamp incident
  // came from that). If no phase can be parsed, SKIP the job. Idempotent: a re-run finds N already
  // shipped → skip the stamp but still clear the lingering parked card.
  for (const [slug, positions] of unstampedBySlug) {
    const unstamped = new Set(positions);
    const { data: naJobs } = await admin
      .from("agent_jobs")
      .select("id, error, log_tail, instructions")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", slug)
      .eq("kind", "build")
      .eq("status", "needs_attention")
      .order("created_at", { ascending: false })
      .limit(5);
    for (const j of (naJobs ?? []) as { id: string; error: string | null; log_tail: string | null; instructions: string | null }[]) {
      const log = `${j.error ?? ""}\n${j.log_tail ?? ""}`;
      if (!ALREADY_BUILT_BROAD_RE.test(log)) continue; // not an "already built" park → leave it for Ada

      // Per-phase precision: the dispatched phase is reliably named in `instructions` ("Phase N — …");
      // the log is a fallback. No number from either → SKIP (never guess / never default to position 1).
      const n = dispatchedPhaseNumber(j.instructions, log);
      if (n === null) continue;

      // Idempotent: a re-run (or a phase already shipped by an earlier branch this pass) finds N no longer
      // in `unstamped` → skip the stamp but STILL clear the lingering parked card.
      if (!unstamped.has(n)) {
        await admin.from("agent_jobs").update({ status: "completed" }).eq("id", j.id).then(undefined, () => {});
        continue;
      }

      let ok = false;
      try {
        await stampPhaseShipped(workspaceId, slug, n, { pr: null, merge_sha: null });
        ok = true;
      } catch {
        /* stamp failed — leave the card; the next sweep re-attempts */
      }
      if (!ok) continue;
      unstamped.delete(n);

      // Clear the stuck needs_attention card (clears Ada's escalation) now that its phase is reconciled.
      await admin.from("agent_jobs").update({ status: "completed" }).eq("id", j.id).then(undefined, () => {});

      const existing = healed.find((h) => h.slug === slug);
      if (existing) existing.phases.push(n);
      else healed.push({ slug, phases: [n], pr: -1 });

      // Supervisor-visible report — same shape as the existing branches, naming the parked-build signal.
      try {
        const { recordDirectorActivity } = await import("@/lib/director-activity");
        await recordDirectorActivity(admin, {
          workspaceId,
          directorFunction: "platform",
          actionKind: "healed_built_unstamped",
          specSlug: slug,
          reason: `reconciler:spec-drift stamped built-but-unstamped phase P${n} of ${slug} shipped — a re-queued build parked needs_attention because the box found the phase already built on main (matched the general "already built" signal, no PR, no file changes). Parsed the dispatched phase from the job instructions, stamped ONLY P${n}, self-healed the derived status, and cleared the stuck card.`,
          metadata: { actor: "reconciler:spec-drift", signal: "already-built-broad", pr: null, merge_sha: null, phase: n, job_id: j.id },
        });
      } catch {
        /* audit is best-effort — the stamp already landed */
      }
    }
  }

  return healed;
}

// ── Self-heal manual squash/merge of claude/build-* PRs (stamp-phases-on-github-pr-merged) ──────────

/** Minimal PR shape from GitHub's list-pulls endpoint used to decide "is this branch shipped?". */
export interface BranchPrCandidate {
  number: number;
  merged_at: string | null;
  merge_commit_sha: string | null;
}

/**
 * Pure fail-closed PR picker (stamp-phases-on-github-pr-merged Phase 2). Given the list of PRs
 * GitHub returns for a `claude/build-*` branch head, return the MERGED PR's provenance — or `null`.
 *
 * Fail-closed by construction — a stamp is irreversible provenance:
 *   - an OPEN PR (`merged_at == null`) NEVER qualifies;
 *   - a CLOSED-unmerged PR (also `merged_at == null` — the #949-closed shape) NEVER qualifies;
 *   - MERGED is the ONLY qualifying state (`merged_at != null` — GitHub's ship-of-truth signal);
 *   - when a branch carries BOTH a MERGED and a CLOSED-unmerged PR (the #961-merged / #949-closed
 *     shape from fix-spec-brain-refs), the MERGED one wins REGARDLESS of iteration order.
 *
 * Passing `null`/`undefined` (the "read failed" shape the caller uses for a GitHub error) returns
 * `null` — no stamp, no throw. Purity: no I/O, no logging; the whole verification (Phase 2) is
 * assertable from tests that hand-craft PR lists (see spec-drift.test.ts).
 */
export function pickMergedPrFromList(
  prs: BranchPrCandidate[] | null | undefined,
): { number: number; merge_sha: string | null } | null {
  if (!prs || !Array.isArray(prs)) return null;
  for (const pr of prs) {
    if (pr && pr.merged_at) {
      return { number: pr.number, merge_sha: pr.merge_commit_sha ?? null };
    }
  }
  return null;
}

// ── Built-in-merge phase filter (reconciler-spec-drift-stamps-only-built-phases-in-merged-pr P1) ────

/** One phase's built-state inputs as the merge-heal filter sees it — enough to decide "in this PR?". */
export interface PhaseBuiltCandidate {
  /** 1-based `spec_phases.position` — the writeback key. */
  position: number;
  /** The `stampPhaseBuilt` provenance — non-null iff the phase built on the branch. */
  build_sha: string | null;
  /** The phase body — code-path extraction source for the file-diff fallback. */
  body: string;
}

/** Which phases the merged PR actually built + why we're stamping each. */
export interface PhasesBuiltInMerge {
  stamped: { position: number; reason: "build_sha" | "file-diff" }[];
  skipped: number[]; // positions with build_sha=null AND no declared file in the merge diff
}

/**
 * Pure filter (reconciler-spec-drift-stamps-only-built-phases-in-merged-pr P1). Given a spec's
 * unshipped phases + the merged commit's changed-file set, return ONLY the phases actually built in
 * that merge. A phase qualifies iff:
 *
 *   (1) `build_sha` is non-null — the worker's `stampPhaseBuilt` recorded a real branch build; OR
 *   (2) at least one declared file path in `body` (via `extractCodePaths`) appears in the merge
 *       diff — the fallback for a phase whose code was manually smuggled into the squash without
 *       ever going through the box's build flow.
 *
 * Unbuilt phases (build_sha=null AND no declared file in the merge diff) are RETURNED SEPARATELY
 * in `skipped` so the caller can leave their `spec_phases.status` untouched — the drift-healer's
 * whole point per this spec is that a partial-phase manual squash-merge must not stamp Phases 2/3
 * shipped when only Phase 1 was actually in the PR (generalize-director-coach-backend PR #1712 is
 * the live incident: coach/route.ts +26 only, but the old healer stamped all 3 phases → their
 * auto-queued build sessions died as "already shipped" → the spec-test correctly failed them →
 * a permanent shipped-but-red fold-deadlock).
 *
 * `mergedFiles === null` means we couldn't fetch the merge diff (a GitHub read failure). In that
 * case we fall back to `build_sha`-only — a phase with a recorded branch build still qualifies,
 * but no path-intersection heal is attempted this pass (a later pass retries when GitHub answers).
 *
 * Pure — no I/O, no logging; the whole verification is assertable from tests that hand-craft
 * phases + a mergedFiles set (see spec-drift.test.ts).
 */
export function pickPhasesBuiltInMerge(
  phases: readonly PhaseBuiltCandidate[],
  mergedFiles: ReadonlySet<string> | null,
): PhasesBuiltInMerge {
  const stamped: { position: number; reason: "build_sha" | "file-diff" }[] = [];
  const skipped: number[] = [];
  for (const p of phases) {
    if (p.build_sha) {
      stamped.push({ position: p.position, reason: "build_sha" });
      continue;
    }
    if (mergedFiles) {
      const paths = extractCodePaths(p.body);
      if (paths.some((path) => mergedFiles.has(path))) {
        stamped.push({ position: p.position, reason: "file-diff" });
        continue;
      }
    }
    skipped.push(p.position);
  }
  return { stamped, skipped };
}

/**
 * The FOURTH built-unstamped signal — MANUAL GitHub squash/merge of a `claude/build-*` PR.
 *
 * The Branches page invites owners to squash & merge a `claude/build-*` PR themselves. When they do
 * (spec-brain-refs PR #961 was manually squash-merged 2026-07-02, the live root cause), the box's
 * OWN merge flow never fires — no `already merged via #N` job log lands, so every job-log signal in
 * `healBuiltUnstampedPhases` misses. The squash also DISCARDS the branch's `build_sha`, so SHA-
 * ancestry checks miss it too. Result: phases stay `in_progress`, the spec stalls at `in_testing`
 * forever, and the fold is never enqueued.
 *
 * THE STRONG, SHA-AGNOSTIC SIGNAL: for each spec with ≥1 unshipped phase (not folded), ask GitHub
 * whether its `claude/build-{slug}` branch has a MERGED PR. GitHub's MERGED state is the definitive,
 * squash-safe ship signal, and the PR's `merge_commit_sha` is the ship provenance. If MERGED, stamp
 * every non-shipped, non-rejected phase `shipped` via `stampPhaseShipped({ pr, merge_sha })`.
 *
 * FAIL-CLOSED BY CONSTRUCTION (stamps are irreversible provenance, never guess): NO stamp when the
 * branch has no PR / an OPEN PR / a CLOSED-without-merge PR / on ANY GitHub read failure (missing
 * token, rate limit, API blip, 404). We skip the spec that pass and let a later pass retry. When a
 * branch carries BOTH a MERGED and a CLOSED-unmerged PR (the #961-merged / #949-closed shape from
 * fix-spec-brain-refs), resolve to the MERGED one — irrespective of API return order — never the
 * closed one. One `director_activity` row per healed spec (mirrors the existing signals above).
 *
 * SINGLE-WORKSPACE by contract (mirrors `healBuiltUnstampedPhases`) — it MUTATES phase status.
 */
export async function reconcileMergedBuildBranchPrs(
  workspaceId: string,
): Promise<{ slug: string; phases: number[]; pr: number }[]> {
  if (!ghToken()) return [];
  const admin = createAdminClient();

  // Candidate specs: any with ≥1 phase NOT IN ('shipped','rejected'), not folded — the same shape
  // `healBuiltUnstampedPhases` uses. Read through the specs-table SDK (no raw PM SQL). Carry the
  // per-phase build_sha + body forward: the P1 filter below (pickPhasesBuiltInMerge) needs both to
  // decide "was this phase actually in the merged PR?" so we don't over-stamp unbuilt phases from a
  // partial manual squash-merge (the generalize-director-coach-backend #1712 incident).
  const specs = await listSpecs(workspaceId);
  const unstampedBySlug = new Map<string, PhaseBuiltCandidate[]>();
  for (const spec of specs) {
    if (spec.status === "folded") continue;
    const candidates = spec.phases
      .filter((p) => p.status !== "shipped" && p.status !== "rejected")
      .map((p) => ({ position: p.position, build_sha: p.build_sha, body: p.body }));
    if (candidates.length) unstampedBySlug.set(spec.slug, candidates);
  }
  if (!unstampedBySlug.size) return [];

  const owner = REPO.split("/")[0];
  const healed: { slug: string; phases: number[]; pr: number }[] = [];

  for (const [slug, candidates] of unstampedBySlug) {
    const branch = `claude/build-${slug}`;

    // List EVERY PR (open + closed + merged) whose head is this branch. state=all so we can
    // distinguish a MERGED PR from a CLOSED-unmerged one (which shares state=closed). Never guess:
    // a non-ok response or a non-array payload → skip this spec (fail-closed). Exceptions are
    // caught → skip (a later pass retries). Selection is the pure `pickMergedPrFromList` helper
    // (Phase 2 verification lives in spec-drift.test.ts): OPEN + CLOSED-unmerged never win, and
    // MERGED wins regardless of the API's iteration order.
    let merged: { number: number; merge_sha: string | null } | null = null;
    try {
      const res = await gh(
        "GET",
        `/repos/${REPO}/pulls?head=${encodeURIComponent(owner)}:${encodeURIComponent(branch)}&state=all&per_page=100`,
      );
      if (!res.ok || !Array.isArray(res.json)) continue;
      merged = pickMergedPrFromList(res.json as unknown as BranchPrCandidate[]);
    } catch {
      continue; // fail-closed: exception → no stamp, next pass retries
    }
    if (!merged) continue; // no MERGED PR (open / closed-unmerged / none) → skip, never stamp

    // Fetch the merge commit's changed-file set — the fallback source for phases whose branch
    // build never stamped a `build_sha` but whose code was still smuggled into the squash. Best-
    // effort: a null (missing merge_sha / GitHub read failure / non-array `files`) collapses the
    // filter to `build_sha`-only, so a phase with a recorded branch build still qualifies but a
    // path-intersection heal waits for a later pass when GitHub answers.
    let mergedFiles: Set<string> | null = null;
    if (merged.merge_sha) {
      try {
        const cRes = await gh("GET", `/repos/${REPO}/commits/${merged.merge_sha}`);
        if (cRes.ok) {
          const rawFiles = (cRes.json.files as Array<{ filename?: string }> | undefined) ?? [];
          mergedFiles = new Set(rawFiles.map((f) => String(f.filename ?? "")).filter(Boolean));
        }
      } catch {
        mergedFiles = null; // read failure — fall back to build_sha-only for this pass
      }
    }

    // Filter to the phases ACTUALLY in this merge (build_sha ≠ null, or a declared file in the
    // merge diff). Unbuilt phases (build_sha=null AND no file intersection) stay in their prior
    // status so their one-phase-per-session build sessions still auto-queue — the fix for the
    // fold-deadlock this spec is closing.
    const filtered = pickPhasesBuiltInMerge(candidates, mergedFiles);
    if (!filtered.stamped.length) {
      // No phase in this spec's PR — nothing to stamp. Don't emit a director_activity row (there's
      // no heal to report), just skip. A later pass with a fresh build_sha or a proper build-flow
      // stamp will heal on its own turn.
      continue;
    }

    const stamped: { position: number; reason: "build_sha" | "file-diff" }[] = [];
    for (const s of filtered.stamped.slice().sort((a, b) => a.position - b.position)) {
      try {
        await stampPhaseShipped(workspaceId, slug, s.position, {
          pr: merged.number,
          merge_sha: merged.merge_sha,
        });
        stamped.push(s);
      } catch {
        /* a single-phase stamp failure — the next sweep re-attempts the remainder */
      }
    }
    if (!stamped.length) continue;
    healed.push({ slug, phases: stamped.map((s) => s.position), pr: merged.number });

    // Supervisor-visible report: one director_activity row per healed spec, naming the signal +
    // ONLY the phases actually stamped. `skipped_phases` lists the unbuilt phases we deliberately
    // left in their prior status so the operator can see the healer honored the "one PR = only its
    // own phases" invariant (never a blanket all-non-shipped stamp).
    const stampedPositions = stamped.map((s) => s.position);
    const stampedReasons = stamped.map((s) => `P${s.position} (${s.reason})`).join(", ");
    const skippedSuffix = filtered.skipped.length
      ? ` Left ${filtered.skipped.length} unbuilt phase(s) (P${filtered.skipped.join(", P")}) in their prior status — their build_sha is null AND their declared files are not in the merge diff, so their one-phase-per-session builds can still auto-queue instead of dead-ending as "already shipped".`
      : "";
    try {
      const { recordDirectorActivity } = await import("@/lib/director-activity");
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: "platform",
        actionKind: "healed_built_unstamped",
        specSlug: slug,
        reason: `reconciler:spec-drift stamped ${stamped.length} built-but-unstamped phase(s) (${stampedReasons}) of ${slug} shipped — GitHub reports ${branch}'s PR #${merged.number} is MERGED (merge_sha ${merged.merge_sha ?? "unknown"}). The owner manually squash-merged the PR (which the Branches page invites), so the box's own merge flow never fired the "already merged via #N" job-log signal and the phases stalled. Self-healed the derived status from GitHub's MERGED state, filtered to phases actually in this PR (build_sha or merge-diff intersection).${skippedSuffix}`,
        metadata: {
          actor: "reconciler:spec-drift",
          signal: "github-pr-merged",
          pr: merged.number,
          merge_sha: merged.merge_sha,
          phases: stampedPositions,
          skipped_phases: filtered.skipped,
          stamp_reasons: stamped,
          branch,
        },
      });
    } catch {
      /* audit is best-effort — the stamp already landed */
    }
  }

  return healed;
}

// ── Self-heal "archived-but-not-folded" specs (folded-spec-must-stay-folded) ────────────────────────

/**
 * The SYMMETRIC backstop to `healBuiltUnstampedPhases`: where that stamps a SHIPPED phase the DB missed,
 * this FOLDS a DB row the ARCHIVE says is done. Together they make the spec-drift reconciler self-heal
 * BOTH drift directions.
 *
 * THE LOOP THIS CLOSES (the db-reduce-calls incident): the fold worker moves a spec's markdown to
 * `docs/brain/archive.d/{slug}.md` AND flips `specs.status='folded'` — but the two are NOT atomic (the
 * markdown lands on `main` at PR-MERGE, the status flips at PR-OPEN) and `folded` is an OVERRIDE-ONLY
 * column a later re-author/reconcile can clobber to NULL. When that happens the slug's markdown is in
 * archive.d/ (authoritative: it shipped + folded) but the DB row reads NULL/planned/in_progress → the
 * phase rollup DERIVES an ACTIVE status → the archived spec re-appears in the board's Planned column AND
 * `cancelJobsForArchivedSpecs` (which keys on archive.d/ presence) auto-cancels its builds as "spec
 * archived". A DB-vs-archive split that strands a phantom planned spec forever.
 *
 * THE FIX: the archive is AUTHORITATIVE — the markdown was DELIBERATELY moved to archive.d/, so the spec
 * shipped + folded. For every archived slug whose DB row exists with `status != 'folded'`, persist the
 * `folded` override via `setSpecStatus` (the only sanctioned `specs.status` writer). No code-on-main check
 * is needed (unlike the phase-stamp paths) — archive.d/ presence IS the proof. One supervisor-visible
 * `director_activity` row per heal. Idempotent: a re-run finds `status='folded'` → no-op.
 *
 * CANNOT FALSE-FIRE: it acts ONLY when (a) the slug is genuinely in `docs/brain/archive.d/` AND (b) the DB
 * row exists with a NON-folded status. It NEVER folds an active spec that isn't archived, and NEVER
 * authors a row for an archived slug that has no DB row in this workspace.
 *
 * SINGLE-WORKSPACE by contract (mirrors `healBuiltUnstampedPhases`) — it MUTATES status, so the caller
 * passes the canonical PM workspace; this never iterates workspaces.
 */
export async function reconcileArchivedNotFolded(
  workspaceId: string,
): Promise<{ slug: string; previous: SpecStatus | null }[]> {
  const archived = await listArchivedSlugs();
  if (!archived.length) return [];
  const admin = createAdminClient();
  const healed: { slug: string; previous: SpecStatus | null }[] = [];

  for (const slug of archived) {
    let spec: Awaited<ReturnType<typeof getSpec>>;
    try {
      spec = await getSpec(workspaceId, slug);
    } catch {
      continue; // read failure — leave it for the next sweep
    }
    if (!spec) continue; // archived slug with no DB row in this workspace — never author one
    if (spec.status === "folded") continue; // already terminal — idempotent no-op
    const previous = spec.status;

    try {
      await setSpecStatus(workspaceId, slug, "folded", "reconciler:spec-drift");
    } catch {
      continue; // write failed — the next sweep re-attempts
    }
    healed.push({ slug, previous });

    // Supervisor-visible report: one director_activity row naming the slug + the status it drifted from.
    try {
      const { recordDirectorActivity } = await import("@/lib/director-activity");
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: "platform",
        actionKind: "reconciled_archived_not_folded",
        specSlug: slug,
        reason: `reconciler:spec-drift folded ${slug} — its markdown is in docs/brain/archive.d/ (the spec shipped + was folded into the brain) but the DB row still read '${previous ?? "planned (derived from the phase rollup)"}', so it drifted back onto the active board and its builds were being auto-cancelled as "spec archived". The archive is authoritative — persisted the 'folded' override to self-heal.`,
        metadata: { actor: "reconciler:spec-drift", signal: "archived-not-folded", previous },
      });
    } catch {
      /* audit is best-effort — the fold already landed */
    }
  }

  return healed;
}

/**
 * The DB-vs-CODE consistency backstop, plus the spec_phases anomaly sweep (repurpose-spec-drift-reconciler
 * Phase 2). Status is DERIVED from spec_phases now (the rollup trigger was dropped — derive-rollup-status
 * P3), so the reconciler NEVER writes spec_card_state.status anymore — that would only append phantom rows
 * to spec_status_history for a field nothing reads. Its remaining jobs:
 *
 *   (a) DB-vs-code: for every phase canonical `spec_phases` marks **shipped**, verify the phase's code is
 *       ACTUALLY on `main`. If a shipped phase's code paths are missing (a bad/reverted merge, a wrong DB
 *       write), surface a `spec_drift` row for the supervising director to confirm + escalate. NEVER
 *       mutates status here (surface-don't-auto-correct, North star — the leash's reversibility backstop).
 *
 *   (b) Anomaly sweep: surface genuine `spec_phases` anomalies the auto-healer can't fix — orphan rows
 *       (a spec_phases child whose parent specs row is gone), duplicate positions within a spec (the
 *       upsert spine bypassed), and provenance gaps (`status='shipped'` with both `pr` and `merge_sha`
 *       null — a stamp landed without recording the merge that shipped it). One `director_activity` row
 *       per anomaly cluster, routed to the platform director. Idempotent: a second pass finds the same
 *       anomalies and emits the same audit rows; the dashboard de-dupes by spec/kind.
 *
 * Phase bodies live in `public.spec_phases.body` (retire-md-reads-from-pm-flow Phase 2 — the PM flow
 * reads no `docs/brain/specs/*.md` anymore); the path-existence check pulls `body` straight from the
 * canonical row.
 */
export async function runSpecDriftReconciler(workspaceId: string): Promise<DriftSweepResult> {
  if (!ghToken()) return { specsScanned: 0, flipped: 0, surfaced: 0 };
  const archived = new Set(await listArchivedSlugs());
  const cache = new Map<string, boolean>();
  const suspects: { slug: string; index: number; title: string }[] = [];
  let scanned = 0;

  // (a) DB-vs-code: read the CANONICAL shipped phases from `spec_phases` (not the spec_card_state mirror)
  //     so the check tracks the truth the board derives from. `body` + `title` come from the same row —
  //     retire-md-reads-from-pm-flow Phase 2: no `docs/brain/specs/*.md` fetch + parse for the path
  //     verification, we read the typed body straight from the canonical row. Through the specs-table SDK
  //     (no raw PM SQL — pm-db-agent-toolkit); filter to shipped phases of non-folded specs in memory.
  const specRows = await listSpecs(workspaceId);
  // Goal-aware guard (reese-goal-aware-drift Phase 1) — load the goal list once + skip specs whose
  // owning goal has not promoted to main yet. A goal-member's shipped phase's code lives on the
  // goal branch until the goal atomically promotes; scanning it against main would false-flag a
  // reverse-drift row. Any existing open row for such a spec auto-resolves via `syncReverseDriftRows`
  // (which resolves any open row not in the current suspect set). Fail-open — a `listGoals` read
  // failure falls back to the non-goal-aware scan (never suppress a real drift on a hiccup).
  let goalsForGuard: GoalRow[] = [];
  try { goalsForGuard = await listGoals(workspaceId); } catch { goalsForGuard = []; }
  const shippedBySlug = new Map<string, { position: number; title: string; body: string }[]>();
  for (const spec of specRows) {
    if (spec.status === "folded") continue;
    if (archived.has(spec.slug)) continue;
    if (isGoalPendingPromotion(spec.milestone_id, goalsForGuard).pending) continue;
    const shipped = spec.phases.filter((p) => p.status === "shipped");
    if (!shipped.length) continue;
    shippedBySlug.set(
      spec.slug,
      shipped.map((p) => ({ position: p.position, title: p.title, body: p.body })),
    );
  }

  for (const [slug, rows] of shippedBySlug) {
    scanned++;
    for (const row of rows) {
      // `spec_phases.position` is 1-based; the drift surface uses 0-based `index` (matches /api/roadmap/spec-drift).
      const index = row.position - 1;
      const paths = extractCodePaths(row.body);
      if (!paths.length) continue; // no code paths declared → can't verify → trust the DB (don't false-flag)
      const checks = await Promise.all(paths.map((p) => pathExistsOnMain(p, cache)));
      if (!checks.every(Boolean)) suspects.push({ slug, index, title: row.title }); // shipped in DB, code missing on main
    }
  }
  await syncReverseDriftRows(workspaceId, suspects);

  // (b) Anomaly sweep — orphan/duplicate spec_phases rows + provenance gaps. Surface-only: one
  //     director_activity row per spec with at least one anomaly the reconciler can't auto-heal.
  await detectSpecPhaseAnomalies(workspaceId);

  return { specsScanned: scanned, flipped: 0, surfaced: suspects.length };
}

/**
 * The spec_phases anomaly sweep (repurpose-spec-drift-reconciler Phase 2). Three genuine anomalies the
 * reconciler can't auto-heal — they reflect a corrupt write upstream, not stale drift — surface to the
 * platform director as one `director_activity` row per spec / kind:
 *
 *   - ORPHAN: a spec_phases row whose parent specs row is gone (the FK ON DELETE CASCADE should kill
 *     these on parent delete, so a survivor is a data-integrity bug — probably a missing FK or a manual
 *     row insert via a one-off script).
 *
 *   - DUPLICATE POSITION: two spec_phases rows with the same (spec_id, position). The unique index
 *     should prevent this, so a survivor means the index is missing or was dropped — surface for the
 *     director to investigate, never auto-deduplicate (which of the two carries the truth?).
 *
 *   - PROVENANCE GAP: a `status='shipped'` row with both `pr` IS NULL and `merge_sha` IS NULL — a stamp
 *     landed without recording the merge that shipped it. The board's per-phase PR chip can't render
 *     and the audit trail loses the shipping commit. Surface so the director can backfill from the
 *     build job / merge hook.
 *
 * Read-only against `spec_phases` + `specs`; never mutates. Best-effort + never throws — a query failure
 * leaves the next beat to retry. Returns the count of anomaly clusters reported (one per spec/kind).
 */
export async function detectSpecPhaseAnomalies(workspaceId: string): Promise<{ orphans: number; duplicates: number; provenanceGaps: number }> {
  const admin = createAdminClient();
  let orphanReported = 0;
  let dupReported = 0;
  let gapReported = 0;

  const { recordDirectorActivity } = await import("@/lib/director-activity");

  // ORPHAN + PROVENANCE-GAP sweeps both come from the specs-table SDK's integrity-scan reader
  // (`listSpecPhaseAnomalies`) — no raw PM SQL (pm-db-agent-toolkit). The reader resolves spec_id→{slug,
  // workspace} internally: orphans are global (no parent to read a workspace from), provenance gaps are
  // workspace-scoped + folded-excluded.
  let anomalies: Awaited<ReturnType<typeof listSpecPhaseAnomalies>> = { orphans: [], provenanceGaps: [] };
  try {
    anomalies = await listSpecPhaseAnomalies(workspaceId);
  } catch { /* best-effort — a read failure leaves the next beat to retry */ }

  // ORPHAN sweep: a spec_phases row whose parent specs row is gone (FK cascade should have killed it).
  if (anomalies.orphans.length) {
    try {
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: "platform",
        actionKind: "spec_phases_anomaly",
        specSlug: null,
        reason: `reconciler:spec-drift surfaced ${anomalies.orphans.length} orphan spec_phases row(s) — spec_id has no parent specs row (FK cascade should have killed these on parent delete). Inspect + clean up via a one-off script.`,
        metadata: { actor: "reconciler:spec-drift", kind: "orphan", count: anomalies.orphans.length, sample: anomalies.orphans.slice(0, 10).map((o) => ({ id: o.phase_id, spec_id: o.spec_id, position: o.position, status: o.status })) },
      });
      orphanReported = 1;
    } catch { /* best-effort audit */ }
  }

  // DUPLICATE POSITION sweep: same (spec_id, position) appears twice. The unique index
  // (spec_phases_spec_position) should prevent this — a survivor means the index is missing or was
  // dropped. Read the workspace's specs through the SDK (no raw PM SQL); a duplicate surfaces as two
  // `spec.phases` entries sharing a position. Surface, never auto-dedupe (which row carries the truth?).
  try {
    const specRows = await listSpecs(workspaceId);
    for (const spec of specRows) {
      const byPos = new Map<number, SpecPhaseRow[]>();
      for (const p of spec.phases) {
        const list = byPos.get(p.position) ?? [];
        list.push(p);
        byPos.set(p.position, list);
      }
      for (const [position, list] of byPos) {
        if (list.length < 2) continue;
        try {
          await recordDirectorActivity(admin, {
            workspaceId,
            directorFunction: "platform",
            actionKind: "spec_phases_anomaly",
            specSlug: spec.slug,
            reason: `reconciler:spec-drift surfaced duplicate spec_phases rows for ${spec.slug} position ${position} — ${list.length} rows share (spec_id, position). The unique index should prevent this; inspect which carries the truth + dedupe.`,
            metadata: { actor: "reconciler:spec-drift", kind: "duplicate_position", slug: spec.slug, position, ids: list.map((l) => l.id), statuses: list.map((l) => l.status) },
          });
          dupReported++;
        } catch { /* best-effort audit */ }
      }
    }
  } catch { /* best-effort — a read failure leaves the next beat to retry */ }

  // PROVENANCE GAP sweep: a shipped spec_phases row with both pr IS NULL and merge_sha IS NULL (resolved
  // by the SDK reader). Group by spec so the director sees one row per spec, not one per phase.
  const gapsBySlug = new Map<string, number[]>();
  for (const g of anomalies.provenanceGaps) {
    const list = gapsBySlug.get(g.slug) ?? [];
    list.push(g.position);
    gapsBySlug.set(g.slug, list);
  }
  for (const [slug, positions] of gapsBySlug) {
    const sorted = positions.sort((a, b) => a - b);
    try {
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: "platform",
        actionKind: "spec_phases_anomaly",
        specSlug: slug,
        reason: `reconciler:spec-drift surfaced ${sorted.length} shipped phase(s) of ${slug} (P${sorted.join(", P")}) with no PR + no merge_sha — provenance lost. Backfill from the build job / merge hook so the per-phase PR chip and the audit trail recover.`,
        metadata: { actor: "reconciler:spec-drift", kind: "provenance_gap", slug, phases: sorted },
      });
      gapReported++;
    } catch { /* best-effort audit */ }
  }

  return { orphans: orphanReported, duplicates: dupReported, provenanceGaps: gapReported };
}

/** Upsert an open `spec_drift` row per DB-shipped-but-code-missing phase; resolve rows that recovered. */
async function syncReverseDriftRows(workspaceId: string, suspects: { slug: string; index: number; title: string }[]): Promise<void> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const keep = new Set(suspects.map((s) => `${s.slug}#${s.index}`));
  for (const s of suspects) {
    const detail = `${s.slug} — P${s.index + 1} (${s.title}) is marked SHIPPED in the DB, but its code is NOT on main (possible bad/reverted merge or a wrong status write). Confirm + escalate.`;
    const { data: existing } = await admin
      .from("spec_drift").select("id").eq("workspace_id", workspaceId).eq("spec_slug", s.slug).eq("phase_index", s.index).eq("status", "open").limit(1);
    if (existing && existing.length) {
      await admin.from("spec_drift").update({ last_seen_at: nowIso, phase_title: s.title, current_emoji: "✅↛", detail }).eq("id", (existing[0] as { id: string }).id);
    } else {
      await admin.from("spec_drift").insert({ workspace_id: workspaceId, spec_slug: s.slug, phase_index: s.index, phase_title: s.title, current_emoji: "✅↛", detail, status: "open" }).then(undefined, () => {});
    }
  }
  // Resolve any open row that's no longer a suspect (the code came back / the phase was downgraded).
  const { data: open } = await admin.from("spec_drift").select("id, spec_slug, phase_index").eq("workspace_id", workspaceId).eq("status", "open");
  for (const row of (open ?? []) as { id: string; spec_slug: string; phase_index: number }[]) {
    if (!keep.has(`${row.spec_slug}#${row.phase_index}`)) {
      await admin.from("spec_drift").update({ status: "resolved", last_seen_at: nowIso }).eq("id", row.id);
    }
  }
}

// ── CEO inbox routing for confirmed reverse-drift (reese-goal-aware-drift Phase 2) ─────────────
//
// Before this phase a confirmed reverse-drift only reached the CEO as a director-board message —
// easy to miss when the board scrolls or the founder isn't looking at it. The board post STAYS
// (the CS/DevOps rooms still need the visibility), but each confirmed reverse-drift ALSO surfaces
// as an actionable CEO inbox item — the `dashboard_notifications` `agent_approval_request` shape
// every other escalate_founder card uses (author-spec.ts:979, fleet-spend-governor.ts:321), so it
// appears alongside the founder's other approvals with the spec + phase + missing-code detail.
//
// De-dupe: a stable per-(workspace, spec, phase) `dedupe_key` — a persistent drift row bumps the
// existing card's title/body/metadata but never mints a new one. Mirrors the fleet-spend-governor
// pattern (one OPEN breach per lane at a time; the next pass just refreshes the snapshot).

export interface ReverseDriftInboxInput {
  workspaceId: string;
  specSlug: string;
  /** 0-based phase index (matches spec_drift.phase_index and the /api/roadmap/spec-drift surface). */
  phaseIndex: number;
  phaseTitle: string;
  /** The missing-code detail (from the drift row's `detail` or the session/pre-filter reasoning). */
  detail: string;
  /** The spec_drift.id this inbox card gates — audit trail + deep-link back to the drift row. */
  driftRowId: string;
}

export interface ReverseDriftInboxRow {
  title: string;
  body: string;
  link: string;
  metadata: {
    routed_to_function: string;
    raised_by_function: string;
    escalated_by_director: string;
    escalation_kind: string;
    escalation_reason: string;
    dedupe_key: string;
    spec_slug: string;
    phase_index: number;
    phase_title: string;
    drift_row_id: string;
    deep_link: string;
    autonomous: boolean;
  };
}

/**
 * Stable per-(workspace, spec, phase) dedupe key. A re-surfaced same drift row — same (workspace,
 * slug, phase_index) — yields the same key, so the inbox emitter finds the existing OPEN card and
 * refreshes it instead of minting a duplicate. Pure — testable without DB or GitHub.
 */
export function reverseDriftDedupeKey(args: {
  workspaceId: string;
  specSlug: string;
  phaseIndex: number;
}): string {
  return `spec-drift-reverse:${args.workspaceId}:${args.specSlug}:${args.phaseIndex}`;
}

/**
 * Pure builder for the CEO inbox row surfacing ONE confirmed reverse-drift. Returns the
 * `dashboard_notifications` row shape (title/body/link/metadata) that the emitter inserts.
 *
 * Testable without DB: same inputs → same title/body/metadata (dedupe_key deterministic from
 * workspace+slug+phase). The escalation_kind `spec_drift_reverse` distinguishes this card from
 * every other escalate_founder card in the CEO approvals feed.
 */
export function buildReverseDriftInboxRow(input: ReverseDriftInboxInput): ReverseDriftInboxRow {
  const { workspaceId, specSlug, phaseIndex, phaseTitle, detail, driftRowId } = input;
  const dedupe_key = reverseDriftDedupeKey({ workspaceId, specSlug, phaseIndex });
  const title = `Reverse-drift: ${specSlug} P${phaseIndex + 1} (${phaseTitle}) — code missing from main`.slice(0, 200);
  const body = `Reese confirmed ${specSlug} P${phaseIndex + 1} (${phaseTitle}) is marked SHIPPED in the DB but its code is NOT on main. ${detail} Decide: rebuild the phase, confirm an intentional revert, or downgrade the phase status.`.slice(0, 4000);
  const link = "/dashboard/roadmap";
  return {
    title,
    body,
    link,
    metadata: {
      routed_to_function: "ceo",
      raised_by_function: "platform",
      escalated_by_director: "platform",
      escalation_kind: "spec_drift_reverse",
      escalation_reason: detail.slice(0, 2000),
      dedupe_key,
      spec_slug: specSlug,
      phase_index: phaseIndex,
      phase_title: phaseTitle,
      drift_row_id: driftRowId,
      deep_link: link,
      autonomous: true,
    },
  };
}

/**
 * Emit ONE confirmed reverse-drift as a CEO inbox item (`dashboard_notifications` type
 * `agent_approval_request` — the shape every other escalate_founder card uses). Idempotent under
 * a persistent drift row: if an OPEN card with the same dedupe_key already exists, we bump its
 * title/body/metadata but insert nothing new (the verification's "does not create a duplicate
 * inbox item" contract). A dismissed card is NOT counted as open — the founder dismissing the
 * card + Reese re-confirming the same drift is a legitimate re-surface, so a new card mints.
 *
 * Compare-and-set on the update (mirrors the read predicate) so a concurrent dismiss can't be
 * clobbered by a late re-surface: workspace + type + dedupe + still-not-dismissed. Returns
 * `{ emitted, reSurfaced }` so the caller can log which path fired. Best-effort — a Supabase
 * error is logged upstream + returned as `emitted:false, reSurfaced:false` (the board post
 * still ran and the drift row stays open for the next pass).
 */
export async function emitReverseDriftInboxItem(
  admin: ReturnType<typeof createAdminClient>,
  input: ReverseDriftInboxInput,
): Promise<{ emitted: boolean; reSurfaced: boolean; error?: string }> {
  const { workspaceId } = input;
  const row = buildReverseDriftInboxRow(input);
  const dedupe = row.metadata.dedupe_key;

  // De-dupe read: an OPEN (undismissed) same-dedupe_key notification already represents this
  // drift row. Never a bare row-exists match — narrow by (workspace, type, dedupe_key, dismissed).
  const { data: open } = await admin
    .from("dashboard_notifications")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("type", "agent_approval_request")
    .eq("metadata->>dedupe_key", dedupe)
    .eq("dismissed", false)
    .limit(1);
  if ((open ?? []).length > 0) {
    const existing = (open as Array<{ id: string }>)[0];
    // Compare-and-set: re-assert the read-time predicate on the update. A concurrent dismiss
    // between the read and the write flips `dismissed=true` and this update matches zero rows —
    // safer than a bare `.eq("id", existing.id)` update that would resurrect a dismissed card.
    const { error: updErr } = await admin
      .from("dashboard_notifications")
      .update({ title: row.title, body: row.body, metadata: row.metadata })
      .eq("id", existing.id)
      .eq("workspace_id", workspaceId)
      .eq("type", "agent_approval_request")
      .eq("metadata->>dedupe_key", dedupe)
      .eq("dismissed", false);
    if (updErr) return { emitted: false, reSurfaced: false, error: updErr.message };
    return { emitted: false, reSurfaced: true };
  }

  const { error } = await admin.from("dashboard_notifications").insert({
    workspace_id: workspaceId,
    type: "agent_approval_request",
    title: row.title,
    body: row.body,
    link: row.link,
    metadata: row.metadata,
    read: false,
    dismissed: false,
  });
  if (error) return { emitted: false, reSurfaced: false, error: error.message };
  return { emitted: true, reSurfaced: false };
}

/** Open spec-drift rows for a workspace (newest-bumped first) — the Control Tower's "Spec drift" surface. */
export async function getOpenSpecDrift(workspaceId: string): Promise<SpecDriftRow[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("spec_drift")
    .select("id, spec_slug, phase_index, phase_title, current_emoji, detail, status, opened_at, last_seen_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "open")
    .order("last_seen_at", { ascending: false })
    .limit(100);
  return (data ?? []) as SpecDriftRow[];
}

/**
 * Resolve open drift rows for a (workspace, slug) — called after the owner one-tap flips/dismisses a
 * phase on the Control Tower. Pass `phaseIndex` to resolve only that phase's row (the others stay open);
 * omit it to resolve every open row for the slug.
 */
export async function resolveSpecDrift(workspaceId: string, slug: string, phaseIndex?: number): Promise<void> {
  const admin = createAdminClient();
  let q = admin
    .from("spec_drift")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("status", "open");
  if (phaseIndex !== undefined) q = q.eq("phase_index", phaseIndex);
  await q;
}
