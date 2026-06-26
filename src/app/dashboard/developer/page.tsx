"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { DEVELOPER_GROUPS, type DeveloperBadgeKey } from "@/lib/developer-nav";

// Developer portal — Overview (the portal home). Clicking "Developer" in the main nav lands here and
// swaps the sidebar for the developer sub-nav (see sidebar.tsx). This page is the directory: one card
// per developer surface (Goals, Pipeline, …) you click into. Owner-only.
// See docs/brain/dashboard/developer.md.

type Counts = Partial<Record<DeveloperBadgeKey, number>>;

const BADGE_CLS: Record<DeveloperBadgeKey, string> = {
  approvals: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  security: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  regressions: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  humanQA: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  branches: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

export default function DeveloperOverviewPage() {
  const workspace = useWorkspace();
  const [counts, setCounts] = useState<Counts>({});

  useEffect(() => {
    if (workspace.role !== "owner") return;
    const load = () => {
      fetch(`/api/developer/approvals?count=1`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.escalatedCount != null && setCounts((c) => ({ ...c, approvals: d.escalatedCount })))
        .catch(() => {});
      fetch(`/api/developer/security-tests?count=1`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.surfacedCount != null && setCounts((c) => ({ ...c, security: d.surfacedCount })))
        .catch(() => {});
      fetch(`/api/developer/spec-test/human-queue`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.counts) setCounts((c) => ({ ...c, humanQA: d.counts.waiting || 0, regressions: d.counts.regressions || 0 }));
        })
        .catch(() => {});
      fetch(`/api/branches`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.total != null && setCounts((c) => ({ ...c, branches: d.total })))
        .catch(() => {});
    };
    load();
  }, [workspace.role]);

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Developer</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This area is owner-only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Developer</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
        The build OS — goals, the spec pipeline, the autonomous agents that ship it, and the gates that keep it honest.
        Pick a surface; the sidebar stays scoped to this area until you head back.
      </p>

      <div className="mt-5 space-y-6">
        {DEVELOPER_GROUPS.map((group) => (
          <section key={group.heading}>
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{group.heading}</h2>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map((item) => {
                const count = item.badge ? counts[item.badge] : undefined;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="group flex flex-col rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50/30 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/20"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 transition-colors group-hover:bg-indigo-100 group-hover:text-indigo-600 dark:bg-zinc-800 dark:text-zinc-300 dark:group-hover:bg-indigo-900/40 dark:group-hover:text-indigo-300">
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                          <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
                        </svg>
                      </span>
                      {item.badge && count != null && count > 0 && (
                        <span className={`rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums ${BADGE_CLS[item.badge]}`}>
                          {count > 99 ? "99+" : count}
                        </span>
                      )}
                    </div>
                    <h3 className="mt-2.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{item.label}</h3>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">{item.desc}</p>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
