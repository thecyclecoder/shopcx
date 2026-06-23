/**
 * platform-director-cron — the STANDING CADENCE for the box-hosted Platform/DevOps Director
 * ([[../specs/platform-director-agent]], M5 [[../specs/director-loop-grading]] Phase 1).
 *
 * The director already runs event-driven (a `platform-director` agent_jobs row is enqueued when a
 * Platform approval is routed to it). But escorting approved goals through their milestones + watching
 * the platform must happen on a RELIABLE BEAT, not only on inbound approvals — otherwise a goal stalls
 * silently whenever no approval happens to arrive. So, exactly like triage-escalations / spec-test
 * (the box has no internal ticker), this cron is the trigger: once a day it inserts ONE `agent_jobs`
 * row `kind='platform-director'` per build-console workspace, and the box claims it on its
 * platform-director lane (scripts/builder-worker.ts → runPlatformDirectorJob) to run the standing pass.
 *
 * Dedupe: skip a workspace that already has an in-flight platform-director job (queued / queued_resume
 * / building / claimed) — a standing pass must never pile up day over day. This cron does NO reasoning
 * itself; it is purely the enqueue. Mirrors daily-analysis-report-cron's daily cron shape.
 * See docs/brain/inngest/platform-director-cron.md.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const platformDirectorCron = inngest.createFunction(
  {
    id: "platform-director-cron",
    name: "Platform/DevOps Director — daily standing-cadence enqueue",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "15 12 * * *" }], // daily at 12:15 UTC (offset from the other crons)
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const result = await step.run("enqueue-platform-director-jobs", async () => {
      // Build-console workspaces — any workspace that uses the agent-jobs queue (mirrors spec-test-cron).
      const { data: wsRows } = await admin.from("agent_jobs").select("workspace_id").limit(1000);
      const workspaceIds = Array.from(new Set((wsRows || []).map((r) => r.workspace_id as string)));
      if (!workspaceIds.length) return { workspaces: 0, enqueued: 0 };

      // Skip any workspace that already has an in-flight platform-director job (no daily pileup).
      const { data: inflight } = await admin
        .from("agent_jobs")
        .select("workspace_id")
        .eq("kind", "platform-director")
        .in("status", ["queued", "queued_resume", "building", "claimed"]);
      const busy = new Set((inflight || []).map((j) => j.workspace_id as string));

      let enqueued = 0;
      for (const workspaceId of workspaceIds) {
        if (busy.has(workspaceId)) continue;
        const { error } = await admin.from("agent_jobs").insert({
          workspace_id: workspaceId,
          spec_slug: "platform-director",
          kind: "platform-director",
          status: "queued",
          created_by: null,
        });
        if (!error) enqueued++;
      }
      return { workspaces: workspaceIds.length, enqueued };
    });

    // Control Tower: end-of-run heartbeat (control-tower spec, Phase 1) — keeps a DEAD cadence visible
    // so the standing pass can't silently die (MONITORED_LOOPS / coverage-auto-register contract).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("platform-director-cron", { ok: true, produced: result });
    });

    return result;
  },
);
