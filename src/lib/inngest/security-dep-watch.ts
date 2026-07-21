/**
 * security-dep-watch — the daily CVE / dependency-upgrade watch behind the **Security / Dependency
 * Agent** ([[docs/brain/specs/security-dependency-agent.md]] Phase 2). The sibling of the per-diff
 * security pass: where Phase 1 reviews each merged diff, this watches the dependency tree for known
 * CVEs / available security upgrades.
 *
 * North star (supervisable autonomy): the watch DETECTS (a vulnerable dep) and the box AUTHORS a scoped
 * upgrade-fix spec + SURFACES a one-tap owner Build card — it NEVER auto-bumps a dependency (the
 * owner-gated build does the bump + the `tsc` gate). Mirrors [[coverage-auto-register-agent|Cole]] /
 * [[repair-agent|Rafa]]: detect → propose → owner builds.
 *
 * Why a cron that ENQUEUES a box job rather than scanning here: `npm audit` needs the npm CLI + the
 * committed lockfile + registry access — none reliably present in the Vercel/Inngest serverless runtime.
 * So this cron is the SCHEDULER (deduped to ≤1 live scan/day, emits its heartbeat) and the box worker's
 * `runSecurityReviewJob` (dep-watch mode) runs the actual `npm audit` on the real tree and authors the
 * upgrade-fix spec. The observable behaviour matches the spec: a daily watch → an upgrade-fix spec +
 * Build card on a finding, a healthy beat on a clean tree.
 */
import { inngest } from "./client";
import { errText } from "@/lib/error-text";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueDepWatchJob, enqueueSecurityDiffIfDue } from "@/lib/security-agent";

export const securityDepWatch = inngest.createFunction(
  { id: "security-dep-watch", retries: 1, triggers: [{ cron: "0 4 * * *" }] },
  async ({ step }) => {
    // Compute the run result on every path (incl. the dedup no-op) so the end-of-run heartbeat always
    // fires — a healthy-but-idle cron must still beat, or Control Tower false-flags it registered_not_firing.
    const result = await step.run("enqueue-dep-watch", async () => {
      const admin = createAdminClient();
      const r = await enqueueDepWatchJob(admin);
      return r;
    });

    // fix-vault-post-merge-diff-backstop-7fbde0 — the POST-MERGE `diff` security backstop's daily leg
    // (the platform-director standing pass is the fast leg). Walks `spec_status_history` for
    // `actor='merge:<sha>'` rows in the 14d window (audit-authoritative, survives fold) and (idempotently
    // via `enqueueSecurityReviewDiff`'s SHA dedup) enqueues the diff review for any merge SHA that has
    // no security-review job yet. Best-effort — never breaks the heartbeat.
    const diffBackstop = await step.run("enqueue-diff-backstop", async () => {
      try {
        const admin = createAdminClient();
        return await enqueueSecurityDiffIfDue(admin);
      } catch (err) {
        return { enqueued: [], scanned: 0, resolved: 0, error: errText(err) };
      }
    });

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("security-dep-watch", { ok: true, produced: { ...result, diff_backstop: diffBackstop } });
    });

    return { ...result, diff_backstop: diffBackstop };
  },
);
