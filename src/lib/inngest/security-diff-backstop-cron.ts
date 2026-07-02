/**
 * security-diff-backstop-cron — the CHEAP 15-min backstop for Vault's post-merge `diff` security review
 * ([[../specs/fix-vault-post-merge-diff-backstop-7fbde0]] cheap if-due cron backstop, on top of
 * [[../specs/vault-post-merge-diff-backstop]] Phase 1).
 *
 * Why a dedicated cron on top of the daily [[security-dep-watch]] leg + the platform-director standing pass:
 * the daily 4am cron caught an orphan window UP TO ~24h wide, and the standing pass only fires when the
 * platform director agent is up. During the `fix-vault-post-merge-diff-backstop-7fbde0` pre-merge spec-test
 * on 2026-07-02, the shared-DB provenance probe still observed **orphan_count=45** across recent merges even
 * with both nets wired — a 24h window is too coarse and the standing pass isn't guaranteed to catch each
 * merge before the M4 promote gate's probe reads the DB. This cron closes both gaps by running the SAME
 * `enqueueSecurityDiffIfDue` sweep every 15 minutes: cheap (it's a read + a dedup-guarded insert; no reasoning),
 * short-window (the largest orphan lag shrinks from 24h → 15min), and idempotent (the 14d SHA dedup inside
 * `enqueueSecurityReviewJob` short-circuits every SHA that already has a review row). Mirrors the every-15-min
 * cadence [[spec-review-cron]] / [[control-tower-monitor]] use for the same class of dropped-event backstop.
 *
 * Same enqueue-only shape as [[spec-review-cron]] — the box has no internal ticker, so an Inngest cron is
 * the trigger. **This cron does NO reasoning** — purely the enqueue. Heartbeats every run so Control Tower
 * can catch a `registered_not_firing` regression.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueSecurityDiffIfDue } from "@/lib/security-agent";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const securityDiffBackstopCron = inngest.createFunction(
  {
    id: "security-diff-backstop-cron",
    name: "Security — cheap 15-min if-due backstop over merged claude/* builds",
    retries: 1,
    concurrency: [{ limit: 1 }],
    // Every 15 min — matches spec-review-cron/control-tower-monitor cadence; the sweep is cheap (a bounded
    // 500-row read + a 14d-deduped SHA insert per orphan). Shrinks the orphan window from ~24h (the old daily
    // 4am fallback) down to ~15min so the M4 promote gate's post-merge probe rarely trips a false-fail.
    triggers: [{ cron: "*/15 * * * *" }],
  },
  async ({ step }) => {
    const admin = createAdminClient();

    // Compute the run result on every path (incl. the zero-orphan no-op) so the end-of-run heartbeat always
    // fires — a healthy-but-idle cron must still beat, or Control Tower false-flags it registered_not_firing.
    const result = await step.run("enqueue-security-diff-if-due", async () => {
      return await enqueueSecurityDiffIfDue(admin);
    });

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("security-diff-backstop-cron", { ok: true, produced: result });
    });

    return result;
  },
);
