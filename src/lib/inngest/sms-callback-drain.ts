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
 * `profile_events` "Received SMS" is written by the Phase 4
 * `received-sms-rollup-cron` at the bottom of this file — NOT here on
 * the drain hot path. The cron reads `sms_campaign_recipients` where
 * `delivered_at IS NOT NULL AND received_sms_logged_at IS NULL`,
 * emits one event per row (`datetime = delivered_at`), then stamps
 * the flag — exactly-once by construction.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendSMS } from "@/lib/twilio";
import { unsubscribeFromSmsMarketing, subscribeToSmsMarketing } from "@/lib/shopify-marketing";

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

    // ── profile_events "Received SMS" ─────────────────────────────────
    // No longer inserted here — Phase 4 moved it to a watermarked
    // rollup cron (`received-sms-rollup-cron`) that reads
    // `sms_campaign_recipients` with `delivered_at IS NOT NULL AND
    // received_sms_logged_at IS NULL`, inserts profile_events with
    // `datetime = delivered_at`, then marks the flag — exactly one
    // event per delivered recipient, idempotent by construction.

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
    // `recipients_delivered` (Phase 4 counter) tracks the terminal
    // delivered state distinctly from `recipients_sent` (which counts
    // sent+scheduled+delivered per the pre-existing convention in
    // marketing-text.ts).
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
          const { count: delivered } = await admin
            .from("sms_campaign_recipients")
            .select("id", { count: "exact", head: true })
            .eq("campaign_id", cid)
            .eq("status", "delivered");
          const { count: failed } = await admin
            .from("sms_campaign_recipients")
            .select("id", { count: "exact", head: true })
            .eq("campaign_id", cid)
            .in("status", ["failed", "failed_permanent"]);
          await admin
            .from("sms_campaigns")
            .update({
              recipients_sent: sent || 0,
              recipients_delivered: delivered || 0,
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

// ═════════════════════════════════════════════════════════════════════
// Phase 3 — Bounded inbound (STOP / HELP / reply) drain.
//
// Consumes `sms/inbound.received` events that the fast-ack webhook
// (`src/app/api/webhooks/twilio/marketing-sms/route.ts`) enqueues for
// every inbound message to our marketing shortcode. All matching /
// consent / logging work that used to run on the webhook request path
// (workspace lookup → find_customers_by_phone RPC → per-customer
// Shopify consent mutation → customers UPDATE → sms_marketing_inbound
// INSERT → dedupe-gated TwiML autoresponse) happens here, bounded so a
// STOP-storm after a big send can't DDoS Postgres via the webhook path.
//
// STOP / HELP / START confirmation replies are still handled by
// Twilio's Advanced Opt-Out at the carrier edge (per docs/brain/
// integrations/twilio.md); we log the inbound + mirror consent to
// Shopify so audience builds line up with Twilio's block list.
// ═════════════════════════════════════════════════════════════════════

const AUTORESPONSE_TEXT =
  "This number isn't monitored. For help, please visit https://help.superfoodscompany.com — our team responds within a few hours.";

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Case-insensitive, whole-message-or-first-word match — mirrors the
// pre-fast-ack inline logic. Substring matching would unsubscribe a
// customer who types "thanks!" (contains "ks"); we don't do that.
const STOP_KEYWORDS = new Set([
  "STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE",
  "OPTOUT", "OPT-OUT", "OPT OUT", "REMOVE",
]);
const START_KEYWORDS = new Set([
  "START", "UNSTOP", "YES", "SUBSCRIBE", "OPTIN", "OPT-IN", "OPT IN",
]);

function isStopMessage(body: string): boolean {
  const trimmed = body.trim().toUpperCase();
  if (STOP_KEYWORDS.has(trimmed)) return true;
  return /^(PLEASE\s+STOP|REMOVE\s+ME|STOP\s+MESSAGES|STOP\s+TEXTS|STOP\s+ALL)\b/i.test(body.trim());
}

function isStartMessage(body: string): boolean {
  const trimmed = body.trim().toUpperCase();
  if (START_KEYWORDS.has(trimmed)) return true;
  return /^(RESUBSCRIBE|RE-?SUBSCRIBE\s+ME|RESUME)\b/i.test(body.trim());
}

export const smsInboundDrain = inngest.createFunction(
  {
    id: "sms-inbound-drain",
    name: "Twilio — SMS inbound drain (STOP/HELP/reply)",
    // Same drain-rate DIAL pattern as the status-callback drain. Inbound
    // volume is a fraction of status-callback volume (STOP-storms after
    // a big blast are the main scenario), so a lower ceiling is fine.
    concurrency: [{ limit: 4 }],
    triggers: [{ event: "sms/inbound.received" }],
  },
  async ({ event, step }) => {
    const data = event.data as { params?: Record<string, string> } | undefined;
    const params = data?.params;
    if (!params) return { drained: 0, reason: "missing-params" };

    const from = params.From || "";
    const to = params.To || "";
    const messageBody = params.Body || "";
    const messageSid = params.MessageSid || "";
    if (!from || !to) return { drained: 0, reason: "missing-from-or-to" };

    // ── STOP / START classification (Twilio OptOutType first, then keyword) ──
    const optOutType = (params.OptOutType || "").toUpperCase();
    const isOptOut = optOutType === "STOP" || isStopMessage(messageBody);
    const isOptIn = optOutType === "START" || isStartMessage(messageBody);

    if (isOptOut || isOptIn) {
      const outcome = await step.run("consent-flip", async () => {
        const admin = createAdminClient();
        // Resolve workspace by the shortcode the inbound came TO. The
        // `twilio_phone_number` column stores the bare shortcode digits
        // (e.g. "85041") for marketing.
        const { data: ws } = await admin
          .from("workspaces")
          .select("id")
          .eq("twilio_phone_number", to.replace(/^\+/, ""))
          .maybeSingle();

        let matched = 0;
        let flipped = 0;
        if (ws?.id) {
          // find_customers_by_phone strips non-digits on both sides so
          // +18583349198 / (858) 334-9198 / 858-334-9198 all match.
          // Returns rows regardless of current sms_marketing_status so
          // START can flip 'unsubscribed' rows back. Uses the expression
          // index on last-10-digits (verified via EXPLAIN in the spec).
          const { data: matches, error: rpcErr } = await admin.rpc(
            "find_customers_by_phone",
            { p_workspace_id: ws.id, p_phone: from },
          );
          if (rpcErr) {
            console.error("[sms-inbound-drain] phone lookup RPC failed:", rpcErr.message);
          }

          const newStatus = isOptOut ? "unsubscribed" : "subscribed";
          for (const cust of (matches || []) as Array<{
            id: string;
            workspace_id: string;
            shopify_customer_id: string | null;
            sms_marketing_status: string | null;
          }>) {
            matched++;
            // Idempotency: skip rows already in the target state — same
            // guard the pre-fast-ack inline code used.
            if (cust.sms_marketing_status === newStatus) continue;
            if (cust.shopify_customer_id) {
              try {
                if (isOptOut) {
                  await unsubscribeFromSmsMarketing(cust.workspace_id, cust.shopify_customer_id);
                } else {
                  await subscribeToSmsMarketing(cust.workspace_id, cust.shopify_customer_id);
                }
              } catch (err) {
                console.error(
                  `[sms-inbound-drain] Shopify SMS ${isOptOut ? "unsubscribe" : "subscribe"} failed:`,
                  cust.id,
                  err,
                );
              }
            }
            await admin
              .from("customers")
              .update({
                sms_marketing_status: newStatus,
                updated_at: new Date().toISOString(),
              })
              .eq("id", cust.id);
            flipped++;
          }
        }
        return { workspace_id: ws?.id || null, matched, flipped };
      });

      // Log the inbound. Autoresponder skipped — Twilio's Advanced
      // Opt-Out replies with the carrier-mandated STOP/START
      // confirmation from its edge, so a second reply would look
      // broken (matches pre-fast-ack behavior).
      await step.run("log-inbound-optout", async () => {
        const admin = createAdminClient();
        await admin.from("sms_marketing_inbound").insert({
          shortcode: to,
          from_phone: from,
          body: messageBody,
          message_sid: messageSid,
          autoresponded: false,
        });
      });

      return { drained: 1, type: isOptOut ? "opt_out" : "opt_in", ...outcome };
    }

    // ── Generic inbound — dedupe-gated autoresponder ─────────────────
    // The pre-fast-ack path returned TwiML that Twilio auto-replied
    // from the shortcode. Fast-ack drops the TwiML response body, so
    // the drain sends the same message out-of-band via the Twilio API.
    const decision = await step.run("log-inbound-generic", async () => {
      const admin = createAdminClient();
      const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
      const { data: recent } = await admin
        .from("sms_marketing_inbound")
        .select("id")
        .eq("shortcode", to)
        .eq("from_phone", from)
        .gte("created_at", since)
        .eq("autoresponded", true)
        .limit(1)
        .maybeSingle();

      const shouldAutoRespond = !recent;

      await admin.from("sms_marketing_inbound").insert({
        shortcode: to,
        from_phone: from,
        body: messageBody,
        message_sid: messageSid,
        autoresponded: shouldAutoRespond,
      });

      // Need workspace_id to send the reply from the correct shortcode.
      const { data: ws } = await admin
        .from("workspaces")
        .select("id")
        .eq("twilio_phone_number", to.replace(/^\+/, ""))
        .maybeSingle();

      return { shouldAutoRespond, workspace_id: ws?.id || null };
    });

    if (decision.shouldAutoRespond && decision.workspace_id) {
      await step.run("send-autoresponder", async () => {
        const res = await sendSMS(decision.workspace_id as string, from, AUTORESPONSE_TEXT);
        if (!res.success) {
          console.error("[sms-inbound-drain] autoresponse send failed:", res.error);
        }
      });
    }

    return { drained: 1, type: "generic", autoresponded: decision.shouldAutoRespond };
  },
);

// ═════════════════════════════════════════════════════════════════════
// Phase 4 — Received-SMS rollup cron.
//
// Emits one `profile_events` row per delivered SMS recipient, driven by
// `sms_campaign_recipients.received_sms_logged_at`. Runs on a short
// interval (every 5 min) so segmentation (which reads profile_events)
// sees delivered engagements with only a small lag.
//
// The drain (Phase 2) NO LONGER inserts profile_events on the hot path
// (removed above). Moving the insert here means:
//   1. Webhook path is DB-write-free (Phase 1 mandate).
//   2. `datetime = delivered_at`, not the drain's `now()` — matches
//      when the recipient actually got the message, so time-windowed
//      segments read correctly.
//   3. Exactly-once via the `received_sms_logged_at` flag: candidates
//      are `delivered_at IS NOT NULL AND received_sms_logged_at IS NULL`
//      (backed by `idx_sms_campaign_recipients_rollup_pending`); after
//      insert we stamp the flag. A second cron pass picks zero rows.
//
// Concurrency 1 to keep the flag flip deterministic (no two runs
// racing for the same candidate).
// ═════════════════════════════════════════════════════════════════════

/** Cap per run — keeps a single tick fast even if a big blast just landed. */
const ROLLUP_BATCH_LIMIT = 2000;

export const receivedSmsRollupCron = inngest.createFunction(
  {
    id: "received-sms-rollup-cron",
    name: "Twilio — Received-SMS profile-event rollup",
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "*/5 * * * *" }],
  },
  async ({ step }) => {
    return await step.run("rollup", async () => {
      const admin = createAdminClient();
      // Candidate set: delivered but not-yet-rolled-up. Ordered by
      // delivered_at so a partial batch still advances time monotonically
      // and the partial index (delivered_at) stays useful for the LIMIT.
      const { data: candidates } = await admin
        .from("sms_campaign_recipients")
        .select("id, workspace_id, customer_id, campaign_id, delivered_at")
        .not("delivered_at", "is", null)
        .is("received_sms_logged_at", null)
        .order("delivered_at", { ascending: true })
        .limit(ROLLUP_BATCH_LIMIT);

      const rows = (candidates || []) as Array<{
        id: string;
        workspace_id: string;
        customer_id: string | null;
        campaign_id: string;
        delivered_at: string;
      }>;
      if (rows.length === 0) return { emitted: 0, flagged: 0 };

      // Only recipients with a customer_id emit a profile event (no
      // customer → no engagement lineage). Recipients WITHOUT a
      // customer still get their flag flipped so we don't scan them
      // again forever.
      const withCustomer = rows.filter((r) => r.customer_id);
      if (withCustomer.length > 0) {
        await admin.from("profile_events").insert(
          withCustomer.map((r) => ({
            workspace_id: r.workspace_id,
            customer_id: r.customer_id,
            metric_name: "Received SMS",
            datetime: r.delivered_at,
            attributed_campaign_id: r.campaign_id,
          })),
        );
      }

      // Mark ALL candidates (with or without customer) as rolled up.
      // received_sms_logged_at is the idempotency flag — after this
      // update they exit the candidate set forever.
      // Chunk the id list — a single `.in("id", [...all])` built a ~40 KB query
      // string on a large candidate batch, which the gateway rejects with 400.
      // (An empty batch also skips the update: the loop simply doesn't run.)
      const rolledUpAt = new Date().toISOString();
      const rolledUpIds = rows.map((r) => r.id);
      for (let i = 0; i < rolledUpIds.length; i += 100) {
        await admin
          .from("sms_campaign_recipients")
          .update({ received_sms_logged_at: rolledUpAt })
          .in("id", rolledUpIds.slice(i, i + 100));
      }

      return { emitted: withCustomer.length, flagged: rows.length };
    });
  },
);
