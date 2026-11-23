/**
 * Subscriber-experiment guardrail + verdict — Inngest cron (the retention autonomy layer).
 *
 *   subscriber-experiment-guardrail-cron — daily: evaluates the pre-renewal reminder 50/50 test's
 *     guardrails treatment-vs-holdout with a sequential-safe (anytime-valid) method plus hard
 *     absolute floors; on a trip it flips the experiment to `stopped` through the status SDK (which,
 *     after Phase 4, halts ALL reminders) and sends ONE deduped CEO notification. When the
 *     pre-registered sample is reached and every group's 90-day window has closed, it records the
 *     verdict and notifies the CEO once. Never auto-resumes.
 *
 * Thin wrapper — the logic lives in [[subscriber-experiment-guardrails]]. Runs at 14:00 UTC (after
 * the pre-renewal reminder cron at 13:00) and emits a heartbeat on EVERY tick (incl. the no-running-
 * experiment / kill-switch-off path) per the CLAUDE.md node-completeness rule.
 */
import { inngest } from "@/lib/inngest/client";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import {
  runSubscriberExperimentGuardrails,
  GUARDRAIL_CRON_LOOP_ID,
} from "@/lib/subscriber-experiment-guardrails";
// ⭐ The cron is the autonomy boundary: it owns the capability to PAUSE the test and injects the
// audited status-SDK writer, so a guardrail trip can only flip the experiment to 'stopped' through
// `setExperimentStatus` (never a raw write). See [[subscriber-experiments]] + the north-star rule.
import { setExperimentStatus } from "@/lib/subscriber-experiments";

export const subscriberExperimentGuardrailCron = inngest.createFunction(
  { id: GUARDRAIL_CRON_LOOP_ID, retries: 1, triggers: [{ cron: "0 14 * * *" }] },
  async ({ step }) => {
    const result = await step.run("run", () =>
      runSubscriberExperimentGuardrails(new Date(), undefined, setExperimentStatus),
    );
    // Heartbeat on EVERY tick (incl. the kill-switch-off / no-running-experiment path).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat(GUARDRAIL_CRON_LOOP_ID, { ok: !result.killSwitchOff, produced: result });
    });
    return result;
  },
);
