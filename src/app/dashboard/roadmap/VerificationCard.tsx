"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import { AgentTestedStamp, CheckList, TestChip, type Check, type Summary } from "../developer/spec-tests/SpecTestView";
import TestNowButton from "../developer/spec-tests/TestNowButton";
import ProposeFixButton from "../developer/spec-tests/ProposeFixButton";

/** The latest box spec-test run for this spec (spec-test-agent) — structural, no server import. */
export interface SpecTestRunLite {
  agent_verdict: string;
  summary: Summary;
  checks: Check[];
  run_at: string;
}

/** Live per-bullet green state (spec-test-maximize-machine-coverage Phase 3) — structural, no server import. */
export interface GreenBulletLite {
  text: string;
  green: boolean;
  via: "agent" | "owner" | null;
}

/**
 * The "how to test this" card on a spec detail page (verification-guides), rendered right beside
 * BuildButton's **Mark verified & archive** so the test steps sit where the verify decision happens.
 *
 *  - Has a `## Verification` section → render it as a prominent checklist card (`html` = its rendered md).
 *  - No section → owner-only **Generate test plan** affordance (never silence). It enqueues a box spec-chat
 *    job (POST /api/roadmap/chat, action "generate_verification"; box-spec-chat) — a Max `claude -p` that
 *    Reads the spec + its brain homes and emits a concrete `## Verification` section, which the worker commits
 *    to specs/{slug}.md on main. The section appears after the box commits it + the next deploy.
 *  - `run` (spec-test-agent): the box QA agent's latest run — render the Agent-tested stamp + per-bullet
 *    verdicts + a distinct "Needs human testing" list, so the owner does only those, then verifies.
 */
export default function VerificationCard({
  slug,
  html,
  run,
  greenBullets,
  allGreen,
}: {
  slug: string;
  html: string | null;
  run?: SpecTestRunLite | null;
  greenBullets?: GreenBulletLite[];
  allGreen?: boolean;
}) {
  const workspace = useWorkspace();
  const router = useRouter();
  const [generating, setGenerating] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOwner = workspace.role === "owner";

  async function generate() {
    if (generating) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/roadmap/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, action: "generate_verification" }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "generation failed");
      setDone(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "generation failed");
    } finally {
      setGenerating(false);
    }
  }

  // The box QA agent's report — per-bullet verdicts + the human-only list (spec-test-agent).
  const humanChecks = run?.checks.filter((c) => c.verdict === "needs_human") ?? [];
  const agentBlock = run ? (
    <div className="mt-2 rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 dark:border-indigo-900/40 dark:bg-indigo-950/20">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <AgentTestedStamp verdict={run.agent_verdict} />
          <TestChip summary={run.summary} />
        </div>
        {isOwner && <TestNowButton slug={slug} compact />}
      </div>
      <p className="mb-2 text-[11px] text-zinc-500 dark:text-zinc-400">
        The box checks the automatable parts. On an <span className="font-medium">approved</span> run the spec auto-folds
        into the brain — no click needed. Any human-only checks below are advisory and never block the fold.
      </p>
      {run.agent_verdict === "issues" && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-rose-200 bg-rose-50/60 px-2 py-1.5 dark:border-rose-900/50 dark:bg-rose-950/20">
          <span className="text-[11px] font-medium text-rose-700 dark:text-rose-400">
            ⚠️ Shipped but failing its own spec-test — a likely regression.
          </span>
          {isOwner && <ProposeFixButton slug={slug} compact />}
        </div>
      )}
      {run.checks.length > 0 && <CheckList checks={run.checks} />}
      {humanChecks.length > 0 && (
        <div className="mt-2 border-t border-indigo-100 pt-2 dark:border-indigo-900/40">
          <div className="mb-1 text-[11px] font-semibold text-amber-700 dark:text-amber-400">👤 Human QA pending (advisory — doesn&apos;t block the fold)</div>
          <ul className="space-y-1">
            {humanChecks.map((c, i) => (
              <li key={i} className="text-[11px] text-zinc-600 dark:text-zinc-400">{c.text}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  ) : isOwner ? (
    <div className="mt-2 text-center">
      <TestNowButton slug={slug} compact />
    </div>
  ) : null;

  // Phase 3 (spec-test-maximize-machine-coverage): live green state of each verification bullet — green
  // when the agent passed it OR the owner marked it ✓ Tested. Rendered directly from the DB
  // (spec_test_runs + spec_test_human_checks); no markdown commit under 'DB is the spec'.
  const bullets = greenBullets ?? [];
  const greenCount = bullets.filter((b) => b.green).length;
  const greenBlock =
    bullets.length > 0 ? (
      <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50/50 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/20">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-emerald-800 dark:text-emerald-300">
            Verification progress — {greenCount}/{bullets.length} green
          </span>
        </div>
        {allGreen ? (
          <div className="mb-2 rounded-md border border-emerald-300 bg-emerald-100/70 px-2 py-1.5 text-[11px] font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
            ✅ All checks green. The machine spec-test pass auto-folds this into the brain — no click needed.
          </div>
        ) : null}
        <ul className="space-y-1">
          {bullets.map((b, i) => (
            <li key={i} className="flex items-start gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
              <span className="mt-px shrink-0" aria-hidden>
                {b.green ? "✅" : "◻️"}
              </span>
              <span className={b.green ? "text-emerald-700 dark:text-emerald-400" : undefined}>
                {b.text}
                {b.green && b.via ? (
                  <span className="ml-1 text-[10px] text-zinc-400">({b.via === "owner" ? "you tested" : "agent"})</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  if (html) {
    return (
      <div>
        {greenBlock}
        <div className="rounded-lg border border-teal-200 bg-teal-50/60 p-3 dark:border-teal-900/40 dark:bg-teal-950/20">
          <div className="mb-1.5 text-xs font-semibold text-teal-800 dark:text-teal-300">✅ How to verify in prod</div>
          <div
            className="prose prose-sm max-w-none text-xs text-zinc-700 prose-li:my-0.5 prose-ul:my-1 prose-code:before:content-none prose-code:after:content-none dark:prose-invert dark:text-zinc-300"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
        {agentBlock}
      </div>
    );
  }

  return (
    <div>
      {greenBlock}
      <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50/60 p-3 text-center dark:border-zinc-700 dark:bg-zinc-900">
        <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">No test plan yet</div>
        {isOwner &&
          (done ? (
            <p className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">
              Queued on the box — it drafts + commits to <code>specs/{slug}.md</code>. Appears here after it lands + the next deploy.
            </p>
          ) : (
            <button
              type="button"
              onClick={generate}
              disabled={generating}
              className="mt-2 rounded-md bg-teal-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-teal-700 disabled:opacity-50"
              title="Opus drafts a concrete prod-facing test checklist from this spec + its brain homes, then commits it"
            >
              {generating ? "Generating…" : "Generate test plan"}
            </button>
          ))}
        {error && <p className="mt-1 text-[11px] text-rose-500">{error}</p>}
      </div>
      {agentBlock}
    </div>
  );
}
