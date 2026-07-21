// QuickBooks P&L snapshot refresh: re-pull the trailing 6 CLOSED months every
// month. Two reasons late data matters — (1) the previous month's books don't
// finish closing in QuickBooks until ~the 15th, and (2) entries land after the
// fact and quietly change already-closed months. So every refresh re-grabs the
// last 6 months (not just the newest), overwriting each snapshot in place.
// Runs on the 16th (safely past the ~15th close). See
// docs/brain/lifecycles/investors-area.md + docs/brain/tables/qb_pnl_snapshots.md.

import { inngest } from "./client";
import { errText } from "@/lib/error-text";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { backfillPnlSnapshots } from "@/lib/quickbooks";

/** How many trailing closed months to re-pull on every refresh. 6 covers the
 *  window in which late entries realistically still move the books. */
export const QB_REFRESH_MONTHS = 6;

interface RefreshEventData {
  workspaceId?: string; // limit to one workspace
  months?: number; // override the trailing window
}

export const qbSnapshotRefresh = inngest.createFunction(
  {
    id: "qb-snapshot-refresh",
    retries: 1,
    triggers: [
      { cron: "0 8 16 * *" }, // 16th, 8am UTC — after the previous month closes (~15th)
      { event: "qb/refresh-snapshots" }, // manual trigger
    ],
  },
  async ({ step, event }) => {
    const admin = createAdminClient();
    const data = (event?.data ?? {}) as RefreshEventData;
    const months = data.months ?? QB_REFRESH_MONTHS;

    const workspaces = await step.run("get-connected-workspaces", async () => {
      if (data.workspaceId) return [{ id: data.workspaceId }];
      const { data: conns } = await admin.from("quickbooks_connections").select("workspace_id");
      return [...new Set((conns ?? []).map((c) => c.workspace_id as string))].map((id) => ({ id }));
    });

    let refreshed = 0;
    const errors: string[] = [];
    for (const ws of workspaces) {
      const res = await step.run(`refresh-${ws.id}`, async (): Promise<{ months: number; error?: string }> => {
        try {
          const rows = await backfillPnlSnapshots(ws.id, months, admin);
          return { months: rows.length };
        } catch (e) {
          return { months: 0, error: errText(e) };
        }
      });
      if (res.error) errors.push(`${ws.id}: ${res.error}`);
      else refreshed += res.months;
    }

    const summary = { workspaces: workspaces.length, monthsRefreshed: refreshed, errors };
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("qb-snapshot-refresh", { ok: errors.length === 0, produced: summary });
    });
    return summary;
  },
);
