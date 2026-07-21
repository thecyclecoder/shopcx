/**
 * Daily recompute of customers.segments for every SMS-subscribed customer in
 * every workspace. Campaigns target customers by `segments` overlap, so a stale
 * book mis-targets sends (a new order still reads `lapsed`, `active_sub` misses
 * recent cancels, etc.).
 *
 * SET-BASED (2026-07-04): the whole recompute is ONE SQL statement — the
 * `public.refresh_customer_segments(workspace_id, all)` function (migration
 * 20260704160000). It replaced a per-customer read/compute/write loop that
 * issued ~138K individual UPDATE round-trips and took ~3 HOURS (and could
 * silently truncate a heavy customer's orders/events at the PostgREST 1000-row
 * cap → wrong segments). The function computes every segment via aggregate CTEs
 * inside Postgres: 138K customers in ~1 minute, exact, no pagination. This also
 * retires the earlier keyset-pagination whole-book-coverage bug — there's no
 * pagination left to get wrong.
 *
 * Segment predicates live in the SQL function (docs/brain/inngest/refresh-customer-segments.md);
 * the manual escape hatch scripts/refresh-customer-segments.ts calls the same function.
 *
 *   cold · single_order · just_ordered · cycle_hitter · lapsed · deep_lapsed
 *   engaged (orders>=1 + recent click/ATC/checkout/2× view) · active_sub · storefront_signup
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

/**
 * Per-workspace refresh — one `.rpc()` call to the set-based function. No pagination,
 * no per-row writes; the whole workspace recomputes in a single short invocation, so it
 * can't time out or leave the back half of the book stale.
 */
export const refreshWorkspaceSegments = inngest.createFunction(
  {
    id: "refresh-workspace-segments",
    name: "Refresh customer.segments for one workspace (set-based)",
    concurrency: [{ limit: 4 }],
    retries: 2,
    triggers: [{ event: "segments/refresh-workspace" }],
  },
  async ({ event, step }) => {
    const { workspace_id } = event.data as { workspace_id: string };
    const updated = await step.run("refresh-segments-sql", async () => {
      const sb = createAdminClient();
      const { data, error } = await sb.rpc("refresh_customer_segments", {
        p_workspace_id: workspace_id,
        p_all: false, // SMS-subscribed scope — matches campaign targeting
      });
      if (error) throw new Error(`refresh_customer_segments(${workspace_id}) failed: ${error.message}`);
      return (data as number) ?? 0;
    });
    return { workspace_id, updated };
  },
);

export const refreshCustomerSegmentsCron = inngest.createFunction(
  {
    id: "refresh-customer-segments-cron",
    name: "Refresh customer.segments daily (fan out per workspace)",
    concurrency: [{ limit: 1 }],
    retries: 2,
    // 07:00 UTC = 1 AM CST / 2 AM CDT daily — moved earlier into the deep off-peak
    // window (was 11:00 UTC / 6 AM Central) so this heavy set-based refresh (the
    // `refresh_customer_segments` RPC — up to ~30s/workspace) lands when DB load is
    // lowest. Cron is fixed-UTC (no DST shift); 07:00 UTC still resolves the day's
    // audiences well before the marketing-text send-tick + sms-marketing agent at
    // 12:00 UTC, so the ordering guarantee is preserved.
    triggers: [{ cron: "0 7 * * *" }],
  },
  async ({ step }) => {
    const sb = createAdminClient();
    // Fan out one event per workspace — each handled by refreshWorkspaceSegments
    // in its own run.
    const { data: workspaces } = await sb.from("workspaces").select("id");
    const events = (workspaces || []).map((w) => ({
      name: "segments/refresh-workspace",
      data: { workspace_id: w.id as string },
    }));
    if (events.length) await step.sendEvent("fan-out-workspaces", events);

    // Coverage probe (fix-segment-refresh-coverage Phase 2): SMS-subscribed count vs
    // count refreshed within 26h. Rides `produced` so the Control Tower tile + the
    // `segment-coverage` output assertion red on <95% coverage — the alarm that would
    // have caught the old 1000/138K stale-book state.
    //
    // Fanout is async: the per-workspace runs kicked off above haven't executed yet, so
    // this reflects the state BEFORE today's refresh — exactly what a staleness alarm
    // wants (a red tile at 11:00 UTC = yesterday's book stayed stale; the assertion
    // re-polls every ~15 min so the tile clears once the fanout lands).
    const coverage = await step.run("probe-coverage", async () => {
      const cutoff26h = new Date(Date.now() - 26 * 60 * 60_000).toISOString();
      const [totalRes, freshRes] = await Promise.all([
        sb.from("customers").select("id", { count: "exact", head: true }).eq("sms_marketing_status", "subscribed"),
        sb
          .from("customers")
          .select("id", { count: "exact", head: true })
          .eq("sms_marketing_status", "subscribed")
          .gte("segments_refreshed_at", cutoff26h),
      ]);
      const total = totalRes.count ?? 0;
      const fresh = freshRes.count ?? 0;
      return {
        sms_subscribed_total: total,
        sms_subscribed_fresh_26h: fresh,
        coverage_ratio: total > 0 ? Math.round((fresh / total) * 10_000) / 10_000 : null,
      };
    });

    const result = { fanned_out: events.length, ...coverage };
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("refresh-customer-segments-cron", { ok: true, produced: result });
    });
    return result;
  },
);
