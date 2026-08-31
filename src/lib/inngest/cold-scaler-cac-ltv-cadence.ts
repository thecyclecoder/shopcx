/**
 * cold-scaler-cac-ltv-cadence — the weekly cron + per-workspace event handler
 * that enqueues the [[../media-buyer/cold-scaler-cac-ltv-sensor]] box lane
 * ([[../../../docs/brain/specs/cold-scaler-arming-decides-on-evidence-not-absence]]
 * Phase 2 — the missing dispatcher for the cold-scaler CAC:LTV arm of the
 * cold-scaler arming gate). `runColdScalerCacLtvSensor` is fully written but
 * appeared only inside a comment — no cron ever enqueued it, so
 * [[../../../docs/brain/tables/media_buyer_cold_scaler_cac_ltv_snapshots]]
 * stayed empty and the arming gate had no CAC:LTV ratio to compare to its
 * target. The sensor snapshot is keyed by ISO week, so a weekly cadence
 * matches the snapshot grain — a same-week re-fire updates in place.
 *
 * The cron (`cold-scaler-cac-ltv-cron`, `0 12 * * 1` UTC — Monday 12:00, the
 * start of a fresh ISO week) SELECTs distinct `workspace_id` from
 * [[../../../docs/brain/tables/media_buyer_cold_scaler_cohorts]] where
 * `is_active=true` and fans out one `growth/cold-scaler-cac-ltv-sweep` event
 * per workspace. Each sweep inserts EXACTLY ONE workspace-scoped
 * [[../../../docs/brain/tables/agent_jobs]] row `kind='cold-scaler-cac-ltv'`
 * IF no other `kind='cold-scaler-cac-ltv'` job for this workspace has been
 * created in the last 7 days — the idempotency-within-the-week guard the
 * spec asks for. A same-week re-fire of the cron (manual or Inngest retry)
 * is a safe no-op; the sensor itself is compare-and-set on (workspace,
 * cohort, iso_week) so even a second job would upsert the SAME snapshot row.
 *
 * Self-monitoring: emits a `cold-scaler-cac-ltv-cron` heartbeat via
 * [[../control-tower/heartbeat]] `emitCronHeartbeat` at the end. The
 * MONITORED_LOOPS row lives in `src/lib/control-tower/registry.ts` with owner
 * `growth` + a 9d liveness window (weekly × 1.28 ≈ 9d clears the jitter grace
 * per `assertRegistryInvariants`) — a dead sensor shows as a stale cron tile
 * on the Control Tower instead of silently starving the gate again.
 *
 * Node-completeness trio (owner / switch / heartbeat — CLAUDE.md hard rule):
 * owner is `growth` on both the cron (MONITORED_LOOPS) and the
 * `cold-scaler-cac-ltv` agent-kind ([[../control-tower/node-registry]]
 * `KIND_OWNER_FALLBACK`); kill-switch coverage comes from the ancestor
 * `growth` department row in [[../../../docs/brain/tables/kill_switches]]
 * (the cascade in [[../control-tower/kill-switch-resolver]] resolves any
 * child owned by growth); heartbeat is emitted here (cron) + at the end of
 * the box lane's dispatch.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Stable workspace-scoped `agent_jobs.spec_slug` for the cold-scaler CAC:LTV
 * sensor. The column is NOT NULL (supabase/migrations/20260618120000_agent_jobs.sql),
 * so an omitted value blocks the insert. One workspace runs one sensor pass
 * per cron tick (which fans over the workspace's active scaler cohorts inside
 * the box lane), so a single per-workspace slug is the durable bucket for the
 * `agent_jobs_slug_idx (workspace_id, spec_slug, ...)` Roadmap rollups (mirrors
 * [[./sensor-trust-probe-cadence]] `SENSOR_TRUST_PROBE_SPEC_SLUG`).
 */
export const COLD_SCALER_CAC_LTV_SPEC_SLUG = "cold-scaler-cac-ltv:workspace";

/** Returns the stable slug — helper form parallel to
 *  [[./sensor-trust-probe-cadence]] `sensorTrustProbeSpecSlug`. */
export function coldScalerCacLtvSpecSlug(): string {
  return COLD_SCALER_CAC_LTV_SPEC_SLUG;
}

/** Idempotency window — a sweep skips insert if a same-kind job for this
 *  workspace has been created within this window. Sized to the cron cadence
 *  (weekly = 7d) so a same-week manual/retry re-fire is a no-op but a
 *  legitimate next-week run is not. */
export const COLD_SCALER_CAC_LTV_IDEMPOTENCY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface AgentJobRow {
  id: string;
  created_at: string;
}

export interface DispatchColdScalerCacLtvResult {
  evaluated: number;
  dispatched: number;
}

/**
 * PURE per-workspace sweep — if the workspace has ≥1 active
 * [[../../../docs/brain/tables/media_buyer_cold_scaler_cohorts]] row AND no
 * `kind='cold-scaler-cac-ltv'` job has been created for this workspace in the
 * last `COLD_SCALER_CAC_LTV_IDEMPOTENCY_WINDOW_MS`, insert ONE workspace-scoped
 * `agent_jobs` row (`spec_slug='cold-scaler-cac-ltv:workspace'`).
 *
 * Returns `{evaluated, dispatched}` — `evaluated` is 1 when the workspace has
 * ≥1 active scaler cohort (else 0); `dispatched` is 0 or 1.
 *
 * Extracted from the Inngest handler so it's testable without `step.run`.
 */
export async function dispatchColdScalerCacLtv(
  admin: Admin,
  workspaceId: string,
  nowMs: number = Date.now(),
): Promise<DispatchColdScalerCacLtvResult> {
  const { data: cohorts, error: cohErr } = await admin
    .from("media_buyer_cold_scaler_cohorts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .limit(1);
  if (cohErr) {
    throw new Error(`media_buyer_cold_scaler_cohorts read failed: ${cohErr.message}`);
  }
  if (!cohorts || cohorts.length === 0) return { evaluated: 0, dispatched: 0 };

  const sinceIso = new Date(
    nowMs - COLD_SCALER_CAC_LTV_IDEMPOTENCY_WINDOW_MS,
  ).toISOString();
  const { data: recent, error: jobsErr } = await admin
    .from("agent_jobs")
    .select("id, created_at")
    .eq("workspace_id", workspaceId)
    .eq("kind", "cold-scaler-cac-ltv")
    .gte("created_at", sinceIso)
    .limit(1);
  if (jobsErr) throw new Error(`agent_jobs read failed: ${jobsErr.message}`);
  if ((recent as AgentJobRow[] | null | undefined)?.length) {
    return { evaluated: 1, dispatched: 0 };
  }

  const { error: insErr } = await admin.from("agent_jobs").insert({
    workspace_id: workspaceId,
    spec_slug: coldScalerCacLtvSpecSlug(),
    kind: "cold-scaler-cac-ltv",
    instructions: JSON.stringify({ trigger: "cron" }),
  });
  if (insErr) throw new Error(`agent_jobs insert failed: ${insErr.message}`);
  return { evaluated: 1, dispatched: 1 };
}

/** Distinct workspace_ids with ≥1 active scaler cohort row — the cron's
 *  fan-out set. Mirrors [[./sensor-trust-probe-cadence]]
 *  `findSensorTrustProbeWorkspaces` shape. */
export async function findColdScalerCacLtvWorkspaces(admin: Admin): Promise<string[]> {
  const { data, error } = await admin
    .from("media_buyer_cold_scaler_cohorts")
    .select("workspace_id")
    .eq("is_active", true);
  if (error) {
    throw new Error(`media_buyer_cold_scaler_cohorts read failed: ${error.message}`);
  }
  return [
    ...new Set(((data || []) as Array<{ workspace_id: string }>).map((r) => r.workspace_id)),
  ];
}

export const coldScalerCacLtvCron = inngest.createFunction(
  {
    id: "cold-scaler-cac-ltv-cron",
    name: "Growth — cold-scaler CAC:LTV weekly sweep",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 12 * * 1" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const workspaceIds = await step.run("find-scaler-cohort-workspaces", async () => {
      return findColdScalerCacLtvWorkspaces(admin);
    });

    for (const workspaceId of workspaceIds) {
      await step.run(`fan-out-${workspaceId}`, async () => {
        await inngest.send({
          name: "growth/cold-scaler-cac-ltv-sweep",
          data: { workspace_id: workspaceId, trigger: "cron" },
        });
      });
    }

    const result = { workspaces: workspaceIds.length };
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("cold-scaler-cac-ltv-cron", {
        ok: true,
        produced: result,
        detail: `fanned out ${result.workspaces} workspace(s)`,
      });
    });
    return result;
  },
);

export const coldScalerCacLtvSweep = inngest.createFunction(
  {
    id: "cold-scaler-cac-ltv-sweep",
    name: "Growth — cold-scaler CAC:LTV per-workspace sweep",
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "growth/cold-scaler-cac-ltv-sweep" }],
  },
  async ({ event, step }) => {
    const { workspace_id } = event.data as {
      workspace_id: string;
      trigger?: "cron" | "manual";
    };
    const result = await step.run("dispatch-cold-scaler-cac-ltv-job", async () => {
      const admin = createAdminClient();
      return dispatchColdScalerCacLtv(admin, workspace_id);
    });
    console.log(
      `[cold-scaler-cac-ltv-cadence] ws=${workspace_id} evaluated=${result.evaluated} dispatched=${result.dispatched}`,
    );
    return { status: "complete", ...result };
  },
);
