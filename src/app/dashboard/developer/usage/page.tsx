"use client";

/**
 * /dashboard/developer/usage — the fleet-usage cockpit (Phase 3 of the
 * fleet-usage-cockpit spec). Sits directly below Pulse in the developer
 * sidebar takeover.
 *
 * Owner-gated. Reads /api/developer/usage and renders three panels:
 *   • Accounts  — 4 Max Round Robin lanes + Codex. Two-currency honesty:
 *     TOKENS + rate-limit proximity + capped/reset countdown; NEVER a $.
 *     Claude limit = burn / discoverLimit (real % once ≥1 wall sampled,
 *     else 'learning…'); Codex limit = reported /status %.
 *   • Departments — per-owner_function fleet-cost with the fleet_budgets
 *     ceiling + breach flag (matches runFleetSpendGovernor).
 *   • API spend — real $ from ai_token_usage: model, purpose, cache split.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface WindowLimitDiscovered { status: "discovered"; limit_tokens: number; wall_count: number; burn_pct: number }
interface WindowLimitLearning { status: "learning"; wall_count: number }
interface WindowLimitReported { status: "reported"; limit_pct: number; wall_count: number }
type WindowLimit = WindowLimitDiscovered | WindowLimitLearning | WindowLimitReported;

interface AccountWindow {
  window_kind: "5h" | "weekly";
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cache_read_ratio_pct: number;
  capped: boolean;
  capped_until: string | null;
  window_reset_at: string | null;
  limit: WindowLimit;
}
interface AccountCard {
  account: string;
  runtime: "claude" | "codex";
  capped: boolean;
  windows: { fiveH: AccountWindow; weekly: AccountWindow };
}
interface DepartmentRow {
  owner_function: string;
  window_days: number;
  total_tokens: number;
  usd_cents: number | null;
  subscription_only: boolean;
  token_ceiling: number | null;
  usd_ceiling_cents: number | null;
  breach: boolean;
  breach_reason: string | null;
}
interface ApiPanel {
  window_days: number;
  total_cost_cents: number;
  total_tokens: number;
  cache: { raw_input_tokens: number; cache_creation_tokens: number; cache_read_tokens: number; output_tokens: number; read_ratio_pct: number };
  by_model: Array<{ model: string; total_tokens: number; usd_cents: number; calls: number }>;
  by_purpose: Array<{ purpose: string; total_tokens: number; usd_cents: number; calls: number }>;
}
interface CockpitResponse {
  generated_at: string;
  accounts: AccountCard[];
  departments: DepartmentRow[];
  api: ApiPanel;
}

/** Render a UTC ISO in America/Puerto_Rico (AST, no DST) — matches the pulse page. */
function formatAstTimestamp(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/Puerto_Rico",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
function fmtCents(cents: number): string {
  const dollars = cents / 100;
  return dollars >= 100 ? `$${dollars.toFixed(0)}` : `$${dollars.toFixed(2)}`;
}
function fmtCountdown(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `in ${hrs}h ${rest}m` : `in ${hrs}h`;
}

function LimitBadge({ limit }: { limit: WindowLimit }) {
  if (limit.status === "discovered") {
    const pct = limit.burn_pct;
    const tone = pct >= 90 ? "text-red-700 dark:text-red-300" : pct >= 60 ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300";
    return (
      <span className={`text-xs font-medium ${tone}`}>
        {pct}% of ~{fmtNum(limit.limit_tokens)} <span className="text-zinc-400">({limit.wall_count} wall{limit.wall_count === 1 ? "" : "s"})</span>
      </span>
    );
  }
  if (limit.status === "reported") {
    const pct = limit.limit_pct;
    const tone = pct >= 90 ? "text-red-700 dark:text-red-300" : pct >= 60 ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300";
    return (
      <span className={`text-xs font-medium ${tone}`}>
        /status: {pct}% <span className="text-zinc-400">({limit.wall_count} wall{limit.wall_count === 1 ? "" : "s"})</span>
      </span>
    );
  }
  return (
    <span className="text-xs italic text-zinc-500">learning… <span className="text-zinc-400">(0 walls)</span></span>
  );
}

function AccountRow({ card }: { card: AccountCard }) {
  return (
    <div className={`rounded-xl border p-4 ${card.capped ? "border-red-200 bg-red-50/50 dark:border-red-950 dark:bg-red-950/20" : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"}`}>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{card.account}</span>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{card.runtime}</span>
        </div>
        {card.capped ? (
          <span className="rounded bg-red-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700 dark:bg-red-900/50 dark:text-red-300">capped</span>
        ) : (
          <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">healthy</span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {(["fiveH", "weekly"] as const).map((k) => {
          const w = card.windows[k];
          const label = k === "fiveH" ? "5h window" : "weekly window";
          return (
            <div key={k} className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{label}</span>
                {w.capped && w.capped_until && (
                  <span className="text-[11px] text-zinc-500">resets {fmtCountdown(w.capped_until)}</span>
                )}
              </div>
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{fmtNum(w.total_tokens)} tokens</div>
              <div className="mt-1 text-[11px] text-zinc-500">
                cache read {w.cache_read_ratio_pct}% · {fmtNum(w.output_tokens)} out
              </div>
              <div className="mt-2">
                <LimitBadge limit={w.limit} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DepartmentsPanel({ departments }: { departments: DepartmentRow[] }) {
  if (!departments.length) {
    return <p className="text-sm text-zinc-500">No departmental spend or budgets yet — the fleet-budgets seed hasn&apos;t landed on this workspace.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
            <th className="py-2 pr-4">Department</th>
            <th className="py-2 pr-4">Tokens</th>
            <th className="py-2 pr-4">$ (API-billed only)</th>
            <th className="py-2 pr-4">Ceiling</th>
            <th className="py-2 pr-4">Window</th>
            <th className="py-2 pr-4">Status</th>
          </tr>
        </thead>
        <tbody>
          {departments.map((d) => (
            <tr key={d.owner_function} className={d.breach ? "border-b border-red-200 bg-red-50/40 dark:border-red-900/50 dark:bg-red-950/20" : "border-b border-zinc-100 dark:border-zinc-800"}>
              <td className="py-2 pr-4 font-medium text-zinc-900 dark:text-zinc-100">{d.owner_function}</td>
              <td className="py-2 pr-4 text-zinc-700 dark:text-zinc-300">{fmtNum(d.total_tokens)}</td>
              <td className="py-2 pr-4 text-zinc-700 dark:text-zinc-300">
                {d.subscription_only ? <span className="italic text-zinc-400">subscription proxy</span> : d.usd_cents != null ? fmtCents(d.usd_cents) : "—"}
              </td>
              <td className="py-2 pr-4 text-zinc-500">
                {d.token_ceiling != null ? `${fmtNum(d.token_ceiling)} tok` : ""}
                {d.token_ceiling != null && d.usd_ceiling_cents != null ? " · " : ""}
                {d.usd_ceiling_cents != null ? fmtCents(d.usd_ceiling_cents) : ""}
                {d.token_ceiling == null && d.usd_ceiling_cents == null && <span className="italic text-zinc-400">none</span>}
              </td>
              <td className="py-2 pr-4 text-zinc-500">{d.window_days}d</td>
              <td className="py-2 pr-4">
                {d.breach ? (
                  <span title={d.breach_reason || ""} className="rounded bg-red-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700 dark:bg-red-900/50 dark:text-red-300">breach</span>
                ) : (
                  <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">ok</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApiPanelView({ panel }: { panel: ApiPanel }) {
  const topModels = panel.by_model.slice(0, 6);
  const topPurposes = panel.by_purpose.slice(0, 6);
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
          <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Total (window)</div>
          <div className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100">{fmtCents(panel.total_cost_cents)}</div>
          <div className="text-[11px] text-zinc-500">{fmtNum(panel.total_tokens)} tokens</div>
        </div>
        <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
          <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Cache read</div>
          <div className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100">{panel.cache.read_ratio_pct}%</div>
          <div className="text-[11px] text-zinc-500">of input side</div>
        </div>
        <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
          <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Raw input</div>
          <div className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100">{fmtNum(panel.cache.raw_input_tokens)}</div>
          <div className="text-[11px] text-zinc-500">uncached</div>
        </div>
        <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
          <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Output</div>
          <div className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100">{fmtNum(panel.cache.output_tokens)}</div>
          <div className="text-[11px] text-zinc-500">tokens</div>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">By model</div>
          <ul className="space-y-1">
            {topModels.length === 0 && <li className="text-sm text-zinc-500">No API-billed usage in the window.</li>}
            {topModels.map((m) => (
              <li key={m.model} className="flex items-center justify-between text-sm">
                <span className="truncate text-zinc-700 dark:text-zinc-300">{m.model}</span>
                <span className="text-right">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{fmtCents(m.usd_cents)}</span>
                  <span className="ml-2 text-[11px] text-zinc-500">{m.calls} calls · {fmtNum(m.total_tokens)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">By purpose</div>
          <ul className="space-y-1">
            {topPurposes.length === 0 && <li className="text-sm text-zinc-500">No API-billed usage in the window.</li>}
            {topPurposes.map((p) => (
              <li key={p.purpose} className="flex items-center justify-between text-sm">
                <span className="truncate text-zinc-700 dark:text-zinc-300">{p.purpose}</span>
                <span className="text-right">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{fmtCents(p.usd_cents)}</span>
                  <span className="ml-2 text-[11px] text-zinc-500">{p.calls} calls · {fmtNum(p.total_tokens)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export default function UsageCockpitPage() {
  const workspace = useWorkspace();
  const [data, setData] = useState<CockpitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/developer/usage");
      if (r.status === 403) { setError("This surface is owner-gated."); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as CockpitResponse;
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const claudeCards = useMemo(() => data?.accounts.filter((a) => a.runtime === "claude") ?? [], [data]);
  const codexCards = useMemo(() => data?.accounts.filter((a) => a.runtime === "codex") ?? [], [data]);

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">Fleet usage</h1>
        <p className="mt-2 text-sm text-zinc-500">Owner only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Fleet usage cockpit</h1>
          <p className="text-xs text-zinc-500">
            Per-account 5h + weekly windows · department budgets · API $ · two-currency honesty
            {data?.generated_at ? <> · captured {formatAstTimestamp(data.generated_at)} AST</> : null}
          </p>
        </div>
        <button type="button" onClick={fetchData} disabled={loading} className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      {error && <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{error}</div>}

      {/* Accounts panel — 4 Max + Codex */}
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Accounts <span className="text-zinc-400">(tokens + rate-limit proximity — never $)</span></h2>
        <div className="grid gap-3 md:grid-cols-2">
          {claudeCards.map((c) => <AccountRow key={c.account} card={c} />)}
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {codexCards.map((c) => <AccountRow key={c.account} card={c} />)}
        </div>
      </section>

      {/* Departments panel — fleet-cost per owner_function with breach flag */}
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Departments <span className="text-zinc-400">(fleet-cost + budgets)</span></h2>
        {data && <DepartmentsPanel departments={data.departments} />}
      </section>

      {/* API panel — real $ */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">API spend <span className="text-zinc-400">(runtime AI — real $)</span></h2>
        {data && <ApiPanelView panel={data.api} />}
      </section>
    </div>
  );
}
