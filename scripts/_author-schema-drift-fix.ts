import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "media-buyer-schema-drift-meta-ads-spend-and-publish-job-campaign-id",
    {
      title: "Fix two live schema-drift Postgres errors in Bianca's code: meta_ads.spend_cents and ad_publish_jobs.ad_campaign_id",
      why: "Supabase Postgres logs show two schema-mismatch errors firing on every media-buyer pass (24 occurrences in one hour). First: three lookups query the meta_ads table for a spend_cents column that does not exist there — spend lives in meta_insights_daily — so the dominant-child-ad resolution errors and silently falls back to naming the ad set instead of the winning creative in the crown/kill/reactivation audit. Second: the creative-learning outcome stamper filters ad_publish_jobs on an ad_campaign_id column that does not exist (the real column is campaign_id), so stampCreativeOutcome throws and the creative-learning flywheel never records won/lost/reactivated for any adset-resolved ad. Both degrade Bianca's accuracy and spam the error log.",
      what: "Resolve the dominant child ad from meta_insights_daily (which has spend_cents) instead of meta_ads, via one shared helper used by all three sites; and correct the ad_publish_jobs column reference from ad_campaign_id to campaign_id in the creative-learning outcome stamper.",
      summary: "In src/lib/media-buyer/meta-cpa-signal.ts replace the three `.from('meta_ads').select('meta_ad_id, spend_cents').order('spend_cents')` lookups (resolveWinnerSource ~137, detectMetaCpaLosers ~297, detectMetaCpaReactivations ~383) with a helper that reads spend from meta_insights_daily (level='ad'); in src/lib/ads/creative-learning.ts stampCreativeOutcome change the ad_publish_jobs select/filter from ad_campaign_id to campaign_id (~lines 146,148,151).",
      owner: "growth",
      parent: '[[../functions/growth]] — "Media buyer (Bianca, under Max)" mandate: these are Bianca\'s live crown/kill/reactivation + creative-learning paths throwing DB errors on every pass. See [[../libraries/media-buyer-agent]] and [[../tables/meta_insights_daily]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Resolve the dominant child ad from meta_insights_daily, not meta_ads.spend_cents",
          why: "meta_ads carries no spend_cents column, so the three dominant-ad lookups error and fall back to the ad set id — the audit misnames the creative and Postgres logs an error each pass.",
          what: "Add one helper that returns the highest-spend child ad id for an ad set using meta_insights_daily, and use it in all three sites.",
          body: "In src/lib/media-buyer/meta-cpa-signal.ts add `async function dominantChildAdId(admin, { workspaceId, metaAdsetId }): Promise<string>`: (1) read the ad set's child ad ids from meta_ads (`select meta_ad_id where meta_adset_id = metaAdsetId`, workspace-scoped) — meta_ads legitimately maps ad→adset; (2) sum spend_cents from meta_insights_daily where level='ad' and meta_object_id in those ad ids over the lifetime lookback (meta_insights_daily.spend_cents exists — it's already used at lines 86 and 362 of this file); (3) return the ad id with the highest summed spend; fall back to the first child ad id, then to metaAdsetId if there are none. Replace the three broken blocks — resolveWinnerSource (~137-140), detectMetaCpaLosers loser resolution (~296-301), detectMetaCpaReactivations (~382-384) — each of which currently does `.from('meta_ads').select('meta_ad_id, spend_cents')...order('spend_cents')` — with a call to this helper. No meta_ads select or order may reference spend_cents afterward. Update docs/brain/libraries/media-buyer-agent.md (or the meta-cpa-signal library page) per CLAUDE.md.",
          verification: "- tsc clean\n- no meta_ads query selects/orders by spend_cents\n- the dominantChildAdId helper exists",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "meta-cpa-signal no longer selects spend_cents from meta_ads", kind: "auto", exec_kind: "grep", params: { pattern: "select(\"meta_ad_id, spend_cents\")", path: "src/lib/media-buyer/meta-cpa-signal.ts", expect: "absent" } },
            { position: 3, description: "the dominant-child-ad helper exists", kind: "auto", exec_kind: "grep", params: { pattern: "dominantChildAdId", path: "src/lib/media-buyer/meta-cpa-signal.ts", expect: "present" } },
          ],
          status: "planned",
        },
        {
          title: "Phase 2 — Correct ad_publish_jobs column from ad_campaign_id to campaign_id in the outcome stamper",
          why: "stampCreativeOutcome filters ad_publish_jobs on a non-existent ad_campaign_id column, so it throws and the creative-learning flywheel never records outcomes for adset-resolved ads.",
          what: "Change the ad_publish_jobs select/filter/destructure from ad_campaign_id to the real column campaign_id.",
          body: "In src/lib/ads/creative-learning.ts stampCreativeOutcome, the ad_publish_jobs lookup (~lines 145-152) uses `.select('ad_campaign_id').not('ad_campaign_id','is',null)` and destructures `pj.ad_campaign_id`. ad_publish_jobs' column is `campaign_id` (the ad_campaigns UUID FK; `meta_campaign_id` is the separate Meta id). Change the select, the .not filter, and the destructure to `campaign_id`. Leave the creative_test_outcomes references (line 126 insert, line 166 .eq) as-is — that table legitimately has ad_campaign_id. Verify against the live schema (ad_publish_jobs has campaign_id, not ad_campaign_id). Note the fix in docs/brain/libraries/creative-learning.md (or ad-render lifecycle) per CLAUDE.md.",
          verification: "- tsc clean\n- creative-learning no longer selects ad_publish_jobs.ad_campaign_id",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "the broken ad_publish_jobs.ad_campaign_id select is gone", kind: "auto", exec_kind: "grep", params: { pattern: "select(\"ad_campaign_id\")", path: "src/lib/ads/creative-learning.ts", expect: "absent" } },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "growth#media-buyer-bianca-under-max" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 500)); process.exit(1); });
