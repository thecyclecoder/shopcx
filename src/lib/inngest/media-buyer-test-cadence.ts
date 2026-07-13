/**
 * media-buyer-test-cadence — the CRISP intraday freshness loop (CEO Dylan, 2026-07-12).
 *
 * The daily full-account pipeline ([[./meta-performance]] `metaPerformanceDailyCron`, 11:30 UTC) rolls up
 * the PREVIOUS day for every account. But test ads spend ~$150/day (~$6/hr), so by late-day a test may have
 * ~$100 of TODAY's spend the DB hasn't seen — a stale scorecard hides a dud that already crossed its kill
 * line, or a winner that already crossed its crown line. This cron closes that gap: every 2 hours it pulls
 * insights for ONLY the media-buyer TEST campaigns (not the whole account — cost/rate-limit scoped via
 * Graph `filtering`), including TODAY, and refreshes their scorecards. Bianca's deterministic review
 * ([[./media-buyer-cadence]]) then reads fresh data.
 *
 * Why 2h (not 1h): at ~$6/hr a 2h window is ~$12.50 of new spend — enough to matter, frequent enough to
 * crown within 2h of the $450 mark and catch a 0-conversion dud near the $300 fast-kill, without
 * over-sampling attribution-incomplete data. The DECISION stays threshold-gated (most cycles are no-ops).
 *
 * Scope: every ACTIVE `media_buyer_test_cohorts` row — per-test (Creatine/Ashwavana/Creamer) via
 * `test_meta_campaign_id`, and legacy shared-adset (Tabs) via the adset's parent campaign. Full-account /
 * previous-day stays on the daily cron.
 *
 * See docs/brain/inngest/media-buyer-test-cadence.md · [[../media-buyer/agent]] · [[../meta/performance]].
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMetaUserToken } from "@/lib/meta-ads";
import { syncMetaStructure, syncMetaInsightsForLevel } from "@/lib/meta/performance";
import { refreshScorecards } from "@/lib/meta/scorecards";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

type Admin = ReturnType<typeof createAdminClient>;

/** Days of insight history each pull refreshes — TODAY + 2 back so late attribution updates land too. */
export const TEST_CADENCE_WINDOW_DAYS = 3;

/** UTC calendar day (for the scorecard label the media-buyer loop also reads by UTC-today). */
function dayStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The calendar day (YYYY-MM-DD) at instant `d` IN the ad account's own timezone. Meta buckets insights by
 * the account's tz (the stored `snapshot_date` = Graph `date_start`), and the accounts differ (LA vs
 * Chicago), so the pull WINDOW must be account-local — otherwise late-evening-Mountain "today" (already the
 * next UTC day) would pull the wrong window near the boundary. Falls back to UTC on a bad/absent tz.
 */
export function localDayInTz(d: Date, tz: string | null | undefined): string {
  if (!tz) return dayStr(d);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return dayStr(d);
  }
}

export interface TestCadenceTarget {
  workspaceId: string;
  adAccountId: string; // meta_ad_accounts.id (our UUID) — what meta_ads/meta_adsets/scorecards key on
  metaAccountId: string; // bare Meta act id — what the Graph pull hits
  timezone: string | null; // the account's Meta timezone (America/Los_Angeles, America/Chicago, …)
  campaignIds: string[]; // the test campaigns to scope the pull to
}

/**
 * Resolve the intraday pull targets: one entry per (workspace, account) with the set of test campaign ids
 * to scope to. Per-test cohorts contribute `test_meta_campaign_id`; legacy shared-adset cohorts contribute
 * their adset's parent campaign (resolved from `meta_adsets`). A cohort missing both its account id and a
 * resolvable campaign is skipped (nothing to pull).
 */
export async function resolveTestCadenceTargets(admin: Admin): Promise<TestCadenceTarget[]> {
  const { data: cohorts, error } = await admin
    .from("media_buyer_test_cohorts")
    .select("workspace_id, meta_ad_account_id, default_meta_account_id, adset_per_test, test_meta_campaign_id, test_meta_adset_id")
    .eq("is_active", true);
  if (error) throw new Error(`media_buyer_test_cohorts read failed: ${error.message}`);

  const groups = new Map<string, { workspaceId: string; adAccountId: string; metaAccountId: string; campaignIds: Set<string> }>();
  for (const c of (cohorts ?? []) as Array<{
    workspace_id: string; meta_ad_account_id: string | null; default_meta_account_id: string | null;
    test_meta_campaign_id: string | null; test_meta_adset_id: string | null;
  }>) {
    if (!c.meta_ad_account_id || !c.default_meta_account_id) continue;
    let campaignId = c.test_meta_campaign_id;
    if (!campaignId && c.test_meta_adset_id) {
      const { data: as } = await admin.from("meta_adsets").select("meta_campaign_id").eq("meta_adset_id", c.test_meta_adset_id).maybeSingle();
      campaignId = (as as { meta_campaign_id?: string | null } | null)?.meta_campaign_id ?? null;
    }
    if (!campaignId) continue;
    const key = `${c.workspace_id}|${c.meta_ad_account_id}`;
    if (!groups.has(key)) groups.set(key, { workspaceId: c.workspace_id, adAccountId: c.meta_ad_account_id, metaAccountId: c.default_meta_account_id, campaignIds: new Set() });
    groups.get(key)!.campaignIds.add(campaignId);
  }

  // Attach each account's Meta timezone (accounts differ — LA vs Chicago) so the pull window is account-local.
  const acctIds = [...new Set([...groups.values()].map((g) => g.adAccountId))];
  const tzByAccount = new Map<string, string | null>();
  if (acctIds.length) {
    const { data: accts } = await admin.from("meta_ad_accounts").select("id, timezone").in("id", acctIds);
    for (const a of (accts ?? []) as Array<{ id: string; timezone: string | null }>) tzByAccount.set(a.id, a.timezone ?? null);
  }
  return [...groups.values()].map((g) => ({
    workspaceId: g.workspaceId,
    adAccountId: g.adAccountId,
    metaAccountId: g.metaAccountId,
    timezone: tzByAccount.get(g.adAccountId) ?? null,
    campaignIds: [...g.campaignIds],
  }));
}

export const mediaBuyerTestCadenceCron = inngest.createFunction(
  {
    id: "media-buyer-test-cadence",
    retries: 1,
    triggers: [{ cron: "0 */2 * * *" }, { event: "growth/media-buyer-test-cadence" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();
    const targets = await step.run("resolve-targets", async () => resolveTestCadenceTargets(admin));
    if (!targets.length) {
      await step.run("emit-heartbeat", async () => {
        await emitCronHeartbeat("media-buyer-test-cadence", { ok: true, produced: { targets: 0 }, detail: "no active test cohorts" });
      });
      return { targets: 0, note: "no active test cohorts" };
    }

    const now = new Date();
    // Scorecard LABEL stays UTC-today so it matches the media-buyer loop's snapshot read; the pull WINDOW
    // is account-local so each account's current ad-day (LA vs Chicago) is always included near the UTC boundary.
    const scorecardDate = dayStr(now);

    const results: unknown[] = [];
    for (const t of targets) {
      const r = await step.run(`pull-${t.adAccountId}`, async () => {
        const token = await getMetaUserToken(t.workspaceId);
        if (!token) return { account: t.metaAccountId, error: "no_token" };
        const until = localDayInTz(now, t.timezone); // account-local today
        const since = localDayInTz(new Date(now.getTime() - (TEST_CADENCE_WINDOW_DAYS - 1) * 86400000), t.timezone);
        const p = { workspaceId: t.workspaceId, adAccountId: t.adAccountId, metaAccountId: t.metaAccountId, accessToken: token };
        const struct = await syncMetaStructure(p, { campaignIds: t.campaignIds });
        const adset = await syncMetaInsightsForLevel(p, "adset", since, until, { campaignIds: t.campaignIds });
        const ad = await syncMetaInsightsForLevel(p, "ad", since, until, { campaignIds: t.campaignIds });
        const sc = await refreshScorecards({ workspaceId: t.workspaceId, adAccountId: t.adAccountId }, { snapshotDate: scorecardDate });
        // Fresh scorecards → fire Bianca's deterministic review for this workspace (part 2 of the loop).
        await inngest.send({ name: "growth/media-buyer-cadence-sweep", data: { workspace_id: t.workspaceId, trigger: "test-cadence" } });
        return { account: t.metaAccountId, tz: t.timezone, window: { since, until }, campaigns: t.campaignIds.length, adsets: struct.adsets, adsetInsightRows: adset.rows, adInsightRows: ad.rows, scorecardRows: sc.rows };
      });
      results.push(r);
    }
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("media-buyer-test-cadence", { ok: true, produced: { targets: targets.length }, detail: `pulled ${targets.length} account(s) for ${scorecardDate}` });
    });
    return { targets: targets.length, scorecardDate, results };
  },
);
