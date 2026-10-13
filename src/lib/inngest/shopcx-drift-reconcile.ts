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
import { reconcileShopcxDrift, findLateSubscriptions } from "@/lib/commerce/shopcx-drift-reconciler";
import { enqueueRepairJob } from "@/lib/repair-agent";

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
      }
      for (const e of report.errors) console.error(`[shopcx-drift] ${workspaceId}: ${e}`);
    }

    // ⭐ The cadence check — what drift structurally cannot see.
    const late = await step.run("find-late-subscriptions", async () => {
      const all: { contractId: string; extraDays: number; inDunning: boolean; inherited: boolean }[] = [];
      for (const workspaceId of workspaces) {
        for (const l of await findLateSubscriptions(workspaceId)) {
          all.push({ contractId: l.contractId, extraDays: l.extraDays, inDunning: l.inDunning, inherited: l.inheritedFromAppstle });
        }
      }
      return all;
    });
    // A sub held by an OPEN dunning cycle is late on purpose, and one that arrived late was already
    // behind when we got it. Only the remainder is something WE did — and only that should page
    // anyone, or the alert becomes noise and stops being read.
    const lateUnexplained = late.filter((l) => !l.inDunning && !l.inherited);

    // ⭐ ESCALATE. Every defect in this subsystem through 2026-09-30 was found because a HUMAN
    // asked "check on things" — the cron logged perfectly and nobody read the logs. A monitor that
    // only writes to console is not a monitor. Anything non-zero now opens a repair job, deduped by
    // signature so a persisting condition does not re-open one daily.
    //
    // The 'stranded' escalation was retired with the strand probe in the reconciler
    // (resolveChargeableCycle bills the first UNBILLED cycle by index, so a spent-cycle date no
    // longer strands a sub) — only the cadence-lateness path still pages.
    if (lateUnexplained.length) {
      await step.run("escalate", async () => {
        const admin = createAdminClient();
        const bits = `${lateUnexplained.length} late beyond their own cadence`;
        await enqueueRepairJob(admin, {
          source: "loop-alert",
          // Stable signature = deduped while the condition persists, re-opens once cleared.
          signature: `shopcx-subscription-health:late`,
          title: `ShopCX subscriptions unhealthy — ${bits}`,
        });
        console.error(
          `[shopcx-drift] ESCALATED — ${bits}\n  late: ${lateUnexplained.slice(0, 20).map((l) => `${l.contractId} +${l.extraDays}d`).join(", ")}`,
        );
      });
    }

    console.log(`[shopcx-drift] checked=${checked} repaired=${repaired} drift=${JSON.stringify(drift)} late=${lateUnexplained.length} (+${late.length - lateUnexplained.length} held by dunning)`);

    await step.run("beat", () =>
      emitCronHeartbeat(FN_ID, {
        produced: {
          checked, repaired,
          date: drift.date ?? 0, status: drift.status ?? 0,
          late: lateUnexplained.length,
          lateInDunning: late.filter((l) => l.inDunning).length,
          lateInherited: late.filter((l) => l.inherited && !l.inDunning).length,
        },
      }),
    );
    return { checked, repaired, drift, late: lateUnexplained.length };
  },
);
