/**
 * grade-rollup — per-ad-account rollups of [[media_buyer_action_grades]] for the Growth dashboard
 * (media-buyer-grade-rollup-on-growth-director-brief Phase 2). The grades table keys by
 * `source_meta_ad_id` (the graded creative), NOT by account — so we map ad → account through
 * [[meta_ads]] (`meta_ad_id` → `meta_ad_account_id`, both the internal-UUID form the cohorts tile
 * uses) and group. Feeds the cohorts tile (`avgOverallGrade` + 14-day sparkline per cohort) and the
 * per-account detail page (last-N grades). READ-ONLY.
 *
 * Sibling of [[../agents/growth-director]] `loadMediaBuyerRollup` (the by-action_kind brief rollup) —
 * same table, different grouping (by account here vs by verb there). An empty table yields zero rows /
 * null averages so callers render a "no graded actions yet" placeholder rather than a broken chart.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface AccountGradeRollup {
  metaAdAccountId: string;
  count: number;
  /** 30-day average `overall_grade` for this account's graded actions (null when none). */
  avgOverallGrade: number | null;
  /** Daily average `overall_grade` over the last 14 days — the cohort-row sparkline (chronological). */
  dailyOverallAvg14d: { date: string; avg: number }[];
}

export interface AccountGradeRow {
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

interface GradeRecord {
  id: string;
  action_kind: string;
  source_meta_ad_id: string | null;
  decision_quality: number;
  outcome_quality: number;
  overall_grade: number;
  realized_roas: number | null;
  graded_at: string;
  reasoning: string | null;
}

/** meta_ad_id → meta_ad_account_id for the workspace (internal-UUID account form). */
async function adToAccount(admin: Admin, workspaceId: string): Promise<Map<string, string>> {
  const { data } = await admin
    .from("meta_ads")
    .select("meta_ad_id, meta_ad_account_id")
    .eq("workspace_id", workspaceId);
  const m = new Map<string, string>();
  for (const r of (data ?? []) as { meta_ad_id: string; meta_ad_account_id: string | null }[]) {
    if (r.meta_ad_id && r.meta_ad_account_id) m.set(r.meta_ad_id, r.meta_ad_account_id);
  }
  return m;
}

/** Per-account rollups (avg overall grade + 14-day sparkline) for the given accounts, over the last 30
 *  days. Accounts with zero grades get a zeroed row (count 0, null avg) so the tile can placeholder. */
export async function loadAccountGradeRollups(
  admin: Admin,
  workspaceId: string,
  accountIds: string[],
): Promise<Map<string, AccountGradeRollup>> {
  const out = new Map<string, AccountGradeRollup>();
  for (const id of accountIds) out.set(id, { metaAdAccountId: id, count: 0, avgOverallGrade: null, dailyOverallAvg14d: [] });
  if (accountIds.length === 0) return out;

  const [adAccount, { data: grades }] = await Promise.all([
    adToAccount(admin, workspaceId),
    admin
      .from("media_buyer_action_grades")
      .select("source_meta_ad_id, overall_grade, graded_at")
      .eq("workspace_id", workspaceId)
      .gte("graded_at", new Date(Date.now() - 30 * 864e5).toISOString())
      .order("graded_at", { ascending: true }),
  ]);

  const wanted = new Set(accountIds);
  // account → { sum, n } for the 30d avg + day → { sum, n } for the 14d sparkline
  const acc = new Map<string, { sum: number; n: number; byDay: Map<string, { sum: number; n: number }> }>();
  const day14Cutoff = Date.now() - 14 * 864e5;
  for (const g of (grades ?? []) as Pick<GradeRecord, "source_meta_ad_id" | "overall_grade" | "graded_at">[]) {
    const account = g.source_meta_ad_id ? adAccount.get(g.source_meta_ad_id) : undefined;
    if (!account || !wanted.has(account)) continue;
    const bucket = acc.get(account) ?? { sum: 0, n: 0, byDay: new Map() };
    bucket.sum += g.overall_grade;
    bucket.n += 1;
    if (new Date(g.graded_at).getTime() >= day14Cutoff) {
      const day = g.graded_at.slice(0, 10);
      const d = bucket.byDay.get(day) ?? { sum: 0, n: 0 };
      d.sum += g.overall_grade;
      d.n += 1;
      bucket.byDay.set(day, d);
    }
    acc.set(account, bucket);
  }

  for (const [account, b] of acc) {
    out.set(account, {
      metaAdAccountId: account,
      count: b.n,
      avgOverallGrade: b.n > 0 ? Number((b.sum / b.n).toFixed(2)) : null,
      dailyOverallAvg14d: Array.from(b.byDay.entries())
        .sort((x, y) => x[0].localeCompare(y[0]))
        .map(([date, d]) => ({ date, avg: Number((d.sum / d.n).toFixed(2)) })),
    });
  }
  return out;
}

/** The last `limit` graded actions for ONE account (newest first), for the detail page's table.
 *  Maps grades → account via meta_ads; returns [] when the account has no grades. */
export async function loadAccountGrades(
  admin: Admin,
  workspaceId: string,
  metaAdAccountId: string,
  limit = 50,
): Promise<AccountGradeRow[]> {
  const adAccount = await adToAccount(admin, workspaceId);
  const adIds = [...adAccount.entries()].filter(([, a]) => a === metaAdAccountId).map(([adId]) => adId);
  if (adIds.length === 0) return [];
  const { data } = await admin
    .from("media_buyer_action_grades")
    .select("id, action_kind, source_meta_ad_id, decision_quality, outcome_quality, overall_grade, realized_roas, graded_at, reasoning")
    .eq("workspace_id", workspaceId)
    .in("source_meta_ad_id", adIds)
    .order("graded_at", { ascending: false })
    .limit(limit);
  return ((data ?? []) as GradeRecord[]).map((g) => ({
    id: g.id,
    actionKind: g.action_kind,
    sourceMetaAdId: g.source_meta_ad_id,
    decisionQuality: g.decision_quality,
    outcomeQuality: g.outcome_quality,
    overallGrade: g.overall_grade,
    realizedRoas: g.realized_roas,
    gradedAt: g.graded_at,
    reasoning: g.reasoning,
  }));
}
