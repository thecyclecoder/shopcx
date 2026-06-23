"use client";

/**
 * Storefront test detail — both-version previews + per-arm funnel
 * (docs/brain/specs/storefront-test-detail-page.md Phase 1).
 *
 * Each arm side by side: an owner-only preview link (forces that arm, exposure-
 * excluded) + the full funnel (sessions, engagement %, ATC, lead, conversion,
 * sub-attach, predicted-LTV/visitor, rev/visitor) with lift vs control + the bandit
 * win-probability. The numbers match what the bandit decides on (same rollup source).
 *
 * Reads /api/workspaces/[id]/storefront-experiments/[experimentId] (owner/admin only).
 */

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface Arm {
  variant_id: string;
  label: string;
  is_control: boolean;
  sessions: number;
  engagement_rate: number;
  atc_rate: number;
  lead_rate: number;
  conversion_rate: number;
  sub_attach_rate: number;
  revenue_per_visitor_cents: number;
  ltv_per_visitor_cents: number;
  win_prob: number | null;
  preview_url: string | null;
}

interface DetailResponse {
  experiment: {
    id: string;
    lander_type: string;
    audience: string;
    lever: string;
    hypothesis: string | null;
    status: string;
    holdout_pct: number;
    promoted_variant_id: string | null;
    started_at: string | null;
    rolled_back_at: string | null;
    rollback_reason: string | null;
    created_at: string | null;
  };
  product: { id: string; title: string | null; handle: string | null } | null;
  arms: Arm[];
}

const STATUS_STYLE: Record<string, string> = {
  running: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  promoted: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  draft: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  killed: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  rolled_back: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
};

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const int = (n: number) => n.toLocaleString();

type MetricKey = keyof Pick<
  Arm,
  | "sessions"
  | "engagement_rate"
  | "atc_rate"
  | "lead_rate"
  | "conversion_rate"
  | "sub_attach_rate"
  | "ltv_per_visitor_cents"
  | "revenue_per_visitor_cents"
>;

const METRICS: { key: MetricKey; label: string; fmt: (n: number) => string; lift: boolean }[] = [
  { key: "sessions", label: "Sessions", fmt: int, lift: false },
  { key: "engagement_rate", label: "Engagement %", fmt: pct, lift: true },
  { key: "atc_rate", label: "Add-to-cart rate", fmt: pct, lift: true },
  { key: "lead_rate", label: "Lead rate", fmt: pct, lift: true },
  { key: "conversion_rate", label: "Conversion rate", fmt: pct, lift: true },
  { key: "sub_attach_rate", label: "Sub-attach rate", fmt: pct, lift: true },
  { key: "ltv_per_visitor_cents", label: "Predicted LTV / visitor", fmt: money, lift: true },
  { key: "revenue_per_visitor_cents", label: "Revenue / visitor", fmt: money, lift: true },
];

/** Lift of an arm's metric vs control, as a signed percentage. Null when control is
 *  zero (no baseline to lift from) or the arm is the control. */
function liftLabel(armVal: number, controlVal: number): { text: string; cls: string } | null {
  if (controlVal === 0) return null;
  const lift = (armVal - controlVal) / controlVal;
  const text = `${lift >= 0 ? "+" : ""}${(lift * 100).toFixed(0)}%`;
  const cls =
    lift > 0.0001
      ? "text-emerald-600 dark:text-emerald-400"
      : lift < -0.0001
        ? "text-rose-600 dark:text-rose-400"
        : "text-zinc-400";
  return { text, cls };
}

export default function StorefrontTestDetailPage() {
  const workspace = useWorkspace();
  const { experimentId } = useParams<{ experimentId: string }>();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await fetch(`/api/workspaces/${workspace.id}/storefront-experiments/${experimentId}`);
    if (res.ok) {
      setData(await res.json());
    } else if (res.status === 403) {
      setError("Only an owner or admin can view this test.");
    } else if (res.status === 404) {
      setError("Test not found.");
    } else {
      setError("Failed to load this test.");
    }
    setLoading(false);
  }, [workspace.id, experimentId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        <p className="text-sm text-zinc-400">Loading…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        <Link
          href="/dashboard/storefront/optimizer/tests"
          className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
        >
          ← All tests
        </Link>
        <p className="mt-4 text-sm text-rose-600 dark:text-rose-400">{error ?? "Test not found."}</p>
      </div>
    );
  }

  const { experiment, product, arms } = data;
  const control = arms.find((a) => a.is_control) ?? null;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
      <Link
        href="/dashboard/storefront/optimizer/tests"
        className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
      >
        ← All tests
      </Link>

      {/* ── Header / status ───────────────────────────────────────────── */}
      <header className="mt-3 mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
              STATUS_STYLE[experiment.status] ?? STATUS_STYLE.draft
            }`}
          >
            {experiment.status.replace("_", " ")}
          </span>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {experiment.lander_type}
          </span>
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            lever: {experiment.lever || "—"}
          </span>
          {experiment.audience && (
            <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-800">
              {experiment.audience}
            </span>
          )}
        </div>
        <h1 className="mt-3 text-xl font-bold text-zinc-900 dark:text-zinc-100">
          {experiment.hypothesis || product?.title || "Storefront test"}
        </h1>
        <p className="mt-1 text-xs text-zinc-500">
          {product?.title ? `${product.title} · ` : ""}
          holdout {(experiment.holdout_pct * 100).toFixed(0)}%
          {experiment.started_at ? ` · started ${new Date(experiment.started_at).toLocaleDateString()}` : ""}
        </p>
        {experiment.status === "rolled_back" && experiment.rollback_reason && (
          <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
            Rolled back: {experiment.rollback_reason}
          </p>
        )}
        <p className="mt-3 text-xs text-zinc-400">
          The autonomous bandit drives promote/kill from these same numbers — this page is to observe
          and preview.
        </p>
      </header>

      {arms.length === 0 ? (
        <p className="text-sm text-zinc-400">This test has no arms.</p>
      ) : (
        <>
          {/* ── Preview links per arm ───────────────────────────────────── */}
          <section className="mb-6 grid gap-3 sm:grid-cols-2">
            {arms.map((a) => (
              <div
                key={a.variant_id}
                className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{a.label}</span>
                  {a.is_control ? (
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-800">
                      control
                    </span>
                  ) : a.variant_id === experiment.promoted_variant_id ? (
                    <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                      promoted
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  {a.is_control ? "What shoppers see today." : "The generated variant."}
                </p>
                {a.preview_url ? (
                  <a
                    href={a.preview_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700"
                  >
                    Preview this version ↗
                  </a>
                ) : (
                  <p className="mt-2 text-xs text-zinc-400">Preview unavailable (no storefront URL).</p>
                )}
              </div>
            ))}
          </section>

          {/* ── Per-arm funnel ──────────────────────────────────────────── */}
          <section className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  <th className="px-4 py-2 text-left text-xs font-semibold text-zinc-500">Metric</th>
                  {arms.map((a) => (
                    <th key={a.variant_id} className="px-4 py-2 text-right text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                      {a.label}
                      {a.is_control && <span className="ml-1 font-normal text-zinc-400">(control)</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {METRICS.map((m) => (
                  <tr key={m.key} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                    <td className="px-4 py-2 text-left text-xs text-zinc-500">{m.label}</td>
                    {arms.map((a) => {
                      const lift =
                        m.lift && control && !a.is_control
                          ? liftLabel(a[m.key], control[m.key])
                          : null;
                      return (
                        <td key={a.variant_id} className="px-4 py-2 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                          {m.fmt(a[m.key])}
                          {lift && <span className={`ml-2 text-[11px] ${lift.cls}`}>{lift.text}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {/* Win-probability vs control (bandit posterior). */}
                <tr className="border-t border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
                  <td className="px-4 py-2 text-left text-xs font-medium text-zinc-600 dark:text-zinc-300">
                    Win-probability vs control
                  </td>
                  {arms.map((a) => (
                    <td key={a.variant_id} className="px-4 py-2 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                      {a.is_control || a.win_prob == null ? (
                        <span className="text-zinc-400">—</span>
                      ) : (
                        pct(a.win_prob)
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </section>
          <p className="mt-2 text-[11px] text-zinc-400">
            Outcome counts (conversion, sub-attach, revenue, predicted LTV) are read from the same
            rollups the bandit decides on. Engagement %, add-to-cart and lead rates are derived from
            on-site events for the exposed sessions. Win-probability is the Monte-Carlo posterior the
            bandit uses to promote/kill.
          </p>
        </>
      )}
    </div>
  );
}
