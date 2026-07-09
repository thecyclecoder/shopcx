/**
 * media-buyer-grade — the daily cron + per-workspace event handler that dispatches
 * the [[../libraries/media-buyer-grader]] deterministic grader over concluded Media
 * Buyer actions ([[../specs/media-buyer-grade-daily-cron]] Phase 1 — the missing
 * "grading" piece of the [[../goals/autonomous-media-buyer-supervision]] M4
 * "Graded + self-correcting" milestone).
 *
 * The cron (`media-buyer-grade-cron`, `0 14 * * *` UTC) SELECTs every ungraded
 * [[../tables/director_activity]] row whose `action_kind` is in
 * [[../libraries/media-buyer-grader]] `GRADEABLE_ACTION_KINDS` and whose `created_at`
 * is older than the settled window (`REALIZED_WINDOW_MIN_DAYS` = 3d) — cross-checked
 * against [[../tables/media_buyer_action_grades]] via `director_activity_id` so any
 * already-graded row drops out — then fans out one `growth/media-buyer-grade-sweep`
 * event per DISTINCT workspace with ≥1 remaining ungraded settled action. A workspace
 * whose newest action is only 2d old contributes nothing (the settled-window guard).
 *
 * Each sweep inserts ONE [[../tables/agent_jobs]] row `kind='media-buyer-grade'` with
 * `instructions.limit=50` (matches the [[../libraries/media-buyer-grader]] default);
 * the box worker's `runMediaBuyerGradeJob` lane runs
 * [[../libraries/media-buyer-grader]] `gradeMediaBuyerActions` deterministically —
 * no Max session, no LLM.
 *
 * Self-monitoring: the cron emits its own `media-buyer-grade-cron` heartbeat at the
 * end via [[../libraries/control-tower]] `emitCronHeartbeat` (registered in
 * `src/lib/control-tower/registry.ts` with owner `growth`) — so a dead grader shows
 * as a stale cron tile on the Control Tower.
 *
 * NEVER auto-reverts or mutates a source `director_activity` row — the grader writes
 * to `media_buyer_action_grades` keyed on `director_activity_id`; the M4 revert
 * consumer is a separate supervised path ([[../operational-rules]] § North star).
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import {
  GRADEABLE_ACTION_KINDS,
  REALIZED_WINDOW_MIN_DAYS,
} from "@/lib/media-buyer/grader";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Default `instructions.limit` on the enqueued `agent_jobs` row — matches the
 * [[../libraries/media-buyer-grader]] runner default so an omitted `limit` in the
 * event handler and the grader itself agree on the per-pass row cap.
 */
export const MEDIA_BUYER_GRADE_DEFAULT_LIMIT = 50;

/** ISO cutoff — actions must be older than this to enter the settled window. */
function settledCutoffIso(now: Date = new Date()): string {
  const ms = now.getTime() - REALIZED_WINDOW_MIN_DAYS * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

/**
 * Distinct `workspace_id`s with ≥1 UNGRADED settled Media Buyer action — the cron's
 * fan-out set. A workspace whose entire settled backlog is already scored contributes
 * nothing; a workspace whose newest gradeable action is younger than
 * `REALIZED_WINDOW_MIN_DAYS` contributes nothing (the settled-window guard).
 *
 * Extracted from the cron handler so it's testable without `step.run`.
 */
export async function findWorkspacesWithGradeableActions(
  admin: Admin,
  now: Date = new Date(),
): Promise<string[]> {
  const cutoff = settledCutoffIso(now);
  const { data: settled, error } = await admin
    .from("director_activity")
    .select("id, workspace_id")
    .in("action_kind", GRADEABLE_ACTION_KINDS as readonly string[])
    .lt("created_at", cutoff);
  if (error) throw new Error(`director_activity read failed: ${error.message}`);
  const rows = (settled || []) as Array<{ id: string; workspace_id: string }>;
  if (!rows.length) return [];

  const actionIds = rows.map((r) => r.id);
  const { data: graded, error: gErr } = await admin
    .from("media_buyer_action_grades")
    .select("director_activity_id")
    .in("director_activity_id", actionIds);
  if (gErr) throw new Error(`media_buyer_action_grades read failed: ${gErr.message}`);
  const alreadyGraded = new Set(
    ((graded || []) as Array<{ director_activity_id: string }>).map((r) => r.director_activity_id),
  );

  const ungradedWorkspaces = new Set<string>();
  for (const row of rows) {
    if (!alreadyGraded.has(row.id)) ungradedWorkspaces.add(row.workspace_id);
  }
  return [...ungradedWorkspaces];
}

export const mediaBuyerGradeCron = inngest.createFunction(
  {
    id: "media-buyer-grade-cron",
    name: "Growth — media buyer grader daily sweep",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 14 * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const workspaceIds = await step.run("find-gradeable-workspaces", async () => {
      return findWorkspacesWithGradeableActions(admin);
    });

    for (const workspaceId of workspaceIds) {
      await step.run(`fan-out-${workspaceId}`, async () => {
        await inngest.send({
          name: "growth/media-buyer-grade-sweep",
          data: { workspace_id: workspaceId, trigger: "cron" },
        });
      });
    }

    const result = { workspaces: workspaceIds.length };
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("media-buyer-grade-cron", {
        ok: true,
        produced: result,
        detail: `fanned out ${result.workspaces} workspace(s)`,
      });
    });
    return result;
  },
);

export const mediaBuyerGradeSweep = inngest.createFunction(
  {
    id: "media-buyer-grade-sweep",
    name: "Growth — media buyer grader per-workspace pass",
    retries: 1,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "growth/media-buyer-grade-sweep" }],
  },
  async ({ event, step }) => {
    const { workspace_id } = event.data as {
      workspace_id: string;
      trigger?: "cron" | "manual";
    };
    const result = await step.run("enqueue-media-buyer-grade-job", async () => {
      const admin = createAdminClient();
      const { error } = await admin.from("agent_jobs").insert({
        workspace_id,
        kind: "media-buyer-grade",
        instructions: JSON.stringify({ limit: MEDIA_BUYER_GRADE_DEFAULT_LIMIT }),
      });
      if (error) throw new Error(`agent_jobs insert failed: ${error.message}`);
      return { dispatched: 1 };
    });
    console.log(
      `[media-buyer-grade] ws=${workspace_id} dispatched=${result.dispatched}`,
    );
    return { status: "complete", ...result };
  },
);
