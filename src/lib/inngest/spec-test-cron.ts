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
      // Shipped-but-not-archived specs: status `shipped` and slug not in archive.d/.
      const [{ specs }, archived] = await Promise.all([getRoadmap(), listArchivedSlugs()]);
      const archivedSet = new Set(archived);
      const slugs = specs.filter((s) => s.status === "shipped" && !archivedSet.has(s.slug)).map((s) => s.slug);
      if (!slugs.length) return { workspaces: 0, candidates: 0, enqueued: 0 };

      // Enqueue per workspace that actually uses the build console (has any agent_jobs row).
      const { data: wsRows } = await admin.from("agent_jobs").select("workspace_id").limit(1000);
      const workspaceIds = Array.from(new Set((wsRows || []).map((r) => r.workspace_id as string)));
      if (!workspaceIds.length) return { workspaces: 0, candidates: slugs.length, enqueued: 0 };

      // In-flight spec-test jobs (skip a (workspace, slug) already queued/building).
      const { data: inflight } = await admin
        .from("agent_jobs")
        .select("workspace_id, spec_slug")
        .eq("kind", "spec-test")
        .in("status", ["queued", "queued_resume", "building", "claimed"]);
      const busy = new Set((inflight || []).map((j) => `${j.workspace_id}:${j.spec_slug}`));

      // Fresh runs (skip a (workspace, slug) tested in the last ~20h).
      const since = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
      const { data: recent } = await admin
        .from("spec_test_runs")
        .select("workspace_id, spec_slug")
        .gte("run_at", since);
      const fresh = new Set((recent || []).map((r) => `${r.workspace_id}:${r.spec_slug}`));

      let enqueued = 0;
      for (const workspaceId of workspaceIds) {
        for (const slug of slugs) {
          const key = `${workspaceId}:${slug}`;
          if (busy.has(key) || fresh.has(key)) continue;
          const { error } = await admin.from("agent_jobs").insert({
            workspace_id: workspaceId,
            spec_slug: slug,
            kind: "spec-test",
            status: "queued",
            created_by: null,
          });
          if (!error) enqueued++;
        }
      }
      return { workspaces: workspaceIds.length, candidates: slugs.length, enqueued };
    });

    return result;
  },
);
