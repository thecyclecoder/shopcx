/**
 * Klaviyo engagement INCREMENTAL sync.
 *
 * Daily cron — pulls events created since MAX(datetime) per metric and
 * upserts them into `klaviyo_profile_events`. The companion to the
 * one-shot `klaviyo-engagement-backfill` function (which loads 180d).
 *
 * Why this exists: per `project_klaviyo_engagement_backfill_local`, the
 * Inngest backfill ran into Vercel's 5-minute function timeout on
 * high-volume metrics (Active on Site, Viewed Product). The full
 * backfill is now driven by a local Node script; this cron just keeps
 * the data fresh going forward. Incremental volumes are tiny
 * (hundreds–low-thousands of events/day across all metrics) so a
 * single Inngest function invocation handles a full daily delta with
 * room to spare.
 *
 * Skipped metrics:
 *   - Clicked SMS: ~0 new events since Klaviyo SMS is cut.
 * Active metrics:
 *   - Opened Email, Clicked Email — until our email sender lands.
 *   - Active on Site, Viewed Product, Added to Cart, Checkout Started
 *     — until the storefront pixel ships and these flow into
 *     `storefront_events` instead.
 *
 * The cron only runs for workspaces with
 * `klaviyo_engagement_backfill_completed_at` set, so it never duplicates
 * the backfill's work.
 */

import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

const KLAVIYO_REVISION = "2025-01-15";

// Same metric set as the backfill function — keep in sync.
const METRICS = [
  "Clicked SMS",
  "Opened Email",
  "Clicked Email",
  "Viewed Product",
  "Added to Cart",
  "Checkout Started",
  "Active on Site",
] as const;

// Metric IDs per workspace. Hardcoded by design — Klaviyo's /api/metrics
// endpoint is unreliable for this account (it's what took the original
// backfill Inngest function down; the local script bypassed it via a
// fixed map and that's what actually worked). Add new workspaces as we
// onboard them.
const METRIC_IDS_BY_WORKSPACE: Record<string, Record<string, string>> = {
  "fdc11e10-b89f-4989-8b73-ed6526c4d906": {
    "Clicked SMS": "XguEVT",
    "Opened Email": "P6RT4W",
    "Active on Site": "L4pUjd",
    "Clicked Email": "NtQQsj",
    "Viewed Product": "SjW2Lq",
    "Added to Cart": "XqHE4N",
    "Checkout Started": "XWgWge",
  },
};

const PAGE_SIZE = 200;
const UPSERT_CHUNK = 100;
// Hard cap on lookback. If yesterday's run failed and the watermark is
// 3 days old, we still only pull 1 day — never a multi-day backlog.
// Recovering from a longer outage means running the local backfill
// script (which is what proved reliable for high-volume metrics).
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// Max pages per metric per run. With PAGE_SIZE=200 that's 10K events
// per metric, which is well above any realistic daily delta for this
// account. Hitting the cap means we should run the backfill script.
const MAX_PAGES_PER_METRIC = 50;

export const klaviyoEngagementSync = inngest.createFunction(
  {
    id: "klaviyo-engagement-sync",
    name: "Klaviyo — incremental engagement sync (daily)",
    concurrency: [{ limit: 1 }],
    retries: 2,
    // 10:00 UTC = ~4 AM Central. Engagement data doesn't need precise
    // timing; this just runs before customers wake up on the east coast.
    // Manual trigger via the event lets us re-run mid-day if needed.
    triggers: [
      { cron: "0 10 * * *" },
      { event: "marketing/klaviyo-engagement.sync" },
    ],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    // ── 1) Find workspaces eligible for incremental sync ──
    // Only workspaces that have completed the initial 180d backfill —
    // otherwise this cron would race with whatever backfill is in
    // progress.
    const { data: workspaces } = await admin
      .from("workspaces")
      .select("id, klaviyo_api_key_encrypted")
      .not("klaviyo_engagement_backfill_completed_at", "is", null)
      .not("klaviyo_api_key_encrypted", "is", null);

    if (!workspaces?.length) return { workspaces_synced: 0, message: "no eligible workspaces" };

    const results: Array<{ workspace_id: string; pulled: Record<string, number>; errors: string[] }> = [];

    for (const ws of workspaces) {
      const wsResult = await step.run(`sync-${ws.id}`, async () => {
        const admin = createAdminClient();
        const apiKey = decrypt(ws.klaviyo_api_key_encrypted);
        const headers = {
          Authorization: `Klaviyo-API-Key ${apiKey}`,
          revision: KLAVIYO_REVISION,
          Accept: "application/json",
        };

        // Hardcoded metric IDs — /api/metrics resolution intentionally
        // skipped (broke the original backfill, the local script with
        // fixed IDs is the path that proved reliable).
        const metricIds = METRIC_IDS_BY_WORKSPACE[ws.id] || {};
        const pulled: Record<string, number> = {};
        const errors: string[] = [];

        if (Object.keys(metricIds).length === 0) {
          errors.push(`No METRIC_IDS_BY_WORKSPACE entry for workspace ${ws.id} — add one to enable sync`);
          return { workspace_id: ws.id, pulled, errors };
        }

        // ── For each metric: watermark → paginate → upsert ──
        const oneDayAgoIso = new Date(Date.now() - MAX_LOOKBACK_MS).toISOString();

        for (const metricName of METRICS) {
          const metricId = metricIds[metricName];
          if (!metricId) {
            errors.push(`${metricName}: no metric_id in METRIC_IDS_BY_WORKSPACE`);
            continue;
          }

          // Watermark — most recent event we already have for this
          // (workspace, metric). Klaviyo's greater-than is exclusive on
          // datetime, so back off 1s to catch same-second events;
          // duplicates dedupe on the unique constraint.
          const { data: watermark } = await admin
            .from("klaviyo_profile_events")
            .select("datetime")
            .eq("workspace_id", ws.id)
            .eq("metric_name", metricName)
            .order("datetime", { ascending: false })
            .limit(1)
            .maybeSingle();

          // sinceIso = MAX(watermark - 1s, now - 1 day). The MAX caps
          // the lookback at 1 day even if the cron has been failing —
          // we never do a multi-day pull from this function.
          const watermarkSince = watermark?.datetime
            ? new Date(new Date(watermark.datetime).getTime() - 1000).toISOString()
            : null;
          const sinceIso = watermarkSince && watermarkSince > oneDayAgoIso
            ? watermarkSince
            : oneDayAgoIso;

          const filter = `and(equals(metric_id,"${metricId}"),greater-than(datetime,${sinceIso}))`;
          let url: string | null =
            "https://a.klaviyo.com/api/events" +
            `?filter=${encodeURIComponent(filter)}&sort=datetime&page[size]=${PAGE_SIZE}`;
          let pages = 0;
          let added = 0;

          while (url && pages < MAX_PAGES_PER_METRIC) {
            pages++;
            const r: Response = await fetch(url, { headers });
            if (r.status === 429) {
              await new Promise((res) => setTimeout(res, 5000));
              continue;
            }
            if (!r.ok) {
              const text = await r.text().catch(() => "");
              errors.push(`${metricName} page=${pages} ${r.status}: ${text.slice(0, 200)}`);
              break;
            }
            const body = (await r.json()) as {
              data: Array<{
                id: string;
                attributes?: { datetime?: string; timestamp?: number; event_properties?: Record<string, unknown> };
                relationships?: { profile?: { data?: { id: string } | null } };
              }>;
              links?: { next?: string };
            };

            const rows = (body.data || [])
              .map((e) => {
                const profileId = e.relationships?.profile?.data?.id;
                if (!profileId) return null;
                const datetime =
                  e.attributes?.datetime ||
                  (e.attributes?.timestamp ? new Date(e.attributes.timestamp * 1000).toISOString() : null);
                if (!datetime) return null;
                const props = e.attributes?.event_properties || {};
                const rawValue = (props["$value"] ?? props["value"] ?? null) as unknown;
                const valueCents =
                  typeof rawValue === "number" && Number.isFinite(rawValue)
                    ? Math.round(rawValue * 100)
                    : typeof rawValue === "string" && Number.isFinite(Number(rawValue))
                      ? Math.round(Number(rawValue) * 100)
                      : null;
                return {
                  workspace_id: ws.id,
                  klaviyo_profile_id: profileId,
                  klaviyo_event_id: e.id,
                  metric_name: metricName,
                  datetime,
                  value_cents: valueCents,
                };
              })
              .filter((r): r is NonNullable<typeof r> => r !== null);

            if (rows.length > 0) {
              for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
                const batch = rows.slice(i, i + UPSERT_CHUNK);
                const { error } = await admin
                  .from("klaviyo_profile_events")
                  .upsert(batch, { onConflict: "workspace_id,klaviyo_event_id", ignoreDuplicates: false });
                if (error) {
                  errors.push(`${metricName} upsert page=${pages}: ${error.message}`);
                  url = null;
                  break;
                }
              }
              added += rows.length;
            }

            url = body.links?.next || null;
          }

          if (pages >= MAX_PAGES_PER_METRIC && url) {
            errors.push(`${metricName}: hit MAX_PAGES_PER_METRIC=${MAX_PAGES_PER_METRIC} cap — likely backfill gap, escalate`);
          }

          pulled[metricName] = added;
        }

        return { workspace_id: ws.id, pulled, errors };
      });

      results.push(wsResult);
    }

    return {
      workspaces_synced: results.length,
      results,
    };
  },
);
