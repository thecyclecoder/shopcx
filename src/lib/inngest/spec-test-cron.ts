/**
 * spec-test-cron — the daily enqueuer for the box-hosted spec-test QA agent (spec-test-agent).
 * The box has no internal ticker, so (exactly like triage-escalations / portal-auto-resume) an Inngest
 * cron is the trigger: once a day it finds specs that are **shipped but not archived** — derived status
 * `shipped` (brain-roadmap deriveStatus) AND still in docs/brain/specs/ with no archive.d/{slug}.md —
 * and inserts one `agent_jobs` row `kind='spec-test'` per such spec, per build-console workspace. The
 * box claims each on its concurrency-1 spec-test lane (runSpecTestJob) and runs the non-destructive
 * `## Verification` checks on Max.
 *
 * Dedupe: skip a (workspace, slug) that already has an in-flight spec-test job OR a fresh run (a
 * spec_test_runs row in the last ~20h) — a daily sweep must never pile up or re-test the same spec twice
 * a day. This cron does NO reasoning — it is purely the enqueue. See docs/brain/inngest/spec-test-cron.md.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRoadmap, listArchivedSlugs } from "@/lib/brain-roadmap";
import { enqueueSpecTestIfDue } from "@/lib/agent-jobs";
import { autoFoldVerifiedSpecs } from "@/lib/spec-test-runs";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

export const specTestCron = inngest.createFunction(
  {
    id: "spec-test-cron",
    name: "Spec-test — daily box QA enqueue over shipped-unverified specs",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "45 10 * * *" }], // daily at 10:45 UTC (offset from the other crons)
  },
  async ({ step }) => {
    const admin = createAdminClient();

    const result = await step.run("enqueue-spec-test-jobs", async () => {
      // Backlog sweep: shipped-but-not-archived specs (status `shipped`, slug not in archive.d/) that the
      // event triggers (spec-test-on-ship) missed — box was down, or they shipped before the event existed.
      const [{ specs }, archived] = await Promise.all([getRoadmap(), listArchivedSlugs()]);
      const archivedSet = new Set(archived);
      const slugs = specs.filter((s) => s.status === "shipped" && !archivedSet.has(s.slug)).map((s) => s.slug);
      if (!slugs.length) return { workspaces: 0, candidates: 0, enqueued: 0 };

      // Enqueue per workspace that actually uses the build console (has any agent_jobs row).
      const { data: wsRows } = await admin.from("agent_jobs").select("workspace_id").limit(1000);
      const workspaceIds = Array.from(new Set((wsRows || []).map((r) => r.workspace_id as string)));
      if (!workspaceIds.length) return { workspaces: 0, candidates: slugs.length, enqueued: 0 };

      // Per (workspace, slug) through the shared guard — the SAME in-flight + fresh-run dedupe the event
      // triggers use, so a cron tick that races a manual flip / build merge no-ops the duplicate. We pass
      // the already-derived `shipped` status to skip a redundant per-slug disk read.
      let enqueued = 0;
      for (const workspaceId of workspaceIds) {
        for (const slug of slugs) {
          const { enqueued: did } = await enqueueSpecTestIfDue(workspaceId, slug, "shipped");
          if (did) enqueued++;
        }
      }
      return { workspaces: workspaceIds.length, candidates: slugs.length, enqueued };
    });

    // Auto-fold Gate B periodic sweep (auto-ship-pipeline Phase 2): the reactive triggers (spec-test
    // completion / human-check resolution) drive the common case; this daily backstop catches specs that
    // became all-green while the box was down / the gate threw / the kill-switch was toggled back on. The
    // gate itself is kill-switched + all-green-only + idempotent (coalesces into the batch fold-build).
    const autoFold = await step.run("auto-fold-verified-specs", async () => {
      const { data: wsRows } = await admin.from("agent_jobs").select("workspace_id").limit(1000);
      const workspaceIds = Array.from(new Set((wsRows || []).map((r) => r.workspace_id as string)));
      let folded = 0;
      const foldedSlugs: string[] = [];
      for (const workspaceId of workspaceIds) {
        const f = await autoFoldVerifiedSpecs(workspaceId, admin);
        folded += f.folded;
        foldedSlugs.push(...f.foldedSlugs);
      }
      return { workspaces: workspaceIds.length, folded, foldedSlugs };
    });

    // Control Tower: end-of-run heartbeat (control-tower spec, Phase 1).
    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("spec-test-cron", { ok: true, produced: { ...result, autoFold } });
    });

    return { ...result, autoFold };
  },
);
