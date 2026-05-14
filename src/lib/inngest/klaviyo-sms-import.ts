/**
 * Klaviyo SMS campaign history importer.
 *
 *   marketing/klaviyo-sms.import     — pulls Klaviyo SMS campaigns
 *                                      from the last 6 months,
 *                                      fetches each one's body +
 *                                      values report (with Placed
 *                                      Order as the conversion
 *                                      metric), upserts into
 *                                      klaviyo_sms_campaign_history.
 *
 * Designed to be safely re-run. The unique constraint on
 * (workspace_id, klaviyo_campaign_id) makes upsert clean; stats
 * just get refreshed on each import.
 *
 * Manual trigger via POST /api/workspaces/[id]/klaviyo-sms-import,
 * which fires this Inngest event.
 *
 * Step structure keeps each Klaviyo API call inside its own
 * step.run so individual failures (rate limit, transient 5xx) retry
 * in isolation. Klaviyo's rate limit is ~75 req/sec across most
 * endpoints; well above what we hit here.
 */

import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

const KLAVIYO_REVISION = "2025-01-15";
const PLACED_ORDER_METRIC = "VCkHuL"; // Shopify Placed Order metric

// Days of history to import. 6 months ≈ 183 days; we round up.
const DEFAULT_HISTORY_DAYS = 200;

interface KlaviyoCampaign {
  id: string;
  attributes: {
    name: string;
    status: string;
    audiences?: { included?: string[]; excluded?: string[] };
    send_strategy?: {
      method?: string;
      datetime?: string;
      options?: { is_local?: boolean };
    };
    send_time?: string;
    scheduled_at?: string;
    created_at?: string;
    updated_at?: string;
  };
  relationships?: {
    "campaign-messages"?: { data?: Array<{ id: string }> };
  };
}

interface KlaviyoCampaignMessage {
  id: string;
  attributes?: {
    definition?: {
      content?: {
        body?: string;
        media_url?: string | null;
      };
    };
  };
}

interface ValuesReportResult {
  groupings?: { campaign_id?: string };
  statistics?: Record<string, number>;
}

export const klaviyoSmsImport = inngest.createFunction(
  {
    id: "klaviyo-sms-import",
    name: "Klaviyo — import SMS campaign history",
    concurrency: [{ limit: 2 }],
    retries: 2,
    triggers: [{ event: "marketing/klaviyo-sms.import" }],
  },
  async ({ event, step }) => {
    const { workspace_id, history_days } = event.data as {
      workspace_id: string;
      history_days?: number;
    };
    const days = history_days || DEFAULT_HISTORY_DAYS;

    // 1) Get Klaviyo API key for the workspace.
    const apiKey = await step.run("load-api-key", async () => {
      const admin = createAdminClient();
      const { data } = await admin.from("workspaces")
        .select("klaviyo_api_key_encrypted")
        .eq("id", workspace_id).single();
      if (!data?.klaviyo_api_key_encrypted) throw new Error("Klaviyo API key not configured");
      return decrypt(data.klaviyo_api_key_encrypted);
    });

    // 2) List all SMS campaigns scheduled in the last N days.
    //    Klaviyo paginates at 10 per page by default; we max page[size]
    //    and follow the next links until exhausted.
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const campaigns: KlaviyoCampaign[] = await step.run("list-campaigns", async () => {
      const collected: KlaviyoCampaign[] = [];
      let url: string | null =
        "https://a.klaviyo.com/api/campaigns?" +
        `filter=${encodeURIComponent(
          `and(equals(messages.channel,'sms'),greater-than(scheduled_at,${since}))`,
        )}&sort=-scheduled_at&page[size]=100`;
      while (url) {
        const res: Response = await fetch(url, {
          headers: klaviyoHeaders(apiKey),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`List campaigns ${res.status}: ${text.slice(0, 200)}`);
        }
        const body = (await res.json()) as { data: KlaviyoCampaign[]; links?: { next?: string } };
        collected.push(...(body.data || []));
        url = body.links?.next || null;
      }
      return collected;
    });

    if (campaigns.length === 0) {
      return { imported: 0, message: "No SMS campaigns in window" };
    }

    // 3) For each campaign, fetch the message body + values report
    //    and upsert one row. step.run per campaign so each one
    //    retries independently if Klaviyo returns a transient 5xx.
    let imported = 0;
    for (const c of campaigns) {
      await step.run(`import-${c.id}`, async () => {
        const messageRefId = c.relationships?.["campaign-messages"]?.data?.[0]?.id || null;

        // 3a) Message body — fetch the campaign-message resource.
        let messageBody: string | null = null;
        let messageMediaUrl: string | null = null;
        if (messageRefId) {
          const msgRes = await fetch(
            `https://a.klaviyo.com/api/campaign-messages/${messageRefId}`,
            { headers: klaviyoHeaders(apiKey) },
          );
          if (msgRes.ok) {
            const msgBody = (await msgRes.json()) as { data?: KlaviyoCampaignMessage };
            messageBody = msgBody.data?.attributes?.definition?.content?.body || null;
            messageMediaUrl = msgBody.data?.attributes?.definition?.content?.media_url || null;
          }
          // 404/forbidden = message gone or restricted; leave nulls.
        }

        // 3b) Values report — aggregate conversion stats.
        const reportRes = await fetch(
          "https://a.klaviyo.com/api/campaign-values-reports",
          {
            method: "POST",
            headers: { ...klaviyoHeaders(apiKey), "Content-Type": "application/json" },
            body: JSON.stringify({
              data: {
                type: "campaign-values-report",
                attributes: {
                  statistics: [
                    "recipients", "delivered", "delivery_rate",
                    "clicks", "clicks_unique", "click_rate",
                    "conversions", "conversion_value", "conversion_rate",
                    "revenue_per_recipient", "average_order_value",
                    "unsubscribes", "unsubscribe_rate",
                    "spam_complaints", "spam_complaint_rate",
                    "bounced", "bounce_rate",
                    "failed", "failed_rate",
                  ],
                  conversion_metric_id: PLACED_ORDER_METRIC,
                  timeframe: { key: "last_365_days" },
                  filter: `equals(campaign_id,"${c.id}")`,
                },
              },
            }),
          },
        );
        let stats: Record<string, number> = {};
        if (reportRes.ok) {
          const reportBody = (await reportRes.json()) as { data?: { attributes?: { results?: ValuesReportResult[] } } };
          const first = reportBody.data?.attributes?.results?.[0];
          stats = first?.statistics || {};
        }

        // 3c) Upsert. Cents conversion for money fields so we don't
        //     accumulate floating-point drift on dashboards.
        const admin = createAdminClient();
        const { error } = await admin.from("klaviyo_sms_campaign_history").upsert({
          workspace_id,
          klaviyo_campaign_id: c.id,
          klaviyo_campaign_message_id: messageRefId,
          channel: "sms",
          name: c.attributes.name,
          status: c.attributes.status,
          send_time: c.attributes.send_time || null,
          scheduled_at: c.attributes.scheduled_at || null,
          klaviyo_created_at: c.attributes.created_at || null,
          klaviyo_updated_at: c.attributes.updated_at || null,
          is_local_send: c.attributes.send_strategy?.options?.is_local ?? null,

          audience_included: c.attributes.audiences?.included || [],
          audience_excluded: c.attributes.audiences?.excluded || [],

          message_body: messageBody,
          message_media_url: messageMediaUrl,

          recipients: intOrNull(stats.recipients),
          delivered: intOrNull(stats.delivered),
          delivery_rate: numOrNull(stats.delivery_rate),
          clicks: intOrNull(stats.clicks),
          clicks_unique: intOrNull(stats.clicks_unique),
          click_rate: numOrNull(stats.click_rate),
          conversions: intOrNull(stats.conversions),
          conversion_rate: numOrNull(stats.conversion_rate),
          conversion_value_cents: dollarsToCents(stats.conversion_value),
          revenue_per_recipient_cents: dollarsToCents(stats.revenue_per_recipient),
          average_order_value_cents: dollarsToCents(stats.average_order_value),
          unsubscribes: intOrNull(stats.unsubscribes),
          unsubscribe_rate: numOrNull(stats.unsubscribe_rate),
          spam_complaints: intOrNull(stats.spam_complaints),
          spam_complaint_rate: numOrNull(stats.spam_complaint_rate),
          bounced: intOrNull(stats.bounced),
          bounce_rate: numOrNull(stats.bounce_rate),
          failed: intOrNull(stats.failed),
          failed_rate: numOrNull(stats.failed_rate),

          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: "workspace_id,klaviyo_campaign_id" });
        if (error) throw new Error(`Upsert failed: ${error.message}`);
        imported++;
      });
    }

    return { imported, total_campaigns: campaigns.length };
  },
);

function klaviyoHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    revision: KLAVIYO_REVISION,
    Accept: "application/json",
  };
}

function intOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.round(v);
}
function numOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}
function dollarsToCents(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.round(v * 100);
}
