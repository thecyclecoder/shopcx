"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import type { SecurityReviewLogItem, SecurityReviewVerdict } from "@/lib/security-agent";

// Security tests (developer/security-tests) — Vault's security-review log. She reviews every merged
// spec build (read-only) and classifies it; this page logs every review she's run, clean ones
// included. Findings (real-vuln / needs-human) get the alert treatment; the routed fix is decided on
// the Approvals page. Mobile-friendly cards, newest-first. Backed by GET /api/developer/security-tests.
// See docs/brain/dashboard/security-tests.md.

function elapsed(iso: string): string {
  if (!iso) return "";
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

const VERDICT: Record<SecurityReviewVerdict, { label: string; cls: string; dot: string }> = {
  clean: {
    label: "Clean",
    cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  "false-positive": {
    label: "False positive",
    cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
    dot: "bg-zinc-400",
  },
  "real-vuln": {
    label: "Real vuln",
    cls: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
    dot: "bg-rose-500",
  },
  "needs-human": {
    label: "Needs human",
    cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  running: {
    label: "Running",
    cls: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
    dot: "bg-indigo-500",
  },
  failed: {
    label: "Failed",
    cls: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
    dot: "bg-rose-500",
  },
};

const ATTENTION: ReadonlySet<SecurityReviewVerdict> = new Set(["real-vuln", "needs-human"]);
type Filter = "all" | "attention" | "clean";

function ReviewCard({ item }: { item: SecurityReviewLogItem }) {
  const [expanded, setExpanded] = useState(false);
  const v = VERDICT[item.verdict];
  const needsAttention = ATTENTION.has(item.verdict);
  // Strip the leading "verdict:" prefix from the finding — it's already shown as the badge.
  const finding = item.finding.replace(/^\s*[a-z-]+\s*:\s*/i, "").trim();
  const long = finding.length > 240;

  return (
    <li
      className={`rounded-xl border p-3.5 shadow-sm sm:p-4 ${
        needsAttention
          ? "border-rose-200 bg-rose-50/40 dark:border-rose-900/50 dark:bg-rose-950/15"
          : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      }`}
    >
      {/* Header: verdict · mode · pr · time */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${v.cls}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${v.dot}`} />
          {v.label}
        </span>
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          {item.mode === "dep-watch" ? "Dependency scan" : "Diff review"}
        </span>
        {item.prNumber != null && (
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            PR #{item.prNumber}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-zinc-400">{elapsed(item.createdAt)}</span>
      </div>

      {/* What was reviewed */}
      <h3 className="mt-2 text-sm font-semibold leading-snug text-zinc-900 dark:text-zinc-100">
        {item.specTitle || item.specSlug || "Security review"}
      </h3>
      {item.specTitle && item.specSlug && (
        <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-400">{item.specSlug}</p>
      )}

      {/* Finding */}
      {finding && (
        <div className="mt-2">
          <p
            className={`whitespace-pre-wrap break-words text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-300 ${
              !expanded && long ? "line-clamp-3" : ""
            }`}
          >
            {finding}
          </p>
          {long && (
            <button
              onClick={() => setExpanded((x) => !x)}
              className="mt-0.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}

      {/* Routed real-vuln → the authored fix spec (decision lives on the Approvals page) */}
      {item.fixSlug && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-rose-200 bg-white px-2.5 py-1.5 text-[12px] dark:border-rose-900/40 dark:bg-zinc-950/40">
          <span className="font-medium text-rose-700 dark:text-rose-300">Fix authored</span>
          <Link href={`/dashboard/roadmap/${item.fixSlug}`} className="truncate font-mono text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
            {item.fixSlug}
          </Link>
          <Link href="/dashboard/developer/approvals" className="ml-auto shrink-0 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
            decide in Approvals →
          </Link>
        </div>
      )}
    </li>
  );
}

export default function SecurityTestsPage() {
  const workspace = useWorkspace();
  const [items, setItems] = useState<SecurityReviewLogItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");

  const load = useCallback(async (quiet?: boolean) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch("/api/developer/security-tests");
      if (!res.ok) throw new Error(String(res.status));
      const d: { items: SecurityReviewLogItem[] } = await res.json();
      setItems(d.items);
      setErr(false);
    } catch {
      setErr(true);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (workspace.role !== "owner") return;
    load();
    const t = setInterval(() => load(true), 20000);
    return () => clearInterval(t);
  }, [workspace.role, load]);

  const stats = useMemo(() => {
    const all = items ?? [];
    return {
      total: all.length,
      clean: all.filter((i) => i.verdict === "clean" || i.verdict === "false-positive").length,
      attention: all.filter((i) => ATTENTION.has(i.verdict)).length,
    };
  }, [items]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? []).filter((i) => {
      if (filter === "attention" && !ATTENTION.has(i.verdict)) return false;
      if (filter === "clean" && i.verdict !== "clean" && i.verdict !== "false-positive") return false;
      if (!needle) return true;
      return (
        (i.specTitle ?? "").toLowerCase().includes(needle) ||
        i.specSlug.toLowerCase().includes(needle) ||
        i.finding.toLowerCase().includes(needle)
      );
    });
  }, [items, filter, q]);

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Security tests</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  const FILTERS: { id: Filter; label: string; badge?: number }[] = [
    { id: "all", label: "All reviews", badge: stats.total || undefined },
    { id: "attention", label: "Needs attention", badge: stats.attention || undefined },
    { id: "clean", label: "Clean" },
  ];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Security tests</h1>
          <p className="mt-1 max-w-xl text-sm text-zinc-500 dark:text-zinc-400">
            Vault reviews every merged spec build for injection, secret-leak, and authz holes — read-only, then she
            escalates. Every review is logged here; clean passes included.
          </p>
        </div>
        {stats.attention > 0 && (
          <span className="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
            {stats.attention} need{stats.attention === 1 ? "s" : ""} attention
          </span>
        )}
      </div>

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-800">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                filter === f.id
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
            >
              {f.label}
              {f.badge != null && (
                <span className="rounded-full bg-zinc-100 px-1.5 text-[10px] font-semibold tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
                  {f.badge}
                </span>
              )}
            </button>
          ))}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter…"
          className="ml-auto w-40 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-sm text-zinc-700 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
        />
        <button
          onClick={() => load()}
          className="rounded-md border border-zinc-300 px-2.5 py-1 text-[12px] font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>

      {/* Feed */}
      <div className="mt-4">
        {loading && !items ? (
          <div className="py-16 text-center text-sm text-zinc-400">Loading security tests…</div>
        ) : err && !items ? (
          <div className="rounded-xl border border-dashed border-zinc-200 py-16 text-center text-sm text-zinc-400 dark:border-zinc-800">
            Couldn&apos;t load security tests.
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 px-4 py-14 text-center dark:border-zinc-800">
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
              {filter === "attention" ? "No open security findings." : "No security reviews yet."}
            </p>
            <p className="mx-auto mt-1 max-w-sm text-[12px] text-zinc-400">
              Vault reviews every merged spec build — her verdicts (clean · false positive · real vuln · needs human)
              land here.
            </p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {visible.map((i) => (
              <ReviewCard key={i.jobId} item={i} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
