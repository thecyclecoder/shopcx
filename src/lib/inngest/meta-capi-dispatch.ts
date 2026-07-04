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
  resolveMetaContent,
  deriveFbc,
  type CapiEvent,
  type MetaSink,
} from "@/lib/meta-capi";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

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

        // Seed `pending` dispatch rows for a set of event ids, skipping any
        // that already have one for this sink. Idempotent — safe to re-run.
        const seedMissing = async (eventIds: string[]) => {
          if (eventIds.length === 0) return;
          const { data: existing } = await admin
            .from("event_dispatches")
            .select("event_id")
            .eq("sink_id", sinkRow.id)
            .in("event_id", eventIds);
          const have = new Set((existing || []).map((d) => d.event_id as string));
          const toSeed = eventIds.filter((id) => !have.has(id));
          if (toSeed.length === 0) return;
          await admin.from("event_dispatches").upsert(
            toSeed.map((event_id) => ({
              workspace_id: sinkRow.workspace_id,
              event_id,
              sink_id: sinkRow.id,
              status: "pending",
            })),
            { onConflict: "event_id,sink_id", ignoreDuplicates: true },
          );
        };

        // Renewals must never reach Meta as a Purchase — they're recurring
        // subscription billing, not ad conversions, and are already excluded
        // from ROAS on our side via bucketOrder ("recurring" = source_name
        // contains "subscription"; see libraries/order-bucketing). Today
        // order_placed is only emitted by the storefront checkout for NEW
        // orders, so this is defense-in-depth: drop any order_placed whose
        // order is a renewal before it can seed a CAPI dispatch (e.g. a future
        // immediate "order now" charge or renewal-via-storefront path).
        const dropRenewalPurchases = async (
          rows: Array<{ id: string; event_type?: string | null; meta?: Record<string, unknown> | null }>,
        ): Promise<string[]> => {
          const orderId = (r: { meta?: Record<string, unknown> | null }) =>
            ((r.meta as { order_id?: string } | null)?.order_id) || "";
          const orderIds = [...new Set(
            rows.filter((r) => r.event_type === "order_placed").map(orderId).filter(Boolean),
          )];
          if (orderIds.length === 0) return rows.map((r) => r.id);
          const { data: ords } = await admin
            .from("orders").select("id, source_name").in("id", orderIds);
          const renewalIds = new Set(
            (ords || [])
              .filter((o) => (((o.source_name as string | null) || "").toLowerCase()).includes("subscription"))
              .map((o) => o.id as string),
          );
          if (renewalIds.size === 0) return rows.map((r) => r.id);
          const dropped = rows.filter((r) => r.event_type === "order_placed" && renewalIds.has(orderId(r)));
          if (dropped.length) {
            console.log(`[meta-capi] skipped ${dropped.length} renewal order_placed event(s) — not a Purchase`);
          }
          return rows.filter((r) => !(r.event_type === "order_placed" && renewalIds.has(orderId(r)))).map((r) => r.id);
        };

        // Keyset-paginate — a bare/.limit(1000) select is capped at PostgREST max-rows (1000).
        // A busy window can exceed 1000 events; the unordered overflow would never be seeded,
        // so those Purchases never reach Meta CAPI (lost conversions). seedMissing() is idempotent.
        const recentEvents: Array<{ id: string; event_type: string; meta: Record<string, unknown> | null }> = [];
        {
          let afterId: string | null = null;
          while (true) {
            let q = admin
              .from("storefront_events")
              .select("id, event_type, meta")
              .eq("workspace_id", sinkRow.workspace_id)
              .in("event_type", mappedTypes)
              .gte("created_at", sinceIso)
              .order("id", { ascending: true })
              .limit(1000);
            if (afterId) q = q.gt("id", afterId);
            const { data } = await q;
            if (!data?.length) break;
            recentEvents.push(...(data as Array<{ id: string; event_type: string; meta: Record<string, unknown> | null }>));
            if (data.length < 1000) break;
            afterId = data[data.length - 1].id as string;
          }
        }
        await seedMissing(await dropRenewalPurchases(recentEvents));

        // ── 1b. Safety net for order_placed (the money event) ────────
        // The 20-minute lookback above permanently skips any order_placed
        // row whose created_at is already older than the window when it's
        // inserted — e.g. a server-side backfill recreating a pixel-missed
        // purchase with created_at = order time. Re-scan order_placed across
        // Meta's 7-day CAPI acceptance window and seed any still-undispatched.
        // Volume is ~one row per order, and seedMissing() keeps it idempotent.
        if (mappedTypes.includes("order_placed")) {
          const capiWindowIso = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
          // Keyset-paginate the full 7-day window — >1000 Purchases/week is common and the
          // unordered tail past 1000 would otherwise never be seeded (permanently lost to CAPI).
          const purchases: Array<{ id: string; meta: Record<string, unknown> | null }> = [];
          let afterId: string | null = null;
          while (true) {
            let q = admin
              .from("storefront_events")
              .select("id, meta")
              .eq("workspace_id", sinkRow.workspace_id)
              .eq("event_type", "order_placed")
              .gte("created_at", capiWindowIso)
              .order("id", { ascending: true })
              .limit(1000);
            if (afterId) q = q.gt("id", afterId);
            const { data } = await q;
            if (!data?.length) break;
            purchases.push(...(data as Array<{ id: string; meta: Record<string, unknown> | null }>));
            if (data.length < 1000) break;
            afterId = data[data.length - 1].id as string;
          }
          await seedMissing(await dropRenewalPurchases(purchases.map((p) => ({ ...p, event_type: "order_placed" }))));
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

        // ── First-touch fbc/fbclid recovery ─────────────────────────
        // user_data.fbc is what ties a conversion to the ad click, and it's
        // derived from the fbclid that lands in the URL — but that lands on the
        // FIRST-touch session, while the event (esp. our server order_placed,
        // which can fall back to a later session) may sit on a session with no
        // click id. When the event's own session has neither fbc nor fbclid,
        // recover the EARLIEST fbc/fbclid the visitor ever had (by customer_id,
        // else anonymous_id) so Meta can still match the order to the click.
        type FirstTouch = { fbc: string | null; fbclid: string | null; fbp: string | null; ts: number };
        const ftByCust = new Map<string, FirstTouch>();
        const ftByAnon = new Map<string, FirstTouch>();
        const needFt = (events || []).filter((e) => {
          const s = sessionById.get(e.session_id as string);
          return !s?.fbc && !s?.fbclid;
        });
        const ftCustIds = [...new Set(needFt.map((e) => e.customer_id as string).filter(Boolean))];
        const ftAnonIds = [...new Set(needFt.map((e) => e.anonymous_id as string).filter(Boolean))];
        if (ftCustIds.length || ftAnonIds.length) {
          const idClauses: string[] = [];
          if (ftCustIds.length) idClauses.push(`customer_id.in.(${ftCustIds.join(",")})`);
          if (ftAnonIds.length) idClauses.push(`anonymous_id.in.(${ftAnonIds.map((a) => `"${a}"`).join(",")})`);
          const { data: ftRows } = await admin
            .from("storefront_sessions")
            .select("customer_id, anonymous_id, fbc, fbclid, fbp, first_seen_at")
            .eq("workspace_id", sinkRow.workspace_id)
            .or("fbc.not.is.null,fbclid.not.is.null")
            .or(idClauses.join(","))
            .order("first_seen_at", { ascending: true });
          for (const r of ftRows || []) {
            const ft: FirstTouch = { fbc: r.fbc as string | null, fbclid: r.fbclid as string | null, fbp: r.fbp as string | null, ts: new Date(r.first_seen_at as string).getTime() };
            const c = r.customer_id as string | null;
            const a = r.anonymous_id as string | null;
            if (c && !ftByCust.has(c)) ftByCust.set(c, ft);   // first row = earliest (ordered asc)
            if (a && !ftByAnon.has(a)) ftByAnon.set(a, ft);
          }
        }

        // Resolve catalog content_ids for the whole batch in one pass. Our
        // events carry UUIDs; this translates UUID → meta_id (the Shopify-
        // derived catalog id) only here, at the Meta egress.
        const contentByEvent = await resolveMetaContent(
          sinkRow.workspace_id,
          (events || []).map((e) => ({
            id: e.id as string,
            event_type: e.event_type as string,
            product_id: (e.product_id as string) || null,
            meta: (e.meta || {}) as Record<string, unknown>,
          })),
        );

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

          // fbc: event's own session first; else the visitor's first-touch
          // click id (stamped with that landing's time, per Meta's spec).
          let fbc = deriveFbc(sess?.fbc ?? null, sess?.fbclid ?? null, eventTimeMs);
          let fbp = sess?.fbp ?? null;
          if (!fbc) {
            const ft = (ev.customer_id ? ftByCust.get(ev.customer_id as string) : null)
              || (ev.anonymous_id ? ftByAnon.get(ev.anonymous_id as string) : null);
            if (ft) {
              fbc = deriveFbc(ft.fbc, ft.fbclid, ft.ts);
              if (!fbp) fbp = ft.fbp;
            }
          }

          const customData: Record<string, unknown> = {};
          const cents = typeof meta.total_cents === "number" ? meta.total_cents : typeof meta.value_cents === "number" ? meta.value_cents : null;
          if (cents != null) {
            customData.value = Math.round(cents) / 100;
            customData.currency = (meta.currency as string) || "USD";
          }
          // Catalog content — meta_id values resolved from our UUIDs. The
          // catalog is variant-level, so content_type is always "product".
          const content = contentByEvent.get(ev.id as string);
          if (content && content.contentIds.length) {
            customData.content_ids = content.contentIds;
            customData.content_type = "product";
            if (content.numItems != null) customData.num_items = content.numItems;
          }
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
              fbp,
              fbc,
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

    const result = { sinks: sinks.length, sent: totalSent, failed: totalFailed };
    // Control Tower: end-of-run heartbeat (control-tower-complete-coverage spec, Phase 1).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("meta-capi-dispatch-cron", { ok: true, produced: result });
    });
    return result;
  },
);
