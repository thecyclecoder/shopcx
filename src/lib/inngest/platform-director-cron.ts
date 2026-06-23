/**
 * platform-director-cron — the STANDING CADENCE for the box-hosted Platform/DevOps Director
 * ([[../specs/platform-director-agent]], M5 [[../specs/director-loop-grading]] Phase 1).
 *
 * The director already runs event-driven (a `platform-director` agent_jobs row is enqueued when a
 * Platform approval is routed to it). But escorting approved goals through their milestones + watching
 * the platform must happen on a RELIABLE BEAT, not only on inbound approvals — otherwise a goal stalls
 * silently whenever no approval happens to arrive. So, exactly like triage-escalations / spec-test
 * (the box has no internal ticker), this cron is the trigger: every 15 min it inserts ONE `agent_jobs`
 * row `kind='platform-director'` per build-console workspace, and the box claims it on its
 * platform-director lane (scripts/builder-worker.ts → runPlatformDirectorJob) to run the standing pass.
 * (A responsive beat so the director actively drives in-flight work; the in-flight dedupe below keeps it
 * to one pass at a time — it never piles up.)
 *
 * Dedupe: skip a workspace that already has an in-flight platform-director job (queued / queued_resume
 * / building / claimed) — a standing pass must never pile up day over day.
 *
 * On the SAME beat it also runs the GRADING LOOP ([[../specs/director-loop-grading]] Phase 3): grade
 * every recently-CONCLUDED director call — each autonomous auto-approval + each escorted milestone that
 * landed — 1–10 with reasoning into director_decision_grades (src/lib/agents/director-grader.ts
 * `gradeConcludedDirectorCalls`). The grade sweep runs HERE, in the deployed runtime (it needs the
 * Anthropic API key), not on the box; the enqueue half is purely the box-job insert. Mirrors
 * daily-analysis-report-cron's daily cron shape + acquisition-research-cadence's grade sweep.
 * See docs/brain/inngest/platform-director-cron.md · docs/brain/libraries/director-grader.md.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { gradeConcludedDirectorCalls } from "@/lib/agents/director-grader";
import { workerGradingBatchReady, gradeConcludedWorkerActions, detectGradeDropCoaching } from "@/lib/agents/worker-grader";

export const platformDirectorCron = inngest.createFunction(
  {
    id: "platform-director-cron",
    name: "Platform/DevOps Director — daily standing-cadence enqueue",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "*/15 * * * *" }], // every 15 min — a RESPONSIVE standing beat so the director actively drives in-flight work, not once a day (dedupe below prevents pileup)
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const result = await step.run("enqueue-platform-director-jobs", async () => {
      // Build-console workspaces — any workspace that uses the agent-jobs queue (mirrors spec-test-cron).
      const { data: wsRows } = await admin.from("agent_jobs").select("workspace_id").limit(1000);
      const workspaceIds = Array.from(new Set((wsRows || []).map((r) => r.workspace_id as string)));
      if (!workspaceIds.length) return { workspaces: 0, enqueued: 0, workspaceIds: [] as string[] };

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
      return { workspaces: workspaceIds.length, workspaceIds, enqueued };
    });

    // The grading loop (director-loop-grading Phase 3): on the SAME standing beat, grade every
    // recently-CONCLUDED director call — each autonomous auto-approval + each escorted milestone that
    // landed — 1–10 with reasoning (director_decision_grades). Mirrors the acquisition-research-cadence
    // grade sweep; runs HERE (the deployed runtime has the API key) not on the box. Best-effort +
    // idempotent (an already-graded call is skipped). A no-op while the director made no calls.
    const grading = await step.run("grade-concluded-director-calls", async () => {
      let considered = 0;
      let graded = 0;
      for (const workspaceId of result.workspaceIds || []) {
        try {
          const r = await gradeConcludedDirectorCalls({ workspaceId, admin });
          considered += r.considered;
          graded += r.graded;
        } catch (e) {
          console.error(`[platform-director-cron] grade sweep failed ws=${workspaceId}:`, e instanceof Error ? e.message : e);
        }
      }
      return { considered, graded };
    });

    // The WORKER grading + coaching loop (worker-grading-and-director-management Phase 2): one level
    // DOWN the cascade — on the same beat, the Director grades each recently-CONCLUDED worker action
    // (worker_action_grades) and coaches any worker whose rollup slipped (<7 or >1.5-pt drop →
    // coachWorker). BATCHED: a workspace is graded only when ≥5 ungraded concluded jobs have
    // accumulated OR the oldest is >~3h old (workerGradingBatchReady) — keeps the LLM spend to one
    // session per batch. Runs HERE in the deployed runtime (it needs the API key), best-effort +
    // idempotent. A no-op while no worker has concluded an ungraded action.
    const workerGrading = await step.run("grade-and-coach-workers", async () => {
      let considered = 0;
      let graded = 0;
      let coached = 0;
      for (const workspaceId of result.workspaceIds || []) {
        try {
          const batch = await workerGradingBatchReady(admin, workspaceId);
          if (!batch.ready) continue;
          const r = await gradeConcludedWorkerActions({ workspaceId, admin });
          considered += r.considered;
          graded += r.graded;
          // Coach exactly the workers this batch newly graded (a slip → a coachWorker amendment).
          for (const workerKind of r.gradedKinds) {
            try {
              const c = await detectGradeDropCoaching({ workspaceId, workerKind, admin });
              if (c.coached) coached++;
            } catch (e) {
              console.error(`[platform-director-cron] coach ${workerKind} ws=${workspaceId}:`, e instanceof Error ? e.message : e);
            }
          }
        } catch (e) {
          console.error(`[platform-director-cron] worker-grade sweep failed ws=${workspaceId}:`, e instanceof Error ? e.message : e);
        }
      }
      return { considered, graded, coached };
    });

    // Control Tower: end-of-run heartbeat (control-tower spec, Phase 1) — keeps a DEAD cadence visible
    // so the standing pass can't silently die (MONITORED_LOOPS / coverage-auto-register contract).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("platform-director-cron", { ok: true, produced: { ...result, grading, workerGrading } });
    });

    return { ...result, grading, workerGrading };
  },
);
