// Inngest functions for Meta ad spend sync

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { syncMetaAdSpend } from "@/lib/meta/sync-spend";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import {
  installDefaultAppOwnerActionEscalationHandler,
  setCurrentAppOwnerActionWorkspaceScope,
} from "@/lib/meta/app-owner-action-escalation";

/**
 * Stable human-blocked fingerprint for the meta/sync-spend function. When
 * Meta's Data Use Checkup gate fires (graph-retry tags `metaClass =
 * 'app_owner_action_required'`), the escalation handler already books ONE
 * deduped CEO card per workspace per UTC day — retrying or throwing the same
 * 400 from the Inngest job just floods the Control Tower error feed with
 * duplicates that no re-run can clear. This function returns the fingerprint
 * instead, so a real fatal Meta 400 still propagates while the known gate is
 * contained. Mirrors today-sync (log-level downgrade) and media-buyer test
 * cadence (result-tagged human-blocked) precedents for the same class.
 */
export const META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED =
  "meta_sync_spend_app_owner_action_required" as const;

/**
 * Narrow error-branch classifier for `metaSyncSpend`. If the thrown error is
 * a graph-retry-tagged app-owner-action-required (canonical: Data Use
 * Checkup 400), return the stable human-blocked result the function should
 * emit; otherwise return null so the caller rethrows. Extracted so the
 * containment predicate is unit-testable without spinning up the Inngest
 * handler + step wrapper.
 */
export function classifyMetaSyncSpendError(
  err: unknown,
  scope: { workspaceId: string; adAccountId: string; metaAccountId: string },
): {
  status: typeof META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED;
  workspaceId: string;
  adAccountId: string;
  metaAccountId: string;
} | null {
  const metaClass = (err as { metaClass?: string } | null)?.metaClass;
  if (metaClass !== "app_owner_action_required") return null;
  return {
    status: META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED,
    workspaceId: scope.workspaceId,
    adAccountId: scope.adAccountId,
    metaAccountId: scope.metaAccountId,
  };
}

// ── meta/sync-spend ──
export const metaSyncSpend = inngest.createFunction(
  {
    id: "meta-sync-spend",
    retries: 2,
    concurrency: [{ limit: 2, key: "event.data.ad_account_id" }],
    triggers: [{ event: "meta/sync-spend" }],
  },
  async ({ event, step }) => {
    const { workspace_id, ad_account_id, meta_account_id, days } = event.data as {
      workspace_id: string;
      ad_account_id: string;
      meta_account_id: string;
      days?: number;
    };

    const admin = createAdminClient();

    // Install + scope the app-owner-action-required escalation handler for
    // this run so a Data Use Checkup 400 raised inside graphFetchJson books
    // exactly one deduped CEO card per workspace per UTC day (routed to the
    // workspace that owns this sync). Scope is cleared in `finally` so a
    // subsequent unrelated call site can't accidentally raise a card scoped
    // to this workspace. Handler is idempotent — safe to install per run.
    installDefaultAppOwnerActionEscalationHandler(admin);
    setCurrentAppOwnerActionWorkspaceScope(workspace_id);

    try {
      // Get access token from connection
      const token = await step.run("get-token", async () => {
        const { data: conn } = await admin
          .from("meta_connections")
          .select("access_token_encrypted")
          .eq("workspace_id", workspace_id)
          .eq("is_active", true)
          .single();
        if (!conn) throw new Error("No active Meta connection");
        return decrypt(conn.access_token_encrypted);
      });

      const syncDays = Math.min(days || 30, 90);
      const endDate = new Date().toISOString().slice(0, 10);
      const startDate = new Date(Date.now() - syncDays * 86400000).toISOString().slice(0, 10);

      try {
        const result = await step.run("sync-spend", async () => {
          return syncMetaAdSpend({
            workspaceId: workspace_id,
            adAccountId: ad_account_id,
            metaAccountId: meta_account_id,
            accessToken: token,
            startDate,
            endDate,
          });
        });

        return { status: "complete", ...result };
      } catch (err) {
        // Contain Meta's Data Use Checkup gate as a human-blocked result: the
        // escalation handler above already booked the deduped CEO card, and
        // Inngest retrying will never clear the gate (only a human clearing
        // it in the App Dashboard can). Any other Meta failure keeps its
        // current throw behavior so the Inngest failure feed still surfaces it.
        const blocked = classifyMetaSyncSpendError(err, {
          workspaceId: workspace_id,
          adAccountId: ad_account_id,
          metaAccountId: meta_account_id,
        });
        if (blocked) return blocked;
        throw err;
      }
    } finally {
      setCurrentAppOwnerActionWorkspaceScope(null);
    }
  }
);

// ── Daily cron: sync yesterday's spend for all active accounts ──
export const metaDailySyncCron = inngest.createFunction(
  {
    id: "meta-daily-sync",
    retries: 1,
    triggers: [{ cron: "0 11 * * *" }], // 6 AM Central
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const accounts = await step.run("find-active-accounts", async () => {
      const { data } = await admin
        .from("meta_ad_accounts")
        .select("id, workspace_id, meta_account_id")
        .eq("is_active", true);
      return data || [];
    });

    for (const acct of accounts) {
      await step.run(`trigger-sync-${acct.id}`, async () => {
        await inngest.send({
          name: "meta/sync-spend",
          data: {
            workspace_id: acct.workspace_id,
            ad_account_id: acct.id,
            meta_account_id: acct.meta_account_id,
            days: 3, // Last 3 days to catch late-reporting
          },
        });
      });
    }

    const result = { triggered: accounts.length };

    // Control Tower: end-of-run heartbeat (control-tower-complete-coverage spec, Phase 1).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("meta-daily-sync", { ok: true, produced: result });
    });

    return result;
  }
);
