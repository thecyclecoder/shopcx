"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

// Control Tower (control-tower spec, Phase 1): the single "is the machine healthy?" screen.
// A green/amber/red tile per monitored loop — last ran, last produced, status, open alerts, and
// recent history. Polls GET /api/developer/control-tower every ~15s. Owner-only, read-only.

const REPO = "thecyclecoder/shopcx";

type LoopColor = "green" | "amber" | "red";

interface HistoryRow {
  ran_at: string;
  ok: boolean;
  produced: unknown;
  detail: string | null;
  duration_ms: number | null;
}
interface OpenAlert {
  id: string;
  reason: string;
  detail: string;
  opened_at: string;
  last_seen_at: string;
}
interface LoopStatus {
  id: string;
  kind: "worker" | "cron" | "agent-kind";
  label: string;
  description: string;
  expectedCadence: string;
  color: LoopColor;
  statusText: string;
  lastRanAt: string | null;
  lastProduced: unknown;
  detail: string | null;
  history: HistoryRow[];
  openAlert: OpenAlert | null;
}
interface Snapshot {
  generatedAt: string;
  counts: { green: number; amber: number; red: number };
  loops: LoopStatus[];
}

function elapsed(iso: string | null | undefined): string {
  if (!iso) return "never";
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function compactProduced(p: unknown): string | null {
  if (p == null) return null;
  if (typeof p === "number" || typeof p === "string") return String(p);
  if (typeof p === "object") {
    const entries = Object.entries(p as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined);
    if (!entries.length) return null;
    return entries.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ");
  }
  return null;
}

const TILE: Record<LoopColor, string> = {
  green: "border-emerald-200 bg-emerald-50 dark:border-emerald-900/40 dark:bg-emerald-900/15",
  amber: "border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/15",
  red: "border-rose-200 bg-rose-50 dark:border-rose-900/40 dark:bg-rose-900/15",
};
const DOT: Record<LoopColor, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-rose-500",
};
const KIND_LABEL: Record<string, string> = {
  worker: "Worker",
  cron: "Crons",
  "agent-kind": "Agent lanes",
};

function HistoryStrip({ history }: { history: HistoryRow[] }) {
  if (!history.length) return null;
  // Oldest → newest left-to-right (history arrives newest-first).
  const cells = [...history].reverse();
  return (
    <div className="mt-2 flex items-center gap-1">
      {cells.map((h, i) => (
        <span
          key={i}
          title={`${h.ok ? "ok" : "not ok"} · ${new Date(h.ran_at).toLocaleString()}${h.detail ? ` · ${h.detail}` : ""}`}
          className={`h-3 w-2 rounded-sm ${h.ok ? "bg-emerald-400 dark:bg-emerald-500" : "bg-rose-400 dark:bg-rose-500"}`}
        />
      ))}
    </div>
  );
}

function LoopTile({ loop }: { loop: LoopStatus }) {
  const produced = compactProduced(loop.lastProduced);
  return (
    <div className={`rounded-lg border p-3.5 ${TILE[loop.color]}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT[loop.color]}`} />
            <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100" title={loop.id}>
              {loop.label}
            </h3>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400" title={loop.description}>
            {loop.description}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800/70 dark:text-zinc-400">
          {loop.expectedCadence}
        </span>
      </div>

      <p className="mt-2 text-xs font-medium text-zinc-700 dark:text-zinc-200">{loop.statusText}</p>

      <dl className="mt-1.5 space-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
        <div className="flex gap-1.5">
          <dt className="text-zinc-400">last ran</dt>
          <dd className="text-zinc-600 dark:text-zinc-300">{loop.lastRanAt ? `${elapsed(loop.lastRanAt)} ago` : "—"}</dd>
        </div>
        {produced && (
          <div className="flex gap-1.5">
            <dt className="text-zinc-400">produced</dt>
            <dd className="truncate text-zinc-600 dark:text-zinc-300" title={produced}>{produced}</dd>
          </div>
        )}
      </dl>

      {loop.openAlert && (
        <div className="mt-2 rounded-md border border-rose-300 bg-rose-100/70 px-2 py-1.5 text-[11px] text-rose-800 dark:border-rose-900/50 dark:bg-rose-900/30 dark:text-rose-200">
          <span className="font-semibold">⛔ open alert</span> · since {elapsed(loop.openAlert.opened_at)} ago
          <p className="mt-0.5 opacity-90">{loop.openAlert.detail}</p>
        </div>
      )}

      <HistoryStrip history={loop.history} />
    </div>
  );
}

export default function ControlTowerPage() {
  const workspace = useWorkspace();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/developer/control-tower")
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d) => {
          if (!alive) return;
          setSnap(d);
          setErr(false);
        })
        .catch(() => alive && setErr(true))
        .finally(() => alive && setLoading(false));
    load();
    const interval = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Control Tower</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  const groups: LoopStatus["kind"][] = ["worker", "cron", "agent-kind"];

  return (
    <div className="mx-auto w-full max-w-screen-xl p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Control Tower</h1>
        <Link href="/dashboard/roadmap/box" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
          Build box →
        </Link>
      </div>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        Every autonomous loop, watching itself — liveness, cron freshness, stuck jobs, and output assertions
        (idle-while-work + false-success). A red tile pages the owners on Slack; a healthy or genuinely-idle loop
        is green. Polls every ~15s.
      </p>

      {loading && !snap ? (
        <div className="py-12 text-center text-sm text-zinc-400">Loading…</div>
      ) : err && !snap ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          Couldn&apos;t load the Control Tower.
        </div>
      ) : snap ? (
        <>
          {/* Summary bar */}
          <div className="mb-5 flex flex-wrap items-center gap-3 text-sm">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
              <span className="h-2 w-2 rounded-full bg-emerald-500" /> {snap.counts.green} healthy
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
              <span className="h-2 w-2 rounded-full bg-amber-500" /> {snap.counts.amber} warning
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-100 px-2.5 py-1 font-medium text-rose-800 dark:bg-rose-900/30 dark:text-rose-300">
              <span className="h-2 w-2 rounded-full bg-rose-500" /> {snap.counts.red} alerting
            </span>
            <span className="text-xs text-zinc-400">updated {elapsed(snap.generatedAt)} ago</span>
          </div>

          <div className="space-y-6">
            {groups.map((g) => {
              const loops = snap.loops.filter((l) => l.kind === g);
              if (!loops.length) return null;
              return (
                <div key={g}>
                  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    {KIND_LABEL[g]}
                  </h2>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {loops.map((l) => (
                      <LoopTile key={l.id} loop={l} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="mt-6 text-[11px] text-zinc-400">
            SHA comparison uses the deployed commit ({" "}
            <a href={`https://github.com/${REPO}`} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted">
              {REPO}
            </a>
            ). Output assertions: escalation idle-while-work, spec-test false-success, and internal-renewal integrity.
          </p>
        </>
      ) : null}
    </div>
  );
}
