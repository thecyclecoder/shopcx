/**
 * Klaviyo engagement backfill.
 *
 *   marketing/klaviyo-engagement.backfill { workspace_id, days? }
 *
 * Pulls 180d (configurable) of engagement events from Klaviyo across
 * the metrics we use for archetype scoring, mirrors them into
 * `klaviyo_profile_events`, then rebuilds the per-profile rolling
 * aggregates in `profile_engagement_summary`.
 *
 * One-time historical fill — SMS clicks are frozen (Dylan cut Klaviyo
 * SMS sending), email/email-click/site-event streams keep updating via
 * a nightly delta cron until the email sender lands.
 *
 * Strategy:
 *  - One step.run per metric: filter events by metric_id, paginate.
 *  - Per-page chunked upsert into klaviyo_profile_events (idempotent
 *    via (workspace_id, klaviyo_event_id)).
 *  - After all metrics are pulled, one rebuild step does a single
 *    GROUP-BY SQL pass to recompute the summary rollups.
 *  - Identity resolution (customer_id / email / phone) joins
 *    customers via email/phone in the same rebuild step.
 *
 * Why per-metric (not per-profile): the Klaviyo events endpoint is
 * dramatically faster filtered by metric_id than per-profile (we'd
 * need ~138K profile-level calls otherwise; metric-level is ~10-25K
 * total pages across all metrics for 180d).
 *
 * Concurrency: 1 — saturating both Klaviyo and Postgres simultaneously
 * is what took us down once already. One in-flight backfill at a time.
 */

import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

const KLAVIYO_REVISION = "2025-01-15";

// Metrics to backfill. Names map to the Klaviyo standard SDK metric
// labels. The actual metric_id is workspace-specific and is resolved
// at runtime by walking /api/metrics.
const METRICS_TO_BACKFILL = [
  "Clicked SMS",
  "Opened Email",
  "Clicked Email",
  "Viewed Product",
  "Added to Cart",
  "Checkout Started",
  "Active on Site",
] as const;

const DEFAULT_DAYS = 180;
const PAGE_SIZE = 200;
const UPSERT_CHUNK = 100;
// Pages-per-step.run before yielding back to Inngest. 30 pages × ~1.2s
// per page ≈ 36 seconds — well under the 300s Vercel function timeout.
// Inngest re-invokes for the next chunk; total runtime accumulates
// across invocations.
const PAGES_PER_STEP = 30;

export const klaviyoEngagementBackfill = inngest.createFunction(
  {
    id: "klaviyo-engagement-backfill",
    name: "Klaviyo — backfill engagement events (180d)",
    concurrency: [{ limit: 1 }],
    retries: 1,
    triggers: [{ event: "marketing/klaviyo-engagement.backfill" }],
  },
  async ({ event, step }) => {
    const { workspace_id, days } = event.data as {
      workspace_id: string;
      days?: number;
    };
    const windowDays = days || DEFAULT_DAYS;
    const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString();

    // ── 1) Setup: API key + mark started + resolve metric_id catalog ──
    const { apiKey, metricIds } = await step.run("setup", async () => {
      const admin = createAdminClient();
      const { data: ws } = await admin
        .from("workspaces")
        .select("klaviyo_api_key_encrypted")
        .eq("id", workspace_id)
        .single();
      if (!ws?.klaviyo_api_key_encrypted) throw new Error("Klaviyo API key not configured");
      const apiKey = decrypt(ws.klaviyo_api_key_encrypted);
      await admin
        .from("workspaces")
        .update({
          klaviyo_engagement_backfill_started_at: new Date().toISOString(),
          klaviyo_engagement_backfill_completed_at: null,
        })
        .eq("id", workspace_id);

      // The /api/metrics endpoint sometimes returns 0 rows (account
      // permission quirk). The safer path is to resolve metric_id
      // from a sample event's include=metric. We do this by walking
      // a profile that we know has lots of activity.
      const headers = {
        Authorization: `Klaviyo-API-Key ${apiKey}`,
        revision: KLAVIYO_REVISION,
        Accept: "application/json",
      };
      const metricIds: Record<string, string> = {};

      // Try /api/metrics first (faster when it works).
      let mUrl: string | null = "https://a.klaviyo.com/api/metrics?page[size]=200";
      while (mUrl) {
        const res: Response = await fetch(mUrl, { headers });
        if (!res.ok) break;
        const body = (await res.json()) as {
          data: Array<{ id: string; attributes?: { name?: string } }>;
          links?: { next?: string };
        };
        for (const m of body.data || []) {
          const name = m.attributes?.name;
          if (name && (METRICS_TO_BACKFILL as readonly string[]).includes(name)) {
            metricIds[name] = m.id;
          }
        }
        mUrl = body.links?.next || null;
      }

      // Fall back to include=metric probe if /api/metrics gave us nothing.
      if (Object.keys(metricIds).length < METRICS_TO_BACKFILL.length) {
        const { data: anyEv } = await admin
          .from("klaviyo_events")
          .select("klaviyo_profile_id")
          .eq("workspace_id", workspace_id)
          .limit(1)
          .single();
        if (anyEv) {
          const probeUrl =
            "https://a.klaviyo.com/api/events" +
            `?filter=${encodeURIComponent(`equals(profile_id,"${anyEv.klaviyo_profile_id}")`)}` +
            `&page[size]=200&include=metric`;
          const r = await fetch(probeUrl, { headers });
          const b = (await r.json()) as {
            included?: Array<{ type: string; id: string; attributes?: { name?: string } }>;
          };
          for (const inc of b.included || []) {
            if (inc.type !== "metric") continue;
            const name = inc.attributes?.name;
            if (name && (METRICS_TO_BACKFILL as readonly string[]).includes(name) && !metricIds[name]) {
              metricIds[name] = inc.id;
            }
          }
        }
      }

      const resolved = Object.keys(metricIds);
      const missing = METRICS_TO_BACKFILL.filter((m) => !resolved.includes(m));
      if (missing.length > 0) {
        // Not fatal — we backfill whatever we have.
        console.warn(`[engagement-backfill] couldn't resolve metrics: ${missing.join(", ")}`);
      }
      return { apiKey, metricIds };
    });

    // ── 2) For each metric: paginate + upsert raw events ──
    //
    // Pagination is chunked across multiple step.run calls so we
    // never exceed Vercel's 5-minute function timeout. Each step
    // pulls up to PAGES_PER_STEP pages, then returns the next URL;
    // Inngest re-invokes for the next chunk. Total runtime can be
    // hours for high-volume metrics like Active on Site — that's
    // fine, Inngest persists the loop state.
    const headers = {
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      revision: KLAVIYO_REVISION,
      Accept: "application/json",
    };

    const totals: Record<string, number> = {};

    for (const [metricName, metricId] of Object.entries(metricIds)) {
      const metricSlug = metricName.replace(/\s+/g, "-").toLowerCase();
      const filter = `and(equals(metric_id,"${metricId}"),greater-than(datetime,${sinceIso}))`;
      let nextUrl: string | null =
        "https://a.klaviyo.com/api/events" +
        `?filter=${encodeURIComponent(filter)}&sort=datetime&page[size]=${PAGE_SIZE}`;
      let metricImported = 0;
      let chunkNum = 0;

      while (nextUrl) {
        chunkNum++;
        const urlForStep: string = nextUrl;
        const result = await step.run(`pull-${metricSlug}-chunk-${chunkNum}`, async () => {
          let pageUrl: string | null = urlForStep;
          let chunkImported = 0;
          let pagesInChunk = 0;
          const admin = createAdminClient();

          while (pageUrl && pagesInChunk < PAGES_PER_STEP) {
            const res = await fetch(pageUrl, { headers });
            if (!res.ok) {
              const text = await res.text().catch(() => "");
              throw new Error(`Events ${metricName} chunk=${chunkNum} page=${pagesInChunk} ${res.status}: ${text.slice(0, 200)}`);
            }
            const body = (await res.json()) as {
              data: Array<{
                id: string;
                attributes?: {
                  datetime?: string;
                  timestamp?: number;
                  event_properties?: Record<string, unknown>;
                };
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
                  workspace_id,
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
                const { error } = await admin.from("klaviyo_profile_events").upsert(batch, {
                  onConflict: "workspace_id,klaviyo_event_id",
                  ignoreDuplicates: false,
                });
                if (error) throw new Error(`Upsert failed: ${error.message}`);
                if (i + UPSERT_CHUNK < rows.length) await new Promise((r) => setTimeout(r, 20));
              }
            }

            chunkImported += rows.length;
            pagesInChunk++;
            pageUrl = body.links?.next || null;
            // Light throttle to stay well under Klaviyo's 75 req/sec
            // limit (we're at ~10/sec at this pace).
            if (pageUrl) await new Promise((r) => setTimeout(r, 100));
          }

          return { count: chunkImported, next: pageUrl };
        });

        metricImported += result.count;
        nextUrl = result.next;
      }

      totals[metricName] = metricImported;
    }

    // ── 3) Rebuild summary rollups in a single SQL pass ──
    await step.run("rebuild-summary", async () => {
      const admin = createAdminClient();
      const { error } = await admin.rpc("rebuild_engagement_summary", {
        p_workspace_id: workspace_id,
      });
      if (error) throw new Error(`Summary rebuild failed: ${error.message}`);
    });

    // ── 4) Mark completed ──
    await step.run("mark-completed", async () => {
      const admin = createAdminClient();
      await admin
        .from("workspaces")
        .update({
          klaviyo_engagement_backfill_completed_at: new Date().toISOString(),
        })
        .eq("id", workspace_id);
    });

    return { totals, window_days: windowDays };
  },
);
