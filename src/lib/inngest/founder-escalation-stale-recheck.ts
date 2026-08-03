/**
 * founder-escalation-stale-recheck cron — Phase 2 of docs/brain/specs/a-founder-escalated-
 * customer-never-waits-in-silence.md.
 *
 * Every hour (offset from `triage-escalations-cron` at :30 → this at :45) sweep tickets that were
 * escalated to the founder ≥48h ago, have received at least one new inbound customer message since
 * the escalation, and have NOT been re-checked more than the cap. Re-enqueue ONE `cs-director-call`
 * job per eligible ticket so June re-reads with fresh state.
 *
 * WHY this cron exists — the founder lane is the outlier on wait-times across every escalation lane
 * (the spec measured median wait 1.0h across all lanes; the founder lane hit 46–232h on the three
 * worst multi-day stalls, one of which was Susan Bellamy sending four more messages into silence
 * and abandoning a subscription she was actively trying to buy). The Phase-1 acknowledgement makes
 * the silence honest but does not un-stall it; Phase 2 is the un-stall. June is now materially
 * better equipped (the policy package shipped 2026-08-02, a derived grandfathered-price restore is
 * moving into her leash) — several of the historical founder escalations she can now handle
 * herself.
 *
 * OWNERSHIP — the recheck's outcome is June's, not the founder's. Three shapes are possible on
 * recheck (the same three the primary triage produces):
 *   1. `approve_remedy` — June can now handle it in leash. Her handler fires the fix + delivers
 *      the customer message. The prior CEO card should be withdrawn (that withdrawal is left to a
 *      follow-up spec so this cron stays a pure enqueue; the acknowledgement Phase 1 shipped
 *      keeps the customer informed regardless).
 *   2. `escalate_founder` (again) — it's still a genuine founder call. `handleEscalateFounder`
 *      sends a SECOND, DIFFERENT acknowledgement (via `composeFounderEscalationAck`'s
 *      recheckIndex-aware variants) so the customer doesn't hear the same text twice.
 *   3. `author_spec` / `close_no_action` — same terminal semantics as the primary triage.
 *
 * CAP — a ticket may be re-checked AT MOST twice (`FOUNDER_RECHECK_CAP = 2`). Once the cap is hit,
 * the sweep stops enqueuing for that ticket forever, so a genuinely founder-only decision does not
 * become a loop that pages June every 48h until the CEO acts. The count is derived by counting
 * prior `cs-director-call` `agent_jobs` rows on this ticket carrying `instructions.recheck: true`
 * (not by a column on `tickets` — the ledger is the source of truth so a manual re-run works too).
 *
 * See docs/brain/inngest/founder-escalation-stale-recheck.md.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { STALE_FOUNDER_ESCALATION_HOURS } from "@/lib/cs-director";

// ── Tunables ──────────────────────────────────────────────────────────────────────────────────────

/**
 * A founder-escalated ticket is "stale" 48h after its `escalated_at`. The spec measured 232h /
 * 75h / 46h as the three worst multi-day stalls; 48h is the tightest cutoff that would have caught
 * all three (46h narrowly qualifies) without waking June for routine same-day CEO reviews.
 *
 * SINGLE SOURCE OF TRUTH — the authoritative constant is `STALE_FOUNDER_ESCALATION_HOURS` in
 * `src/lib/cs-director.ts` (declared alongside the escalate_founder handler + Phase-2 recheckIndex
 * resolver so the founder-escalation stale contract is findable in one place). This module
 * re-exports it under the local alias so existing callers/tests that reference
 * `FOUNDER_STALE_RECHECK_HOURS` keep working while a `git grep STALE_FOUNDER_ESCALATION_HOURS`
 * on cs-director.ts stays green.
 */
export const FOUNDER_STALE_RECHECK_HOURS = STALE_FOUNDER_ESCALATION_HOURS;

/**
 * Max re-checks per ticket. Two rechecks + one initial review = at most three June-review sessions
 * over a founder-escalated ticket. Beyond that, the ticket is genuinely a CEO-only decision and
 * further June pings are noise.
 */
export const FOUNDER_RECHECK_CAP = Number(process.env.FOUNDER_RECHECK_CAP || 2);

/**
 * Per-tick enqueue cap so a large stale backlog cannot blow the cs-director-call lane in one
 * hourly tick — mirrors triage-escalations-cron's own cap semantics.
 */
export const FOUNDER_STALE_RECHECK_ENQUEUE_CAP_PER_TICK = Number(
  process.env.FOUNDER_STALE_RECHECK_ENQUEUE_CAP_PER_TICK || 20,
);

// ── Pure predicates (unit-tested) ─────────────────────────────────────────────────────────────────

/**
 * Ticket-level eligibility for a Phase-2 stale recheck. Pure so the invariant is reviewable in
 * isolation without a DB — a future SQL edit that leaks a routine-owned or too-fresh row cannot
 * defeat this predicate.
 *
 * A ticket qualifies when:
 *   - `escalated_at` is set (an escalation actually happened)
 *   - `escalated_to` is NOT null (the founder — not the routine — owns it; contrast the primary
 *     triage which selects `escalated_to IS NULL`)
 *   - `status` is not archived/closed (a closed ticket has no live escalation to re-check)
 *   - the escalation is at least `hoursThreshold` old (48h by default)
 */
export function passesFounderStaleRecheckSelection(
  ticket: {
    escalated_at: string | null;
    escalated_to: string | null;
    status: string | null;
  },
  nowIso: string,
  hoursThreshold: number = FOUNDER_STALE_RECHECK_HOURS,
): boolean {
  if (!ticket.escalated_at) return false;
  if (ticket.escalated_to === null) return false;
  if (ticket.status === "archived" || ticket.status === "closed") return false;
  const escAt = Date.parse(ticket.escalated_at);
  const now = Date.parse(nowIso);
  if (Number.isNaN(escAt) || Number.isNaN(now)) return false;
  const ageMs = now - escAt;
  return ageMs >= hoursThreshold * 60 * 60 * 1000;
}

/**
 * Count of prior recheck invocations for a ticket. Derived from `agent_jobs` rows (kind =
 * `cs-director-call`, spec_slug = ticket id) whose `instructions.recheck === true`. Pure — takes
 * the parsed instructions strings so a test can enumerate the exact ledger shape.
 */
export function countPriorFounderRechecks(
  jobsForTicket: readonly { instructions: string | null }[],
): number {
  let n = 0;
  for (const j of jobsForTicket) {
    if (!j.instructions) continue;
    try {
      const parsed = JSON.parse(j.instructions) as { recheck?: unknown };
      if (parsed && parsed.recheck === true) n += 1;
    } catch {
      /* malformed row — do not count */
    }
  }
  return n;
}

/**
 * Pure enqueue-instructions builder — the JSON string handed to `agent_jobs.instructions` for a
 * recheck job. Carries the linkage back to the originating triage_run when known so
 * `handleEscalateFounder`'s existing `resolveLinkageFromJob` still finds it. `recheck: true` is the
 * signal `countPriorFounderRechecks` (and `composeFounderEscalationAck`'s recheckIndex-aware
 * copy) reads.
 */
export function buildFounderRecheckInstructions(args: {
  ticketId: string;
  triageRunId?: string | null;
  recheckIndex: number;
}): string {
  const payload: Record<string, unknown> = {
    ticket_id: args.ticketId,
    recheck: true,
    recheck_index: args.recheckIndex,
  };
  if (args.triageRunId) payload.triage_run_id = args.triageRunId;
  return JSON.stringify(payload);
}

// ── Cron ──────────────────────────────────────────────────────────────────────────────────────────

export const founderEscalationStaleRecheckCron = inngest.createFunction(
  {
    id: "founder-escalation-stale-recheck-cron",
    name: "Founder escalation — stale re-check enqueue",
    retries: 1,
    concurrency: [{ limit: 1 }],
    // Hourly at :45 — offset from triage-escalations at :30 so the two crons don't stampede the
    // cs-director-call lane in the same minute.
    triggers: [{ cron: "45 * * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const result = await step.run("enqueue-founder-stale-recheck-jobs", async () => {
      const nowIso = new Date().toISOString();

      // Founder-owned escalated tickets not yet resolved. Ordered oldest-first so the longest
      // waits drain first when a large backlog exists.
      const { data: tickets } = await admin
        .from("tickets")
        .select("id, workspace_id, escalated_at, escalated_to, status")
        .not("escalated_at", "is", null)
        .not("escalated_to", "is", null)
        .not("status", "in", '("archived","closed")')
        .order("escalated_at", { ascending: true });

      const fetched = (tickets || []) as {
        id: string;
        workspace_id: string;
        escalated_at: string | null;
        escalated_to: string | null;
        status: string | null;
      }[];

      // Ticket-level eligibility (pure predicate re-asserted so a future SQL edit that accidentally
      // leaks an ineligible row cannot reach enqueue).
      const stale = fetched.filter((t) => passesFounderStaleRecheckSelection(t, nowIso));
      if (!stale.length) {
        return {
          candidates: 0,
          filtered_no_customer_reply: 0,
          filtered_cap_hit: 0,
          filtered_inflight: 0,
          enqueued: 0,
        };
      }
      const ticketIds = stale.map((t) => t.id);

      // At least one inbound customer message since `escalated_at`. "The customer keeps writing"
      // is the spec's second half of the trigger — silence alone is a completed one-way message
      // (bad but not the pattern this cron targets); it's the customer's continued pings that
      // define "left in silence while asking again".
      const msgFilters = await admin
        .from("ticket_messages")
        .select("ticket_id, created_at")
        .in("ticket_id", ticketIds)
        .eq("direction", "inbound")
        .eq("author_type", "customer");
      const latestInboundByTicket = new Map<string, string>();
      for (const m of (msgFilters.data || []) as { ticket_id: string; created_at: string }[]) {
        const prev = latestInboundByTicket.get(m.ticket_id);
        if (!prev || Date.parse(m.created_at) > Date.parse(prev)) {
          latestInboundByTicket.set(m.ticket_id, m.created_at);
        }
      }
      const withNewCustomerReply = stale.filter((t) => {
        if (!t.escalated_at) return false;
        const latest = latestInboundByTicket.get(t.id);
        if (!latest) return false;
        return Date.parse(latest) > Date.parse(t.escalated_at);
      });
      const filteredNoCustomerReply = stale.length - withNewCustomerReply.length;

      // Dedupe against inflight cs-director-call jobs — a job already queued/claimed on this
      // ticket picks up the fresh state anyway; enqueuing a second would double-page June.
      const { data: inflight } = await admin
        .from("agent_jobs")
        .select("spec_slug")
        .eq("kind", "cs-director-call")
        .in("spec_slug", ticketIds)
        .in("status", ["queued", "queued_resume", "claimed", "building", "needs_input"]);
      const inflightSlugs = new Set((inflight || []).map((j) => j.spec_slug as string));
      const notInflight = withNewCustomerReply.filter((t) => !inflightSlugs.has(t.id));
      const filteredInflight = withNewCustomerReply.length - notInflight.length;

      // Cap enforcement — count prior recheck jobs per ticket from `agent_jobs.instructions.recheck`.
      // The `.in()` query fetches ALL cs-director-call jobs for these tickets; the pure counter
      // filters to `recheck === true` per-ticket.
      const { data: allDirectorJobs } = await admin
        .from("agent_jobs")
        .select("spec_slug, instructions")
        .eq("kind", "cs-director-call")
        .in("spec_slug", ticketIds);
      const jobsByTicket = new Map<string, { instructions: string | null }[]>();
      for (const j of (allDirectorJobs || []) as { spec_slug: string; instructions: string | null }[]) {
        const arr = jobsByTicket.get(j.spec_slug) ?? [];
        arr.push({ instructions: j.instructions });
        jobsByTicket.set(j.spec_slug, arr);
      }
      const eligible: Array<{ ticket: (typeof notInflight)[number]; recheckIndex: number }> = [];
      let filteredCapHit = 0;
      for (const t of notInflight) {
        const prior = countPriorFounderRechecks(jobsByTicket.get(t.id) ?? []);
        if (prior >= FOUNDER_RECHECK_CAP) {
          filteredCapHit += 1;
          continue;
        }
        eligible.push({ ticket: t, recheckIndex: prior + 1 });
      }

      const capped = eligible.slice(0, FOUNDER_STALE_RECHECK_ENQUEUE_CAP_PER_TICK);

      let enqueued = 0;
      for (const { ticket, recheckIndex } of capped) {
        const { error } = await admin.from("agent_jobs").insert({
          workspace_id: ticket.workspace_id,
          spec_slug: ticket.id,
          kind: "cs-director-call",
          status: "queued",
          instructions: buildFounderRecheckInstructions({
            ticketId: ticket.id,
            recheckIndex,
          }),
          created_by: null,
        });
        if (!error) enqueued += 1;
      }
      return {
        candidates: stale.length,
        filtered_no_customer_reply: filteredNoCustomerReply,
        filtered_inflight: filteredInflight,
        filtered_cap_hit: filteredCapHit,
        enqueued,
      };
    });

    // Control Tower heartbeat — the loop id matches the MONITORED_LOOPS registry entry.
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("founder-escalation-stale-recheck-cron", { ok: true, produced: result });
    });

    return result;
  },
);
