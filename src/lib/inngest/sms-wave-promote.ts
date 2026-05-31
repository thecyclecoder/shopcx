/**
 * Promote a "wave" of staged SMS campaign candidates to actual
 * sms_campaign_recipients, deduping by phone using priority.
 *
 * Triggered ~2 minutes after textCampaignScheduled finishes staging
 * a campaign — gives the admin a debounce window to schedule
 * additional campaigns into the same wave (same workspace + send_date)
 * before dedup runs. If multiple campaigns in a wave fire this event,
 * the function is idempotent on a per-campaign basis via the
 * audience_promoted_at CAS flip.
 *
 * Why this exists:
 *   - The previous in-memory rate-limit dedup in textCampaignSendTick
 *     wasn't replay-safe under Inngest's step-replay model. Dylan got
 *     SUMMERFIT engaged AND SUMMERFIT just_ordered on 2026-05-31.
 *   - The per-recipient runtime DB check that replaced it (shipped
 *     earlier today) is correct but adds N queries to the
 *     high-concurrency send-tick — exactly the saturation pattern
 *     that took down the connection pool during MDW.
 *   - Pre-flight dedup moves the work off the hot path: one SQL pass
 *     at scheduling time, not N runtime queries during the send.
 *
 * Priority map (lower wins, derived from May 30d conversion data):
 *   engaged=1, lapsed=2, just_ordered=3, cycle_hitter=4,
 *   active_sub=5, single_order=6, deep_lapsed=7, cold=8.
 * Per-campaign override available via sms_campaigns.priority.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";

const SEGMENT_PRIORITY: Record<string, number> = {
  engaged: 1,
  lapsed: 2,
  just_ordered: 3,
  cycle_hitter: 4,
  active_sub: 5,
  single_order: 6,
  deep_lapsed: 7,
  cold: 8,
};

/** Derive a campaign's effective priority from its included_segments. */
export function computeCampaignPriority(includedSegments: string[] | null | undefined): number {
  const segs = includedSegments || [];
  if (segs.length === 0) return 100;
  return Math.min(...segs.map(s => SEGMENT_PRIORITY[s] ?? 100));
}

export const smsWavePromote = inngest.createFunction(
  {
    id: "sms-wave-promote",
    name: "SMS: dedup + promote a staged wave to recipients",
    concurrency: [{ limit: 1, key: "event.data.wave_key" }],
    retries: 2,
    triggers: [{ event: "marketing/sms-wave.promote" }],
  },
  async ({ event, step }) => {
    const { workspace_id, send_date } = event.data as { workspace_id: string; send_date: string; wave_key: string };

    // Debounce: wait 2 minutes after the trigger so additional
    // campaigns scheduled into the same wave can stage their
    // candidates before we dedup. Idempotent — if the wave was
    // already promoted by an earlier event, the status check below
    // short-circuits.
    await step.sleep("debounce", "2m");

    const result = await step.run("promote-wave", async () => {
      const admin = createAdminClient();
      // Find all campaigns in this wave that are staged but not yet promoted.
      const { data: campaigns } = await admin
        .from("sms_campaigns")
        .select("id, name, included_segments, priority")
        .eq("workspace_id", workspace_id)
        .eq("send_date", send_date)
        .not("audience_staged_at", "is", null)
        .is("audience_promoted_at", null);

      if (!campaigns?.length) {
        return { reason: "no_staged_unpromoted_campaigns" };
      }
      const campaignIds = campaigns.map(c => c.id);

      // Load candidates (staged) for these campaigns. We page in chunks
      // to stay under PostgREST's 1000-row response cap.
      type Candidate = {
        id: string;
        campaign_id: string;
        customer_id: string | null;
        phone: string;
        scheduled_send_at: string;
        resolved_timezone: string | null;
        timezone_source: string | null;
        preferred_hour_used: number | null;
        priority: number;
      };
      const candidates: Candidate[] = [];
      let lastId: string | null = null;
      while (true) {
        let q = admin
          .from("sms_send_candidates")
          .select("id, campaign_id, customer_id, phone, scheduled_send_at, resolved_timezone, timezone_source, preferred_hour_used, priority")
          .eq("workspace_id", workspace_id)
          .in("campaign_id", campaignIds)
          .eq("outcome", "staged")
          .order("id", { ascending: true })
          .limit(1000);
        if (lastId) q = q.gt("id", lastId);
        const { data, error } = await q;
        if (error) throw new Error(`candidates load: ${error.message}`);
        if (!data?.length) break;
        for (const r of data) candidates.push(r as Candidate);
        lastId = data[data.length - 1].id as string;
        if (data.length < 1000) break;
      }

      // Dedup in JS by phone, lowest priority wins (ties: stable order
      // by created_at via id).
      const winnersByPhone = new Map<string, Candidate>();
      for (const c of candidates) {
        const cur = winnersByPhone.get(c.phone);
        if (!cur || c.priority < cur.priority) winnersByPhone.set(c.phone, c);
      }

      // ALSO check for pre-existing recipients on the same send_date
      // (defense-in-depth: if a late campaign joins a wave that was
      // already promoted, this catches the overlap).
      const winnerPhones = [...winnersByPhone.keys()];
      const existingPhones = new Set<string>();
      for (let i = 0; i < winnerPhones.length; i += 1000) {
        const chunk = winnerPhones.slice(i, i + 1000);
        const { data } = await admin
          .from("sms_campaign_recipients")
          .select("phone")
          .eq("workspace_id", workspace_id)
          .in("phone", chunk)
          .gte("scheduled_send_at", `${send_date}T00:00:00`)
          .lt("scheduled_send_at", `${send_date}T23:59:59.999Z`)
          .in("status", ["pending", "sending", "scheduled", "sent", "delivered"]);
        for (const r of data || []) existingPhones.add(r.phone);
      }

      // Build recipient insert rows
      const recipientInserts: Array<{
        workspace_id: string; campaign_id: string; customer_id: string | null; phone: string;
        scheduled_send_at: string; resolved_timezone: string | null; timezone_source: string | null;
        preferred_hour_used: number | null; status: string;
      }> = [];
      const winnerCandidateIds: string[] = [];
      let skippedAlreadyRecipient = 0;
      for (const w of winnersByPhone.values()) {
        if (existingPhones.has(w.phone)) {
          skippedAlreadyRecipient++;
          continue;
        }
        recipientInserts.push({
          workspace_id,
          campaign_id: w.campaign_id,
          customer_id: w.customer_id,
          phone: w.phone,
          scheduled_send_at: w.scheduled_send_at,
          resolved_timezone: w.resolved_timezone,
          timezone_source: w.timezone_source,
          preferred_hour_used: w.preferred_hour_used,
          status: "pending",
        });
        winnerCandidateIds.push(w.id);
      }

      // Batch insert recipients
      let inserted = 0;
      for (let i = 0; i < recipientInserts.length; i += 500) {
        const chunk = recipientInserts.slice(i, i + 500);
        const { error, count } = await admin
          .from("sms_campaign_recipients")
          .upsert(chunk, { onConflict: "campaign_id,phone", ignoreDuplicates: true, count: "exact" });
        if (error) throw new Error(`recipient upsert: ${error.message}`);
        inserted += count || chunk.length;
      }

      // Mark candidates: winners → promoted, others → deduped.
      const winnerSet = new Set(winnerCandidateIds);
      const promotedIds = candidates.filter(c => winnerSet.has(c.id)).map(c => c.id);
      const dedupedIds = candidates.filter(c => !winnerSet.has(c.id)).map(c => c.id);

      for (let i = 0; i < promotedIds.length; i += 500) {
        await admin
          .from("sms_send_candidates")
          .update({ outcome: "promoted" })
          .in("id", promotedIds.slice(i, i + 500));
      }
      for (let i = 0; i < dedupedIds.length; i += 500) {
        await admin
          .from("sms_send_candidates")
          .update({ outcome: "deduped" })
          .in("id", dedupedIds.slice(i, i + 500));
      }

      // Flip each campaign to status='scheduled' + stamp
      // audience_promoted_at. Recipients_total reflects how many
      // survived the dedup pass for THIS campaign.
      const recipientCountByCampaign = new Map<string, number>();
      for (const w of winnersByPhone.values()) {
        if (existingPhones.has(w.phone)) continue;
        recipientCountByCampaign.set(w.campaign_id, (recipientCountByCampaign.get(w.campaign_id) || 0) + 1);
      }
      for (const c of campaigns) {
        await admin
          .from("sms_campaigns")
          .update({
            audience_promoted_at: new Date().toISOString(),
            status: "scheduled",
            recipients_total: recipientCountByCampaign.get(c.id) || 0,
            scheduled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", c.id)
          .is("audience_promoted_at", null);
      }

      return {
        campaigns: campaigns.length,
        candidates: candidates.length,
        promoted: promotedIds.length,
        deduped: dedupedIds.length,
        recipients_inserted: inserted,
        skipped_already_recipient: skippedAlreadyRecipient,
      };
    });

    return result;
  },
);
