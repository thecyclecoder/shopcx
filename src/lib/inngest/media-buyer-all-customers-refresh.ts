/**
 * Daily cron: incremental refresh of the all-customers (CUSTOMER_LIST, hashed) exclusion audience
 * per (workspace, meta_ad_account) — bianca-full-order-history-customer-list-exclusion-audience Fix 1.
 *
 * A CUSTOMER_LIST custom audience does NOT auto-update — newly-acquired customers are NOT excluded
 * until we upload them. A daily top-up keeps the exclusion current so the cold-test rail's
 * complete-existing-customer coverage doesn't silently narrow as the business grows. (Daily, not
 * weekly: the upload is incremental + append-only so it's cheap to run every day, and daily
 * shrinks the window before a brand-new customer is excluded from ~7d to ~1d — CEO 2026-07-20.)
 *
 * Incremental via watermark: for each active per-test cohort carrying `excluded_all_customers_audience_id`,
 * we upload customers whose `first_order_at >= last_run_at_iso` (defaulted to 2d ago on first run —
 * a 24h grace over the 1d cadence so a paused/delayed run picks up the missed window). Only
 * hashed email + hashed phone leave the box (via `addUsersToCustomAudience`); plaintext PII is
 * never persisted or logged. Ships the node-completeness trio: OWNER in the node registry (Growth),
 * kill_switches ancestry inherited from Growth's `director:growth` seat, and an end-of-run
 * `emitCronHeartbeat` — required by the CLAUDE.md node-completeness rule.
 *
 * Runs daily 12:00 UTC. MONITORED_LOOPS `livenessWindowMs` is 30h (daily + jitter grace per the
 * monitor-cadence invariant). No sub-5-min cadence.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  addUsersToCustomAudience,
  getMetaUserToken,
} from "@/lib/meta-ads";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

const CUSTOMER_CHUNK = 10_000;
const DEFAULT_WATERMARK_LOOKBACK_DAYS = 2;

/**
 * PURE — pick the ISO watermark for THIS run: the last run's completion timestamp if we have one,
 * else `now - lookbackDays * 86400s`. The lookback default (2d) is one 24h grace beyond the 1d
 * cron cadence so a paused/delayed run doesn't silently skip a customer that ordered in the miss
 * window. Exported for the unit test that pins the "only new customers since the watermark" contract.
 */
export function pickRefreshWatermarkIso(input: {
  lastRunAtIso: string | null | undefined;
  nowIso: string;
  lookbackDays?: number;
}): string {
  if (input.lastRunAtIso) return input.lastRunAtIso;
  const days = input.lookbackDays ?? DEFAULT_WATERMARK_LOOKBACK_DAYS;
  const nowMs = Date.parse(input.nowIso);
  const lookbackMs = days * 24 * 60 * 60 * 1000;
  return new Date(nowMs - lookbackMs).toISOString();
}

export const mediaBuyerAllCustomersRefreshDailyCron = inngest.createFunction(
  {
    id: "media-buyer-all-customers-refresh-daily",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 12 * * *" }], // daily 12:00 UTC
  },
  async ({ step }) => {
    const admin = createAdminClient();
    const nowIso = new Date().toISOString();

    // Enumerate every active per-test cohort that has been stamped with the all-customers
    // audience id. Cohorts without a stamped id are NOT refreshed here — the Fix 1 backfill
    // is what does the initial upload + stamp; this cron ONLY tops up already-stamped cohorts.
    const cohorts = await step.run("list-cohorts", async () => {
      const { data, error } = await admin
        .from("media_buyer_test_cohorts")
        .select(
          "id, workspace_id, meta_ad_account_id, excluded_all_customers_audience_id",
        )
        .eq("adset_per_test", true)
        .eq("is_active", true)
        .not("excluded_all_customers_audience_id", "is", null);
      if (error) throw new Error(`list-cohorts failed: ${error.message}`);
      return (data ?? []) as Array<{
        id: string;
        workspace_id: string;
        meta_ad_account_id: string | null;
        excluded_all_customers_audience_id: string;
      }>;
    });

    const summary: Array<{
      workspace: string;
      audience_id: string;
      watermark_iso: string;
      new_customers: number;
      uploaded_rows: number;
    }> = [];

    // Group by (workspace, audience_id) so a shared audience across per-product cohorts is only
    // topped up once per run.
    const groups = new Map<string, {
      workspaceId: string;
      audienceId: string;
      metaAdAccountId: string;
    }>();
    for (const c of cohorts) {
      if (!c.meta_ad_account_id) continue;
      const key = `${c.workspace_id}|${c.excluded_all_customers_audience_id}`;
      if (groups.has(key)) continue;
      groups.set(key, {
        workspaceId: c.workspace_id,
        audienceId: c.excluded_all_customers_audience_id,
        metaAdAccountId: c.meta_ad_account_id,
      });
    }

    for (const g of groups.values()) {
      const groupSummary = await step.run(`refresh-${g.audienceId}`, async () => {
        // Watermark: last successful heartbeat for THIS cron on THIS workspace.
        // We store the last-refresh watermark on the workspace's most recent
        // media_buyer_all_customers_refresh_runs row so we only ever upload the new-customer delta.
        const { data: lastRun } = await admin
          .from("media_buyer_all_customers_refresh_runs")
          .select("completed_at")
          .eq("workspace_id", g.workspaceId)
          .eq("audience_id", g.audienceId)
          .order("completed_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const watermarkIso = pickRefreshWatermarkIso({
          lastRunAtIso: (lastRun as { completed_at?: string | null } | null)?.completed_at ?? null,
          nowIso,
        });

        const token = await getMetaUserToken(g.workspaceId);
        if (!token) {
          return {
            workspace: g.workspaceId,
            audience_id: g.audienceId,
            watermark_iso: watermarkIso,
            new_customers: 0,
            uploaded_rows: 0,
            skipped: "no_meta_token" as const,
          };
        }

        // Cursor-paginate new customers acquired since the watermark. This IS the "select only
        // customers since the last-refresh watermark" contract the spec verification checks.
        let cursor: string | null = null;
        let newCustomers = 0;
        let uploaded = 0;
        for (;;) {
          let q = admin
            .from("customers")
            .select("id, email, phone, first_order_at")
            .eq("workspace_id", g.workspaceId)
            .gte("first_order_at", watermarkIso)
            .order("id", { ascending: true })
            .limit(CUSTOMER_CHUNK);
          if (cursor) q = q.gt("id", cursor);
          const { data: rows, error } = await q;
          if (error) throw new Error(`customers read failed: ${error.message}`);
          const list = (rows ?? []) as Array<{
            id: string;
            email: string | null;
            phone: string | null;
            first_order_at: string | null;
          }>;
          if (!list.length) break;
          newCustomers += list.length;
          const uploadRows = list.map((c) => ({ email: c.email, phone: c.phone }));
          const results = await addUsersToCustomAudience(token, g.audienceId, uploadRows);
          for (const r of results) uploaded += r.num_received;
          if (list.length < CUSTOMER_CHUNK) break;
          cursor = list[list.length - 1].id;
        }

        // Record the completion so the next run's watermark is this run's timestamp.
        await admin.from("media_buyer_all_customers_refresh_runs").insert({
          workspace_id: g.workspaceId,
          audience_id: g.audienceId,
          meta_ad_account_id: g.metaAdAccountId,
          watermark_at: watermarkIso,
          completed_at: nowIso,
          new_customers: newCustomers,
          uploaded_rows: uploaded,
        });

        return {
          workspace: g.workspaceId,
          audience_id: g.audienceId,
          watermark_iso: watermarkIso,
          new_customers: newCustomers,
          uploaded_rows: uploaded,
        };
      });
      summary.push(groupSummary);
    }

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("media-buyer-all-customers-refresh-daily", {
        ok: true,
        produced: summary,
        detail: `refreshed ${summary.length} audience(s), ${summary.reduce((s, r) => s + r.uploaded_rows, 0)} row(s)`,
      });
    });

    return summary;
  },
);
