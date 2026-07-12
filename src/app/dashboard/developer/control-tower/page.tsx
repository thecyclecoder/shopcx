"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { routedInboxHref } from "@/lib/agents/inbox";
import { PersonaChip } from "@/components/agents/persona-chip";
import { getPersona } from "@/lib/agents/personas";
import { MONITORED_LOOPS } from "@/lib/control-tower/registry";

// Control Tower (control-tower spec, Phase 1): the single "is the machine healthy?" screen.
// A green/amber/red tile per monitored loop — last ran, last produced, status, open alerts, and
// recent history. Polls GET /api/developer/control-tower every ~15s. Owner-only, read-only.

const REPO = "thecyclecoder/shopcx";

type LoopColor = "green" | "amber" | "red";
type OwnerFunction = "platform" | "growth" | "retention" | "cs" | "cmo" | "ceo";

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
interface DirectorDismissedRepairItem {
  jobId: string;
  signature: string;
  title: string;
  reasoning: string;
  dismissedAt: string;
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
type ClaudeComponentStatus =
  | "operational"
  | "degraded_performance"
  | "partial_outage"
  | "major_outage"
  | "under_maintenance"
  | "unknown";
interface ClaudeHealth {
  apiStatus: ClaudeComponentStatus;
  codeStatus: ClaudeComponentStatus;
  externalDown: boolean;
  localDown: boolean;
  down: boolean;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastPolledAt: string | null;
  pollOk: boolean | null;
  trippedAt: string | null;
  recoveredAt: string | null;
  detail: string | null;
  updatedAt: string | null;
}
// L0 snapshot payload (no `loops` — those load lazily per department via `?level=1&owner=<fn>`).
// control-tower-switch-controls-three-tier Phase 1: the CEO-glance shape — counts + rollups +
// page-level auxiliary panels only. Per-department loops arrive from the L1 fetch.
interface Snapshot {
  generatedAt: string;
  counts: { green: number; amber: number; red: number };
  departments?: DepartmentRollup[];
  selfAudit?: CoverageAudit;
  errorFeed?: ErrorFeedSnapshot;
  specDrift?: SpecDriftRow[];
  repairs?: RepairSurfaceItem[];
  directorDismissed?: DirectorDismissedRepairItem[];
  dbHealth?: DbHealthPanel;
  coverageRegister?: CoverageRegisterItem[];
  claudeHealth?: ClaudeHealth;
}

interface LoopsPayload {
  generatedAt: string;
  loops: LoopStatus[];
}

// control-tower-infra-sub-page Phase 1 — the payload the per-department Infra tab consumes.
// Mirrors src/lib/control-tower/infra-tab.ts `InfraTabPayload`. Fetched lazily the FIRST time
// the CEO clicks the Infra tab inside a DepartmentSection drill-in (no request fires on the
// initial render — verified by the "no /api/developer/control-tower/infra call until Infra is
// clicked" bullet in the spec's ## Verification).
interface InfraTabIncident extends ErrorIncident {
  resolvedOwner: OwnerFunction | null;
}
interface InfraTabPayload {
  generatedAt: string;
  owner: OwnerFunction;
  errorFeed: {
    incidents: InfraTabIncident[];
    bySource: Record<ErrorSource, number>;
    totalOccurrences: number;
  };
  // Only surfaced under `platform` — DB is Devi's Nano lane.
  dbHealth: DbHealthPanel | null;
}

// Persona key for a single LoopStatus — mirrors src/lib/control-tower/node-registry.ts
// `personaForLoop`: the MonitoredLoop entry's `personaKind ?? agentKind`, falling back to the
// director slug so a loop with no explicit persona still renders under its department director's
// chip (never the neutral 🤖 default). Aliases (`deploy-review` → `deploy-guardian` etc.) are
// resolved inside `getPersona` via KIND_PERSONA_ALIAS in personas.ts.
function personaKeyForLoop(loopId: string, owner: OwnerFunction): string {
  const entry = MONITORED_LOOPS.find((l) => l.id === loopId);
  return entry?.personaKind ?? entry?.agentKind ?? owner;
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
// control-tower-switch-controls-three-tier Phase 1: an owner-persona chip surfaces WHO owns the
// department (the director) before showing whether they're healthy.
function DepartmentRollupTile({ dept }: { dept: DepartmentRollup }) {
  const persona = getPersona(dept.owner);
  return (
    <div className={`rounded-lg border p-3.5 ${ROLLUP_TILE[dept.color]}`}>
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT[dept.color]}`} />
        <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{dept.healthLabel}</h3>
      </div>
      <div className="mt-1.5">
        <PersonaChip persona={persona} />
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
// control-tower-switch-controls-three-tier Phase 1: lazy — the department's loops arrive from a
// second fetch (`?level=1&owner=<fn>`) fired the first time the section is opened. The header
// carries the director's persona chip (owner-first: WHO before whether-they're-healthy).
//
// control-tower-infra-sub-page Phase 1: adds a "Loops | Infra" tab-switcher inside the drill-in.
// Clicking Infra lazy-loads the ancestry-filtered error-feed + DB-health panel for this
// department via /api/developer/control-tower/infra?owner=<fn>. No infra request fires on the
// initial render — the fetch only kicks in when Infra is the active tab.
function DepartmentSection({
  dept,
  loops,
  onEnsureLoaded,
  loading,
  infra,
  onEnsureInfraLoaded,
  infraLoading,
}: {
  dept: DepartmentRollup;
  loops: LoopStatus[] | undefined;
  onEnsureLoaded: () => void;
  loading: boolean;
  infra: InfraTabPayload | undefined;
  onEnsureInfraLoaded: () => void;
  infraLoading: boolean;
}) {
  const persona = getPersona(dept.owner);
  // Default-open for a red/amber department; a green one stays collapsed until the CEO clicks.
  // Either way, a first open fires the L1 fetch — an open-by-default red dept auto-loads on mount.
  const initialOpen = dept.color !== "green";
  const firedRef = useRef(false);
  const [tab, setTab] = useState<"loops" | "infra">("loops");
  useEffect(() => {
    if (initialOpen && !firedRef.current) {
      firedRef.current = true;
      onEnsureLoaded();
    }
  }, [initialOpen, onEnsureLoaded]);
  const handleToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (e.currentTarget.open && !firedRef.current) {
      firedRef.current = true;
      onEnsureLoaded();
    }
  };
  return (
    <details
      className="rounded-lg border border-zinc-200 dark:border-zinc-800"
      open={initialOpen}
      onToggle={handleToggle}
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3.5 py-2.5 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
        <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT[dept.color]}`} />
        {dept.label}
        <PersonaChip persona={persona} />
        <span className="text-[11px] font-normal text-zinc-400">
          {dept.healthy}/{dept.total} healthy
          {dept.counts.red > 0 ? ` · ${dept.counts.red} alerting` : ""}
          {dept.counts.amber > 0 ? ` · ${dept.counts.amber} warning` : ""}
        </span>
      </summary>
      <div className="px-3.5 pb-3.5">
        <div className="mb-3 flex items-center gap-2 border-b border-zinc-200 dark:border-zinc-800">
          <button
            type="button"
            onClick={() => setTab("loops")}
            className={`-mb-px border-b-2 px-2 py-1.5 text-[11px] font-semibold ${
              tab === "loops"
                ? "border-zinc-800 text-zinc-800 dark:border-zinc-100 dark:text-zinc-100"
                : "border-transparent text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
            }`}
          >
            Loops
          </button>
          <button
            type="button"
            onClick={() => {
              setTab("infra");
              // Lazy — the fetch fires the FIRST time Infra becomes active.
              onEnsureInfraLoaded();
            }}
            className={`-mb-px border-b-2 px-2 py-1.5 text-[11px] font-semibold ${
              tab === "infra"
                ? "border-zinc-800 text-zinc-800 dark:border-zinc-100 dark:text-zinc-100"
                : "border-transparent text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
            }`}
          >
            Infra
          </button>
        </div>
        {tab === "loops" ? (
          <div className="space-y-4">
            {loops === undefined ? (
              <p className="px-1 py-2 text-[11px] text-zinc-400">{loading ? "Loading loops…" : "…"}</p>
            ) : (
              KIND_ORDER.map((k) => {
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
              })
            )}
          </div>
        ) : (
          <InfraTab owner={dept.owner} payload={infra} loading={infraLoading} />
        )}
      </div>
    </details>
  );
}

// control-tower-infra-sub-page Phase 1: the per-department Infra tab.
// Reuses the error-feed + db-health plumbing already surfaced globally, ancestry-filtered to
// this department via src/lib/control-tower/infra-tab.ts `buildInfraTabPayload`. The tab
// renders a flat list of ancestry-owned incidents grouped by source, then the DB-Health panel
// (surfaced only under `platform` — Devi's Nano lane).
function InfraTab({
  owner,
  payload,
  loading,
}: {
  owner: OwnerFunction;
  payload: InfraTabPayload | undefined;
  loading: boolean;
}) {
  if (payload === undefined) {
    return <p className="px-1 py-2 text-[11px] text-zinc-400">{loading ? "Loading infra…" : "…"}</p>;
  }
  const incidents = payload.errorFeed.incidents;
  const bySourceEntries = (Object.entries(payload.errorFeed.bySource) as [ErrorSource, number][])
    .filter(([, n]) => n > 0);
  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Error feed</h3>
          {bySourceEntries.length > 0 && (
            <span className="text-[11px] text-zinc-400">
              {payload.errorFeed.totalOccurrences} occurrence{payload.errorFeed.totalOccurrences === 1 ? "" : "s"} ·{" "}
              {bySourceEntries.map(([src, n], i) => (
                <span key={src}>
                  {i > 0 ? " · " : ""}
                  {n} {ERROR_SOURCE_LABEL[src]}
                </span>
              ))}
            </span>
          )}
        </div>
        {incidents.length === 0 ? (
          <p className="mt-1.5 rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-xs text-emerald-700 dark:border-zinc-800 dark:text-emerald-300">
            No error-feed rows resolve under {owner} in the last 7 days — clean.
          </p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {incidents.map((inc) => (
              <li
                key={inc.id}
                className="rounded-md border border-zinc-200/70 bg-white/60 px-2 py-1.5 text-[11px] dark:border-zinc-800/70 dark:bg-zinc-900/30"
                title={inc.detail ?? inc.title}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="truncate font-medium text-zinc-700 dark:text-zinc-200">
                    <span className="mr-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      {ERROR_SOURCE_LABEL[inc.source]}
                    </span>
                    {inc.title}
                  </span>
                  <span className="shrink-0 rounded-full bg-rose-100 px-1.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
                    ×{inc.count}
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] text-zinc-400">
                  last seen {elapsed(inc.last_seen_at)} ago
                  {inc.resolvedOwner === null && (
                    <span className="ml-1.5 italic text-zinc-400">
                      · surface not registered — defaulted to platform
                    </span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
      {payload.dbHealth && (
        <div>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">DB health</h3>
          <div className="rounded-md border border-zinc-200 bg-white/60 px-3 py-2 text-[11px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/30 dark:text-zinc-300">
            <p>
              {payload.dbHealth.proposals.length} open proposal{payload.dbHealth.proposals.length === 1 ? "" : "s"} ·{" "}
              {payload.dbHealth.slowQueries.length} slow quer{payload.dbHealth.slowQueries.length === 1 ? "y" : "ies"} ·{" "}
              {payload.dbHealth.topTables.length} top table{payload.dbHealth.topTables.length === 1 ? "" : "s"}
            </p>
            <p className="mt-0.5 text-[10px] text-zinc-400">
              Details in the Nano panel below — this tab surfaces the count for the drill-in view.
            </p>
          </div>
        </div>
      )}
    </div>
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
  // control-tower-switch-controls-three-tier Phase 1: per-loop owner-persona chip. Resolves the
  // MonitoredLoop entry's personaKind/agentKind (mirrors node-registry.ts personaForLoop), so a
  // repair-lane tile carries Rafa's chip, a db-health cron carries Devi's, etc. — and a loop with
  // no explicit persona falls back to the department director's chip via the owner slug.
  const persona = getPersona(personaKeyForLoop(loop.id, loop.owner));
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
          <div className="mt-1">
            <PersonaChip persona={persona} />
          </div>
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

function CoverageRegisterSection({ items, onChange }: { items: CoverageRegisterItem[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (item: CoverageRegisterItem, action: "register" | "exempt" | "dismiss") => {
    setBusy(`${item.jobId}:${action}`);
    try {
      const res = await fetch("/api/developer/control-tower/coverage-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: item.jobId, action }),
      });
      if (res.ok) onChange();
    } finally {
      setBusy(null);
    }
  };

  if (items.length === 0) return null; // only show when there's a proposal waiting (the clean state lives in the audit section).
  return (
    <div className="mt-8">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Coverage registration
      </h2>
      <p className="mb-3 text-[11px] text-zinc-400">
        The coverage-register agent turns each unregistered loop into a proposed <code>MONITORED_LOOPS</code> entry —
        it infers the cadence-derived window + an owner-function, then surfaces it for one-tap <b>Register</b> (lands
        the entry → the loop becomes a monitored tile). <b>Mark intentionally-unmonitored</b> exempts it (it stops
        re-surfacing); <b>Dismiss</b> defers. It never silently edits the registry — the build is queued only on your tap.
        This register/exempt choice is multi-way, so it&apos;s decided here; the Agents inbox surfaces the request and
        deep-links to this section.
      </p>
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item.jobId}
            className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] dark:border-amber-900/40 dark:bg-amber-900/15"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
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
              <div className="flex shrink-0 flex-wrap gap-2">
                <button
                  onClick={() => act(item, "register")}
                  disabled={busy !== null}
                  className="rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {busy === `${item.jobId}:register` ? "Queuing…" : "Register"}
                </button>
                <button
                  onClick={() => act(item, "exempt")}
                  disabled={busy !== null}
                  className="rounded-md border border-amber-300 px-2.5 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/30"
                >
                  {busy === `${item.jobId}:exempt` ? "…" : "Intentionally-unmonitored"}
                </button>
                <button
                  onClick={() => act(item, "dismiss")}
                  disabled={busy !== null}
                  className="rounded-md border border-zinc-300 px-2.5 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {busy === `${item.jobId}:dismiss` ? "…" : "Dismiss"}
                </button>
              </div>
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

function RepairFeedSection({ items, dismissed, onChange }: { items: RepairSurfaceItem[]; dismissed: DirectorDismissedRepairItem[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (item: RepairSurfaceItem, action: "build" | "dismiss") => {
    setBusy(`${item.jobId}:${action}`);
    try {
      const res = await fetch("/api/developer/control-tower/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: item.jobId, action }),
      });
      if (res.ok) onChange();
    } finally {
      setBusy(null);
    }
  };

  const reopen = async (item: DirectorDismissedRepairItem) => {
    setBusy(`${item.jobId}:reopen`);
    try {
      const res = await fetch("/api/developer/control-tower/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: item.jobId, action: "reopen" }),
      });
      if (res.ok) onChange();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-8">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Repair feed</h2>
      <p className="mb-3 text-[11px] text-zinc-400">
        The Repair Agent triages each new error/alert read-only and proposes a fix — <b>error → proposed fix</b>.
        Proposed fixes are now <b>approved in the Agents inbox</b> (the single routed approval queue) — this is a
        read-only view onto them. <b>Needs human</b> items couldn&apos;t be confidently diagnosed (no spec) and are
        cleared here. Empty = nothing waiting on you.
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
              <div className="flex flex-wrap items-start justify-between gap-2">
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
                <div className="flex shrink-0 items-center gap-2">
                  {item.state === "needs-human" ? (
                    // Needs-human (needs_attention) items aren't approvals (no proposed fix) → never enter the
                    // routed inbox; they're cleared here as a monitoring triage.
                    <button
                      onClick={() => act(item, "dismiss")}
                      disabled={busy !== null}
                      className="rounded-md border border-zinc-300 px-2.5 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      {busy === `${item.jobId}:dismiss` ? "…" : "Dismiss"}
                    </button>
                  ) : (
                    <Link
                      href={routedInboxHref()}
                      className="text-[11px] font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
                    >
                      Review in the Agents inbox →
                    </Link>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {dismissed.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-[11px] text-zinc-400">
            Cleared by the Platform/DevOps Director (Ada) — she adversarially re-checked Rafa&apos;s no-fix call and
            confirmed each benign. <b>Re-open</b> restores the warning and re-enqueues Rafa for a fresh triage.
          </p>
          <ul className="space-y-2">
            {dismissed.map((item) => (
              <li
                key={item.jobId}
                className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-[12px] dark:border-zinc-800 dark:bg-zinc-900/40"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-semibold text-zinc-700 dark:text-zinc-200">🛠️ Dismissed by Ada</span>
                    <span className="ml-1 text-zinc-600 dark:text-zinc-300">— {item.reasoning || item.title}</span>
                    <p className="mt-0.5 text-[10px] text-zinc-400">
                      <code>{item.signature}</code> · dismissed {elapsed(item.dismissedAt)} ago
                    </p>
                  </div>
                  <button
                    onClick={() => reopen(item)}
                    disabled={busy !== null}
                    className="shrink-0 rounded-md border border-zinc-300 px-2.5 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    {busy === `${item.jobId}:reopen` ? "…" : "Re-open"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
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

function DbHealthSection({ panel, onChange }: { panel: DbHealthPanel; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (item: DbHealthProposalItem, action: "build" | "dismiss") => {
    setBusy(`${item.jobId}:${action}`);
    try {
      const res = await fetch("/api/developer/control-tower/db-health", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: item.jobId, action }),
      });
      if (res.ok) onChange();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-8">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">DB Health</h2>
      <p className="mb-3 text-[11px] text-zinc-400">
        The DB Health Agent watches Postgres read-only — top tables by size/growth, the slowest queries
        (root-caused via <code>EXPLAIN</code>), missing/unused indexes, and bloat — and <b>proposes</b> fix specs.
        It never applies DDL or deletes on its own; proposed fixes are <b>approved in the Agents inbox</b> (the single
        routed approval queue). Last size sweep {elapsed(panel.lastSizeSweepAt)} ago ·
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
              <div className="flex flex-wrap items-start justify-between gap-2">
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
                <div className="flex shrink-0 items-center gap-2">
                  {item.specSlug ? (
                    <Link
                      href={routedInboxHref()}
                      className="text-[11px] font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
                    >
                      Review in the Agents inbox →
                    </Link>
                  ) : (
                    // No proposed fix spec ⇒ needs-human (needs_attention), not an approval → cleared here.
                    <button
                      onClick={() => act(item, "dismiss")}
                      disabled={busy !== null}
                      className="rounded-md border border-zinc-300 px-2.5 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      {busy === `${item.jobId}:dismiss` ? "…" : "Dismiss"}
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// agent-outage-resilience Phase 2: the "is Claude up?" tile — the Claude-down breaker + live component
// status. Green = operational + breaker closed; amber = degraded / local-signal firing; red = a
// partial/major outage or the breaker tripped. When tripped, autonomous agent jobs park
// `blocked_on_dependency` and the repair fan-out is suppressed until Claude recovers.
const CLAUDE_STATUS_LABEL: Record<ClaudeComponentStatus, string> = {
  operational: "operational",
  degraded_performance: "degraded",
  partial_outage: "partial outage",
  major_outage: "major outage",
  under_maintenance: "maintenance",
  unknown: "unknown",
};
function claudeComponentColor(s: ClaudeComponentStatus): LoopColor {
  if (s === "major_outage" || s === "partial_outage") return "red";
  if (s === "degraded_performance" || s === "unknown" || s === "under_maintenance") return "amber";
  return "green";
}
function ClaudeHealthTile({ h }: { h: ClaudeHealth }) {
  const color: LoopColor = h.down
    ? "red"
    : h.apiStatus === "operational" && h.codeStatus === "operational"
      ? "green"
      : "amber";
  const headline = h.down ? "Claude is DOWN — breaker tripped" : color === "green" ? "Claude is up" : "Claude degraded";
  return (
    <div className={`rounded-lg border p-3.5 ${TILE[color]}`}>
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT[color]}`} />
        <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{headline}</h3>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
        <span className={`rounded-full px-1.5 py-0.5 font-medium ${TILE[claudeComponentColor(h.apiStatus)]}`}>
          Claude API: {CLAUDE_STATUS_LABEL[h.apiStatus]}
        </span>
        <span className={`rounded-full px-1.5 py-0.5 font-medium ${TILE[claudeComponentColor(h.codeStatus)]}`}>
          Claude Code: {CLAUDE_STATUS_LABEL[h.codeStatus]}
        </span>
      </div>
      <dl className="mt-2 space-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
        {h.localDown && (
          <div className="flex gap-1.5">
            <dt className="text-zinc-400">local signal</dt>
            <dd className="text-rose-600 dark:text-rose-300">{h.consecutiveFailures} consecutive failures</dd>
          </div>
        )}
        {h.down && h.trippedAt && (
          <div className="flex gap-1.5">
            <dt className="text-zinc-400">tripped</dt>
            <dd className="text-zinc-600 dark:text-zinc-300">{elapsed(h.trippedAt)} ago — agents parked, repair fan-out suppressed</dd>
          </div>
        )}
        <div className="flex gap-1.5">
          <dt className="text-zinc-400">last poll</dt>
          <dd className="text-zinc-600 dark:text-zinc-300">
            {h.lastPolledAt ? `${elapsed(h.lastPolledAt)} ago` : "never"}
            {h.pollOk === false ? " · status page unreachable" : ""}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export default function ControlTowerPage() {
  const workspace = useWorkspace();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  // control-tower-switch-controls-three-tier Phase 1: per-department loop cache. Populated on
  // first expand (or on mount for a red/amber dept that's open by default), refreshed on every
  // 15s poll tick alongside the L0 snapshot so the drill-in stays live once opened.
  const [loopsByOwner, setLoopsByOwner] = useState<Record<string, LoopStatus[]>>({});
  const [loadingOwner, setLoadingOwner] = useState<Record<string, boolean>>({});
  // Track which owners have EVER been requested this mount, so the poll tick can re-fetch just
  // those without re-opening every dept. A ref avoids threading it through effect deps.
  const requestedOwnersRef = useRef<Set<string>>(new Set());
  // control-tower-infra-sub-page Phase 1: per-department Infra tab payload cache. Populated
  // ONLY when the CEO clicks Infra on a section (lazy, per the spec's ## Verification bullet).
  // Refreshed on the 15s poll tick alongside the loops fetch so an open Infra tab stays live.
  const [infraByOwner, setInfraByOwner] = useState<Record<string, InfraTabPayload>>({});
  const [loadingInfraOwner, setLoadingInfraOwner] = useState<Record<string, boolean>>({});
  const requestedInfraOwnersRef = useRef<Set<string>>(new Set());

  const fetchLoopsForOwner = useCallback((owner: OwnerFunction) => {
    requestedOwnersRef.current.add(owner);
    setLoadingOwner((s) => ({ ...s, [owner]: true }));
    return fetch(`/api/developer/control-tower?level=1&owner=${encodeURIComponent(owner)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: LoopsPayload) => {
        setLoopsByOwner((s) => ({ ...s, [owner]: d.loops }));
      })
      .catch(() => {
        // A transient L1 failure leaves the last-known loops in place (or `undefined` if never
        // loaded — the section shows "Loading loops…" until the next tick succeeds).
      })
      .finally(() => {
        setLoadingOwner((s) => ({ ...s, [owner]: false }));
      });
  }, []);

  // control-tower-infra-sub-page Phase 1: lazy per-department Infra fetch. First called only
  // when the CEO clicks the Infra tab inside a DepartmentSection (never on the initial render);
  // once requested, the 15s poll tick re-fetches it alongside the loops payload.
  const fetchInfraForOwner = useCallback((owner: OwnerFunction) => {
    requestedInfraOwnersRef.current.add(owner);
    setLoadingInfraOwner((s) => ({ ...s, [owner]: true }));
    return fetch(`/api/developer/control-tower/infra?owner=${encodeURIComponent(owner)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: InfraTabPayload) => {
        setInfraByOwner((s) => ({ ...s, [owner]: d }));
      })
      .catch(() => {
        // Transient failure — keep the last-known payload if any.
      })
      .finally(() => {
        setLoadingInfraOwner((s) => ({ ...s, [owner]: false }));
      });
  }, []);

  const refresh = useCallback(
    () =>
      fetch("/api/developer/control-tower")
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d: Snapshot) => {
          setSnap(d);
          setErr(false);
          // Refresh loops for every dept already loaded/open — the poll tick keeps the drill-in
          // live without re-collapsing anything the CEO has explicitly expanded.
          for (const owner of Array.from(requestedOwnersRef.current)) {
            fetchLoopsForOwner(owner as OwnerFunction);
          }
          // control-tower-infra-sub-page Phase 1: refresh the Infra payload for every dept
          // the CEO has actively opened Infra on. First-time Infra opens are gated by the tab
          // click (below); this only re-fires for owners that are already in the cache.
          for (const owner of Array.from(requestedInfraOwnersRef.current)) {
            fetchInfraForOwner(owner as OwnerFunction);
          }
        })
        .catch(() => setErr(true))
        .finally(() => setLoading(false)),
    [fetchLoopsForOwner, fetchInfraForOwner],
  );

  useEffect(() => {
    // cut-internal-egress-pooler-and-spec-rpcs Phase 3: visibility-guard mirrors the sidebar
    // reduce-calls pattern (src/app/dashboard/sidebar.tsx:347) — a backgrounded tab issues no
    // poll requests while hidden and refreshes on 'visibilitychange' → visible, so the
    // 13-17-request fan-out this page's ~15s tick fires doesn't run while the operator is on
    // another tab. Panels change on events, not routes, so deferring while hidden is safe.
    refresh();
    const runPoll = () => { if (document.visibilityState === "visible") refresh(); };
    const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
    const interval = setInterval(runPoll, 15000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
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

          {/* agent-outage-resilience Phase 2: the dependency-health tile — is Claude up? */}
          {snap.claudeHealth && (
            <div className="mb-6">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Dependency health
              </h2>
              <p className="mb-3 text-[11px] text-zinc-400">
                The Claude-down circuit-breaker — a 1-min poll of <code>status.claude.com</code> (Claude API + Claude
                Code) plus our own consecutive-failure counter. When it trips, autonomous agent jobs park
                <code> blocked_on_dependency</code> and the repair fan-out is suppressed until Claude recovers
                (park-and-drain); the customer-facing ticket path retries across the outage.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <ClaudeHealthTile h={snap.claudeHealth} />
              </div>
            </div>
          )}

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

          {/* Drill-in: per-department loop cards, sub-grouped by kind. Loops arrive lazily
              (control-tower-switch-controls-three-tier Phase 1) — a first expand fires the L1
              fetch; a red/amber dept auto-loads on mount because it's open by default. */}
          <div className="space-y-3">
            {departments.map((d) => (
              <DepartmentSection
                key={d.owner}
                dept={d}
                loops={loopsByOwner[d.owner]}
                loading={!!loadingOwner[d.owner]}
                onEnsureLoaded={() => fetchLoopsForOwner(d.owner)}
                infra={infraByOwner[d.owner]}
                onEnsureInfraLoaded={() => fetchInfraForOwner(d.owner)}
                infraLoading={!!loadingInfraOwner[d.owner]}
              />
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

          <CoverageRegisterSection items={snap.coverageRegister ?? []} onChange={refresh} />

          <RepairFeedSection items={snap.repairs ?? []} dismissed={snap.directorDismissed ?? []} onChange={refresh} />

          {snap.dbHealth && <DbHealthSection panel={snap.dbHealth} onChange={refresh} />}

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
