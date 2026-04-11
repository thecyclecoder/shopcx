"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Stats {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
}

interface Rates {
  deliveryRate: number;
  bounceRate: number;
  openRate: number;
  clickRate: number;
  complaintRate: number;
}

interface Score {
  value: number;
  label: string;
  color: string;
}

interface BounceItem {
  email: string;
  subject: string;
  date: string;
  reason: string;
}

interface ComplaintItem {
  email: string;
  subject: string;
  date: string;
}

function StatCard({ label, value, subtitle, color }: { label: string; value: string | number; subtitle?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color || "text-zinc-900 dark:text-zinc-100"}`}>{value}</p>
      {subtitle && <p className="mt-0.5 text-xs text-zinc-400">{subtitle}</p>}
    </div>
  );
}

function RateBar({ label, rate, color, threshold }: { label: string; rate: number; color: string; threshold?: { good: number; warn: number } }) {
  const isGood = threshold ? (threshold.good > threshold.warn ? rate >= threshold.good : rate <= threshold.good) : true;
  const isWarn = threshold ? (threshold.good > threshold.warn ? rate < threshold.warn : rate > threshold.warn) : false;
  const barColor = isWarn ? "bg-red-500" : isGood ? `bg-${color}-500` : `bg-amber-500`;

  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">{label}</span>
        <span className={`font-semibold ${isWarn ? "text-red-500" : isGood ? `text-${color}-600` : "text-amber-500"}`}>{rate}%</span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${Math.min(rate, 100)}%` }} />
      </div>
    </div>
  );
}

export default function EmailDeliveryPage() {
  const workspace = useWorkspace();
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<Stats | null>(null);
  const [rates, setRates] = useState<Rates | null>(null);
  const [score, setScore] = useState<Score | null>(null);
  const [bounces, setBounces] = useState<BounceItem[]>([]);
  const [complaints, setComplaints] = useState<ComplaintItem[]>([]);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/workspaces/${workspace.id}/delivery-stats?days=${days}`)
      .then(r => r.json())
      .then(data => {
        setStats(data.stats);
        setRates(data.rates);
        setScore(data.score);
        setBounces(data.bounces || []);
        setComplaints(data.complaints || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [workspace.id, days]);

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Email Delivery</h1>
        <div className="mt-6 animate-pulse space-y-4">
          <div className="h-32 rounded-xl bg-zinc-100 dark:bg-zinc-800" />
          <div className="grid grid-cols-3 gap-4">
            {[1, 2, 3].map(i => <div key={i} className="h-24 rounded-lg bg-zinc-100 dark:bg-zinc-800" />)}
          </div>
        </div>
      </div>
    );
  }

  const scoreColorMap: Record<string, string> = {
    emerald: "text-emerald-600 dark:text-emerald-400",
    blue: "text-blue-600 dark:text-blue-400",
    amber: "text-amber-600 dark:text-amber-400",
    red: "text-red-600 dark:text-red-400",
  };

  const scoreBgMap: Record<string, string> = {
    emerald: "bg-emerald-50 border-emerald-200 dark:bg-emerald-950 dark:border-emerald-800",
    blue: "bg-blue-50 border-blue-200 dark:bg-blue-950 dark:border-blue-800",
    amber: "bg-amber-50 border-amber-200 dark:bg-amber-950 dark:border-amber-800",
    red: "bg-red-50 border-red-200 dark:bg-red-950 dark:border-red-800",
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Email Delivery</h1>
          <p className="mt-1 text-sm text-zinc-500">Monitor email health, deliverability, and engagement.</p>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(parseInt(e.target.value))}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      {/* Health Score */}
      {score && (
        <div className={`mt-6 rounded-xl border p-6 ${scoreBgMap[score.color] || scoreBgMap.blue}`}>
          <div className="flex items-center gap-6">
            <div className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-current" style={{ borderColor: score.color === "emerald" ? "#059669" : score.color === "blue" ? "#2563eb" : score.color === "amber" ? "#d97706" : "#dc2626" }}>
              <span className={`text-3xl font-bold ${scoreColorMap[score.color]}`}>{score.value}</span>
            </div>
            <div>
              <p className={`text-lg font-semibold ${scoreColorMap[score.color]}`}>{score.label}</p>
              <p className="text-sm text-zinc-500">
                {score.value >= 90 ? "Your email reputation is excellent. Keep it up!" :
                 score.value >= 75 ? "Good delivery health. Watch bounce and complaint rates." :
                 score.value >= 50 ? "Some issues detected. Review bounces and complaints below." :
                 "Action needed. High bounce or complaint rates are hurting deliverability."}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Stats Cards */}
      {stats && (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Sent" value={stats.sent.toLocaleString()} />
          <StatCard label="Delivered" value={stats.delivered.toLocaleString()} subtitle={rates ? `${rates.deliveryRate}%` : undefined} />
          <StatCard label="Opened" value={stats.opened.toLocaleString()} subtitle={rates ? `${rates.openRate}%` : undefined} color="text-emerald-600 dark:text-emerald-400" />
          <StatCard label="Clicked" value={stats.clicked.toLocaleString()} subtitle={rates ? `${rates.clickRate}%` : undefined} color="text-cyan-600 dark:text-cyan-400" />
          <StatCard label="Bounced" value={stats.bounced.toLocaleString()} subtitle={rates ? `${rates.bounceRate}%` : undefined} color={stats.bounced > 0 ? "text-red-600 dark:text-red-400" : undefined} />
          <StatCard label="Complaints" value={stats.complained.toLocaleString()} subtitle={rates ? `${rates.complaintRate}%` : undefined} color={stats.complained > 0 ? "text-red-600 dark:text-red-400" : undefined} />
        </div>
      )}

      {/* Rate Bars */}
      {rates && (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Delivery Rates</h2>
          <div className="space-y-4">
            <RateBar label="Delivery Rate" rate={rates.deliveryRate} color="emerald" threshold={{ good: 98, warn: 95 }} />
            <RateBar label="Open Rate" rate={rates.openRate} color="blue" threshold={{ good: 20, warn: 10 }} />
            <RateBar label="Click Rate" rate={rates.clickRate} color="cyan" threshold={{ good: 3, warn: 1 }} />
            <RateBar label="Bounce Rate" rate={rates.bounceRate} color="red" threshold={{ good: 2, warn: 5 }} />
            <RateBar label="Complaint Rate" rate={rates.complaintRate} color="red" threshold={{ good: 0.1, warn: 0.3 }} />
          </div>
        </div>
      )}

      {/* Bounces List */}
      {bounces.length > 0 && (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Recent Bounces ({bounces.length})</h2>
          </div>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {bounces.map((b, i) => (
              <div key={i} className="flex items-center justify-between px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{b.email}</p>
                  <p className="truncate text-xs text-zinc-400">{b.subject}</p>
                </div>
                <div className="ml-4 shrink-0 text-right">
                  <p className="text-xs text-red-500">{b.reason}</p>
                  <p className="text-xs text-zinc-400">{new Date(b.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Complaints List */}
      {complaints.length > 0 && (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950">
          <div className="border-b border-red-200 px-5 py-3 dark:border-red-800">
            <h2 className="text-sm font-semibold text-red-700 dark:text-red-400">Spam Complaints ({complaints.length})</h2>
          </div>
          <div className="divide-y divide-red-100 dark:divide-red-900">
            {complaints.map((c, i) => (
              <div key={i} className="flex items-center justify-between px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-red-900 dark:text-red-100">{c.email}</p>
                  <p className="truncate text-xs text-red-400">{c.subject}</p>
                </div>
                <p className="ml-4 shrink-0 text-xs text-red-400">{new Date(c.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {stats && stats.sent === 0 && (
        <div className="mt-8 text-center">
          <p className="text-sm text-zinc-400">No email data for this period. Email tracking events will appear here once emails are sent.</p>
        </div>
      )}
    </div>
  );
}
