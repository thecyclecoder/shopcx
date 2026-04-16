"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface FraudCase {
  id: string;
  rule_type: string;
  status: string;
  severity: string;
  title: string;
  summary: string | null;
  evidence: Record<string, unknown>;
  customer_ids: string[];
  order_ids: string[];
  assigned_to: string | null;
  first_detected_at: string;
  last_seen_at: string;
  created_at: string;
  fraud_rules: { name: string };
}

interface Stats {
  open_count: number;
  confirmed_30d: number;
  dismissed_30d: number;
  value_at_risk_cents: number;
}

const PAGE_SIZE = 25;

const SEVERITY_COLORS: Record<string, string> = {
  high: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  medium: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  low: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const STATUS_COLORS: Record<string, string> = {
  open: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  reviewing: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  confirmed_fraud: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  dismissed: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500",
};

const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  reviewing: "Reviewing",
  confirmed_fraud: "Confirmed",
  dismissed: "Dismissed",
};

const RULE_TYPE_LABELS: Record<string, string> = {
  shared_address: "Shared Address",
  high_velocity: "High Velocity",
  large_order: "Large Order",
};

const RULE_TYPE_ICONS: Record<string, string> = {
  shared_address: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1",
  high_velocity: "M13 10V3L4 14h7v7l9-11h-7z",
  large_order: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

function timeAgo(date: string): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

export default function FraudMonitorPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [cases, setCases] = useState<FraudCase[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats>({ open_count: 0, confirmed_30d: 0, dismissed_30d: 0, value_at_risk_cents: 0 });
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);

  // Filters
  const [statusFilter, setStatusFilter] = useState(searchParams.get("status") || "");
  const [ruleTypeFilter, setRuleTypeFilter] = useState(searchParams.get("rule_type") || "");
  const [severityFilter, setSeverityFilter] = useState(searchParams.get("severity") || "");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("limit", String(PAGE_SIZE));
        params.set("offset", String(offset));
        if (statusFilter) params.set("status", statusFilter);
        if (ruleTypeFilter) params.set("rule_type", ruleTypeFilter);
        if (severityFilter) params.set("severity", severityFilter);

        const res = await fetch(`/api/workspaces/${workspace.id}/fraud-cases?${params}`);
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          setCases(data.cases || []);
          setTotal(data.total || 0);
          setStats((prev) => data.stats || prev);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workspace.id, offset, statusFilter, ruleTypeFilter, severityFilter]);

  // Open case from URL param
  useEffect(() => {
    const caseId = searchParams.get("case");
    if (caseId) {
      router.push(`/dashboard/fraud/${caseId}`);
    }
  }, [searchParams, router]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Fraud Monitor</h1>
        <p className="mt-1 text-sm text-zinc-500">Review suspicious patterns detected across orders and customers.</p>
      </div>

      {/* Stats tiles */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Open Cases" value={String(stats.open_count)} color="text-blue-600 dark:text-blue-400" />
        <StatTile label="Confirmed (30d)" value={String(stats.confirmed_30d)} color="text-red-600 dark:text-red-400" />
        <StatTile label="Dismissed (30d)" value={String(stats.dismissed_30d)} color="text-zinc-500" />
        <StatTile label="Value at Risk" value={formatCents(stats.value_at_risk_cents)} color="text-amber-600 dark:text-amber-400" />
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setOffset(0); }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        >
          <option value="">All Statuses</option>
          <option value="open">Open</option>
          <option value="reviewing">Reviewing</option>
          <option value="confirmed_fraud">Confirmed</option>
          <option value="dismissed">Dismissed</option>
        </select>

        <select
          value={ruleTypeFilter}
          onChange={(e) => { setRuleTypeFilter(e.target.value); setOffset(0); }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        >
          <option value="">All Rule Types</option>
          <option value="shared_address">Shared Address</option>
          <option value="high_velocity">High Velocity</option>
        </select>

        <select
          value={severityFilter}
          onChange={(e) => { setSeverityFilter(e.target.value); setOffset(0); }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        >
          <option value="">All Severities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>

        <span className="ml-auto text-sm text-zinc-400">
          {total} case{total !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Case list */}
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {loading ? (
          <div className="px-6 py-12 text-center text-sm text-zinc-400">Loading...</div>
        ) : cases.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <svg className="mx-auto h-10 w-10 text-zinc-300 dark:text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            <p className="mt-2 text-sm text-zinc-500">No fraud cases found.</p>
            <p className="text-sm text-zinc-400">Detection runs nightly and on new orders.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs font-medium uppercase text-zinc-400 dark:border-zinc-800">
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Case</th>
                <th className="hidden px-4 py-3 sm:table-cell">Customers</th>
                <th className="hidden px-4 py-3 sm:table-cell">Orders</th>
                <th className="hidden px-4 py-3 md:table-cell">Value</th>
                <th className="hidden px-4 py-3 md:table-cell">Detected</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => {
                const ev = (c.evidence || {}) as Record<string, unknown>;
                const valueAtRisk = Number(ev.total_order_value_cents || ev.total_spend_in_window_cents || ev.amount_cents || 0);

                return (
                  <tr
                    key={c.id}
                    onClick={() => router.push(`/dashboard/fraud/${c.id}`)}
                    className="cursor-pointer border-b border-zinc-100 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50"
                  >
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_COLORS[c.severity]}`}>
                        {c.severity}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <svg className="h-4 w-4 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d={RULE_TYPE_ICONS[c.rule_type] || RULE_TYPE_ICONS.shared_address} />
                        </svg>
                        <span className="text-zinc-600 dark:text-zinc-400">{RULE_TYPE_LABELS[c.rule_type] || c.rule_type}</span>
                      </div>
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                      {c.title}
                    </td>
                    <td className="hidden px-4 py-3 tabular-nums text-zinc-500 sm:table-cell">
                      {c.customer_ids?.length || 0}
                    </td>
                    <td className="hidden px-4 py-3 tabular-nums text-zinc-500 sm:table-cell">
                      {c.order_ids?.length || 0}
                    </td>
                    <td className="hidden px-4 py-3 tabular-nums text-zinc-600 dark:text-zinc-400 md:table-cell">
                      {formatCents(valueAtRisk)}
                    </td>
                    <td className="hidden px-4 py-3 text-zinc-400 md:table-cell">
                      {timeAgo(c.first_detected_at)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[c.status]}`}>
                        {STATUS_LABELS[c.status] || c.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <button
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Previous
          </button>
          <span className="text-zinc-400">
            Page {currentPage} of {totalPages}
          </span>
          <button
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={currentPage >= totalPages}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs font-medium uppercase text-zinc-400">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}
