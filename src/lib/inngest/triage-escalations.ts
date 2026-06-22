/**
 * triage-escalations cron — the hourly trigger for the box-hosted escalation triage routine
 * (box-escalation-triage). The build box has no internal ticker, so (exactly like portal-auto-resume)
 * an Inngest cron enqueues the work: once an hour it inserts ONE `agent_jobs` row
 * (kind='triage-escalations', status='queued') per workspace that currently has a routine-owned
 * escalated ticket. The box claims it on its concurrency-1 triage lane (claim_agent_job) and runs the
 * solver→skeptic→quorum sweep on Max — see scripts/builder-worker.ts → runEscalationTriageJob.
 *
 * Dedupe: skip a workspace that already has a queued/queued_resume/building triage job (a long sweep
 * must never pile up hourly). This cron does NOT do any reasoning itself — it is purely the enqueue.
 * See docs/brain/inngest/triage-escalations.md.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const triageEscalationsCron = inngest.createFunction(
  {
    id: "triage-escalations-cron",
    name: "Escalation triage — hourly box sweep enqueue",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "30 * * * *" }], // every hour at :30 (offset from portal-auto-resume's :15)
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const result = await step.run("enqueue-triage-jobs", async () => {
      // Workspaces with at least one routine-owned escalated ticket (escalated_at set, escalated_to null).
      const { data: escalated } = await admin
        .from("tickets")
        .select("workspace_id")
        .not("escalated_at", "is", null)
        .is("escalated_to", null)
        .not("status", "in", '("archived","closed")');
      const workspaceIds = Array.from(new Set((escalated || []).map((t) => t.workspace_id as string)));
      if (!workspaceIds.length) return { workspaces: 0, enqueued: 0 };

      // Skip any workspace that already has an in-flight triage job (no hourly pileup).
      const { data: inflight } = await admin
        .from("agent_jobs")
        .select("workspace_id")
        .eq("kind", "triage-escalations")
        .in("status", ["queued", "queued_resume", "building", "claimed"]);
      const busy = new Set((inflight || []).map((j) => j.workspace_id as string));

      let enqueued = 0;
      for (const workspaceId of workspaceIds) {
        if (busy.has(workspaceId)) continue;
        const { error } = await admin.from("agent_jobs").insert({
          workspace_id: workspaceId,
          spec_slug: "triage-escalations",
          kind: "triage-escalations",
          status: "queued",
          created_by: null,
        });
        if (!error) enqueued++;
      }
      return { workspaces: workspaceIds.length, enqueued };
    });

    // Control Tower: end-of-run heartbeat (control-tower spec, Phase 1).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("triage-escalations-cron", { ok: true, produced: result });
    });

    return result;
  },
);
