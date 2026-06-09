"use client";

/**
 * Migrations monitor — "what's stuck?" for Appstle→internal migrations.
 *
 * North star: a `failed` row is a renewal at risk. This page surfaces failed +
 * pending audits with their failing checks so they get fixed before the next
 * renewal. See specs/appstle-pricing-heal-and-migration-monitor.md § Phase 3.
 */

import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Check { key: string; ok: boolean; detail?: string }
interface Audit {
  id: string;
  subscription_id: string;
  appstle_contract_id: string | null;
  internal_contract_id: string | null;
  is_recovery: boolean;
  status: string;
  checks: Check[];
  retry_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
interface Resp {
  counts: { passed: number; pending: number; failed: number; total: number };
  atRisk: Audit[];
  recentPassed: Audit[];
}

export default function MigrationsPage() {
  const workspace = useWorkspace();
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch("/api/migrations")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [workspace.id]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold text-zinc-900">Migrations</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Appstle→internal migration health. A <strong>failed</strong> row is a renewal at risk — fix it before the next bill.
      </p>

      {loading ? (
        <div className="mt-6 rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500">Loading…</div>
      ) : !data ? (
        <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">Couldn’t load migrations.</div>
      ) : (
        <>
          {/* Counts */}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Total" value={data.counts.total} tone="zinc" />
            <Stat label="Passed" value={data.counts.passed} tone="emerald" />
            <Stat label="Pending" value={data.counts.pending} tone="amber" />
            <Stat label="Failed" value={data.counts.failed} tone="rose" />
          </div>

          {/* At-risk */}
          <h2 className="mt-8 text-sm font-semibold uppercase tracking-wider text-zinc-500">Needs attention</h2>
          {data.atRisk.length === 0 ? (
            <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center text-sm font-medium text-emerald-800">
              ✅ Nothing stuck — every migration passed.
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              {data.atRisk.map((a) => (
                <AuditCard key={a.id} a={a} />
              ))}
            </div>
          )}

          {/* Recent passed */}
          {data.recentPassed.length > 0 && (
            <>
              <h2 className="mt-8 text-sm font-semibold uppercase tracking-wider text-zinc-500">Recently passed</h2>
              <div className="mt-3 space-y-2">
                {data.recentPassed.map((a) => (
                  <div key={a.id} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm">
                    <span className="font-mono text-xs text-zinc-600">{a.subscription_id.slice(0, 8)} · {a.internal_contract_id}</span>
                    <span className="flex items-center gap-2 text-zinc-500">
                      {a.is_recovery && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-700">Recovery</span>}
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">Passed</span>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "zinc" | "emerald" | "amber" | "rose" }) {
  const tones: Record<string, string> = {
    zinc: "border-zinc-200 bg-white text-zinc-900",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    rose: "border-rose-200 bg-rose-50 text-rose-800",
  };
  return (
    <div className={`rounded-xl border p-4 ${tones[tone]}`}>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs font-semibold uppercase tracking-wider opacity-80">{label}</div>
    </div>
  );
}

function AuditCard({ a }: { a: Audit }) {
  const failed = (a.checks || []).filter((c) => !c.ok);
  const isFailed = a.status === "failed";
  return (
    <article className={`rounded-xl border p-4 ${isFailed ? "border-rose-200 bg-rose-50" : "border-amber-200 bg-amber-50"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-xs text-zinc-700">
          sub {a.subscription_id.slice(0, 8)} · {a.appstle_contract_id} → {a.internal_contract_id}
        </div>
        <div className="flex items-center gap-2">
          {a.is_recovery && <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-700">Recovery</span>}
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${isFailed ? "bg-rose-200 text-rose-800" : "bg-amber-200 text-amber-800"}`}>
            {a.status} · retry {a.retry_count}
          </span>
        </div>
      </div>
      <ul className="mt-3 space-y-1">
        {(a.checks || []).map((c) => (
          <li key={c.key} className="flex items-start gap-2 text-xs">
            <span>{c.ok ? "✅" : "❌"}</span>
            <span className={c.ok ? "text-zinc-600" : "font-medium text-rose-800"}>
              {c.key}
              {c.detail ? <span className="font-normal text-zinc-500"> — {c.detail}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {failed.length > 0 && <p className="mt-2 text-xs text-rose-700">{failed.length} check(s) failing.</p>}
    </article>
  );
}
