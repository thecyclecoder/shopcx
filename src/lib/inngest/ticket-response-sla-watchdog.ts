/**
 * ticket-response-sla-watchdog — the 30-minute response SLA guarantee.
 *
 * Phase 1 of [[../specs/every-inbound-handled-within-30-min]]. Every failure mode on 2026-10-07
 * (tickets 09f7257a / 2acc8634 / 668bc5c8 / Sanja's edf7331f) ended the same way: a Sol or
 * Sonnet turn failed or produced no reply, and NOTHING OWNED THE TICKET AFTER THAT. The
 * unanswered-inbound-backstop handles the LOST-INGEST class (a `ticket/inbound-message` event
 * that was dropped), but it does NOT fire when a dispatch landed, the handler claimed, and the
 * turn FAILED — the stamp is cleared, no customer-facing reply was sent, and the ticket just
 * sits open until a human notices.
 *
 * This watchdog is the catch-net for THAT class. Every 5 minutes it finds open tickets whose
 * newest inbound customer message has sat past the response SLA with no outbound external
 * reply, no reply queued, and no live claim on it (no active playbook turn, not already
 * escalated, no inflight cs-director-call), and enqueues ONE `cs-director-call` agent_jobs row
 * for June. June rules before the founder is paged — the spec forbids escalating directly to
 * the founder from this surface.
 *
 * North star: no customer waits past the SLA because nothing owns the ticket after a failed
 * turn. The founder owns objectives — the CS Director (June) owns tickets. See
 * [[../operational-rules]] § North star and [[../specs/every-inbound-handled-within-30-min]].
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { getTicketMessages } from "@/lib/tickets-read";

/** The response SLA. A ticket's newest inbound customer message older than this with no
 *  outbound external reply, no queued reply, and no live claim ⇒ hand to June. */
export const TICKET_RESPONSE_SLA_MS = 30 * 60 * 1000;

/** Max age — don't resurrect an ancient open ticket; a message older than this is stale, not a
 *  live wait. Matches the backstop cron's upper bound so the two sweeps share one window. */
export const SLA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Idempotency marker. Posted once per inbound message. */
export const SLA_BREACH_MARKER = "30-min response SLA breached — routed to June";

/** Per-tick batch size. */
const BATCH = 25;

/**
 * Pure predicate — should this ticket's last inbound message escalate to June on SLA breach?
 * Unit-pinned so the invariant is reviewable without a DB.
 *
 * Returns true when:
 *   - newest inbound customer external message exists AND is older than the SLA (but ≤ max age)
 *   - no outbound external response at or after the customer message
 *   - no queued outbound send is in flight for this ticket
 *   - no prior breach marker already sits after the customer message (idempotent per message)
 */
export interface SlaBreachInput {
  lastCustomerAt: string | null;
  lastResponseAt: string | null;
  hasPendingSend: boolean;
  alreadyMarked: boolean;
  now: number;
  slaMs: number;
  maxAgeMs: number;
}

export function shouldRouteToJune(i: SlaBreachInput): boolean {
  if (!i.lastCustomerAt) return false;
  if (i.hasPendingSend) return false;
  if (i.alreadyMarked) return false;
  const custMs = Date.parse(i.lastCustomerAt);
  if (!Number.isFinite(custMs)) return false;
  const age = i.now - custMs;
  if (age < i.slaMs || age > i.maxAgeMs) return false;
  if (i.lastResponseAt) {
    const respMs = Date.parse(i.lastResponseAt);
    if (Number.isFinite(respMs) && respMs >= custMs) return false;
  }
  return true;
}

/** Newest customer inbound external message time, or null. */
function newestCustomerAt(msgs: Awaited<ReturnType<typeof getTicketMessages>>): string | null {
  let best: string | null = null;
  for (const m of msgs) {
    if (
      m.direction === "inbound" &&
      m.author_type === "customer" &&
      m.visibility === "external" &&
      m.created_at &&
      (!best || m.created_at > best)
    ) {
      best = m.created_at;
    }
  }
  return best;
}

/** Newest customer-facing outbound response time, or null. */
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

export const ticketResponseSlaWatchdog = inngest.createFunction(
  {
    id: "ticket-response-sla-watchdog",
    name: "Ticket 30-min response SLA watchdog",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "*/5 * * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();
    const nowIso = new Date().toISOString();
    const now = Date.parse(nowIso);
    const slaCutoff = new Date(now - TICKET_RESPONSE_SLA_MS).toISOString();
    const ageCutoff = new Date(now - SLA_MAX_AGE_MS).toISOString();

    // Candidate tickets: open, unmerged, not already escalated, not human-assigned, whose
    // newest customer reply sits inside the breach window. The per-ticket check re-asserts
    // the full predicate below (confirming-predicate guardrail — never route on stale state).
    const candidates = await step.run("find-candidates", async () => {
      const { data } = await admin
        .from("tickets")
        .select("id, workspace_id, channel, last_customer_reply_at, active_playbook_id")
        .eq("status", "open")
        .is("merged_into", null)
        .is("escalated_at", null)
        .is("assigned_to", null)
        .is("active_playbook_id", null)
        .not("last_customer_reply_at", "is", null)
        .lte("last_customer_reply_at", slaCutoff)
        .gte("last_customer_reply_at", ageCutoff)
        .order("last_customer_reply_at", { ascending: true })
        .limit(BATCH);
      return (data as Array<{
        id: string;
        workspace_id: string;
        channel: string | null;
        last_customer_reply_at: string | null;
        active_playbook_id: string | null;
      }>) || [];
    });

    if (!candidates.length) {
      await emitCronHeartbeat("ticket-response-sla-watchdog", { ok: true, detail: "idle" });
      return { routed: 0, scanned: 0 };
    }

    // Inflight guard — a cs-director-call already queued/claimed on these tickets covers the
    // breach; we must not double-enqueue (mirrors the sibling guards in
    // needs-attention-route-cs-owner.ts and triage-escalations.ts).
    const ticketIds = candidates.map((t) => t.id);
    const { data: inflight } = await admin
      .from("agent_jobs")
      .select("spec_slug")
      .eq("kind", "cs-director-call")
      .in("spec_slug", ticketIds)
      .in("status", ["queued", "queued_resume", "claimed", "building", "needs_input"]);
    const inflightSlugs = new Set((inflight || []).map((j) => j.spec_slug as string));

    let routed = 0;
    for (const t of candidates) {
      if (inflightSlugs.has(t.id)) continue;
      const done = await step.run(`sla-${t.id.slice(0, 8)}`, async () => {
        // Re-read the ticket at write time to collapse any race (another sweep claimed, a
        // human replied, a human took it over) — compare-and-set style predicate before we
        // enqueue + insert the internal note.
        const { data: fresh } = await admin
          .from("tickets")
          .select("id, workspace_id, status, merged_into, escalated_at, escalated_to, assigned_to, active_playbook_id")
          .eq("id", t.id)
          .single();
        if (!fresh) return false;
        if (
          fresh.status !== "open" ||
          fresh.merged_into != null ||
          fresh.escalated_at != null ||
          fresh.assigned_to != null ||
          fresh.active_playbook_id != null
        ) {
          return false;
        }

        const msgs = await getTicketMessages(admin, t.id);
        const lastCustomerAt = newestCustomerAt(msgs);
        const lastResponseAt = newestResponseAt(msgs);
        const hasPendingSend = msgs.some((m) => m.pending_send_at && !m.sent_at && !m.send_cancelled);
        const alreadyMarked = msgs.some(
          (m) =>
            m.visibility === "internal" &&
            m.author_type === "system" &&
            (m.body || "").includes(SLA_BREACH_MARKER) &&
            !!m.created_at &&
            !!lastCustomerAt &&
            m.created_at > lastCustomerAt,
        );
        const fire = shouldRouteToJune({
          lastCustomerAt,
          lastResponseAt,
          hasPendingSend,
          alreadyMarked,
          now,
          slaMs: TICKET_RESPONSE_SLA_MS,
          maxAgeMs: SLA_MAX_AGE_MS,
        });
        if (!fire) return false;

        // Idempotency marker first — if the enqueue fails below, the next sweep still sees
        // the marker and skips, so one SLA breach never pages June twice. The spec
        // mandates this exact internal-note text ("[System] 30-min response SLA breached —
        // routed to June").
        await admin.from("ticket_messages").insert({
          ticket_id: t.id,
          direction: "outbound",
          visibility: "internal",
          author_type: "system",
          body: `[System] ${SLA_BREACH_MARKER}`,
        });

        // Enqueue cs-director-call — same shape as triage-escalations.ts and
        // needs-attention-route-cs-owner.ts: spec_slug = ticket id so the per-slug queue
        // view surfaces one row per ticket; instructions carries ticket_id + the breach
        // context so June's session can see why she was called.
        await admin.from("agent_jobs").insert({
          workspace_id: t.workspace_id,
          spec_slug: t.id,
          kind: "cs-director-call",
          status: "queued",
          instructions: JSON.stringify({
            ticket_id: t.id,
            sla_breach: {
              last_customer_at: lastCustomerAt,
              last_response_at: lastResponseAt,
              waited_ms: lastCustomerAt ? now - Date.parse(lastCustomerAt) : null,
              sla_ms: TICKET_RESPONSE_SLA_MS,
              source: "ticket-response-sla-watchdog",
            },
          }),
          created_by: null,
        });

        // Spec contract: NEVER set escalated_to to the founder from this surface. We leave
        // the ticket's escalation fields alone — June's runner owns any status transition.
        return true;
      });
      if (done) routed++;
    }

    await emitCronHeartbeat("ticket-response-sla-watchdog", {
      ok: true,
      detail: `routed ${routed}/${candidates.length}`,
      produced: { routed, scanned: candidates.length },
    });
    return { routed, scanned: candidates.length };
  },
);
