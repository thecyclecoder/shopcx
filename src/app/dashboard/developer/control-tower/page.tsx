"use client";

import { useCallback, useEffect, useState } from "react";
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
  kind: "worker" | "cron" | "agent-kind" | "inline-agent";
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
type ErrorSource = "vercel" | "inngest" | "supabase" | "supabase-logs";
interface ErrorIncident {
  id: string;
  source: ErrorSource;
  signature: string;
  title: string;
  detail: string | null;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
}
type PanelConnectionState = "not-configured" | "awaiting" | "connected" | "errors";
interface ErrorFeedPanel {
  source: ErrorSource;
  color: LoopColor;
  incidents: ErrorIncident[];
  activeSignatures: number;
  totalOccurrences: number;
  configured: boolean;
  lastReceivedAt: string | null;
  connectionState: PanelConnectionState;
  statusText: string;
  hint: string | null;
}
interface ErrorFeedSnapshot {
  generatedAt: string;
  panels: ErrorFeedPanel[];
}
interface SpecDriftRow {
  id: string;
  spec_slug: string;
  phase_index: number;
  phase_title: string;
  current_emoji: string;
  detail: string;
  opened_at: string;
  last_seen_at: string;
}
interface Snapshot {
  generatedAt: string;
  counts: { green: number; amber: number; red: number };
  loops: LoopStatus[];
  errorFeed?: ErrorFeedSnapshot;
  specDrift?: SpecDriftRow[];
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
  "inline-agent": "Inline AI agents",
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

const ERROR_SOURCE_LABEL: Record<ErrorSource, string> = {
  vercel: "Vercel errors",
  inngest: "Inngest failures",
  supabase: "Supabase errors (app-layer)",
  "supabase-logs": "Supabase errors (DB logs)",
};
const ERROR_SOURCE_HINT: Record<ErrorSource, string> = {
  vercel: "prod runtime errors / 500s via the log drain",
  inngest: "functions that failed after exhausting retries",
  supabase: "DB errors our code reported (reportDbError)",
  "supabase-logs": "Postgres/auth/API error logs via the Management API",
};

function ErrorPanel({ panel }: { panel: ErrorFeedPanel }) {
  return (
    <div className={`rounded-lg border p-3.5 ${TILE[panel.color]}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT[panel.color]}`} />
            <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {ERROR_SOURCE_LABEL[panel.source]}
            </h3>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
            {ERROR_SOURCE_HINT[panel.source]}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800/70 dark:text-zinc-400">
          {panel.activeSignatures} active · {panel.totalOccurrences} total
        </span>
      </div>

      {panel.incidents.length === 0 ? (
        <div className="mt-2">
          <p
            className={`text-xs font-medium ${
              panel.color === "green"
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-amber-700 dark:text-amber-300"
            }`}
          >
            {panel.statusText}
          </p>
          {panel.hint && <p className="mt-1 text-[10px] text-zinc-400">{panel.hint}</p>}
        </div>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {panel.incidents.map((inc) => (
            <li
              key={inc.id}
              className="rounded-md border border-zinc-200/70 bg-white/60 px-2 py-1.5 text-[11px] dark:border-zinc-800/70 dark:bg-zinc-900/30"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="truncate font-medium text-zinc-700 dark:text-zinc-200" title={inc.title}>
                  {inc.title}
                </span>
                <span className="shrink-0 rounded-full bg-rose-100 px-1.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
                  ×{inc.count}
                </span>
              </div>
              <p className="mt-0.5 text-[10px] text-zinc-400">last seen {elapsed(inc.last_seen_at)} ago</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SpecDriftSection({ rows, onChange }: { rows: SpecDriftRow[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (row: SpecDriftRow, action: "flip" | "dismiss") => {
    setBusy(`${row.id}:${action}`);
    try {
      const res = await fetch("/api/roadmap/spec-drift", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: row.spec_slug, phaseIndex: row.phase_index, action }),
      });
      if (res.ok) onChange();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-8">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Spec drift</h2>
      <p className="mb-3 text-[11px] text-zinc-400">
        Phases whose code is verifiably on <code>main</code> but whose emoji is still ⏳/🚧 with no merged build
        on record — the reconciler won&apos;t auto-flip these, so confirm with one tap. <b>Mark P&shy;n ✅</b> flips
        the phase in the spec markdown (committed to main); <b>Dismiss</b> leaves it and clears the notice. Empty =
        no unresolved drift.
      </p>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-xs text-emerald-700 dark:border-zinc-800 dark:text-emerald-300">
          No spec drift — every shipped phase is marked ✅.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] dark:border-amber-900/40 dark:bg-amber-900/15"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link
                    href={`/dashboard/roadmap/${row.spec_slug}`}
                    className="font-semibold text-zinc-800 hover:underline dark:text-zinc-100"
                  >
                    {row.spec_slug}
                  </Link>
                  <span className="ml-1.5 rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800/70 dark:text-zinc-300">
                    P{row.phase_index + 1} {row.current_emoji}
                  </span>
                  <p className="mt-1 text-zinc-600 dark:text-zinc-300">{row.detail}</p>
                  <p className="mt-0.5 text-[10px] text-zinc-400">surfaced {elapsed(row.opened_at)} ago</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => act(row, "flip")}
                    disabled={busy !== null}
                    className="rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {busy === `${row.id}:flip` ? "Flipping…" : `Mark P${row.phase_index + 1} ✅`}
                  </button>
                  <button
                    onClick={() => act(row, "dismiss")}
                    disabled={busy !== null}
                    className="rounded-md border border-zinc-300 px-2.5 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    {busy === `${row.id}:dismiss` ? "…" : "Dismiss"}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ControlTowerPage() {
  const workspace = useWorkspace();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);

  const refresh = useCallback(
    () =>
      fetch("/api/developer/control-tower")
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d) => {
          setSnap(d);
          setErr(false);
        })
        .catch(() => setErr(true))
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Control Tower</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  const groups: LoopStatus["kind"][] = ["worker", "cron", "agent-kind", "inline-agent"];

  return (
    <div className="mx-auto w-full max-w-screen-xl p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Control Tower</h1>
        <Link href="/dashboard/roadmap/box" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
          Build box →
        </Link>
      </div>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        Every autonomous loop, watching itself — worker liveness, cron freshness, stuck jobs, inline-agent
        liveness-when-work-exists + error-rate, and output assertions (idle-while-work + false-success). A red tile
        pages the owners on Slack; a healthy or genuinely-idle loop is green. Polls every ~15s.
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

          {snap.errorFeed && (
            <div className="mt-8">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Errors
              </h2>
              <p className="mb-3 text-[11px] text-zinc-400">
                The hidden surfaces — Vercel runtime errors, Inngest failed runs, app-layer Supabase errors, and
                DB-level Supabase logs (Postgres/auth/API) via the Management API — grouped by signature. A new
                signature or a re-firing spike pages the owners (rate-limited: a burst of the same error = one
                page). Green = configured + receiving + 0 errors; amber = not configured / awaiting first event
                (we&apos;re not yet watching) — never a misleading green &ldquo;0 errors&rdquo; while disconnected.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {snap.errorFeed.panels.map((p) => (
                  <ErrorPanel key={p.source} panel={p} />
                ))}
              </div>
            </div>
          )}

          <SpecDriftSection rows={snap.specDrift ?? []} onChange={refresh} />

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
