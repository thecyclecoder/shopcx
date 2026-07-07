/**
 * triage-escalations cron — the hourly trigger for the box's escalation triage lane.
 *
 * Phase 1 of june-review-replaces-solver-skeptic-quorum-triage rewires this cron: instead of
 * enqueueing ONE `triage-escalations` sweep job per workspace (which then ran a solver→skeptic→
 * quorum loop over every eligible ticket), it now enqueues ONE `cs-director-call` job PER eligible
 * escalated ticket. June's review IS the primary triage — she reads the ticket handling
 * (`ticket_resolution_events`) + the analyzer's grade + issue tags (`ticket_analyses`) + the ticket
 * conversation and emits ONE verdict { approve_remedy | author_spec | escalate_founder }. The
 * worker (`runCsDirectorCallJob`) records the verdict to `director_activity` and to `triage_runs`
 * so the audit trail reflects the leaner path. See docs/brain/specs/june-review-replaces-solver-
 * skeptic-quorum-triage.md and docs/brain/libraries/cs-director.md.
 *
 * Eligibility — a ticket qualifies for a June review when it is routine-owned + escalated + not
 * archived/closed AND does NOT already have:
 *   - an inflight `cs-director-call` job (spec_slug = ticket id) — no dup enqueue per hourly tick,
 *   - any prior `triage_runs` row — Phase 1 is one June-review per ticket; Phase 2 will add an
 *     on-demand second-opinion path (retire the routine quorum default).
 *
 * The cron does NOT reason itself — it is purely the enqueue. See docs/brain/inngest/triage-
 * escalations.md.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

// Small per-tick cap so a workspace with a large escalated backlog does not blow the cs-director-
// call lane in a single tick. Matches the box's triage cap semantics (`TRIAGE_CAP` = 5) — the
// remainder drain on the next hourly tick.
const JUNE_REVIEW_ENQUEUE_CAP_PER_TICK = Number(process.env.JUNE_REVIEW_ENQUEUE_CAP_PER_TICK || 20);

export const triageEscalationsCron = inngest.createFunction(
  {
    id: "triage-escalations-cron",
    name: "Escalation triage — hourly June-review enqueue",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "30 * * * *" }], // every hour at :30 (offset from portal-auto-resume's :15)
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const result = await step.run("enqueue-june-review-jobs", async () => {
      // Routine-owned escalated tickets: escalated_at set, escalated_to null (analyzer routed to
      // the routine, not a human), not archived/closed. Ordered oldest-first so a large backlog
      // drains in escalation order across ticks.
      const { data: tickets } = await admin
        .from("tickets")
        .select("id, workspace_id, escalated_at")
        .not("escalated_at", "is", null)
        .is("escalated_to", null)
        .not("status", "in", '("archived","closed")')
        .order("escalated_at", { ascending: true });
      const rows = (tickets || []) as { id: string; workspace_id: string }[];
      if (!rows.length) return { eligible: 0, deferred: 0, enqueued: 0 };
      const ticketIds = rows.map((t) => t.id);

      // Dedupe against inflight cs-director-call jobs (spec_slug = ticket id) — the
      // `enqueueTicketAnalyzeJob` pattern in src/lib/ticket-analyzer.ts uses the same shape so the
      // box's per-slug queue view surfaces one row per ticket.
      const { data: inflight } = await admin
        .from("agent_jobs")
        .select("spec_slug")
        .eq("kind", "cs-director-call")
        .in("spec_slug", ticketIds)
        .in("status", ["queued", "queued_resume", "claimed", "building", "needs_input"]);
      const inflightSlugs = new Set((inflight || []).map((j) => j.spec_slug as string));

      // Dedupe against any prior triage_runs row for the ticket. Phase 1 is one June-review per
      // ticket; Phase 2 will add an on-demand second-opinion mechanism for genuinely borderline
      // cases (the exception, not a routine re-run).
      const { data: prior } = await admin
        .from("triage_runs")
        .select("ticket_id")
        .in("ticket_id", ticketIds);
      const priorTicketIds = new Set((prior || []).map((r) => r.ticket_id as string));

      const eligible = rows.filter((t) => !inflightSlugs.has(t.id) && !priorTicketIds.has(t.id));
      const capped = eligible.slice(0, JUNE_REVIEW_ENQUEUE_CAP_PER_TICK);

      let enqueued = 0;
      for (const t of capped) {
        const { error } = await admin.from("agent_jobs").insert({
          workspace_id: t.workspace_id,
          spec_slug: t.id, // ticket id → per-ticket per-slug queue view, same shape as ticket-analyze
          kind: "cs-director-call",
          status: "queued",
          instructions: JSON.stringify({ ticket_id: t.id }),
          created_by: null,
        });
        if (!error) enqueued++;
      }
      return {
        eligible: eligible.length,
        deferred: Math.max(0, eligible.length - capped.length),
        enqueued,
      };
    });

    // Control Tower: end-of-run heartbeat (control-tower spec, Phase 1). The cron id is unchanged
    // so the registered watcher entry (control-tower/registry.ts) keeps its liveness window.
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("triage-escalations-cron", { ok: true, produced: result });
    });

    return result;
  },
);
