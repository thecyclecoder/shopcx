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

/** The compact board chip text — "✅ 8 · ✗ 1 · 👤 1" — from a run's summary. */
export function chipParts(s: SpecTestSummary): { pass: number; fail: number; human: number; inconclusive: number } {
  return { pass: s.auto_pass, fail: s.auto_fail, human: s.needs_human, inconclusive: s.inconclusive };
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
