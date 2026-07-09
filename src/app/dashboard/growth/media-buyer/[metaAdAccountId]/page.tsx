"use client";

// Growth Director → Media Buyer per-account grade detail (media-buyer-grade-rollup-on-growth-director-brief
// Phase 2). Renders the last 50 graded actions for one ad account with decisionQuality + outcomeQuality
// columns (the two orthogonal axes from [[media_buyer_action_grades]]). Zero grades → a
// "no graded actions yet" placeholder rather than a broken table. Read-only; data via
// GET /api/growth/media-buyer/grades.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface GradeRow {
  id: string;
  actionKind: string;
  sourceMetaAdId: string | null;
  decisionQuality: number;
  outcomeQuality: number;
  overallGrade: number;
  realizedRoas: number | null;
  gradedAt: string;
  reasoning: string | null;
}

function QualityCell({ value }: { value: number }) {
  const tone = value >= 8 ? "text-emerald-700 dark:text-emerald-300" : value >= 5 ? "text-amber-700 dark:text-amber-300" : "text-red-700 dark:text-red-300";
  return <span className={`font-semibold ${tone}`}>{value}/10</span>;
}

export default function MediaBuyerAccountDetailPage() {
  const workspace = useWorkspace();
  const params = useParams<{ metaAdAccountId: string }>();
  const metaAdAccountId = params?.metaAdAccountId ?? "";
  const [grades, setGrades] = useState<GradeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/growth/media-buyer/grades?workspaceId=${workspace.id}&account=${encodeURIComponent(metaAdAccountId)}`);
        if (!res.ok) { if (alive) setError(`Failed to load grades (${res.status})`); return; }
        const json = (await res.json()) as { grades: GradeRow[] };
        if (alive) setGrades(json.grades ?? []);
      } catch {
        if (alive) setError("Failed to load grades");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [workspace.id, metaAdAccountId]);

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="mb-4 flex items-center gap-3">
        <Link href="/dashboard/growth/media-buyer" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
          ← Cohorts
        </Link>
      </div>
      <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Media Buyer grades</h1>
      <p className="mt-1 text-xs text-zinc-500">account {metaAdAccountId.slice(0, 8)} · last 50 graded actions</p>

      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

      {loading ? (
        <p className="mt-4 text-sm text-zinc-500">Loading…</p>
      ) : !grades || grades.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700" data-testid="mb-grades-empty">
          No graded actions yet.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs" data-testid="mb-grades-table">
            <thead>
              <tr className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
                <th className="py-2 pr-3">Action</th>
                <th className="py-2 pr-3">Ad</th>
                <th className="py-2 pr-3">Decision quality</th>
                <th className="py-2 pr-3">Outcome quality</th>
                <th className="py-2 pr-3">Overall</th>
                <th className="py-2 pr-3">Realized ROAS</th>
                <th className="py-2 pr-3">Graded</th>
              </tr>
            </thead>
            <tbody>
              {grades.map((g) => (
                <tr key={g.id} className="border-b border-zinc-100 dark:border-zinc-900">
                  <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-300">{g.actionKind.replace(/^media_buyer_/, "")}</td>
                  <td className="py-2 pr-3 text-zinc-500">{g.sourceMetaAdId ? g.sourceMetaAdId.slice(-8) : "—"}</td>
                  <td className="py-2 pr-3"><QualityCell value={g.decisionQuality} /></td>
                  <td className="py-2 pr-3"><QualityCell value={g.outcomeQuality} /></td>
                  <td className="py-2 pr-3 font-semibold text-zinc-900 dark:text-zinc-100">{g.overallGrade}/10</td>
                  <td className="py-2 pr-3 text-zinc-600 dark:text-zinc-400">{g.realizedRoas == null ? "—" : `${g.realizedRoas.toFixed(2)}×`}</td>
                  <td className="py-2 pr-3 text-zinc-500">{g.gradedAt.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
