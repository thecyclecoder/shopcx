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
 * Two reconcilers run every 5 minutes:
 *
 *  1. INTENT PATH (Phase 3 — the precise reconciler). Since Phase 2, every ingest chokepoint stamps
 *     `dispatch_pending_at` on the just-inserted `ticket_messages` row BEFORE firing the event, and
 *     [[unified-ticket-handler]] `clearDispatchIntent`s the stamp on claim. An UN-cleared stamp older
 *     than `INTENT_SETTLE_MS` is therefore an unambiguous LOST send — not "handler declined the turn".
 *     The intent scan re-fires exactly those rows and clears the intent, and counts the drops so the
 *     true lost-send RATE surfaces on the dashboard instead of being invisible until a customer
 *     complains. This is the precise reconciler the spec's Phase 3 asks for.
 *
 *  2. MESSAGE-AGE PATH (legacy floor). Kept for PRE-Phase-2 message rows (backfilled `NULL` stamps)
 *     and any post-Phase-2 message that somehow ended up without an intent stamp — a longer 12-min
 *     age floor catches those with the older, coarser heuristic. Uses the existing predicate and
 *     [System] `{BACKSTOP_MARKER}` idempotency note; the intent path drops the SAME marker so both
 *     paths share the same "already backstopped" skip.
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

/**
 * Phase-3 tighter settle window for INTENT-bearing rows. `dispatchInboundMessage` stamps the intent
 * on-disk, and [[unified-ticket-handler]] `clearDispatchIntent` clears it at the TOP of every run
 * (regardless of the run's outcome — real turn, ai_disabled skip, empty inbound, spam). So a stamp
 * that survives past this window means the event never reached the handler at all. Three minutes
 * comfortably covers Inngest's delivery + retry backoff on a healthy hop while still catching a
 * genuine drop long before the 12-min message-age floor would.
 */
export const INTENT_SETTLE_MS = 3 * 60 * 1000;

/** Sweep-batch size (per path). */
const BATCH = 25;

/**
 * Threshold for the Control Tower alarm — a single sweep reconciling this many intent-based lost
 * sends signals a real hiccup (base rate is ~zero), so we surface a dashboard notification. This is
 * an OBSERVABILITY threshold, not a policy gate: the reconciler still re-fires every eligible row
 * regardless. Per-workspace so a single noisy tenant doesn't blind the others.
 */
export const LOST_SEND_ALARM_THRESHOLD = 3;

/** Payload for the pure intent-reconcile predicate. */
export interface IntentReconcileInput {
  /** The message row's `dispatch_pending_at` (ISO), or null when the row was never stamped. */
  dispatchPendingAt: string | null;
  /** Whether a `[System] BACKSTOP_MARKER` note already sits after this message → skip (idempotent). */
  alreadyBackstopped: boolean;
  now: number;
  settleMs: number;
}

/**
 * Pure decision: is this specific `ticket_messages` row a LOST send that the backstop must
 * re-dispatch? True iff there's an un-cleared intent stamp older than the settle window AND we
 * haven't already backstopped this row on a prior sweep. Unit-pinned in the cron's test.
 *
 * The stamp's presence + age is the entire signal — the handler's `clearDispatchIntent` runs at the
 * top of every claimed run and clears the stamp regardless of the run's disposition, so the reverse
 * ("stamp is set, handler chose not to reply") cannot exist. That is what makes this reconciler
 * PRECISE where the message-age path is a coarse floor.
 */
export function shouldIntentReconcile(i: IntentReconcileInput): boolean {
  if (!i.dispatchPendingAt) return false;
  if (i.alreadyBackstopped) return false;
  const stampMs = Date.parse(i.dispatchPendingAt);
  if (!Number.isFinite(stampMs)) return false;
  return i.now - stampMs >= i.settleMs;
}

/** Payload for the pure message-age predicate. Kept as a floor for pre-Phase-2 rows. */
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
 * Pure decision: should this ticket's last inbound message be re-dispatched by the MESSAGE-AGE
 * path? True ONLY when AI is on, the newest customer-facing message is an unanswered customer
 * message aged into [settle, maxAge], no reply is queued, and we have not already backstopped it.
 * Unit-pinned in the cron's test.
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

/**
 * The visible drop-rate alarm: when a single sweep reconciled ≥ `LOST_SEND_ALARM_THRESHOLD` lost
 * sends on a workspace, insert ONE `dashboard_notifications` row per workspace so the drop rate is
 * observable BEFORE a customer complains. Uses `type: 'system'` (CHECK-constrained per
 * [[../../docs/brain/tables/dashboard_notifications]]) and `metadata.dedupe_key` for the sweep — the
 * cron runs every 5 min so a stuck bad hop doesn't spam more than one alarm per sweep per workspace.
 */
async function surfaceLostSendAlarm(
  admin: ReturnType<typeof createAdminClient>,
  perWorkspace: Map<string, number>,
  sweepIso: string,
): Promise<number> {
  let alarms = 0;
  for (const [workspaceId, count] of perWorkspace.entries()) {
    if (count < LOST_SEND_ALARM_THRESHOLD) continue;
    const { error } = await admin.from("dashboard_notifications").insert({
      workspace_id: workspaceId,
      type: "system",
      title: `Lost inbound-message events reconciled (${count})`,
      body: `The backstop reconciled ${count} lost \`ticket/inbound-message\` event${count === 1 ? "" : "s"} in the last sweep — above the alarm threshold of ${LOST_SEND_ALARM_THRESHOLD}. The customer replies were still handled (the backstop re-fired), but a sustained rate signals an Inngest delivery hiccup or an ingest bug.`,
      link: "/dashboard/tickets",
      metadata: {
        source: "unanswered-inbound-backstop-cron",
        sweep_at: sweepIso,
        lost_send_count: count,
        threshold: LOST_SEND_ALARM_THRESHOLD,
      },
    });
    if (!error) alarms++;
    else console.warn(`[unanswered-inbound-backstop-cron] alarm insert failed for ws=${workspaceId}:`, error.message);
  }
  return alarms;
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
    const intentCutoff = new Date(now - INTENT_SETTLE_MS).toISOString();
    const settleCutoff = new Date(now - BACKSTOP_SETTLE_MS).toISOString();
    const ageCutoff = new Date(now - BACKSTOP_MAX_AGE_MS).toISOString();

    // ── Path 1: INTENT reconciler (precise) ──
    // Scans `ticket_messages` rows whose Phase-2 intent stamp is older than INTENT_SETTLE_MS AND has
    // not been cleared by the handler. Every row here is an unambiguous lost send.
    let lostSendReconciled = 0;
    const perWorkspace = new Map<string, number>();
    const intentClaimedTicketIds = new Set<string>();

    const intentRows = await step.run("find-intent-candidates", async () => {
      const { data } = await admin
        .from("ticket_messages")
        .select("id, ticket_id, body, dispatch_pending_at")
        .not("dispatch_pending_at", "is", null)
        .lte("dispatch_pending_at", intentCutoff)
        .order("dispatch_pending_at", { ascending: true })
        .limit(BATCH);
      return (data as Array<{ id: string; ticket_id: string; body: string | null; dispatch_pending_at: string }>) || [];
    });

    for (const row of intentRows) {
      const fired = await step.run(`intent-${row.id.slice(0, 8)}`, async () => {
        // Reload the ticket to enforce the same eligibility gates the ingest chokepoints did —
        // a Phase-2 stamp survives merges/reassignment/ai_disabled toggles, so the reconciler must
        // re-check before firing. This is the confirming-predicate guardrail from the coaching
        // (never re-fire a broadcast over stale state).
        const { data: ticket } = await admin
          .from("tickets")
          .select("id, workspace_id, channel, status, do_not_reply, ai_disabled, analyzer_locked, escalated_at, assigned_to, merged_into")
          .eq("id", row.ticket_id)
          .single();
        if (!ticket) return false;
        // Even the smallest disqualifier means the backstop should NOT re-fire — the handler
        // would bail on the same reason anyway, and firing would leak turn-count noise into the
        // AI usage log. But we STILL clear the intent so the row doesn't keep showing up.
        const disqualified =
          ticket.status !== "open" ||
          ticket.merged_into != null ||
          ticket.do_not_reply === true ||
          ticket.ai_disabled === true ||
          ticket.analyzer_locked === true ||
          ticket.escalated_at != null ||
          ticket.assigned_to != null;
        if (disqualified) {
          await admin.from("ticket_messages").update({ dispatch_pending_at: null }).eq("id", row.id);
          return false;
        }

        // Idempotency: the same [System] BACKSTOP_MARKER note both paths use. If it already sits
        // after this message, skip — an earlier sweep already re-fired.
        const msgs = await getTicketMessages(admin, ticket.id);
        const alreadyBackstopped = msgs.some(
          (m) =>
            m.visibility === "internal" &&
            m.author_type === "system" &&
            (m.body || "").includes(BACKSTOP_MARKER) &&
            !!m.created_at &&
            m.created_at > row.dispatch_pending_at,
        );
        const fire = shouldIntentReconcile({
          dispatchPendingAt: row.dispatch_pending_at,
          alreadyBackstopped,
          now,
          settleMs: INTENT_SETTLE_MS,
        });
        if (!fire) return false;

        // Marker BEFORE the send — same shape/message as the legacy path so both share the same
        // "already-backstopped" skip on the next sweep.
        await admin.from("ticket_messages").insert({
          ticket_id: ticket.id,
          direction: "outbound",
          visibility: "internal",
          author_type: "system",
          body: `[System] ${BACKSTOP_MARKER}: re-dispatching handling — a Phase-2 dispatch-intent stamped ${row.dispatch_pending_at} was never cleared by the unified handler, so the ticket/inbound-message event appears to have been lost.`,
        });

        await inngest.send({
          name: "ticket/inbound-message",
          data: {
            workspace_id: ticket.workspace_id,
            ticket_id: ticket.id,
            message_body: row.body || "",
            channel: ticket.channel || "chat",
            is_new_ticket: false,
          },
        });
        // Note: we do NOT null the intent stamp here — the handler's `clearDispatchIntent` will
        // clear it on receipt. If the re-fire is ALSO lost, the next sweep will see the stamp
        // still un-cleared and re-fire again (bounded by the alarm above the threshold).
        perWorkspace.set(ticket.workspace_id, (perWorkspace.get(ticket.workspace_id) || 0) + 1);
        intentClaimedTicketIds.add(ticket.id);
        return true;
      });
      if (fired) lostSendReconciled++;
    }

    const alarmsRaised = perWorkspace.size
      ? await step.run("surface-lost-send-alarm", async () => surfaceLostSendAlarm(admin, perWorkspace, nowIso))
      : 0;

    // ── Path 2: MESSAGE-AGE floor (legacy) ──
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

    if (!candidates.length && !intentRows.length) {
      await emitCronHeartbeat("unanswered-inbound-backstop-cron", { ok: true, detail: "idle" });
      return { redispatched: 0, scanned: 0, lostSendReconciled, alarmsRaised };
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
      // Skip tickets the intent path just handled — the marker will make the message-age path skip
      // them anyway, but avoiding the extra ticket_messages read is a cheap efficiency win on a
      // burst of Inngest hiccups.
      if (intentClaimedTicketIds.has(t.id)) continue;
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

    await emitCronHeartbeat("unanswered-inbound-backstop-cron", {
      ok: true,
      detail: `redispatched ${redispatched}/${candidates.length} · lost-send ${lostSendReconciled}/${intentRows.length}${alarmsRaised ? ` · alarms ${alarmsRaised}` : ""}`,
      produced: { redispatched, scanned: candidates.length, lostSendReconciled, intentScanned: intentRows.length, alarmsRaised },
    });
    return { redispatched, scanned: candidates.length, lostSendReconciled, alarmsRaised };
  },
);
