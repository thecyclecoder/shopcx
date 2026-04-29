"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface ScorePoint {
  date: string;
  overall_score: number | null;
  channel_scores: Record<string, number>;
  conversations: number;
}

interface IssueRow {
  type: string;
  description: string;
  ticket_id: string | null;
}

interface ActionItem {
  priority: "high" | "medium" | "low" | string;
  description: string;
}

interface Data {
  days: number;
  scores: ScorePoint[];
  latest: {
    score: number | null;
    summary: string;
    issues: IssueRow[];
    action_items: ActionItem[];
    date: string | null;
  };
  totals: { ai_tickets: number; escalated: number; escalation_rate_pct: number; chat: number; email: number };
  decisions: Record<string, number>;
  actions: Record<string, number>;
  tags: Record<string, number>;
  cost?: {
    total_cents: number;
    total_tokens: number;
    tickets_with_usage: number;
    avg_per_ticket_cents: number;
    by_model: Record<string, { tokens: number; cost_cents: number; calls: number }>;
    by_purpose: Record<string, { tokens: number; cost_cents: number; calls: number }>;
    daily: { date: string; cost_cents: number; tokens: number }[];
    orchestrator_split: {
      opus_calls: number;
      sonnet_calls: number;
      opus_tickets: number;
      sonnet_tickets: number;
      opus_pct: number;
    };
  };
}

const DECISION_LABELS: Record<string, string> = {
  direct_action: "Direct actions",
  journey: "Journey routings",
  playbook: "Playbook routings",
  workflow: "Workflow runs",
  ai_response: "AI replies",
  kb_response: "KB replies",
  macro: "Macro sends",
  escalate: "Escalations",
};

function scoreColor(s: number | null): string {
  if (s == null) return "text-zinc-500";
  if (s >= 8) return "text-emerald-600";
  if (s >= 6) return "text-amber-600";
  return "text-rose-600";
}

export default function AiAnalyticsPage() {
  const workspace = useWorkspace();
  const [data, setData] = useState<Data | null>(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/analytics/ai?days=${days}`)
      .then(r => r.json())
      .then(setData)
      .catch(() => setData(null));
  }, [workspace.id, days]);

  if (!data) return <div className="p-8 text-sm text-zinc-500">Loading…</div>;

  const latestScore = data.latest.score;
  const recentScores = data.scores.filter(s => s.overall_score != null);
  const avgScore = recentScores.length
    ? recentScores.reduce((acc, s) => acc + (s.overall_score || 0), 0) / recentScores.length
    : null;

  const tagDisplayBuckets = bucketTags(data.tags);
  const totalDecisions = Object.values(data.decisions).reduce((a, b) => a + b, 0);
  const totalActions = Object.values(data.actions).reduce((a, b) => a + b, 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">AI Agent Analytics</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Daily ratings, what Sonnet&apos;s actually doing, and the latest issue surface.
          </p>
        </div>
        <select
          value={days}
          onChange={e => setDays(parseInt(e.target.value, 10))}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
          <option value={60}>Last 60 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      {/* Top KPI row */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Latest score" value={latestScore != null ? `${latestScore}/10` : "—"} valueClassName={scoreColor(latestScore)} />
        <Stat label={`Avg over ${data.days}d`} value={avgScore != null ? `${avgScore.toFixed(1)}/10` : "—"} valueClassName={scoreColor(avgScore)} />
        <Stat label="AI tickets" value={data.totals.ai_tickets.toLocaleString()} hint={`${data.totals.email} email · ${data.totals.chat} chat`} />
        <Stat label="Escalation rate" value={`${data.totals.escalation_rate_pct}%`} hint={`${data.totals.escalated} of ${data.totals.ai_tickets}`} />
      </div>

      {/* Cost / token usage */}
      {data.cost && data.cost.total_tokens > 0 && (
        <Section
          title="Token usage & cost"
          subtitle={`${data.cost.total_tokens.toLocaleString()} tokens over ${data.days}d · ${data.cost.tickets_with_usage} ticket${data.cost.tickets_with_usage === 1 ? "" : "s"} attributed`}
        >
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={`Total ${data.days}d`} value={fmtCost(data.cost.total_cents)} hint={`~${fmtCost(data.cost.total_cents / Math.max(1, data.days))}/day`} />
            <Stat label="Per ticket" value={fmtCost(data.cost.avg_per_ticket_cents)} hint="avg cost / ticket" />
            <Stat
              label="Opus share"
              value={`${data.cost.orchestrator_split.opus_pct}%`}
              hint={`${data.cost.orchestrator_split.opus_tickets} opus · ${data.cost.orchestrator_split.sonnet_tickets} sonnet`}
            />
            <Stat
              label="Monthly run-rate"
              value={fmtCost((data.cost.total_cents / Math.max(1, data.days)) * 30)}
              hint="extrapolated"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">By model</div>
              <BarList
                items={Object.entries(data.cost.by_model)
                  .map(([m, v]) => ({ label: `${shortenModel(m)} — ${fmtCost(v.cost_cents)} (${v.calls} calls)`, value: v.tokens }))
                  .sort((a, b) => b.value - a.value)}
                compact
              />
            </div>
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">By purpose</div>
              <BarList
                items={Object.entries(data.cost.by_purpose)
                  .map(([p, v]) => ({ label: `${p} — ${fmtCost(v.cost_cents)}`, value: v.tokens }))
                  .sort((a, b) => b.value - a.value)
                  .slice(0, 8)}
                compact
              />
            </div>
          </div>
        </Section>
      )}

      {/* Score chart */}
      <Section title="Daily score" subtitle={`${recentScores.length} report${recentScores.length === 1 ? "" : "s"} in window`}>
        <ScoreChart points={data.scores} />
      </Section>

      {/* Sonnet decisions */}
      <Section
        title="Sonnet decisions"
        subtitle={`${totalDecisions.toLocaleString()} total decisions over ${data.days}d`}
      >
        <BarList
          items={Object.entries(data.decisions)
            .map(([k, v]) => ({ label: DECISION_LABELS[k] || k, value: v }))
            .sort((a, b) => b.value - a.value)}
        />
      </Section>

      {/* Direct actions executed */}
      {totalActions > 0 && (
        <Section
          title="Direct actions executed"
          subtitle={`${totalActions.toLocaleString()} action${totalActions === 1 ? "" : "s"} (parsed from "Action completed" notes)`}
        >
          <BarList
            items={Object.entries(data.actions)
              .map(([k, v]) => ({ label: k, value: v }))
              .sort((a, b) => b.value - a.value)
              .slice(0, 12)}
          />
        </Section>
      )}

      {/* Flow tags */}
      <Section
        title="Flow distribution"
        subtitle="Which journeys / playbooks / workflows fired"
      >
        <div className="grid gap-4 md:grid-cols-3">
          {tagDisplayBuckets.map(b => (
            <div key={b.title}>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">{b.title}</div>
              <BarList items={b.items} compact />
            </div>
          ))}
        </div>
      </Section>

      {/* Latest issues */}
      <Section
        title="Latest issues"
        subtitle={data.latest.date ? `From ${data.latest.date} report — score ${data.latest.score}/10` : "No reports yet"}
      >
        {data.latest.summary && (
          <p className="mb-4 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm leading-relaxed text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
            {data.latest.summary}
          </p>
        )}

        {data.latest.action_items.length > 0 && (
          <div className="mb-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Action items</div>
            <ul className="space-y-1.5">
              {data.latest.action_items.map((a, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                    a.priority === "high" ? "bg-rose-100 text-rose-700" :
                    a.priority === "medium" ? "bg-amber-100 text-amber-700" :
                    "bg-zinc-200 text-zinc-700"
                  }`}>
                    {a.priority}
                  </span>
                  <span className="text-zinc-700 dark:text-zinc-300">{a.description}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {data.latest.issues.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Issues</div>
            <ul className="space-y-1.5">
              {data.latest.issues.map((issue, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 inline-block rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
                    {issue.type.replace(/_/g, " ")}
                  </span>
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {issue.description}
                    {issue.ticket_id && (
                      <Link href={`/dashboard/tickets/${issue.ticket_id}`} className="ml-1 text-indigo-600 hover:underline">
                        →
                      </Link>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>
    </div>
  );
}

function Stat({ label, value, hint, valueClassName }: { label: string; value: string; hint?: string; valueClassName?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${valueClassName || "text-zinc-900 dark:text-zinc-100"}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
        {subtitle && <p className="mt-1 text-xs text-zinc-500">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function ScoreChart({ points }: { points: ScorePoint[] }) {
  const valid = points.filter(p => p.overall_score != null);
  if (!valid.length) return <div className="text-sm text-zinc-500">No reports in this window yet.</div>;

  const W = 800, H = 180, PAD = 24;
  const minDate = new Date(valid[0].date).getTime();
  const maxDate = new Date(valid[valid.length - 1].date).getTime();
  const xRange = Math.max(1, maxDate - minDate);
  const x = (d: string) => PAD + ((new Date(d).getTime() - minDate) / xRange) * (W - 2 * PAD);
  const y = (s: number) => H - PAD - (s / 10) * (H - 2 * PAD);

  const path = valid.map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.date)} ${y(p.overall_score!)}`).join(" ");

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 480 }}>
        {/* Y gridlines at 0, 5, 10 */}
        {[0, 5, 10].map(g => (
          <g key={g}>
            <line x1={PAD} x2={W - PAD} y1={y(g)} y2={y(g)} stroke="currentColor" className="text-zinc-200 dark:text-zinc-800" strokeDasharray={g === 5 ? "" : "2 2"} />
            <text x={4} y={y(g) + 4} className="fill-zinc-500 text-[10px]">{g}</text>
          </g>
        ))}
        {/* Line */}
        <path d={path} fill="none" stroke="currentColor" className="text-indigo-500" strokeWidth={2} />
        {/* Points */}
        {valid.map((p, i) => (
          <g key={i}>
            <circle cx={x(p.date)} cy={y(p.overall_score!)} r={3} fill="currentColor" className="text-indigo-500" />
            <title>{`${p.date}: ${p.overall_score}/10 (${p.conversations} convos)`}</title>
          </g>
        ))}
        {/* X labels — first, middle, last */}
        {[valid[0], valid[Math.floor(valid.length / 2)], valid[valid.length - 1]].filter(Boolean).map((p, i) => (
          <text key={i} x={x(p.date)} y={H - 4} textAnchor="middle" className="fill-zinc-500 text-[10px]">
            {p.date.slice(5)}
          </text>
        ))}
      </svg>
    </div>
  );
}

function BarList({ items, compact = false }: { items: { label: string; value: number }[]; compact?: boolean }) {
  if (!items.length) return <div className="text-xs text-zinc-500">No data.</div>;
  const max = Math.max(...items.map(i => i.value), 1);
  return (
    <div className={compact ? "space-y-1.5" : "space-y-2"}>
      {items.map(it => (
        <div key={it.label} className={compact ? "text-xs" : "text-sm"}>
          <div className="flex items-baseline justify-between">
            <span className="text-zinc-700 dark:text-zinc-300">{it.label}</span>
            <span className="font-semibold text-zinc-900 dark:text-zinc-100">{it.value.toLocaleString()}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-indigo-500"
              style={{ width: `${(it.value / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Group raw tag counts into useful display buckets — journeys,
 * playbooks, and "other notable" (link, wb, dunning, crisis, etc.)
 */
function fmtCost(cents: number): string {
  if (cents < 100) return `${cents.toFixed(2)}¢`;
  return `$${(cents / 100).toFixed(2)}`;
}

function shortenModel(m: string): string {
  if (m.includes("opus")) return "Opus 4.7";
  if (m.includes("sonnet")) return "Sonnet 4";
  if (m.includes("haiku")) return "Haiku 4.5";
  return m;
}

function bucketTags(tags: Record<string, number>) {
  const journeys: { label: string; value: number }[] = [];
  const playbooks: { label: string; value: number }[] = [];
  const other: { label: string; value: number }[] = [];

  for (const [tag, n] of Object.entries(tags)) {
    if (tag.startsWith("j:")) journeys.push({ label: tag.slice(2).replace(/_/g, " "), value: n });
    else if (tag.startsWith("pb:")) playbooks.push({ label: tag.slice(3).replace(/_/g, " "), value: n });
    else if (tag === "pb") continue; // umbrella tag — counted by specific pb:* below
    else if (tag.startsWith("w:")) playbooks.push({ label: `workflow: ${tag.slice(2)}`, value: n });
    else if (["link", "agent", "wb", "wb:success", "crisis"].includes(tag) || tag.startsWith("dunning:") || tag.startsWith("crisis:")) {
      other.push({ label: tag, value: n });
    }
  }

  return [
    { title: "Journeys", items: journeys.sort((a, b) => b.value - a.value) },
    { title: "Playbooks / workflows", items: playbooks.sort((a, b) => b.value - a.value) },
    { title: "Other flows", items: other.sort((a, b) => b.value - a.value) },
  ];
}
