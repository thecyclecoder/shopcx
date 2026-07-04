/**
 * SMS status-callback drain (Phase 2 of twilio-callback-queue-drain).
 *
 * Consumes `sms/status-callback.received` events that the fast-ack webhook
 * (`src/app/api/webhooks/twilio/marketing-status/route.ts`) enqueues for
 * every Twilio delivery-status callback. All DB work that used to run on
 * the webhook request path (~100k+ writes during a ~50k blast) happens
 * here — bounded/batched off the request path so Postgres can't get
 * DDoS'd by a marketing send storm.
 *
 * Shape:
 *   - `concurrency: [{ limit: 8 }]` — same pattern as
 *     `abandoned-cart.ts:52`. Runtime dial for drain-rate; bump/cut here
 *     when Postgres headroom changes.
 *   - `batchEvents: { maxSize: 100, timeout: "5s" }` — Inngest hands the
 *     handler up to 100 callbacks at a time. Bulk-updates then collapse
 *     N sids into O(transition-groups) UPDATEs.
 *   - Idempotent on MessageSid. Twilio can re-deliver the same callback;
 *     the dedup within batch + stage-rank guard on the UPDATE mean a
 *     re-drain of the same batch leaves identical row state.
 *   - Out-of-order (delivered before sent) resolved by lifecycle-stage
 *     rank: the UPDATE for `status='sent'` only touches rows in
 *     ['scheduled','sending','sent']; a late 'sent' can't clobber a
 *     'delivered'.
 *   - Split: delivered/sent → bulk transition UPDATEs; failed/undelivered
 *     → per-row (needs customer_id to flip customers.phone_status on
 *     fatal carrier codes).
 *   - Fallback: sids that aren't campaign recipients are matched against
 *     `storefront_leads.sms_message_sid` (popup-coupon SMS sends direct
 *     from the short code, per docs/brain/integrations/twilio.md).
 *   - Campaign counters: after every batch, recount touched
 *     `sms_campaigns.recipients_sent` / `recipients_failed` — same
 *     recount pattern as `marketing-text.ts` send-tick, not a naive
 *     increment (so a re-drained batch never double-counts).
 *
 * `profile_events` "Received SMS" insert on delivered is preserved from
 * the pre-fast-ack inline code path. Phase 4 moves it to a watermarked
 * rollup for true idempotency; the segmentation layer today treats
 * duplicates as one engagement slot.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";

/** Lifecycle-stage rank — higher wins when dedup'ing multiple callbacks per MessageSid. */
const STAGE_RANK: Record<string, number> = {
  sent: 1,
  delivered: 2,
  undelivered: 3,
  failed: 3,
};

/**
 * Fatal-error → phone_status map. Mirrors `classifyTwilioError` in
 * `marketing-text.ts` (kept inline so the two callers can diverge if
 * carrier-specific codes need different handling later).
 */
function classifyTwilioError(code: number | undefined): string | null {
  if (!code) return null;
  switch (code) {
    case 21211:
    case 21217:
    case 21407:
    case 21421:
    case 21614:
    case 21660:
      return "invalid";
    case 21408:
    case 21612:
      return "carrier_violation";
    case 21610:
      return "unsubscribed";
    case 30003:
    case 30004:
    case 30005:
    case 30006:
    case 30007:
    case 30008:
      return "blocked";
    default:
      return null;
  }
}

export const smsCallbackDrain = inngest.createFunction(
  {
    id: "sms-callback-drain",
    name: "Twilio — SMS status-callback drain (delivered→aggregate, failed→per-row)",
    // Drain-rate dial. Concurrency is scoped per-function across the
    // whole Inngest app — 8 parallel runs × batch size 100 caps at 800
    // callbacks in flight regardless of how many the webhook enqueues.
    concurrency: [{ limit: 8 }],
    // Latency vs bulk-efficiency dial. 5s tail keeps a quiet stream
    // moving; 100-event ceiling caps the per-run write burst.
    batchEvents: { maxSize: 100, timeout: "5s" },
    triggers: [{ event: "sms/status-callback.received" }],
  },
  async ({ events, step }) => {
    // ── Dedup within batch by MessageSid, keep highest lifecycle rank ──
    // Twilio can deliver `sent` then `delivered` in-order OR the same
    // callback twice on retry — either way we want ONE terminal state
    // per sid in this batch.
    type Best = {
      params: Record<string, string>;
      status: "sent" | "delivered" | "failed" | "undelivered";
      rank: number;
    };
    const bestBySid = new Map<string, Best>();
    for (const ev of events) {
      const data = ev.data as { params?: Record<string, string> } | undefined;
      const params = data?.params;
      if (!params) continue;
      const sid = params.MessageSid;
      const status = (params.MessageStatus || "").toLowerCase();
      const rank = STAGE_RANK[status];
      if (!sid || !rank) continue; // ignore queued/sending — no-op today
      const prev = bestBySid.get(sid);
      if (!prev || rank > prev.rank) {
        bestBySid.set(sid, { params, status: status as Best["status"], rank });
      }
    }

    if (bestBySid.size === 0) {
      return { drained: 0 };
    }

    // Bucket by transition group. Delivered/sent → bulk; failed → per-row.
    const sentSids: string[] = [];
    const deliveredSids: string[] = [];
    const failedRows: Array<{
      sid: string;
      errorCode: number | undefined;
      errorMessage: string | undefined;
      phoneStatus: string | null;
      isFatal: boolean;
    }> = [];
    for (const [sid, row] of bestBySid) {
      if (row.status === "sent") {
        sentSids.push(sid);
      } else if (row.status === "delivered") {
        deliveredSids.push(sid);
      } else {
        const codeStr = row.params.ErrorCode;
        const errorCode = codeStr ? parseInt(codeStr, 10) : undefined;
        const phoneStatus = classifyTwilioError(errorCode);
        failedRows.push({
          sid,
          errorCode,
          errorMessage: row.params.ErrorMessage,
          phoneStatus,
          isFatal: phoneStatus !== null,
        });
      }
    }

    // Track sids that matched a real campaign recipient — the leftovers
    // are storefront_leads (popup-coupon SMS) or another-system sends
    // and get handled in the storefront-leads step.
    const matchedRecipientSids = new Set<string>();
    // Campaigns whose counters need recount after this batch.
    const touchedCampaigns = new Set<string>();
    // Delivered recipients that still need a "Received SMS" profile
    // event (only campaign recipients — leads don't have customer_id).
    const deliveredProfileRows: Array<{
      workspace_id: string;
      customer_id: string;
      campaign_id: string;
    }> = [];

    // ── Bulk: sent transition ─────────────────────────────────────────
    // Stage-rank guard: only advance rows still in-flight or already
    // marked sent (idempotent). Never overwrite delivered/failed_*.
    if (sentSids.length > 0) {
      await step.run("bulk-sent", async () => {
        const admin = createAdminClient();
        const now = new Date().toISOString();
        const { data: rows } = await admin
          .from("sms_campaign_recipients")
          .update({ status: "sent", sent_at: now, updated_at: now })
          .in("message_sid", sentSids)
          .in("status", ["scheduled", "sending", "sent"])
          .select("id, campaign_id, message_sid");
        for (const r of (rows || []) as Array<{ id: string; campaign_id: string; message_sid: string }>) {
          matchedRecipientSids.add(r.message_sid);
          touchedCampaigns.add(r.campaign_id);
        }
        // Also match any sids whose recipient exists but is already
        // past 'sent' (guard rejected the UPDATE) — still not leads.
        const remaining = sentSids.filter((s) => !matchedRecipientSids.has(s));
        if (remaining.length > 0) {
          const { data: existing } = await admin
            .from("sms_campaign_recipients")
            .select("message_sid, campaign_id")
            .in("message_sid", remaining);
          for (const r of (existing || []) as Array<{ message_sid: string; campaign_id: string }>) {
            matchedRecipientSids.add(r.message_sid);
            touchedCampaigns.add(r.campaign_id);
          }
        }
      });
    }

    // ── Bulk: delivered transition ────────────────────────────────────
    // Stage-rank guard: don't downgrade failed_* rows.
    if (deliveredSids.length > 0) {
      await step.run("bulk-delivered", async () => {
        const admin = createAdminClient();
        const now = new Date().toISOString();
        const { data: rows } = await admin
          .from("sms_campaign_recipients")
          .update({ status: "delivered", delivered_at: now, updated_at: now })
          .in("message_sid", deliveredSids)
          .in("status", ["scheduled", "sending", "sent", "delivered"])
          .select("id, workspace_id, customer_id, campaign_id, message_sid");
        for (const r of (rows || []) as Array<{
          id: string;
          workspace_id: string;
          customer_id: string | null;
          campaign_id: string;
          message_sid: string;
        }>) {
          matchedRecipientSids.add(r.message_sid);
          touchedCampaigns.add(r.campaign_id);
          if (r.customer_id) {
            deliveredProfileRows.push({
              workspace_id: r.workspace_id,
              customer_id: r.customer_id,
              campaign_id: r.campaign_id,
            });
          }
        }
        // Same leftover pass as sent — sids whose row is past the
        // guarded prev-state (rare) are still not leads.
        const remaining = deliveredSids.filter((s) => !matchedRecipientSids.has(s));
        if (remaining.length > 0) {
          const { data: existing } = await admin
            .from("sms_campaign_recipients")
            .select("message_sid, campaign_id")
            .in("message_sid", remaining);
          for (const r of (existing || []) as Array<{ message_sid: string; campaign_id: string }>) {
            matchedRecipientSids.add(r.message_sid);
            touchedCampaigns.add(r.campaign_id);
          }
        }
      });
    }

    // ── Per-row: failed / undelivered ────────────────────────────────
    // Terminal; no stage-rank guard on the recipient update (matches
    // pre-fast-ack behavior). We DO guard against overwriting an
    // already-delivered row — if delivered arrived first, don't flip
    // back to failed.
    if (failedRows.length > 0) {
      await step.run("per-row-failed", async () => {
        const admin = createAdminClient();
        const now = new Date().toISOString();
        // Look up recipients + their current status in one shot; splits
        // the fatal path (need customer_id to flip customers.phone_status)
        // from the storefront-leads fallback path.
        const { data: recs } = await admin
          .from("sms_campaign_recipients")
          .select("id, customer_id, campaign_id, workspace_id, message_sid, status")
          .in("message_sid", failedRows.map((r) => r.sid));
        const byRecSid = new Map<string, { id: string; customer_id: string | null; campaign_id: string; status: string }>();
        for (const r of (recs || []) as Array<{ id: string; customer_id: string | null; campaign_id: string; workspace_id: string; message_sid: string; status: string }>) {
          matchedRecipientSids.add(r.message_sid);
          touchedCampaigns.add(r.campaign_id);
          byRecSid.set(r.message_sid, r);
        }
        for (const f of failedRows) {
          const rec = byRecSid.get(f.sid);
          if (!rec) continue; // will be picked up by the storefront_leads step
          if (rec.status === "delivered") continue; // don't downgrade
          const newStatus = f.isFatal ? "failed_permanent" : "failed";
          const errorText = f.errorCode
            ? `${f.errorCode}: ${f.errorMessage || "carrier failure"}`
            : f.errorMessage || "undelivered";
          await admin
            .from("sms_campaign_recipients")
            .update({ status: newStatus, error: errorText, updated_at: now })
            .eq("id", rec.id);
          if (f.isFatal && rec.customer_id && f.phoneStatus) {
            await admin
              .from("customers")
              .update({
                phone_status: f.phoneStatus,
                phone_status_code: f.errorCode,
                phone_status_at: now,
              })
              .eq("id", rec.customer_id);
          }
        }
      });
    }

    // ── Bulk: profile_events "Received SMS" on delivered ─────────────
    // Preserves the pre-fast-ack inline behavior. Phase 4 hoists this
    // to a watermarked rollup for true idempotency.
    if (deliveredProfileRows.length > 0) {
      await step.run("delivered-profile-events", async () => {
        const admin = createAdminClient();
        const now = new Date().toISOString();
        await admin.from("profile_events").insert(
          deliveredProfileRows.map((r) => ({
            workspace_id: r.workspace_id,
            customer_id: r.customer_id,
            metric_name: "Received SMS",
            datetime: now,
            attributed_campaign_id: r.campaign_id,
          })),
        );
      });
    }

    // ── storefront_leads fallback ────────────────────────────────────
    // Popup-coupon SMS sends direct from the short code with this
    // route passed as an explicit StatusCallback (see docs/brain/
    // integrations/twilio.md). Any sid we haven't matched to a
    // recipient may be a lead. One UPDATE per transition group.
    const unmatched: Array<{ sid: string; status: string }> = [];
    for (const [sid, row] of bestBySid) {
      if (!matchedRecipientSids.has(sid)) unmatched.push({ sid, status: row.status });
    }
    if (unmatched.length > 0) {
      await step.run("storefront-leads-fallback", async () => {
        const admin = createAdminClient();
        const now = new Date().toISOString();
        // Group by target status.
        const byStatus = new Map<string, string[]>();
        for (const u of unmatched) {
          const arr = byStatus.get(u.status) || [];
          arr.push(u.sid);
          byStatus.set(u.status, arr);
        }
        for (const [status, sids] of byStatus) {
          await admin
            .from("storefront_leads")
            .update({ sms_status: status, sms_status_at: now, updated_at: now })
            .in("sms_message_sid", sids);
        }
      });
    }

    // ── Recount touched campaign counters ─────────────────────────────
    // Recount (not increment) — matches `marketing-text.ts` send-tick.
    // Idempotent: re-draining the same batch produces the same counts.
    if (touchedCampaigns.size > 0) {
      await step.run("recount-campaigns", async () => {
        const admin = createAdminClient();
        const now = new Date().toISOString();
        for (const cid of touchedCampaigns) {
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
          await admin
            .from("sms_campaigns")
            .update({
              recipients_sent: sent || 0,
              recipients_failed: failed || 0,
              updated_at: now,
            })
            .eq("id", cid);
        }
      });
    }

    return {
      drained: bestBySid.size,
      sent: sentSids.length,
      delivered: deliveredSids.length,
      failed: failedRows.length,
      leads: unmatched.length,
      campaigns_recounted: touchedCampaigns.size,
    };
  },
);
