"use client";

// Growth Director → Media Buyer cohorts tile (media-buyer-armed-flip-surface Phase 2).
//
// Renders every active media_buyer_test_cohorts row for the workspace joined to the currently
// active iteration_policies mode + newest media_buyer_arming_authorization + newest
// media_buyer_sensor_trust snapshot. Owner-role members see Arm / Disarm buttons; the Arm
// button is enabled ONLY when the newest authorization is `allowed=true` AND fresh
// (`expires_at > now()`). Non-owner members see read-only badges.
//
// Buttons call the Phase 1 route (POST /api/growth/media-buyer/arm) with the cohort's
// meta_ad_account_id and direction:'arm' | 'disarm'; on success we reload the tile so the
// rendered mode reflects the mutation.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface CohortRow {
  id: string;
  meta_ad_account_id: string | null;
  test_meta_adset_id: string;
  daily_test_ceiling_cents: number;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface PolicySummary {
  id: string;
  version: number;
  status: string;
  mode: "shadow" | "armed";
}

interface AuthorizationSummary {
  id: string;
  allowed: boolean;
  reasons: unknown;
  iso_week: string;
  evaluated_at: string;
  expires_at: string;
  fresh: boolean;
}

interface SensorTrustSummary {
  id: string;
  snapshot_date: string;
  band: "green" | "yellow" | "red";
  reasons: unknown;
  window_days: number;
  coverage_ratio: number | null;
  updated_at: string;
}

interface GradeRollup {
  metaAdAccountId: string;
  count: number;
  avgOverallGrade: number | null;
  dailyOverallAvg14d: { date: string; avg: number }[];
}

interface EnrichedCohort {
  cohort: CohortRow;
  policy: PolicySummary | null;
  authorization: AuthorizationSummary | null;
  sensor_trust: SensorTrustSummary | null;
  grades?: GradeRollup | null;
}

/** Minimal inline sparkline of the 14-day daily avg overall grade (0–10 scale). */
function Sparkline({ points }: { points: { date: string; avg: number }[] }) {
  if (points.length < 2) return null;
  const w = 96, h = 20, max = 10;
  const step = w / (points.length - 1);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - (p.avg / max) * h).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="text-indigo-500" data-testid="mb-grade-sparkline" aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

interface CohortsResponse {
  cohorts: EnrichedCohort[];
  policyWide: PolicySummary | null;
  workspace_authorization?: AuthorizationSummary | null;
  workspace_sensor_trust?: SensorTrustSummary | null;
}

function ModeBadge({ mode }: { mode: "shadow" | "armed" | null }) {
  if (!mode) {
    return (
      <span
        className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
        data-testid="mb-mode-badge"
      >
        no policy
      </span>
    );
  }
  const armed = mode === "armed";
  return (
    <span
      className={
        armed
          ? "rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
          : "rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900 dark:text-amber-200"
      }
      data-testid="mb-mode-badge"
    >
      {armed ? "ARMED" : "SHADOW"}
    </span>
  );
}

function BandBadge({ band }: { band: "green" | "yellow" | "red" | null }) {
  if (!band) {
    return (
      <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
        no trust snapshot
      </span>
    );
  }
  const cls =
    band === "green"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
      : band === "yellow"
        ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
        : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
  return <span className={`rounded px-2 py-0.5 text-xs font-semibold ${cls}`}>trust {band}</span>;
}

function reasonsToLabels(reasons: unknown): string[] {
  if (!reasons) return [];
  if (Array.isArray(reasons)) {
    return reasons.map((r) => {
      if (typeof r === "string") return r;
      if (r && typeof r === "object") {
        const code = (r as { code?: unknown }).code;
        return typeof code === "string" ? code : JSON.stringify(r);
      }
      return String(r);
    });
  }
  if (typeof reasons === "object") {
    const bag = reasons as Record<string, unknown>;
    if (Array.isArray(bag.reasons)) return reasonsToLabels(bag.reasons);
  }
  return [];
}

export default function MediaBuyerCohortsPage() {
  const workspace = useWorkspace();
  const isOwner = workspace.role === "owner";

  const [data, setData] = useState<CohortsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/growth/media-buyer/cohorts?workspaceId=${workspace.id}`);
      if (!res.ok) {
        setError(`Failed to load cohorts (${res.status})`);
        setData(null);
        return;
      }
      const body = (await res.json()) as CohortsResponse;
      setData(body);
    } finally {
      setLoading(false);
    }
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  const post = useCallback(
    async (
      direction: "arm" | "disarm",
      metaAdAccountId: string | null,
      key: string,
    ) => {
      setBusyKey(key);
      setFlash(null);
      try {
        const res = await fetch("/api/growth/media-buyer/arm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workspace_id: workspace.id,
            meta_ad_account_id: metaAdAccountId,
            direction,
            reason: direction === "disarm" ? "manual" : undefined,
          }),
        });
        if (res.status === 202) {
          const body = (await res.json().catch(() => ({}))) as { routed_to?: string; job_id?: string | null };
          setFlash(`Arm request routed to ${body.routed_to || "supervisor"} for approval.`);
        } else if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
          setFlash(`${direction === "arm" ? "Arm" : "Disarm"} failed: ${body.error || res.statusText}${body.detail ? ` (${body.detail})` : ""}`);
        } else {
          setFlash(`${direction === "arm" ? "Armed" : "Disarmed"} the cohort.`);
        }
        await load();
      } finally {
        setBusyKey(null);
      }
    },
    [workspace.id, load],
  );

  const cohortCards: EnrichedCohort[] = (() => {
    if (!data) return [];
    if (data.cohorts.length > 0) return data.cohorts;
    return [
      {
        cohort: {
          id: `${workspace.id}-workspace-wide`,
          meta_ad_account_id: null,
          test_meta_adset_id: "(no cohort configured)",
          daily_test_ceiling_cents: 0,
          is_active: false,
          notes: null,
          created_at: "",
          updated_at: "",
        },
        policy: data.policyWide ?? null,
        authorization: data.workspace_authorization ?? null,
        sensor_trust: data.workspace_sensor_trust ?? null,
      },
    ];
  })();

  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Media Buyer cohorts</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Flip Media Buyer cohorts between shadow (audit-only) and armed (executor may act). The Arm
            button requires a fresh + allowed arming authorization; Disarm is always available.
          </p>
        </div>
        <Link href="/dashboard/marketing/ads" className="text-sm text-indigo-600 hover:underline">
          ← Ads
        </Link>
      </div>

      {!isOwner ? (
        <p className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Arm / Disarm buttons are owner-only. You have read-only access to this tile.
        </p>
      ) : null}

      {flash ? <p className="mb-3 text-sm text-indigo-700 dark:text-indigo-300">{flash}</p> : null}
      {error ? <p className="mb-3 text-sm text-red-600">{error}</p> : null}

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : cohortCards.length === 0 ? (
        <p className="text-sm text-zinc-500">No media_buyer_test_cohorts rows yet.</p>
      ) : (
        <ul className="space-y-3">
          {cohortCards.map((row) => {
            const cohort = row.cohort;
            const policy = row.policy;
            const authorization = row.authorization;
            const trust = row.sensor_trust;
            const key = cohort.id;
            const armEnabled = isOwner && !!authorization && authorization.allowed === true && authorization.fresh === true;
            const armReason = !authorization
              ? "no authorization yet"
              : !authorization.allowed
                ? "authorization not allowed"
                : !authorization.fresh
                  ? "authorization expired"
                  : null;
            const reasonLabels = reasonsToLabels(authorization?.reasons);
            const disarmEnabled = isOwner;
            const isBusy = busyKey === key;
            return (
              <li
                key={key}
                className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
                data-testid="mb-cohort-card"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        Cohort {cohort.test_meta_adset_id}
                      </h3>
                      <ModeBadge mode={policy?.mode ?? null} />
                      <BandBadge band={trust?.band ?? null} />
                    </div>
                    <p className="mt-1 text-xs text-zinc-500">
                      {cohort.meta_ad_account_id ? `account ${cohort.meta_ad_account_id.slice(0, 8)} · ` : "workspace-wide · "}
                      ceiling ${(cohort.daily_test_ceiling_cents / 100).toFixed(2)}/day
                      {policy ? ` · policy v${policy.version}` : " · no active policy"}
                    </p>
                    {cohort.meta_ad_account_id ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" data-testid="mb-cohort-grades">
                        {row.grades && row.grades.count > 0 ? (
                          <>
                            <span className="text-zinc-600 dark:text-zinc-400">
                              avg grade{" "}
                              <span className="font-semibold text-zinc-900 dark:text-zinc-100">{row.grades.avgOverallGrade}/10</span>
                              <span className="text-zinc-400"> · {row.grades.count} graded (30d)</span>
                            </span>
                            <Sparkline points={row.grades.dailyOverallAvg14d} />
                          </>
                        ) : (
                          <span className="text-zinc-400" data-testid="mb-cohort-grades-empty">no graded actions yet</span>
                        )}
                        <Link
                          href={`/dashboard/growth/media-buyer/${cohort.meta_ad_account_id}`}
                          className="text-indigo-600 hover:underline dark:text-indigo-400"
                        >
                          View grades →
                        </Link>
                      </div>
                    ) : null}
                    <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                      {authorization ? (
                        <>
                          <span
                            className={
                              authorization.allowed
                                ? "font-semibold text-emerald-700 dark:text-emerald-300"
                                : "font-semibold text-red-700 dark:text-red-300"
                            }
                            data-testid="mb-auth-allowed"
                          >
                            authorization {authorization.allowed ? "allowed" : "denied"}
                          </span>
                          {" · "}
                          <span data-testid="mb-auth-fresh">{authorization.fresh ? "fresh" : "stale"}</span>
                          {authorization.iso_week ? ` · ${authorization.iso_week}` : null}
                          {authorization.expires_at
                            ? ` · expires ${new Date(authorization.expires_at).toLocaleString()}`
                            : null}
                          {reasonLabels.length > 0 ? (
                            <ul className="mt-1 list-disc pl-4 text-xs text-zinc-500" data-testid="mb-auth-reasons">
                              {reasonLabels.slice(0, 5).map((r, i) => (
                                <li key={`${r}-${i}`}>{r}</li>
                              ))}
                            </ul>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <span className="font-semibold text-zinc-500 dark:text-zinc-400" data-testid="mb-auth-allowed">
                            no arming authorization yet
                          </span>
                          {" · "}
                          <span data-testid="mb-auth-fresh">—</span>
                          <ul className="mt-1 list-disc pl-4 text-xs text-zinc-500" data-testid="mb-auth-reasons">
                            <li>no authorization has been evaluated for this cohort</li>
                          </ul>
                        </>
                      )}
                    </div>
                    {trust ? (
                      <p className="mt-1 text-xs text-zinc-500">
                        sensor snapshot {trust.snapshot_date} · window {trust.window_days}d
                        {trust.coverage_ratio != null ? ` · coverage ${(trust.coverage_ratio * 100).toFixed(0)}%` : null}
                      </p>
                    ) : null}
                  </div>
                  {isOwner ? (
                    <div className="flex shrink-0 gap-2" data-testid="mb-owner-buttons">
                      <button
                        type="button"
                        disabled={!armEnabled || isBusy}
                        onClick={() => post("arm", cohort.meta_ad_account_id, key)}
                        title={armReason ?? "Arm the cohort"}
                        className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid="mb-arm-button"
                      >
                        Arm
                      </button>
                      <button
                        type="button"
                        disabled={!disarmEnabled || isBusy}
                        onClick={() => post("disarm", cohort.meta_ad_account_id, key)}
                        className="rounded bg-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-800 hover:bg-zinc-300 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-200"
                        data-testid="mb-disarm-button"
                      >
                        Disarm
                      </button>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
