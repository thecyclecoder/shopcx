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
import { createAdminClient } from "@/lib/supabase/admin";

export type CheckVerdict = "pass" | "fail" | "needs_human" | "inconclusive";
export type CheckCategory = "auto" | "needs_human" | "inconclusive";
export type AgentVerdict = "approved" | "issues" | "needs_human";

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
