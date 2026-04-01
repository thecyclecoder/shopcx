"use client";

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface DashboardStats {
  open_tickets: number;
  pending_tickets: number;
  customers: number;
  active_subs: number;
  avg_retention: number | null;
  ai_resolution_rate: number | null;
  tickets_range: number;
  tickets_prev: number;
  kb_articles: number;
  macros: number;
  cancels_range: number;
  cancels_prev: number;
  failures_range: number;
  failures_prev: number;
  dunning_recovered: number;
  dunning_active_failures: number;
  dunning_in_progress: number;
}

const RANGES = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
] as const;

type Range = (typeof RANGES)[number]["value"];

function prevLabel(range: Range): string {
  if (range === "today") return "vs yesterday";
  if (range === "yesterday") return "vs day before";
  if (range === "7d") return "vs prev 7 days";
  return "vs prev 30 days";
}

interface StatCard {
  label: string;
  value: string;
  color?: string;
  change?: { text: string; color: string } | null;
  href?: string;
}

function change(current: number, prev: number, invertColor = false): { text: string; color: string } | null {
  if (prev === 0 && current === 0) return null;
  if (prev === 0) return { text: `+${current}`, color: invertColor ? "text-red-500" : "text-emerald-500" };
  const pct = Math.round(((current - prev) / prev) * 100);
  if (pct === 0) return { text: "no change", color: "text-zinc-400" };
  const up = pct > 0;
  return {
    text: `${up ? "+" : ""}${pct}%`,
    color: invertColor ? (up ? "text-red-500" : "text-emerald-500") : (up ? "text-emerald-500" : "text-red-500"),
  };
}

function StatCardEl({ card }: { card: StatCard }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">{card.label}</p>
      <p className={`mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-100 ${card.color || ""}`}>
        {card.value}
      </p>
      {card.change && (
        <p className={`mt-0.5 text-xs ${card.change.color}`}>{card.change.text}</p>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">{title}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {children}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const workspace = useWorkspace();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [range, setRange] = useState<Range>("today");
  const [dupeAlerts, setDupeAlerts] = useState<{ id: string; title: string; body: string }[]>([]);

  const load = useCallback(async () => {
    const [open, pending, extra] = await Promise.all([
      fetch("/api/tickets?status=open&limit=1").then(r => r.json()),
      fetch("/api/tickets?status=pending&limit=1").then(r => r.json()),
      fetch(`/api/workspaces/${workspace.id}/dashboard-stats?range=${range}`).then(r => r.json()).catch(() => ({})),
    ]);
    setStats({
      open_tickets: open?.total || 0,
      pending_tickets: pending?.total || 0,
      customers: extra.customers || 0,
      active_subs: extra.active_subs || 0,
      avg_retention: extra.avg_retention ?? null,
      ai_resolution_rate: extra.ai_resolution_rate ?? null,
      tickets_range: extra.tickets_range || 0,
      tickets_prev: extra.tickets_prev || 0,
      kb_articles: extra.kb_articles || 0,
      macros: extra.macros || 0,
      cancels_range: extra.cancels_range || 0,
      cancels_prev: extra.cancels_prev || 0,
      failures_range: extra.failures_range || 0,
      failures_prev: extra.failures_prev || 0,
      dunning_recovered: extra.dunning_recovered || 0,
      dunning_active_failures: extra.dunning_active_failures || 0,
      dunning_in_progress: extra.dunning_in_progress || 0,
    });
  }, [workspace.id, range]);

  useEffect(() => { load(); }, [load]);

  // Fetch duplicate order alerts
  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/notifications?type=duplicate_order_alert&dismissed=false`)
      .then(r => r.ok ? r.json() : { notifications: [] })
      .then(data => setDupeAlerts(data.notifications || []))
      .catch(() => {});
  }, [workspace.id]);

  const prev = prevLabel(range);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Header + Range Selector */}
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Overview</h1>
          <p className="mt-1 text-sm text-zinc-500">{workspace.name}</p>
        </div>
        <div className="flex rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          {RANGES.map(r => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors first:rounded-l-lg last:rounded-r-lg ${
                range === r.value
                  ? "bg-indigo-500 text-white"
                  : "text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Duplicate order alert banner */}
      {dupeAlerts.length > 0 && (
        <div className="mb-6 rounded-lg border-2 border-red-500 bg-red-50 p-4 dark:bg-red-950/50">
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-red-600 text-white">
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-bold text-red-800 dark:text-red-300">
                {dupeAlerts.length} Duplicate Order{dupeAlerts.length > 1 ? "s" : ""} Detected
              </h3>
              <div className="mt-1 space-y-1">
                {dupeAlerts.slice(0, 5).map(alert => (
                  <p key={alert.id} className="text-sm text-red-700 dark:text-red-400">{alert.body}</p>
                ))}
                {dupeAlerts.length > 5 && (
                  <p className="text-sm font-medium text-red-700 dark:text-red-400">+ {dupeAlerts.length - 5} more</p>
                )}
              </div>
              <div className="mt-2 flex items-center gap-3">
                <a href="/dashboard/orders?filter=all" className="text-sm font-medium text-red-800 underline hover:text-red-900 dark:text-red-300 dark:hover:text-red-200">
                  View in Orders
                </a>
                <button
                  onClick={async () => {
                    await Promise.all(dupeAlerts.map(a =>
                      fetch(`/api/workspaces/${workspace.id}/notifications/${a.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ dismissed: true }),
                      })
                    ));
                    setDupeAlerts([]);
                  }}
                  className="text-sm font-medium text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-200"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {!stats ? (
        <p className="text-sm text-zinc-400">Loading...</p>
      ) : (
        <div className="space-y-8">
          {/* Support */}
          <Section title="Support">
            <StatCardEl card={{
              label: "Open Tickets",
              value: stats.open_tickets.toLocaleString(),
              color: stats.open_tickets > 0 ? "text-blue-600" : "",
            }} />
            <StatCardEl card={{
              label: "Pending Tickets",
              value: stats.pending_tickets.toLocaleString(),
              color: stats.pending_tickets > 0 ? "text-amber-600" : "",
            }} />
            <StatCardEl card={{
              label: "New Tickets",
              value: stats.tickets_range.toLocaleString(),
              change: { ...change(stats.tickets_range, stats.tickets_prev, true)!, text: `${change(stats.tickets_range, stats.tickets_prev, true)?.text || ""} ${prev}` },
            }} />
            <StatCardEl card={{
              label: "AI Resolution Rate",
              value: stats.ai_resolution_rate != null ? `${Math.round(stats.ai_resolution_rate * 100)}%` : "\u2014",
            }} />
          </Section>

          {/* Subscriptions & Revenue */}
          <Section title="Subscriptions">
            <StatCardEl card={{
              label: "Active Subscriptions",
              value: stats.active_subs.toLocaleString(),
            }} />
            <StatCardEl card={{
              label: "Cancellations",
              value: stats.cancels_range.toLocaleString(),
              color: stats.cancels_range > 0 ? "text-red-600" : "",
              change: change(stats.cancels_range, stats.cancels_prev, true)
                ? { text: `${change(stats.cancels_range, stats.cancels_prev, true)!.text} ${prev}`, color: change(stats.cancels_range, stats.cancels_prev, true)!.color }
                : null,
            }} />
            <StatCardEl card={{
              label: "Payment Failures",
              value: stats.failures_range.toLocaleString(),
              color: stats.failures_range > 0 ? "text-red-600" : "",
              change: change(stats.failures_range, stats.failures_prev, true)
                ? { text: `${change(stats.failures_range, stats.failures_prev, true)!.text} ${prev}`, color: change(stats.failures_range, stats.failures_prev, true)!.color }
                : null,
            }} />
            <StatCardEl card={{
              label: "Avg. Retention Score",
              value: stats.avg_retention != null ? `${Math.round(stats.avg_retention)}/100` : "\u2014",
            }} />
          </Section>

          {/* Dunning & Recovery */}
          <Section title="Dunning & Recovery">
            <StatCardEl card={{
              label: "In Dunning",
              value: stats.dunning_in_progress.toLocaleString(),
              color: stats.dunning_in_progress > 0 ? "text-amber-600" : "",
            }} />
            <StatCardEl card={{
              label: "At-Risk Subs",
              value: stats.dunning_active_failures.toLocaleString(),
              color: stats.dunning_active_failures > 0 ? "text-red-600" : "",
            }} />
            <StatCardEl card={{
              label: "Recovered",
              value: stats.dunning_recovered.toLocaleString(),
              color: stats.dunning_recovered > 0 ? "text-emerald-600" : "",
            }} />
          </Section>

          {/* Platform */}
          <Section title="Platform">
            <StatCardEl card={{
              label: "Customers",
              value: stats.customers.toLocaleString(),
            }} />
            <StatCardEl card={{
              label: "KB Articles",
              value: stats.kb_articles.toLocaleString(),
            }} />
            <StatCardEl card={{
              label: "Active Macros",
              value: stats.macros.toLocaleString(),
            }} />
          </Section>
        </div>
      )}
    </div>
  );
}
