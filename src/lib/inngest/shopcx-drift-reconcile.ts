/**
 * Inngest cron: daily row-vs-contract drift check for ShopCX-billed subscriptions.
 *
 * ⭐ Supervisable autonomy, applied to a money path. The renewal worker is an autonomous tool
 * optimizing a bounded proxy ("charge what our row says is due"). When our row and the Shopify
 * contract disagree, that proxy quietly stops tracking the real objective — a customer who is not
 * actually subscribed keeps being "renewed" at, or a live subscriber is never charged again — and
 * NOTHING in the charge path errors. This cron is the supervisor that makes that visible.
 *
 * See [[docs/brain/inngest/shopcx-drift-reconcile]] and
 * [[docs/brain/libraries/commerce__shopcx-drift-reconciler]].
 */

import { inngest } from "./client";
import { enforceSwitch } from "@/lib/control-tower/enforce-switch";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconcileShopcxDrift } from "@/lib/commerce/shopcx-drift-reconciler";

const FN_ID = "shopcx-drift-reconcile-cron";

export const shopcxDriftReconcileCron = inngest.createFunction(
  {
    id: FN_ID,
    name: "ShopCX subscription drift — daily reconcile",
    retries: 1,
    concurrency: { limit: 1 },
    // 08:00 UTC — two hours BEFORE the renewal cron, so a strand found today is reported before
    // today's charges run rather than after.
    triggers: [{ cron: "0 8 * * *" }],
  },
  async ({ step }) => {
    const gate = await step.run("check-kill-switch", () => enforceSwitch(FN_ID));
    if (gate.ok === "blocked_off") {
      await step.run("beat-off", () => emitCronHeartbeat(FN_ID, { produced: { outcome: "switched_off" } }));
      return { status: "skipped", reason: `switched_off_by:${gate.offBy}` };
    }

    const workspaces = await step.run("list-workspaces", async () => {
      const admin = createAdminClient();
      const { data } = await admin
        .from("workspaces").select("id")
        .not("shopify_access_token_encrypted", "is", null);
      return (data ?? []).map((w) => w.id as string);
    });

    let checked = 0;
    let repaired = 0;
    const drift: Record<string, number> = {};
    const loud: string[] = [];

    for (const workspaceId of workspaces) {
      const report = await step.run(`reconcile-${workspaceId}`, () =>
        // `apply` fixes ONLY the status disagreement, where the contract is authoritative by
        // definition. Dates are reported, never auto-written — a strand needs a re-pin decision.
        reconcileShopcxDrift(workspaceId, { apply: true }),
      );
      checked += report.checked;
      repaired += report.repaired;
      for (const d of report.drift) {
        drift[d.kind] = (drift[d.kind] ?? 0) + 1;
        // A strand is the only kind that silently stops a live customer being charged, so it is
        // the only one loud enough to name every instance in the log.
        if (d.kind === "stranded") loud.push(`${d.contractId}: ${d.detail}`);
      }
      for (const e of report.errors) console.error(`[shopcx-drift] ${workspaceId}: ${e}`);
    }

    if (loud.length) {
      console.error(
        `[shopcx-drift] ⚠️ ${loud.length} STRANDED subscription(s) — these will never be charged again:\n  ${loud.join("\n  ")}`,
      );
    }
    console.log(`[shopcx-drift] checked=${checked} repaired=${repaired} drift=${JSON.stringify(drift)}`);

    await step.run("beat", () =>
      emitCronHeartbeat(FN_ID, {
        produced: { checked, repaired, stranded: drift.stranded ?? 0, date: drift.date ?? 0, status: drift.status ?? 0 },
      }),
    );
    return { checked, repaired, drift };
  },
);
