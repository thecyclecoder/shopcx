/**
 * platform-director-cron — the STANDING CADENCE for the box-hosted Platform/DevOps Director
 * ([[../specs/platform-director-agent]], M5 [[../specs/director-loop-grading]] Phase 1).
 *
 * The director already runs event-driven (a `platform-director` agent_jobs row is enqueued when a
 * Platform approval is routed to it). But escorting approved goals through their milestones + watching
 * the platform must happen on a RELIABLE BEAT, not only on inbound approvals — otherwise a goal stalls
 * silently whenever no approval happens to arrive. So, exactly like triage-escalations / spec-test
 * (the box has no internal ticker), this cron is the trigger: every 5 min it inserts ONE `agent_jobs`
 * row `kind='platform-director'` per build-console workspace, and the box claims it on its
 * platform-director lane (scripts/builder-worker.ts → runPlatformDirectorJob) to run the standing pass.
 * (director-initiation-throughput Phase 3 tightened the beat 15→5 min; the event-driven top-up on a build
 * merge — agent-jobs `enqueueDirectorTopUp` from applyMergedBuildEffects — refills a freed lane within
 * seconds, so this cron is the BACKSTOP heartbeat, not the primary refill trigger.)
 * (A responsive beat so the director actively drives in-flight work; the in-flight dedupe below keeps it
 * to one pass at a time — it never piles up.)
 *
 * Dedupe: skip a workspace that already has an in-flight platform-director job (queued / queued_resume
 * / building / claimed) — a standing pass must never pile up day over day.
 *
 * On the SAME beat it also runs the GRADING LOOP ([[../specs/director-loop-grading]] Phase 3 +
 * [[../specs/grading-cascade-to-box-sessions]] Phase 3): grade every recently-CONCLUDED director call
 * — each autonomous auto-approval + each escorted milestone that landed — 1–10 with reasoning into
 * director_decision_grades. GRADING COMPUTE MOVED BOX-SIDE (CEO directive 2026-06-30, every grader
 * box-side): the cron picks candidates via director-grader.ts `pickDirectorGradeBatch` and enqueues
 * ONE `director-grade` agent_jobs row per batch-ready workspace; the box's director-grade lane
 * (scripts/builder-worker.ts → runDirectorGradeJob) git-shows the target build's approved merged
 * commit + writes director_decision_grades via `applyBoxDirectorGrade`. Same shape as the Phase-1
 * worker-grade cascade below. Mirrors daily-analysis-report-cron's daily cron shape.
 * See docs/brain/inngest/platform-director-cron.md · docs/brain/libraries/director-grader.md.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { pickDirectorGradeBatch } from "@/lib/agents/director-grader";
import { agentGradingBatchReady, pickAgentGradeBatch } from "@/lib/agents/agent-grader";
import { computePlatformScorecard, getRegisteredMetrics } from "@/lib/agents/platform-scorecard";
import { auditAllKpis, type KpiAuditReport } from "@/lib/agents/kpi-review";
import {
  PLATFORM,
  platformHasPendingWork,
  platformStandingPassRecentlyActive,
  recordPlatformStandingPassGateBeat,
} from "@/lib/agents/platform-director";

export const platformDirectorCron = inngest.createFunction(
  {
    id: "platform-director-cron",
    name: "Platform/DevOps Director — daily standing-cadence enqueue",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "*/5 * * * *" }], // every 5 min — a TIGHT standing beat so the pool stays saturated (director-initiation-throughput Phase 3); the event-driven top-up (applyMergedBuildEffects) refills a freed lane within seconds, this cron is the backstop heartbeat. Dedupe below prevents pileup
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const result = await step.run("enqueue-platform-director-jobs", async () => {
      // Build-console workspaces — any workspace that uses the agent-jobs queue (mirrors spec-test-cron).
      const { data: wsRows } = await admin.from("agent_jobs").select("workspace_id").limit(1000);
      const workspaceIds = Array.from(new Set((wsRows || []).map((r) => r.workspace_id as string)));
      if (!workspaceIds.length) {
        return { workspaces: 0, enqueued: 0, workspaceIds: [] as string[], gated: 0, gateDecisions: [] as Array<{ ws: string; pending: boolean; reason: string; enqueued: boolean; recentlyActive: boolean; onTheHour: boolean }> };
      }

      // Skip any workspace that already has an in-flight platform-director job (no daily pileup).
      const { data: inflight } = await admin
        .from("agent_jobs")
        .select("workspace_id")
        .eq("kind", "platform-director")
        .in("status", ["queued", "queued_resume", "building", "claimed"]);
      const busy = new Set((inflight || []).map((j) => j.workspace_id as string));

      // ada-standing-pass-reasoning-gate Phase 4 — idle work-gate + adaptive cadence backoff. Per workspace,
      // BEFORE queueing: check `platformHasPendingWork` (cheap EXISTS/COUNT). If PENDING → enqueue as
      // usual. If NOT pending → back off from */5 to hourly across a solid idle span. `recentlyActive`
      // (a gate beat with `pending=true` within the last 30 min) keeps the cron on */5 through a
      // transient quiet gap; only a solid idle span (no pending signal in 30 min) actually flips the
      // cadence to hourly (enqueue only when the UTC minute is 0). ANY pending signal snaps it back
      // to */5 on the next tick. Best-effort — a gate error → treat as pending (fail-open, prefer
      // running the pass over silencing it).
      const onTheHour = new Date().getUTCMinutes() === 0;

      let enqueued = 0;
      let gated = 0;
      const gateDecisions: Array<{ ws: string; pending: boolean; reason: string; enqueued: boolean; recentlyActive: boolean; onTheHour: boolean }> = [];
      for (const workspaceId of workspaceIds) {
        if (busy.has(workspaceId)) continue;

        let pending = { pending: true, reason: "gate-error" };
        try {
          pending = await platformHasPendingWork(workspaceId);
        } catch (e) {
          console.error(`[platform-director-cron] pending-work gate failed ws=${workspaceId}:`, e instanceof Error ? e.message : e);
        }

        let recentlyActive = false;
        if (!pending.pending) {
          try {
            recentlyActive = await platformStandingPassRecentlyActive(workspaceId);
          } catch (e) {
            recentlyActive = true; // fail-open
            console.error(`[platform-director-cron] recently-active read failed ws=${workspaceId}:`, e instanceof Error ? e.message : e);
          }
        }

        // Enqueue when: pending now · OR non-idle within the last 30 min · OR the hourly floor beat.
        const shouldEnqueue = pending.pending || recentlyActive || onTheHour;

        // Every tick per workspace writes ONE gate beat — the record `platformStandingPassRecentlyActive`
        // reads next tick to decide the cadence. Kept best-effort so a heartbeat write never blocks the
        // enqueue itself.
        await recordPlatformStandingPassGateBeat(workspaceId, pending.pending, pending.reason, {
          enqueued: shouldEnqueue,
          recently_active: recentlyActive,
          on_the_hour: onTheHour,
        });

        gateDecisions.push({ ws: workspaceId, pending: pending.pending, reason: pending.reason, enqueued: shouldEnqueue, recentlyActive, onTheHour });

        if (!shouldEnqueue) {
          gated++;
          continue;
        }
        const { error } = await admin.from("agent_jobs").insert({
          workspace_id: workspaceId,
          spec_slug: "platform-director",
          kind: "platform-director",
          status: "queued",
          created_by: null,
        });
        if (!error) enqueued++;
      }
      return { workspaces: workspaceIds.length, workspaceIds, enqueued, gated, gateDecisions };
    });

    // The DIRECTOR grading loop (grading-cascade-to-box-sessions Phase 3, CEO directive 2026-06-30):
    // GRADING COMPUTE MOVED BOX-SIDE — instead of calling gradeConcludedDirectorCalls inline (which
    // grades from the director's own `reasoning` string + a repeat-failure count — the deployed
    // runtime can't see the approved diff, so it has to trust the director), the cron ENQUEUES ONE
    // `director-grade` `agent_jobs` row per workspace carrying the picked batch of candidates. The
    // box's director-grade lane (scripts/builder-worker.ts → runDirectorGradeJob) then git-shows each
    // target's approved merged commit (or each escorted milestone's member specs' merged shas),
    // independently verifies the call was in-leash / diff-matches-reasoning, and writes
    // director_decision_grades via applyBoxDirectorGrade (same partial-unique upsert + human-override
    // invariant). Mirrors the Phase-1 pattern for worker grades. Best-effort + idempotent. Same-
    // workspace dedup: skip re-enqueueing while a director-grade job for this workspace is already
    // queued/building (one batched box session at a time, no daily pileup).
    //
    // `graded` here == "grading dispatched box-side"; the actual DB write happens in
    // runDirectorGradeJob within a few minutes. Keeps the grading-liveness heartbeat starvation gate
    // correct — a considered>0 (real ungraded backlog) with enqueued=0 (box lane broken / dedupe
    // blocked twice) is a legitimate STARVED state and pages after ≥2 consecutive sweeps.
    const grading = await step.run("grade-concluded-director-calls", async () => {
      let considered = 0;
      let enqueued = 0;
      for (const workspaceId of result.workspaceIds || []) {
        try {
          const batch = await pickDirectorGradeBatch({ workspaceId, admin });
          if (!batch.length) continue;
          // Count the batch toward `considered` up front — regardless of dedup / insert error — so
          // the grading-liveness heartbeat can distinguish "no work" (considered=0) from "work
          // exists but nothing dispatched" (considered>0, enqueued=0) → the starvation gate trips
          // after ≥2 consecutive such beats. A dedup skip (an in-flight `director-grade` job for
          // this workspace already covers the batch) also raises `enqueued` so the gate stays green
          // — dispatch happened; it's just carried by the prior beat's job.
          considered += batch.length;
          const { data: inflight } = await admin
            .from("agent_jobs")
            .select("id")
            .eq("workspace_id", workspaceId)
            .eq("kind", "director-grade")
            .in("status", ["queued", "queued_resume", "building", "claimed"])
            .limit(1);
          if (inflight && inflight.length) {
            enqueued++; // already dispatched on a prior beat — grading IS flowing box-side
            continue;
          }
          const { error } = await admin.from("agent_jobs").insert({
            workspace_id: workspaceId,
            spec_slug: "director-grade",
            kind: "director-grade",
            status: "queued",
            created_by: null,
            instructions: JSON.stringify({ candidates: batch }),
          });
          if (!error) {
            enqueued++;
          } else {
            console.error(`[platform-director-cron] director-grade enqueue failed ws=${workspaceId}: ${error.message}`);
          }
        } catch (e) {
          console.error(`[platform-director-cron] director-grade pick/enqueue failed ws=${workspaceId}:`, e instanceof Error ? e.message : e);
        }
      }
      return { considered, graded: enqueued };
    });

    // The WORKER grading + coaching loop (worker-grading-and-director-management Phase 2 +
    // grading-cascade-to-box-sessions Phase 1): one level DOWN the cascade — on the same beat, the
    // Director grades each recently-CONCLUDED worker action (agent_action_grades) and coaches any
    // worker whose rollup slipped (<7 or >1.5-pt drop → coachAgent). BATCHED: a workspace is graded
    // only when ≥5 ungraded concluded jobs have accumulated OR the oldest is >~3h old
    // (agentGradingBatchReady) — keeps the LLM spend to one session per batch.
    //
    // GRADING COMPUTE MOVED BOX-SIDE (grading-cascade-to-box-sessions Phase 1, CEO directive
    // 2026-06-30). Instead of calling gradeConcludedAgentActions inline (which grades from the job-row
    // metadata + log_tail — the deployed runtime can't see the real diff, so grades cap at 7-9
    // "because I can't see the diff"), the cron ENQUEUES ONE `agent-grade` `agent_jobs` row per
    // batch-ready workspace carrying the picked batch of `agent_job_ids`. The box's agent-grade lane
    // (scripts/builder-worker.ts → runAgentGradeJob) then reads each id's REAL merged diff via
    // git-show / git-diff, applies AGENT_RUBRICS + approved calibration rules, and writes
    // agent_action_grades via applyBoxGrade (same UNIQUE(agent_job_id) upsert + human-override
    // invariant). The coaching cascade (detectGradeDropCoaching) fires per beat over ALL rubric-backed
    // kinds so a slip caused by newly box-written grades is caught within one beat of the box job
    // landing — idempotent, loop-guarded, a no-op when nothing slipped.
    //
    // Best-effort + idempotent. Same-workspace dedup: skip re-enqueueing while an agent-grade job for
    // this workspace is already queued/building (one batched box session at a time, no daily pileup).
    const workerGrading = await step.run("grade-and-coach-workers", async () => {
      let considered = 0;
      let enqueued = 0;
      // consolidate-grade-coach-one-session (Phase 1): coaching moved INTO the agent-grade box session,
      // so the cron no longer coaches per-kind here. `coached` stays in the return shape (always 0 now)
      // for the grading-liveness heartbeat + KPI readers that reference it.
      const coached = 0;
      // director-grades-only-own-charge (Phase 1) — Ada supervises only the PLATFORM-owned workers.
      // Every grading call below is scoped to `PLATFORM` (via agentGradingBatchReady/pickAgentGradeBatch),
      // so this cron stops sweeping ticket-improve/triage-escalations/product-seed/migration-fix/
      // storefront-optimizer (CS/CMO/Retention/Growth workers) — their own director will grade them once live.
      for (const workspaceId of result.workspaceIds || []) {
        try {
          const batch = await agentGradingBatchReady(admin, workspaceId, Date.now(), PLATFORM);
          if (batch.ready) {
            const pool = await pickAgentGradeBatch({ workspaceId, admin, fn: PLATFORM });
            if (pool.length) {
              // Count the batch toward `considered` up front — regardless of dedup / insert-error —
              // so the grading-liveness heartbeat can distinguish "no work" (considered=0) from
              // "work exists but nothing dispatched" (considered>0, enqueued=0) → the starvation
              // gate trips after ≥2 consecutive such beats. A dedup skip (an in-flight `agent-grade`
              // job for this workspace already covers the batch) also raises `enqueued` so the
              // gate stays green — dispatch happened; it's just carried by the prior beat's job.
              considered += pool.length;
              const { data: inflight } = await admin
                .from("agent_jobs")
                .select("id")
                .eq("workspace_id", workspaceId)
                .eq("kind", "agent-grade")
                .in("status", ["queued", "queued_resume", "building", "claimed"])
                .limit(1);
              if (inflight && inflight.length) {
                enqueued++; // already dispatched on a prior beat — grading IS flowing box-side
              } else {
                const { error } = await admin.from("agent_jobs").insert({
                  workspace_id: workspaceId,
                  spec_slug: "agent-grade",
                  kind: "agent-grade",
                  status: "queued",
                  created_by: null,
                  // director-grades-only-own-charge Phase 1 — stamp the enqueuing director's function
                  // on the payload so the box lane's post-batch `detectGradeDropCoaching` fan-out
                  // stays scoped to this director's charge (defense-in-depth; the box also defaults
                  // to 'platform' for a legacy row that predates this field).
                  instructions: JSON.stringify({ agent_job_ids: pool.map((j) => j.id), fn: PLATFORM }),
                });
                if (!error) {
                  enqueued++;
                } else {
                  console.error(`[platform-director-cron] agent-grade enqueue failed ws=${workspaceId}: ${error.message}`);
                }
              }
            }
          }
          // consolidate-grade-coach-one-session (Phase 1): the coaching cascade NO LONGER fans out here.
          // It used to loop every platform kind each beat, and detectGradeDropCoaching enqueued a
          // SEPARATE `agent-coach` box job per slipped kind — each re-hydrating ~550K of context + re-
          // reading diffs the grade session already read (the "4 agent-coach queued" pileup, live 2026-
          // 07-01). Coaching now runs as a FOLLOW-ON inside the ONE `agent-grade` box session
          // (runAgentGradeJob), off the diffs it already read — one lane per director, no re-hydration.
          // A slip is only actionable when a NEW low grade lands, which is exactly when the grade session
          // runs; so tying coaching to that session (not a blind per-beat sweep) loses no coverage.
        } catch (e) {
          console.error(`[platform-director-cron] worker-grade sweep failed ws=${workspaceId}:`, e instanceof Error ? e.message : e);
        }
      }
      // `graded` here == "grading dispatched box-side"; the actual DB write happens in runAgentGradeJob
      // within a few minutes. Keeps the grading-liveness heartbeat starvation gate correct — a
      // considered>0 (real ungraded backlog) with enqueued=0 (box lane broken / dedupe blocked twice)
      // is a legitimate STARVED state and pages after ≥2 consecutive sweeps.
      return { considered, graded: enqueued, coached };
    });

    // The Platform Department Scorecard daily pulse (platform-scorecard-engine Phase 3): on the same
    // standing beat, snapshot the daily KPI set (loop health · error backlog + derived MTTR · build
    // throughput · autonomy ratio · escalations) into platform_scorecard_snapshots so they trend over
    // time. Runs HERE in the deployed runtime (it needs DB access, like the grade sweeps), not on the
    // box. Guarded to once per UTC day per workspace (spend-saving — the upsert on (metric_key,
    // cadence='daily', snapshot_date) already makes a same-day re-run a no-op). Best-effort +
    // idempotent: a quiet workspace writes zeros, never errors.
    const scorecard = await step.run("snapshot-platform-scorecard", async () => {
      // The daily snapshot's effective date is the PREVIOUS complete UTC day, not todayUTC — the
      // window `[snapshotDate, snapshotDate]` must be a full 24h calendar day (devops-kpi-daily-
      // snapshot-date-lag-fix, re-opening devops-kpi-review-sdk-and-data-fix Phase 3). The guard
      // checks the same lagged date so the spend-saving "already done today" check still matches.
      const today = new Date().toISOString().slice(0, 10);
      const snapshotDate = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86_400_000)
        .toISOString()
        .slice(0, 10);
      // The done guard accepts a row only when its updated_at is at/after endIso(snapshotDate) — i.e.,
      // the row was written AFTER the snapshot day's UTC midnight cutoff. Post-lagged-fix rows always
      // satisfy this (snapshotDate = yesterday UTC, written today); pre-lagged-fix rows (kpi-daily-
      // snapshot-date-lag-fix #819) were written during their own snapshot_date and so updated_at <
      // endIso(snapshot_date) — they fall OUT of the done set and get re-snapshotted by the next beat,
      // healing in place via the idempotent upsert on (workspace_id, metric_key, cadence, snapshot_date).
      // Stops the loop:kpi_drift:build_throughput:daily Control Tower signature at its root.
      const endIso = `${snapshotDate}T23:59:59.999Z`;
      const { data: existing } = await admin
        .from("platform_scorecard_snapshots")
        .select("workspace_id, updated_at")
        .eq("cadence", "daily")
        .eq("snapshot_date", snapshotDate)
        .gte("updated_at", endIso);
      const done = new Set(((existing ?? []) as Array<{ workspace_id: string }>).map((r) => r.workspace_id));
      let snapshotted = 0;
      let metricsWritten = 0;
      for (const workspaceId of result.workspaceIds || []) {
        if (done.has(workspaceId)) continue; // already snapshotted for that UTC day (spend-saving)
        try {
          const rows = await computePlatformScorecard(workspaceId, { cadence: "daily", windowDays: 1, snapshotDate });
          if (rows.length) {
            snapshotted++;
            metricsWritten += rows.length;
          }
        } catch (e) {
          console.error(`[platform-director-cron] scorecard snapshot failed ws=${workspaceId}:`, e instanceof Error ? e.message : e);
        }
      }
      return { snapshotted, metricsWritten, date: snapshotDate };
    });

    // The Platform Department Scorecard weekly throughput + quality rollup (platform-scorecard-weekly
    // spec, Phase 2): on the same standing beat, snapshot the weekly KPI set (specs/week · build
    // success rate · idea→merge cycle time · % approvals untouched · per-worker grade rollup ·
    // regressions caught) into platform_scorecard_snapshots over a trailing 7-day window. Guarded to
    // ONCE PER ISO WEEK per workspace (the upsert on (metric_key, cadence='weekly', snapshot_date)
    // already makes a same-week re-run a no-op — the guard is spend-saving). Best-effort + idempotent.
    const scorecardWeekly = await step.run("snapshot-platform-scorecard-weekly", async () => {
      // The weekly snapshot's effective date is the LAST DAY OF THE PREVIOUS CLOSED ISO WEEK (the
      // Sunday immediately before the current ISO Monday), mirroring the daily lag pattern
      // (devops-kpi-weekly-snapshot-date-lag-fix, extending devops-kpi-daily-snapshot-date-lag-fix).
      // The trailing 7-day window then becomes [prev Mon 00:00Z, prev Sun 23:59:59Z] — a fully
      // closed ISO week — so the snapshot value byte-matches the audit's ground-truth re-derivation
      // and the loop:kpi_drift:approvals_untouched_pct:weekly false-positive clears at the writer.
      const today = new Date().toISOString().slice(0, 10);
      const d = new Date(`${today}T00:00:00Z`);
      const mondayOffset = (d.getUTCDay() + 6) % 7; // Sun=0 → 6, Mon=1 → 0, …
      const thisMonday = new Date(d.getTime() - mondayOffset * 86_400_000);
      const snapshotDate = new Date(thisMonday.getTime() - 86_400_000).toISOString().slice(0, 10);
      // The done guard matches on the same lagged snapshot_date so the once-per-week spend-saving
      // check still holds (a second beat in the same ISO week sees the prev-Sunday row and skips).
      const { data: existing } = await admin
        .from("platform_scorecard_snapshots")
        .select("workspace_id")
        .eq("cadence", "weekly")
        .eq("snapshot_date", snapshotDate);
      const done = new Set(((existing ?? []) as Array<{ workspace_id: string }>).map((r) => r.workspace_id));
      let snapshotted = 0;
      let metricsWritten = 0;
      for (const workspaceId of result.workspaceIds || []) {
        if (done.has(workspaceId)) continue; // already snapshotted this ISO week (spend-saving)
        try {
          const rows = await computePlatformScorecard(workspaceId, { cadence: "weekly", windowDays: 7, snapshotDate });
          if (rows.length) {
            snapshotted++;
            metricsWritten += rows.length;
          }
        } catch (e) {
          console.error(`[platform-director-cron] weekly scorecard snapshot failed ws=${workspaceId}:`, e instanceof Error ? e.message : e);
        }
      }
      return { snapshotted, metricsWritten, snapshot_date: snapshotDate };
    });

    // The Platform Department Scorecard monthly leading curve (platform-scorecard-monthly spec,
    // Phase 2): on the same standing beat, snapshot the monthly KPI set (human_touch_per_build ·
    // goals_escorted_unbabysat · time_to_approve_hours · deploy_reliability · director_call_grade)
    // into platform_scorecard_snapshots over a trailing 30-day window ending at the PREVIOUS
    // complete UTC day (devops-kpi-monthly-snapshot-date-lag-fix, mirroring devops-kpi-daily- /
    // devops-kpi-weekly-snapshot-date-lag-fix). Passing that snapshotDate through to
    // computePlatformScorecard closes the window at [snapshotDate − 29, snapshotDate] so the
    // persisted monthly snapshot byte-matches the audit's ground-truth re-derivation (clears the
    // loop:kpi_drift:human_touch_per_build:monthly false-positive at the writer instead of masking
    // it at the audit). The done-set guard matches on the same lagged snapshot_date so a second
    // beat within the same UTC day sees the yesterday-dated row and skips (spend-saving); the
    // upsert on (metric_key, cadence='monthly', snapshot_date) makes a same-date re-run a no-op
    // anyway. Best-effort + idempotent.
    const scorecardMonthly = await step.run("snapshot-platform-scorecard-monthly", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const snapshotDate = new Date(new Date(`${today}T00:00:00Z`).getTime() - 86_400_000)
        .toISOString()
        .slice(0, 10);
      const { data: existing } = await admin
        .from("platform_scorecard_snapshots")
        .select("workspace_id")
        .eq("cadence", "monthly")
        .eq("snapshot_date", snapshotDate);
      const done = new Set(((existing ?? []) as Array<{ workspace_id: string }>).map((r) => r.workspace_id));
      let snapshotted = 0;
      let metricsWritten = 0;
      for (const workspaceId of result.workspaceIds || []) {
        if (done.has(workspaceId)) continue; // already snapshotted for that lagged UTC day (spend-saving)
        try {
          const rows = await computePlatformScorecard(workspaceId, { cadence: "monthly", windowDays: 30, snapshotDate });
          if (rows.length) {
            snapshotted++;
            metricsWritten += rows.length;
          }
        } catch (e) {
          console.error(`[platform-director-cron] monthly scorecard snapshot failed ws=${workspaceId}:`, e instanceof Error ? e.message : e);
        }
      }
      return { snapshotted, metricsWritten, snapshot_date: snapshotDate };
    });

    // The Platform Department Scorecard audit pass (devops-kpi-review-sdk-and-data-fix Phase 5,
    // `audit-platform-scorecard` step): on the same standing beat, re-derive every advertised KPI
    // from the raw tables via [[../libraries/kpi-review]] `auditAllKpis` and compare it to the
    // persisted snapshot. Each metric's drift is logged to `kpi_audit_log` (idempotent upsert on
    // snapshot_date). Persistent drift — over-tolerance for ≥2 consecutive snapshots — opens a
    // `loop_alerts` row keyed `kpi_drift:<metric>:<cadence>` (owner=`platform`, signature stamped)
    // so the control-tower surface + the daily watch line pick it up; a single-snapshot drift is
    // logged but NOT alerted (self-healing on transient timing noise — concluded repairs land
    // between writes, lane utilization churns in seconds, etc.). A metric that recovers to
    // within-tolerance auto-resolves its open alert on the next pass. Best-effort + idempotent.
    const scorecardAudit = await step.run("audit-platform-scorecard", async () => {
      let audited = 0;
      let alertsOpened = 0;
      let alertsResolved = 0;
      for (const workspaceId of result.workspaceIds || []) {
        for (const cadence of ["daily", "weekly", "monthly"] as const) {
          let reports: KpiAuditReport[];
          try {
            reports = await auditAllKpis(workspaceId, cadence);
          } catch (e) {
            console.error(
              `[platform-director-cron] kpi audit failed ws=${workspaceId} cadence=${cadence}:`,
              e instanceof Error ? e.message : e,
            );
            continue;
          }
          if (!reports.length) continue;

          const auditRows = reports.map((r) => ({
            workspace_id: workspaceId,
            metric_key: r.metric,
            cadence: r.cadence,
            snapshot_date: r.snapshotDate,
            snapshot_value: r.snapshotValue,
            ground_truth_value: r.groundTruthValue,
            drift: r.drift,
            drift_pct: r.driftPct,
            within_tolerance: r.withinTolerance,
            updated_at: new Date().toISOString(),
          }));
          const { error: upErr } = await admin
            .from("kpi_audit_log")
            .upsert(auditRows, { onConflict: "workspace_id,metric_key,cadence,snapshot_date" });
          if (upErr) {
            console.error(
              `[platform-director-cron] kpi_audit_log upsert failed ws=${workspaceId} cadence=${cadence}:`,
              upErr.message,
            );
            continue;
          }
          audited += reports.length;

          // Stale-alert sweep for audit-skipped metrics: `auditAllKpis` SKIPS
          // `MetricDef.currentState` metrics (lane_utilization etc. — point reads churn between
          // snapshot write and ground-truth re-read) AND `MetricDef.liveSpecSetDependent` metrics
          // (today: only regression_coverage_pct — specs_per_week's slug→owner map moved to the
          // folded-inclusive director-kpis SDK in director-kpi-sdk Phase 1 and dropped the flag —
          // the live brain-roadmap spec set churns between snapshot write and audit re-read for
          // the remaining live-set-dependent metric). The within-tolerance auto-resolve branch
          // below never fires for either class — they don't appear in `reports` at all — so an
          // alert opened before the metric was flagged would sit open forever. Resolve any open
          // `kpi_drift:<skipped-metric>:<cadence>` here once, on the same standing beat, so the
          // Control Tower tile clears.
          for (const m of getRegisteredMetrics(cadence)) {
            if (!m.currentState && !m.liveSpecSetDependent) continue;
            const signature = `kpi_drift:${m.key}:${cadence}`;
            const { data: openRow } = await admin
              .from("loop_alerts")
              .select("id")
              .eq("status", "open")
              .eq("loop_id", signature)
              .maybeSingle();
            if (openRow) {
              await admin
                .from("loop_alerts")
                .update({ status: "resolved", resolved_at: new Date().toISOString() })
                .eq("id", (openRow as { id: string }).id);
              alertsResolved++;
            }
          }

          for (const r of reports) {
            const signature = `kpi_drift:${r.metric}:${r.cadence}`;
            if (!r.withinTolerance) {
              // Persistent-drift gate: open the alert ONLY when the IMMEDIATELY-PREVIOUS audit row
              // was also over-tolerance (≥2 consecutive snapshots). A lone-snapshot reading is
              // logged above but does NOT page — transient timing noise self-heals on the next
              // pass.
              const { data: prev } = await admin
                .from("kpi_audit_log")
                .select("snapshot_date, within_tolerance")
                .eq("workspace_id", workspaceId)
                .eq("metric_key", r.metric)
                .eq("cadence", r.cadence)
                .lt("snapshot_date", r.snapshotDate)
                .order("snapshot_date", { ascending: false })
                .limit(1)
                .maybeSingle();
              if (!prev || (prev as { within_tolerance: boolean }).within_tolerance !== false) continue;

              const pctTxt = r.driftPct == null ? "n/a" : `${(r.driftPct * 100).toFixed(2)}%`;
              const detail = `KPI ${r.label} (${r.cadence}) drift ${r.drift} (${pctTxt}) for ≥2 consecutive snapshots — snapshot=${r.snapshotValue} vs raw=${r.groundTruthValue} as of ${r.snapshotDate}.`;
              const { data: existing } = await admin
                .from("loop_alerts")
                .select("id")
                .eq("status", "open")
                .eq("loop_id", signature)
                .maybeSingle();
              if (existing) {
                await admin
                  .from("loop_alerts")
                  .update({ detail, last_seen_at: new Date().toISOString() })
                  .eq("id", (existing as { id: string }).id);
              } else {
                const { error: insErr } = await admin.from("loop_alerts").insert({
                  loop_id: signature,
                  kind: "kpi-drift",
                  owner: "platform",
                  signature,
                  reason: "kpi_drift",
                  detail,
                });
                if (!insErr) alertsOpened++;
                else if ((insErr as { code?: string }).code !== "23505") {
                  console.error(
                    `[platform-director-cron] loop_alerts open failed sig=${signature}:`,
                    insErr.message,
                  );
                }
              }
            } else {
              // Within tolerance — auto-resolve any open alert (recovery). Matches the
              // control-tower-monitor pattern (a green loop closes the open incident).
              const { data: openRow } = await admin
                .from("loop_alerts")
                .select("id")
                .eq("status", "open")
                .eq("loop_id", signature)
                .maybeSingle();
              if (openRow) {
                await admin
                  .from("loop_alerts")
                  .update({ status: "resolved", resolved_at: new Date().toISOString() })
                  .eq("id", (openRow as { id: string }).id);
                alertsResolved++;
              }
            }
          }
        }
      }
      return { audited, alertsOpened, alertsResolved };
    });

    // GRADING LIVENESS (fix-starved-grading): the director/worker grade sweeps above can SILENTLY STARVE
    // — the cron heartbeats fine while `graded:0` sweep after sweep (e.g. every concluded build sat in
    // `merged`, which the grader's terminal-status set used to omit → considered>0, graded=0 for days, and
    // nobody saw it). So emit a DEDICATED grading beat (`loop_id='director-decision-grading'`) carrying
    // {considered, graded} for BOTH layers, and open a warn-level `loop_alerts` row when grading is
    // STARVED for ≥2 consecutive sweeps (considered>0 but graded==0 across both layers) — auto-resolving
    // the moment grading flows again. This closes the silent-starvation gap (the CEO's "make sure grading
    // actually happens + is observable" ask) without rebuilding the cadence. Best-effort + idempotent.
    //
    // Post-grading-cascade-to-box-sessions Phase 3: BOTH layers now report `graded` as "dispatched
    // box-side" (director-grade + agent-grade `agent_jobs` inserts) rather than an inline sweep's
    // in-line grade count — the actual DB writes land within a few minutes on the box lanes. The
    // starvation gate is preserved: a considered>0 with enqueued=0 across both layers is a legitimate
    // STARVED state (box lane broken / dedupe blocked twice / pick returned candidates but the insert
    // errored), so `grading_starved:director-decision-grading` still trips after ≥2 consecutive sweeps.
    await step.run("emit-grading-liveness", async () => {
      const consideredTotal = grading.considered + workerGrading.considered;
      const gradedTotal = grading.graded + workerGrading.graded;
      const starved = consideredTotal > 0 && gradedTotal === 0; // work to grade, but nothing graded
      try {
        await emitCronHeartbeat("director-decision-grading", {
          ok: !starved,
          detail: starved ? "grading starved — considered>0 but graded=0" : undefined,
          produced: {
            director: { considered: grading.considered, graded: grading.graded },
            worker: { considered: workerGrading.considered, graded: workerGrading.graded, coached: workerGrading.coached },
            starved,
          },
        });
      } catch (e) {
        console.error("[platform-director-cron] grading-liveness heartbeat failed:", e instanceof Error ? e.message : e);
      }

      // Consecutive-starvation alert: page only when the PRIOR grading beat was also starved (≥2 in a
      // row) — a lone starved sweep (a transient between-merge gap) self-heals on the next beat and must
      // not page. A healthy sweep (graded>0, or nothing to grade) auto-resolves any open alert.
      const signature = "grading_starved:director-decision-grading";
      try {
        if (starved) {
          const { data: prevBeats } = await admin
            .from("loop_heartbeats")
            .select("ok, produced, ran_at")
            .eq("loop_id", "director-decision-grading")
            .order("ran_at", { ascending: false })
            .limit(2);
          // prevBeats[0] is the beat we just wrote; [1] is the immediately-previous sweep.
          const prev = (prevBeats as Array<{ ok: boolean; produced: { starved?: boolean } | null }> | null)?.[1];
          const prevStarved = prev ? prev.ok === false || prev.produced?.starved === true : false;
          if (prevStarved) {
            const detail = `Director/worker grading STARVED for ≥2 consecutive sweeps — considered ${consideredTotal} (director ${grading.considered} + worker ${workerGrading.considered}) but dispatched box-side 0. A concluded-but-ungradeable status (e.g. a build stuck \`merged\` outside the grader's terminal set) or the box's director-grade / agent-grade lane not draining is the usual cause.`;
            const { data: open } = await admin
              .from("loop_alerts")
              .select("id")
              .eq("status", "open")
              .eq("loop_id", signature)
              .maybeSingle();
            if (open) {
              await admin.from("loop_alerts").update({ detail, last_seen_at: new Date().toISOString() }).eq("id", (open as { id: string }).id);
            } else {
              const { error: insErr } = await admin
                .from("loop_alerts")
                .insert({ loop_id: signature, kind: "grading-starved", owner: "platform", signature, reason: "grading_starved", detail });
              if (insErr && (insErr as { code?: string }).code !== "23505") {
                console.error("[platform-director-cron] grading-starved alert open failed:", insErr.message);
              }
            }
          }
        } else if (consideredTotal === 0 || gradedTotal > 0) {
          // Grading flowed (or there was nothing to grade) — recovery: resolve any open starvation alert.
          const { data: open } = await admin
            .from("loop_alerts")
            .select("id")
            .eq("status", "open")
            .eq("loop_id", signature)
            .maybeSingle();
          if (open) {
            await admin
              .from("loop_alerts")
              .update({ status: "resolved", resolved_at: new Date().toISOString() })
              .eq("id", (open as { id: string }).id);
          }
        }
      } catch (e) {
        console.error("[platform-director-cron] grading-starved alert sweep failed:", e instanceof Error ? e.message : e);
      }
    });

    // Control Tower: end-of-run heartbeat (control-tower spec, Phase 1) — keeps a DEAD cadence visible
    // so the standing pass can't silently die (MONITORED_LOOPS / coverage-auto-register contract).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("platform-director-cron", { ok: true, produced: { ...result, grading, workerGrading, scorecard, scorecardWeekly, scorecardMonthly, scorecardAudit } });
    });

    return { ...result, grading, workerGrading, scorecard, scorecardWeekly, scorecardMonthly, scorecardAudit };
  },
);
