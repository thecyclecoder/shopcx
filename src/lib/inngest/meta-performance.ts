// Inngest functions for Meta performance ingestion (Storefront Iteration Engine
// Phase 1). Mirrors campaign/adset/ad structure + daily object-grain insights
// into meta_campaigns/meta_adsets/meta_ads/meta_insights_daily, then reconciles
// against the existing daily_meta_ad_spend account rollup.

import { inngest } from "./client";
import { errText } from "@/lib/error-text";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMetaUserToken } from "@/lib/meta-ads";
import { ingestMetaPerformance } from "@/lib/meta/performance";
import { refreshVariantAttribution } from "@/lib/meta/attribution";
import { refreshScorecards } from "@/lib/meta/scorecards";
import { runDecisionEngine, persistActions } from "@/lib/meta/decision-engine";
import { executeAutonomousActions } from "@/lib/meta/execution";
import { executeRecommendation } from "@/lib/meta/recommendation-execute";
import {
  startRun,
  finishRun,
  reconcilePriorActions,
  buildReversalLinks,
  linkReversals,
  MIN_ACTION_SPEND_CENTS,
  MIN_VARIANT_SESSIONS,
  type StageRecord,
} from "@/lib/meta/iteration-run";
import { runGrowthAllocationPass } from "@/lib/growth-allocation";
import { attributeCreativeOutcomes } from "@/lib/ads/creative-outcome-attribution";
import { notifyOpsAlert } from "@/lib/notify-ops-alert";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

// ── meta/sync-performance — ingest one account ──
export const metaSyncPerformance = inngest.createFunction(
  {
    id: "meta-sync-performance",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.ad_account_id" }],
    triggers: [{ event: "meta/sync-performance" }],
  },
  async ({ event, step }) => {
    const { workspace_id, ad_account_id, meta_account_id, incremental_days } = event.data as {
      workspace_id: string;
      ad_account_id: string;
      meta_account_id: string;
      incremental_days?: number;
    };

    const token = await step.run("get-token", async () => {
      const t = await getMetaUserToken(workspace_id);
      if (!t) throw new Error("No active Meta token for workspace");
      return t;
    });

    const result = await step.run("ingest", async () => {
      return ingestMetaPerformance(
        { workspaceId: workspace_id, adAccountId: ad_account_id, metaAccountId: meta_account_id, accessToken: token },
        { incrementalDays: incremental_days },
      );
    });

    // Surface reconciliation drift loudly (Phase 5 will route this to run-records/alerts).
    if (result.reconcile.drift.length) {
      console.warn(
        `[meta-performance] spend drift vs daily_meta_ad_spend for account ${ad_account_id}:`,
        JSON.stringify(result.reconcile.drift),
      );
    }

    // Phase 2 — refresh variant attribution now that insights are fresh (the
    // ad-level spend it allocates was just upserted above). Phase 5 will fold this
    // into the full daily orchestration; firing it here keeps the data current.
    await step.run("attribution-refresh", async () => {
      await inngest.send({
        name: "meta/attribution-refresh",
        data: { workspace_id, ad_account_id },
      });
    });

    return { status: "complete", ...result };
  },
);

// ── meta/attribution-refresh — Phase 2 per-(meta_ad_id, variant, day) rollup ──
export const metaAttributionRefresh = inngest.createFunction(
  {
    id: "meta-attribution-refresh",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.ad_account_id" }],
    triggers: [{ event: "meta/attribution-refresh" }],
  },
  async ({ event, step }) => {
    const { workspace_id, ad_account_id, incremental_days } = event.data as {
      workspace_id: string;
      ad_account_id: string;
      incremental_days?: number;
    };

    const result = await step.run("compute", async () => {
      return refreshVariantAttribution(
        { workspaceId: workspace_id, adAccountId: ad_account_id },
        { incrementalDays: incremental_days },
      );
    });

    // Surface the coverage metric loudly (Phase 5 will route to run-records/alerts).
    console.log(
      `[meta-attribution] account ${ad_account_id} variant_attribution_coverage=${result.coverage.variant_attribution_coverage}`,
      JSON.stringify(result.coverage),
    );

    // Phase 3 — refresh scorecards now that per-variant attribution is fresh. Phase
    // 5 folds this into the full daily orchestration; firing it here keeps the
    // controller's metrics current as soon as attribution lands.
    await step.run("scorecards-refresh", async () => {
      await inngest.send({
        name: "meta/scorecards-refresh",
        data: { workspace_id, ad_account_id },
      });
    });

    return { status: "complete", ...result };
  },
);

// ── meta/scorecards-refresh — Phase 3 deterministic metric rollups ──
export const metaScorecardsRefresh = inngest.createFunction(
  {
    id: "meta-scorecards-refresh",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.ad_account_id" }],
    triggers: [{ event: "meta/scorecards-refresh" }],
  },
  async ({ event, step }) => {
    const { workspace_id, ad_account_id, snapshot_date, window_days } = event.data as {
      workspace_id: string;
      ad_account_id: string;
      snapshot_date?: string;
      window_days?: number;
    };

    const result = await step.run("compute", async () => {
      return refreshScorecards(
        { workspaceId: workspace_id, adAccountId: ad_account_id },
        { snapshotDate: snapshot_date, windowDays: window_days },
      );
    });

    console.log(
      `[meta-scorecards] account ${ad_account_id} ${result.snapshotDate} rows=${result.rows} ` +
        `coverage=${result.variant_attribution_coverage}`,
      JSON.stringify(result.counts),
    );

    // Phase 4 — run the decision engine now that scorecards are fresh. Phase 5
    // folds this into the full daily orchestration (with the reconcile/reversal
    // stage); firing it here keeps decisions current as soon as metrics land.
    await step.run("decision-engine", async () => {
      await inngest.send({
        name: "meta/decision-engine",
        data: { workspace_id, ad_account_id, snapshot_date: result.snapshotDate },
      });
    });

    return { status: "complete", ...result };
  },
);

// ── meta/decision-engine — Phase 4: scorecards + policy → two outputs ──
// 4a autonomous policy actions (decided here, executed in Phase 6a) + 4b
// approval-gated recommendations (persisted PAUSED to iteration_recommendations).
// NO external (Meta) writes occur here. With no active policy, zero autonomous
// actions are produced (the core safety invariant).
export const metaDecisionEngine = inngest.createFunction(
  {
    id: "meta-decision-engine",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.ad_account_id" }],
    triggers: [{ event: "meta/decision-engine" }],
  },
  async ({ event, step }) => {
    const { workspace_id, ad_account_id, snapshot_date } = event.data as {
      workspace_id: string;
      ad_account_id: string;
      snapshot_date?: string;
    };

    const result = await step.run("decide", async () => {
      return runDecisionEngine(
        { workspaceId: workspace_id, adAccountId: ad_account_id },
        { snapshotDate: snapshot_date },
      );
    });

    console.log(
      `[meta-decision] account ${ad_account_id} ${result.snapshotDate} ` +
        `policy_active=${result.policy_active} actions=${result.autonomous.actions.length} ` +
        `escalations=${result.autonomous.escalations.length} ` +
        `recs=${result.recommendations.generated}/${result.recommendations.persisted}`,
      JSON.stringify({ counts: result.autonomous.counts, byType: result.recommendations.byType }),
    );

    return { status: "complete", ...result };
  },
);

// ── meta/iteration-run — Phase 5: the full daily pipeline as ONE durable run ──
// Folds the chain above (ingest → attribution → rollups) into a single
// self-correcting run, then adds the reconcile/reversal stage, persists the 4a
// autonomous decisions to iteration_actions, and records the whole thing to
// iteration_runs (status, timing, counts) with a failure alert. Every stage is
// idempotent, so a re-run on the same day never double-writes/recommends/acts.
// Stage 7 executes the decided actions on Meta (Phase 6a — pause/unpause/scale via
// executeAutonomousActions; only status='decided' rows, idempotent). With no
// active policy the run does scorecards + 4b recommendations only.
export const metaIterationRun = inngest.createFunction(
  {
    id: "meta-iteration-run",
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.ad_account_id" }],
    triggers: [{ event: "meta/iteration-run" }],
  },
  async ({ event, step }) => {
    const { workspace_id, ad_account_id, meta_account_id, trigger, incremental_days } = event.data as {
      workspace_id: string;
      ad_account_id: string;
      meta_account_id: string;
      trigger?: "cron" | "manual";
      incremental_days?: number;
    };
    const p = { workspaceId: workspace_id, adAccountId: ad_account_id };

    const runId = await step.run("start-run", () =>
      startRun(p, trigger === "manual" ? "manual" : "cron"),
    );

    const stages: StageRecord[] = [];
    try {
      // ── Stage 1 — ingest Meta performance (P1) ──────────────────────────────
      const ingest = await step.run("ingest", async () => {
        const t0 = Date.now();
        const token = await getMetaUserToken(workspace_id);
        if (!token) throw new Error("No active Meta token for workspace");
        const r = await ingestMetaPerformance(
          { workspaceId: workspace_id, adAccountId: ad_account_id, metaAccountId: meta_account_id, accessToken: token },
          { incrementalDays: incremental_days },
        );
        const insightRows = r.insights.campaign + r.insights.adset + r.insights.ad;
        return { ms: Date.now() - t0, drift: r.reconcile.drift.length, insightRows, asyncBackfill: r.asyncBackfill };
      });
      // insight_rows is the rows-written assertion's observable output: a 0 here on
      // an account with prior spend would already have thrown inside the ingest.
      // async_backfill flags when the first-run backfill used Meta's async report path
      // (iteration-ingest-async-reports) instead of chunked synchronous GETs.
      stages.push({
        name: "ingest",
        status: "ok",
        ms: ingest.ms,
        spend_drift_objects: ingest.drift,
        insight_rows: ingest.insightRows,
        async_backfill: ingest.asyncBackfill,
      });

      // ── Stage 2 — variant attribution refresh (P2/2b) ───────────────────────
      const attribution = await step.run("attribution", async () => {
        const t0 = Date.now();
        const r = await refreshVariantAttribution({ workspaceId: workspace_id, adAccountId: ad_account_id }, {});
        return { ms: Date.now() - t0, coverage: r.coverage.variant_attribution_coverage, rows: r.rows };
      });
      stages.push({
        name: "attribution",
        status: "ok",
        ms: attribution.ms,
        variant_attribution_coverage: attribution.coverage,
        rows: attribution.rows,
      });

      // ── Stage 3 — scorecard rollups (P3) → resolves the snapshot date ───────
      const scorecards = await step.run("rollups", async () => {
        const t0 = Date.now();
        const r = await refreshScorecards({ workspaceId: workspace_id, adAccountId: ad_account_id }, {});
        return { ms: Date.now() - t0, snapshotDate: r.snapshotDate, rows: r.rows, counts: r.counts };
      });
      const snapshotDate = scorecards.snapshotDate;
      stages.push({ name: "rollups", status: "ok", ms: scorecards.ms, snapshot_date: snapshotDate, rows: scorecards.rows });

      // ── Stage 4 — reconcile prior actions (outcomes + reversal targets) ─────
      const reconcile = await step.run("reconcile", async () => {
        const t0 = Date.now();
        const r = await reconcilePriorActions(p, snapshotDate);
        return { ms: Date.now() - t0, ...r };
      });
      stages.push({ name: "reconcile", status: "ok", ms: reconcile.ms, outcomes_reconciled: reconcile.outcomes_reconciled });

      // ── Stage 5+6 — decision engine: 4a autonomous actions + 4b recs ────────
      // Run-wide cooldown + per-account budget-delta ceiling + the no-active-policy
      // invariant are enforced inside runDecisionEngine; noise floors skip thin objects.
      const decision = await step.run("decide", async () => {
        const t0 = Date.now();
        const r = await runDecisionEngine(p, {
          snapshotDate,
          minSpendCents: MIN_ACTION_SPEND_CENTS,
          minSessions: MIN_VARIANT_SESSIONS,
        });
        return { ms: Date.now() - t0, ...r };
      });
      stages.push({
        name: "decide",
        status: "ok",
        ms: decision.ms,
        policy_active: decision.policy_active,
        actions: decision.autonomous.actions.length,
        escalations: decision.autonomous.escalations.length,
        recommendations: decision.recommendations.persisted,
      });

      // ── Stage 6b — persist the 4a decisions to the ledger + link reversals ──
      const persisted = await step.run("persist-actions", async () => {
        const t0 = Date.now();
        const count = await persistActions(
          p,
          snapshotDate,
          decision.autonomous.actions,
          decision.autonomous.escalations,
        );
        const links = buildReversalLinks(decision.autonomous.actions, reconcile.openReversibles);
        const reversals = await linkReversals(p, snapshotDate, links);
        return { ms: Date.now() - t0, count, reversals };
      });
      stages.push({ name: "persist-actions", status: "ok", ms: persisted.ms, persisted: persisted.count, reversals: persisted.reversals });

      // ── Stage 7 — execute autonomous adapters (6a) ──────────────────────────
      // Apply the just-persisted decided actions to Meta (pause/unpause/scale).
      // Idempotent: only status='decided' rows are touched, flipped to
      // executed/failed; escalated rows are never executed. Self-correcting — a
      // scale_down that reverts a prior scale_up runs here.
      const execute = await step.run("execute", async () => {
        const t0 = Date.now();
        const r = await executeAutonomousActions(p, snapshotDate);
        return { ms: Date.now() - t0, ...r };
      });
      stages.push({
        name: "execute",
        status: "ok",
        ms: execute.ms,
        executed: execute.executed,
        failed: execute.failed,
        skipped: execute.skipped,
      });

      // ── Stage 8 — growth-allocation pass (growth-allocation-brain Phase 3) ──
      // Compose ONE cross-tool allocation decision (Meta vs Storefront) grounded in
      // the M2 blended CAC:LTV objective + each tool's marginal-leverage signal +
      // the active ad-spend ceiling. Stamp `director_activity` (director_function='growth')
      // and route `escalate_*` kinds to the CEO via `escalateDiagnosisToCeo` — the
      // % of autonomous reallocations is the M2 goal's success metric, so every pass
      // must leave one auditable row. Best-effort: a failure here must NEVER roll back
      // the just-executed stage-7 actions, so the stage is recorded as error + the run
      // still finishes complete.
      const allocation = await step.run("growth-allocation", async () => {
        const t0 = Date.now();
        try {
          const r = await runGrowthAllocationPass({
            workspaceId: workspace_id,
            adAccountId: ad_account_id,
            snapshotDate,
          });
          return {
            ms: Date.now() - t0,
            decision_kind: r.decision.kind,
            action_kind: r.actionKind,
            activity_recorded: r.activityRecorded,
            escalated: !!r.escalation?.emitted,
            escalation_kind: r.escalation?.escalationKind ?? null,
            error: null as string | null,
          };
        } catch (e) {
          return {
            ms: Date.now() - t0,
            decision_kind: null as string | null,
            action_kind: null as string | null,
            activity_recorded: false,
            escalated: false,
            escalation_kind: null as string | null,
            error: errText(e),
          };
        }
      });

      // ── Stage 9 — creative→outcome lineage (growth-adopt-creative-makers Phase 3) ──────
      // Stamp `attributed_creative_outcome` rows for every Director-promoted creative whose
      // publish has matured (≥ OUTCOME_MATURATION_DAYS) and whose meta_ad_id now has
      // attribution-window rows. Idempotent — a per-workspace pass per snapshot. Best-effort:
      // never aborts the run on a failure (the iteration loop continues regardless).
      const lineage = await step.run("creative-outcome-lineage", async () => {
        const t0 = Date.now();
        try {
          const admin = createAdminClient();
          const r = await attributeCreativeOutcomes(admin, {
            workspaceId: workspace_id,
            snapshotDate,
          });
          return { ms: Date.now() - t0, status: "ok" as const, ...r };
        } catch (err) {
          return {
            ms: Date.now() - t0,
            status: "error" as const,
            error: errText(err).slice(0, 200),
            attributed: 0,
            skipped_immature: 0,
            skipped_not_published: 0,
            skipped_no_attribution: 0,
            skipped_already_done: 0,
          };
        }
      });
      stages.push({
        name: "growth-allocation",
        status: allocation.error ? "error" : "ok",
        ms: allocation.ms,
        decision_kind: allocation.decision_kind,
        action_kind: allocation.action_kind,
        activity_recorded: allocation.activity_recorded,
        escalated: allocation.escalated,
        escalation_kind: allocation.escalation_kind,
        ...(allocation.error ? { error: allocation.error } : {}),
      });
      stages.push({
        name: "creative-outcome-lineage",
        status: lineage.status,
        ms: lineage.ms,
        attributed: lineage.attributed,
        skipped_immature: lineage.skipped_immature,
        skipped_not_published: lineage.skipped_not_published,
        skipped_no_attribution: lineage.skipped_no_attribution,
        skipped_already_done: lineage.skipped_already_done,
      });

      const counts = {
        scorecard_rows: scorecards.rows,
        variant_attribution_coverage: attribution.coverage,
        outcomes_reconciled: reconcile.outcomes_reconciled,
        actions_decided: decision.autonomous.actions.length,
        escalations: decision.autonomous.escalations.length,
        reversals: persisted.reversals,
        actions_executed: execute.executed,
        actions_failed: execute.failed,
        recommendations: decision.recommendations.persisted,
        spend_drift_objects: ingest.drift,
        growth_allocation_decision_kind: allocation.decision_kind,
        growth_allocation_action_kind: allocation.action_kind,
        growth_allocation_escalated: allocation.escalated,
        creative_outcomes_attributed: lineage.attributed,
      };

      await step.run("finish-run", () =>
        finishRun(runId, {
          status: "complete",
          snapshotDate,
          policy_active: decision.policy_active,
          policy_version_id: decision.policy_version_id,
          stages,
          counts,
        }),
      );

      console.log(
        `[meta-iteration-run] account ${ad_account_id} ${snapshotDate} ` +
          `policy_active=${decision.policy_active} actions=${counts.actions_decided} ` +
          `executed=${counts.actions_executed} failed=${counts.actions_failed} ` +
          `escalations=${counts.escalations} reversals=${counts.reversals} recs=${counts.recommendations}`,
        JSON.stringify(counts),
      );

      return { status: "complete", runId, snapshotDate, ...counts };
    } catch (err) {
      const message = errText(err);
      // Record the failure on the run row + alert the owners, then rethrow so
      // Inngest marks the run failed (and retries per the function config).
      await finishRun(runId, { status: "failed", stages, error: message });
      await notifyOpsAlert(workspace_id, {
        title: "Iteration engine daily run failed",
        lines: [`Account ${ad_account_id}`, `Stage reached: ${stages.length}`, message],
        severity: "warning",
      });
      throw err;
    }
  },
);

// ── meta/execute-recommendation — Phase 6b: execute one approved recommendation ──
// Fired by the review surface when Dylan approves an iteration_recommendations row.
// Turns it into a DRAFT/PAUSED Meta object via the native publish path (never a new
// live spend line). Idempotent: non-approved / already-dispatched rows short-circuit.
export const metaExecuteRecommendation = inngest.createFunction(
  {
    id: "meta-execute-recommendation",
    retries: 2,
    concurrency: [{ limit: 2, key: "event.data.workspace_id" }],
    triggers: [{ event: "meta/execute-recommendation" }],
  },
  async ({ event, step }) => {
    const { workspace_id, recommendation_id } = event.data as {
      workspace_id: string;
      recommendation_id: string;
    };
    const result = await step.run("execute", () =>
      executeRecommendation(workspace_id, recommendation_id),
    );
    console.log(
      `[meta-execute-recommendation] rec ${recommendation_id} → ${result.status}` +
        (result.reason ? ` (${result.reason})` : ""),
    );
    return { status: "complete", execution: result };
  },
);

// ── Daily cron: drive the full iteration pipeline for all active accounts ──
// Phase 5: fires meta/iteration-run (the consolidated, run-recorded pipeline)
// per account. The per-stage events (meta/sync-performance → … → decision-engine)
// remain for manual/stage-by-stage debugging.
export const metaPerformanceDailyCron = inngest.createFunction(
  {
    id: "meta-performance-daily",
    retries: 1,
    triggers: [{ cron: "30 11 * * *" }], // 6:30 AM Central — after meta-daily-sync (account spend rollup)
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const accounts = await step.run("find-active-accounts", async () => {
      const { data } = await admin
        .from("meta_ad_accounts")
        .select("id, workspace_id, meta_account_id")
        .eq("is_active", true);
      return data || [];
    });

    for (const acct of accounts) {
      await step.run(`trigger-run-${acct.id}`, async () => {
        await inngest.send({
          name: "meta/iteration-run",
          data: {
            workspace_id: acct.workspace_id,
            ad_account_id: acct.id,
            meta_account_id: acct.meta_account_id,
            trigger: "cron",
          },
        });
      });
    }

    const result = { triggered: accounts.length };

    // Control Tower: end-of-run heartbeat (control-tower-complete-coverage spec, Phase 1).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("meta-performance-daily", { ok: true, produced: result });
    });

    return result;
  },
);
