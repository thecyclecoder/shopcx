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

// ─── Scheduled — build the recipient queue ─────────────────────────
export const textCampaignScheduled = inngest.createFunction(
  {
    id: "marketing-text-campaign-scheduled",
    name: "Marketing text — resolve audience + queue recipients",
    concurrency: [{ limit: 4 }],
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
      shortlinkSlug = await step.run("create-shortlink", async () => {
        const admin = createAdminClient();
        // 3 tries to avoid the (vanishingly rare) slug collision.
        for (let i = 0; i < 3; i++) {
          const slug = generateShortlinkSlug(6);
          const { error } = await admin.from("marketing_shortlinks").insert({
            workspace_id: campaign.workspace_id,
            slug,
            target_url: campaign.shortlink_target_url,
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

      let q = admin
        .from("customers")
        .select("id, phone, timezone, default_address, sms_marketing_status, subscription_status, segments, phone_status, preferred_sms_send_hour")
        .eq("workspace_id", campaign.workspace_id)
        .not("phone", "is", null);

      // SMS consent gate — non-negotiable.
      q = q.eq("sms_marketing_status", "subscribed");

      // Bad-phone exclusion — phones marked invalid/unsubscribed/etc
      // by past Twilio failures get a NULL-OR-good filter.
      q = q.or("phone_status.is.null,phone_status.eq.good");

      // Segment include — recipient must match ≥1.
      if (included.length > 0) {
        q = q.overlaps("segments", included);
      }

      // Optional sub-status filter (legacy, kept for back-compat).
      const subStatuses = filter.subscription_status as string[] | undefined;
      if (Array.isArray(subStatuses) && subStatuses.length > 0) {
        q = q.in("subscription_status", subStatuses);
      }

      const { data } = await q.limit(200000); // raised cap for SMS-subscribed bases
      let rows = (data || []) as Array<CustomerForTzResolve & { id: string; phone: string; segments: string[] | null; preferred_sms_send_hour: number | null }>;

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

    const enqueued = await step.run("enqueue-recipients", async () => {
      const admin = createAdminClient();
      const fallback = campaign.fallback_timezone || "America/Chicago";
      const baseHour = campaign.target_local_hour;
      const fallbackHour = campaign.fallback_target_local_hour ?? 10;

      const rows = customers
        .map((c) => {
          const phone = normalizeUSPhone(c.phone || "");
          if (!phone) return null;
          const tz = resolveRecipientTimezone(c, fallback);
          // Hour resolution chain:
          //   1. Planned hour (fallback hour if recipient's tz was the
          //      workspace fallback, target_local_hour otherwise).
          //   2. If customer has a preferred_sms_send_hour AND it's
          //      LATER than the planned hour, use it. Never moves a
          //      recipient earlier than the campaign's intended time.
          const plannedHour = tz.source === "fallback" ? fallbackHour : baseHour;
          const preferred = c.preferred_sms_send_hour;
          const finalHour = preferred != null && preferred > plannedHour ? preferred : plannedHour;

          const sendAt = computeSendInstant(
            campaign.send_date,
            finalHour,
            tz.timezone,
          );
          return {
            workspace_id: campaign.workspace_id,
            campaign_id: campaign.id,
            customer_id: c.id,
            phone,
            resolved_timezone: tz.timezone,
            timezone_source: tz.source as TimezoneSource,
            scheduled_send_at: sendAt.toISOString(),
            preferred_hour_used: finalHour,
            status: "pending",
          };
        })
        .filter((r): r is NonNullable<typeof r> => !!r);

      if (rows.length === 0) return { inserted: 0 };

      // Upsert with ignoreDuplicates so re-running Schedule on an
      // already-queued campaign doesn't double-insert.
      const { error } = await admin
        .from("sms_campaign_recipients")
        .upsert(rows, { onConflict: "campaign_id,phone", ignoreDuplicates: true });
      if (error) throw new Error(`enqueue failed: ${error.message}`);

      return { inserted: rows.length };
    });

    await step.run("mark-scheduled", async () => {
      const admin = createAdminClient();
      await admin
        .from("sms_campaigns")
        .update({
          status: "scheduled",
          recipients_total: enqueued.inserted,
          scheduled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", campaign.id);
    });

    return {
      campaign_id,
      audience_count: customers.length,
      enqueued: enqueued.inserted,
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
    triggers: [{ cron: "* * * * *" }], // every minute
  },
  async ({ step }) => {
    const due = await step.run("pick-due-recipients", async () => {
      const admin = createAdminClient();
      // Pick pending rows NOT yet submitted to Twilio, with
      // scheduled_send_at within Twilio's 7-day SendAt window.
      const sevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data } = await admin
        .from("sms_campaign_recipients")
        .select("id, campaign_id, workspace_id, customer_id, phone, scheduled_send_at")
        .eq("status", "pending")
        .is("scheduled_at_twilio", null)
        .lte("scheduled_send_at", sevenDays)
        .order("scheduled_send_at", { ascending: true })
        .limit(1000); // raised from 200 — submission is fast (just an API call)
      return (data || []) as Array<{
        id: string;
        campaign_id: string;
        workspace_id: string;
        customer_id: string | null;
        phone: string;
        scheduled_send_at: string;
      }>;
    });

    if (due.length === 0) return { sent: 0 };

    // ── 12-hour rate limit safety net ────────────────────────────
    // Even if exclusion config is wrong, no customer gets two
    // campaign SMS within 12 hours. We check by scheduled_send_at
    // (not sent_at) so already-scheduled-but-not-yet-delivered
    // messages still count — otherwise two campaigns scheduled
    // back-to-back could both submit to Twilio for the same person.
    const customerIds = [...new Set(due.map((r) => r.customer_id).filter((c): c is string => !!c))];
    const recentlySent = new Set<string>();
    if (customerIds.length > 0) {
      // Window: 12h before earliest due send → 12h after latest due
      // send. Any prior message landing in that window blocks this one.
      const earliest = Math.min(...due.map((r) => Date.parse(r.scheduled_send_at)));
      const latest = Math.max(...due.map((r) => Date.parse(r.scheduled_send_at)));
      const windowStart = new Date(earliest - 12 * 60 * 60 * 1000).toISOString();
      const windowEnd = new Date(latest + 12 * 60 * 60 * 1000).toISOString();
      const recent = await step.run("rate-limit-check", async () => {
        const admin = createAdminClient();
        const { data } = await admin
          .from("sms_campaign_recipients")
          .select("customer_id")
          .in("customer_id", customerIds)
          .in("status", ["sent", "scheduled", "delivered"])
          .gte("scheduled_send_at", windowStart)
          .lte("scheduled_send_at", windowEnd);
        return (data || []) as Array<{ customer_id: string }>;
      });
      for (const r of recent) recentlySent.add(r.customer_id);
    }

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

      // 12-hour rate limit — hard floor. Catches misconfigured
      // exclusions where the same customer ends up in two campaigns.
      if (recipient.customer_id && recentlySent.has(recipient.customer_id)) {
        await step.run(`rate-limit-${recipient.id}`, async () => {
          const admin = createAdminClient();
          await admin
            .from("sms_campaign_recipients")
            .update({ status: "skipped_rate_limit", updated_at: new Date().toISOString() })
            .eq("id", recipient.id)
            .eq("status", "pending");
        });
        skippedCount++;
        continue;
      }

      // Claim the row before submitting so a slow Twilio call doesn't
      // race with the next tick. Atomic CAS via the eq("status","pending").
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
        const body = campaign.message_body
          .replace(/\{coupon\}/g, campaign.coupon_code || "")
          .replace(/\{shortlink\}/g, campaign.shortlink_url || "");
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
          if (recipient.customer_id) recentlySent.add(recipient.customer_id);
          sentCount++;
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

    return { sent: sentCount, failed: failedCount, skipped: skippedCount };
  },
);

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
