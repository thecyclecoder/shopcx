/**
 * SMS/MMS marketing campaign pipeline.
 *
 * Two Inngest functions:
 *
 *   marketing/text-campaign.scheduled
 *     Fired when an admin clicks Schedule on a draft campaign. Resolves
 *     the audience filter into concrete recipient rows, runs each
 *     through the timezone resolver, and computes their UTC
 *     scheduled_send_at. Marks the campaign 'scheduled' when done.
 *
 *   marketing/text-campaign.send-tick (cron)
 *     Runs every minute. Picks any pending recipients whose
 *     scheduled_send_at has passed, sends each one via Twilio
 *     (throttled to keep us under the SMS rate limit), and updates
 *     the recipient + campaign stats.
 *
 * Concurrency control is done at the Inngest level: the send-tick
 * function declares `concurrency: { limit: 20 }` so we never have
 * more than 20 in-flight Twilio calls at once. Inngest also retries
 * failed sends automatically.
 */

import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendSMS } from "@/lib/twilio";
import {
  resolveRecipientTimezone,
  computeSendInstant,
  type CustomerForTzResolve,
  type TimezoneSource,
} from "@/lib/marketing-text-timezone";
import { generateShortlinkSlug } from "@/lib/shortlink-slug";
import {
  createCampaignCoupon,
  disableCampaignCoupon,
  buildShortlinkUrl,
} from "@/lib/marketing-coupons";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

// ─── Scheduled — build the recipient queue ─────────────────────────
export const textCampaignScheduled = inngest.createFunction(
  {
    id: "marketing-text-campaign-scheduled",
    name: "Marketing text — resolve audience + queue recipients",
    // Serialized — audience resolve seq-scans customers per page; running
    // 4 in parallel saturated the pooler and produced 504s on unrelated
    // routes during MDW scheduling.
    concurrency: [{ limit: 1 }],
    triggers: [{ event: "marketing/text-campaign.scheduled" }],
  },
  async ({ event, step }) => {
    const { campaign_id } = event.data as { campaign_id: string };

    const campaign = await step.run("load-campaign", async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("sms_campaigns")
        .select("*")
        .eq("id", campaign_id)
        .single();
      return data;
    });
    if (!campaign) return { skipped: "campaign-not-found" };
    if (campaign.status !== "scheduled" && campaign.status !== "draft") {
      return { skipped: `status=${campaign.status}` };
    }

    // ── Generate shortlink (if a target URL is configured) ────────
    // Done before audience resolve so the body's {shortlink}
    // placeholder gets substituted with the right URL at send time.
    // Idempotent — if a slug was already issued for this campaign
    // (re-Schedule after pause/edit) we keep the existing one so
    // any pre-sent SMS keep working.
    let shortlinkSlug: string | null = campaign.shortlink_slug || null;
    if (campaign.shortlink_target_url && !shortlinkSlug) {
      // Inject UTM params so Placed Order events on Shopify carry
      // attribution back to this campaign. Klaviyo's event importer
      // parses event_properties.$extra.landing_site → utm_campaign →
      // klaviyo_events.attributed_utm_campaign. Enables:
      //   1. Per-campaign revenue attribution
      //   2. Excluding past-campaign buyers from tomorrow's send
      //      (query orders/klaviyo_events where utm_campaign = prior
      //      campaign_id)
      const utmTargetUrl = injectMarketingUtms(campaign.shortlink_target_url, campaign.id);
      shortlinkSlug = await step.run("create-shortlink", async () => {
        const admin = createAdminClient();
        // 3 tries to avoid the (vanishingly rare) slug collision.
        for (let i = 0; i < 3; i++) {
          const slug = generateShortlinkSlug(6);
          const { error } = await admin.from("marketing_shortlinks").insert({
            workspace_id: campaign.workspace_id,
            slug,
            target_url: utmTargetUrl,
            campaign_id: campaign.id,
            is_active: true,
          });
          if (!error) {
            await admin
              .from("sms_campaigns")
              .update({ shortlink_slug: slug, updated_at: new Date().toISOString() })
              .eq("id", campaign.id);
            return slug;
          }
          if (!String(error.message).includes("duplicate")) throw error;
        }
        throw new Error("shortlink slug collision — try again");
      });
    }

    // If the campaign uses an already-existing Shopify coupon embedded in
    // the shortlink target (e.g. /discount/VIP-226?redirect=…) and no
    // coupon_code was set, parse it out and persist. This is the manual-
    // coupon path; the auto-generated path below covers coupon_enabled.
    // Persisting it lets the campaign list/detail views attribute revenue
    // by coupon match as a fallback when UTM is missing.
    if (!campaign.coupon_code && campaign.shortlink_target_url) {
      const m = /\/discount\/([^/?#]+)/i.exec(campaign.shortlink_target_url);
      const parsed = m ? (() => { try { return decodeURIComponent(m[1]); } catch { return m[1]; } })() : null;
      if (parsed) {
        await step.run("persist-shortlink-coupon", async () => {
          const admin = createAdminClient();
          await admin.from("sms_campaigns")
            .update({ coupon_code: parsed, updated_at: new Date().toISOString() })
            .eq("id", campaign.id);
        });
        campaign.coupon_code = parsed;
      }
    }

    // ── Generate coupon (if enabled) ──────────────────────────────
    // Created in Shopify; we cache the code + node id on the campaign
    // for substitution + the auto-disable cron. Skipped if already
    // created (e.g. re-Schedule after edit).
    if (campaign.coupon_enabled && !campaign.coupon_code && campaign.coupon_discount_pct) {
      const result = await step.run("create-coupon", async () => {
        const expiresAt = new Date(
          Date.now() + (campaign.coupon_expires_days_after_send || 21) * 86_400_000,
        );
        return await createCampaignCoupon({
          workspaceId: campaign.workspace_id,
          campaignName: campaign.name,
          discountPct: campaign.coupon_discount_pct,
          expiresAt,
        });
      });
      if (result.error) {
        throw new Error(`coupon create failed: ${result.error}`);
      }
      await step.run("persist-coupon", async () => {
        const admin = createAdminClient();
        await admin.from("sms_campaigns").update({
          coupon_code: result.code,
          coupon_shopify_node_id: result.shopifyNodeId,
          coupon_created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", campaign.id);
      });
      campaign.coupon_code = result.code;
      campaign.coupon_shopify_node_id = result.shopifyNodeId;
    }

    const customers = await step.run("resolve-audience", async () => {
      const admin = createAdminClient();
      const filter = (campaign.audience_filter as Record<string, unknown>) || {};
      const included = (campaign.included_segments as string[]) || [];
      const excluded = (campaign.excluded_segments as string[]) || [];

      // Rebuilt per page — PostgREST queries aren't reusable across calls
      // (each .range() consumes the builder). Wrapping in a factory lets
      // us add a fresh .gt("id", lastId) for keyset pagination each loop.
      const subStatuses = filter.subscription_status as string[] | undefined;
      const buildBaseQuery = () => {
        let q = admin
          .from("customers")
          .select("id, phone, timezone, default_address, sms_marketing_status, subscription_status, segments, phone_status, preferred_sms_send_hour")
          .eq("workspace_id", campaign.workspace_id)
          .not("phone", "is", null)
          // SMS consent gate — non-negotiable.
          .eq("sms_marketing_status", "subscribed")
          // Bad-phone exclusion — phones marked invalid/unsubscribed/etc
          // by past Twilio failures get a NULL-OR-good filter.
          .or("phone_status.is.null,phone_status.eq.good");
        // Segment include — recipient must match ≥1.
        if (included.length > 0) q = q.overlaps("segments", included);
        // Optional sub-status filter (legacy, kept for back-compat).
        if (Array.isArray(subStatuses) && subStatuses.length > 0) {
          q = q.in("subscription_status", subStatuses);
        }
        return q;
      };

      // Keyset pagination — `id > lastId ORDER BY id LIMIT 1000`. Stays
      // O(1) per page regardless of audience size. OFFSET-style
      // pagination forced Postgres to re-evaluate the WHERE clause and
      // skip N rows on each page; with 4 concurrent schedules pre-fix
      // that became the saturation that locked the pool.
      type AudienceRow = CustomerForTzResolve & {
        id: string;
        phone: string;
        segments: string[] | null;
        preferred_sms_send_hour: number | null;
      };
      const pageSize = 1000;
      let rows: AudienceRow[] = [];
      let lastId: string | null = null;
      // Safety stop at 250k rows so a runaway query can't OOM the
      // Inngest worker — our largest sendable audience is ~138K.
      while (rows.length < 250000) {
        let pageQ = buildBaseQuery().order("id", { ascending: true }).limit(pageSize);
        if (lastId) pageQ = pageQ.gt("id", lastId);
        const { data, error } = await pageQ;
        if (error) throw new Error(`audience query: ${error.message}`);
        const page = (data || []) as AudienceRow[];
        rows.push(...page);
        if (page.length < pageSize) break;
        lastId = page[page.length - 1].id;
      }

      // Segment exclude — recipient must match 0 of the excluded set.
      // PostgREST doesn't expose a `NOT overlaps` operator cleanly,
      // so we filter in JS. With segments rarely > 10 items per row,
      // this is cheap.
      if (excluded.length > 0) {
        const excludeSet = new Set(excluded);
        rows = rows.filter((r) => !(r.segments || []).some((s) => excludeSet.has(s)));
      }

      return rows;
    });

    const staged = await step.run("stage-candidates", async () => {
      const admin = createAdminClient();
      const fallback = campaign.fallback_timezone || "America/Chicago";
      const baseHour = campaign.target_local_hour;
      const baseMinute = campaign.target_local_minute ?? 0;
      const fallbackHour = campaign.fallback_target_local_hour ?? 10;
      const fallbackMinute = campaign.fallback_target_local_minute ?? 0;

      // Derive campaign priority for the cross-campaign dedup pass.
      // Lower number wins. Per-campaign override on sms_campaigns.priority
      // takes precedence; otherwise derive from included_segments.
      const { computeCampaignPriority } = await import("@/lib/inngest/sms-wave-promote");
      const includedSegmentsTyped = campaign.included_segments as string[] | null;
      const effectivePriority = (campaign.priority as number | null) ?? computeCampaignPriority(includedSegmentsTyped);

      const rows = customers
        .map((c) => {
          const phone = normalizeUSPhone(c.phone || "");
          if (!phone) return null;
          const tz = resolveRecipientTimezone(c, fallback);
          const plannedHour = tz.source === "fallback" ? fallbackHour : baseHour;
          const plannedMinute = tz.source === "fallback" ? fallbackMinute : baseMinute;
          const preferred = c.preferred_sms_send_hour;
          const useFinalHour = preferred != null && preferred > plannedHour ? preferred : plannedHour;
          const useFinalMinute = preferred != null && preferred > plannedHour ? 0 : plannedMinute;

          const sendAt = computeSendInstant(
            campaign.send_date,
            useFinalHour,
            tz.timezone,
            useFinalMinute,
          );
          return {
            workspace_id: campaign.workspace_id,
            campaign_id: campaign.id,
            customer_id: c.id,
            phone,
            resolved_timezone: tz.timezone,
            timezone_source: tz.source as TimezoneSource,
            scheduled_send_at: sendAt.toISOString(),
            preferred_hour_used: useFinalHour,
            priority: effectivePriority,
          };
        })
        .filter((r): r is NonNullable<typeof r> => !!r);

      if (rows.length === 0) return { inserted: 0 };

      // Write to staging table — sms_send_candidates — not recipients
      // directly. The wave-promote function will dedup across all
      // campaigns scheduled for the same send_date and only the
      // winners become sms_campaign_recipients. Idempotent on
      // (campaign_id, phone) via the unique constraint.
      let inserted = 0;
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { error, count } = await admin
          .from("sms_send_candidates")
          .upsert(chunk, { onConflict: "campaign_id,phone", ignoreDuplicates: true, count: "exact" });
        if (error) throw new Error(`stage failed: ${error.message}`);
        inserted += count || chunk.length;
      }
      return { inserted };
    });

    await step.run("mark-staged", async () => {
      const admin = createAdminClient();
      await admin
        .from("sms_campaigns")
        .update({
          status: "audience_staged",
          audience_staged_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaign.id);
    });

    // Trigger the wave-promote handler. It debounces 2 min internally
    // so additional campaigns scheduled into the same wave (same
    // send_date) get included in the dedup pass before recipients are
    // created. wave_key combines workspace + send_date so concurrent
    // events for the same wave coalesce on the concurrency.key.
    await step.sendEvent("trigger-wave-promote", {
      name: "marketing/sms-wave.promote",
      data: {
        workspace_id: campaign.workspace_id,
        send_date: campaign.send_date,
        wave_key: `${campaign.workspace_id}:${campaign.send_date}`,
      },
    });

    return {
      campaign_id,
      audience_count: customers.length,
      staged: staged.inserted,
    };
  },
);

// ─── Submit tick — hand pending rows to Twilio SendAt ──────────────
// Architecture: we pre-compute scheduled_send_at at enqueue time, then
// this cron submits each row to Twilio's Messaging Service. Twilio
// holds the message server-side until SendAt fires, then delivers via
// the short code. For sends already <15 min away we POST without
// SendAt and Twilio sends immediately.
export const textCampaignSendTick = inngest.createFunction(
  {
    id: "marketing-text-campaign-send-tick",
    name: "Marketing text — submit pending recipients to Twilio (cron)",
    // Concurrency: short code 85041 supports 100 MPS (~6000/min) per
    // CTIA. 80 in flight at once = ~80/sec submission rate, well under.
    concurrency: [{ limit: 80 }],
    retries: 3,
    triggers: [{ cron: "*/5 * * * *" }], // every 5 min (CEO 2026-07-11 monitoring-cost guardrail: MONITOR_TICK_FLOOR_MS)
  },
  async ({ step }) => {
    const due = await step.run("pick-due-recipients", async () => {
      const admin = createAdminClient();
      // Pick pending rows NOT yet submitted to Twilio, with
      // scheduled_send_at within Twilio's 7-day SendAt window.
      const sevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data } = await admin
        .from("sms_campaign_recipients")
        .select("id, campaign_id, workspace_id, customer_id, phone, scheduled_send_at, customer:customers!sms_campaign_recipients_customer_id_fkey(short_code)")
        .eq("status", "pending")
        .is("scheduled_at_twilio", null)
        .lte("scheduled_send_at", sevenDays)
        .order("scheduled_send_at", { ascending: true })
        .limit(1000); // raised from 200 — submission is fast (just an API call)
      return (data || []).map((r) => ({
        id: r.id as string,
        campaign_id: r.campaign_id as string,
        workspace_id: r.workspace_id as string,
        customer_id: r.customer_id as string | null,
        phone: r.phone as string,
        scheduled_send_at: r.scheduled_send_at as string,
        customer_short_code: ((r.customer as unknown) as { short_code?: string | null } | null)?.short_code || null,
      }));
    });

    // ── Inline shortcode safety net ────────────────────────────────
    // If any recipient's customer is missing a short_code (e.g. a
    // legacy row pre-dating the trigger migration), generate one
    // before we build the personalized shortlink. Without this, the
    // send falls back to the bare campaign slug and we lose click
    // attribution to that customer. The trigger from migration
    // 20260518160000 fires on a no-op UPDATE that touches the
    // sms_marketing_status column, so we kick it that way.
    const missingCode = due.filter((r) => r.customer_id && !r.customer_short_code);
    if (missingCode.length > 0) {
      await step.run("ensure-shortcodes", async () => {
        const admin = createAdminClient();
        const ids = [...new Set(missingCode.map((r) => r.customer_id as string))];
        // Trigger needs the OF column actually present in the UPDATE.
        // Setting sms_marketing_status to itself is a no-op value-wise
        // but does fire BEFORE UPDATE OF sms_marketing_status.
        for (const cid of ids) {
          await admin
            .from("customers")
            .update({ sms_marketing_status: "subscribed", updated_at: new Date().toISOString() })
            .eq("id", cid)
            .eq("sms_marketing_status", "subscribed")
            .is("short_code", null);
        }
        const { data: refreshed } = await admin
          .from("customers")
          .select("id, short_code")
          .in("id", ids);
        const map = new Map((refreshed || []).map((c) => [c.id as string, c.short_code as string | null]));
        for (const r of due) {
          if (r.customer_id && !r.customer_short_code) {
            r.customer_short_code = map.get(r.customer_id) || null;
          }
        }
      });
    }

    if (due.length === 0) {
      // Idle tick: still beat so Control Tower reads green. The heartbeat
      // means "Inngest invoked me", independent of whether there was work
      // (cron-heartbeat-on-idle-tick spec). Without this, a healthy-but-idle
      // cron never writes a beat and trips monitor.ts never_fired.
      const result = { sent: 0 };
      await step.run("emit-heartbeat", async () => {
        await emitCronHeartbeat("marketing-text-campaign-send-tick", { ok: true, produced: result });
      });
      return result;
    }

    // 12-hour rate-limit enforcement moved INTO the per-recipient
    // `claim-${id}` step below. The previous design built an
    // in-memory `recentlySent` Set at tick start and mutated it as
    // each send completed — but that pattern is broken under Inngest's
    // step-replay model. Outer-scope mutations aren't reapplied on
    // replay; cached step results are returned without re-running
    // their bodies, so the dedup state from the first iteration
    // disappears by the time the second runs. Result: Dylan got both
    // SUMMERFIT engaged and SUMMERFIT just_ordered on 2026-05-31. The
    // per-recipient live-DB query inside claim is replay-safe.

    // Group by campaign so we can load the message body once per
    // campaign instead of per recipient.
    const campaignIds = [...new Set(due.map((r) => r.campaign_id))];
    const campaigns = await step.run("load-campaigns", async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("sms_campaigns")
        .select("id, message_body, media_url, status, workspace_id, coupon_code, shortlink_slug")
        .in("id", campaignIds);
      // Also load per-workspace Messaging Service SID for the marketing
      // shortcode. Sending via MessagingServiceSid (vs direct From) is
      // required for Twilio SendAt scheduled delivery.
      const workspaceIds = [...new Set((data || []).map((c) => c.workspace_id))];
      const { data: workspaces } = await admin
        .from("workspaces")
        .select("id, twilio_marketing_messaging_service_sid")
        .in("id", workspaceIds);
      const mssByWs = new Map<string, string | null>();
      for (const w of workspaces || []) mssByWs.set(w.id, w.twilio_marketing_messaging_service_sid);

      // Resolve each campaign's full shortlink URL once per tick.
      const map = new Map<string, {
        id: string;
        message_body: string;
        media_url: string | null;
        status: string;
        workspace_id: string;
        coupon_code: string | null;
        shortlink_url: string | null;
        messaging_service_sid: string | null;
      }>();
      for (const c of data || []) {
        const shortlinkUrl = c.shortlink_slug
          ? await buildShortlinkUrl(c.workspace_id, c.shortlink_slug)
          : null;
        map.set(c.id, {
          ...c,
          shortlink_url: shortlinkUrl,
          messaging_service_sid: mssByWs.get(c.workspace_id) || null,
        });
      }
      return Array.from(map.entries());
    });
    const campaignMap = new Map(campaigns);

    let sentCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const recipient of due) {
      const campaign = campaignMap.get(recipient.campaign_id);
      if (!campaign) continue;

      // Pause / cancel honored mid-drain.
      if (campaign.status === "paused" || campaign.status === "cancelled") {
        await step.run(`skip-${recipient.id}`, async () => {
          const admin = createAdminClient();
          await admin
            .from("sms_campaign_recipients")
            .update({ status: "skipped", updated_at: new Date().toISOString() })
            .eq("id", recipient.id)
            .eq("status", "pending"); // race-safe
        });
        skippedCount++;
        continue;
      }

      // Atomic CAS claim — prevents two concurrent ticks from sending
      // the same row twice. Cross-campaign dedup is now handled
      // BEFORE recipients exist, by the wave-promote function reading
      // sms_send_candidates and inserting only winners into this
      // table. The previous per-recipient rate-limit subquery here
      // was correct but expensive (N live queries per tick); pulling
      // dedup forward to scheduling time removes the DB pressure.
      const claimed = await step.run(`claim-${recipient.id}`, async () => {
        const admin = createAdminClient();
        const { data, error } = await admin
          .from("sms_campaign_recipients")
          .update({ status: "sending", updated_at: new Date().toISOString() })
          .eq("id", recipient.id)
          .eq("status", "pending")
          .select("id")
          .maybeSingle();
        if (error) return false;
        return !!data;
      });
      if (!claimed) continue; // someone else picked it up

      // Decide: schedule via SendAt or send immediately?
      // Twilio's SendAt requires 15+ min in the future. For sends
      // closer than that, POST without SendAt and Twilio delivers
      // right away.
      const sendAtMs = Date.parse(recipient.scheduled_send_at);
      const useSendAt = sendAtMs - Date.now() >= 15 * 60 * 1000;

      const result = await step.run(`send-${recipient.id}`, async () => {
        // Append the customer's permanent short_code so the shortlink
        // URL identifies them on click (superfd.co/{slug}/{short_code}).
        // The redirect handler resolves the trailing segment against
        // customers.short_code and sets the sx_customer cookie. Falls
        // back to the bare shortlink if the customer somehow has no
        // code — shouldn't happen post-backfill, but covered.
        const personalShortlink = campaign.shortlink_url && recipient.customer_short_code
          ? `${campaign.shortlink_url}/${recipient.customer_short_code}`
          : campaign.shortlink_url || "";
        const body = campaign.message_body
          .replace(/\{coupon\}/g, campaign.coupon_code || "")
          .replace(/\{shortlink\}/g, personalShortlink);
        const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";
        return await sendSMS(recipient.workspace_id, recipient.phone, body, {
          mediaUrl: campaign.media_url,
          statusCallback: `${siteUrl}/api/webhooks/twilio/marketing-status`,
          messagingServiceSid: campaign.messaging_service_sid,
          sendAt: useSendAt ? new Date(sendAtMs) : null,
        });
      });

      await step.run(`finalize-${recipient.id}`, async () => {
        const admin = createAdminClient();
        if (result.success) {
          // Distinguish "Twilio accepted and will send later" from
          // "Twilio accepted and sent immediately":
          //   - status='scheduled' when SendAt was used
          //   - status='sent' when sent immediately (no SendAt)
          // The status callback later flips both to 'delivered' or
          // 'failed' based on carrier response.
          await admin
            .from("sms_campaign_recipients")
            .update({
              status: useSendAt ? "scheduled" : "sent",
              message_sid: result.messageSid || null,
              scheduled_at_twilio: new Date().toISOString(),
              sent_at: useSendAt ? null : new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", recipient.id);
          sentCount++;
          // Log a `Received SMS` engagement event tied to our customer
          // UUID. Mirrors the Klaviyo metric shape so segmentation reads
          // both sources uniformly (clicked_sms_60d etc. just match on
          // metric_name). Fire-and-forget; one missing event doesn't
          // block a successful send.
          if (recipient.customer_id && !useSendAt) {
            void admin.from("profile_events").insert({
              workspace_id: recipient.workspace_id,
              customer_id: recipient.customer_id,
              metric_name: "Received SMS",
              datetime: new Date().toISOString(),
              attributed_campaign_id: campaign.id,  // our sms_campaigns.id
            });
          }
        } else {
          const phoneStatus = classifyTwilioError(result.errorCode);
          const isFatal = phoneStatus !== null;
          await admin
            .from("sms_campaign_recipients")
            .update({
              status: isFatal ? "failed_permanent" : "failed",
              error: result.errorCode ? `${result.errorCode}: ${result.error}` : result.error || "unknown",
              updated_at: new Date().toISOString(),
            })
            .eq("id", recipient.id);
          if (isFatal && recipient.customer_id) {
            await admin
              .from("customers")
              .update({
                phone_status: phoneStatus,
                phone_status_code: result.errorCode,
                phone_status_at: new Date().toISOString(),
              })
              .eq("id", recipient.customer_id);
          }
          failedCount++;
        }
      });
    }

    // Roll up campaign stats — recipients_sent counts everything Twilio
    // accepted (sent + scheduled + delivered). Campaign is "complete"
    // when nothing's still pending or in-flight.
    await step.run("update-campaign-stats", async () => {
      const admin = createAdminClient();
      for (const cid of campaignIds) {
        const { count: sent } = await admin
          .from("sms_campaign_recipients")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", cid)
          .in("status", ["sent", "scheduled", "delivered"]);
        const { count: failed } = await admin
          .from("sms_campaign_recipients")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", cid)
          .in("status", ["failed", "failed_permanent"]);
        const { count: pending } = await admin
          .from("sms_campaign_recipients")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", cid)
          .in("status", ["pending", "sending"]);

        const completed = pending === 0;
        await admin
          .from("sms_campaigns")
          .update({
            recipients_sent: sent || 0,
            recipients_failed: failed || 0,
            status: completed ? "sent" : "sending",
            ...(completed ? { completed_at: new Date().toISOString() } : {}),
            updated_at: new Date().toISOString(),
          })
          .eq("id", cid);
      }
    });

    const result = { sent: sentCount, failed: failedCount, skipped: skippedCount };
    // Control Tower: end-of-run heartbeat (control-tower-complete-coverage spec, Phase 1).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("marketing-text-campaign-send-tick", { ok: true, produced: result });
    });
    return result;
  },
);

/**
 * Inject UTM tracking params into a campaign target URL so the
 * Placed Order event Klaviyo fires carries attribution back to this
 * SMS campaign.
 *
 * For Shopify discount URLs (?redirect=/path...) we inject UTMs on
 * BOTH layers:
 *   - Outer URL — so Shopify's session-entry capture (landing_site)
 *     records them. UTMs only inside the redirect param sometimes
 *     get dropped before the redirect step (Shopify community thread
 *     2023+ confirms this; verified live 2026-05-16 on superfoodscompany.com).
 *   - Inside the redirect= value — so the final landing URL the
 *     customer sees still has them (visible in address bar; survives
 *     for any client-side analytics / FB Pixel / GA4).
 *
 * For non-discount URLs, just inject on the URL's own query string.
 *
 * Existing utm_* params are preserved (admin override wins) — we
 * only add params that aren't already present.
 */
function injectMarketingUtms(rawUrl: string, campaignId: string): string {
  const utmDefaults: Record<string, string> = {
    utm_source: "shopcx_sms",
    utm_medium: "sms",
    utm_campaign: campaignId,
  };
  try {
    const url = new URL(rawUrl);
    const redirectParam = url.searchParams.get("redirect");
    if (redirectParam) {
      // Inject INSIDE the redirect target so they show on the
      // final landing URL.
      const dummyBase = "https://_redirect_/";
      const redirUrl = new URL(redirectParam, dummyBase);
      for (const [k, v] of Object.entries(utmDefaults)) {
        if (!redirUrl.searchParams.has(k)) redirUrl.searchParams.set(k, v);
      }
      const rebuiltRedirect = redirUrl.pathname + (redirUrl.search || "");
      url.searchParams.set("redirect", rebuiltRedirect);
    }
    // ALSO inject on the outer URL. This is the version Shopify's
    // session tracking sees first — necessary for the Placed Order
    // event's landing_site / $extra.full_landing_site to carry UTMs.
    for (const [k, v] of Object.entries(utmDefaults)) {
      if (!url.searchParams.has(k)) url.searchParams.set(k, v);
    }
    return url.toString();
  } catch {
    // Malformed URL — return as-is, admin will fix and re-schedule.
    return rawUrl;
  }
}

/**
 * Map a Twilio API error code to a customers.phone_status value, OR
 * null if the failure is transient and we should leave the customer
 * alone. Reference: https://www.twilio.com/docs/api/errors
 *
 * Fatal codes update customers.phone_status so future campaigns skip
 * the customer automatically. Transient codes (rate limits, queue
 * overflows, infrastructure blips) return null — we just mark the
 * recipient row as failed without poisoning the customer.
 */
function classifyTwilioError(code: number | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case 21211: // Invalid 'To' Phone Number
    case 21217: // Phone number does not appear to be valid
    case 21407: // This Phone Number type is not supported by Twilio
    case 21421: // PhoneNumber is invalid
    case 21614: // 'To' number is not a valid mobile number (landline)
    case 21660: // Mismatch between From and Messaging Service
      return "invalid";
    case 21408: // Permission to send SMS not enabled for the region
    case 21612: // 'To' phone number cannot receive SMS
      return "carrier_violation";
    case 21610: // Attempt to send to unsubscribed recipient
      return "unsubscribed";
    case 30003: // Unreachable destination handset
    case 30004: // Message blocked
    case 30005: // Unknown destination handset
    case 30006: // Landline or unreachable carrier
    case 30007: // Carrier violation (spam)
    case 30008: // Unknown error from carrier
      return "blocked";
    default:
      return null; // transient / unknown — don't poison the customer
  }
}

/**
 * Normalize a US phone string into E.164 (+1XXXXXXXXXX). Returns null
 * if we can't (international, too short, too many digits, etc).
 */
function normalizeUSPhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
