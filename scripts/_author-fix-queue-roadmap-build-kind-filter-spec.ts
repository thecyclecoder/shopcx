/**
 * Mario→Ada escalation: author the durable fix-spec that fixes the coalescing bug
 * in `queueRoadmapBuild` so `reclaim_and_redrive` can actually unstick the
 * built-but-unmerged class (the concrete symptom that stalled
 * [[sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend]]
 * for ~19h at lifecycle fold/pending).
 *
 * The bug (src/lib/roadmap-actions.ts:170-173):
 *   ```
 *   const { data: existing } = await admin
 *     .from("agent_jobs")
 *     .select("*")
 *     .eq("workspace_id", workspaceId)
 *     .eq("spec_slug", slug)
 *     .in("status", ACTIVE_STATUSES)   // ← no `.eq("kind", "build")`
 *     .order("created_at", { ascending: false }).limit(1).maybeSingle();
 *   if (existing) {
 *     if (!instructions || chainPhases) return { ok: true, job: existing, alreadyActive: true };
 *     ...
 *   }
 *   ```
 * `ACTIVE_STATUSES` includes `"building"`. A running Mario job (kind='mario',
 * status='building', spec_slug=X) matches the guard for a `reclaim_and_redrive`
 * of slug X, so the guard returns `alreadyActive:true` without inserting a new
 * `kind='build'` row. Mario's fix silently no-ops; the spec stays stuck.
 *
 * The fix: filter the existing-job guard by `kind='build'` so ONLY a live build
 * counts as "there is already a live build here." A Mario/plan/spec-review/etc.
 * row for the same spec_slug no longer coalesces a reclaim.
 *
 * Owner: platform. Parent: platform's "Infra & DevOps / reliability" mandate
 * (`platform#infra-devops-reliability`) — same mandate Mario's own fix-specs live
 * under (see [[../libraries/mario]] `MARIO_FIX_MANDATE_SLUG` + `authorMarioFixSpec`).
 * `critical: true, autoBuild: true` — a pipeline-reliability fix should build
 * itself the moment it lands.
 *
 * Idempotent: `authorSpecRowStructured` upserts on (workspace_id, slug); re-running
 * with the same slug is a re-author (Vale re-reviews on content change).
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "fix-queue-roadmap-build-kind-filter";

async function main() {
  const authored = await authorSpecRowStructured(
    WS,
    SLUG,
    {
      title: "queueRoadmapBuild's existing-job guard must filter by kind='build' — Mario reclaim can't be coalesced by a non-build job",
      summary:
        "**Brain refs:** [[../libraries/roadmap-actions]] [[../libraries/mario]] [[../libraries/agent-jobs]]. Concrete symptom: [[../specs/sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend]] sat green (spec-test 16/16, security clean, Vale passed) but built-but-unmerged for ~19h at lifecycle fold/pending because its latest kind='build' row (f11e8754) was terminal `failed` on a `/tmp/sol-reads-moved-wt` worktree collision and Mario's `reclaim_and_redrive` (director_activity mario_fixed 2026-07-09T17:00:52Z, fix_executed:true) enqueued nothing — queueRoadmapBuild's existing-job guard (src/lib/roadmap-actions.ts:170-173) matched the RUNNING Mario job itself and returned `alreadyActive:true`.",
      owner: "platform",
      parent:
        '[[../functions/platform]] — "Infra & DevOps / reliability" mandate: Mario\'s durable pipeline-reliability fix so this stall class cannot recur.',
      blocked_by: [],
      critical: true,
      autoBuild: true,
      why:
        "Mario's whole non-destructive vocabulary rests on `reclaim_and_redrive` being able to enqueue a fresh build via `queueRoadmapBuild` when a spec's LATEST build died (worktree collision, orphaned by a worker restart, stale/conflicting branch). Today it can't: `queueRoadmapBuild`'s existing-job guard queries `agent_jobs` filtered by `.eq(spec_slug, slug).in(status, ACTIVE_STATUSES)` with NO `.eq(kind, 'build')` filter. `ACTIVE_STATUSES` includes 'building'. A running Mario job (kind='mario', status='building', spec_slug=X) matches, and the guard returns `alreadyActive:true` — no new `kind='build'` row is inserted. Mario's own `reclaim_and_redrive` silently no-ops the moment it runs FROM a Mario job, which is exactly when it fires. The sol-reads-moved spec was the observed casualty; the class is every spec whose newest build failed while Mario is still holding its own row.",
      what:
        "The one-active-build guard in `queueRoadmapBuild` (src/lib/roadmap-actions.ts) narrows to `.eq('kind', 'build')`, so ONLY a live build blocks a fresh build enqueue. A Mario / plan / spec-review / any-non-build job for the same spec_slug no longer coalesces `reclaim_and_redrive` (or any other `queueRoadmapBuild` caller). `reclaim_and_redrive` can now actually unstick the built-but-unmerged class it was designed for.",
      phases: [
        {
          title:
            "Phase 1 — narrow queueRoadmapBuild's existing-job guard to kind='build'",
          why:
            "The kind-less predicate is the exact silent-coalesce Mario hits every time. Adding `.eq('kind','build')` makes the guard's semantics match its comment ('One active build per spec') and makes `reclaim_and_redrive` capable of actually enqueueing.",
          what:
            "Add `.eq('kind', 'build')` to the `existing`-row query in `queueRoadmapBuild` (src/lib/roadmap-actions.ts, the `.select('*').eq('workspace_id', workspaceId).eq('spec_slug', slug).in('status', ACTIVE_STATUSES)` chain). No other change to the branch/return shape — a real live BUILD job still short-circuits the same way it does today.",
          body:
            "In `src/lib/roadmap-actions.ts` inside `queueRoadmapBuild` (~line 168-176), extend the existing-job SELECT chain with `.eq('kind', 'build')` so it reads only live `kind='build'` rows for this `(workspace_id, spec_slug)`. Keep the rest of the branch unchanged: with no live build the function falls through to insert a fresh `kind='build'` row (which is what `reclaim_and_redrive` needs); with a live build the plain-tap coalesce and the instructions follow-up both keep working. Cite the fix in an inline comment naming this spec so a future reader sees the WHY (Mario reclaim coalescing).",
          verification:
            "Unit test: given a Mario job (kind='mario', status='building', spec_slug=X) and NO live build for X, `queueRoadmapBuild(workspaceId, ownerId, {slug: X})` inserts a new `kind='build'` row (not `alreadyActive`). Given a live BUILD job for X, a plain `queueRoadmapBuild` STILL returns `{ok:true, alreadyActive:true}` (unchanged behavior). Given a live BUILD job for X and `instructions` present, still enqueues a distinct follow-up build (unchanged). `npx tsc --noEmit` clean.",
        },
        {
          title:
            "Phase 2 — regression test at the Mario boundary: reclaim_and_redrive from a live Mario job actually enqueues a build",
          why:
            "The bug's root cause is a boundary between two SDKs (Mario calls queueRoadmapBuild while its own row is live). A boundary test — Mario job present, `reclaimAndRedrive` invoked — pins the fix so a future refactor cannot silently reintroduce the coalesce.",
          what:
            "An integration-style test (in-memory Supabase stub or the existing test harness pattern) that stands up a `kind='mario'` row for a spec_slug, invokes `reclaimAndRedrive` (or the Mario dispatcher path that calls it), and asserts a fresh `kind='build'` row was inserted with `status='queued'`.",
          body:
            "Add a test to the closest existing mario / roadmap-actions test file (src/lib/mario.test.ts or src/lib/roadmap-actions.test.ts — pick the one already exercising queueRoadmapBuild's guard). Seed one Mario row (kind='mario', status='building', spec_slug=X, workspace_id=W) and NO build row for X, then call reclaimAndRedrive(admin, W, X). Assert that a NEW kind='build' row exists for (W, X) with status='queued'. Also add the negative case: with a live BUILD row for X already present, reclaimAndRedrive returns without inserting a second build (the coalesce for the ACTUAL live-build case is still correct).",
          verification:
            "Both new tests pass. The positive case (Mario-only, no build) inserts one queued build. The negative case (live build present) does NOT double-insert. `npx tsc --noEmit` clean.",
        },
        {
          title:
            "Phase 3 — brain fold on [[../libraries/roadmap-actions]] and [[../libraries/mario]]",
          why:
            "CLAUDE.md hard rule — every fix that changes an invariant lands a brain page in the same PR. The kind-filter invariant on the existing-job guard is exactly the kind of subtle rule the brain page has to state so a future reader doesn't re-widen it.",
          what:
            "Document the kind='build' invariant on [[../libraries/roadmap-actions]] `queueRoadmapBuild` (one live BUILD per spec — NOT one live JOB of any kind) and cross-link from [[../libraries/mario]] `reclaim_and_redrive` explaining that this predicate is what lets Mario's own reclaim actually enqueue when it runs from a live Mario row.",
          body:
            "Update `docs/brain/libraries/roadmap-actions.md` with a short subsection on `queueRoadmapBuild`'s existing-job guard: filter is `(workspace_id, spec_slug, kind='build', status ∈ ACTIVE_STATUSES)`; a non-build job for the same slug is NOT a live build and does NOT coalesce a fresh build enqueue. Cite this spec. In `docs/brain/libraries/mario.md`, in the `reclaim_and_redrive` section, add one sentence: 'The kind='build' filter in queueRoadmapBuild's existing-job guard (fixed in [[../specs/fix-queue-roadmap-build-kind-filter]]) is what lets this action enqueue at all — the live Mario job that INVOKES reclaim_and_redrive would otherwise be treated as the existing active build.'",
          verification:
            "`grep -n 'kind.*build' docs/brain/libraries/roadmap-actions.md docs/brain/libraries/mario.md` finds the invariant + cross-link. `grep -n 'fix-queue-roadmap-build-kind-filter' docs/brain/libraries/` finds citations from both files. brain:index reconcile clean. `npx tsc --noEmit` clean.",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "mario", parentKind: "mandate", parentRef: "platform#infra-devops-reliability" },
  );
  console.log(authored ? `authored ${SLUG}` : `author FAILED for ${SLUG}`);
  if (!authored) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
