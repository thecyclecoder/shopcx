import Link from "next/link";
import { getRoadmap, listArchivedSlugs, type SpecCard } from "@/lib/brain-roadmap";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { getLatestSpecTestRuns, type SpecTestRun } from "@/lib/spec-test-runs";
import { AgentTestedStamp, TestChip, CheckList } from "./SpecTestView";
import TestNowButton from "./TestNowButton";
import ProposeFixButton from "./ProposeFixButton";

// Reads docs/brain/specs at request time + the latest spec_test_runs — always live.
export const dynamic = "force-dynamic";

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default async function SpecTestsPage() {
  const [{ specs }, archived, workspaceId] = await Promise.all([getRoadmap(), listArchivedSlugs(), getActiveWorkspaceId()]);
  const archivedSet = new Set(archived);
  const shipped: SpecCard[] = specs
    .filter((s) => s.status === "shipped" && !archivedSet.has(s.slug))
    .sort((a, b) => a.title.localeCompare(b.title));
  const runs: Record<string, SpecTestRun> = workspaceId ? await getLatestSpecTestRuns(workspaceId) : {};

  // Aggregated "Needs human testing" list across every shipped spec's latest run.
  const needsHuman: { slug: string; title: string; check: SpecTestRun["checks"][number] }[] = [];
  for (const s of shipped) {
    const run = runs[s.slug];
    if (!run) continue;
    for (const c of run.checks) {
      if (c.verdict === "needs_human") needsHuman.push({ slug: s.slug, title: s.title, check: c });
    }
  }

  const tested = shipped.filter((s) => runs[s.slug]).length;

  return (
    <div className="mx-auto w-full max-w-5xl p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Spec Tests</h1>
        <div className="flex items-center gap-3">
          <Link href="/dashboard/developer/spec-tests/human-queue" className="text-sm text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300">
            👤 Human-test queue →
          </Link>
          <Link href="/dashboard/roadmap" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
            Roadmap →
          </Link>
        </div>
      </div>
      <p className="mb-5 mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        The box QA agent runs each shipped-but-unverified spec&apos;s <code>## Verification</code> checklist —
        non-destructive checks only (repo/tsc, GitHub CI, Vercel deploy/logs/env, read-only DB probes, GET endpoints).
        It <span className="font-medium">stamps</span> what holds; it never marks a spec verified and never mutates prod.
        The owner still owns the <span className="font-medium">Verified &amp; archive</span> gate.
        <span className="ml-1 text-zinc-400">{tested}/{shipped.length} tested.</span>
      </p>

      {/* Aggregated needs-human list — the parts only the owner can do. */}
      {needsHuman.length > 0 && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-900/40 dark:bg-amber-950/20">
          <div className="mb-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
            👤 Needs human testing <span className="tabular-nums text-amber-500">{needsHuman.length}</span>
          </div>
          <ul className="space-y-1.5">
            {needsHuman.map((n, i) => (
              <li key={i} className="flex flex-wrap items-start gap-x-2 text-xs">
                <Link href={`/dashboard/roadmap/${n.slug}`} className="font-medium text-amber-700 hover:underline dark:text-amber-400">
                  {n.title}
                </Link>
                <span className="text-zinc-600 dark:text-zinc-400">{n.check.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {shipped.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          No shipped-but-unverified specs right now.
        </div>
      ) : (
        <div className="space-y-3">
          {shipped.map((s) => {
            const run = runs[s.slug];
            return (
              <div key={s.slug} className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/dashboard/roadmap/${s.slug}`} className="text-sm font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-400">
                      {s.title}
                    </Link>
                    {run ? <AgentTestedStamp verdict={run.agent_verdict} /> : <span className="text-[11px] text-zinc-400">not yet tested</span>}
                    {run && <TestChip summary={run.summary} />}
                  </div>
                  <div className="flex items-center gap-2">
                    {run?.agent_verdict === "issues" && <ProposeFixButton slug={s.slug} compact />}
                    {run && <span className="text-[11px] text-zinc-400">{timeAgo(run.run_at)}</span>}
                    <TestNowButton slug={s.slug} />
                  </div>
                </div>
                {run?.error && <p className="mt-2 text-xs text-rose-500">{run.error}</p>}
                {run && run.checks.length > 0 && (
                  <details className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                    <summary className="cursor-pointer select-none text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
                      {run.checks.length} check{run.checks.length === 1 ? "" : "s"}
                    </summary>
                    <div className="mt-2">
                      <CheckList checks={run.checks} />
                    </div>
                  </details>
                )}
                <code className="mt-2 block text-[11px] text-zinc-400">specs/{s.slug}.md</code>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
