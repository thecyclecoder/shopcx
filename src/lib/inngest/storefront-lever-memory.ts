/**
 * Storefront lever-importance memory maintenance — Inngest functions (Phase 3/4 of
 * the lever-importance model + CRO-learnings memory
 * docs/brain/specs/storefront-lever-importance-memory.md).
 *
 *   storefront-lever-memory-decay-cron — daily fan-out (mirrors the M1 refresh cadence,
 *     offset 30 min AFTER it so freshly-committed posteriors decay on the next pass):
 *     finds every workspace with a lever-importance posterior and fires one event each.
 *   storefront-lever-memory-decay — per-workspace worker: decays every posterior toward
 *     its prior with age (keeps a written-off lever explorable / re-probable) and
 *     intakes the M3 reconciler's recalibration signal if present
 *     ([[storefront-lever-memory]] decayLeverImportance + applyReconcilerSignals).
 *
 * The which-lever bandit math lives in [[storefront-lever-memory]]; these are thin
 * Inngest wrappers, like [[storefront-experiments]].
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { decayLeverImportance, applyReconcilerSignals } from "@/lib/storefront/lever-memory";

export const storefrontLeverMemoryDecayCron = inngest.createFunction(
  { id: "storefront-lever-memory-decay-cron", retries: 1, triggers: [{ cron: "30 12 * * *" }] },
  async ({ step }) => {
    const admin = createAdminClient();
    const workspaceIds = await step.run("find-workspaces-with-posteriors", async () => {
      const { data } = await admin.from("storefront_lever_importance").select("workspace_id");
      return [...new Set((data || []).map((r) => r.workspace_id as string))];
    });
    for (const workspaceId of workspaceIds) {
      await step.run(`trigger-${workspaceId}`, async () => {
        await inngest.send({ name: "storefront/lever-memory-decay", data: { workspace_id: workspaceId } });
      });
    }
    return { workspaces: workspaceIds.length };
  },
);

export const storefrontLeverMemoryDecay = inngest.createFunction(
  {
    id: "storefront-lever-memory-decay",
    retries: 2,
    concurrency: [{ limit: 1, key: "event.data.workspace_id" }],
    triggers: [{ event: "storefront/lever-memory-decay" }],
  },
  async ({ event, step }) => {
    const { workspace_id } = event.data as { workspace_id: string };
    const decay = await step.run("decay", () => decayLeverImportance({ workspaceId: workspace_id }));
    const recal = await step.run("reconciler-signals", () => applyReconcilerSignals({ workspaceId: workspace_id }));
    console.log(
      `[storefront-lever-memory] ws=${workspace_id} decay scanned=${decay.scanned} drifted=${decay.drifted} ` +
        `recal signals=${recal.signals} adjusted=${recal.adjusted}`,
    );
    return { status: "complete", decay, recal };
  },
);
