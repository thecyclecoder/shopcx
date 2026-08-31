/**
 * notification-hygiene — the daily sweep that gives informational notifications a terminal state a
 * human doesn't have to reach.
 *
 * See [[../notification-hygiene]] for the why. In short: `dashboard_notifications` had 2,237
 * undismissed rows against 13 real decisions, and 98-100% of the pile was already READ. Nobody is
 * ignoring it — dismissing simply accomplishes nothing when there's no decision, so anything
 * informational accrues forever because a manual click is its only exit.
 *
 * This cron runs both unambiguous sweeps per workspace:
 *   · expired daily recaps (age-based — a report has no other terminal condition)
 *   · settled chargeback alerts (status-driven — a LIVE dispute is deliberately left alone)
 *
 * Fraud alerts are NOT swept: their problem is granularity and severity routing, which is a product
 * decision rather than a retention one.
 *
 * Self-monitoring: emits its own `notification-hygiene-cron` heartbeat (registered in
 * `src/lib/control-tower/registry.ts`, owner `platform`), so a dead sweep shows as a stale tile
 * rather than silently letting the pile grow back.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { sweepExpiredReports, sweepSettledChargebacks, sweepResolvedFraudCases } from "@/lib/notification-hygiene";

/** Workspaces with ≥1 undismissed sweepable notification — never a blind all-workspaces fan-out. */
export async function workspacesWithSweepableNotifications(
  admin: ReturnType<typeof createAdminClient>,
): Promise<string[]> {
  const { data, error } = await admin
    .from("dashboard_notifications")
    .select("workspace_id")
    .eq("dismissed", false)
    .in("type", ["agent_daily_summary", "chargeback_alert", "fraud_alert"]);
  if (error) throw new Error(`workspacesWithSweepableNotifications: ${error.message}`);
  return [...new Set(((data ?? []) as Array<{ workspace_id: string }>).map((r) => r.workspace_id))];
}

export const notificationHygieneCron = inngest.createFunction(
  {
    id: "notification-hygiene-cron",
    name: "Platform — notification hygiene daily sweep",
    retries: 1,
    // A stuck sweep must not stack up runs — the next tick re-reads the same rows anyway.
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 9 * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const workspaceIds = await step.run("find-workspaces", () => workspacesWithSweepableNotifications(admin));

    let reportsDismissed = 0;
    let chargebacksDismissed = 0;
    let chargebacksKept = 0;
    let fraudDismissed = 0;
    let fraudKept = 0;

    for (const workspaceId of workspaceIds) {
      const reports = await step.run(`reports-${workspaceId}`, () =>
        sweepExpiredReports(admin, { workspaceId, apply: true }),
      );
      reportsDismissed += reports.dismissed;

      const cbs = await step.run(`chargebacks-${workspaceId}`, () =>
        sweepSettledChargebacks(admin, { workspaceId, apply: true }),
      );
      chargebacksDismissed += cbs.dismissed;
      chargebacksKept += cbs.kept;

      const fraud = await step.run(`fraud-${workspaceId}`, () =>
        sweepResolvedFraudCases(admin, { workspaceId, apply: true }),
      );
      fraudDismissed += fraud.dismissed;
      fraudKept += fraud.kept;
    }

    const result = {
      workspaces: workspaceIds.length,
      reportsDismissed,
      chargebacksDismissed,
      chargebacksKept,
      fraudDismissed,
      fraudKept,
    };

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("notification-hygiene-cron", {
        ok: true,
        produced: result,
        // `kept` is reported deliberately: it is the evidence the sweep is selective rather than
        // indiscriminate — a live dispute still wants eyes.
        detail:
          `retired ${reportsDismissed} expired recap(s), ${chargebacksDismissed} settled chargeback alert(s), ` +
          `${fraudDismissed} worked fraud alert(s) across ${workspaceIds.length} workspace(s); ` +
          `kept ${chargebacksKept} unsettled chargeback + ${fraudKept} open fraud alert(s)`,
      });
    });
    return result;
  },
);
