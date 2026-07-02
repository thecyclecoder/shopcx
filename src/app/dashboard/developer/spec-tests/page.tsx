import Link from "next/link";
import { getRoadmap, listArchivedSlugs, type SpecCard } from "@/lib/brain-roadmap";
import { getActiveWorkspaceId } from "@/lib/workspace";
import {
  getLatestSpecTestRuns,
  getPreMergeRuns,
  signSpecTestScreenshot,
  type SpecTestRun,
} from "@/lib/spec-test-runs";
import { getFixSpecForOrigin } from "@/lib/specs-table";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentJob } from "@/lib/agent-jobs";
import { AgentTestedStamp, TestChip, CheckList, type Check } from "./SpecTestView";
import TestNowButton from "./TestNowButton";
import ProposeFixButton from "./ProposeFixButton";
import FixCard, { type FixCardState } from "./FixCard";

// Reads docs/brain/specs at request time + the latest spec_test_runs — always live.

/**
 * spec-test-request-fix-inline-author-and-approve Phase 2 — translate the fix build's `agent_jobs` row
 * into the FixCard display state + the gated-action handle the inline Approve button posts to
 * /api/roadmap/approve. A build with no row yet (the request-fix authoring path's insert hadn't landed at
 * read time) reads as `building` so the card never blanks out.
 */
function deriveFixCardState(
  job: Pick<AgentJob, "id" | "status" | "pending_actions"> | null,
): { state: FixCardState; approval?: { jobId: string; actionId: string } } {
  if (!job) return { state: "building" };
  switch (job.status) {
    case "queued":
    case "claimed":
    case "building":
    case "queued_resume":
    case "blocked_on_usage":
      return { state: "building" };
    case "needs_input":
      return { state: "needs_input" };
    case "needs_approval": {
      const pending = (job.pending_actions ?? []).find((a) => a.status === "pending");
      if (!pending) return { state: "building" }; // every gate decided → resuming; show neutral state
      return { state: "needs_approval", approval: { jobId: job.id, actionId: pending.id } };
    }
    case "completed":
      return { state: "ready_to_merge" };
    case "merged":
      return { state: "merged" };
    case "failed":
    case "needs_attention":
      return { state: "failed" };
    default:
      return { state: "building" };
  }
}

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
  const workspaceId = await getActiveWorkspaceId();
  const [{ specs }, archived] = await Promise.all([getRoadmap(workspaceId ?? undefined), listArchivedSlugs()]);
  const archivedSet = new Set(archived);
  const shipped: SpecCard[] = specs
    .filter((s) => s.status === "shipped" && !archivedSet.has(s.slug))
    .sort((a, b) => a.title.localeCompare(b.title));
  const runs: Record<string, SpecTestRun> = workspaceId ? await getLatestSpecTestRuns(workspaceId) : {};
  // premerge-spectest-rerun-and-visibility Phase 3 — the "Pre-merge" surface. Branch-scoped
  // spec_test_runs (spec_branch not null) are otherwise invisible: the shipped list above filters to
  // status='shipped', so an in-progress spec's pre-merge run had no UI slot at all — this is that slot.
  // Lists the latest run per (slug, branch) regardless of verdict (approved / needs_human / issues /
  // error), so a stuck `issues` verdict on a fixed branch is visible + re-runnable. Rendered below the
  // shipped list; excludes any run whose spec is ALREADY listed above (its verdict is surfaced there).
  const preMergeRuns: SpecTestRun[] = workspaceId ? await getPreMergeRuns(workspaceId) : [];
  const shippedSlugs = new Set(shipped.map((s) => s.slug));
  const preMergeList = preMergeRuns.filter((r) => !shippedSlugs.has(r.spec_slug));
  const specTitleBySlug = new Map(specs.map((s) => [s.slug, s.title] as const));
  // (The aggregated "Needs human testing" card was removed — the Human-test queue sidebar item is the one
  // place for that. This page is just the per-spec test-run list.)

  const tested = shipped.filter((s) => runs[s.slug]).length;

  // Sign browser-check screenshots (spec-test-deep-verification Phase 1) server-side — the private
  // evidence bucket is signed per-render (short TTL); a stored signed URL would expire. Enrich each
  // run's checks with the signed `screenshotUrl` so the client CheckList can render the image.
  const signedChecksBySlug: Record<string, Check[]> = {};
  await Promise.all(
    shipped.map(async (s) => {
      const run = runs[s.slug];
      if (!run) return;
      signedChecksBySlug[s.slug] = await Promise.all(
        run.checks.map(async (c) => ({
          ...c,
          screenshotUrl: c.screenshot ? await signSpecTestScreenshot(c.screenshot) : null,
        })),
      );
    }),
  );

  // spec-test-request-fix-inline-author-and-approve Phase 2 — for every regressed origin whose latest run
  // is `agent_verdict='issues'`, resolve the inline-authored fix by typed linkage (`regression_of_slug =
  // origin`), then read its latest build `agent_jobs` row + any pending gated action so the card renders
  // the fix's state + an inline Approve button in place of the legacy "open it under Resume a recent chat"
  // copy. Linkage-driven (not a hand-typed deterministic slug) so a renamed fix slug still surfaces.
  const fixStateBySlug: Record<
    string,
    { fixSlug: string; state: FixCardState; approval?: { jobId: string; actionId: string } } | null
  > = {};
  if (workspaceId) {
    const issuesSpecs = shipped.filter((s) => runs[s.slug]?.agent_verdict === "issues");
    await Promise.all(
      issuesSpecs.map(async (s) => {
        const fix = await getFixSpecForOrigin(workspaceId, s.slug).catch(() => null);
        if (!fix) {
          fixStateBySlug[s.slug] = null;
          return;
        }
        // Latest `kind='build'` job for the fix — the build whose state the card mirrors.
        const admin = createAdminClient();
        const { data: jobRow } = await admin
          .from("agent_jobs")
          .select("id, status, pending_actions")
          .eq("workspace_id", workspaceId)
          .eq("spec_slug", fix.slug)
          .eq("kind", "build")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const job = (jobRow as Pick<AgentJob, "id" | "status" | "pending_actions"> | null) ?? null;
        fixStateBySlug[s.slug] = { fixSlug: fix.slug, ...deriveFixCardState(job) };
      }),
    );
  }

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

      {shipped.length === 0 && preMergeList.length === 0 ? (
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
                    {run && run.agent_verdict !== "error" && <TestChip summary={run.summary} />}
                  </div>
                  <div className="flex items-center gap-2">
                    {run?.agent_verdict === "issues" &&
                      (fixStateBySlug[s.slug] ? (
                        <FixCard
                          fixSlug={fixStateBySlug[s.slug]!.fixSlug}
                          state={fixStateBySlug[s.slug]!.state}
                          approval={fixStateBySlug[s.slug]!.approval}
                          compact
                        />
                      ) : (
                        <ProposeFixButton slug={s.slug} compact />
                      ))}
                    {run && <span className="text-[11px] text-zinc-400">{timeAgo(run.run_at)}</span>}
                    <TestNowButton slug={s.slug} />
                  </div>
                </div>
                {run?.agent_verdict === "error" ? (
                  <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-700 dark:bg-zinc-800/40">
                    <p className="font-medium text-zinc-600 dark:text-zinc-300">
                      Run errored — retry. <span className="font-normal text-zinc-500 dark:text-zinc-400">{run.error || "the agent produced no parseable verdict"}</span>
                    </p>
                    {run.transcript && (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer select-none text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
                          raw output tail
                        </summary>
                        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-1.5 text-[11px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                          {run.transcript}
                        </pre>
                      </details>
                    )}
                    <p className="mt-1.5 text-[11px] text-zinc-400">Use <span className="font-medium">Test now</span> to re-run.</p>
                  </div>
                ) : (
                  run?.error && <p className="mt-2 text-xs text-rose-500">{run.error}</p>
                )}
                {run && run.checks.length > 0 && (
                  <details className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                    <summary className="cursor-pointer select-none text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
                      {run.checks.length} check{run.checks.length === 1 ? "" : "s"}
                    </summary>
                    <div className="mt-2">
                      <CheckList checks={signedChecksBySlug[s.slug] ?? run.checks} />
                    </div>
                  </details>
                )}
                <code className="mt-2 block text-[11px] text-zinc-400">specs/{s.slug}.md</code>
              </div>
            );
          })}
        </div>
      )}

      {preMergeList.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Pre-merge
          </h2>
          <p className="mb-3 mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Branch-scoped runs on a <code>claude/*</code> preview — the pre-merge gate for a spec that
            hasn&apos;t shipped yet. Re-run to force a fresh preview capture + retest even after a stuck
            terminal verdict (<code>issues</code>/<code>error</code>); the current in-flight run still
            blocks. Retries hit the per-build preview, never prod.
          </p>
          <div className="space-y-3">
            {preMergeList.map((run) => {
              const title = specTitleBySlug.get(run.spec_slug) ?? run.spec_slug;
              const isError = run.agent_verdict === "error";
              const cardClass = isError
                ? "rounded-xl border border-amber-200 bg-amber-50/40 p-4 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/20"
                : "rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900";
              return (
                <div key={`${run.spec_slug}::${run.spec_branch}`} className={cardClass}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/dashboard/roadmap/${run.spec_slug}`}
                        className="text-sm font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-400"
                      >
                        {title}
                      </Link>
                      <AgentTestedStamp verdict={run.agent_verdict} />
                      {!isError && <TestChip summary={run.summary} />}
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                        {run.spec_branch}
                      </span>
                      {run.preview_url && (
                        <a
                          href={run.preview_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
                          title={run.preview_url}
                        >
                          preview ↗
                        </a>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-zinc-400">{timeAgo(run.run_at)}</span>
                      <TestNowButton slug={run.spec_slug} branch={run.spec_branch} />
                    </div>
                  </div>
                  {isError ? (
                    <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs dark:border-zinc-700 dark:bg-zinc-800/40">
                      <p className="font-medium text-zinc-600 dark:text-zinc-300">
                        Run errored — retry.{" "}
                        <span className="font-normal text-zinc-500 dark:text-zinc-400">
                          {run.error || "the agent produced no parseable verdict"}
                        </span>
                      </p>
                      {run.transcript && (
                        <details className="mt-1.5">
                          <summary className="cursor-pointer select-none text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
                            raw output tail
                          </summary>
                          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-1.5 text-[11px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                            {run.transcript}
                          </pre>
                        </details>
                      )}
                      <p className="mt-1.5 text-[11px] text-zinc-400">
                        Use <span className="font-medium">Test now</span> to re-fire against the branch preview.
                      </p>
                    </div>
                  ) : (
                    run.error && <p className="mt-2 text-xs text-rose-500">{run.error}</p>
                  )}
                  {!isError && run.checks.length > 0 && (
                    <details className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                      <summary className="cursor-pointer select-none text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
                        {run.checks.length} check{run.checks.length === 1 ? "" : "s"}
                      </summary>
                      <div className="mt-2">
                        <CheckList checks={run.checks} />
                      </div>
                    </details>
                  )}
                  <code className="mt-2 block text-[11px] text-zinc-400">specs/{run.spec_slug}.md</code>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
