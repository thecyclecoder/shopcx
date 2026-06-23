"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

// Control Tower (control-tower spec, Phase 1): the single "is the machine healthy?" screen.
// A green/amber/red tile per monitored loop — last ran, last produced, status, open alerts, and
// recent history. Polls GET /api/developer/control-tower every ~15s. Owner-only, read-only.

const REPO = "thecyclecoder/shopcx";
// approval-routing-engine Phase 4 (CEO ruling 2026-06-23): the Control Tower keeps its MONITORING
// panels, but its approval FEEDS are no longer a separate entry point — every proposal is DECIDED in
// the one routed Agents-hub inbox (in-context, reusing the same control-tower executors). These sections
// stay as read-only "what's waiting" monitoring and link into the inbox; the decide buttons moved there.
const APPROVAL_INBOX_HREF = "/dashboard/agents?view=inbox";

function DecideInInbox() {
  return (
    <Link
      href={APPROVAL_INBOX_HREF}
      className="inline-flex items-center rounded-md border border-indigo-300 px-2.5 py-1 text-[11px] font-medium text-indigo-700 hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
    >
      Decide in inbox →
    </Link>
  );
}

type LoopColor = "green" | "amber" | "red";
type OwnerFunction = "platform" | "growth" | "retention" | "cs" | "cmo";

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
  kind: "worker" | "cron" | "agent-kind" | "inline-agent" | "reactive";
  owner: OwnerFunction;
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
type ErrorSource = "vercel" | "inngest" | "supabase" | "supabase-logs" | "client";
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
interface RepairSurfaceItem {
  jobId: string;
  signature: string;
  title: string;
  diagnosis: string;
  specSlug: string | null;
  state: "proposed" | "needs-human";
  createdAt: string;
}
interface DbHealthProposalItem {
  jobId: string;
  signature: string;
  title: string;
  impact: string;
  cause: string;
  category: string;
  specSlug: string | null;
  specTitle: string | null;
  createdAt: string;
}
interface DbHealthPanel {
  topTables: { table: string; totalBytes: number; rowEstimate: number }[];
  slowQueries: { queryid: string; cause: string; table: string; impact: string }[];
  proposals: DbHealthProposalItem[];
  lastSizeSweepAt: string | null;
  lastSlowQueryAt: string | null;
}
interface UnregisteredLoop {
  id: string;
  cadence: string;
}
interface InngestRegistrationDiff {
  status: "ok" | "unverified";
  missing: string[];
}
interface CoverageAudit {
  unregistered: UnregisteredLoop[];
  inngestRegistration: InngestRegistrationDiff;
}
interface CoverageRegisterItem {
  jobId: string;
  loopId: string;
  cadence: string;
  proposedOwner: OwnerFunction;
  proposedCadence: string;
  registerSlug: string;
  createdAt: string;
}
interface DepartmentRollup {
  owner: OwnerFunction;
  label: string;
  healthLabel: string;
  color: LoopColor;
  total: number;
  healthy: number;
  counts: { green: number; amber: number; red: number };
  openAlerts: number;
}
interface Snapshot {
  generatedAt: string;
  counts: { green: number; amber: number; red: number };
  loops: LoopStatus[];
  departments?: DepartmentRollup[];
  selfAudit?: CoverageAudit;
  errorFeed?: ErrorFeedSnapshot;
  specDrift?: SpecDriftRow[];
  repairs?: RepairSurfaceItem[];
  dbHealth?: DbHealthPanel;
  coverageRegister?: CoverageRegisterItem[];
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
  reactive: "Reactive agents",
  "agent-kind": "Agent lanes",
  "inline-agent": "Inline AI agents",
};
// The kind sub-groups inside each department drill-in, in display order.
const KIND_ORDER: LoopStatus["kind"][] = ["worker", "cron", "reactive", "agent-kind", "inline-agent"];

const ROLLUP_TILE: Record<LoopColor, string> = {
  green: "border-emerald-300 bg-emerald-50 dark:border-emerald-800/60 dark:bg-emerald-900/20",
  amber: "border-amber-300 bg-amber-50 dark:border-amber-800/60 dark:bg-amber-900/20",
  red: "border-rose-300 bg-rose-50 dark:border-rose-800/60 dark:bg-rose-900/20",
};

// Phase 3: the CEO-glance rollup tile per org function — worst-of health across its loops, with
// a healthy/total count + open-alert count. The dashboard leads with these, then drills in.
function DepartmentRollupTile({ dept }: { dept: DepartmentRollup }) {
  return (
    <div className={`rounded-lg border p-3.5 ${ROLLUP_TILE[dept.color]}`}>
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT[dept.color]}`} />
        <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{dept.healthLabel}</h3>
      </div>
      <p className="mt-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        {dept.healthy}/{dept.total} <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">healthy</span>
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
        {dept.counts.red > 0 && (
          <span className="rounded-full bg-rose-100 px-1.5 py-0.5 font-medium text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
            {dept.counts.red} alerting
          </span>
        )}
        {dept.counts.amber > 0 && (
          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            {dept.counts.amber} warning
          </span>
        )}
        {dept.openAlerts > 0 && (
          <span className="rounded-full bg-rose-100 px-1.5 py-0.5 font-medium text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
            ⛔ {dept.openAlerts} open
          </span>
        )}
        {dept.color === "green" && <span className="text-emerald-700 dark:text-emerald-300">all healthy</span>}
      </div>
    </div>
  );
}

// Phase 3: one drill-in block per department — its loops, sub-grouped by kind, collapsible.
function DepartmentSection({ dept, loops }: { dept: DepartmentRollup; loops: LoopStatus[] }) {
  return (
    <details className="rounded-lg border border-zinc-200 dark:border-zinc-800" open={dept.color !== "green"}>
      <summary className="flex cursor-pointer items-center gap-2 px-3.5 py-2.5 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
        <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT[dept.color]}`} />
        {dept.label}
        <span className="text-[11px] font-normal text-zinc-400">
          {dept.healthy}/{dept.total} healthy
          {dept.counts.red > 0 ? ` · ${dept.counts.red} alerting` : ""}
          {dept.counts.amber > 0 ? ` · ${dept.counts.amber} warning` : ""}
        </span>
      </summary>
      <div className="space-y-4 px-3.5 pb-3.5">
        {KIND_ORDER.map((k) => {
          const kindLoops = loops.filter((l) => l.kind === k);
          if (!kindLoops.length) return null;
          return (
            <div key={k}>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{KIND_LABEL[k]}</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {kindLoops.map((l) => (
                  <LoopTile key={l.id} loop={l} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

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
  client: "Client errors",
};
const ERROR_SOURCE_HINT: Record<ErrorSource, string> = {
  vercel: "prod runtime errors / 500s via the log drain",
  inngest: "functions that failed after exhausting retries",
  supabase: "DB errors our code reported (reportDbError)",
  "supabase-logs": "Postgres/auth/API error logs via the Management API",
  client: "browser JS errors on the storefront + portal (PDP/customize/checkout/thank-you/portal)",
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

function CoverageAuditSection({ audit }: { audit: CoverageAudit }) {
  const { unregistered, inngestRegistration } = audit;
  const clean = unregistered.length === 0 && inngestRegistration.missing.length === 0;
  return (
    <div className="mt-8">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Coverage self-audit
      </h2>
      <p className="mb-3 text-[11px] text-zinc-400">
        The watchdog auditing its own coverage — every cron <code>createFunction</code> in the serve route diffed
        against the monitored-loop registry, plus the serve route diffed against what Inngest Cloud has actually
        registered. A cron in code with no tile is an <b>unregistered loop</b> (amber) — coverage gaps surface here
        automatically instead of waiting for someone to notice. Empty = full coverage.
      </p>

      {clean ? (
        <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-xs text-emerald-700 dark:border-zinc-800 dark:text-emerald-300">
          Full coverage — every cron in code has a monitored-loop tile
          {inngestRegistration.status === "ok" ? " and Inngest has them all registered." : "."}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {unregistered.map((u) => (
            <div key={u.id} className={`rounded-lg border p-3.5 ${TILE.amber}`}>
              <div className="flex items-center gap-2">
                <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT.amber}`} />
                <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100" title={u.id}>
                  Unregistered loop: {u.id}
                </h3>
              </div>
              <p className="mt-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200">
                In code but not in the registry — the coverage-register agent proposes the entry below for one-tap Build.
              </p>
              <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">cron: {u.cadence}</p>
            </div>
          ))}
          {inngestRegistration.missing.map((id) => (
            <div key={`inngest-${id}`} className={`rounded-lg border p-3.5 ${TILE.amber}`}>
              <div className="flex items-center gap-2">
                <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT.amber}`} />
                <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100" title={id}>
                  Not registered with Inngest: {id}
                </h3>
              </div>
              <p className="mt-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200">
                Served in code but Inngest Cloud has no record of it — a deploy may not have re-synced the app.
              </p>
            </div>
          ))}
        </div>
      )}

      {inngestRegistration.status === "unverified" && (
        <p className="mt-2 text-[10px] text-zinc-400">
          In-code↔Inngest-registered diff unverified (no Inngest signing key / API unreachable) — the never-fired
          cron check still covers the same gap from the heartbeat side.
        </p>
      )}
    </div>
  );
}

function CoverageRegisterSection({ items }: { items: CoverageRegisterItem[] }) {
  if (items.length === 0) return null; // only show when there's a proposal waiting (the clean state lives in the audit section).
  return (
    <div className="mt-8">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Coverage registration
        </h2>
        <DecideInInbox />
      </div>
      <p className="mb-3 text-[11px] text-zinc-400">
        The coverage-register agent turns each unregistered loop into a proposed <code>MONITORED_LOOPS</code> entry —
        it infers the cadence-derived window + an owner-function. Monitoring only: <b>Register</b> /{" "}
        <b>Intentionally-unmonitored</b> / <b>Dismiss</b> are decided in the routed inbox (it never silently edits
        the registry — the build is queued only on your tap).
      </p>
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item.jobId}
            className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] dark:border-amber-900/40 dark:bg-amber-900/15"
          >
            <div className="min-w-0">
              <span className="font-semibold text-zinc-800 dark:text-zinc-100">Unregistered loop: {item.loopId}</span>
              <span className="ml-1.5 rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800/70 dark:text-zinc-300">
                proposed entry
              </span>
              <p className="mt-1 text-zinc-600 dark:text-zinc-300">
                Inferred: owner <b>{item.proposedOwner}</b> · {item.proposedCadence}
              </p>
              <p className="mt-0.5 text-[10px] text-zinc-400">
                <code>{item.cadence}</code> · build <code>{item.registerSlug}</code> · surfaced {elapsed(item.createdAt)} ago
              </p>
            </div>
          </li>
        ))}
      </ul>
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

function RepairFeedSection({ items }: { items: RepairSurfaceItem[] }) {
  return (
    <div className="mt-8">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Repair feed</h2>
        {items.length > 0 && <DecideInInbox />}
      </div>
      <p className="mb-3 text-[11px] text-zinc-400">
        The Repair Agent triages each new error/alert read-only and proposes a fix — <b>error → proposed fix</b>.
        Monitoring only: the one-tap <b>Build</b> (it never auto-builds product code) / <b>Dismiss</b> decision is
        made in the routed inbox. <b>Needs human</b> items couldn&apos;t be confidently diagnosed — no spec, no loop.
        Empty = nothing waiting on you.
      </p>
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-xs text-emerald-700 dark:border-zinc-800 dark:text-emerald-300">
          No repair items waiting — every triaged error was auto-resolved, auto-queued, or already actioned.
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.jobId}
              className={`rounded-lg border p-3 text-[12px] ${
                item.state === "needs-human"
                  ? "border-rose-200 bg-rose-50 dark:border-rose-900/40 dark:bg-rose-900/15"
                  : "border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/15"
              }`}
            >
              <div className="min-w-0">
                <span className="font-semibold text-zinc-800 dark:text-zinc-100">{item.title}</span>
                <span className="ml-1.5 rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800/70 dark:text-zinc-300">
                  {item.state === "needs-human" ? "needs human" : "proposed fix"}
                </span>
                {item.specSlug && (
                  <Link
                    href={`/dashboard/roadmap/${item.specSlug}`}
                    className="ml-1.5 font-mono text-[11px] text-zinc-600 hover:underline dark:text-zinc-300"
                  >
                    [[{item.specSlug}]]
                  </Link>
                )}
                {item.diagnosis && <p className="mt-1 whitespace-pre-wrap text-zinc-600 dark:text-zinc-300">{item.diagnosis}</p>}
                <p className="mt-0.5 text-[10px] text-zinc-400">
                  <code>{item.signature}</code> · surfaced {elapsed(item.createdAt)} ago
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function dbHumanBytes(n: number): string {
  if (!n || n < 1024) return `${n || 0} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function DbHealthSection({ panel }: { panel: DbHealthPanel }) {
  return (
    <div className="mt-8">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">DB Health</h2>
        {panel.proposals.length > 0 && <DecideInInbox />}
      </div>
      <p className="mb-3 text-[11px] text-zinc-400">
        The DB Health Agent watches Postgres read-only — top tables by size/growth, the slowest queries
        (root-caused via <code>EXPLAIN</code>), missing/unused indexes, and bloat — and <b>proposes</b> fix specs.
        Monitoring only: the one-tap <b>Build</b> / <b>Dismiss</b> decision is made in the routed inbox (it never
        applies DDL or deletes on its own). Last size sweep {elapsed(panel.lastSizeSweepAt)} ago ·
        last slow-query pass {elapsed(panel.lastSlowQueryAt)} ago.
      </p>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <h3 className="mb-1.5 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">Top tables by size</h3>
          {panel.topTables.length === 0 ? (
            <p className="text-[11px] text-zinc-400">No snapshot yet — the daily size sweep hasn&apos;t run.</p>
          ) : (
            <ul className="space-y-0.5 text-[11px]">
              {panel.topTables.slice(0, 8).map((t) => (
                <li key={t.table} className="flex justify-between gap-2">
                  <code className="truncate text-zinc-600 dark:text-zinc-300">{t.table}</code>
                  <span className="shrink-0 text-zinc-400">
                    {dbHumanBytes(t.totalBytes)} · {t.rowEstimate.toLocaleString()} rows
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <h3 className="mb-1.5 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">Slowest queries (diagnosed)</h3>
          {panel.slowQueries.length === 0 ? (
            <p className="text-[11px] text-zinc-400">No slow queries over threshold on the last pass.</p>
          ) : (
            <ul className="space-y-0.5 text-[11px]">
              {panel.slowQueries.slice(0, 8).map((q) => (
                <li key={q.queryid} className="flex justify-between gap-2">
                  <span className="truncate text-zinc-600 dark:text-zinc-300">
                    <span className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{q.cause}</span>{" "}
                    {q.table}
                  </span>
                  <span className="shrink-0 text-zinc-400">{q.impact}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <h3 className="mb-1.5 mt-4 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">Proposed fixes</h3>
      {panel.proposals.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-xs text-emerald-700 dark:border-zinc-800 dark:text-emerald-300">
          No proposed fixes waiting — nothing over threshold, or every finding was already actioned.
        </p>
      ) : (
        <ul className="space-y-2">
          {panel.proposals.map((item) => (
            <li
              key={item.jobId}
              className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] dark:border-amber-900/40 dark:bg-amber-900/15"
            >
              <div className="min-w-0">
                <span className="font-semibold text-zinc-800 dark:text-zinc-100">{item.title}</span>
                <span className="ml-1.5 rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800/70 dark:text-zinc-300">
                  {item.cause}
                </span>
                {item.impact && <p className="mt-1 text-zinc-600 dark:text-zinc-300">{item.impact}</p>}
                <p className="mt-0.5 text-[10px] text-zinc-400">
                  <code>{item.signature}</code> · surfaced {elapsed(item.createdAt)} ago
                </p>
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

  const departments = snap?.departments ?? [];

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

          {/* Phase 3: department rollups (CEO glance) lead — one health tile per org function. */}
          {departments.length > 0 && (
            <div className="mb-6">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Department health
              </h2>
              <p className="mb-3 text-[11px] text-zinc-400">
                Each org function&apos;s loops rolled up worst-of (a single red loop turns its department amber/red).
                The CEO glance — which function is healthy? — then expand a department below to drill into its loops.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                {departments.map((d) => (
                  <DepartmentRollupTile key={d.owner} dept={d} />
                ))}
              </div>
            </div>
          )}

          {/* Drill-in: per-department loop cards, sub-grouped by kind. */}
          <div className="space-y-3">
            {departments.map((d) => (
              <DepartmentSection key={d.owner} dept={d} loops={snap.loops.filter((l) => l.owner === d.owner)} />
            ))}
          </div>

          {snap.errorFeed && (
            <div className="mt-8">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Errors
              </h2>
              <p className="mb-3 text-[11px] text-zinc-400">
                The hidden surfaces — Vercel runtime errors, Inngest failed runs, app-layer Supabase errors,
                DB-level Supabase logs (Postgres/auth/API) via the Management API, and client-side JS errors on the
                storefront + portal (the fourth feed our server logs can&apos;t see) — grouped by signature. A new
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

          {snap.selfAudit && <CoverageAuditSection audit={snap.selfAudit} />}

          <CoverageRegisterSection items={snap.coverageRegister ?? []} />

          <RepairFeedSection items={snap.repairs ?? []} />

          {snap.dbHealth && <DbHealthSection panel={snap.dbHealth} />}

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
