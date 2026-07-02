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

    // vault-post-merge-diff-backstop Phase 1 — second net for the post-merge diff security review. The
    // platform-director standing pass is the primary re-sweep; this daily cron is the fallback so a box
    // outage that skips the standing pass can't leave merged commits unreviewed indefinitely. The
    // enqueue itself is idempotent (14d SHA dedup inside enqueueSecurityReviewJob).
    const diffBackstop = await step.run("enqueue-diff-if-due", async () => {
      const admin = createAdminClient();
      return await enqueueSecurityDiffIfDue(admin);
    });

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("security-dep-watch", { ok: true, produced: { depWatch: result, diffBackstop } });
    });

    return { depWatch: result, diffBackstop };
  },
);
