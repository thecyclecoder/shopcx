/**
 * spec_test_runs — the box spec-test agent's QA report over shipped-but-unverified specs
 * (server-side helpers + shared types). The cron enqueues a kind='spec-test' agent_jobs row per
 * shipped-but-not-archived spec; the box worker (runSpecTestJob) runs the spec-test skill and writes
 * one row here. Latest run per spec wins on the Developer → Spec Tests page + roadmap board chip.
 *
 * The agent NEVER marks a spec verified/archived and NEVER runs a mutating check — it stamps an
 * agent_verdict (a bounded "automatable checks pass" proxy) the owner then confirms. See
 * docs/brain/specs/spec-test-agent.md + docs/brain/tables/spec_test_runs.md.
 */
import { createHash } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRoadmap, listArchivedSlugs } from "@/lib/brain-roadmap";
import { ACTIVE_STATUSES } from "@/lib/agent-jobs";
import { emitReactiveHeartbeat } from "@/lib/control-tower/heartbeat";
import { AUTO_FOLD_GATE_LOOP_ID } from "@/lib/control-tower/registry";
import { getSecurityStateBySlug } from "@/lib/security-agent";
import { isEffectivelyEnabled } from "@/lib/control-tower/legacy-switch-compat";

type Admin = ReturnType<typeof createAdminClient>;

export type CheckVerdict = "pass" | "fail" | "needs_human" | "inconclusive";
export type CheckCategory = "auto" | "needs_human" | "inconclusive";
// `error` = the run could not produce a parseable verdict (the agent returned prose / unparseable JSON
// even after one repair re-prompt, reported it couldn't proceed, or the worker threw). A distinct,
// retryable terminal state — NEVER a silent 0-check `approved`/empty row that reads like a clean pass.
export type AgentVerdict = "approved" | "issues" | "needs_human" | "error";

export interface SpecTestCheck {
  text: string;
  verdict: CheckVerdict;
  category?: CheckCategory;
  evidence?: string;
  /**
   * Phase 1 (spec-test-deep-verification) — for a BROWSER check, the private-bucket storage path of the
   * screenshot the headless-browser tool captured (`spec-test-evidence/<slug>/<file>.png`). Rendered on
   * the Developer → Spec Tests page via a short-lived signed URL (signSpecTestScreenshot), never a
   * public URL — dashboard screenshots can contain real customer data. Undefined for non-browser checks.
   */
  screenshot?: string;
}

export interface SpecTestSummary {
  auto_pass: number;
  auto_fail: number;
  needs_human: number;
  inconclusive: number;
}

export interface SpecTestRun {
  id: string;
  workspace_id: string;
  spec_slug: string;
  agent_job_id: string | null;
  agent_verdict: AgentVerdict;
  summary: SpecTestSummary;
  checks: SpecTestCheck[];
  transcript: string | null;
  error: string | null;
  /**
   * spec-test-on-preview-pre-merge Phase 2 — populated only on a PRE-MERGE run (spec-test against
   * a per-build *.vercel.app preview before the claude/* branch merges); a post-ship/standing-lane
   * run leaves both null. M3's green-signal helper reads the latest row per (slug, spec_branch).
   */
  spec_branch: string | null;
  preview_url: string | null;
  run_at: string;
  created_at: string;
  updated_at: string;
}

const EMPTY_SUMMARY: SpecTestSummary = { auto_pass: 0, auto_fail: 0, needs_human: 0, inconclusive: 0 };

/** Normalize a raw row's jsonb fields into typed shapes (defensive — the agent writes them). */
export function normalizeRun(row: Record<string, unknown>): SpecTestRun {
  const summary = (row.summary as Partial<SpecTestSummary>) ?? {};
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    spec_slug: String(row.spec_slug),
    agent_job_id: (row.agent_job_id as string) ?? null,
    agent_verdict: (row.agent_verdict as AgentVerdict) ?? "needs_human",
    summary: { ...EMPTY_SUMMARY, ...summary },
    checks: Array.isArray(row.checks) ? (row.checks as SpecTestCheck[]) : [],
    transcript: (row.transcript as string) ?? null,
    error: (row.error as string) ?? null,
    spec_branch: (row.spec_branch as string) ?? null,
    preview_url: (row.preview_url as string) ?? null,
    run_at: String(row.run_at),
    created_at: String(row.created_at ?? row.run_at),
    updated_at: String(row.updated_at ?? row.run_at),
  };
}

/** Latest spec-test run per spec slug for a workspace (newest wins) — drives the page + board chip. */
export async function getLatestSpecTestRuns(workspaceId: string): Promise<Record<string, SpecTestRun>> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("spec_test_runs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("run_at", { ascending: false })
    .limit(1000);
  const map: Record<string, SpecTestRun> = {};
  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    const slug = String(raw.spec_slug);
    if (!map[slug]) map[slug] = normalizeRun(raw);
  }
  return map;
}

/**
 * premerge-spectest-rerun-and-visibility Phase 3 — the "Pre-merge" surface for the Developer → Spec
 * Tests page. Latest `spec_test_runs` row per (slug, spec_branch) — regardless of verdict — so a
 * branch-scoped pre-merge run (approved/needs_human/issues/error) is visible + re-runnable, not just an
 * errored one. Pre-merge (in_progress) specs otherwise had no UI surface: the shipped list at the top of
 * the page filters to status='shipped'. A run whose spec_branch is null (post-ship / standing-lane) is
 * NOT surfaced here — those are already listed by getLatestSpecTestRuns above. The re-run affordance on
 * this surface forces a fresh preview + a re-enqueue that bypasses the terminal-verdict dedup (POST
 * /api/roadmap/spec-test with `{slug, branch}` — the API path looks up the latest build for the branch,
 * fresh-captures its preview via [[preview-capture]]'s `capturePreviewUrlForJob`, and calls
 * [[enqueuePreMergeSpecTest]] with `force: true`), so a stuck `issues` verdict on a fixed branch can be
 * kicked from the dashboard without waiting for the standing-pass backstop.
 */
export async function getPreMergeRuns(workspaceId: string): Promise<SpecTestRun[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("spec_test_runs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .not("spec_branch", "is", null)
    .order("run_at", { ascending: false })
    .limit(1000);
  const seen = new Set<string>();
  const out: SpecTestRun[] = [];
  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    const branch = (raw.spec_branch as string) ?? "";
    if (!branch) continue;
    const key = `${String(raw.spec_slug)}::${branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalizeRun(raw));
  }
  return out;
}

/**
 * Latest branch-scoped run per (slug, branch) whose `agent_verdict='error'` — retained for callers that
 * only want the errored subset. Delegates to [[getPreMergeRuns]] + filters, so the two helpers can never
 * disagree on latest-per-branch semantics.
 */
export async function getPreMergeErrorRuns(workspaceId: string): Promise<SpecTestRun[]> {
  const all = await getPreMergeRuns(workspaceId);
  return all.filter((r) => r.agent_verdict === "error");
}

/**
 * Per-spec count of human checks the owner has acted on (any resolution — verified/dismissed/failed).
 * The board chip uses this to render the `👤` part as DONE vs WAITING, so you can tell at a glance
 * whether the human testing is finished before deciding to Mark verified & archive.
 */
export async function getHumanResolutionCounts(workspaceId: string): Promise<Record<string, number>> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("spec_test_human_checks")
    .select("spec_slug, resolution")
    .eq("workspace_id", workspaceId)
    .limit(5000);
  const map: Record<string, number> = {};
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    if (r.resolution) map[String(r.spec_slug)] = (map[String(r.spec_slug)] ?? 0) + 1;
  }
  return map;
}

/** Is a spec-test job for this spec already in flight? (dedupe for the cron + the Test-now button.) */
export async function hasActiveSpecTestJob(workspaceId: string, specSlug: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "spec-test")
    .eq("spec_slug", specSlug)
    .in("status", ["queued", "queued_resume", "building", "claimed"])
    .limit(1);
  return Array.isArray(data) && data.length > 0;
}

/**
 * The set of spec slugs that have a `spec-test` agent_jobs row in ACTIVE_STATUSES (the LIVE spec-test
 * gate the build-card lifecycle timeline reads — Spec Test stage = active while a run is in flight).
 * Per-board fetch (one query, not N×); empty Set when there's no active workspace.
 */
export async function getLiveSpecTestSlugs(workspaceId: string): Promise<Set<string>> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("agent_jobs")
    .select("spec_slug")
    .eq("workspace_id", workspaceId)
    .eq("kind", "spec-test")
    .in("status", ACTIVE_STATUSES)
    .limit(500);
  const set = new Set<string>();
  for (const r of (data ?? []) as { spec_slug: string }[]) {
    if (r.spec_slug) set.add(r.spec_slug);
  }
  return set;
}

/** The compact board chip text — "✅ 8 · ✗ 1 · 👤 1" — from a run's summary. */
export function chipParts(s: SpecTestSummary): { pass: number; fail: number; human: number; inconclusive: number } {
  return { pass: s.auto_pass, fail: s.auto_fail, human: s.needs_human, inconclusive: s.inconclusive };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Phase 1 (spec-test-deep-verification) — headless-browser check screenshot evidence.
 * The browser-check tool (scripts/spec-test-browser-check.ts) captures a screenshot of the
 * owner-authed page it asserts and stores it in a PRIVATE bucket; a check carries the storage path in
 * `screenshot`. The Developer → Spec Tests page signs it for rendering. Private (not public) because a
 * dashboard screenshot can contain real customer data. See docs/brain/specs/spec-test-deep-verification.md.
 * ────────────────────────────────────────────────────────────────────────── */

/** Private bucket holding spec-test browser-check screenshots (QA evidence only — never customer assets). */
export const SPEC_TEST_EVIDENCE_BUCKET = "spec-test-evidence";

/** Ensure the private evidence bucket exists (idempotent — the browser-check tool calls this before upload). */
export async function ensureSpecTestEvidenceBucket(): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.storage.getBucket(SPEC_TEST_EVIDENCE_BUCKET);
  if (!data) await admin.storage.createBucket(SPEC_TEST_EVIDENCE_BUCKET, { public: false });
}

/** Short-lived signed URL for a stored screenshot path; null if it's missing/unsignable (render-safe). */
export async function signSpecTestScreenshot(path: string, ttlSec = 3600): Promise<string | null> {
  if (!path) return null;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage.from(SPEC_TEST_EVIDENCE_BUCKET).createSignedUrl(path, ttlSec);
    return error || !data ? null : data.signedUrl;
  } catch {
    return null;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Phase 2 — the human-test queue + regression escalation.
 * The agent classifies the bullets it CAN'T run (visual/UX or prod-mutating) as `needs_human`. The
 * Developer → Human-test queue aggregates those across every shipped-unverified spec so the owner does
 * only the human parts, marks each tested, and regressions (an auto-`fail`) get surfaced loudly with a
 * one-click "Propose fix spec" route into box-spec-chat. See docs/brain/specs/spec-test-agent.md Phase 2.
 * ────────────────────────────────────────────────────────────────────────── */

export type HumanCheckResolution = "verified" | "failed" | "dismissed";
const HUMAN_RESOLUTIONS: HumanCheckResolution[] = ["verified", "failed", "dismissed"];
export function isHumanResolution(v: unknown): v is HumanCheckResolution {
  return typeof v === "string" && (HUMAN_RESOLUTIONS as string[]).includes(v);
}

/** Stable key for a `## Verification` bullet — survives re-runs as long as the bullet text is unchanged. */
export function checkKey(text: string): string {
  const normalized = String(text).replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Phase 3 (spec-test-maximize-machine-coverage) — green-check derivation.
 * A verification check is GREEN when its latest-agent check is `pass` OR the owner marked it
 * `✓ Tested` (`spec_test_human_checks` resolution='verified'). Derived per row by the same `checkKey`
 * hash the human-queue uses, so it survives re-runs + matches owner resolutions. The green state is
 * rendered live on the VerificationCard directly from the DB (`spec_phase_checks` rows +
 * `spec_test_runs` + `spec_test_human_checks`) — pm-structured-intent-and-refs Phase 4 removed the
 * legacy markdown bullet parser; nothing extracts semantic structure from the rendered spec body.
 * ────────────────────────────────────────────────────────────────────────── */

export interface GreenBullet {
  text: string;
  green: boolean;
  via: "agent" | "owner" | null;
}

/**
 * Per-bullet green state: green iff the latest agent run has a `pass` check with the same `checkKey`,
 * OR the owner resolved it `verified`. `resolutions` is the `${slug}:${check_key}` map from
 * getHumanCheckResolutions. Pure — drives both the live VerificationCard render and the file writeback.
 */
export function deriveGreenBullets(
  bulletTexts: string[],
  run: SpecTestRun | null,
  resolutions: Map<string, HumanCheckRow>,
  slug: string,
): GreenBullet[] {
  const passKeys = new Set<string>();
  for (const c of run?.checks ?? []) {
    if (c.verdict === "pass") passKeys.add(checkKey(c.text));
  }
  return bulletTexts.map((text) => {
    const key = checkKey(text);
    if (passKeys.has(key)) return { text, green: true, via: "agent" };
    if (resolutions.get(`${slug}:${key}`)?.resolution === "verified") return { text, green: true, via: "owner" };
    return { text, green: false, via: null };
  });
}

export interface HumanCheckRow {
  spec_slug: string;
  check_key: string;
  check_text: string;
  resolution: HumanCheckResolution;
  note: string | null;
  resolved_at: string;
}

/** All owner resolutions for a workspace, keyed `${spec_slug}:${check_key}` (the queue joins them in memory). */
export async function getHumanCheckResolutions(workspaceId: string): Promise<Map<string, HumanCheckRow>> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("spec_test_human_checks")
    .select("spec_slug, check_key, check_text, resolution, note, resolved_at")
    .eq("workspace_id", workspaceId)
    .limit(2000);
  const map = new Map<string, HumanCheckRow>();
  for (const raw of (data ?? []) as Record<string, unknown>[]) {
    const row: HumanCheckRow = {
      spec_slug: String(raw.spec_slug),
      check_key: String(raw.check_key),
      check_text: String(raw.check_text ?? ""),
      resolution: isHumanResolution(raw.resolution) ? raw.resolution : "verified",
      note: (raw.note as string) ?? null,
      resolved_at: String(raw.resolved_at),
    };
    map.set(`${row.spec_slug}:${row.check_key}`, row);
  }
  return map;
}

/**
 * THE single clean-machine-pass predicate — shared by the **pre-merge promote gate**
 * ([[getSpecTestStateForBranch]]) and the **post-ship fold gate** ([[getAutoFoldEligibleSlugs]] Rail 2),
 * so the two supervision rails (one before the merge, one after) can NEVER disagree on what
 * "spec-test green" means. Both call this; do NOT inline a second copy.
 *
 * A run is a CLEAN MACHINE PASS iff ALL hold:
 *   (a) agent-verdict ∈ {`approved`, `needs_human`} — an `issues`/`error`/missing verdict is NOT clean
 *       (a genuine failure, or an unparseable/errored run that the AgentVerdict doc warns must never read
 *       as a silent pass).
 *   (b) the run ASSERTED at least one check (`run.checks.length >= 1`). This is the floor that REPLACES the
 *       old `summary.auto_pass >= 1` floor. The old floor's ONLY real job was to reject a degenerate
 *       0-check / `error` "silent empty pass" (nothing was actually asserted) — but it ALSO permanently
 *       stranded a HUMAN-ONLY spec whose Verification is entirely `needs_human` checks (auto_pass=0),
 *       leaving it in_testing forever. CEO decision: human checks are FULLY ADVISORY — a human-only run
 *       (≥1 check, 0 auto-fails, verdict `needs_human`) promotes WITHOUT requiring the human checks to be
 *       resolved. `checks.length >= 1` preserves the no-empty-run / no-`error`-row guard (the only thing the
 *       floor really protected) while letting a human-only run through.
 *   (c) 0 UNRESOLVED auto-`fail` regressions — an evidence-backed broken bullet whose
 *       `spec_test_human_checks` resolution is unset still BLOCKS; a `verified`/`dismissed` resolution clears
 *       it. `needs_human` checks do NOT need resolution (advisory). This keeps a `needs_human` run carrying a
 *       lingering machine `fail` OUT (an `approved` run won't carry a `fail`, but a `needs_human` one can).
 *
 * `resolutions` is the `${slug}:${check_key}` map from [[getHumanCheckResolutions]] (the SAME join the
 * human-test queue / regression banner use). Pure.
 */
export function isCleanMachinePassRun(
  run: SpecTestRun,
  resolutions: Map<string, HumanCheckRow>,
  slug: string,
): boolean {
  // (a) verdict gate — `issues`/`error`/(missing) are non-pass.
  if (run.agent_verdict !== "approved" && run.agent_verdict !== "needs_human") return false;
  // (b) total_checks >= 1 floor (REPLACES the old auto_pass>=1 floor) — reject a 0-check "silent empty pass",
  //     ALLOW a human-only run (auto_pass=0 but ≥1 needs_human check) — human checks are advisory (CEO).
  if (run.checks.length < 1) return false;
  // (c) 0 UNRESOLVED auto-`fail` — a verified/dismissed resolution clears it; needs_human checks don't gate.
  for (const c of run.checks) {
    if (c.verdict !== "fail") continue;
    const res = resolutions.get(`${slug}:${checkKey(c.text)}`);
    if (!res?.resolution) return false;
  }
  return true;
}

/** Upsert one owner resolution (owner-gated API only — the agent never writes here). */
export async function upsertHumanCheckResolution(args: {
  workspaceId: string;
  specSlug: string;
  checkKey: string;
  checkText: string;
  resolution: HumanCheckResolution;
  note?: string | null;
  userId: string;
}): Promise<{ error?: string }> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("spec_test_human_checks")
    .upsert(
      {
        workspace_id: args.workspaceId,
        spec_slug: args.specSlug,
        check_key: args.checkKey,
        check_text: args.checkText,
        resolution: args.resolution,
        note: args.note ?? null,
        resolved_by: args.userId,
        resolved_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,spec_slug,check_key" },
    );
  return error ? { error: error.message } : {};
}

/**
 * Agent-written (regressions-out-of-human-queue): when the regression-agent (Remi) DISMISSES a regression
 * (false-positive / already-fixed / transient / foreign — i.e. "not a real break to fix"), clear its failing
 * checks off the queue by recording a `dismissed` resolution per check. Because the resolution is keyed by
 * `spec_slug:check_key` and persists, a dismissed check stays cleared across future spec-test re-runs — so a
 * repeatedly-mis-firing check (the slack-fetch ×6 churn) gets permanently suppressed after one dismissal,
 * not re-surfaced every run. `resolved_by` is null (agent, not the owner); the owner can still re-open it via
 * clearHumanCheckResolution. Best-effort per check; returns how many cleared.
 */
export async function dismissRegressionChecks(args: {
  workspaceId: string;
  specSlug: string;
  failing: { text: string; check_key: string }[];
  verdict: string;
  reason: string;
}): Promise<number> {
  const admin = createAdminClient();
  let cleared = 0;
  for (const f of args.failing) {
    const { error } = await admin.from("spec_test_human_checks").upsert(
      {
        workspace_id: args.workspaceId,
        spec_slug: args.specSlug,
        check_key: f.check_key,
        check_text: f.text,
        resolution: "dismissed" as HumanCheckResolution,
        note: `Auto-dismissed by Remi (regression-agent): ${args.verdict} — ${args.reason}`.slice(0, 1000),
        resolved_by: null,
        resolved_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,spec_slug,check_key" },
    );
    if (!error) cleared++;
  }
  return cleared;
}

/** Clear a resolution (owner re-opens a check) — removes it from the "Done" pile back into "waiting". */
export async function clearHumanCheckResolution(
  workspaceId: string,
  specSlug: string,
  checkKey: string,
): Promise<{ error?: string }> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("spec_test_human_checks")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", specSlug)
    .eq("check_key", checkKey);
  return error ? { error: error.message } : {};
}

export interface HumanQueueItem {
  slug: string;
  title: string;
  text: string;
  evidence?: string;
  check_key: string;
  run_at: string;
  resolution: HumanCheckResolution | null;
  resolved_at: string | null;
  note: string | null;
}

export interface RegressionItem {
  slug: string;
  title: string;
  run_at: string;
  agent_verdict: AgentVerdict;
  failing: { text: string; evidence?: string; check_key: string }[];
}

export interface HumanTestQueue {
  items: HumanQueueItem[];
  regressions: RegressionItem[];
  counts: { waiting: number; resolved: number; regressions: number };
}

/**
 * The Developer → Human-test queue: every `needs_human` check across the latest run of every
 * shipped-but-not-archived spec, joined to the owner's resolutions, plus the regressions (specs whose
 * latest run has an auto-`fail`). Drives the queue page, the sidebar count, and the regression banner.
 */
export async function getHumanTestQueue(workspaceId: string): Promise<HumanTestQueue> {
  const [{ specs }, archived, runs, resolutions] = await Promise.all([
    getRoadmap(),
    listArchivedSlugs(),
    getLatestSpecTestRuns(workspaceId),
    getHumanCheckResolutions(workspaceId),
  ]);
  const archivedSet = new Set(archived);
  const titleBySlug = new Map<string, string>();
  for (const s of specs) {
    if (s.status === "shipped" && !archivedSet.has(s.slug)) titleBySlug.set(s.slug, s.title);
  }

  const items: HumanQueueItem[] = [];
  const regressions: RegressionItem[] = [];
  for (const [slug, title] of titleBySlug) {
    const run = runs[slug];
    if (!run) continue;
    for (const c of run.checks) {
      if (c.verdict !== "needs_human") continue;
      const key = checkKey(c.text);
      const res = resolutions.get(`${slug}:${key}`) ?? null;
      items.push({
        slug,
        title,
        text: c.text,
        evidence: c.evidence,
        check_key: key,
        run_at: run.run_at,
        resolution: res?.resolution ?? null,
        resolved_at: res?.resolved_at ?? null,
        note: res?.note ?? null,
      });
    }
    // A regression is a `fail` the owner hasn't dismissed/resolved yet. Join the same
    // spec_test_human_checks resolutions used for needs_human checks, and drop resolved fails —
    // so the owner CAN dismiss a (e.g. false-positive) regression and have it clear. A run only
    // counts as a regression while it has at least one UNRESOLVED fail (a stale `issues` verdict
    // with every fail dismissed is no longer a regression).
    const failing = run.checks
      .filter((c) => c.verdict === "fail")
      .map((c) => ({ text: c.text, evidence: c.evidence, check_key: checkKey(c.text) }))
      .filter((c) => !(resolutions.get(`${slug}:${c.check_key}`)?.resolution));
    if (failing.length > 0) {
      regressions.push({ slug, title, run_at: run.run_at, agent_verdict: run.agent_verdict, failing });
    }
  }

  // Newest runs first, then by spec title — keeps the queue stable run-to-run.
  items.sort((a, b) => b.run_at.localeCompare(a.run_at) || a.title.localeCompare(b.title));
  regressions.sort((a, b) => b.run_at.localeCompare(a.run_at) || a.title.localeCompare(b.title));

  const waiting = items.filter((i) => i.resolution === null).length;
  return {
    items,
    regressions,
    counts: { waiting, resolved: items.length - waiting, regressions: regressions.length },
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Gate B — fold on MACHINE spec-test pass + SECURITY clear (auto-ship-pipeline Phase 2;
 * fold-on-spec-test-pass, task #29; build-card-lifecycle-timeline Phase 3).
 *
 * The mirror of the auto-merge gate, one rung up the pipeline: where Gate A automates the owner's
 * rubber-stamp "merge" click on green PRs, Gate B folds a shipped spec into the brain the moment its
 * MACHINE spec-test passes (agent-verdict `approved` + no open regression) AND its post-merge security
 * review reaches a clean terminal state — no human click required. Fold is NON-destructive (the
 * specs/spec_phases row is PRESERVED with status='folded'; the fold just extracts knowledge into the
 * permanent brain pages), so the machine spec-test + a clean security pass are sufficient verification.
 * It optimizes a bounded proxy (fold-when-machine-tested-green-AND-security-clear), the owner still owns
 * the objective + can pause it (the `workspaces.auto_fold_enabled` kill-switch), and every fold is
 * surfaced (Control Tower heartbeat + log). Human QA is ADVISORY — a waiting/failed `needs_human` check
 * does NOT block the fold; only a real machine-detected regression (an open auto-`fail`) OR a live /
 * surfaced security-review leaves the spec alone (hitting a rail = leave it; security routes a Build card
 * via [[security-agent]] so the rail is actionable). Coalesces into the SAME batch fold-build the manual
 * verify uses (enqueue_fold).
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Kill-switch: is auto-fold enabled for a workspace? Default ENABLED (true) — the gate automates the
 * owner's verify-&-archive click, the flag exists to PAUSE it. Read via `select("*")` so a deploy that
 * lands before the `auto_fold_enabled` migration applies degrades gracefully (column absent ⇒ undefined ⇒
 * enabled), and a read failure also defaults to enabled (best-effort; the fold is still guarded by machine pass).
 * Only an explicit `auto_fold_enabled === false` pauses the gate. Mirrors isAutoMergeEnabled.
 *
 * migrate-ad-hoc-kill-switches-to-resolver Phase 1: the legacy `workspaces.auto_fold_enabled` read is
 * wrapped by [[./control-tower/legacy-switch-compat]] `readEffectiveOnOff('fold', ...)` so a
 * `platform`-scope kill_switches row (department seat OR the `fold` agent) also pauses the gate.
 * Union semantics — either source OFF wins.
 */
export async function isAutoFoldEnabled(workspaceId: string, adminClient?: Admin): Promise<boolean> {
  const legacyFn = async (): Promise<boolean | undefined> => {
    try {
      const admin = adminClient || createAdminClient();
      const { data } = await admin.from("workspaces").select("*").eq("id", workspaceId).maybeSingle();
      const flag = (data as Record<string, unknown> | null)?.auto_fold_enabled;
      return flag !== false;
    } catch {
      return true;
    }
  };
  return isEffectivelyEnabled("fold", legacyFn);
}

/**
 * The set of shipped-but-not-archived specs eligible to fold for a workspace.
 *
 * fold-on-spec-test-pass (task #29): the fold trigger is the MACHINE spec-test pass, NOT human
 * verification. Fold is NON-destructive in the DB-driven world (the specs/spec_phases row is PRESERVED
 * with status='folded'; the fold only extracts knowledge into the permanent brain pages) — so gating it
 * on an uncompletable human-test backlog just blinds the devops agents to shipped code. A spec is eligible
 * when BOTH gates pass:
 *   - **Spec-test gate** (the original): the latest spec_test run is a CLEAN MACHINE PASS — agent-verdict
 *     `approved` OR `needs_human` (its automatable Verification checks all pass; a `needs_human` verdict means
 *     the agent machine-verified everything it could and flagged the REMAINDER for OPTIONAL human review —
 *     task #29) AND 0 regressions (no UNRESOLVED auto-`fail` check — an evidence-backed broken bullet; same
 *     definition the human-test queue / regression banner use). A FAILING spec-test (verdict `issues`/`error`,
 *     or any open auto-`fail` — incl. a `needs_human` run that carries an unresolved machine `fail`) is NOT
 *     eligible — it surfaces the failure instead of folding.
 *   - **Security-test gate** ([[../specs/build-card-lifecycle-timeline]] Phase 3): the per-diff
 *     [[security-agent]] review for the slug has reached a clean terminal state — a `completed`
 *     security-review job exists AND there is no live job (`queued`/`claimed`/`building`/`needs_input`/
 *     `queued_resume`) and no surfaced job (`needs_approval` = routed real-vuln fix · `needs_attention` =
 *     needs-human finding). The security-test rollup ([[getSecurityStateBySlug]]) is the SAME signal the
 *     timeline's Security node reads (Phase 1 `securityCompletedClean`) so the two can never disagree.
 *     A spec whose security-review is still live or surfaced is NOT yet eligible — the fold DEFERS until
 *     security clears, exactly as it defers behind a live build today (fold-guard-live-build precedent).
 *     A shipped spec with no security-review record yet (the merge hook hasn't fired, or it's mid-enqueue)
 *     is also NOT eligible — defer until the post-merge review lands.
 *
 * Human QA is now ADVISORY, never a fold gate (task #29): a `needs_human` VERDICT, a `needs_human` check the
 * owner hasn't resolved, or a human `failed` resolution, does NOT block the fold (the "human QA pending" badge
 * stays for the owner to clear whenever they want, or never). Before this fix only `approved` folded, which
 * wrongly stranded the machine-passed `needs_human` specs shipped-but-unfoldable. Pure read; mirrors the
 * regression definition so the gate can never disagree with the surfaced regression banner. A spec missing a
 * run is NOT eligible (it hasn't been machine-tested yet).
 *
 * Three correctness rails (fix(fold) — getAutoFoldEligibleSlugs requires derived-shipped + approved
 * spec-test + goal-not-in-flight):
 *   1. DERIVED-shipped, never the stored column. `getRoadmap()` builds each SpecCard's `status` from the
 *      PHASE ROLLUP (`deriveSpecCardStatus`→`rollupPhaseStatus`: all phases shipped ⇒ shipped; terminal
 *      deferred/in_review/folded win), NOT the vestigial `specs.status` column — so a spec stamped
 *      `planned`/`in_review`/`in_progress` on the row but with all phases shipped reads `shipped` here, and a
 *      still-building spec never reads shipped just because the stored column is stale. We re-assert
 *      `s.status === "shipped"` (a `deferred`/`in_review`/`in_progress`/`planned` rollup is rejected).
 *   2. POSITIVE machine pass, not absence-of-failure (the SINGLE shared [[isCleanMachinePassRun]] predicate).
 *      The latest run must be `agent_verdict IN ('approved','needs_human')` AND have ASSERTED at least one
 *      check (`run.checks.length >= 1` — the total_checks floor that REPLACED the old `auto_pass >= 1` floor,
 *      so a HUMAN-ONLY spec with auto_pass=0 but ≥1 `needs_human` check now folds instead of stranding forever;
 *      human checks fully advisory per CEO) AND have 0 unresolved auto-`fail` regressions. A degenerate 0-check
 *      row — the "silent empty pass" the AgentVerdict doc warns about (an unparseable/empty verdict that reads
 *      like a clean pass) — asserted nothing, so it is NOT eligible. Absence of a `fail` ≠ a pass.
 *   3. GOAL-BOUND DEFER (goal-promotion-fold-collision-and-held-surfacing Phase 1). A spec whose parent
 *      goal is still IN-FLIGHT (stored `goals.status` ∈ {`proposed`,`greenlit`} — the atomic goal→main
 *      promotion has NOT yet landed) DEFERS its fold. Otherwise the fold PR writes the goal's brain pages
 *      to main WHILE the goal branch is also editing them, and M5's `mergeGoalBranchIntoMain` 409s on the
 *      resulting add/add + content conflicts — the 2026-07-06 centralized-commerce-sdk incident. Once M5
 *      lands (`finalizePromotedGoal` flips the goal → `complete`) the guard clears and the next fold-cron
 *      sweep picks the spec back up. A one-off spec (`null` goal) or a spec whose goal is already
 *      `complete`/`folded` folds normally. Redirects the fold's write target off `main` at the source.
 *      See [[isFoldSafeGivenGoalStatus]] for the pure predicate + tests.
 *
 * Supervisable-autonomy posture: hitting the security rail (live/surfaced) = DEFER + escalate (the Build
 * card surfaces the routed fix); the gate NEVER folds past it.
 */
/**
 * goal-promotion-fold-collision-and-held-surfacing Phase 1 — the pure predicate the goal-bound-defer rail
 * evaluates. Returns TRUE iff a spec's fold-to-brain is safe to land on `main` given the STORED status of
 * its parent goal (or `null` when the spec is a one-off with no goal).
 *
 * The atomic goal→main promotion ([[../libraries/agent-jobs]] `promoteCompleteGoalsToMain` → M5's
 * `mergeGoalBranchIntoMain`) is the ONLY sanctioned path for a goal-bound spec's code (and its accumulated
 * `docs/brain/` edits) to reach `main`. Before that atomic merge lands, a fold PR editing the SAME brain
 * pages the goal branch also touches would 409 the atomic merge on add/add + content conflicts (the
 * 2026-07-06 centralized-commerce-sdk incident). So:
 *   - `null` — the spec is a one-off (no goal). No goal branch to collide with. Safe.
 *   - `'proposed'` / `'greenlit'` — the goal is still in-flight; M5's atomic promotion has NOT yet landed.
 *     DEFER the fold. `finalizePromotedGoal` flips the goal → `complete` right after the atomic merge, so
 *     the next fold-cron sweep clears the guard and folds normally.
 *   - `'complete'` / `'folded'` — the goal's atomic promotion landed (its brain-page edits are already on
 *     `main`); the fold is now additive-only. Safe.
 *
 * Pure — no I/O. See `spec-test-runs.test.ts` for the state pins.
 */
export type GoalStoredStatus = "proposed" | "greenlit" | "complete" | "folded" | null;
export function isFoldSafeGivenGoalStatus(goalStatus: GoalStoredStatus): boolean {
  if (goalStatus === null) return true;
  if (goalStatus === "complete" || goalStatus === "folded") return true;
  return false;
}

export async function getAutoFoldEligibleSlugs(workspaceId: string): Promise<string[]> {
  const admin = createAdminClient();
  // Rail 3 imports (goal-promotion-fold-collision-and-held-surfacing Phase 1) — hoisted so the loop
  // doesn't re-import per spec. Dynamic to break the specs-table ↔ agent-jobs ↔ spec-test-runs cycle the
  // rest of this module already navigates the same way.
  const { resolveGoalSlugForSpec } = await import("@/lib/agent-jobs");
  const { getGoal } = await import("@/lib/goals-table");
  const [{ specs }, archived, runs, resolutions, liveRows, securityBySlug] = await Promise.all([
    // Grade the SAME workspace whose spec-test runs we read below — `getRoadmap()` with no arg resolves a
    // non-deterministic DEFAULT workspace (latest agent_job), so the gate would otherwise grade the wrong
    // workspace's specs against this workspace's runs. Pass workspaceId so the rollup-derived `shipped` set
    // and the spec-test runs are always for the same tenant.
    getRoadmap(workspaceId),
    listArchivedSlugs(),
    getLatestSpecTestRuns(workspaceId),
    getHumanCheckResolutions(workspaceId),
    // fold-guard-live-build (Phase 1): a spec with a live build/spec-test job is NOT eligible — auto-folding
    // it would orphan the running build (its spec page 404s the moment the fold merges). The re-test/build
    // completes and re-triggers the gate, so this defers the fold, never drops it. Mirror of the manual
    // verify guard (getLiveJobForSlug) so the gate and the owner's click can never disagree.
    admin
      .from("agent_jobs")
      .select("spec_slug")
      .eq("workspace_id", workspaceId)
      .in("kind", ["build", "spec-test"])
      .in("status", ACTIVE_STATUSES),
    // fold-gate security gate (build-card-lifecycle-timeline Phase 3): one batched per-slug rollup that
    // mirrors Phase 1's `securityCompletedClean` signal — clean iff a `completed` security-review job
    // exists for the slug AND no live/surfaced job is open. Same source the Security node reads, so the
    // node + the gate can never disagree.
    getSecurityStateBySlug(admin, workspaceId),
  ]);
  const archivedSet = new Set(archived);
  const liveSlugs = new Set(((liveRows.data ?? []) as { spec_slug: string }[]).map((r) => r.spec_slug));
  // Rail 3 cache: goalSlug → stored status. Every member spec of the same goal resolves to the same
  // status, so this collapses N spec lookups → 1 goal lookup per goal in the batch. Populated lazily
  // as we resolve.
  const goalStatusCache = new Map<string, GoalStoredStatus>();
  const eligible: string[] = [];
  for (const s of specs) {
    // Rail 1 — DERIVED-shipped only. `s.status` is the PHASE ROLLUP from getRoadmap (deriveSpecCardStatus),
    // never the stale stored `specs.status` column; a `planned`/`in_progress`/`in_review`/`deferred` rollup
    // (or an archived spec) is rejected. All phases shipped ⇒ shipped ⇒ pass this gate.
    if (s.status !== "shipped" || archivedSet.has(s.slug)) continue;
    if (liveSlugs.has(s.slug)) continue;
    const run = runs[s.slug];
    // Rail 2 — POSITIVE machine pass, not absence-of-failure. The latest run must be a CLEAN MACHINE PASS by
    // the SINGLE shared predicate [[isCleanMachinePassRun]] (the pre-merge promote gate
    // [[getSpecTestStateForBranch]] calls the SAME helper, so the two rails can never disagree):
    //   - agent-verdict `approved` OR `needs_human` (task #29 — `needs_human` means the agent machine-verified
    //     everything it could and flagged the REMAINDER for OPTIONAL human review; human QA is advisory, NOT a
    //     failure or a fold gate; `issues`/`error`/missing are non-pass),
    //   - the run ASSERTED at least one check (`run.checks.length >= 1`) — the floor that REPLACES the old
    //     `auto_pass >= 1` floor: it still rejects a degenerate 0-check "silent empty pass" (nothing asserted),
    //     but a HUMAN-ONLY spec (Verification all `needs_human`, auto_pass=0) now folds instead of sitting
    //     in_testing forever (CEO: human checks fully advisory — promote on 0 auto-fails without resolving them),
    //   - 0 UNRESOLVED auto-`fail` regressions — an evidence-backed broken bullet (a `verified`/`dismissed`
    //     resolution clears it). This keeps a `needs_human` run carrying a lingering machine `fail` OUT.
    if (!run || !isCleanMachinePassRun(run, resolutions, s.slug)) continue;

    // Security-test gate (build-card-lifecycle-timeline Phase 3): require a clean terminal security review.
    // No record yet (`undefined`) is NOT clean — the post-merge security pass hasn't landed; defer. Live
    // (`queued`/`claimed`/`building`/`needs_input`/`queued_resume`) defers. Surfaced (`needs_approval` =
    // routed real-vuln fix · `needs_attention` = needs-human finding) defers. Only `completedClean === true`
    // (a `completed` job with no live/surfaced sibling) clears the gate — the exact condition Phase 1's
    // Security node renders as `done`.
    const sec = securityBySlug[s.slug];
    if (!sec?.completedClean) continue;

    // Rail 3 — GOAL-BOUND DEFER (goal-promotion-fold-collision-and-held-surfacing Phase 1). A spec whose
    // parent goal is still in-flight (`goals.status` ∈ {`proposed`,`greenlit`} — atomic goal→main promotion
    // has not landed yet) MUST NOT fold to main: its brain-page edits would race the goal branch's own,
    // 409ing `mergeGoalBranchIntoMain`. `finalizePromotedGoal` flips the goal to `complete` right after M5's
    // atomic merge, so a deferred spec is picked up on the next cron sweep. `resolveGoalSlugForSpec` returns
    // null for a one-off spec (no milestone / no goal chain) — we fail OPEN there (fold normally), matching
    // the "no goal-bound guard needed" case. A `getGoal` read miss also falls through to safe (never block
    // the fold on a lookup blip; the incident this rail prevents requires the goal to actually be in-flight).
    let goalSlug: string | null = null;
    try {
      goalSlug = await resolveGoalSlugForSpec(workspaceId, s.slug);
    } catch {
      goalSlug = null;
    }
    if (goalSlug) {
      let goalStatus: GoalStoredStatus;
      if (goalStatusCache.has(goalSlug)) {
        goalStatus = goalStatusCache.get(goalSlug) ?? null;
      } else {
        try {
          const goal = await getGoal(workspaceId, goalSlug);
          goalStatus = (goal?.status ?? null) as GoalStoredStatus;
        } catch {
          goalStatus = null;
        }
        goalStatusCache.set(goalSlug, goalStatus);
      }
      if (!isFoldSafeGivenGoalStatus(goalStatus)) continue;
    }

    eligible.push(s.slug);
  }
  return eligible;
}

export interface AutoFoldResult {
  enabled: boolean;
  /** shipped-but-not-archived specs that PASSED their machine spec-test (no open regression) this pass. */
  eligible: number;
  /** specs newly enqueued for the batch fold-build (excludes ones already pending/folding). */
  folded: number;
  foldedSlugs: string[];
}

/**
 * Gate B: enqueue a batch fold-build for every shipped spec that PASSED its machine spec-test AND its
 * post-merge security review in a workspace.
 *
 * Guardrails (supervisable autonomy):
 *  - kill-switch: no-op when `auto_fold_enabled === false` on the workspace.
 *  - MACHINE-PASS only — agent-verdict approved + 0 open regressions (getAutoFoldEligibleSlugs). Human QA
 *    is advisory: a waiting/failed `needs_human` check does NOT block; only an open auto-`fail` regression does.
 *  - SECURITY-CLEAR only (build-card-lifecycle-timeline Phase 3) — the per-diff security-review for the
 *    slug must have reached a clean terminal state (`completedClean` via [[getSecurityStateBySlug]]). A live
 *    review (`queued`/`claimed`/`building`/`needs_input`/`queued_resume`) or a surfaced one
 *    (`needs_approval` routed fix · `needs_attention` needs-human finding) DEFERS the fold — exactly as a
 *    live build does. Hitting the security rail = defer + escalate, never fold past it.
 *  - Idempotent: skips a spec already pending/folding (a fold job already owns it); enqueue_fold itself
 *    coalesces every eligible spec into ONE queued batch fold-build (no fan-out of N fold PRs).
 *  - requested_by = null (no human clicked — this is the gate). Surfaces the pass as a Control Tower
 *    heartbeat (loop_id = AUTO_FOLD_GATE_LOOP_ID) + a console log of each folded spec.
 */
/* ──────────────────────────────────────────────────────────────────────────
 * spec-test-on-preview-pre-merge Phase 3 — "spec-test green for this branch".
 *
 * A pre-merge spec-test (Phase 1 enqueue → Phase 2 runner) writes one
 * spec_test_runs row stamped with `spec_branch` + `preview_url` against the
 * per-build `*.vercel.app` preview. M4's promote-on-green gate needs a
 * deterministic read of "did the latest pre-merge run for THIS branch pass?"
 * — and it MUST agree with what the post-ship fold gate (above) calls a pass,
 * because both gates are the same supervision rail (one before the merge, one
 * after).
 *
 * So this section shares `getAutoFoldEligibleSlugs`'s **Rail 2** predicate
 * ([[isCleanMachinePassRun]] — the SAME helper, not a copy):
 *   - agent-verdict `approved` OR `needs_human` (the `needs_human`-is-eligible
 *     task #29 carve-out — the agent machine-verified what it could and flagged
 *     the rest as optional human review; human QA is advisory),
 *   - the run ASSERTED ≥1 check (`run.checks.length >= 1` — the total_checks floor
 *     that REPLACED the old `auto_pass >= 1` floor: it still rejects a 0-check silent
 *     empty pass, but a HUMAN-ONLY run with auto_pass=0 and ≥1 `needs_human` check now
 *     promotes; human checks fully advisory per CEO. Absence-of-fail ≠ pass),
 *   - 0 UNRESOLVED auto-`fail` regressions (consult the same
 *     `spec_test_human_checks` resolutions the human-queue uses, so a dismissed
 *     false-positive doesn't keep the branch un-promotable).
 * Absence of a run for `(slug, branch)` is NOT green — defer (the pre-merge
 * enqueue hasn't fired yet, or the box hasn't reached a verdict); same
 * absence-≠-clean rule the post-ship fold gate applies.
 *
 * Mirrors [[../specs/security-test-on-preview-pre-merge]] Phase 3's
 * `getSecurityStateForBranch` / `isSecurityGreenForBranch` shape so the M4
 * promote gate can read both signals with the same call pattern.
 * ────────────────────────────────────────────────────────────────────────── */

export interface SpecTestStateForBranch {
  /** Latest `spec_test_runs` row for this `(workspace, slug, branch)`, or null when none yet. */
  latest: SpecTestRun | null;
  /**
   * True iff `latest` is a CLEAN MACHINE PASS by the SAME shared predicate
   * [[isCleanMachinePassRun]] that [[getAutoFoldEligibleSlugs]] Rail 2 uses:
   * agent-verdict `approved` OR `needs_human`, the run ASSERTED ≥1 check
   * (`run.checks.length >= 1` — the total_checks floor that replaced the old
   * `auto_pass >= 1` floor, so a human-only run promotes; human checks advisory),
   * and zero UNRESOLVED auto-`fail` checks. The pre-merge promote gate and the
   * post-ship fold gate can never disagree because they share this predicate.
   */
  cleanMachinePass: boolean;
}

/**
 * Latest `spec_test_runs` row for `(workspace, slug, branch)` — backed by the
 * per-branch index `spec_test_runs_ws_slug_branch_idx`. Null when no pre-merge
 * run has landed for the branch yet (deferral signal for the promote gate).
 */
export async function getLatestSpecTestRunForBranch(
  workspaceId: string,
  specSlug: string,
  branch: string,
): Promise<SpecTestRun | null> {
  if (!workspaceId || !specSlug || !branch) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("spec_test_runs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", specSlug)
    .eq("spec_branch", branch)
    .order("run_at", { ascending: false })
    .limit(1);
  const row = ((data ?? [])[0] as Record<string, unknown> | undefined) ?? null;
  return row ? normalizeRun(row) : null;
}

/**
 * Per-branch spec-test rollup ([[../specs/spec-test-on-preview-pre-merge]] Phase 3) — the
 * **M4 pre-merge promote gate** reads this. Mirrors [[getAutoFoldEligibleSlugs]] Rail 2
 * (POSITIVE machine pass, not absence-of-failure) so the pre-merge gate and the post-ship
 * fold gate can never disagree on what "spec-test green" means:
 *   - agent-verdict IN (`approved`, `needs_human`) — `needs_human` is advisory-eligible
 *     (task #29); a `needs_human` run that machine-verified everything it could and
 *     flagged the rest as OPTIONAL human review is a pass, just like an `approved` one.
 *   - the run ASSERTED ≥1 check (`run.checks.length >= 1`) — the total_checks floor that
 *     REPLACED the old `auto_pass >= 1` floor. It still rejects a degenerate 0-check
 *     "silent empty pass" (the AgentVerdict doc's warning — nothing asserted), but a
 *     HUMAN-ONLY run (auto_pass=0, ≥1 `needs_human` check) now promotes; human checks are
 *     fully advisory per CEO (promote on 0 auto-fails without resolving them).
 *   - 0 UNRESOLVED auto-`fail` regressions — joins `spec_test_human_checks` resolutions
 *     the same way the human-queue regression banner does, so a dismissed false-positive
 *     doesn't keep the branch un-promotable.
 *
 * Absence of a run for `(slug, branch)` is NOT green (defer; the pre-merge enqueue
 * hasn't fired yet, or the box hasn't reached a verdict). Mirrors
 * [[../libraries/security-agent]] `getSecurityStateForBranch` (one rail, two signals).
 */
export async function getSpecTestStateForBranch(
  workspaceId: string,
  specSlug: string,
  branch: string,
): Promise<SpecTestStateForBranch> {
  const state: SpecTestStateForBranch = { latest: null, cleanMachinePass: false };
  if (!workspaceId || !specSlug || !branch) return state;
  const [latest, resolutions] = await Promise.all([
    getLatestSpecTestRunForBranch(workspaceId, specSlug, branch),
    getHumanCheckResolutions(workspaceId),
  ]);
  state.latest = latest;
  if (!latest) return state;
  // Rail 2 — POSITIVE machine pass via the SINGLE shared predicate [[isCleanMachinePassRun]] (the post-ship
  // fold gate [[getAutoFoldEligibleSlugs]] calls the SAME helper, so the pre-merge promote gate and the fold
  // gate can never disagree): verdict ∈ {approved, needs_human}, ≥1 check ASSERTED (the total_checks>=1 floor
  // that REPLACES the old auto_pass>=1 floor — a human-only run with auto_pass=0 but ≥1 needs_human check now
  // passes; human checks are fully advisory per CEO), and 0 UNRESOLVED auto-`fail` regressions.
  state.cleanMachinePass = isCleanMachinePassRun(latest, resolutions, specSlug);
  return state;
}

/**
 * The "spec-test green for this branch" signal the **M4 pre-merge promote gate** reads
 * ([[../specs/spec-test-on-preview-pre-merge]] Phase 3). Green iff
 * [[getSpecTestStateForBranch]]'s `cleanMachinePass` is true — the SAME shared predicate
 * [[isCleanMachinePassRun]] that [[getAutoFoldEligibleSlugs]] Rail 2 enforces
 * (`approved`/`needs_human` + `run.checks.length >= 1` + 0 unresolved auto-`fail`; the
 * total_checks floor replaced the old `auto_pass >= 1` so a human-only run promotes). The
 * pre-merge gate and the post-ship fold gate share this predicate so they can never
 * disagree. A branch with no pre-merge
 * `spec_test_runs` row yet is NOT green (defer; same absence-≠-clean rule).
 *
 * Mirrors [[../libraries/security-agent]] `isSecurityGreenForBranch` so M4 reads both
 * signals with one call pattern.
 */
export async function isSpecTestGreenForBranch(
  workspaceId: string,
  specSlug: string,
  branch: string,
): Promise<boolean> {
  const state = await getSpecTestStateForBranch(workspaceId, specSlug, branch);
  return state.cleanMachinePass;
}

export async function autoFoldVerifiedSpecs(workspaceId: string, adminClient?: Admin): Promise<AutoFoldResult> {
  const admin = adminClient || createAdminClient();
  const result: AutoFoldResult = { enabled: true, eligible: 0, folded: 0, foldedSlugs: [] };
  let ok = true;
  try {
    result.enabled = await isAutoFoldEnabled(workspaceId, admin);
    if (!result.enabled) return result;

    const eligibleSlugs = await getAutoFoldEligibleSlugs(workspaceId);
    result.eligible = eligibleSlugs.length;
    if (!eligibleSlugs.length) return result;

    // Skip specs a fold job already owns (pending/folding) — enqueue_fold no-ops those rows anyway, but
    // skipping keeps the surfaced `folded` count to genuinely-new folds.
    const { data: pendingRows } = await admin
      .from("pending_folds")
      .select("spec_slug")
      .eq("workspace_id", workspaceId)
      .in("status", ["pending", "folding"]);
    const pending = new Set((pendingRows ?? []).map((r) => String((r as { spec_slug: string }).spec_slug)));

    for (const slug of eligibleSlugs) {
      if (pending.has(slug)) continue;
      const { error } = await admin.rpc("enqueue_fold", { p_workspace: workspaceId, p_slug: slug, p_user: null });
      if (error) {
        ok = false;
        console.warn(`[auto-fold] enqueue_fold failed for ${slug}: ${error.message}`);
        continue;
      }
      result.folded++;
      result.foldedSlugs.push(slug);
      console.log(`[auto-fold] enqueued fold for fully-verified spec ${slug}`);
    }
    return result;
  } catch (e) {
    ok = false;
    console.error("[auto-fold] gate failed:", e instanceof Error ? e.message : e);
    return result;
  } finally {
    // Control Tower liveness + action surfacing: one beat per pass (idle = ok:true/green; a failed
    // enqueue = ok:false, feeding the error-rate assertion). Best-effort — never breaks the gate.
    await emitReactiveHeartbeat(AUTO_FOLD_GATE_LOOP_ID, {
      ok,
      produced: {
        enabled: result.enabled,
        eligible: result.eligible,
        folded: result.folded,
        foldedSlugs: result.foldedSlugs,
      },
    });
  }
}

/**
 * reactive-fold-on-gate-complete — the EVENT-DRIVEN primary trigger for Gate B (auto-fold).
 *
 * Gate B's eligibility flips the MOMENT the LAST gate clears for a spec — and which gate is last depends on
 * the spec's shape. For a one-off spec the usual order is: the build PR merges → its phase(s) ship
 * ([[agent-jobs]] `applyMergedBuildEffects` / `reconcileMergedSpecPhases`) → the post-merge SECURITY review
 * completes clean ([[../scripts/builder-worker]] `runSecurityReviewJob`) → NOW the spec is fold-eligible. The
 * spec-test job completion already fires its own auto-fold (it's the last gate when security cleared first).
 * But the OTHER two completions — a security-review reaching clean on an already-spec-test-passed spec, and a
 * post-merge phase-ship advance on a spec whose security + spec-test already cleared — had NO reactive trigger,
 * so a spec that became fold-eligible there just sat in "Awaiting fold" until the daily `spec-test-cron`
 * backstop happened to fire (observed live: `noop-pipeline-test-4` shipped + eligible but unfolded for a long
 * time). This is the SAME reactive-primary + cron-backstop pattern already applied to Gate-A merge, the
 * pre-merge spec-test/security legs, and the phase chain — the fold is the last step that was missing it.
 *
 * Call this at EVERY completion that can flip THIS spec's eligibility. It:
 *   1. Re-checks fold-eligibility for the workspace via the SAME `getAutoFoldEligibleSlugs` the cron + the
 *      manual verify path use (one source of truth — the reactive trigger and the backstop can never disagree
 *      on what "eligible" means). If `slug` isn't in the eligible set, NO-OP (a cheap read; nothing enqueued).
 *   2. If eligible, enqueues the fold through the SAME path the cron uses — `autoFoldVerifiedSpecs` — which is
 *      already idempotent (kill-switch · skips a spec a fold job already owns in `pending_folds` · `enqueue_fold`
 *      coalesces every eligible spec into ONE queued batch fold-build) and emits the Control Tower heartbeat.
 *      It folds the whole eligible set (not just `slug`) — coalesced into the one batch — so a sibling that
 *      also just became eligible rides along; the per-`slug` guard is purely to skip the enqueue when nothing
 *      is foldable yet.
 *
 * Idempotent + best-effort: `autoFoldVerifiedSpecs` never double-enqueues (a spec already pending/folding is
 * skipped; `enqueue_fold` is advisory-locked per workspace), an already-folded/archived spec is no longer
 * derived-`shipped` / is in the archived set so it's not eligible (mirrors the fold-guard-live-build guard),
 * and any throw is swallowed (the cron backstop still mops up). Returns the underlying AutoFoldResult, or null
 * on a guard short-circuit / error.
 */
export async function reactiveFoldOnGateComplete(
  workspaceId: string,
  slug: string,
  opts?: { reason?: string; admin?: Admin },
): Promise<AutoFoldResult | null> {
  if (!workspaceId || !slug) return null;
  try {
    // Per-slug eligibility re-check (reuse the canonical gate). Cheap short-circuit: if THIS spec isn't
    // foldable yet (a gate still open — security live/surfaced, a live build, no machine pass, an open
    // regression, already archived/folded), do nothing. The fold defers to whichever completion clears the
    // remaining gate — never dropped.
    const eligible = await getAutoFoldEligibleSlugs(workspaceId);
    if (!eligible.includes(slug)) return null;
    const result = await autoFoldVerifiedSpecs(workspaceId, opts?.admin);
    if (result.folded > 0) {
      console.log(
        `[reactive-fold] ${opts?.reason ? `${opts.reason} → ` : ""}folded ${result.folded} eligible spec(s) (triggered by ${slug}): ${result.foldedSlugs.join(", ")}`,
      );
    }
    return result;
  } catch (e) {
    console.error(`[reactive-fold] gate trigger for ${slug} failed (non-fatal):`, e instanceof Error ? e.message : e);
    return null;
  }
}
