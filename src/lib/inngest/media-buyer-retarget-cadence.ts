/**
 * media-buyer-retarget-cadence — the daily cron that drives the Media Buyer's THIRD (retarget)
 * campaign replenish (retarget-campaign-warm-hot-mixed-content Phase 3).
 *
 * Iterates every ACTIVE [[../tables/meta_ad_accounts]] row (each carries its `workspace_id`) and
 * calls [[../libraries/media-buyer-retarget-cohort]]-backed
 * [[../media-buyer/retarget-agent]] `runRetargetReplenishLoopForAccount(workspace, account)`,
 * which resolves the account's active retarget cohorts, reads warm/hot ready creatives, and
 * publishes each passer into the ONE consolidated retarget adset through the retarget publish
 * gate. Unlike the cold-rail `media-buyer-cadence-cron` (which fans out `agent_jobs` for the box
 * worker), this rail runs the deterministic loop inline — it mints no per-test adsets and moves
 * no scale/kill dollars, so there is no box-session reasoning to dispatch.
 *
 * The cold-only invariant of Bianca's existing replenish loop is UNTOUCHED — this cron reads only
 * `media_buyer_retarget_cohorts` and warm/hot creatives.
 *
 * Self-monitoring: emits a `media-buyer-retarget-cadence` cron heartbeat via
 * [[../libraries/control-tower]] `emitCronHeartbeat` at end-of-run. The MONITORED_LOOPS row lives
 * in `src/lib/control-tower/registry.ts` with owner `growth` + a 30h liveness window (daily × 1.2
 * clears the jitter grace) — a dead cadence shows as a stale cron tile on the Control Tower.
 *
 * Node-completeness trio (CLAUDE.md hard rule): owner `growth` (node-registry KIND_OWNER_FALLBACK
 * `media_buyer_retarget` + this cron's MONITORED_LOOPS row), kill-switch coverage via the ancestor
 * `growth` department row, heartbeat emitted here.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { errText } from "@/lib/error-text";
import { runRetargetReplenishLoopForAccount } from "@/lib/media-buyer/retarget-agent";

type Admin = ReturnType<typeof createAdminClient>;

interface ActiveAccountRow {
  id: string;
  workspace_id: string;
}

/** Active meta ad accounts (each carries its workspace) — the cron's per-account fan set. */
async function loadActiveAccounts(admin: Admin): Promise<ActiveAccountRow[]> {
  const { data, error } = await admin
    .from("meta_ad_accounts")
    .select("id, workspace_id")
    .eq("is_active", true);
  if (error) throw new Error(`meta_ad_accounts read failed: ${error.message}`);
  return (data ?? []) as ActiveAccountRow[];
}

export interface RetargetCadenceResult {
  accounts: number;
  passes: number;
  published: number;
  refused: number;
}

export const mediaBuyerRetargetCadenceCron = inngest.createFunction(
  {
    id: "media-buyer-retarget-cadence",
    name: "Growth — media buyer retarget daily cadence",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "30 13 * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const accounts = await step.run("load-active-accounts", async () => {
      return loadActiveAccounts(admin);
    });

    const result: RetargetCadenceResult = { accounts: accounts.length, passes: 0, published: 0, refused: 0 };
    for (const account of accounts) {
      const perAccount = await step.run(`retarget-replenish-${account.id}`, async () => {
        try {
          const passes = await runRetargetReplenishLoopForAccount(admin, {
            workspaceId: account.workspace_id,
            metaAdAccountId: account.id,
          });
          return {
            passes: passes.length,
            published: passes.reduce((n, p) => n + p.result.published, 0),
            refused: passes.reduce((n, p) => n + p.result.refused, 0),
          };
        } catch (e) {
          console.error(`[media-buyer-retarget-cadence] account ${account.id} threw: ${errText(e)}`);
          return { passes: 0, published: 0, refused: 0 };
        }
      });
      result.passes += perAccount.passes;
      result.published += perAccount.published;
      result.refused += perAccount.refused;
    }

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("media-buyer-retarget-cadence", {
        ok: true,
        produced: result,
        detail: `${result.accounts} account(s), ${result.passes} pass(es), ${result.published} published, ${result.refused} gate-refused`,
      });
    });
    return result;
  },
);
