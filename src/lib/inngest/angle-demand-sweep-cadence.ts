/**
 * Angle Demand Sweep Cadence — the daily cron that closes the demand-sourced-angle-sweep spec
 * (Phase 3). Enumerates ad-tool workspaces × their active products and calls
 * `runSweepForProduct` per product so `product_angle_palette.search_demand` reflects real
 * search-volume evidence instead of the seed author's judgement.
 *
 * Per the north-star supervisability rail (CLAUDE.md § North star): this cron is a bounded
 * proxy, not the objective owner — every draft it authors lands is_active=false, and every
 * refresh writes a director_activity audit row. The Growth Director (Max) owns the objective.
 * Kill-switch: `resolveEffectiveSwitch('angle-demand-sweep-cadence-cron')` — a missing row means
 * ON per the [[kill_switches]] fail-open invariant; the CEO can flip it off via the Control
 * Tower switch route without a code change.
 *
 * Triggers:
 *   cron  "30 10 * * *"                                  → daily sweep across all ad-tool workspaces
 *   event "ads/angle-demand-sweep.cadence" { workspaceId?, productId? } → manual / on-demand
 *
 * See docs/brain/inngest/angle-demand-sweep-cadence.md.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { runSweepForProduct } from "@/lib/ads/angle-demand-sweep";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

const CRON_ID = "angle-demand-sweep-cadence-cron";
const MANUAL_ID = "angle-demand-sweep-cadence-manual";

/**
 * Ad-tool workspace scope — the same "workspaces that actually run ads" filter every other
 * growth cron uses (any workspace with at least one ad_campaigns row). A store without ads is
 * out of scope for the palette sweep.
 */
async function adToolWorkspaceIds(): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin.from("ad_campaigns").select("workspace_id");
  return Array.from(new Set((data ?? []).map((r) => r.workspace_id as string)));
}

async function activeProductIds(workspaceId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("products")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("status", "active");
  return (data ?? []).map((r) => r.id as string);
}

interface WorkspaceSweepResult {
  workspaceId: string;
  productsSwept: number;
  totalDraftsCreated: number;
  totalRowsRefreshed: number;
  providers: string[];
}

async function runWorkspaceSweep(workspaceId: string): Promise<WorkspaceSweepResult> {
  const admin = createAdminClient();
  const productIds = await activeProductIds(workspaceId);
  let totalDraftsCreated = 0;
  let totalRowsRefreshed = 0;
  const providers = new Set<string>();

  for (const productId of productIds) {
    try {
      const summary = await runSweepForProduct({ admin, workspaceId, productId });
      totalDraftsCreated += summary.draftsCreated;
      totalRowsRefreshed += summary.rowsRefreshed;
      for (const p of summary.provider.split("+")) providers.add(p);
    } catch (err) {
      // Best-effort per product — one bad product must not break the workspace loop.
      console.error(`[angle-demand-sweep] product sweep failed ws=${workspaceId} product=${productId}:`, err);
    }
  }

  return {
    workspaceId,
    productsSwept: productIds.length,
    totalDraftsCreated,
    totalRowsRefreshed,
    providers: [...providers].sort(),
  };
}

export const angleDemandSweepCadenceCron = inngest.createFunction(
  { id: CRON_ID, retries: 1, triggers: [{ cron: "30 10 * * *" }] },
  async ({ step }) => {
    const result = await (async () => {
      const workspaceIds = await step.run("ad-tool-workspaces", adToolWorkspaceIds);
      if (!workspaceIds.length) return { workspaces: 0, results: [] as WorkspaceSweepResult[] };

      const results: WorkspaceSweepResult[] = [];
      for (const workspaceId of workspaceIds) {
        const r = await step.run(`sweep-${workspaceId}`, () => runWorkspaceSweep(workspaceId));
        results.push(r);
      }
      return { workspaces: workspaceIds.length, results };
    })();

    // Control Tower: end-of-run heartbeat (a healthy-but-idle cron must still beat).
    // This is the runtime artifact the MONITORED_LOOPS tile evaluates against — no beat within
    // livenessWindowMs (30h for a daily cron) → RED alert on the CEO's Control Tower.
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat(CRON_ID, { ok: true, produced: result });
    });

    return result;
  },
);

export const angleDemandSweepCadenceManual = inngest.createFunction(
  { id: MANUAL_ID, retries: 1, triggers: [{ event: "ads/angle-demand-sweep.cadence" }] },
  async ({ event, step }) => {
    const data = (event.data as { workspaceId?: string; productId?: string } | undefined) ?? {};

    // Product-scoped manual run — a single sweep, no workspace enumeration.
    if (data.workspaceId && data.productId) {
      const admin = createAdminClient();
      const summary = await step.run(`sweep-${data.workspaceId}-${data.productId}`, () =>
        runSweepForProduct({ admin, workspaceId: data.workspaceId!, productId: data.productId! }),
      );
      return { workspaces: 1, results: [{
        workspaceId: data.workspaceId,
        productsSwept: 1,
        totalDraftsCreated: summary.draftsCreated,
        totalRowsRefreshed: summary.rowsRefreshed,
        providers: summary.provider.split("+"),
      }] };
    }

    // Workspace-scoped OR all-workspace fan-out — mirrors the cron path.
    const workspaceIds = data.workspaceId
      ? [data.workspaceId]
      : await step.run("ad-tool-workspaces", adToolWorkspaceIds);
    if (!workspaceIds.length) return { workspaces: 0, results: [] as WorkspaceSweepResult[] };
    const results: WorkspaceSweepResult[] = [];
    for (const workspaceId of workspaceIds) {
      const r = await step.run(`sweep-${workspaceId}`, () => runWorkspaceSweep(workspaceId));
      results.push(r);
    }
    return { workspaces: workspaceIds.length, results };
  },
);
