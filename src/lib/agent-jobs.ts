/**
 * agent_jobs — the build queue (server-side helpers). The dashboard "Build" button
 * inserts a row; the box worker claims it via claim_agent_job() and drives it to a PR.
 * See docs/brain/specs/roadmap-build-console.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getRoadmap, getSpec, listArchivedSlugs, type Phase } from "@/lib/brain-roadmap";
import { reconcileSpecDrift, fetchSpecRawFromMain, parseFixesLink } from "@/lib/spec-drift";
import { markSpecCardMergeShipped } from "@/lib/spec-card-state";

export type JobStatus =
  | "queued"
  | "claimed"
  | "building"
  | "needs_input"
  | "needs_approval"
  | "queued_resume"
  | "completed"
  | "merged"
  | "failed"
  | "needs_attention";

export interface JobQuestion {
  id: string;
  q: string;
  options?: string[];
}

// 'spec' is the planner's proposed-branch action (goal-decomposition-engine): the owner approves it,
// the worker authors docs/brain/specs/{slug}.md + queues its build. 'migration_fix' is a typed billing
// repair proposed by the migration-fix box agent (executed via src/lib/migration-fix.ts on approval).
// The others are gated prod side-effects.
export type GatedActionType = "apply_migration" | "run_prod_script" | "merge_pr" | "spec" | "migration_fix";

/** A planner-proposed spec branch — carried on a `type:'spec'` PendingAction so the worker can author it on approval. */
export interface ProposedSpec {
  slug: string;
  title: string;
  owner: string; // function slug (DRI)
  parent: string; // a function mandate or a goal milestone (e.g. "M1 — Metrics spine + COGS")
  milestone?: string; // the goal milestone id this branch attaches under (for the goal-doc wikilink)
  intent: string; // one-paragraph intent
  gap?: string; // the brain page/gap this closes (grounding citation)
}

/** A prod-side-effect (or proposed spec) the build/plan needs the owner to approve. `cmd` is the exact command the worker runs on approval (also shown as the preview). */
export interface PendingAction {
  id: string;
  type: GatedActionType;
  summary: string;
  cmd?: string;
  preview?: string;
  status: "pending" | "approved" | "declined" | "done" | "failed";
  result?: string;
  spec?: ProposedSpec; // set when type==='spec' (planner proposal)
  // set when type==='migration_fix' (migration-fix agent) — the typed billing repair the worker runs
  // through src/lib/migration-fix.ts `applyMigrationFix` on approval.
  fix_kind?: "price_reconcile" | "variant_backfill" | "appstle_cancel";
  payload?: unknown;
}

/** 'build' (default — build a spec to a PR) | 'plan' (run plan-goal against a goal → propose specs)
 * | 'fold' (batch fold-build — fold every pending-fold spec into the brain in one PR, fold-build-batching)
 * | 'product-seed' (box-product-seeding — drive one product none→published on Max)
 * | 'ticket-improve' (box-ticket-improve — one turn of a ticket-bound Improve session on Max)
 * | 'migration-fix' (migration-fix-agent — fix a failed Appstle→internal migration on Max, gated)
 * | 'pr-resolve' (dirty-pr-resolver-agent — webhook-fired: merge main into a dirty claude/* PR, resolve
 *   conflicts, tsc-gate + push, or rebuild-on-main / surface to the owner). */
export type JobKind = "build" | "plan" | "fold" | "product-seed" | "ticket-improve" | "migration-fix" | "pr-resolve";

export interface AgentJob {
  id: string;
  workspace_id: string;
  spec_slug: string; // for plan jobs this holds the GOAL slug being planned
  spec_branch: string | null;
  kind: JobKind;
  status: JobStatus;
  claude_session_id: string | null;
  questions: JobQuestion[];
  answers: { id: string; answer: string }[];
  pending_actions: PendingAction[];
  pr_url: string | null;
  pr_number: number | null;
  log_tail: string | null;
  error: string | null;
  claimed_at: string | null;
  // build-all-phases-chain Phase 1: a "Build all" build → its first ⏳ phase is tagged true; the
  // post-merge step queues the next ⏳ phase (also chain_phases) on merge, until all phases ✅. Default
  // false (single-phase / non-chained builds). May be undefined on a pre-migration row read.
  chain_phases?: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * The instruction text scoping a build to ONE phase — shared by the dashboard per-phase Build, the
 * "Build all" first-phase queue (queueRoadmapBuild), and the post-merge chain step
 * (queueNextChainedPhase) so all three drive the box the same way. Kept in sync with the dashboard
 * PhaseList's inline copy.
 */
export function phaseScopedInstructions(phaseTitle: string): string {
  return `Implement ONLY this phase of the spec: "${phaseTitle}". Mark that phase's emoji ✅ when done. Do not modify other phases.`;
}

/** Statuses where a job is live (no new job should be queued for the same spec/goal). */
export const ACTIVE_STATUSES: JobStatus[] = ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume"];

export function isActive(status: JobStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

type Admin = ReturnType<typeof createAdminClient>;

/**
 * fold-guard-live-build (Phase 1): the most recent NON-TERMINAL build/spec-test job for a spec, or null.
 *
 * The fold path refuses to archive a spec while one of these is alive — folding it would orphan the
 * running build (the spec markdown moves to archive.d/, so the paused build's spec page 404s the instant
 * the fold merges). Only `build`/`spec-test` kinds are a "live build of THIS spec": a fold job carries
 * `spec_slug='fold-batch'` (never the spec's slug) and a plan job keys on a goal slug, so neither matches.
 * Terminal jobs (completed/merged/failed/needs_attention) never block a fold.
 */
export async function getLiveJobForSlug(workspaceId: string, slug: string, adminClient?: Admin): Promise<AgentJob | null> {
  const admin = adminClient || createAdminClient();
  const { data } = await admin
    .from("agent_jobs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .in("kind", ["build", "spec-test"])
    .in("status", ACTIVE_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as AgentJob | null) ?? null;
}

/**
 * fold-guard-live-build (Phase 1) — cleanup backstop. When a spec has been archived (folded into the
 * brain → moved to docs/brain/archive.d/) any still-non-terminal build/spec-test job for that slug is an
 * ORPHAN: it lingers as a paused/active item whose spec page 404s and answering it is meaningless. Cancel
 * each (status → `completed` with a clear "spec archived" reason, questions/pending_actions cleared) so no
 * dead-link paused/active item survives. The preventive guard (getLiveJobForSlug, refused at the fold
 * path) makes this rare; this is the belt-and-suspenders that catches a race the gate missed.
 *
 * Global by default (archive.d/ is global); pass `workspaceId` to scope it (e.g. a board-load reconcile).
 * Idempotent — terminal jobs are never touched. Best-effort: a single failed update doesn't abort the rest.
 */
export async function cancelJobsForArchivedSpecs(opts?: { workspaceId?: string; admin?: Admin }): Promise<{ cancelled: number; slugs: string[] }> {
  const admin = opts?.admin || createAdminClient();
  const archived = await listArchivedSlugs();
  if (!archived.length) return { cancelled: 0, slugs: [] };

  let query = admin
    .from("agent_jobs")
    .select("id, spec_slug")
    .in("kind", ["build", "spec-test"])
    .in("status", ACTIVE_STATUSES)
    .in("spec_slug", archived);
  if (opts?.workspaceId) query = query.eq("workspace_id", opts.workspaceId);
  const { data, error } = await query;
  if (error || !data?.length) return { cancelled: 0, slugs: [] };

  const reason = "spec archived — build auto-cancelled (the spec was folded into the brain; its spec page no longer exists)";
  const slugs: string[] = [];
  for (const j of data as { id: string; spec_slug: string }[]) {
    const { error: upErr } = await admin
      .from("agent_jobs")
      .update({ status: "completed", error: reason, questions: [], pending_actions: [], updated_at: new Date().toISOString() })
      .eq("id", j.id);
    if (!upErr) slugs.push(j.spec_slug);
  }
  return { cancelled: slugs.length, slugs };
}

/** Latest plan job for a goal (newest wins) — drives the goal page's Plan/Re-plan control. */
export async function getLatestPlanJob(workspaceId: string, goalSlug: string): Promise<AgentJob | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("agent_jobs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("kind", "plan")
    .eq("spec_slug", goalSlug)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as AgentJob) ?? null;
}

/** A spec the owner marked verified, awaiting (or mid-) a batch fold-build (fold-build-batching).
 * `foldJob` is the kind='fold' job that will fold it (set once a job has claimed the batch). */
export interface PendingFold {
  spec_slug: string;
  status: "pending" | "folding" | "folded" | "failed";
  job_id: string | null;
  foldJob: AgentJob | null;
}

/**
 * Specs currently queued for / mid- a fold-build, keyed by spec slug. The board renders these as
 * "Folding…" instead of the verify button — the spec's own (build) job no longer maps 1:1 to a fold
 * (one fold PR retires N specs). Only live rows (pending|folding); folded/failed drop off.
 */
export async function getPendingFolds(workspaceId: string): Promise<Record<string, PendingFold>> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("pending_folds")
    .select("spec_slug, status, job_id")
    .eq("workspace_id", workspaceId)
    .in("status", ["pending", "folding"]);
  const rows = (data ?? []) as { spec_slug: string; status: PendingFold["status"]; job_id: string | null }[];
  if (!rows.length) return {};
  const jobIds = [...new Set(rows.map((r) => r.job_id).filter(Boolean))] as string[];
  const jobsById: Record<string, AgentJob> = {};
  if (jobIds.length) {
    const { data: jobs } = await admin.from("agent_jobs").select("*").in("id", jobIds);
    for (const j of (jobs ?? []) as AgentJob[]) jobsById[j.id] = j;
  }
  const map: Record<string, PendingFold> = {};
  for (const r of rows) {
    map[r.spec_slug] = { spec_slug: r.spec_slug, status: r.status, job_id: r.job_id, foldJob: r.job_id ? jobsById[r.job_id] ?? null : null };
  }
  return map;
}

/** Latest job per spec for a workspace (newest wins) — drives the board's per-card status. */
export async function getLatestJobsBySlug(workspaceId: string): Promise<Record<string, AgentJob>> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("agent_jobs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(500);
  const map: Record<string, AgentJob> = {};
  for (const j of (data ?? []) as AgentJob[]) {
    if (!map[j.spec_slug]) map[j.spec_slug] = j;
  }
  return map;
}

/**
 * dirty-pr-resolver-duplicate-detection (Phase 1) — the shared "is this spec's build already merged?"
 * probe. A build job flips to `status='merged'` once [[reconcileMergedJobs]] sees its PR merged (the work
 * landed on `main`). This finds a SIBLING build of the same spec that already merged — the signal that a
 * second, still-open/conflicting build for the spec is a DUPLICATE (its diff is already on main → it can
 * never resolve, and re-running it just re-ships the same work).
 *
 * Phase-scope safe: dedupes only against a merged build with the **same `instructions`** (when an
 * `instructions` filter is given), so a multi-phase chain (phase-1 merged, phase-2 building — different
 * `phaseScopedInstructions`) is NOT mistaken for a dup. Pass `excludeJobId`/`excludeBranch` to ignore the
 * job/branch being checked itself. Returns the merged sibling (id + branch + pr_number) or null.
 */
export async function findMergedSiblingBuild(
  workspaceId: string,
  slug: string,
  opts: { excludeJobId?: string; excludeBranch?: string | null; instructions?: string | null; admin?: Admin } = {},
): Promise<{ id: string; spec_branch: string | null; pr_number: number | null } | null> {
  const admin = opts.admin || createAdminClient();
  const { data } = await admin
    .from("agent_jobs")
    .select("id, spec_branch, pr_number, instructions")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("kind", "build")
    .eq("status", "merged")
    .order("created_at", { ascending: false })
    .limit(25);
  const rows = (data ?? []) as { id: string; spec_branch: string | null; pr_number: number | null; instructions: string | null }[];
  const norm = (s: string | null | undefined) => (s ?? "").trim();
  for (const r of rows) {
    if (opts.excludeJobId && r.id === opts.excludeJobId) continue;
    if (opts.excludeBranch && r.spec_branch === opts.excludeBranch) continue;
    // Only a merged build doing the SAME work (matching phase scope) counts as a duplicate.
    if (opts.instructions !== undefined && norm(r.instructions) !== norm(opts.instructions)) continue;
    return { id: r.id, spec_branch: r.spec_branch, pr_number: r.pr_number };
  }
  return null;
}

const GH_REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";
function ghToken() {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}

/**
 * Shared spec-test enqueue guard (spec-test-on-ship). Insert a `kind='spec-test'` agent_job for
 * (workspaceId, slug) IFF the spec is shipped-but-not-archived AND not already covered — no in-flight
 * spec-test job and no fresh `spec_test_runs` row (last ~20h). Idempotent + the single dedupe chokepoint
 * shared by all three enqueue paths: the daily backlog cron (spec-test-cron), the manual status flip
 * (/api/roadmap/status), and the build-merge reconcile (reconcileMergedJobs below). First caller wins;
 * the rest no-op. Re-running is allowed once the spec changes again (a fresh ship state past the window).
 *
 * `knownStatus` lets a caller that already holds the freshly-derived status pass it in — the cron and the
 * event paths know the spec is shipped without a disk re-read (the status route's local disk is even stale
 * vs. the just-committed content). Omit it to derive shipped-but-not-archived from disk.
 */
export async function enqueueSpecTestIfDue(
  workspaceId: string,
  slug: string,
  knownStatus?: Phase,
): Promise<{ enqueued: boolean; reason?: string }> {
  const admin = createAdminClient();

  // Shipped-but-not-archived? Trust a caller-supplied status; otherwise derive from the brain markdown.
  if (knownStatus !== undefined) {
    if (knownStatus !== "shipped") return { enqueued: false, reason: "not-shipped" };
  } else {
    const [spec, archived] = await Promise.all([getSpec(slug), listArchivedSlugs()]);
    if (!spec || spec.card.status !== "shipped") return { enqueued: false, reason: "not-shipped" };
    if (archived.includes(slug)) return { enqueued: false, reason: "archived" };
  }

  // Dedupe — skip a (workspace, slug) that already has an in-flight spec-test job…
  const { data: inflight } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("kind", "spec-test")
    .in("status", ["queued", "queued_resume", "building", "claimed"])
    .limit(1);
  if (inflight && inflight.length) return { enqueued: false, reason: "in-flight" };

  // …or a fresh run (tested in the last ~20h, matching the cron window).
  const since = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await admin
    .from("spec_test_runs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .gte("run_at", since)
    .limit(1);
  if (recent && recent.length) return { enqueued: false, reason: "fresh-run" };

  const { error } = await admin.from("agent_jobs").insert({
    workspace_id: workspaceId,
    spec_slug: slug,
    kind: "spec-test",
    status: "queued",
    created_by: null,
  });
  if (error) return { enqueued: false, reason: `insert-failed: ${error.message}` };
  return { enqueued: true };
}

/**
 * spec-blockers Phase 2 — auto-queue on unblock. A blocking spec `shippedSlug` just shipped (its build
 * PR merged + phases flipped ✅). Find every live spec that named it as a `Blocked-by` prerequisite and,
 * if that was its LAST uncleared blocker (every other blocker is now cleared too), auto-enqueue its build —
 * the chain goes fully hands-off: merge the prerequisite and the dependent build fires itself. Shares the
 * blockedBy resolution the board + the enqueue gate use (getRoadmap), treating `shippedSlug` as cleared
 * explicitly so a deploy-stale disk snapshot of its status doesn't suppress the unblock.
 *
 * Skips a dependent that's already shipped, that opted out (`**Auto-build:** off`), or that already has a
 * build job (dedupe — one auto-queue per spec; once a build row exists this no-ops on re-run, so it's safe
 * to call from reconcileMergedJobs on every board load). Inserts a `kind='build'` row with created_by=null
 * (an agent enqueue). Returns the slugs it queued.
 */
export async function autoQueueUnblockedBy(workspaceId: string, shippedSlug: string): Promise<string[]> {
  const { specs } = await getRoadmap();
  const dependents = specs.filter(
    (s) =>
      s.autoBuild !== false &&
      s.status !== "shipped" &&
      s.blockedBy.some((b) => b.slug === shippedSlug) &&
      // last blocker cleared? every other blocker already cleared, and shippedSlug counts as cleared now.
      s.blockedBy.every((b) => b.cleared || b.slug === shippedSlug),
  );
  if (!dependents.length) return [];

  const admin = createAdminClient();
  const queued: string[] = [];
  for (const dep of dependents) {
    // Dedupe: only auto-queue a spec with NO build job yet (any status). Once one exists — auto-queued
    // earlier, manually built, or in-flight — skip. This is the "one auto-queue per spec" guarantee.
    const { data: existing } = await admin
      .from("agent_jobs")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", dep.slug)
      .eq("kind", "build")
      .limit(1);
    if (existing && existing.length) continue;

    const { error } = await admin.from("agent_jobs").insert({
      workspace_id: workspaceId,
      spec_slug: dep.slug,
      kind: "build",
      status: "queued",
      created_by: null,
      instructions: `Auto-queued by spec-blockers: prerequisite ${shippedSlug} shipped, clearing the last blocker.`,
    });
    if (!error) queued.push(dep.slug);
  }
  return queued;
}

/**
 * build-all-phases-chain Phase 1 — advance a "Build all" chain. A chain-tagged build for `slug` just
 * merged (its phase's PR landed on `main` + the phase flipped ✅); queue the spec's NEXT ⏳ phase, also
 * `chain_phases`, scoped to that phase and built on fresh `main` (atop the prior phase's code). The chain
 * runs hands-off: each phase builds → auto-merges (auto-ship-pipeline) → queues the next, until none ⏳
 * remain (every phase ✅ = chain complete). A phase that FAILS or hits needs_approval never reaches
 * `merged`, so this is never called for it — the chain stops/pauses there with no explicit stop logic.
 *
 * Reads the spec from `main` via getSpec so it sees the just-merged phase as ✅ (and so a phase a prior
 * build left ⏳ is picked up next). Race/dup-guarded: skips if any build job for the spec is already in
 * flight (a chain already advanced, or a manual build is running) — reconcileMergedJobs flips a job
 * completed→merged once, so this normally fires once per phase; the guard covers concurrent board loads.
 * Returns the queued phase title, or null (chain done / nothing to queue). Best-effort; never throws.
 */
export async function queueNextChainedPhase(workspaceId: string, slug: string): Promise<string | null> {
  const spec = await getSpec(slug);
  if (!spec) return null;
  const next = spec.card.phases.find((p) => p.status === "planned");
  if (!next) return null; // no ⏳ phase left → the chain is complete (all phases ✅)
  const scoped = phaseScopedInstructions(next.title);

  const admin = createAdminClient();
  // Idempotency: never (re-)queue a phase that already has a build job (any status). Covers a re-run on a
  // later board load, an in-flight build of this phase, AND the narrow race where a few-seconds-stale `main`
  // read still shows the just-merged phase as ⏳ — the just-merged job carries this exact scoped instruction,
  // so it matches here and we skip rather than rebuilding the phase we just shipped.
  const { data: dup } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("kind", "build")
    .eq("instructions", scoped)
    .limit(1);
  if (dup && dup.length) return null;
  // Don't stack on any other in-flight build for this spec (e.g. a manual build running concurrently).
  const { data: active } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("kind", "build")
    .in("status", ACTIVE_STATUSES)
    .limit(1);
  if (active && active.length) return null;

  const { error } = await admin.from("agent_jobs").insert({
    workspace_id: workspaceId,
    spec_slug: slug,
    kind: "build",
    status: "queued",
    created_by: null,
    chain_phases: true,
    instructions: scoped,
  });
  if (error) return null;
  return next.title;
}

/**
 * fix-ship-retests-origin: a just-merged build whose spec carries a machine-readable `Fixes: {origin}`
 * link (stamped by the propose-fix flow) should auto-re-test the ORIGIN spec — the fix is now live, so the
 * origin's previously-failing spec-test check can flip ✅ and its stale "Agent-tested · issues" badge clears
 * with no manual re-queue. Reads the merged fix spec's markdown from `main`, parses its `Fixes:` link, and
 * enqueues the origin's spec-test through the shared `enqueueSpecTestIfDue` guard (deduped; the origin's own
 * shipped-but-not-archived gate still applies — derived from disk, no `knownStatus`).
 *
 * Re-test ONLY — never marks the origin verified/archived (the owner's gate); it just refreshes the QC
 * signal. A spec with no `Fixes:` link no-ops (back-compatible). A still-failing re-test keeps the red badge
 * correctly — the loop surfaces truth, it doesn't paper over it. Returns the origin slug iff a re-test was
 * actually enqueued (null otherwise). Best-effort: never throws on a missed fetch — the daily spec-test
 * backlog cron re-tests shipped specs anyway.
 */
export async function retestOriginIfFixMerged(workspaceId: string, fixSlug: string): Promise<string | null> {
  const fetched = await fetchSpecRawFromMain(fixSlug);
  if (!fetched) return null;
  const link = parseFixesLink(fetched.raw);
  if (!link || !link.origin || link.origin === fixSlug) return null; // no link / self-reference → no-op
  const res = await enqueueSpecTestIfDue(workspaceId, link.origin);
  return res.enqueued ? link.origin : null;
}

/**
 * Self-heal: a `completed` job whose PR was merged/closed OUTSIDE the dashboard (e.g. merged on
 * GitHub directly) still shows a stale "Squash & merge" button. Check GitHub; if the PR is no
 * longer open, flip the job to `merged` (mutates the passed jobs in place + persists).
 */
export async function reconcileMergedJobs(jobs: AgentJob[]): Promise<void> {
  const tok = ghToken();
  if (!tok) return;
  const stale = jobs.filter((j) => j.status === "completed" && j.pr_number);
  if (!stale.length) return;
  const admin = createAdminClient();
  await Promise.all(
    stale.map(async (j) => {
      try {
        const res = await fetch(`https://api.github.com/repos/${GH_REPO}/pulls/${j.pr_number}`, {
          headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json" },
          cache: "no-store",
        });
        if (!res.ok) return;
        const pr = (await res.json()) as { merged?: boolean; state?: string; merge_commit_sha?: string };
        if (pr.merged || pr.state === "closed") {
          j.status = "merged";
          await admin.from("agent_jobs").update({ status: "merged", updated_at: new Date().toISOString() }).eq("id", j.id);
          // spec-drift Part A (root fix): a merged build is supposed to flip the phase(s) it built ✅, but
          // doesn't reliably — so shipped work parks in Planned/In-progress. Run the per-phase, evidence-gated
          // reconciler against `main`: it stamps ✅ only on phases whose code is verifiably on main (a merged
          // build now exists for this spec), leaving genuinely-pending phases. This is where the drift
          // originates; closing it here means the cron backstop rarely has work. Returns the post-flip status.
          if (pr.merged && j.kind === "build") {
            try {
              const drift = await reconcileSpecDrift(j.workspace_id, j.spec_slug);
              // spec-card-db-companion: mirror the merge to the board the moment it happens — the card flips
              // to its post-merge status tagged `deploy_pending` with this merge's SHA, so it reads
              // "shipped · deploying" until a deployment carrying that SHA is live (no markdown-redeploy wait,
              // no webhook — the board clears it at read time via VERCEL_GIT_COMMIT_SHA). drift already mirrored
              // the per-phase snapshot; this overlays the merge SHA + deploy flag.
              await markSpecCardMergeShipped(j.workspace_id, j.spec_slug, {
                status: drift.status,
                mergeSha: pr.merge_commit_sha ?? null,
              });
              // spec-test-on-ship: if the corrected phases now read shipped, enqueue a spec-test (shared
              // dedupe no-ops if the cron/manual flip already did) + auto-queue any unblocked dependent.
              if (drift.status === "shipped") {
                await enqueueSpecTestIfDue(j.workspace_id, j.spec_slug, "shipped");
                // spec-blockers Phase 2: this spec just shipped → auto-queue any dependent whose last
                // blocker it was (de-duped, owner-opt-out-aware; no-ops if a build row already exists).
                await autoQueueUnblockedBy(j.workspace_id, j.spec_slug);
              }
            } catch {
              /* event missed → the daily backlog + spec-drift crons mop it up */
            }
            // build-all-phases-chain Phase 1: if THIS merged build was part of a "Build all" chain, queue
            // the next ⏳ phase (on fresh main, atop this phase's code). Outside the shipped-check above:
            // most phase merges leave the spec in_progress (more ⏳ phases remain) — the chain advances on
            // every phase merge, not only the final one. queueNextChainedPhase no-ops when no ⏳ phase is
            // left (all ✅ = chain done) or a build is already in flight (dedupe). A failed/needs_approval
            // phase never reaches `merged`, so the chain stops/pauses there with no explicit stop logic.
            if (j.chain_phases) {
              try {
                await queueNextChainedPhase(j.workspace_id, j.spec_slug);
              } catch {
                /* best-effort — the owner can re-tap Build all to resume the chain */
              }
            }
            // fix-ship-retests-origin: if THIS merged build's spec carries a `Fixes: {origin}` link, re-test
            // the origin so its stale "issues" badge clears once the fix is live (deduped; no link → no-op).
            try {
              await retestOriginIfFixMerged(j.workspace_id, j.spec_slug);
            } catch {
              /* best-effort — the daily spec-test backlog cron re-tests shipped specs anyway */
            }
          }
          // fold-guard-live-build (Phase 1): a just-merged FOLD just archived its batch of specs (their
          // markdown moved to archive.d/). Cancel any non-terminal build/spec-test job still pointing at an
          // archived spec so no orphaned paused/active item with a dead spec link survives — the fold-merge
          // reconcile half of the cleanup backstop (the worker reaper covers a box restart). Best-effort.
          if (pr.merged && j.kind === "fold") {
            try {
              const c = await cancelJobsForArchivedSpecs({ workspaceId: j.workspace_id, admin });
              if (c.cancelled) console.log(`[fold-reconcile] cancelled ${c.cancelled} orphaned job(s) for archived spec(s): ${c.slugs.join(", ")}`);
            } catch {
              /* best-effort — the worker reaper cancels these on next startup */
            }
          }
        }
      } catch {
        /* transient — try again next load */
      }
    }),
  );
}
