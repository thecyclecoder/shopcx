/**
 * fleet-spend-governor cron — the Phase-2 SUPERVISOR pass on the metered-cost proxy
 * ([[../specs/fleet-spend-governor]] Phase 2).
 *
 * Every 30 min, per build-console workspace, reads each effective [[../tables/fleet_budgets]]
 * row against the [[fleet-cost]] rollup. On a lane (kind) or function (owner_function) OVER
 * its ceiling, ESCALATES via [[../libraries/approval-router]] `resolveApproverLive("platform")`
 * (a live+autonomous director, else the CEO inbox) + writes one [[../tables/director_activity]]
 * row (`director_function='platform'`, `action_kind='budget_breach'`). Loop-guarded — one OPEN
 * breach notification per lane at a time; the next sweep re-surfaces it after dismissal if the
 * breach persists (mirrors the control-tower dedup-while-red pattern). NEVER auto-throttles
 * or pauses a lane (operational-rules § North star).
 *
 * Itself a [[../libraries/control-tower|monitored loop]]: it beats at the end so a dead governor
 * is visible on the Control Tower (MONITORED_LOOPS id `fleet-spend-governor`).
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { runFleetSpendGovernor, resolveFleetSpendApprover } from "@/lib/fleet-spend-governor";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const fleetSpendGovernorCron = inngest.createFunction(
  {
    id: "fleet-spend-governor",
    name: "Fleet spend governor — escalate lanes / functions over their fleet_budgets ceiling",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "10,40 * * * *" }], // every ~30 min, offset from the :00/:15 crons
  },
  async ({ step }) => {
    const startedAt = Date.now();

    const result = await step.run("sweep-budgets-and-escalate", async () => {
      const admin = createAdminClient();
      // Build-console workspaces — any workspace that uses the agent-jobs queue (mirrors
      // spec-drift-reconcile / platform-director-cron).
      const { data: wsRows } = await admin.from("agent_jobs").select("workspace_id").limit(1000);
      const workspaceIds = Array.from(new Set((wsRows || []).map((r) => r.workspace_id as string)));
      if (!workspaceIds.length) {
        return { workspaces: 0, evaluated: 0, breaches: 0, escalations: 0, reSurfaced: 0, routedTo: null as string | null };
      }

      let evaluated = 0;
      let breaches = 0;
      let escalations = 0;
      let reSurfaced = 0;
      for (const workspaceId of workspaceIds) {
        try {
          const r = await runFleetSpendGovernor({ workspaceId });
          evaluated += r.evaluated;
          breaches += r.breaches;
          escalations += r.escalations;
          reSurfaced += r.reSurfaced;
        } catch (e) {
          console.error(`[fleet-spend-governor] sweep failed ws=${workspaceId}:`, e instanceof Error ? e.message : e);
        }
      }
      // Resolve once at the end so the heartbeat carries "routed_to" for the dashboard ribbon.
      const routedTo = await resolveFleetSpendApprover().catch(() => null);
      return { workspaces: workspaceIds.length, evaluated, breaches, escalations, reSurfaced, routedTo };
    });

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("fleet-spend-governor", {
        ok: true,
        produced: result,
        detail: `${result.breaches} breach(es) · ${result.escalations} new · ${result.reSurfaced} re-surfaced · routed→${result.routedTo ?? "(none)"}`,
        durationMs: Date.now() - startedAt,
      });
    });

    return result;
  },
);
