"use client";

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface DashboardStats {
  open_tickets: number;
  pending_tickets: number;
  customers: number;
  avg_retention: number | null;
  ai_resolution_rate: number | null;
  tickets_today: number;
  kb_articles: number;
  macros: number;
}

export default function DashboardPage() {
  const workspace = useWorkspace();
  const [stats, setStats] = useState<DashboardStats | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/tickets?status=open&limit=1").then(r => r.json()),
      fetch("/api/tickets?status=pending&limit=1").then(r => r.json()),
      fetch(`/api/workspaces/${workspace.id}/dashboard-stats`).then(r => r.json()).catch(() => ({})),
    ]).then(([open, pending, extra]) => {
      setStats({
        open_tickets: open?.total || 0,
        pending_tickets: pending?.total || 0,
        customers: extra.customers || 0,
        avg_retention: extra.avg_retention ?? null,
        ai_resolution_rate: extra.ai_resolution_rate ?? null,
        tickets_today: extra.tickets_today || 0,
        kb_articles: extra.kb_articles || 0,
        macros: extra.macros || 0,
      });
    });
  }, [workspace.id]);

  const cards = stats ? [
    { label: "Open Tickets", value: stats.open_tickets.toLocaleString(), color: stats.open_tickets > 0 ? "text-blue-600" : "" },
    { label: "Pending Tickets", value: stats.pending_tickets.toLocaleString(), color: stats.pending_tickets > 0 ? "text-amber-600" : "" },
    { label: "Customers", value: stats.customers.toLocaleString(), color: "" },
    { label: "Avg. Retention Score", value: stats.avg_retention != null ? `${Math.round(stats.avg_retention)}/100` : "\u2014", color: "" },
    { label: "AI Resolution Rate", value: stats.ai_resolution_rate != null ? `${Math.round(stats.ai_resolution_rate * 100)}%` : "\u2014", color: "" },
    { label: "Tickets Today", value: stats.tickets_today.toLocaleString(), color: "" },
    { label: "KB Articles", value: stats.kb_articles.toLocaleString(), color: "" },
    { label: "Active Macros", value: stats.macros.toLocaleString(), color: "" },
  ] : null;

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
        Overview
      </h1>
      <p className="mt-2 text-sm text-zinc-500">
        {workspace.name}
      </p>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {(cards || [
          { label: "Open Tickets", value: "\u2014", color: "" },
          { label: "Pending Tickets", value: "\u2014", color: "" },
          { label: "Customers", value: "\u2014", color: "" },
          { label: "Avg. Retention Score", value: "\u2014", color: "" },
          { label: "AI Resolution Rate", value: "\u2014", color: "" },
          { label: "Tickets Today", value: "\u2014", color: "" },
          { label: "KB Articles", value: "\u2014", color: "" },
          { label: "Active Macros", value: "\u2014", color: "" },
        ]).map((stat) => (
          <div
            key={stat.label}
            className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <p className="text-sm font-medium text-zinc-500">{stat.label}</p>
            <p className={`mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-100 ${stat.color}`}>
              {stat.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
