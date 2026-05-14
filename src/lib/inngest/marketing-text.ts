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

    const customers = await step.run("resolve-audience", async () => {
      const admin = createAdminClient();
      const filter = (campaign.audience_filter as Record<string, unknown>) || {};

      let q = admin
        .from("customers")
        .select("id, phone, timezone, default_address, sms_marketing_status, subscription_status")
        .eq("workspace_id", campaign.workspace_id)
        .not("phone", "is", null);

      // SMS consent gate — non-negotiable.
      q = q.eq("sms_marketing_status", "subscribed");

      // Optional sub-status filter
      const subStatuses = filter.subscription_status as string[] | undefined;
      if (Array.isArray(subStatuses) && subStatuses.length > 0) {
        q = q.in("subscription_status", subStatuses);
      }

      // Optional min-orders filter (deferred — needs aggregate join)
      // For now, leave to the AI scheduler / Klaviyo import pass.

      const { data } = await q.limit(50000); // hard cap; warn if hit
      return (data || []) as Array<CustomerForTzResolve & { id: string; phone: string }>;
    });

    const enqueued = await step.run("enqueue-recipients", async () => {
      const admin = createAdminClient();
      const fallback = campaign.fallback_timezone || "America/Chicago";

      const rows = customers
        .map((c) => {
          const phone = normalizeUSPhone(c.phone || "");
          if (!phone) return null;
          const tz = resolveRecipientTimezone(c, fallback);
          const sendAt = computeSendInstant(
            campaign.send_date,
            campaign.target_local_hour,
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

// ─── Send tick — drain the queue ───────────────────────────────────
export const textCampaignSendTick = inngest.createFunction(
  {
    id: "marketing-text-campaign-send-tick",
    name: "Marketing text — send pending recipients (cron)",
    // Concurrency cap protects Twilio's account-level rate limit
    // (default 1 msg/sec, can be raised with their support). 20 in
    // flight at once = ~20/sec when each call takes ~1s round trip.
    concurrency: [{ limit: 20 }],
    retries: 3,
    triggers: [{ cron: "* * * * *" }], // every minute
  },
  async ({ step }) => {
    const due = await step.run("pick-due-recipients", async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("sms_campaign_recipients")
        .select("id, campaign_id, workspace_id, phone")
        .eq("status", "pending")
        .lte("scheduled_send_at", new Date().toISOString())
        .order("scheduled_send_at", { ascending: true })
        .limit(200); // batch cap per tick — 200/min keeps us comfortable
      return (data || []) as Array<{
        id: string;
        campaign_id: string;
        workspace_id: string;
        phone: string;
      }>;
    });

    if (due.length === 0) return { sent: 0 };

    // Group by campaign so we can load the message body once per
    // campaign instead of per recipient.
    const campaignIds = [...new Set(due.map((r) => r.campaign_id))];
    const campaigns = await step.run("load-campaigns", async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("sms_campaigns")
        .select("id, message_body, media_url, status, workspace_id")
        .in("id", campaignIds);
      const map = new Map<string, { id: string; message_body: string; media_url: string | null; status: string; workspace_id: string }>();
      for (const c of data || []) map.set(c.id, c);
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

      // Claim the row before sending so a slow Twilio call doesn't
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

      const result = await step.run(`send-${recipient.id}`, async () => {
        return await sendSMS(
          recipient.workspace_id,
          recipient.phone,
          campaign.message_body,
        );
        // TODO: pass mediaUrl when sendSMS supports MMS — needs
        // sendSMS extension to forward the MediaUrl param to Twilio.
      });

      await step.run(`finalize-${recipient.id}`, async () => {
        const admin = createAdminClient();
        if (result.success) {
          await admin
            .from("sms_campaign_recipients")
            .update({
              status: "sent",
              message_sid: result.messageSid || null,
              sent_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", recipient.id);
          sentCount++;
        } else {
          await admin
            .from("sms_campaign_recipients")
            .update({
              status: "failed",
              error: result.error || "unknown",
              updated_at: new Date().toISOString(),
            })
            .eq("id", recipient.id);
          failedCount++;
        }
      });
    }

    // Roll up campaign stats — recipients_sent + recipients_failed.
    await step.run("update-campaign-stats", async () => {
      const admin = createAdminClient();
      for (const cid of campaignIds) {
        const { count: sent } = await admin
          .from("sms_campaign_recipients")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", cid)
          .eq("status", "sent");
        const { count: failed } = await admin
          .from("sms_campaign_recipients")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", cid)
          .eq("status", "failed");
        const { count: pending } = await admin
          .from("sms_campaign_recipients")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", cid)
          .eq("status", "pending");

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
 * Normalize a US phone string into E.164 (+1XXXXXXXXXX). Returns null
 * if we can't (international, too short, too many digits, etc).
 */
function normalizeUSPhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
