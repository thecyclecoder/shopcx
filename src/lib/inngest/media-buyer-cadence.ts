/**
 * media-buyer-cadence — the daily cron + per-workspace event handler that enqueues
 * the Media Buyer agent's pass across every ACTIVE [[../tables/media_buyer_test_cohorts]]
 * row ([[../specs/media-buyer-daily-cadence-cron]] Phase 1 — the missing daily-cadence
 * piece of the [[../goals/autonomous-media-buyer-supervision]] M2 "Shadow mode
 * (read-only)" milestone).
 *
 * The cron (`media-buyer-cadence-cron`, `0 13 * * *` UTC) SELECTs distinct
 * `workspace_id` from [[../tables/media_buyer_test_cohorts]] where `is_active=true`
 * and fans out one `growth/media-buyer-cadence-sweep` event per workspace. Each sweep
 * inserts EXACTLY ONE workspace-scoped [[../tables/agent_jobs]] row `kind='media-buyer'`
 * (`instructions.meta_ad_account_id = null`), and the [[../libraries/media-buyer-agent]]
 * runner + the box worker's media-buyer lane fan out over every connected
 * [[../tables/meta_ad_accounts]] row × the account's active per-product cohorts.
 * ONE job → ONE run → ONE consolidated Growth-Director digest per workspace per pass.
 *
 * (Pre-Phase-2 shape — media-buyer-digest-consolidate-product-names-suppress-noop Phase 2 —
 * inserted one row PER active cohort, which under the per-product cohort split produced
 * up to 6 Slack messages per pass. The account × product fan-out is now the LANE's job,
 * not the DISPATCHER's — the per-cohort job split was redundant.)
 *
 * Idempotency: a sweep skips a workspace that already has a NOT-YET-TERMINAL
 * `kind='media-buyer'` [[../tables/agent_jobs]] row created since the current UTC day
 * start (regardless of the row's per-account `instructions` shape, so legacy
 * per-account rows from before Phase 2 also count as coverage during rollout). So a
 * second invocation on the same UTC day dispatches ZERO new jobs, and a manual same-day
 * re-fire of the cron is a safe no-op.
 *
 * Self-monitoring: the cron emits its own `media-buyer-cadence-cron` heartbeat at the
 * end via [[../libraries/control-tower]] `emitCronHeartbeat` (registered in
 * `src/lib/control-tower/registry.ts` with owner `growth`) — so a dead cadence shows
 * as a stale cron tile on the Control Tower.
 *
 * Shadow-default: under the [[../goals/autonomous-media-buyer-supervision]] M2 policy,
 * the freshly-enqueued run goes through the [[../libraries/media-buyer-agent]] shadow
 * branch (no Meta writes; publishes are proposed to the shadow-review inbox instead)
 * — so this cron is safe to enable BEFORE any workspace flips the policy live.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Active `agent_jobs.status` values — a job in one of these states is still
 * consuming the workspace-account cadence slot for today. Anything else is
 * terminal (or dismissed / held / needs_attention) and doesn't block a new
 * dispatch. Kept broad and in ONE place so the sweep and any future caller
 * agree on "unfinished".
 */
export const ACTIVE_MEDIA_BUYER_JOB_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "claimed",
  "building",
  "needs_input",
  "needs_approval",
  "queued_resume",
  "blocked_on_usage",
]);

/** ISO string of the current UTC day's midnight — the "for today" idempotency window. */
export function utcDayStartIso(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return d.toISOString();
}

/**
 * Stable per-cadence-slot `agent_jobs.spec_slug` for a media-buyer job. The column is
 * `NOT NULL`, so an omitted value blocks the insert (the 2026-07-11 outage). One slug
 * per workspace-account slot keeps `agent_jobs_slug_idx (workspace_id, spec_slug, ...)`
 * useful for the Roadmap rollups: `media-buyer:<account-id>` for a per-account cohort,
 * and `media-buyer:workspace` for a workspace-wide `meta_ad_account_id IS NULL` cohort.
 */
export function mediaBuyerSpecSlug(account: string | null): string {
  return account ? `media-buyer:${account}` : "media-buyer:workspace";
}

interface CohortRow {
  id: string;
  workspace_id: string;
  meta_ad_account_id: string | null;
}

interface AgentJobRow {
  id: string;
  status: string;
}

export interface DispatchMediaBuyerCadenceResult {
  evaluated: number;
  dispatched: number;
}

/**
 * The PURE per-workspace sweep — resolves the workspace's active cohorts, and if
 * ≥1 exists AND no unfinished workspace-scoped `kind='media-buyer'` job for the
 * workspace was already created today, inserts ONE workspace-scoped `agent_jobs`
 * row (`instructions = { meta_ad_account_id: null }`, `spec_slug =
 * 'media-buyer:workspace'`). The box-worker lane's account × per-product cohort
 * fan-out downstream now covers every cohort under a single job → single
 * consolidated digest — this is
 * media-buyer-digest-consolidate-product-names-suppress-noop Phase 2 (approach (a)
 * in the spec: collapse the redundant per-cohort dispatcher fan-out; the lane
 * already fans out).
 *
 * Preserves the dormant-heartbeat guarantee: a workspace with cohorts but with
 * some accounts having zero active cohort still runs one pass per account so the
 * audit row lands — that invariant lives INSIDE the lane
 * (`runMediaBuyerLoopForAccount`), so a single workspace-scoped job still fires
 * one pass per connected account.
 *
 * Returns `{evaluated, dispatched}` — `evaluated` counts active cohort rows so
 * the cron log preserves the pre-Phase-2 signal; `dispatched` is 0 or 1.
 *
 * Extracted from the Inngest handler so it's testable without `step.run`.
 */
export async function dispatchMediaBuyerCadence(
  admin: Admin,
  workspaceId: string,
  now: Date = new Date(),
): Promise<DispatchMediaBuyerCadenceResult> {
  const { data: cohorts, error: cohErr } = await admin
    .from("media_buyer_test_cohorts")
    .select("id, workspace_id, meta_ad_account_id")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);
  if (cohErr) throw new Error(`media_buyer_test_cohorts read failed: ${cohErr.message}`);
  const rows = (cohorts || []) as CohortRow[];
  if (!rows.length) return { evaluated: 0, dispatched: 0 };

  const sinceIso = utcDayStartIso(now);
  const { data: todaysJobs, error: jobsErr } = await admin
    .from("agent_jobs")
    .select("id, status")
    .eq("workspace_id", workspaceId)
    .eq("kind", "media-buyer")
    .gte("created_at", sinceIso);
  if (jobsErr) throw new Error(`agent_jobs read failed: ${jobsErr.message}`);

  // Phase 2 coverage: ANY unfinished media-buyer job for this workspace today
  // covers the workspace slot — the lane's fan-out downstream handles every
  // account × product. Pre-Phase-2 rows (per-account) also count as coverage
  // during rollout, since the lane will still discover this workspace's accounts
  // and cohorts under whichever job is already in flight.
  const alreadyCoveredToday = ((todaysJobs || []) as AgentJobRow[]).some((j) =>
    ACTIVE_MEDIA_BUYER_JOB_STATUSES.has(j.status),
  );
  if (alreadyCoveredToday) {
    return { evaluated: rows.length, dispatched: 0 };
  }

  const { error: insErr } = await admin.from("agent_jobs").insert({
    workspace_id: workspaceId,
    spec_slug: mediaBuyerSpecSlug(null),
    kind: "media-buyer",
    instructions: JSON.stringify({ meta_ad_account_id: null }),
  });
  if (insErr) {
    console.error(
      `[media-buyer-cadence] insert failed ws=${workspaceId}: ${insErr.message}`,
    );
    return { evaluated: rows.length, dispatched: 0 };
  }
  return { evaluated: rows.length, dispatched: 1 };
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

export const mediaBuyerCadenceCron = inngest.createFunction(
  {
    id: "media-buyer-cadence-cron",
    name: "Growth — media buyer daily cadence",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 13 * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const workspaceIds = await step.run("find-cadence-workspaces", async () => {
      return findCadenceWorkspaces(admin);
    });

    for (const workspaceId of workspaceIds) {
      await step.run(`fan-out-${workspaceId}`, async () => {
        await inngest.send({
          name: "growth/media-buyer-cadence-sweep",
          data: { workspace_id: workspaceId, trigger: "cron" },
        });
      });
    }

    const result = { evaluated: workspaceIds.length, dispatched: workspaceIds.length };
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("media-buyer-cadence-cron", {
        ok: true,
        produced: result,
        detail: `fanned out ${result.dispatched} workspace(s)`,
      });
    });
    return result;
  },
);

export const mediaBuyerCadenceSweep = inngest.createFunction(
  {
    id: "media-buyer-cadence-sweep",
    name: "Growth — media buyer per-workspace cadence sweep",
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "growth/media-buyer-cadence-sweep" }],
  },
  async ({ event, step }) => {
    const { workspace_id } = event.data as { workspace_id: string; trigger?: "cron" | "manual" };
    const result = await step.run("dispatch-media-buyer-jobs", async () => {
      const admin = createAdminClient();
      return dispatchMediaBuyerCadence(admin, workspace_id);
    });
    console.log(
      `[media-buyer-cadence] ws=${workspace_id} evaluated=${result.evaluated} dispatched=${result.dispatched}`,
    );
    return { status: "complete", ...result };
  },
);
