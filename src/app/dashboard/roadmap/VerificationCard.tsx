"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

/**
 * The "how to test this" card on a spec detail page (verification-guides), rendered right beside
 * BuildButton's **Mark verified & archive** so the test steps sit where the verify decision happens.
 *
 *  - Has a `## Verification` section → render it as a prominent checklist card (`html` = its rendered md).
 *  - No section → owner-only **Generate test plan** affordance (never silence). It enqueues a box spec-chat
 *    job (POST /api/roadmap/chat, action "generate_verification"; box-spec-chat) — a Max `claude -p` that
 *    Reads the spec + its brain homes and emits a concrete `## Verification` section, which the worker commits
 *    to specs/{slug}.md on main. The section appears after the box commits it + the next deploy.
 */
export default function VerificationCard({ slug, html }: { slug: string; html: string | null }) {
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

  if (html) {
    return (
      <div className="rounded-lg border border-teal-200 bg-teal-50/60 p-3 dark:border-teal-900/40 dark:bg-teal-950/20">
        <div className="mb-1.5 text-xs font-semibold text-teal-800 dark:text-teal-300">✅ How to verify in prod</div>
        <div
          className="prose prose-sm max-w-none text-xs text-zinc-700 prose-li:my-0.5 prose-ul:my-1 prose-code:before:content-none prose-code:after:content-none dark:prose-invert dark:text-zinc-300"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    );
  }

  return (
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
  );
}
