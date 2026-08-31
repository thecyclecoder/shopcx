/**
 * sensor-trust-probe-cadence — the daily cron + per-workspace event handler that
 * enqueues the [[../media-buyer/sensor-trust-probe]] lane
 * ([[../../../docs/brain/specs/cold-scaler-arming-decides-on-evidence-not-absence]]
 * Phase 1 — the missing dispatcher for the sensor-trust arm of the cold-scaler
 * arming gate). `runSensorTrustProbe` already exists and already has a box lane
 * (`scripts/builder-worker.ts` `runSensorTrustProbeJob`) — nothing was ever
 * enqueueing it, so [[../../../docs/brain/tables/media_buyer_sensor_trust]]
 * stayed empty and the arming gate's trust precondition could never be satisfied.
 *
 * The cron (`sensor-trust-probe-cron`, `0 12 * * *` UTC) SELECTs distinct
 * `workspace_id` from [[../../../docs/brain/tables/media_buyer_test_cohorts]]
 * where `is_active=true` and fans out one `growth/sensor-trust-probe-sweep`
 * event per workspace. Each sweep inserts EXACTLY ONE workspace-scoped
 * [[../../../docs/brain/tables/agent_jobs]] row `kind='sensor-trust-probe'` IF
 * no other `kind='sensor-trust-probe'` job for this workspace has been created
 * in the last 24h — the idempotency-within-a-day guard the spec asks for. A
 * same-day re-fire of the cron (manual or Inngest retry) is a safe no-op.
 *
 * Self-monitoring: emits a `sensor-trust-probe-cron` heartbeat via
 * [[../control-tower/heartbeat]] `emitCronHeartbeat` at the end. The
 * MONITORED_LOOPS row lives in `src/lib/control-tower/registry.ts` with owner
 * `growth` + a 30h liveness window (daily × 1.2 clears the jitter grace) — a
 * dead sensor shows as a stale cron tile on the Control Tower instead of
 * silently starving the gate again.
 *
 * Node-completeness trio (owner / switch / heartbeat — CLAUDE.md hard rule):
 * owner is `growth` on both the cron (MONITORED_LOOPS) and the
 * `sensor-trust-probe` agent-kind ([[../control-tower/node-registry]]);
 * kill-switch coverage comes from the ancestor `growth` department row in
 * [[../../../docs/brain/tables/kill_switches]] (the cascade in
 * [[../control-tower/kill-switch-resolver]] resolves any child owned by
 * growth); heartbeat is emitted here (cron) + at the end of the box lane.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Stable workspace-scoped `agent_jobs.spec_slug` for the sensor-trust probe.
 * The column is NOT NULL (supabase/migrations/20260618120000_agent_jobs.sql), so
 * an omitted value blocks the insert. One workspace runs one probe per cron
 * tick, so a single per-workspace slug is the durable bucket for the
 * `agent_jobs_slug_idx (workspace_id, spec_slug, ...)` Roadmap rollups
 * (mirrors [[./media-buyer-grade]] `MEDIA_BUYER_GRADE_SPEC_SLUG`).
 */
export const SENSOR_TRUST_PROBE_SPEC_SLUG = "sensor-trust-probe:workspace";

/** Returns the stable slug — helper form parallel to [[./media-buyer-grade]] `mediaBuyerGradeSpecSlug`. */
export function sensorTrustProbeSpecSlug(): string {
  return SENSOR_TRUST_PROBE_SPEC_SLUG;
}

/** Idempotency window — a sweep skips insert if a same-kind job for this
 *  workspace has been created within this window. Sized to the cron cadence
 *  (daily) so a same-day manual/retry re-fire is a no-op but a legitimate
 *  next-day run is not. */
export const SENSOR_TRUST_PROBE_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

interface AgentJobRow {
  id: string;
  created_at: string;
}

export interface DispatchSensorTrustProbeResult {
  evaluated: number;
  dispatched: number;
}

/**
 * PURE per-workspace sweep — if the workspace has ≥1 active
 * [[../../../docs/brain/tables/media_buyer_test_cohorts]] row AND no
 * `kind='sensor-trust-probe'` job has been created for this workspace in the
 * last `SENSOR_TRUST_PROBE_IDEMPOTENCY_WINDOW_MS`, insert ONE workspace-scoped
 * `agent_jobs` row (`spec_slug='sensor-trust-probe:workspace'`).
 *
 * Returns `{evaluated, dispatched}` — `evaluated` is 1 when the workspace has
 * ≥1 active cohort (else 0); `dispatched` is 0 or 1.
 *
 * Extracted from the Inngest handler so it's testable without `step.run`.
 */
export async function dispatchSensorTrustProbe(
  admin: Admin,
  workspaceId: string,
  nowMs: number = Date.now(),
): Promise<DispatchSensorTrustProbeResult> {
  const { data: cohorts, error: cohErr } = await admin
    .from("media_buyer_test_cohorts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .limit(1);
  if (cohErr) throw new Error(`media_buyer_test_cohorts read failed: ${cohErr.message}`);
  if (!cohorts || cohorts.length === 0) return { evaluated: 0, dispatched: 0 };

  const sinceIso = new Date(nowMs - SENSOR_TRUST_PROBE_IDEMPOTENCY_WINDOW_MS).toISOString();
  const { data: recent, error: jobsErr } = await admin
    .from("agent_jobs")
    .select("id, created_at")
    .eq("workspace_id", workspaceId)
    .eq("kind", "sensor-trust-probe")
    .gte("created_at", sinceIso)
    .limit(1);
  if (jobsErr) throw new Error(`agent_jobs read failed: ${jobsErr.message}`);
  if ((recent as AgentJobRow[] | null | undefined)?.length) {
    return { evaluated: 1, dispatched: 0 };
  }

  const { error: insErr } = await admin.from("agent_jobs").insert({
    workspace_id: workspaceId,
    spec_slug: sensorTrustProbeSpecSlug(),
    kind: "sensor-trust-probe",
    instructions: JSON.stringify({ trigger: "cron" }),
  });
  if (insErr) throw new Error(`agent_jobs insert failed: ${insErr.message}`);
  return { evaluated: 1, dispatched: 1 };
}

/** Distinct workspace_ids with ≥1 active cohort row — the cron's fan-out set. */
export async function findSensorTrustProbeWorkspaces(admin: Admin): Promise<string[]> {
  const { data, error } = await admin
    .from("media_buyer_test_cohorts")
    .select("workspace_id")
    .eq("is_active", true);
  if (error) throw new Error(`media_buyer_test_cohorts read failed: ${error.message}`);
  return [...new Set(((data || []) as Array<{ workspace_id: string }>).map((r) => r.workspace_id))];
}

export const sensorTrustProbeCron = inngest.createFunction(
  {
    id: "sensor-trust-probe-cron",
    name: "Growth — sensor-trust probe daily sweep",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 12 * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const workspaceIds = await step.run("find-cohort-workspaces", async () => {
      return findSensorTrustProbeWorkspaces(admin);
    });

    for (const workspaceId of workspaceIds) {
      await step.run(`fan-out-${workspaceId}`, async () => {
        await inngest.send({
          name: "growth/sensor-trust-probe-sweep",
          data: { workspace_id: workspaceId, trigger: "cron" },
        });
      });
    }

    const result = { workspaces: workspaceIds.length };
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("sensor-trust-probe-cron", {
        ok: true,
        produced: result,
        detail: `fanned out ${result.workspaces} workspace(s)`,
      });
    });
    return result;
  },
);

export const sensorTrustProbeSweep = inngest.createFunction(
  {
    id: "sensor-trust-probe-sweep",
    name: "Growth — sensor-trust probe per-workspace sweep",
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "growth/sensor-trust-probe-sweep" }],
  },
  async ({ event, step }) => {
    const { workspace_id } = event.data as {
      workspace_id: string;
      trigger?: "cron" | "manual";
    };
    const result = await step.run("dispatch-sensor-trust-probe-job", async () => {
      const admin = createAdminClient();
      return dispatchSensorTrustProbe(admin, workspace_id);
    });
    console.log(
      `[sensor-trust-probe-cadence] ws=${workspace_id} evaluated=${result.evaluated} dispatched=${result.dispatched}`,
    );
    return { status: "complete", ...result };
  },
);
