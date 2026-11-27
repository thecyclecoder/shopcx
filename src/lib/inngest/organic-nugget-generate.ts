/**
 * organicNuggetGenerate — daily cron that keeps each enabled workspace's organic nugget queue filled
 * (docs/brain/inngest/organic-nugget-generate.md · organic-nugget-engine Phase 3).
 *
 * Supervisable autonomy: it DRAFTS carousels (status='draft') via the nugget generator; a human
 * approves them in Marketing › Social before anything posts. Keeps ≥7 draft-or-approved carousels
 * queued per workspace, rotating the three content pillars.
 *
 * Node trio (CLAUDE.md hard rule): OWNER cmo in the node registry (MONITORED_LOOPS daily row, 30h
 * liveness), a kill_switches ancestry (the cmo/social ancestor — same as social-scheduler-plan +
 * featured-review-cards), and an end-of-run emitCronHeartbeat.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { topUpNuggetQueue } from "@/lib/social/nugget-generator";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

const QUEUE_TARGET = 7;

export const organicNuggetGenerate = inngest.createFunction(
  {
    id: "organic-nugget-generate",
    name: "Organic — daily nugget generator (keeps ≥7 carousels queued)",
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 7 * * *" }, { event: "organic/nugget.tick" }],
  },
  async ({ event, step }) => {
    const data = (event?.data || {}) as { workspace_id?: string; target?: number };
    const target = data.target ?? QUEUE_TARGET;

    const workspaceIds = await step.run("enabled-workspaces", async () => {
      const admin = createAdminClient();
      if (data.workspace_id) return [data.workspace_id];
      const { data: rows } = await admin.from("workspaces").select("id, social_scheduler_config");
      return (rows || [])
        .filter((w) => (w.social_scheduler_config as { enabled?: boolean } | null)?.enabled)
        .map((w) => String(w.id));
    });

    const results: Array<{ workspace_id: string; created: number }> = [];
    for (const ws of workspaceIds) {
      const created = await step.run(`gen-${ws}`, () => topUpNuggetQueue(ws, target));
      results.push({ workspace_id: ws, created });
    }
    const result = { results };

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("organic-nugget-generate", { ok: true, produced: result });
    });

    return result;
  },
);
