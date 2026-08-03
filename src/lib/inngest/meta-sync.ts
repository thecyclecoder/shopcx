// Inngest functions for Meta ad spend sync

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { syncMetaAdSpend } from "@/lib/meta/sync-spend";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { escalateAppOwnerActionRequired } from "@/lib/meta/app-owner-action-escalation";
import { escalateReconnectRequired } from "@/lib/meta/reconnect-required-escalation";
import {
  isAppOwnerActionRequiredError,
  isReconnectRequiredError,
  type GraphError,
} from "@/lib/meta/graph-retry";

/**
 * Stable human-blocked fingerprint returned by `metaSyncSpend` when Meta's
 * Data Use Checkup gate fires (graph-retry tags
 * `metaClass = 'app_owner_action_required'`). Retrying can never clear this
 * class — only a human completing the checkup in the Meta App Dashboard can —
 * so we contain the error as a stable result instead of letting it flood the
 * Inngest failure feed with duplicate throws.
 */
export const META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED =
  "meta_sync_spend_app_owner_action_required" as const;

/**
 * Stable human-blocked fingerprint returned by `metaSyncSpend` when the
 * stored per-workspace user token has been invalidated by Meta (graph-retry
 * tags `metaClass = 'reconnect_required'`). Same containment shape as its
 * sibling above — retrying never fixes it (only OAuth re-consent does), so
 * we return the stable result instead of throwing.
 *
 * Introduced by [[../../../docs/brain/specs/meta-reconnect-required-class]]
 * Phase 3.
 */
export const META_SYNC_SPEND_RECONNECT_REQUIRED =
  "meta_sync_spend_reconnect_required" as const;

type MetaSyncSpendBlockedFingerprint =
  | {
      status: typeof META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED;
      workspaceId: string;
      adAccountId: string;
      metaAccountId: string;
    }
  | {
      status: typeof META_SYNC_SPEND_RECONNECT_REQUIRED;
      workspaceId: string;
      adAccountId: string;
      metaAccountId: string;
    };

/**
 * Narrow error-branch classifier for `metaSyncSpend`. Returns the stable
 * human-blocked fingerprint when the thrown error is a graph-retry-tagged
 * human-blocked class — the sibling
 * `app_owner_action_required` (Data Use Checkup 400) OR
 * `reconnect_required` (stored user token invalidated) — and returns null
 * for anything else so the caller rethrows. The class-to-fingerprint mapping
 * lets the caller pick the right escalation SDK (App Dashboard card vs
 * reconnect card) without a second string comparison.
 */
export function classifyMetaSyncSpendError(
  err: unknown,
  scope: { workspaceId: string; adAccountId: string; metaAccountId: string },
): MetaSyncSpendBlockedFingerprint | null {
  if (isAppOwnerActionRequiredError(err)) {
    return {
      status: META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED,
      workspaceId: scope.workspaceId,
      adAccountId: scope.adAccountId,
      metaAccountId: scope.metaAccountId,
    };
  }
  if (isReconnectRequiredError(err)) {
    return {
      status: META_SYNC_SPEND_RECONNECT_REQUIRED,
      workspaceId: scope.workspaceId,
      adAccountId: scope.adAccountId,
      metaAccountId: scope.metaAccountId,
    };
  }
  return null;
}

type EscalateAppOwnerFn = typeof escalateAppOwnerActionRequired;
type EscalateReconnectFn = typeof escalateReconnectRequired;
type Admin = ReturnType<typeof createAdminClient>;

/**
 * Handle a metaSyncSpend throw: if it's a human-blocked class, explicitly
 * book the deduped CEO card against THIS invocation's `workspaceId` via the
 * class-appropriate escalation SDK (App Dashboard card for
 * `app_owner_action_required`; reconnect card for `reconnect_required`).
 * `workspaceId` flows through the local `scope` — never a module-global
 * scope, so two overlapping `meta/sync-spend` runs from different workspaces
 * cannot cross-contaminate each other's service-role notification writes.
 * Any other error is rethrown so the Inngest failure feed still surfaces it.
 *
 * Exported so the workspace-isolation invariant is unit-testable without
 * spinning up the Inngest handler + step wrapper.
 *
 * The two escalate hooks default to the production SDKs; tests inject fakes
 * to assert per-workspace propagation without touching the DB. The
 * `escalate` param positional slot is preserved (backward-compat with the
 * Phase-1 app-owner spec test that only knew about the app-owner escalate).
 */
export async function handleMetaSyncSpendError(
  admin: Admin,
  err: unknown,
  scope: { workspaceId: string; adAccountId: string; metaAccountId: string },
  escalate: EscalateAppOwnerFn = escalateAppOwnerActionRequired,
  escalateReconnect: EscalateReconnectFn = escalateReconnectRequired,
): Promise<MetaSyncSpendBlockedFingerprint> {
  const blocked = classifyMetaSyncSpendError(err, scope);
  if (!blocked) throw err;
  const graphErr = err as GraphError;
  const label = `meta/sync-spend act_${scope.metaAccountId}`;
  const status = graphErr.httpStatus ?? 400;
  const affectedAdAccountIds = [scope.metaAccountId];
  if (blocked.status === META_SYNC_SPEND_APP_OWNER_ACTION_REQUIRED) {
    await escalate(admin, {
      workspaceId: scope.workspaceId,
      label,
      status,
      error: graphErr,
      affectedAdAccountIds,
    });
  } else {
    await escalateReconnect(admin, {
      workspaceId: scope.workspaceId,
      label,
      status,
      error: graphErr,
      affectedAdAccountIds,
    });
  }
  return blocked;
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

    // Containment lives INSIDE step.run so the step returns cleanly on a
    // human-blocked Data Use Checkup 400 — if we caught OUTSIDE the step,
    // the throw would exhaust Inngest step retries and fire
    // `inngest/function.failed`, which inngest-failure-capture then records
    // on the Control Tower error feed with source='inngest'. The workspaceId
    // is bound at the invocation call site (never a module global), so the
    // per-workspace escalation-scope isolation invariant is preserved.
    return await step.run("sync-spend", async () => {
      try {
        const result = await syncMetaAdSpend({
          workspaceId: workspace_id,
          adAccountId: ad_account_id,
          metaAccountId: meta_account_id,
          accessToken: token,
          startDate,
          endDate,
        });
        return { status: "complete" as const, ...result };
      } catch (err) {
        return await handleMetaSyncSpendError(admin, err, {
          workspaceId: workspace_id,
          adAccountId: ad_account_id,
          metaAccountId: meta_account_id,
        });
      }
    });
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
