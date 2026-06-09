/**
 * Meta CAPI fan-out — the storefront_events → event_dispatches → Meta
 * clearinghouse (storefront-mvp spec Phase 3).
 *
 * Runs every minute. For each active meta_capi sink it (1) seeds pending
 * event_dispatches rows for recent, mapped, undispatched events, then
 * (2) sends pending + retryable-failed dispatches to Meta's Conversions
 * API and records the result on the dispatch row.
 *
 * Why a cron sweep over a per-event Inngest emit: it decouples the hot
 * /api/pixel path from delivery, naturally batches (one POST per sink per
 * tick), and the event_dispatches row IS the retry ledger — a failed send
 * just stays `failed` and is retried next tick until MAX_ATTEMPTS → dlq.
 * Dedup with the browser pixel is automatic: both carry event_id =
 * storefront_events.id, so Meta collapses them inside its 48h window.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getActiveMetaSink,
  metaEventName,
  sendCapiEvents,
  deriveFbc,
  type CapiEvent,
  type MetaSink,
} from "@/lib/meta-capi";

const LOOKBACK_MIN = 20; // how far back to seed dispatches for new events
const MAX_ATTEMPTS = 5; // after this, a failed dispatch → dlq
const BATCH = 200; // events per Meta POST

export const metaCapiDispatchCron = inngest.createFunction(
  {
    id: "meta-capi-dispatch-cron",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "* * * * *" }], // every minute
  },
  async ({ step }) => {
    const admin = createAdminClient();

    // Active meta_capi sinks across all workspaces.
    const sinks = await step.run("load-active-sinks", async () => {
      const { data } = await admin
        .from("event_sinks")
        .select("id, workspace_id, event_types")
        .eq("sink_type", "meta_capi")
        .eq("is_active", true);
      return (data || []) as Array<{ id: string; workspace_id: string; event_types: string[] }>;
    });
    if (sinks.length === 0) return { sinks: 0 };

    let totalSent = 0;
    let totalFailed = 0;

    for (const sinkRow of sinks) {
      const result = await step.run(`dispatch-${sinkRow.id}`, async () => {
        const sink = await getActiveMetaSink(sinkRow.workspace_id);
        if (!sink) return { sent: 0, failed: 0 };

        // ── 1. Seed pending dispatches for recent mapped events ──────
        const sinceIso = new Date(Date.now() - LOOKBACK_MIN * 60_000).toISOString();
        const mappedTypes = Object.keys(
          // only event types Meta understands; intersect with the sink's
          // filter when it has one (empty = all mapped types).
          { pdp_view: 1, add_to_cart: 1, checkout_view: 1, order_placed: 1, lead_captured: 1 },
        ).filter((t) => sink.eventTypes.length === 0 || sink.eventTypes.includes(t));

        const { data: recentEvents } = await admin
          .from("storefront_events")
          .select("id")
          .eq("workspace_id", sinkRow.workspace_id)
          .in("event_type", mappedTypes)
          .gte("created_at", sinceIso)
          .limit(1000);

        if (recentEvents && recentEvents.length > 0) {
          const eventIds = recentEvents.map((e) => e.id as string);
          // Which already have a dispatch for this sink?
          const { data: existing } = await admin
            .from("event_dispatches")
            .select("event_id")
            .eq("sink_id", sinkRow.id)
            .in("event_id", eventIds);
          const have = new Set((existing || []).map((d) => d.event_id as string));
          const toSeed = eventIds.filter((id) => !have.has(id));
          if (toSeed.length > 0) {
            await admin.from("event_dispatches").upsert(
              toSeed.map((event_id) => ({
                workspace_id: sinkRow.workspace_id,
                event_id,
                sink_id: sinkRow.id,
                status: "pending",
              })),
              { onConflict: "event_id,sink_id", ignoreDuplicates: true },
            );
          }
        }

        // ── 2. Pull pending + retryable-failed dispatches ────────────
        const { data: due } = await admin
          .from("event_dispatches")
          .select("id, event_id, attempts, status")
          .eq("sink_id", sinkRow.id)
          .in("status", ["pending", "failed"])
          .lt("attempts", MAX_ATTEMPTS)
          .order("created_at", { ascending: true })
          .limit(BATCH);
        if (!due || due.length === 0) return { sent: 0, failed: 0 };

        // Load the underlying events + sessions (+ customers) to build payloads.
        const evIds = due.map((d) => d.event_id as string);
        const { data: events } = await admin
          .from("storefront_events")
          .select("id, event_type, session_id, customer_id, anonymous_id, product_id, meta, url, created_at")
          .in("id", evIds);
        const eventById = new Map((events || []).map((e) => [e.id as string, e]));

        const sessionIds = [...new Set((events || []).map((e) => e.session_id as string).filter(Boolean))];
        const { data: sessions } = sessionIds.length
          ? await admin
              .from("storefront_sessions")
              .select("id, user_agent, fbp, fbc, fbclid, ip_country, ip_region, ip_city")
              .in("id", sessionIds)
          : { data: [] };
        const sessionById = new Map((sessions || []).map((s) => [s.id as string, s]));

        const custIds = [...new Set((events || []).map((e) => e.customer_id as string).filter(Boolean))];
        const { data: customers } = custIds.length
          ? await admin.from("customers").select("id, email, phone, first_name, last_name").in("id", custIds)
          : { data: [] };
        const custById = new Map((customers || []).map((c) => [c.id as string, c]));

        // Build CapiEvents (skip any that don't map — defensive).
        const capiEvents: CapiEvent[] = [];
        const dispatchByEventId = new Map<string, { id: string; attempts: number }>();
        for (const d of due) {
          const ev = eventById.get(d.event_id as string);
          if (!ev) continue;
          const eventName = metaEventName(ev.event_type as string);
          if (!eventName) continue;
          dispatchByEventId.set(ev.id as string, { id: d.id as string, attempts: d.attempts as number });

          const sess = sessionById.get(ev.session_id as string);
          const cust = ev.customer_id ? custById.get(ev.customer_id as string) : null;
          const meta = (ev.meta || {}) as Record<string, unknown>;
          const eventTimeMs = new Date(ev.created_at as string).getTime();

          const customData: Record<string, unknown> = {};
          const cents = typeof meta.total_cents === "number" ? meta.total_cents : typeof meta.value_cents === "number" ? meta.value_cents : null;
          if (cents != null) {
            customData.value = Math.round(cents) / 100;
            customData.currency = (meta.currency as string) || "USD";
          }
          if (ev.product_id || meta.product_id) customData.content_ids = [ev.product_id || meta.product_id];
          if (meta.order_id) customData.order_id = meta.order_id;

          capiEvents.push({
            eventName,
            eventId: ev.id as string,
            eventTimeSec: Math.floor(eventTimeMs / 1000),
            eventSourceUrl: (ev.url as string) || null,
            userData: {
              email: cust?.email ?? null,
              phone: cust?.phone ?? null,
              firstName: cust?.first_name ?? null,
              lastName: cust?.last_name ?? null,
              country: sess?.ip_country ?? null,
              state: sess?.ip_region ?? null,
              city: sess?.ip_city ?? null,
              externalId: (ev.customer_id as string) || (ev.anonymous_id as string) || null,
              clientUserAgent: sess?.user_agent ?? null,
              fbp: sess?.fbp ?? null,
              fbc: deriveFbc(sess?.fbc ?? null, sess?.fbclid ?? null, eventTimeMs),
            },
            customData,
          });
        }

        if (capiEvents.length === 0) return { sent: 0, failed: 0 };

        const res = await sendCapiEvents(sink as MetaSink, capiEvents);
        const nowIso = new Date().toISOString();

        // One POST = all-or-nothing per Meta's API. Record the same outcome
        // on every dispatch in the batch.
        const updates = [...dispatchByEventId.values()].map((d) => {
          const attempts = d.attempts + 1;
          const status = res.ok ? "sent" : attempts >= MAX_ATTEMPTS ? "dlq" : "failed";
          return admin
            .from("event_dispatches")
            .update({
              status,
              attempts,
              last_attempted_at: nowIso,
              last_response_code: res.status,
              last_response_body: res.body || null,
              updated_at: nowIso,
            })
            .eq("id", d.id);
        });
        await Promise.all(updates);

        return res.ok ? { sent: capiEvents.length, failed: 0 } : { sent: 0, failed: capiEvents.length };
      });
      totalSent += result.sent;
      totalFailed += result.failed;
    }

    return { sinks: sinks.length, sent: totalSent, failed: totalFailed };
  },
);
