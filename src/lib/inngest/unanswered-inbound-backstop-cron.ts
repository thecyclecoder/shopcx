/**
 * unanswered-inbound-backstop-cron — the safety net for a LOST inbound-message event.
 *
 * A customer's reply is ingested into `ticket_messages` and then a `ticket/inbound-message` event is
 * fired so [[unified-ticket-handler]] handles it. If that event is silently dropped (a widget/webhook
 * `inngest.send` blip, a cold start, an Inngest delivery hiccup) there is NO retry and NO trace — the
 * customer sits unanswered on an open ticket forever (ticket `c4889020`: a chat follow-up whose event
 * never processed; re-firing the exact event handled it flawlessly, proving the handler was fine and
 * the event was simply lost).
 *
 * This cron closes that gap: every 5 min it finds open tickets whose NEWEST customer-facing message is
 * an unanswered inbound customer message older than the settle window, and RE-FIRES the same
 * `ticket/inbound-message` event the original ingest should have. The handler re-applies every gate
 * (ai_disabled / do_not_reply / escalated / assigned / turn-limit) so re-firing is safe — worst case
 * the handler bails with a note. Idempotent: it writes a `[System] {MARKER}` note BEFORE firing, and
 * skips any ticket that already carries that marker after the customer's last message, so a slow (or
 * genuinely lost-twice) handler is not spammed with duplicate dispatches.
 *
 * North star: no customer is ever silently dropped by a lost event. See [[../operational-rules]].
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { getTicketMessages } from "@/lib/tickets-read";

/** Wait this long past the customer's last message before backstopping — clears the 5-min pending-send
 *  delay + a buffer so we never race a handler that IS about to reply. */
export const BACKSTOP_SETTLE_MS = 12 * 60 * 1000;
/** Don't resurrect ancient tickets — a customer message older than this is stale, not a live wait. */
export const BACKSTOP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Marker on the idempotency note (also the skip key). */
export const BACKSTOP_MARKER = "Unanswered-inbound backstop";
const BATCH = 25;

export interface BackstopDecisionInput {
  /** Newest inbound customer external message time (ISO), or null when none. */
  lastCustomerAt: string | null;
  /** Newest CUSTOMER-FACING outbound response time (ai/agent or system-external), or null. */
  lastResponseAt: string | null;
  /** An uncancelled, unsent outbound send is queued → a reply is already in flight. */
  hasPendingSend: boolean;
  /** A prior backstop note already sits after the customer's last message → don't re-fire. */
  alreadyBackstopped: boolean;
  /** AI is enabled for this ticket's channel. */
  aiEnabled: boolean;
  now: number;
  settleMs: number;
  maxAgeMs: number;
}

/**
 * Pure decision: should this ticket's last inbound message be re-dispatched? True ONLY when AI is on,
 * the newest customer-facing message is an unanswered customer message aged into [settle, maxAge], no
 * reply is queued, and we have not already backstopped it. Unit-pinned in the cron's test.
 */
export function shouldBackstopRedispatch(i: BackstopDecisionInput): boolean {
  if (!i.aiEnabled) return false;
  if (!i.lastCustomerAt) return false;
  if (i.hasPendingSend) return false;
  if (i.alreadyBackstopped) return false;
  const custMs = Date.parse(i.lastCustomerAt);
  if (!Number.isFinite(custMs)) return false;
  const age = i.now - custMs;
  if (age < i.settleMs || age > i.maxAgeMs) return false;
  // Answered? A customer-facing response AT OR AFTER the customer's last message means the handler
  // already replied (or is mid-turn) — not stranded.
  if (i.lastResponseAt) {
    const respMs = Date.parse(i.lastResponseAt);
    if (Number.isFinite(respMs) && respMs >= custMs) return false;
  }
  return true;
}

/** Newest customer inbound external message (body + created_at), or null. */
function newestCustomerMessage(msgs: Awaited<ReturnType<typeof getTicketMessages>>): { at: string; body: string } | null {
  let best: { at: string; body: string } | null = null;
  for (const m of msgs) {
    if (m.direction === "inbound" && m.author_type === "customer" && m.visibility === "external" && m.created_at) {
      if (!best || m.created_at > best.at) best = { at: m.created_at, body: m.body || "" };
    }
  }
  return best;
}

/** Newest customer-facing outbound response time (ai/agent, or system-external), or null. */
function newestResponseAt(msgs: Awaited<ReturnType<typeof getTicketMessages>>): string | null {
  let best: string | null = null;
  for (const m of msgs) {
    if (m.direction !== "outbound" || !m.created_at) continue;
    const customerFacing =
      m.author_type === "ai" || m.author_type === "agent" || (m.author_type === "system" && m.visibility === "external");
    if (customerFacing && (!best || m.created_at > best)) best = m.created_at;
  }
  return best;
}

export const unansweredInboundBackstopCron = inngest.createFunction(
  {
    id: "unanswered-inbound-backstop-cron",
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "*/5 * * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();
    const nowIso = new Date().toISOString();
    const now = Date.parse(nowIso);
    const settleCutoff = new Date(now - BACKSTOP_SETTLE_MS).toISOString();
    const ageCutoff = new Date(now - BACKSTOP_MAX_AGE_MS).toISOString();

    // Candidate tickets: open, unowned, AI-eligible, whose customer last spoke inside the window.
    // The handler re-applies every gate on re-fire, so this filter is an efficiency pre-screen — it
    // excludes the states where re-firing would only bail (merged / do_not_reply / ai_disabled /
    // analyzer_locked / escalated / human-assigned).
    const candidates = await step.run("find-candidates", async () => {
      const { data } = await admin
        .from("tickets")
        .select("id, workspace_id, channel, last_customer_reply_at")
        .eq("status", "open")
        .is("merged_into", null)
        .eq("do_not_reply", false)
        .eq("ai_disabled", false)
        .eq("analyzer_locked", false)
        .is("escalated_at", null)
        .is("assigned_to", null)
        .not("last_customer_reply_at", "is", null)
        .lte("last_customer_reply_at", settleCutoff)
        .gte("last_customer_reply_at", ageCutoff)
        .order("last_customer_reply_at", { ascending: true })
        .limit(BATCH);
      return (data as Array<{ id: string; workspace_id: string; channel: string | null; last_customer_reply_at: string | null }>) || [];
    });

    if (!candidates.length) {
      await emitCronHeartbeat("unanswered-inbound-backstop-cron", { ok: true, detail: "idle" });
      return { redispatched: 0, scanned: 0 };
    }

    // AI-enabled lookup per (workspace, channel), cached across the batch.
    const aiEnabledCache = new Map<string, boolean>();
    async function aiEnabled(workspaceId: string, channel: string | null): Promise<boolean> {
      const key = `${workspaceId}:${channel ?? ""}`;
      if (aiEnabledCache.has(key)) return aiEnabledCache.get(key)!;
      let enabled = false;
      if (channel) {
        const { data } = await admin
          .from("ai_channel_config")
          .select("enabled")
          .eq("workspace_id", workspaceId)
          .eq("channel", channel)
          .maybeSingle();
        enabled = !!(data as { enabled?: boolean } | null)?.enabled;
      }
      aiEnabledCache.set(key, enabled);
      return enabled;
    }

    let redispatched = 0;
    for (const t of candidates) {
      const done = await step.run(`backstop-${t.id.slice(0, 8)}`, async () => {
        const msgs = await getTicketMessages(admin, t.id);
        const cust = newestCustomerMessage(msgs);
        const lastResponseAt = newestResponseAt(msgs);
        const hasPendingSend = msgs.some((m) => m.pending_send_at && !m.sent_at && !m.send_cancelled);
        const alreadyBackstopped = msgs.some(
          (m) =>
            m.visibility === "internal" &&
            m.author_type === "system" &&
            (m.body || "").includes(BACKSTOP_MARKER) &&
            !!m.created_at &&
            !!cust &&
            m.created_at > cust.at,
        );
        const enabled = await aiEnabled(t.workspace_id, t.channel);

        const fire = shouldBackstopRedispatch({
          lastCustomerAt: cust?.at ?? null,
          lastResponseAt,
          hasPendingSend,
          alreadyBackstopped,
          aiEnabled: enabled,
          now,
          settleMs: BACKSTOP_SETTLE_MS,
          maxAgeMs: BACKSTOP_MAX_AGE_MS,
        });
        if (!fire || !cust) return false;

        // Idempotency marker FIRST — it sits after the customer message so the next sweep skips this
        // ticket, and it is an internal note so it never counts as a customer-facing "response".
        await admin.from("ticket_messages").insert({
          ticket_id: t.id,
          direction: "outbound",
          visibility: "internal",
          author_type: "system",
          body: `[System] ${BACKSTOP_MARKER}: re-dispatching handling — the customer's last message got no AI/agent response and no reply is queued, so the original inbound event appears to have been lost.`,
        });

        await inngest.send({
          name: "ticket/inbound-message",
          data: {
            workspace_id: t.workspace_id,
            ticket_id: t.id,
            message_body: cust.body,
            channel: t.channel || "chat",
            is_new_ticket: false,
          },
        });
        return true;
      });
      if (done) redispatched++;
    }

    await emitCronHeartbeat("unanswered-inbound-backstop-cron", { ok: true, detail: `redispatched ${redispatched}/${candidates.length}` });
    return { redispatched, scanned: candidates.length };
  },
);
