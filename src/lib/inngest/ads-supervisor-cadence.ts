/**
 * ads-supervisor-cadence — the 3-hourly cron + per-workspace sweep that enqueues the
 * [[../libraries/ads-supervisor]] pass ([[../specs/growth-ads-supervisor-3h-agent]]
 * Phase 1). The pass supervises Bianca (the [[../libraries/media-buyer-agent]]) + Dahlia
 * (the [[../libraries/creative-agent]]) — audits crown/kill state, checks whether Bianca
 * acted, checks Dahlia's bins + competitor-seeded quality, QAs live-ad copy, autonomously
 * authors fix-specs, and posts one digest to #director-growth-max. It NEVER moves spend
 * itself (north-star: supervisable autonomy — the supervisor never becomes a
 * proxy-optimizer).
 *
 * The cron (`ads-supervisor-cadence`, every 3h at :14 UTC — the 14-min offset stays clear
 * of the daily media-buyer / ad-creative cadence crons that fire on `:00`) SELECTs distinct
 * `workspace_id` from [[../tables/media_buyer_test_cohorts]] where `is_active=true` and
 * fans out one `growth/ads-supervisor-sweep` event per workspace. Each sweep inserts
 * EXACTLY ONE workspace-scoped [[../tables/agent_jobs]] row `kind='ads-supervisor'` IF no
 * NOT-YET-TERMINAL `kind='ads-supervisor'` job already exists for the workspace (unbounded
 * dedup — at 3h cadence a still-running prior pass covers the slot). A same-tick re-fire
 * of the cron is a safe no-op.
 *
 * Self-monitoring: emits an `ads-supervisor-cadence` cron heartbeat via
 * [[../libraries/control-tower]] `emitCronHeartbeat` at the end. The MONITORED_LOOPS row
 * lives in `src/lib/control-tower/registry.ts` with owner `growth` + a 4h liveness window
 * (3h × 1.2 = 3.6h clears the jitter grace; 4h leaves comfortable slack) — a dead cadence
 * shows as a stale cron tile on the Control Tower.
 *
 * Node-completeness trio (owner / switch / heartbeat — CLAUDE.md hard rule): owner is
 * `growth` on both the cron and the `ads-supervisor` agent-kind (in
 * `src/lib/control-tower/node-registry.ts` `KIND_OWNER_FALLBACK`); kill-switch coverage
 * comes from the ancestor `growth` department row in [[../tables/kill_switches]] (the
 * cascade in [[../libraries/kill-switch-resolver]] resolves any child owned by growth);
 * heartbeat is emitted here (cron) + in the box lane (`emitAgentHeartbeat('ads-supervisor')`).
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { ACTIVE_MEDIA_BUYER_JOB_STATUSES } from "@/lib/inngest/media-buyer-cadence";

type Admin = ReturnType<typeof createAdminClient>;

/** Stable per-workspace `agent_jobs.spec_slug`. The column is NOT NULL, so an omitted value
 * blocks the insert. One slug per workspace keeps the Roadmap rollups useful and gives the
 * supervisor's job a durable subject on the dashboard. */
export function adsSupervisorSpecSlug(): string {
  return "ads-supervisor:workspace";
}

interface AgentJobRow {
  id: string;
  status: string;
}

export interface DispatchAdsSupervisorResult {
  evaluated: number;
  dispatched: number;
}

/**
 * PURE per-workspace sweep — if the workspace has ≥1 active [[../tables/media_buyer_test_cohorts]]
 * row AND no not-yet-terminal `kind='ads-supervisor'` job is already open for the workspace,
 * insert ONE workspace-scoped [[../tables/agent_jobs]] row (`spec_slug='ads-supervisor:workspace'`).
 *
 * Returns `{evaluated, dispatched}` — `evaluated` is 1 when the workspace has ≥1 active
 * cohort (else 0); `dispatched` is 0 or 1.
 *
 * Extracted from the Inngest handler so it's testable without `step.run`.
 */
export async function dispatchAdsSupervisor(
  admin: Admin,
  workspaceId: string,
): Promise<DispatchAdsSupervisorResult> {
  const { data: cohorts, error: cohErr } = await admin
    .from("media_buyer_test_cohorts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .limit(1);
  if (cohErr) throw new Error(`media_buyer_test_cohorts read failed: ${cohErr.message}`);
  if (!cohorts || cohorts.length === 0) return { evaluated: 0, dispatched: 0 };

  const { data: openJobs, error: jobsErr } = await admin
    .from("agent_jobs")
    .select("id, status")
    .eq("workspace_id", workspaceId)
    .eq("kind", "ads-supervisor");
  if (jobsErr) throw new Error(`agent_jobs read failed: ${jobsErr.message}`);
  const alreadyOpen = ((openJobs || []) as AgentJobRow[]).some((j) =>
    ACTIVE_MEDIA_BUYER_JOB_STATUSES.has(j.status),
  );
  if (alreadyOpen) return { evaluated: 1, dispatched: 0 };

  const { error: insErr } = await admin.from("agent_jobs").insert({
    workspace_id: workspaceId,
    spec_slug: adsSupervisorSpecSlug(),
    kind: "ads-supervisor",
    instructions: JSON.stringify({ trigger: "cron" }),
  });
  if (insErr) {
    console.error(`[ads-supervisor-cadence] insert failed ws=${workspaceId}: ${insErr.message}`);
    return { evaluated: 1, dispatched: 0 };
  }
  return { evaluated: 1, dispatched: 1 };
}

/** Distinct workspace_ids with ≥1 active cohort row — the cron's fan-out set. */
async function findCadenceWorkspaces(admin: Admin): Promise<string[]> {
  const { data, error } = await admin
    .from("media_buyer_test_cohorts")
    .select("workspace_id")
    .eq("is_active", true);
  if (error) throw new Error(`media_buyer_test_cohorts read failed: ${error.message}`);
  return [...new Set(((data || []) as Array<{ workspace_id: string }>).map((r) => r.workspace_id))];
}

export const adsSupervisorCadenceCron = inngest.createFunction(
  {
    id: "ads-supervisor-cadence",
    name: "Growth — ads supervisor 3h cadence",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "14 */3 * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const workspaceIds = await step.run("find-cadence-workspaces", async () => {
      return findCadenceWorkspaces(admin);
    });

    for (const workspaceId of workspaceIds) {
      await step.run(`fan-out-${workspaceId}`, async () => {
        await inngest.send({
          name: "growth/ads-supervisor-sweep",
          data: { workspace_id: workspaceId, trigger: "cron" },
        });
      });
    }

    const result = { evaluated: workspaceIds.length, dispatched: workspaceIds.length };
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("ads-supervisor-cadence", {
        ok: true,
        produced: result,
        detail: `fanned out ${result.dispatched} workspace(s)`,
      });
    });
    return result;
  },
);

export const adsSupervisorCadenceSweep = inngest.createFunction(
  {
    id: "ads-supervisor-cadence-sweep",
    name: "Growth — ads supervisor per-workspace sweep",
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "growth/ads-supervisor-sweep" }],
  },
  async ({ event, step }) => {
    const { workspace_id } = event.data as { workspace_id: string; trigger?: "cron" | "manual" };
    const result = await step.run("dispatch-ads-supervisor-job", async () => {
      const admin = createAdminClient();
      return dispatchAdsSupervisor(admin, workspace_id);
    });
    console.log(
      `[ads-supervisor-cadence] ws=${workspace_id} evaluated=${result.evaluated} dispatched=${result.dispatched}`,
    );
    return { status: "complete", ...result };
  },
);
