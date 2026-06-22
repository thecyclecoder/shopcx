"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

// Live build-box view (build-box-status-view): box health + SHA, lane grid (what each lane is building
// right now), queue depth, and a paused callout. Polls /api/roadmap/box every ~5s — phone-friendly,
// read-only (pausing/killing lanes is the CLI's job, see docs/brain/recipes/manage-the-build-queue).

const REPO = "thecyclecoder/shopcx";
const STALE_MS = 30_000; // a heartbeat older than this ⇒ box stale/down (worker ticks ~5s)

interface LaneRow {
  kind: string;
  job_id: string;
  spec_slug: string;
  since: string;
}
interface Worker {
  running_sha: string | null;
  status: string;
  active_builds: number;
  detail: string | null;
  last_poll_at: string | null;
  started_at: string | null;
  build_lanes: number;
  fold_lanes: number;
  lanes: LaneRow[];
}
interface Job {
  id: string;
  spec_slug: string;
  kind: string;
  status: string;
  pr_url: string | null;
  pr_number: number | null;
  created_at: string;
  spec_missing?: boolean; // fold-guard-live-build: the spec page would 404 (folded/archived/deleted)
}
interface FailedJob {
  id: string;
  spec_slug: string;
  kind: string;
  error: string | null;
  detail: string | null;
  updated_at: string;
  spec_missing?: boolean; // fold-guard-live-build: the spec page would 404 (folded/archived/deleted)
}

// Route a paused/failed job to where you actually approve/act on it. A spec page (/dashboard/roadmap/{slug})
// only exists for build-kind jobs whose slug is a real spec — so repair (slug = error signature), plan
// (slug = goal slug), and migration-fix (slug = fix id) all 404'd there. Send each to its real surface.
// fold-guard-live-build (Phase 1): a build/spec-test job whose spec was folded/archived/deleted (spec_missing)
// would 404 at /dashboard/roadmap/{slug} too — route it to the board (always resolves), never a dead link.
function approvalHref(kind: string, specSlug: string, specMissing?: boolean): string {
  if (kind === "repair" || kind === "triage-escalations") return "/dashboard/developer/control-tower";
  if (kind === "plan") return `/dashboard/roadmap/goals/${specSlug}`;
  if (kind === "migration-fix") return "/dashboard/migrations";
  if (specMissing) return "/dashboard/roadmap";
  return `/dashboard/roadmap/${specSlug}`;
}

function workerStale(w: Worker): boolean {
  if (!w.last_poll_at) return true;
  return Date.now() - new Date(w.last_poll_at).getTime() > STALE_MS;
}

// Compact elapsed ("Ns/Nm/Nh/Nd") from an ISO timestamp to now.
function elapsed(iso: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

const KIND_CHIP: Record<string, string> = {
  build: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  plan: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
  fold: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300",
};

function LaneCell({ lane }: { lane: LaneRow | null }) {
  if (!lane) {
    return (
      <div className="flex min-h-[64px] flex-col items-center justify-center rounded-lg border border-dashed border-zinc-200 text-xs text-zinc-400 dark:border-zinc-800">
        open
      </div>
    );
  }
  return (
    <div className="flex min-h-[64px] flex-col gap-1.5 rounded-lg border border-zinc-200 bg-white p-2.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between gap-2">
        <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${KIND_CHIP[lane.kind] || KIND_CHIP.build}`}>
          {lane.kind}
        </span>
        <span className="text-[11px] tabular-nums text-zinc-400">{elapsed(lane.since)}</span>
      </div>
      <Link
        href={`/dashboard/roadmap/${lane.spec_slug}`}
        className="truncate text-xs font-medium text-zinc-700 hover:text-indigo-600 dark:text-zinc-200 dark:hover:text-indigo-400"
        title={lane.spec_slug}
      >
        {lane.spec_slug}
      </Link>
    </div>
  );
}

function LaneRowGrid({ label, total, lanes }: { label: string; total: number; lanes: LaneRow[] }) {
  // Fill the first cells with in-use lanes, the rest render "open".
  const cells: (LaneRow | null)[] = Array.from({ length: total }, (_, i) => lanes[i] ?? null);
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</h3>
        <span className="text-xs tabular-nums text-zinc-400">
          {lanes.length}/{total} in use
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
        {cells.map((c, i) => (
          <LaneCell key={c?.job_id ?? `open-${i}`} lane={c} />
        ))}
      </div>
    </div>
  );
}

export default function BoxPage() {
  const workspace = useWorkspace();
  const [worker, setWorker] = useState<Worker | null>(null);
  const [queue, setQueue] = useState<Job[]>([]);
  const [paused, setPaused] = useState<Job[]>([]);
  const [failed, setFailed] = useState<FailedJob[]>([]);
  const [retrying, setRetrying] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/roadmap/box")
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          setWorker(d.worker ?? null);
          setQueue(d.queue ?? []);
          setPaused(d.paused ?? []);
          setFailed(d.failed ?? []);
        })
        .catch(() => {})
        .finally(() => alive && setLoading(false));
    load();
    const interval = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

  const retry = async (slug: string) => {
    setRetrying((r) => ({ ...r, [slug]: true }));
    try {
      const res = await fetch("/api/roadmap/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      if (res.ok) setFailed((f) => f.filter((j) => j.spec_slug !== slug)); // optimistic — it's re-queued now
    } catch {
      /* leave it; the next poll reflects real state */
    } finally {
      setRetrying((r) => ({ ...r, [slug]: false }));
    }
  };

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Build box</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  const stale = worker ? workerStale(worker) : true;
  const buildLanes = (worker?.lanes ?? []).filter((l) => l.kind !== "fold");
  const foldLanes = (worker?.lanes ?? []).filter((l) => l.kind === "fold");

  return (
    <div className="mx-auto w-full max-w-screen-xl p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Build box</h1>
        <Link href="/dashboard/roadmap" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
          ← Roadmap
        </Link>
      </div>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        Live view of the self-hosted build worker — health, lanes, and what each lane is building right now. Read-only;
        pausing or killing lanes is a CLI job. Polls every ~5s.
      </p>

      {loading && !worker ? (
        <div className="py-12 text-center text-sm text-zinc-400">Loading…</div>
      ) : !worker ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          No heartbeat yet — the box hasn&apos;t reported in.
        </div>
      ) : (
        <>
          {/* Health header */}
          <div
            className={`mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-3 text-sm ${
              stale
                ? "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/40 dark:bg-rose-900/20 dark:text-rose-300"
                : "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-900/20 dark:text-emerald-300"
            }`}
          >
            <span className="font-semibold">{stale ? "⚠ stale" : "● healthy"}</span>
            <span>·</span>
            <span>
              SHA{" "}
              {worker.running_sha ? (
                <a
                  href={`https://github.com/${REPO}/commit/${worker.running_sha}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono underline decoration-dotted underline-offset-2"
                >
                  {worker.running_sha}
                </a>
              ) : (
                <code className="font-mono">?</code>
              )}
            </span>
            <span>·</span>
            <span>uptime {worker.started_at ? elapsed(worker.started_at) : "?"}</span>
            <span>·</span>
            <span>last poll {worker.last_poll_at ? `${elapsed(worker.last_poll_at)} ago` : "never"}</span>
            {worker.status !== "healthy" && <span className="opacity-80">· {worker.status}</span>}
            {worker.detail && <span className="opacity-80">· {worker.detail}</span>}
          </div>

          {/* Lane grid */}
          <div className="space-y-5">
            <LaneRowGrid label="Build / plan lanes" total={worker.build_lanes} lanes={buildLanes} />
            <LaneRowGrid label="Fold lane" total={worker.fold_lanes} lanes={foldLanes} />
          </div>

          {/* Queue depth */}
          <div className="mt-5 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
            <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium tabular-nums dark:bg-zinc-800">
              {queue.length}
            </span>
            <span className="text-zinc-500 dark:text-zinc-400">
              job{queue.length === 1 ? "" : "s"} waiting in the queue
            </span>
          </div>

          {/* Failed builds — surface the failure + the real reason (529 / Max / tsc) + a one-tap retry */}
          {failed.length > 0 && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm dark:border-red-900/40 dark:bg-red-900/20">
              <p className="mb-2 font-medium text-red-800 dark:text-red-300">
                {failed.length} build{failed.length === 1 ? "" : "s"} failed
              </p>
              <ul className="space-y-2.5">
                {failed.map((j) => (
                  <li key={j.id} className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={approvalHref(j.kind, j.spec_slug, j.spec_missing)}
                        className="font-medium text-red-800 underline decoration-dotted underline-offset-2 hover:text-red-900 dark:text-red-300 dark:hover:text-red-200"
                      >
                        {j.spec_slug}
                      </Link>
                      {j.spec_missing && <span className="text-[10px] text-red-600/70 dark:text-red-400/70">(spec archived)</span>}
                      <span className="text-xs text-red-600/80 dark:text-red-400/80">{j.error ?? "failed"} · {elapsed(j.updated_at)} ago</span>
                      <button
                        onClick={() => retry(j.spec_slug)}
                        disabled={retrying[j.spec_slug]}
                        className="ml-auto inline-flex items-center rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        {retrying[j.spec_slug] ? "Retrying…" : "↻ Retry build"}
                      </button>
                    </div>
                    {j.detail && (
                      <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded border border-red-200 bg-white/70 px-2 py-1 text-[11px] leading-snug text-red-900/90 dark:border-red-900/40 dark:bg-black/30 dark:text-red-200/90">
                        {j.detail}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Paused callout */}
          {paused.length > 0 && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900/40 dark:bg-amber-900/20">
              <p className="mb-2 font-medium text-amber-800 dark:text-amber-300">
                {paused.length} build{paused.length === 1 ? "" : "s"} paused — awaiting owner action
              </p>
              <ul className="space-y-1.5">
                {paused.map((j) => (
                  <li key={j.id} className="flex flex-wrap items-center gap-2 text-amber-700 dark:text-amber-300">
                    <span className="inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                      {j.status === "needs_approval" ? "needs approval" : "needs input"}
                    </span>
                    <span className="inline-flex items-center rounded-full bg-amber-200/60 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-800/40 dark:text-amber-200">
                      {j.kind}
                    </span>
                    <Link
                      href={approvalHref(j.kind, j.spec_slug, j.spec_missing)}
                      className="font-medium underline decoration-dotted underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200"
                    >
                      {j.spec_slug}
                    </Link>
                    {j.spec_missing && <span className="text-[10px] text-amber-700/70 dark:text-amber-300/70">(spec archived)</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
