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
 * A `## Verification` bullet is GREEN when its latest-agent check is `pass` OR the owner marked it
 * `✓ Tested` (`spec_test_human_checks` resolution='verified'). Derived per bullet by the same `checkKey`
 * hash the human-queue uses, so it survives re-runs + matches owner resolutions. The green state is
 * rendered live on the VerificationCard and written back onto the spec markdown as a leading ✅ by
 * `reflectSpecGreenChecks` (src/lib/spec-green-writeback.ts). See docs/brain/specs/spec-test-maximize-machine-coverage.md.
 * ────────────────────────────────────────────────────────────────────────── */

/** The ✅ marker prepended to a green verification bullet in the spec markdown. */
export const GREEN_CHECK = "✅";

export interface VerificationBullet {
  /** Bullet content, with the `- ` prefix and any leading ✅ stripped, whitespace-collapsed (keys cleanly). */
  text: string;
  /** Index of the bullet's first line (`- …`) in the raw spec markdown's line array (for the writeback edit). */
  startLine: number;
  /** Whether that first line already carries a leading ✅ (idempotency — avoid a no-op commit). */
  hasCheck: boolean;
}

/**
 * Parse the top-level `- ` bullets of a spec's `## Verification` section out of its raw markdown.
 * Continuation lines (indented / nested) fold into the current bullet's text so a multi-line bullet
 * keys the same as the agent's verbatim `check.text`. Returns [] when there's no Verification section.
 */
export function parseVerificationBullets(raw: string): VerificationBullet[] {
  const lines = String(raw).split("\n");
  const start = lines.findIndex((l) => /^##\s+Verification\b/i.test(l));
  if (start === -1) return [];
  const greenRe = new RegExp(`^${GREEN_CHECK}\\s+`);
  const bullets: VerificationBullet[] = [];
  let cur: { startLine: number; parts: string[]; hasCheck: boolean } | null = null;
  const flush = () => {
    if (cur) {
      bullets.push({ text: cur.parts.join(" ").replace(/\s+/g, " ").trim(), startLine: cur.startLine, hasCheck: cur.hasCheck });
      cur = null;
    }
  };
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break; // next section
    const m = /^- (.*)$/.exec(line); // a top-level bullet (no leading whitespace)
    if (m) {
      flush();
      let body = m[1];
      const hasCheck = greenRe.test(body);
      if (hasCheck) body = body.replace(greenRe, "");
      cur = { startLine: i, parts: [body], hasCheck };
    } else if (cur && line.trim() !== "" && /^\s+\S/.test(line)) {
      cur.parts.push(line.trim()); // indented continuation of the current bullet
    } else {
      flush(); // blank line / non-indented prose ends the bullet
    }
  }
  flush();
  return bullets;
}

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
 * Gate B — fold on MACHINE spec-test pass (auto-ship-pipeline Phase 2; fold-on-spec-test-pass, task #29).
 *
 * The mirror of the auto-merge gate, one rung up the pipeline: where Gate A automates the owner's
 * rubber-stamp "merge" click on green PRs, Gate B folds a shipped spec into the brain the moment its
 * MACHINE spec-test passes (agent-verdict `approved` + no open regression) — no human click required.
 * Fold is NON-destructive (the specs/spec_phases row is PRESERVED with status='folded'; the fold just
 * extracts knowledge into the permanent brain pages), so the machine spec-test is sufficient verification.
 * It optimizes a bounded proxy (fold-when-machine-tested-green), the owner still owns the objective + can
 * pause it (the `workspaces.auto_fold_enabled` kill-switch), and every fold is surfaced (Control Tower
 * heartbeat + log). Human QA is now ADVISORY — a waiting/failed `needs_human` check does NOT block the
 * fold; only a real machine-detected regression (an open auto-`fail`) leaves the spec alone (hitting a rail
 * = leave it). Coalesces into the SAME batch fold-build the manual verify uses (enqueue_fold).
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Kill-switch: is auto-fold enabled for a workspace? Default ENABLED (true) — the gate automates the
 * owner's verify-&-archive click, the flag exists to PAUSE it. Read via `select("*")` so a deploy that
 * lands before the `auto_fold_enabled` migration applies degrades gracefully (column absent ⇒ undefined ⇒
 * enabled), and a read failure also defaults to enabled (best-effort; the fold is still guarded by machine pass).
 * Only an explicit `auto_fold_enabled === false` pauses the gate. Mirrors isAutoMergeEnabled.
 */
export async function isAutoFoldEnabled(workspaceId: string, adminClient?: Admin): Promise<boolean> {
  try {
    const admin = adminClient || createAdminClient();
    const { data } = await admin.from("workspaces").select("*").eq("id", workspaceId).maybeSingle();
    const flag = (data as Record<string, unknown> | null)?.auto_fold_enabled;
    return flag !== false;
  } catch {
    return true;
  }
}

/**
 * The set of shipped-but-not-archived specs eligible to fold for a workspace.
 *
 * fold-on-spec-test-pass (task #29): the fold trigger is the MACHINE spec-test pass, NOT human
 * verification. Fold is NON-destructive in the DB-driven world (the specs/spec_phases row is PRESERVED
 * with status='folded'; the fold only extracts knowledge into the permanent brain pages) — so gating it
 * on an uncompletable human-test backlog just blinds the devops agents to shipped code. A spec is eligible
 * the moment its machine spec-test passes:
 *   - the latest spec_test run is agent-verdict `approved` (its automatable Verification checks all pass), AND
 *   - 0 regressions (no UNRESOLVED auto-`fail` check — an evidence-backed broken bullet; same definition the
 *     human-test queue / regression banner use). A FAILING spec-test (verdict `issues`/`needs_human`/`error`,
 *     or any open auto-`fail`) is NOT eligible — it surfaces the failure instead of folding.
 *
 * Human QA is now ADVISORY, never a fold gate: a `needs_human` check the owner hasn't resolved, or a human
 * `failed` resolution, does NOT block the fold (the "human QA pending" badge stays for the owner to clear
 * whenever they want, or never). Pure read; mirrors the regression definition so the gate can never disagree
 * with the surfaced regression banner. A spec missing a run is NOT eligible (it hasn't been machine-tested yet).
 *
 * Two correctness rails (fix(fold) — getAutoFoldEligibleSlugs requires derived-shipped + approved spec-test):
 *   1. DERIVED-shipped, never the stored column. `getRoadmap()` builds each SpecCard's `status` from the
 *      PHASE ROLLUP (`deriveSpecCardStatus`→`rollupPhaseStatus`: all phases shipped ⇒ shipped; terminal
 *      deferred/in_review/folded win), NOT the vestigial `specs.status` column — so a spec stamped
 *      `planned`/`in_review`/`in_progress` on the row but with all phases shipped reads `shipped` here, and a
 *      still-building spec never reads shipped just because the stored column is stale. We re-assert
 *      `s.status === "shipped"` (a `deferred`/`in_review`/`in_progress`/`planned` rollup is rejected).
 *   2. POSITIVE approval, not absence-of-failure. The latest run must be `agent_verdict='approved'` AND carry
 *      at least one real machine `pass` check (`summary.auto_pass > 0`). A degenerate 0-check `approved` row —
 *      the "silent empty pass" the AgentVerdict doc warns about (an unparseable/empty verdict that reads like a
 *      clean pass) — is NOT a genuine verification: nothing was actually asserted, so it is NOT eligible.
 *      Absence of a `fail` ≠ an approval.
 */
export async function getAutoFoldEligibleSlugs(workspaceId: string): Promise<string[]> {
  const admin = createAdminClient();
  const [{ specs }, archived, runs, resolutions, liveRows] = await Promise.all([
    getRoadmap(),
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
  ]);
  const archivedSet = new Set(archived);
  const liveSlugs = new Set(((liveRows.data ?? []) as { spec_slug: string }[]).map((r) => r.spec_slug));
  const eligible: string[] = [];
  for (const s of specs) {
    // Rail 1 — DERIVED-shipped only. `s.status` is the PHASE ROLLUP from getRoadmap (deriveSpecCardStatus),
    // never the stale stored `specs.status` column; a `planned`/`in_progress`/`in_review`/`deferred` rollup
    // (or an archived spec) is rejected. All phases shipped ⇒ shipped ⇒ pass this gate.
    if (s.status !== "shipped" || archivedSet.has(s.slug)) continue;
    if (liveSlugs.has(s.slug)) continue;
    const run = runs[s.slug];
    // Rail 2 — POSITIVE approval, not absence-of-failure. The latest run must be agent-verdict `approved`
    // (`issues`/`needs_human`/`error`, or a MISSING run, are non-pass → not eligible) AND carry at least one
    // real machine `pass` check. A degenerate 0-check `approved` row asserted nothing, so it is NOT a genuine
    // verification — absence of a `fail` ≠ an approval. needs_human checks stay advisory (not consulted).
    if (!run || run.agent_verdict !== "approved" || run.summary.auto_pass < 1) continue;

    // 0 regressions only: an UNRESOLVED auto-`fail` (an evidence-backed broken bullet) blocks the fold — that
    // is a real machine-detected failure, not a human-QA item. (An `approved` run won't carry a `fail`, but
    // we keep the guard so a hand-edited run / future verdict shape can't fold over an open regression.)
    let hasRegression = false;
    for (const c of run.checks) {
      if (c.verdict !== "fail") continue;
      const res = resolutions.get(`${s.slug}:${checkKey(c.text)}`);
      if (!res?.resolution) { hasRegression = true; break; }
    }
    if (hasRegression) continue;

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
 * Gate B: enqueue a batch fold-build for every shipped spec that PASSED its machine spec-test in a workspace.
 *
 * Guardrails (supervisable autonomy):
 *  - kill-switch: no-op when `auto_fold_enabled === false` on the workspace.
 *  - MACHINE-PASS only — agent-verdict approved + 0 open regressions (getAutoFoldEligibleSlugs). Human QA
 *    is advisory: a waiting/failed `needs_human` check does NOT block; only an open auto-`fail` regression does.
 *  - Idempotent: skips a spec already pending/folding (a fold job already owns it); enqueue_fold itself
 *    coalesces every eligible spec into ONE queued batch fold-build (no fan-out of N fold PRs).
 *  - requested_by = null (no human clicked — this is the gate). Surfaces the pass as a Control Tower
 *    heartbeat (loop_id = AUTO_FOLD_GATE_LOOP_ID) + a console log of each folded spec.
 */
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
