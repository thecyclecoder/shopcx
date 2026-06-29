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
import { agentGradingBatchReady, gradeConcludedAgentActions, detectGradeDropCoaching } from "@/lib/agents/agent-grader";
import { computePlatformScorecard, getRegisteredMetrics } from "@/lib/agents/platform-scorecard";
import { auditAllKpis, type KpiAuditReport } from "@/lib/agents/kpi-review";

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
    // (agent_action_grades) and coaches any worker whose rollup slipped (<7 or >1.5-pt drop →
    // coachAgent). BATCHED: a workspace is graded only when ≥5 ungraded concluded jobs have
    // accumulated OR the oldest is >~3h old (agentGradingBatchReady) — keeps the LLM spend to one
    // session per batch. Runs HERE in the deployed runtime (it needs the API key), best-effort +
    // idempotent. A no-op while no worker has concluded an ungraded action.
    const workerGrading = await step.run("grade-and-coach-workers", async () => {
      let considered = 0;
      let graded = 0;
      let coached = 0;
      for (const workspaceId of result.workspaceIds || []) {
        try {
          const batch = await agentGradingBatchReady(admin, workspaceId);
          if (!batch.ready) continue;
          const r = await gradeConcludedAgentActions({ workspaceId, admin });
          considered += r.considered;
          graded += r.graded;
          // Coach exactly the workers this batch newly graded (a slip → a coachAgent amendment).
          for (const agentKind of r.gradedKinds) {
            try {
              const c = await detectGradeDropCoaching({ workspaceId, agentKind, admin });
              if (c.coached) coached++;
            } catch (e) {
              console.error(`[platform-director-cron] coach ${agentKind} ws=${workspaceId}:`, e instanceof Error ? e.message : e);
            }
          }
        } catch (e) {
          console.error(`[platform-director-cron] worker-grade sweep failed ws=${workspaceId}:`, e instanceof Error ? e.message : e);
        }
      }
      return { considered, graded, coached };
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
      const { data: existing } = await admin
        .from("platform_scorecard_snapshots")
        .select("workspace_id")
        .eq("cadence", "daily")
        .eq("snapshot_date", snapshotDate);
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
      const today = new Date().toISOString().slice(0, 10);
      // ISO week start (Monday, UTC) — any weekly snapshot already taken on/after it covers this week.
      const d = new Date(`${today}T00:00:00Z`);
      const mondayOffset = (d.getUTCDay() + 6) % 7; // Sun=0 → 6, Mon=1 → 0, …
      const weekStart = new Date(d.getTime() - mondayOffset * 86_400_000).toISOString().slice(0, 10);
      const { data: existing } = await admin
        .from("platform_scorecard_snapshots")
        .select("workspace_id")
        .eq("cadence", "weekly")
        .gte("snapshot_date", weekStart);
      const done = new Set(((existing ?? []) as Array<{ workspace_id: string }>).map((r) => r.workspace_id));
      let snapshotted = 0;
      let metricsWritten = 0;
      for (const workspaceId of result.workspaceIds || []) {
        if (done.has(workspaceId)) continue; // already snapshotted this ISO week (spend-saving)
        try {
          const rows = await computePlatformScorecard(workspaceId, { cadence: "weekly", windowDays: 7 });
          if (rows.length) {
            snapshotted++;
            metricsWritten += rows.length;
          }
        } catch (e) {
          console.error(`[platform-director-cron] weekly scorecard snapshot failed ws=${workspaceId}:`, e instanceof Error ? e.message : e);
        }
      }
      return { snapshotted, metricsWritten, week_start: weekStart };
    });

    // The Platform Department Scorecard monthly leading curve (platform-scorecard-monthly spec,
    // Phase 2): on the same standing beat, snapshot the monthly KPI set (human_touch_per_build ·
    // goals_escorted_unbabysat · time_to_approve_hours · deploy_reliability · director_call_grade)
    // into platform_scorecard_snapshots over a trailing 30-day window. Guarded to ONCE PER CALENDAR
    // MONTH per workspace (skip any workspace with a monthly row already taken on/after the first of
    // the month; the upsert on (metric_key, cadence='monthly', snapshot_date) makes a same-month
    // re-run a no-op anyway). Best-effort + idempotent.
    const scorecardMonthly = await step.run("snapshot-platform-scorecard-monthly", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const monthStart = `${today.slice(0, 7)}-01`;
      const { data: existing } = await admin
        .from("platform_scorecard_snapshots")
        .select("workspace_id")
        .eq("cadence", "monthly")
        .gte("snapshot_date", monthStart);
      const done = new Set(((existing ?? []) as Array<{ workspace_id: string }>).map((r) => r.workspace_id));
      let snapshotted = 0;
      let metricsWritten = 0;
      for (const workspaceId of result.workspaceIds || []) {
        if (done.has(workspaceId)) continue; // already snapshotted this calendar month (spend-saving)
        try {
          const rows = await computePlatformScorecard(workspaceId, { cadence: "monthly", windowDays: 30 });
          if (rows.length) {
            snapshotted++;
            metricsWritten += rows.length;
          }
        } catch (e) {
          console.error(`[platform-director-cron] monthly scorecard snapshot failed ws=${workspaceId}:`, e instanceof Error ? e.message : e);
        }
      }
      return { snapshotted, metricsWritten, month_start: monthStart };
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

          // Stale-alert sweep for current-state metrics: `auditAllKpis` SKIPS
          // `MetricDef.currentState` metrics (lane_utilization etc. — point reads churn between
          // snapshot write and ground-truth re-read, so the diff is moving-target noise, not drift).
          // The within-tolerance auto-resolve branch below never fires for them — they don't appear
          // in `reports` at all — so an alert opened before the metric was flagged would sit open
          // forever. Resolve any open `kpi_drift:<currentState>:<cadence>` here once, on the same
          // standing beat, so the Control Tower tile clears.
          for (const m of getRegisteredMetrics(cadence)) {
            if (!m.currentState) continue;
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

    // Control Tower: end-of-run heartbeat (control-tower spec, Phase 1) — keeps a DEAD cadence visible
    // so the standing pass can't silently die (MONITORED_LOOPS / coverage-auto-register contract).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("platform-director-cron", { ok: true, produced: { ...result, grading, workerGrading, scorecard, scorecardWeekly, scorecardMonthly, scorecardAudit } });
    });

    return { ...result, grading, workerGrading, scorecard, scorecardWeekly, scorecardMonthly, scorecardAudit };
  },
);
