/**
 * agent_jobs — the build queue (server-side helpers). The dashboard "Build" button
 * inserts a row; the box worker claims it via claim_agent_job() and drives it to a PR.
 * See docs/brain/specs/roadmap-build-console.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getRoadmap, getSpec, listArchivedSlugs, type Phase } from "@/lib/brain-roadmap";
import { rollupPhaseStatus } from "@/lib/spec-card-state";
import { getSpec as getSpecFromDb, stampPhaseShipped, stampSpecMergeProvenance } from "@/lib/specs-table";

export type JobStatus =
  | "queued"
  | "claimed"
  | "building"
  | "needs_input"
  | "needs_approval"
  | "queued_resume"
  // `blocked_on_usage` (box-multi-account-failover): the worker parked this job because every Max account
  // hit its usage wall — it auto-resumes at the soonest reset. It is an ACTIVE (non-terminal) state: a
  // parked build is still a live build of its spec, so the fold-guard must treat it as such (otherwise a
  // chained next-phase build that is merely parked could be folded → orphaned). See ACTIVE_STATUSES.
  | "blocked_on_usage"
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
export type GatedActionType =
  | "apply_migration"
  | "run_prod_script"
  | "merge_pr"
  | "spec"
  | "migration_fix"
  | "repair_build"
  | "storefront_campaign"
  | "storefront_build"
  // box-agent-model-tiers P3: a governed model-tier change for one agent kind. The worker applies it
  // (agent_model_tiers upsert) on approval. Routing is by the TARGET agent kind (see target_kind), not
  // the proposal job kind, so a worker's change routes to its director and a director's to the CEO.
  | "apply_model_tier";

/** The agent_jobs.kind for a governed model-tier change awaiting supervisor approval (box-agent-model-tiers P3). */
export const MODEL_TIER_PROPOSAL_KIND = "proposed-model-tier";
/** The single pending-action type a `proposed-model-tier` job carries — the supervisor's plain approve/decline. */
export const APPLY_MODEL_TIER_ACTION_TYPE = "apply_model_tier";

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
  status: "pending" | "approved" | "declined" | "done" | "failed" | "reject_regen";
  result?: string;
  spec?: ProposedSpec; // set when type==='spec' (planner proposal)
  // set when type==='migration_fix' (migration-fix agent) — the typed billing repair the worker runs
  // through src/lib/migration-fix.ts `applyMigrationFix` on approval.
  fix_kind?: "price_reconcile" | "variant_backfill" | "appstle_cancel";
  payload?: unknown;
  // ── optimizer-hero-preview-gate (storefront-optimizer hero preview/reject-with-notes loop) ──
  // For a kind='hero' storefront_campaign action the approval is two-stage: 'concept' → the worker
  // generates a candidate hero and flips stage='preview', then the owner sees the image and either
  // approves it live or rejects-with-notes (status='reject_regen' + reject_notes) to regenerate.
  stage?: "concept" | "preview";
  preview_image_url?: string;
  preview_attempts?: { url: string; notes?: string; at: string }[];
  reject_notes?: string;
  // set when type==='apply_model_tier' (box-agent-model-tiers P3) — the agent kind whose tier this
  // proposal changes. Drives target-aware approval routing (worker→director, director→CEO) and the
  // worker's apply on approval. The proposed tier + evidence ride on `payload`.
  target_kind?: string;
}

/** 'build' (default — build a spec to a PR) | 'plan' (run plan-goal against a goal → propose specs)
 * | 'fold' (batch fold-build — fold every pending-fold spec into the brain in one PR, fold-build-batching)
 * | 'product-seed' (box-product-seeding — drive one product none→published on Max)
 * | 'ticket-improve' (box-ticket-improve — one turn of a ticket-bound Improve session on Max)
 * | 'migration-fix' (migration-fix-agent — fix a failed Appstle→internal migration on Max, gated)
 * | 'pr-resolve' (dirty-pr-resolver-agent — webhook-fired: merge main into a dirty claude/* PR, resolve
 *   conflicts, tsc-gate + push, or rebuild-on-main / surface to the owner)
 * | 'platform-director' (platform-director-agent — the first live director: investigate a Platform-routed
 *   Approval Request → auto-approve within the leash, else escalate to the CEO). */
export type JobKind = "build" | "plan" | "fold" | "product-seed" | "ticket-improve" | "migration-fix" | "pr-resolve" | "platform-director" | "security-review" | "proposed-model-tier" | "audit-spec-shipped-state" | "spec-review";

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
  // The build's scope/instructions (phaseScopedInstructions embeds "Phase N") — used by the merge hook to
  // attribute which phase(s) a merged PR shipped (phase-pr-provenance). Optional: not every select reads it.
  instructions?: string | null;
  // build-all-phases-chain Phase 1: a "Build all" build → its first ⏳ phase is tagged true; the
  // post-merge step queues the next ⏳ phase (also chain_phases) on merge, until all phases ✅. Default
  // false (single-phase / non-chained builds). May be undefined on a pre-migration row read.
  chain_phases?: boolean;
  // box-session-transparency Phase 1: the live TodoWrite mirror the shared `runBoxSession` runner streams
  // onto every job row while a `claude -p` session is active — Phase 2 renders these on the box card so an
  // active session is no longer a black box. NULL on a pre-migration job or a job that never produced a
  // TodoWrite event. `session_note` is the single one-line current-step verb (the compact chip line);
  // `session_checklist` is the full plan, ticked through as the agent works.
  session_checklist?: SessionChecklistItem[] | null;
  session_note?: string | null;
  created_at: string;
  updated_at: string;
}

/** A single TodoWrite item streamed onto agent_jobs by the shared box-session runner ([[../specs/box-session-transparency]] Phase 1).
 *  Shape mirrors what `scripts/builder-worker.ts → makeChecklistWriter` writes. `note` is the
 *  one-line plain-English present-continuous verb (the TodoWrite `activeForm`) — what the agent is
 *  doing + why — already trimmed/safe to render directly. */
export interface SessionChecklistItem {
  step: string;
  status: "pending" | "in_progress" | "done";
  note: string;
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

/** Statuses where a job is live (no new job should be queued for the same spec/goal). `blocked_on_usage`
 * is active: a job parked at the usage wall auto-resumes at reset, so it must not read as terminal (the
 * fold-guard + auto-fold gate would otherwise fold/orphan a spec whose chained next-phase build is merely
 * parked). Mirrors the worker's own ACTIVE_JOB_STATUSES (scripts/builder-worker.ts). */
export const ACTIVE_STATUSES: JobStatus[] = ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume", "blocked_on_usage"];

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
// The board card shows the spec's BUILD-pipeline state. Director/meta jobs (a spec-status flip, a security
// review, a model-tier proposal) are NOT the spec's build — if one is the most recent job it must not MASK
// the real build. (Observed: a `platform-director` job completed → the card read "Built" while the actual
// build sat in needs_approval, so a CEO-gated migration was invisible.) The per-card picker skips them.
const NON_CARD_JOB_KINDS: JobKind[] = ["platform-director", "security-review", "proposed-model-tier"];

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
    if (NON_CARD_JOB_KINDS.includes(j.kind)) continue; // a director/meta job is not the spec's build state
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

/** The job statuses that prove a branch was BUILT SUCCESSFULLY: the worker only flips a build/fold/
 * pr-resolve job to `completed` after its pre-push `tsc --noEmit` passed and the PR opened cleanly,
 * and to `merged` once that PR landed. Every other status is a partial/errored/paused/parked build. */
export const SUCCESSFUL_BUILD_STATUSES: JobStatus[] = ["completed", "merged"];

/** The job kinds that OWN a claude/* PR branch (each sets `spec_branch` to the branch). */
const BRANCH_OWNING_KINDS: JobKind[] = ["build", "fold", "pr-resolve"];

/**
 * optimizer-launch-hardening Phase 2 — the auto-merge SUCCESS GATE. The repo has no CI workflows and
 * no branch protection, so GitHub reports `mergeable_state==="clean"` for ANY non-conflicting claude/*
 * PR — a vacuous signal that proves nothing about the build. The real proof a build succeeded is its
 * OWN agent_job: the worker drives the branch's job to `completed` only after its pre-push
 * `tsc --noEmit` passed and the PR opened cleanly (→ `merged` once it lands). A branch whose owning
 * job is anything else — `building`/`queued`/`queued_resume` (partial push), `failed`/`needs_attention`
 * (errored post-push), `needs_input`/`needs_approval` (paused mid-build), `blocked_on_usage` (parked) —
 * or a branch with NO owning job (a manual / untracked push) has NOT passed that gate and must NOT
 * auto-merge unreviewed.
 *
 * Returns the verdict for the NEWEST branch-owning job (build/fold/pr-resolve — the kinds that set
 * `spec_branch` to the PR branch; a stale dirty-PR resolve that just cleaned the branch is its newest
 * job and reads `completed` correctly). `ok:false` ⇒ leave the PR for the owner. Fails CLOSED: a read
 * error or a missing job returns `ok:false` (never auto-merge on an unknown).
 */
export async function getBranchBuildSuccess(
  branch: string,
  adminClient?: Admin,
): Promise<{ ok: boolean; status: JobStatus | null; reason: string }> {
  if (!branch || !branch.startsWith("claude/")) {
    return { ok: false, status: null, reason: "not a claude/* branch" };
  }
  try {
    const admin = adminClient || createAdminClient();
    const { data } = await admin
      .from("agent_jobs")
      .select("status, kind")
      .eq("spec_branch", branch)
      .in("kind", BRANCH_OWNING_KINDS)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const job = data as { status: JobStatus; kind: JobKind } | null;
    if (!job) return { ok: false, status: null, reason: "no build job owns this branch (manual/untracked push)" };
    if (SUCCESSFUL_BUILD_STATUSES.includes(job.status)) {
      return { ok: true, status: job.status, reason: `${job.kind} job ${job.status}` };
    }
    return { ok: false, status: job.status, reason: `${job.kind} job is ${job.status} (not completed/merged)` };
  } catch (e) {
    return { ok: false, status: null, reason: `build-job lookup failed: ${e instanceof Error ? e.message : e}` };
  }
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
    // spec-status-db-driven Phase 1: pass workspaceId so the DB mirror's status wins (it's the source
    // of truth post-backfill; the markdown lags by a deploy or — after Phase 3 — has no status at all).
    const [spec, archived] = await Promise.all([getSpec(slug, workspaceId), listArchivedSlugs()]);
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
  // spec-status-db-driven Phase 1: overlay the DB mirror so a just-shipped prerequisite (DB-only flip)
  // unblocks dependents this render — no deploy wait for the markdown emoji to land.
  const { specs } = await getRoadmap(workspaceId);
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
 * fix-ship-retests-origin: a just-merged build whose spec is a regression fix for an ORIGIN spec should
 * auto-re-test that origin — the fix is now live, so the origin's previously-failing spec-test check can
 * flip ✅ and its stale "Agent-tested · issues" badge clears with no manual re-queue. Reads the typed
 * `specs.regression_of_slug` provenance column directly (retire-md-reads-from-pm-flow Phase 2 — no more
 * `**Fixes:**` markdown line fetch + parse), and enqueues the origin's spec-test through the shared
 * `enqueueSpecTestIfDue` guard (deduped; the origin's own shipped-but-not-archived gate still applies).
 *
 * Re-test ONLY — never marks the origin verified/archived (the owner's gate); it just refreshes the QC
 * signal. A spec with no `regression_of_slug` no-ops (back-compatible — the propose_fix flow's
 * `**Regression-of:** [[origin]]` header populates the column when the spec is authored). A still-failing
 * re-test keeps the red badge correctly — the loop surfaces truth, it doesn't paper over it. Returns the
 * origin slug iff a re-test was actually enqueued (null otherwise). Best-effort: never throws on a missed
 * read — the daily spec-test backlog cron re-tests shipped specs anyway.
 */
export async function retestOriginIfFixMerged(workspaceId: string, fixSlug: string): Promise<string | null> {
  const spec = await getSpecFromDb(workspaceId, fixSlug);
  if (!spec) return null;
  const origin = spec.regression_of_slug;
  if (!origin || origin === fixSlug) return null; // no link / self-reference → no-op
  const res = await enqueueSpecTestIfDue(workspaceId, origin);
  return res.enqueued ? origin : null;
}

/**
 * The post-merge effects of a merged `kind='build'` job — the shared body run by BOTH paths that flip a
 * build to `merged`: the board-render reconcile ([[reconcileMergedJobs]], for a manual squash-merge) and
 * the auto-merge webhook path ([[handleAutoMergedBuildBranch]], auto-ship-pipeline). Extracting it keeps
 * the two identical so the chain + the spec advance the same whether a human or the auto-merge gate landed
 * the PR (chain-and-cardstate-under-automerge Phase 1). Steps, each best-effort/idempotent:
 *
 *   1. 100% DB-DRIVEN — read the spec from `public.specs` + `public.spec_phases` via the specs-table SDK
 *      ([[../libraries/specs-table]] `getSpec`). NO `spec_card_state` mirror read, NO markdown/spec-drift
 *      read: the legacy reconcileSpecDrift path read the mirror, which a DB-authored spec has no row in, so
 *      it stamped NOTHING — every DB-authored spec landed "built-unstamped". TRUST THE MERGE: stamp the
 *      phase(s) this merge shipped (the build's named `Phase N`, else the first not-yet-shipped) via
 *      `stampPhaseShipped`, tagging each with the PR # + merge SHA. The leaf write advances the now-DERIVED
 *      `specs.status` (the DB rollup trigger is gone — status derives from `spec_phases` at read time). A
 *      one-shot spec (zero phases) records its card-level PR on `specs.merged_pr` / `last_merge_sha`.
 *   2. when the resulting rollup is FULLY shipped (rollup === shipped): enqueue its spec-test + auto-queue any
 *      dependent it just unblocked;
 *   3. if this was a `chain_phases` "Build all" build: queue the next ⏳ phase (the chain advances off the
 *      merge itself, no board render required). queueNextChainedPhase no-ops when none ⏳ remain or a build is
 *      already in flight, so a double-run (both paths) queues exactly one next phase;
 *   4. re-test the origin spec if this build carries a `Fixes:` link.
 *
 * Never throws — every sub-step swallows its own error (the daily spec-test crons backstop).
 */
/**
 * director-initiation-throughput Phase 3 — the event-driven top-up. A just-merged build FREED a lane;
 * enqueue ONE `platform-director` standing-pass job so the freed lane refills within seconds instead of
 * waiting up to the (now 5-min) cron beat. Deduped on a PENDING pass (queued / queued_resume) so a burst
 * of merges adds at most one waiting pass — a pass already mid-run still gets a fresh follow-up queued so
 * it re-saturates after it finishes, but two never pile up. Best-effort; never throws. Returns whether it
 * queued one.
 */
export async function enqueueDirectorTopUp(workspaceId: string, adminClient?: Admin): Promise<boolean> {
  const admin = adminClient || createAdminClient();
  try {
    const { data: pending } = await admin
      .from("agent_jobs")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("kind", "platform-director")
      .in("status", ["queued", "queued_resume"])
      .limit(1);
    if (pending && pending.length) return false; // a pass is already waiting — it'll see the freed lane
    const { error } = await admin.from("agent_jobs").insert({
      workspace_id: workspaceId,
      spec_slug: "platform-director",
      kind: "platform-director",
      status: "queued",
      created_by: null,
      instructions: "event-driven top-up: a build merged + freed a lane — refill the pool to saturation (director-initiation-throughput Phase 3)",
    });
    return !error;
  } catch {
    return false; // best-effort — the 5-min cron backstop refills regardless
  }
}

/** Phase indices (0-based) a build's instructions name — "Phase 2 — …" → [1]; a single PR may name several. */
function parsePhaseIndices(instructions: string | null | undefined, count: number): number[] {
  if (!instructions) return [];
  const idxs = new Set<number>();
  for (const m of instructions.matchAll(/\bPhase\s+(\d+)\b/gi)) {
    const i = parseInt(m[1], 10) - 1;
    if (i >= 0 && i < count) idxs.add(i);
  }
  return [...idxs];
}

export async function applyMergedBuildEffects(
  workspaceId: string,
  slug: string,
  opts: { chainPhases?: boolean; mergeSha?: string | null; prNumber?: number | null; instructions?: string | null },
): Promise<void> {
  try {
    const pr = opts.prNumber ?? null;
    const sha = opts.mergeSha ?? null;
    // 100% DB-DRIVEN (db-driven PM layer): read the spec from `public.specs` + `public.spec_phases` via the
    // SDK — NO `spec_card_state` mirror, NO markdown/spec-drift read. A DB-authored spec has no mirror row, so
    // the old reconcileSpecDrift path saw an empty phase set and stamped NOTHING — every DB-authored spec
    // landed "built-unstamped". We trust the merge and stamp the phase(s) it shipped directly on the DB.
    const spec = await getSpecFromDb(workspaceId, slug);
    if (!spec) return; // no DB spec row → nothing to advance (the daily backlog cron backstops)
    const phases = spec.phases; // 1-indexed by `position`, ordered ASC
    // TRUST THE MERGE + TAG ITS PROVENANCE (phase-pr-provenance). A single PR/merge can ship SEVERAL phases at
    // once, but builds ship a spec phase-by-phase — so never blanket-ship. Which phase(s) did THIS merge ship?
    //   (1) the phase(s) the build's instructions NAME ("Phase N", possibly several) — mapped to positions;
    //   (2) else the FIRST not-yet-shipped phase (lowest position whose status isn't shipped/rejected).
    // Tag EACH shipped phase with this PR # + merge SHA so "shipped" is provable, not inferred.
    const shippedPositions = new Set<number>();
    const named = parsePhaseIndices(opts.instructions, phases.length); // 0-based indices
    if (named.length) {
      // map named 0-based indices → phase positions (1-indexed `position`, ordered ASC)
      for (const i of named) {
        const p = phases[i];
        if (p) shippedPositions.add(p.position);
      }
    } else {
      const next = phases.find((p) => p.status !== "shipped" && p.status !== "rejected");
      if (next) shippedPositions.add(next.position);
    }
    // Stamp each shipped phase's status + PR/SHA provenance through the SDK — the only status-write path.
    // This leaf write is what advances the now-DERIVED spec status (the DB rollup trigger is gone — status
    // derives from `spec_phases` at read time). No raw PM SQL (pm-db-agent-toolkit invariant).
    if (shippedPositions.size) {
      await Promise.all(
        [...shippedPositions].map((position) => stampPhaseShipped(workspaceId, slug, position, { pr, merge_sha: sha })),
      );
    }
    // Compute the resulting rollup over the post-stamp phase statuses so the downstream gates still fire.
    // A spec with phases: roll up its (now-stamped) phases. A one-shot spec (zero phases): a single-PR ship
    // IS the whole spec → shipped. Record the one-shot card-level provenance on `public.specs` (the canonical
    // `merged_pr` / `last_merge_sha` columns — there's no phase slot to carry it) via the SDK admin client.
    let rolled: Phase;
    if (phases.length) {
      rolled = rollupPhaseStatus(
        phases.map((p) => ({
          index: p.position - 1,
          title: p.title,
          status: shippedPositions.has(p.position) ? ("shipped" as Phase) : p.status,
        })),
      );
    } else {
      rolled = "shipped"; // one-shot spec — the single merge ships it
      // Record the card-level provenance through the specs-table SDK (no raw PM SQL — pm-db-agent-toolkit).
      await stampSpecMergeProvenance(workspaceId, slug, { pr, merge_sha: sha });
    }
    if (rolled === "shipped") {
      await enqueueSpecTestIfDue(workspaceId, slug, "shipped");
      await autoQueueUnblockedBy(workspaceId, slug);
    }
  } catch {
    /* event missed → the daily backlog + spec-test crons mop it up */
  }
  // security-dependency-agent Phase 1: give EVERY merged claude/* diff an autonomous security pass — the
  // supervisor on the auto-merge proxy (the unguarded half auto-merge opened). Fires on every merged build
  // (not only fully-shipped phases — each merged diff is reviewed), deduped by the merge SHA so the two
  // merge-hook paths (manual reconcile + auto-merge webhook) never double-file. Best-effort; never blocks.
  try {
    if (opts.mergeSha) {
      const { enqueueSecurityReviewJob } = await import("@/lib/security-agent");
      await enqueueSecurityReviewJob(createAdminClient(), { mergeSha: opts.mergeSha, specSlug: slug, workspaceId });
    }
  } catch {
    /* best-effort — a missed security pass is caught by the next merged diff, never blocks the merge */
  }
  // build-all-phases-chain: advance a "Build all" chain on this phase's merge (on fresh main, atop this
  // phase's code). Outside the shipped-check above — most phase merges leave the spec in_progress (more ⏳
  // phases remain) and the chain advances on every phase merge, not only the final one.
  if (opts.chainPhases) {
    try {
      await queueNextChainedPhase(workspaceId, slug);
    } catch {
      /* best-effort — the owner can re-tap Build all to resume the chain */
    }
  }
  // fix-ship-retests-origin: if this merged build's spec carries a `Fixes: {origin}` link, re-test the
  // origin so its stale "issues" badge clears once the fix is live (deduped; no link → no-op).
  try {
    await retestOriginIfFixMerged(workspaceId, slug);
  } catch {
    /* best-effort — the daily spec-test backlog cron re-tests shipped specs anyway */
  }
  // director-initiation-throughput Phase 3: this merge freed a build lane — trigger an event-driven director
  // top-up so the pool re-saturates within seconds instead of waiting for the cron beat. Deduped + best-effort.
  try {
    await enqueueDirectorTopUp(workspaceId);
  } catch {
    /* best-effort — the 5-min platform-director-cron backstop refills the pool regardless */
  }
}

/**
 * chain-and-cardstate-under-automerge Phase 1 — the auto-merge path's post-merge hook. When the GitHub
 * webhook's auto-merge gate (auto-ship-pipeline, [[github-pr-resolve]]) squash-merges a claude/* build PR
 * SERVER-SIDE, advance the same post-merge state a board render would — without waiting for one. Maps the
 * merged branch → its `kind='build'` job, flips it to `merged`, and runs [[applyMergedBuildEffects]] (rollup
 * card-state + chain advance + spec-test/unblock). This is what makes "Build all" hands-off under auto-merge:
 * P1 auto-merges → P2 auto-queues inside the webhook window, no click, no board load.
 *
 * Idempotent: a job already `merged` is skipped — and because reconcileMergedJobs only acts on `completed`
 * jobs, flipping it here means that path never double-fires; every effect inside is itself deduped besides,
 * so it's safe even if both paths race. Best-effort: never throws. Returns the advanced spec slug, or null
 * (no build job for the branch / already handled).
 */
export async function handleAutoMergedBuildBranch(branch: string, mergeSha: string | null): Promise<string | null> {
  if (!branch) return null;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("agent_jobs")
      .select("*")
      .eq("spec_branch", branch)
      .eq("kind", "build")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const job = data as AgentJob | null;
    if (!job || job.status === "merged") return null; // no build for this branch / already handled
    await admin.from("agent_jobs").update({ status: "merged", updated_at: new Date().toISOString() }).eq("id", job.id);
    await applyMergedBuildEffects(job.workspace_id, job.spec_slug, {
      chainPhases: !!job.chain_phases,
      mergeSha,
      prNumber: job.pr_number ?? null,
      instructions: job.instructions ?? null,
    });
    return job.spec_slug;
  } catch {
    return null; // best-effort — reconcileMergedJobs is the board-render backstop for this branch
  }
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
          // spec-drift Part A (root fix): a merged build is supposed to flip the phase(s) it built ✅ +
          // advance the board / the chain, but the board-render reconcile is the only trigger here. Run the
          // shared post-merge effects (drift reconcile against main → rollup card-state → spec-test/unblock →
          // chain advance → fix re-test) — the SAME body the auto-merge webhook path runs, so a manual
          // squash-merge lands identically to an auto-merge. Idempotent; this only fires on the
          // completed→merged transition (a job the auto-merge path already flipped `merged` is never `completed`
          // here, so the two never double-run for one merge).
          if (pr.merged && j.kind === "build") {
            await applyMergedBuildEffects(j.workspace_id, j.spec_slug, {
              chainPhases: j.chain_phases,
              mergeSha: pr.merge_commit_sha ?? null,
              prNumber: j.pr_number ?? null,
              instructions: j.instructions ?? null,
            });
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
