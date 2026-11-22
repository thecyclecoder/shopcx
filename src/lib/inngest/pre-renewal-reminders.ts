/**
 * Pre-renewal reminder scheduling — Inngest cron (the retention reminder channel).
 *
 *   pre-renewal-reminder-cron — daily: scans subscriptions renewing ~5 days out
 *     across both live engines, collapses to one reminder per customer group, excludes
 *     paused/dunning/just-edited subs, asks the subscriber-experiment harness for the
 *     arm, and for the treatment arm mints a next-order journey session + sends a
 *     transactional email (and a consented, quiet-hours-respecting SMS). Every send is
 *     written to pre_renewal_reminders stamped with the arm.
 *
 * Thin wrapper — the logic lives in [[pre-renewal-reminders]]. Runs at 13:00 UTC,
 * AFTER the morning subscription charge crons (10:00 UTC) so a sub charged today isn't
 * reminded, and emits a heartbeat on EVERY tick (incl. idle ticks) per the CLAUDE.md
 * node-completeness rule — mirrors the idle-tick heartbeat in
 * [[../../docs/brain/inngest/dunning]] / [[../../docs/brain/inngest/marketing-text]].
 */
import { inngest } from "@/lib/inngest/client";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { runPreRenewalReminders, PRE_RENEWAL_REMINDER_LOOP_ID } from "@/lib/pre-renewal-reminders";

export const preRenewalReminderCron = inngest.createFunction(
  { id: PRE_RENEWAL_REMINDER_LOOP_ID, retries: 1, triggers: [{ cron: "0 13 * * *" }] },
  async ({ step }) => {
    const result = await step.run("run", () => runPreRenewalReminders(new Date()));
    // Heartbeat on EVERY tick (incl. the no-eligible-subs / kill-switch-off path) so
    // the freshness monitor sees a daily beat. No early return above.
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat(PRE_RENEWAL_REMINDER_LOOP_ID, { ok: !result.killSwitchOff, produced: result });
    });
    return result;
  },
);
