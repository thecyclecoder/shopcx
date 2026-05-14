/**
 * Klaviyo Placed Order events importer.
 *
 * Mirrors Placed Order events into our klaviyo_events table so we can
 * compute Initial Revenue locally (excluding subscription auto-
 * renewals) for campaign attribution, AND eventually mine pre-purchase
 * event patterns for the AI segment builder.
 *
 * Strategy: page through /api/events filtered to metric_id +
 * datetime window, page[size]=200 (Klaviyo max). Each event row
 * carries enough Shopify detail in event_properties that we don't
 * need to re-pull later — store everything.
 *
 *   marketing/klaviyo-events.import   { workspace_id, since? }
 *
 * Idempotent via the unique constraint on (workspace_id,
 * klaviyo_event_id). Safe to re-run.
 */

import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

const KLAVIYO_REVISION = "2025-01-15";
const PLACED_ORDER_METRIC = "VCkHuL";

const DEFAULT_SINCE_DAYS = 200;
// Klaviyo caps event pages at 200. We pull aggressively.
const PAGE_SIZE = 200;

interface KlaviyoEvent {
  id: string;
  attributes: {
    timestamp: number;
    datetime?: string;
    event_properties?: Record<string, unknown>;
    metric_id?: string;
  };
  relationships?: {
    profile?: { data?: { id: string } | null };
    metric?: { data?: { id: string } };
  };
}

export const klaviyoEventsImport = inngest.createFunction(
  {
    id: "klaviyo-events-import",
    name: "Klaviyo — import Placed Order events",
    concurrency: [{ limit: 2 }],
    retries: 2,
    triggers: [{ event: "marketing/klaviyo-events.import" }],
  },
  async ({ event, step }) => {
    const { workspace_id, since } = event.data as {
      workspace_id: string;
      since?: string;          // ISO date string
    };

    const sinceIso = since
      || new Date(Date.now() - DEFAULT_SINCE_DAYS * 86_400_000).toISOString();

    const apiKey = await step.run("load-api-key", async () => {
      const admin = createAdminClient();
      const { data } = await admin.from("workspaces")
        .select("klaviyo_api_key_encrypted")
        .eq("id", workspace_id).single();
      if (!data?.klaviyo_api_key_encrypted) throw new Error("Klaviyo API key not configured");
      return decrypt(data.klaviyo_api_key_encrypted);
    });

    const headers = {
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      revision: KLAVIYO_REVISION,
      Accept: "application/json",
    };

    // Paginate. Each step.run is one page; Inngest restarts each
    // page on transient failure without re-pulling everything.
    let nextUrl: string | null = buildInitialUrl(sinceIso);
    let totalImported = 0;
    let pageNum = 0;

    while (nextUrl) {
      pageNum++;
      const result = await step.run(`page-${pageNum}`, async () => {
        const res = await fetch(nextUrl!, { headers });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Events page ${pageNum} ${res.status}: ${text.slice(0, 200)}`);
        }
        const body = (await res.json()) as { data: KlaviyoEvent[]; links?: { next?: string } };
        const events = body.data || [];
        const rows = events.map((e) => mapEventToRow(workspace_id, e)).filter(Boolean);

        if (rows.length > 0) {
          const admin = createAdminClient();
          const { error } = await admin
            .from("klaviyo_events")
            .upsert(rows as Record<string, unknown>[], {
              onConflict: "workspace_id,klaviyo_event_id",
              ignoreDuplicates: false,
            });
          if (error) throw new Error(`Upsert failed: ${error.message}`);
        }
        return { count: rows.length, next: body.links?.next || null };
      });
      totalImported += result.count;
      nextUrl = result.next;
    }

    return { imported: totalImported, pages: pageNum, since: sinceIso };
  },
);

function buildInitialUrl(sinceIso: string): string {
  const filter = `and(` +
    `equals(metric_id,"${PLACED_ORDER_METRIC}"),` +
    `greater-than(datetime,${sinceIso})` +
    `)`;
  // sort by datetime asc so we make forward progress as pages come
  // in — if the job aborts mid-import, the rerun picks up roughly
  // where we left off via the unique-event upsert.
  return "https://a.klaviyo.com/api/events" +
    `?filter=${encodeURIComponent(filter)}` +
    `&sort=datetime` +
    `&page[size]=${PAGE_SIZE}` +
    `&include=profile`;
}

function mapEventToRow(
  workspaceId: string,
  e: KlaviyoEvent,
): Record<string, unknown> | null {
  const datetime = e.attributes.datetime
    || (e.attributes.timestamp ? new Date(e.attributes.timestamp * 1000).toISOString() : null);
  if (!datetime) return null;

  const props = e.attributes.event_properties || {};
  const sourceName = typeof props["Source Name"] === "string"
    ? (props["Source Name"] as string)
    : null;
  const orderNumber = pickOrderNumber(props);
  const valueNum = pickValue(props);

  const profileId = e.relationships?.profile?.data?.id || null;
  const metricId = e.relationships?.metric?.data?.id
    || e.attributes.metric_id
    || PLACED_ORDER_METRIC;

  return {
    workspace_id: workspaceId,
    klaviyo_event_id: e.id,
    klaviyo_metric_id: metricId,
    klaviyo_profile_id: profileId,
    datetime,
    value: valueNum,
    source_name: sourceName,
    order_number: orderNumber,
    event_properties: props,
  };
}

function pickValue(props: Record<string, unknown>): number | null {
  // Klaviyo's $value is the canonical revenue value.
  const raw = props.$value;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickOrderNumber(props: Record<string, unknown>): string | null {
  // Shopify integration stores the human order number in
  // event_properties.$extra.order_number.
  const extra = props.$extra as Record<string, unknown> | undefined;
  const num = extra?.order_number;
  if (typeof num === "number") return `SC${num}`;
  if (typeof num === "string") return num;
  // Some events use name directly.
  const name = extra?.name;
  if (typeof name === "string") return name;
  return null;
}
