/**
 * agent_jobs — the build queue (server-side helpers). The dashboard "Build" button
 * inserts a row; the box worker claims it via claim_agent_job() and drives it to a PR.
 * See docs/brain/specs/roadmap-build-console.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getRoadmap, getSpec, listArchivedSlugs, type Phase } from "@/lib/brain-roadmap";
import { rollupPhaseStatus } from "@/lib/spec-card-state";
import { getSpec as getSpecFromDb, stampPhaseShipped, stampSpecMergeProvenance, isSpecAccumulationComplete } from "@/lib/specs-table";

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
): Promise<{
  ok: boolean;
  status: JobStatus | null;
  reason: string;
  /** The branch-owning job's `workspace_id` (M4 promote-on-green Phase 1 — the TESTS gate needs it to read
   *  per-branch spec-test green; same row, no extra query). Null when no owning job was found. */
  workspaceId: string | null;
  /** The branch-owning job's `spec_slug` (M4 promote-on-green Phase 1 — the TESTS gate needs it to read
   *  per-branch spec-test green). Null when no owning job was found. */
  specSlug: string | null;
}> {
  if (!branch || !branch.startsWith("claude/")) {
    return { ok: false, status: null, reason: "not a claude/* branch", workspaceId: null, specSlug: null };
  }
  try {
    const admin = adminClient || createAdminClient();
    const { data } = await admin
      .from("agent_jobs")
      .select("status, kind, workspace_id, spec_slug")
      .eq("spec_branch", branch)
      .in("kind", BRANCH_OWNING_KINDS)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const job = data as { status: JobStatus; kind: JobKind; workspace_id: string; spec_slug: string } | null;
    if (!job) {
      return { ok: false, status: null, reason: "no build job owns this branch (manual/untracked push)", workspaceId: null, specSlug: null };
    }
    if (SUCCESSFUL_BUILD_STATUSES.includes(job.status)) {
      return { ok: true, status: job.status, reason: `${job.kind} job ${job.status}`, workspaceId: job.workspace_id, specSlug: job.spec_slug };
    }
    return {
      ok: false,
      status: job.status,
      reason: `${job.kind} job is ${job.status} (not completed/merged)`,
      workspaceId: job.workspace_id,
      specSlug: job.spec_slug,
    };
  } catch (e) {
    return { ok: false, status: null, reason: `build-job lookup failed: ${e instanceof Error ? e.message : e}`, workspaceId: null, specSlug: null };
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
 * Pre-merge spec-test enqueue ([[../specs/spec-test-on-preview-pre-merge]] Phase 1) — the SIBLING of
 * `enqueueSpecTestIfDue` for the PRE-MERGE lane. When a `claude/*` build reaches a READY per-build
 * preview (its `preview_url` is set by [[per-build-vercel-preview-deploys]] Phase 2) and the branch
 * is still unmerged, this enqueues ONE `kind='spec-test'` `agent_jobs` row carrying:
 *   - `spec_branch` = the build's `claude/*` branch (so the runner reads the branch's spec body, not
 *     `main`'s) — the field [[getBranchBuildSuccess]] / [[findMergedSiblingBuild]] already index on.
 *   - the preview origin in `instructions` (and in `preview_url` when that column is present) — the
 *     runner's non-destructive GET / browser checks then hit the `*.vercel.app` PREVIEW deployment,
 *     not prod (Phase 2 wires the runner to read it).
 *
 * Mirrors `enqueueSpecTestIfDue`'s dedupe shape, but keyed per **(workspace, slug, branch)**: a
 * pre-merge run on branch A doesn't block a pre-merge run on branch B (different builds of the same
 * spec), and a re-run for the same branch (board refresh, webhook re-fire) no-ops instead of stacking
 * a duplicate row. No shipped-but-not-archived gate — pre-merge is BY DEFINITION not-yet-shipped. The
 * post-ship lane keeps its own (workspace, slug) chokepoint above; the pre-merge dedupe is a
 * STRICTLY-NARROWER key, so the two never collide. First caller wins; the rest no-op.
 */
export async function enqueuePreMergeSpecTest(
  workspaceId: string,
  slug: string,
  branch: string,
  previewUrl: string,
): Promise<{ enqueued: boolean; reason?: string }> {
  if (!branch || !branch.startsWith("claude/")) return { enqueued: false, reason: "not a claude/* branch" };
  const origin = (previewUrl || "").replace(/\/$/, "");
  if (!origin) return { enqueued: false, reason: "no preview_url" };

  const admin = createAdminClient();

  // Dedupe — skip if a spec-test job already exists for (workspace, slug, branch). Mirrors the
  // `enqueueSpecTestIfDue` chokepoint shape (a `.from("agent_jobs").select("id")` SQL probe + first
  // hit wins), but the key is per-BRANCH: a still-open OR an already-finished pre-merge run for the
  // same branch is the SAME code under test, so re-running pre-merge would just re-test the same
  // preview. A fresh commit lands a new preview deployment but the dedupe is per-branch so the run
  // history stays attached to it; the M3 green-signal helper picks the LATEST `spec_test_runs` row
  // for (slug, branch) regardless.
  const { data: existing } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("kind", "spec-test")
    .eq("spec_branch", branch)
    .limit(1);
  if (existing && existing.length) return { enqueued: false, reason: "in-flight" };

  // The runner reads the preview origin from `instructions` (Phase 2 threads it through). We also
  // best-effort-set `preview_url` for symmetry with the build's column — harmless if M1's column
  // isn't present yet (Supabase ignores an unknown insert key in our schema cache, surfaced only via
  // its row-error path; we treat any insert error as a guarded surface — see below).
  const instructions = `Run the spec-test against the PER-BUILD PREVIEW deployment for branch \`${branch}\`. Preview origin: ${origin}. This is a PRE-MERGE verification — every GET / browser-check / deploy-log probe must hit the preview origin (NOT prod). The runner's contract is otherwise unchanged: emit one JSON verdict, NEVER mutate.`;
  const insertRow: Record<string, unknown> = {
    workspace_id: workspaceId,
    spec_slug: slug,
    kind: "spec-test",
    status: "queued",
    spec_branch: branch,
    instructions,
    created_by: null,
    preview_url: origin,
  };
  const { error } = await admin.from("agent_jobs").insert(insertRow);
  if (error) return { enqueued: false, reason: `insert-failed: ${error.message}` };
  return { enqueued: true };
}

/**
 * spec-goal-branch-pm-flow M3 — the pre-merge spec-test TRIGGER. Under the branch-accumulation model a
 * spec's phases build one-by-one onto ONE persistent `claude/build-{slug}` branch, each push firing a
 * per-build Vercel preview deploy ([[preview-capture]]). We want the spec-test to run ONCE — against the
 * WHOLE built spec on its branch preview — not per phase. So the trigger is: **the spec is FULLY
 * accumulated on its branch (every phase carries a `build_sha` / is terminal — [[../libraries/specs-table]]
 * `isSpecAccumulationComplete`) AND a preview URL exists.**
 *
 * The worker calls this from the preview-capture poll's READY callback: when the LAST phase's preview goes
 * READY, accumulation is complete → enqueue. Earlier phases' previews also go READY, but accumulation is
 * NOT yet complete then, so this no-ops until the final phase lands. It also re-runs idempotently — a board
 * refresh / re-poll calls it again, and the underlying [[enqueuePreMergeSpecTest]] dedupes per
 * `(workspace, slug, branch)`, so at most one pre-merge run is queued per branch.
 *
 * The spec-test then materializes the spec from the DB row ([[build-spec-materializer]] reads
 * `public.specs` + `spec_phases`, which M1/M2 stamped from the BRANCH commits) and points its HTTP probes
 * at `previewUrl` — so it tests the actual built spec on its branch preview, NOT main.
 *
 * Best-effort + never throws: a trigger hiccup must never fail the build it's chained off. Returns the
 * enqueue outcome (or a skip reason).
 */
export async function maybeEnqueuePreMergeSpecTestOnAccumulation(args: {
  workspaceId: string;
  slug: string;
  branch: string | null;
  previewUrl: string | null;
}): Promise<{ enqueued: boolean; reason?: string }> {
  const { workspaceId, slug, branch, previewUrl } = args;
  try {
    if (!branch || !branch.startsWith("claude/")) return { enqueued: false, reason: "not a claude/* branch" };
    const origin = (previewUrl || "").replace(/\/$/, "");
    if (!origin) return { enqueued: false, reason: "no preview URL yet" };
    // Only fire once the WHOLE spec is built on the branch — testing a half-accumulated branch would test a
    // partial spec. Same predicate the auto-merge accumulation gate + isSpecPromoteEligible read.
    const acc = await isSpecAccumulationComplete(workspaceId, slug);
    if (!acc.complete) return { enqueued: false, reason: `not fully accumulated yet (${acc.reason})` };
    return await enqueuePreMergeSpecTest(workspaceId, slug, branch, origin);
  } catch (e) {
    return { enqueued: false, reason: `trigger errored: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * security-test-on-preview-pre-merge Phase 1 (the WIRING the spec never landed) — the pre-merge SECURITY
 * trigger, the security twin of `maybeEnqueuePreMergeSpecTestOnAccumulation`. Both pre-merge signals
 * (`isSpecTestGreenForBranch` ∧ `isSecurityGreenForBranch`) gate `isSpecPromoteEligible` + the M4 auto-merge
 * tests gate; the spec-test leg was wired into the preview-ready hook, but the security leg's enqueue
 * (`enqueueSecurityReviewJob` branch mode) was authored (Phase 1 lib) and its signal helper shipped
 * (Phase 3) — yet NO caller ever invoked the branch-mode enqueue, so `isSecurityGreenForBranch` was
 * ALWAYS false and the M4 gate could never pass (every one-off PR sat `in_testing`). This is that caller.
 *
 * Same accumulation predicate as the spec-test twin (test the WHOLE built spec on its branch preview, not a
 * partial). Idempotent (branch-mode enqueue dedupes one open review per branch). Best-effort + never throws.
 */
export async function maybeEnqueuePreMergeSecurityOnAccumulation(args: {
  workspaceId: string;
  slug: string;
  branch: string | null;
  previewUrl: string | null;
  prNumber?: number | null;
}): Promise<{ enqueued: boolean; reason?: string }> {
  const { workspaceId, slug, branch, previewUrl, prNumber } = args;
  try {
    if (!branch || !branch.startsWith("claude/")) return { enqueued: false, reason: "not a claude/* branch" };
    const origin = (previewUrl || "").replace(/\/$/, "");
    if (!origin) return { enqueued: false, reason: "no preview URL yet" };
    const acc = await isSpecAccumulationComplete(workspaceId, slug);
    if (!acc.complete) return { enqueued: false, reason: `not fully accumulated yet (${acc.reason})` };
    const { enqueueSecurityReviewJob } = await import("@/lib/security-agent");
    return await enqueueSecurityReviewJob(createAdminClient(), {
      branch,
      previewOrigin: origin,
      specSlug: slug,
      prNumber: prNumber ?? null,
      workspaceId,
    });
  } catch (e) {
    return { enqueued: false, reason: `trigger errored: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * STANDING-PASS BACKSTOP for BOTH pre-merge triggers (spec-test + security). The Gate-A class gap: both
 * pre-merge enqueues fire ONLY from the build's fire-and-forget preview-capture READY callback. If that
 * poll misses READY (worker restart mid-poll, a slow/late preview, a transient Vercel/DB hiccup) the
 * enqueue never happens — and (for security) it had no caller at all — so a fully-built branch sits
 * `in_testing` forever (the same standing-pass-backstop gap Gate-A had: event-only, no re-evaluation).
 *
 * This is the reliable re-evaluation: every standing pass, enumerate the latest build job per
 * `claude/build-{slug}` branch that carries a READY preview, and (idempotently) fire BOTH pre-merge
 * triggers for any fully-accumulated branch. The underlying enqueues dedupe (spec-test per
 * (workspace, slug, branch); security one-open-review per branch), so re-running every pass is safe + cheap.
 * Mirrors `promoteEligibleSpecsToGoalBranch`'s candidate-enumeration shape. Best-effort per branch; never throws.
 */
export interface PreMergeBackstopResult {
  /** branches whose pre-merge spec-test was (re-)enqueued this pass. */
  specTestEnqueued: string[];
  /** branches whose pre-merge security review was (re-)enqueued this pass. */
  securityEnqueued: string[];
  /** candidate branches scanned (READY-preview claude/build-* branches, deduped per slug). */
  scanned: number;
}

export async function backstopPreMergeChecks(adminClient?: Admin): Promise<PreMergeBackstopResult> {
  const out: PreMergeBackstopResult = { specTestEnqueued: [], securityEnqueued: [], scanned: 0 };
  const admin = adminClient || createAdminClient();
  try {
    // vault-security-review-loop-fix: pre-merge checks are an IN-FLIGHT-ONLY concern. A spec that has
    // SHIPPED (its branch merged to main) or FOLDED (archived into the brain) no longer needs a pre-merge
    // gate — its `claude/build-*` branch may still carry a READY preview, but re-running spec-test /
    // security on it every standing pass is pure waste. This was the Vault re-review loop: a folded/shipped
    // spec's stale READY-preview branch got a fresh security-review enqueued each pass, forever (observed on
    // spec-test-request-fix-inline-author-and-approve + in-testing-board-and-lifecycle-timeline). The
    // archived-slug set is built once up front so the per-branch test is a cheap lookup.
    const archivedSlugs = new Set(await listArchivedSlugs());
    const { data: jobs } = await admin
      .from("agent_jobs")
      .select("id, workspace_id, spec_slug, spec_branch, status, preview_url, preview_state, pr_number, pr_url, created_at")
      .eq("kind", "build")
      .not("spec_branch", "is", null)
      .order("created_at", { ascending: false });
    const seen = new Set<string>();
    for (const j of (jobs ?? []) as Array<{
      id: string;
      workspace_id: string;
      spec_slug: string;
      spec_branch: string;
      status: JobStatus;
      preview_url: string | null;
      preview_state: string | null;
      pr_number: number | null;
      pr_url: string | null;
    }>) {
      const slug = j.spec_slug;
      const branch = j.spec_branch;
      if (!slug || !branch || !branch.startsWith("claude/build-")) continue;
      const key = `${j.workspace_id}:${slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // vault-security-review-loop-fix: skip a spec that is no longer in-flight. Archived (folded) drops out
      // by slug; shipped/folded drop out by DB status. Either way pre-merge gating is meaningless — the spec
      // already merged/folded — so don't (re-)enqueue spec-test or security for it. (Checked BEFORE the
      // preview-state branch so the no-preview RECOVERY path below also honours it.)
      if (archivedSlugs.has(slug)) continue;
      // ⭐ vault-security-review-loop-fix (MERGED-SPEC SKIP — post-merge backstop loop fix): a build whose PR is
      // already MERGED has its `claude/build-*` branch DELETED, so a pre-merge spec-test / security review of it
      // is meaningless — it reviews a gone branch ("[security] reviewing unmerged branch …" for a deleted ref,
      // wasting Max sessions every pass). The `spec.status === shipped/folded` guard below is NOT enough: a spec
      // whose merge stamped only ONE phase (the BUG 1 case) still reads `in_progress`/`planned` even though its
      // PR merged, so the security loop ran forever (noop-pipeline-test-4 / #837). Skip on the actual MERGE
      // signal: the latest build job for the slug is `merged`, OR a merged sibling build exists for the slug.
      if (j.status === "merged") continue;
      const mergedSibling = await findMergedSiblingBuild(j.workspace_id, slug, { admin });
      if (mergedSibling) continue;
      const specRow = await getSpecFromDb(j.workspace_id, slug).catch(() => null);
      if (specRow && (specRow.status === "shipped" || specRow.status === "folded")) continue;

      let previewUrl = j.preview_url;
      // ⭐ NO-CAPTURED-PREVIEW RECOVERY (fix: a resume-after-approval finalize never captures the branch tip's
      // preview, so its build row carries no READY preview and the READY-only scan below skips it forever —
      // the noop-pipeline-test-4 / #837 stall). When the LATEST build row for an in-flight spec has no READY
      // preview, this is the case the push-path poll missed: capture the branch tip's preview onto THIS row
      // ON DEMAND, then fall through to the normal trigger. Gated tight so we don't hammer Vercel every pass:
      // only when the spec is FULLY ACCUMULATED, has an OPEN PR, and has NO spec-test run yet for this branch
      // (and no in-flight spec-test job — enqueuePreMergeSpecTest dedupes that, but we also skip the Vercel
      // call when a run already exists). Idempotent: capturePreviewUrlForJob only advances the row forward.
      if (j.preview_state !== "READY" || !previewUrl) {
        try {
          if (!j.pr_url && !j.pr_number) continue; // no open PR → not yet at the accumulation-complete gate
          const acc = await isSpecAccumulationComplete(j.workspace_id, slug);
          if (!acc.complete) continue; // still accumulating → the push-path poll will fire when the last phase lands
          // Already have a spec-test run for this branch? Then a preview was captured at least once and the
          // normal lane is handling it — no need to re-poll Vercel. (A missing run is the #837 signature.)
          const { data: existingRun } = await admin
            .from("spec_test_runs")
            .select("id")
            .eq("workspace_id", j.workspace_id)
            .eq("spec_slug", slug)
            .eq("spec_branch", branch)
            .limit(1);
          if (existingRun && existingRun.length) continue;
          const { capturePreviewUrlForJob } = await import("@/lib/preview-capture");
          const cap = await capturePreviewUrlForJob({ jobId: j.id, branch, commitSha: null });
          if (cap.previewState !== "READY" || !cap.previewUrl) continue; // preview not READY yet → next pass
          previewUrl = cap.previewUrl;
          console.log(`[pre-merge-backstop] captured missing preview for ${branch} → ${cap.previewUrl}`);
        } catch (e) {
          console.warn(`[pre-merge-backstop] preview recovery for ${branch} failed (skipping):`, e instanceof Error ? e.message : e);
          continue;
        }
      }
      out.scanned++;
      try {
        const st = await maybeEnqueuePreMergeSpecTestOnAccumulation({
          workspaceId: j.workspace_id,
          slug,
          branch,
          previewUrl,
        });
        if (st.enqueued) out.specTestEnqueued.push(branch);
      } catch {
        /* best-effort per branch */
      }
      try {
        const sec = await maybeEnqueuePreMergeSecurityOnAccumulation({
          workspaceId: j.workspace_id,
          slug,
          branch,
          previewUrl,
          prNumber: j.pr_number,
        });
        if (sec.enqueued) out.securityEnqueued.push(branch);
      } catch {
        /* best-effort per branch */
      }
    }
  } catch (e) {
    console.warn("[pre-merge-backstop] scan threw (continuing):", e instanceof Error ? e.message : e);
  }
  return out;
}

/**
 * spec-goal-branch-pm-flow M3 — the PROMOTE-ELIGIBILITY signal M4 consumes. A branch-flow spec is
 * promote-eligible (its `claude/build-{slug}` branch is ready to merge spec→goal) iff ALL THREE hold:
 *
 *   1. **accumulation-complete** (M2) — every phase is built on the branch ([[../libraries/specs-table]]
 *      `isSpecAccumulationComplete`).
 *   2. **spec-test green on the branch preview** (M3) — the latest pre-merge `spec_test_runs` row for
 *      `(workspace, slug, branch)` is a clean machine pass ([[spec-test-runs]] `isSpecTestGreenForBranch`).
 *   3. **security green on the branch** — the latest per-branch security-review rollup is `completedClean`
 *      ([[security-agent]] `isSecurityGreenForBranch`).
 *
 * These are the SAME three signals the [[github-pr-resolve]] auto-merge gate already enforces inline (the
 * accumulation gate + the tests gate), and the SAME spec-test/security predicates the [[brain-roadmap]]
 * `applyInTestingOverlay` derives `in_testing` from — so the board, the auto-merge gate, and this helper can
 * never disagree on "is the spec done testing?". This is the clean seam M4 (spec→goal merge) reads to decide
 * whether to promote; it performs NO action itself (read-only).
 *
 * Fails CLOSED on the green signals (a read error / absent run ⇒ not green ⇒ not eligible) but the
 * accumulation input fails OPEN (a PM-read blip on the phase rollup doesn't wedge an otherwise-green spec;
 * the green signals still gate the actual promotion). Returns `{ eligible, accumulationComplete,
 * specTestGreen, securityGreen, reason }` so the caller can surface WHY a spec isn't yet promote-eligible.
 */
export interface SpecPromoteEligibility {
  eligible: boolean;
  accumulationComplete: boolean;
  specTestGreen: boolean;
  securityGreen: boolean;
  reason: string;
}

export async function isSpecPromoteEligible(
  workspaceId: string,
  slug: string,
  branch: string,
): Promise<SpecPromoteEligibility> {
  const out: SpecPromoteEligibility = {
    eligible: false,
    accumulationComplete: false,
    specTestGreen: false,
    securityGreen: false,
    reason: "",
  };
  if (!workspaceId || !slug || !branch || !branch.startsWith("claude/")) {
    out.reason = "missing workspace/slug or not a claude/* branch";
    return out;
  }
  const admin = createAdminClient();
  // Accumulation (M2) — fail OPEN (a PM blip mustn't wedge a green spec; the green signals still gate).
  const acc = await isSpecAccumulationComplete(workspaceId, slug);
  out.accumulationComplete = acc.complete;
  // Green signals (M3) — fail CLOSED: a read error or an absent per-branch run reads as NOT green.
  try {
    const { isSpecTestGreenForBranch } = await import("@/lib/spec-test-runs");
    out.specTestGreen = await isSpecTestGreenForBranch(workspaceId, slug, branch);
  } catch (e) {
    out.specTestGreen = false;
    out.reason = `spec-test green read failed (treated not-green): ${e instanceof Error ? e.message : String(e)}`;
  }
  try {
    const { isSecurityGreenForBranch } = await import("@/lib/security-agent");
    out.securityGreen = await isSecurityGreenForBranch(admin, branch);
  } catch (e) {
    out.securityGreen = false;
    out.reason = out.reason || `security green read failed (treated not-green): ${e instanceof Error ? e.message : String(e)}`;
  }
  out.eligible = out.accumulationComplete && out.specTestGreen && out.securityGreen;
  if (!out.reason) {
    out.reason = out.eligible
      ? "promote-eligible: accumulation-complete + spec-test green + security green"
      : [
          out.accumulationComplete ? null : `not fully accumulated (${acc.reason})`,
          out.specTestGreen ? null : "spec-test not green on branch preview",
          out.securityGreen ? null : "security not green on branch",
        ]
          .filter(Boolean)
          .join("; ");
  }
  return out;
}

/**
 * spec-goal-branch-pm-flow M4 — resolve the GOAL SLUG a spec belongs to (or null if it's a one-off / not
 * goal-bound). A spec is goal-bound via `specs.milestone_id → goal_milestones.goal_id → goals.slug`. Returns
 * the goal's slug, or null when the spec has no milestone (one-off) or the chain can't be resolved. Read-only,
 * goals-table-only (no raw PM SQL). Used by the spec→goal promote (which goal branch to merge into) AND the
 * claim-time gate (are two specs goal-MATES — same goal?).
 */
export async function resolveGoalSlugForSpec(workspaceId: string, slug: string): Promise<string | null> {
  try {
    const spec = await getSpecFromDb(workspaceId, slug);
    if (!spec || !spec.milestone_id) return null;
    const admin = createAdminClient();
    const { data: ms } = await admin
      .from("goal_milestones")
      .select("goal_id")
      .eq("id", spec.milestone_id)
      .maybeSingle();
    const goalId = (ms as { goal_id?: string } | null)?.goal_id;
    if (!goalId) return null;
    const { data: goal } = await admin.from("goals").select("slug").eq("id", goalId).maybeSingle();
    return (goal as { slug?: string } | null)?.slug ?? null;
  } catch {
    return null;
  }
}

/**
 * spec-goal-branch-pm-flow M4 — are two specs GOAL-MATES (members of the SAME goal)? The claim-time
 * blocked_by gate uses this to pick the right blocker-clearance: a goal-mate blocker is cleared when it's ON
 * the goal branch (it never ships to main until M5's atomic goal promotion); an EXTERNAL blocker (one-off / a
 * different goal) is cleared only when shipped. Both specs must resolve to the SAME non-null goal slug.
 */
export async function areSpecsGoalMates(workspaceId: string, slugA: string, slugB: string): Promise<boolean> {
  const [ga, gb] = await Promise.all([
    resolveGoalSlugForSpec(workspaceId, slugA),
    resolveGoalSlugForSpec(workspaceId, slugB),
  ]);
  return ga !== null && ga === gb;
}

export interface GoalBranchPromoteResult {
  /** spec slugs whose `claude/build-{slug}` branch was merged onto their goal branch this pass (+ stamped). */
  promoted: string[];
  /** spec slugs that hit a merge CONFLICT — surfaced (NOT dropped), left for the owner / a resolver. */
  conflicts: string[];
  /** goal slugs whose `goal/{slug}` branch was seeded from origin/main this pass (the first spec of a goal). */
  goalBranchesCreated: string[];
  /** spec slugs that were promote-eligible but skipped (already on the goal branch, or a transient error). */
  skipped: string[];
}

/**
 * spec-goal-branch-pm-flow M4 — the spec→goal-branch promotion poll. For every GOAL-BOUND spec that is
 * `isSpecPromoteEligible` (accumulation-complete ∧ spec-test-green ∧ security-green on its
 * `claude/build-{slug}` branch — M3's seam) and not yet on its goal branch, merge that branch into
 * `goal/{goal-slug}` (created from origin/main by the FIRST spec of the goal) and stamp `specs.goal_branch_sha`
 * with the merge commit (the M5-consumed marker).
 *
 * Structured like `autoMergeReadyPrs` / `reconcileMergedJobs` — list the candidate branch-owning build jobs,
 * gate each, act on the eligible ones — and runs in the SAME two contexts (the box worker standing pass AND
 * the Vercel github webhook). It uses the GitHub `/merges` API (no local checkout), so it works from either.
 *
 * SEQUENCING: merges are ordered by `blocked_by` (a dependency lands on the goal branch before its dependent),
 * so a dependent spec — which BUILDS off the goal branch (runBuildJob's goal-bound base) — sees its
 * dependency's code. A spec whose goal-mate blocker is NOT yet on the goal branch is DEFERRED to a later pass
 * (its blocker promotes first, then it). ONE merge per spec (idempotent — a re-run skips an already-stamped
 * spec; the `/merges` 204 path is also idempotent).
 *
 * Does NOT push the goal branch to main — that's M5's atomic goal→main promotion. M4 only integrates eligible
 * specs onto their goal branch and records the marker. Conflicts are surfaced (`conflicts[]`), never silently
 * dropped. Best-effort per spec — one spec's failure never blocks the rest. Never throws.
 */
export async function promoteEligibleSpecsToGoalBranch(adminClient?: Admin): Promise<GoalBranchPromoteResult> {
  const result: GoalBranchPromoteResult = { promoted: [], conflicts: [], goalBranchesCreated: [], skipped: [] };
  const admin = adminClient || createAdminClient();
  if (!ghToken()) return result;
  try {
    const { mergeSpecBranchIntoGoalBranch } = await import("@/lib/github-pr-resolve");
    const { isSpecOnGoalBranch, stampSpecGoalBranchSha } = await import("@/lib/specs-table");

    // Candidate set: live build jobs that own a `claude/build-{slug}` branch (the spec-branch flow). One per
    // slug (the latest), so a re-dispatched build doesn't double-list. We then gate each candidate on
    // goal-bound + promote-eligible + not-already-on-goal-branch.
    const { data: jobs } = await admin
      .from("agent_jobs")
      .select("workspace_id, spec_slug, spec_branch, created_at")
      .eq("kind", "build")
      .not("spec_branch", "is", null)
      .order("created_at", { ascending: false });
    const seen = new Set<string>();
    type Cand = { workspaceId: string; slug: string; branch: string; goalSlug: string };
    const candidates: Cand[] = [];
    for (const j of (jobs ?? []) as { workspace_id: string; spec_slug: string; spec_branch: string }[]) {
      const slug = j.spec_slug;
      const branch = j.spec_branch;
      if (!slug || !branch || !branch.startsWith("claude/build-")) continue;
      const key = `${j.workspace_id}:${slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const goalSlug = await resolveGoalSlugForSpec(j.workspace_id, slug);
      if (!goalSlug) continue; // one-off / not goal-bound — M4 is goal-branch integration only
      // Already on the goal branch? skip (idempotent — one merge per spec).
      if (await isSpecOnGoalBranch(j.workspace_id, slug)) continue;
      // Promote-eligible (M3 seam)? accumulation ∧ spec-test green ∧ security green on the branch.
      const elig = await isSpecPromoteEligible(j.workspace_id, slug, branch);
      if (!elig.eligible) continue;
      candidates.push({ workspaceId: j.workspace_id, slug, branch, goalSlug });
    }
    if (!candidates.length) return result;

    // Sequence by blocked_by: a candidate whose goal-mate blocker is ALSO a pending candidate must merge AFTER
    // it (dependency lands on the goal branch first). Topologically order within each (workspace, goal). A
    // candidate whose goal-mate blocker is NOT yet on the goal branch and is NOT a pending candidate is
    // DEFERRED (its blocker promotes in a later pass first).
    const ordered = await sequencePromoteCandidates(admin, candidates);

    for (const c of ordered) {
      try {
        const merge = await mergeSpecBranchIntoGoalBranch(c.branch, c.goalSlug);
        if (merge.created) result.goalBranchesCreated.push(c.goalSlug);
        if (merge.conflict) {
          result.conflicts.push(c.slug);
          console.warn(`[goal-promote] ${c.slug} → goal/${c.goalSlug}: CONFLICT — surfaced, not dropped (${merge.reason})`);
          continue;
        }
        if (!merge.merged || !merge.mergeSha) {
          result.skipped.push(c.slug);
          console.warn(`[goal-promote] ${c.slug} → goal/${c.goalSlug}: not merged (${merge.reason ?? "unknown"})`);
          continue;
        }
        await stampSpecGoalBranchSha(c.workspaceId, c.slug, merge.mergeSha);
        result.promoted.push(c.slug);
        console.log(
          `[goal-promote] merged ${c.branch} → goal/${c.goalSlug}${merge.created ? " (seeded from main)" : ""}; stamped goal_branch_sha=${merge.mergeSha.slice(0, 8)}`,
        );
      } catch (e) {
        result.skipped.push(c.slug);
        console.warn(`[goal-promote] ${c.slug} promote threw (continuing):`, e instanceof Error ? e.message : e);
      }
    }
    return result;
  } catch (e) {
    console.error("[goal-promote] pass failed:", e instanceof Error ? e.message : e);
    return result;
  }
}

/**
 * spec-goal-branch-pm-flow M4 — order the promote candidates so a dependency lands on its goal branch BEFORE
 * its dependent. Within each (workspace, goal) the candidates form a DAG over `blocked_by`; we Kahn-sort it.
 * A candidate whose goal-mate blocker is neither already on the goal branch nor a pending candidate is
 * DEFERRED out of this pass (its blocker must promote first; a later pass picks it up once the blocker is on
 * the branch). Cross-goal / one-off blockers are ignored here (they're cleared by shipping, handled by the
 * claim-time gate — they don't gate goal-branch ordering). Best-effort: a cycle (shouldn't happen) falls back
 * to the input order so it never wedges.
 */
async function sequencePromoteCandidates(
  admin: Admin,
  candidates: { workspaceId: string; slug: string; branch: string; goalSlug: string }[],
): Promise<{ workspaceId: string; slug: string; branch: string; goalSlug: string }[]> {
  const { isSpecOnGoalBranch } = await import("@/lib/specs-table");
  const out: typeof candidates = [];
  const done = new Set<string>(); // keys merged onto the goal branch (already-on-branch ∪ emitted this pass)

  // Pre-seed `done` with goal-mates already on the goal branch + read each candidate's blocked_by.
  const blockersByKey = new Map<string, string[]>();
  for (const c of candidates) {
    const spec = await getSpecFromDb(c.workspaceId, c.slug);
    blockersByKey.set(`${c.workspaceId}:${c.slug}`, spec?.blocked_by ?? []);
  }

  // A blocker "satisfied for ordering" = it's a goal-mate of c that is already on the goal branch, OR it is
  // not a goal-mate at all (external — not our concern here). A goal-mate blocker that's a PENDING candidate
  // must be emitted first (it stays unsatisfied until we emit it). Iterate to a fixpoint (Kahn).
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const c of candidates) {
      const key = `${c.workspaceId}:${c.slug}`;
      if (done.has(key)) continue;
      const blockers = blockersByKey.get(key) ?? [];
      let ready = true;
      for (const bSlug of blockers) {
        const bKey = `${c.workspaceId}:${bSlug}`;
        const bGoal = await resolveGoalSlugForSpec(c.workspaceId, bSlug);
        if (bGoal !== c.goalSlug) continue; // external/cross-goal blocker — not a goal-branch ordering edge
        // Goal-mate blocker: ready only if it's already on the branch OR we've emitted it this pass.
        if (done.has(bKey)) continue;
        if (await isSpecOnGoalBranch(c.workspaceId, bSlug)) {
          done.add(bKey); // memoize so the inner loop is cheap on the next candidate
          continue;
        }
        // Not on the branch + not yet emitted. If it's a pending candidate, wait for it; otherwise DEFER c
        // this pass (its blocker isn't even a candidate — it'll promote in a future pass first).
        ready = false;
        break;
      }
      if (ready && !out.some((o) => `${o.workspaceId}:${o.slug}` === key)) {
        out.push(c);
        done.add(key);
        progressed = true;
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// spec-goal-branch-pm-flow M5 — the ATOMIC promotion (goal branch → main + the shipped stamp).
//
// M1–M4 built: per-spec branch accumulation (build_sha) → per-spec promote-eligibility (accumulation ∧
// spec-test-green ∧ security-green) → integration onto a per-goal branch `goal/{goal-slug}` (goal_branch_sha).
// M5 is the last hop: when a goal is COMPLETE on its goal branch (every member spec on the branch) AND GREEN,
// merge the goal branch → main in ONE atomic merge and flip EVERY member phase to `shipped` (M5 is the ONLY
// shipped-writer), then trigger the fold pipeline for the now-shipped specs.
//
// A PARENT goal (contains sub-goals, no direct buildable specs — e.g. CEO Mode) is EXEMPT: it has no goal
// branch to merge; its children promote independently. `isGoalParentExempt` skips it.
// ─────────────────────────────────────────────────────────────────────────────

export interface GoalPromotionEffects {
  /** spec slugs whose phases were all flipped to `shipped` (stamped with the goal→main merge SHA). */
  stampedSpecs: string[];
  /** total phases flipped to shipped across all member specs this promotion. */
  phasesStamped: number;
  /** spec slugs whose post-ship fold pipeline was triggered (enqueueSpecTestIfDue → fold gate). */
  foldsTriggered: string[];
}

/**
 * spec-goal-branch-pm-flow M5 — the PROMOTION EFFECTS of an atomic goal→main merge: flip EVERY phase of
 * EVERY member spec of `goalSlug` to `shipped`, tagged with `merge_sha = mergeSha` (the main merge commit),
 * then trigger the existing fold pipeline for the now-shipped specs.
 *
 * This is the ONLY shipped-writer in the flow (M2–M4 reserved `status='shipped'` + `merge_sha` for exactly
 * this moment — build_sha'd / in_progress phases stay in_progress until HERE). It reuses `stampPhaseShipped`
 * per phase (SDK-only — no raw PM SQL). After stamping, the read-time rollup makes each spec derive `shipped`
 * and the goal derive `complete` (no rollup trigger — status is read-derived since 20260725160000).
 *
 * Then it mirrors `applyMergedBuildEffects`'s post-ship hook: `enqueueSpecTestIfDue(ws, slug, "shipped")` per
 * shipped spec — the entry to the fold pipeline (the spec-test runs against the now-on-main code; on green the
 * fold gate archives the spec into the brain). Best-effort per spec — one spec's stamp/fold failure never
 * blocks the rest. Idempotent: a phase already `shipped`/`rejected` is left as-is (stampPhaseShipped is a
 * targeted update; re-stamping shipped is inert), so a re-run after a partial promotion converges.
 */
export async function applyGoalPromotionEffects(
  workspaceId: string,
  goalSlug: string,
  mergeSha: string,
): Promise<GoalPromotionEffects> {
  const out: GoalPromotionEffects = { stampedSpecs: [], phasesStamped: 0, foldsTriggered: [] };
  const { goalBranchState } = await import("@/lib/specs-table");
  // The member specs of the goal (via goal → milestones → specs). goalBranchState already resolves them.
  const state = await goalBranchState(workspaceId, goalSlug);
  for (const memberSpec of state.specs) {
    const slug = memberSpec.slug;
    try {
      const spec = await getSpecFromDb(workspaceId, slug);
      if (!spec) continue;
      const phases = spec.phases ?? []; // 1-indexed by position
      // Flip every NON-terminal phase to shipped with the main merge SHA (the only shipped-writer). A phase
      // already shipped/rejected is left untouched (idempotent). A one-shot spec (zero phases) records its
      // card-level provenance instead — there's no phase slot to carry merge_sha.
      const toStamp = phases.filter((p) => p.status !== "shipped" && p.status !== "rejected");
      if (toStamp.length) {
        await Promise.all(
          toStamp.map((p) => stampPhaseShipped(workspaceId, slug, p.position, { merge_sha: mergeSha, pr: null })),
        );
        out.phasesStamped += toStamp.length;
      } else if (!phases.length) {
        await stampSpecMergeProvenance(workspaceId, slug, { pr: null, merge_sha: mergeSha });
      }
      out.stampedSpecs.push(slug);
      // Trigger the fold pipeline for the now-shipped spec (mirror applyMergedBuildEffects' post-ship hook).
      try {
        const r = await enqueueSpecTestIfDue(workspaceId, slug, "shipped");
        if (r.enqueued) out.foldsTriggered.push(slug);
      } catch (e) {
        console.warn(`[goal-promote-effects] ${slug} fold-trigger failed (continuing):`, e instanceof Error ? e.message : e);
      }
      // A just-shipped spec may be the last blocker of a dependent — release any newly-unblocked dependents.
      try {
        await autoQueueUnblockedBy(workspaceId, slug);
      } catch (e) {
        console.warn(`[goal-promote-effects] ${slug} unblock sweep failed (continuing):`, e instanceof Error ? e.message : e);
      }
    } catch (e) {
      console.warn(`[goal-promote-effects] ${goalSlug}/${slug} stamp failed (continuing):`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}

/**
 * spec-goal-branch-pm-flow M5 — the build-console workspace (the one that runs builds = owns the goals/specs
 * we promote). Mirrors github-pr-resolve.resolveBuildWorkspaceId: the newest agent_jobs row's workspace,
 * falling back to the first workspace. M4 never needed this (it iterates build jobs, each carrying its own
 * workspace_id); M5 iterates GOALS, which need a workspace to resolve.
 */
async function resolveBuildConsoleWorkspace(admin: Admin): Promise<string | null> {
  const { data: jobRow } = await admin
    .from("agent_jobs")
    .select("workspace_id")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if ((jobRow as { workspace_id?: string } | null)?.workspace_id) return (jobRow as { workspace_id: string }).workspace_id;
  const { data: ws } = await admin.from("workspaces").select("id").limit(1).maybeSingle();
  return (ws as { id?: string } | null)?.id ?? null;
}

export interface PromoteGoalsToMainResult {
  /** goal slugs atomically merged to main this pass + had all member phases stamped shipped. */
  promoted: string[];
  /** goal slugs that were complete+green but hit a goal→main CONFLICT — surfaced, promotion HELD (not stamped). */
  conflicts: string[];
  /** goal slugs SKIPPED as parent-goal-exempt (contain sub-goals / no buildable specs — children promote alone). */
  parentExempt: string[];
  /** goal slugs evaluated but NOT promoted (not all specs on the goal branch yet, or a member not promote-eligible). */
  notReady: string[];
  /** per promoted goal, the shipped-stamp summary. */
  effects: Record<string, GoalPromotionEffects>;
}

/**
 * spec-goal-branch-pm-flow M5 — the standing pass that ATOMICALLY promotes COMPLETE goals to main. The
 * mirror of M4's `promoteEligibleSpecsToGoalBranch`, one hop further: M4 integrates eligible spec branches
 * onto their goal branch; M5 promotes a COMPLETE goal branch to main and stamps shipped.
 *
 * For each GREENLIT goal in the build-console workspace:
 *   1. PARENT-GOAL EXEMPTION — skip a parent goal (`isGoalParentExempt`: is_parent flag OR has child goals OR
 *      no buildable specs). It has no goal branch to merge; its child goals promote independently. (Part 4.)
 *   2. GOAL-COMPLETE — require `goalBranchState(goalSlug).allOnGoalBranch` (every member spec on the goal
 *      branch). Otherwise NOT ready (a member is still building / not yet integrated). (Part 1.)
 *   3. GREEN (option b — combination-verified, no extra preview deploys) — additionally require EVERY member
 *      spec to be individually `isSpecPromoteEligible` on its own branch (accumulation ∧ spec-test-green ∧
 *      security-green — already tested), and the ATOMIC `mergeGoalBranchIntoMain` itself is the final
 *      combination check (it only lands on a clean merge to main; a 409 HOLDS the promotion). Since each
 *      dependent spec BUILDS off the goal branch (M4 ordering), the integrated whole was compiled together by
 *      the worker's per-build tsc gate — so the COMBINATION is verified, not only the parts.
 *   4. PROMOTE — merge `goal/{slug}` → main in ONE merge; on success run `applyGoalPromotionEffects` (flip
 *      every member phase to shipped with the main merge SHA + trigger the fold pipeline). (Parts 1+2.)
 *
 * Runs from the SAME seams M4 uses (the box worker standing pass + the Gate-B github webhook). GitHub
 * `/merges` API only (no local checkout) so it works in both. SERIALIZED-friendly + idempotent: a goal whose
 * branch is already on main merges as a 204 (no-op) and re-stamps inertly. Best-effort per goal — one goal's
 * failure never blocks the rest. Never throws. Does NOT promote a parent goal, a not-yet-complete goal, or a
 * goal with any not-promote-eligible member.
 */
export async function promoteCompleteGoalsToMain(adminClient?: Admin): Promise<PromoteGoalsToMainResult> {
  const result: PromoteGoalsToMainResult = { promoted: [], conflicts: [], parentExempt: [], notReady: [], effects: {} };
  const admin = adminClient || createAdminClient();
  if (!ghToken()) return result;
  try {
    const { listGoals, isGoalParentExempt } = await import("@/lib/goals-table");
    const { goalBranchState } = await import("@/lib/specs-table");
    const { mergeGoalBranchIntoMain } = await import("@/lib/github-pr-resolve");

    // Resolve the build-console workspace (the one that runs builds = owns the goals/specs we promote). One
    // workspace per build console; the newest agent_jobs row's workspace, falling back to the first workspace
    // (mirrors github-pr-resolve.resolveBuildWorkspaceId — the same system-level resolution the webhook uses).
    const workspaceId = await resolveBuildConsoleWorkspace(admin);
    if (!workspaceId) return result;

    // Candidate goals: GREENLIT (CEO-approved) goals in the workspace. A `complete`-derived goal is also fine
    // to re-evaluate (idempotent), but `proposed`/`folded` goals are never promoted.
    const goals = await listGoals(workspaceId, {});
    for (const goal of goals) {
      if (goal.status === "proposed" || goal.status === "folded") continue;
      const goalSlug = goal.slug;
      try {
        // (1) Parent-goal exemption — never atomic-promote a parent (its children promote independently).
        const exempt = await isGoalParentExempt(workspaceId, goalSlug);
        if (exempt.exempt) {
          result.parentExempt.push(goalSlug);
          continue;
        }
        // (2) Goal-complete on the branch — every member spec integrated onto the goal branch.
        const state = await goalBranchState(workspaceId, goalSlug);
        if (!state.allOnGoalBranch) {
          result.notReady.push(goalSlug);
          continue;
        }
        // (3) GREEN (option b) — every member spec individually promote-eligible on its own branch. (The atomic
        //     merge below is the final combination check.) A member that isn't promote-eligible HOLDS the goal.
        let allEligible = true;
        for (const memberSpec of state.specs) {
          const branch = `claude/build-${memberSpec.slug}`;
          const elig = await isSpecPromoteEligible(workspaceId, memberSpec.slug, branch);
          if (!elig.eligible) {
            allEligible = false;
            console.warn(`[goal-main-promote] ${goalSlug}: member ${memberSpec.slug} not promote-eligible (${elig.reason}) — holding goal`);
            break;
          }
        }
        if (!allEligible) {
          result.notReady.push(goalSlug);
          continue;
        }
        // (4) ATOMIC promote: merge goal/{slug} → main in ONE merge.
        const merge = await mergeGoalBranchIntoMain(goalSlug);
        if (merge.conflict) {
          result.conflicts.push(goalSlug);
          console.warn(`[goal-main-promote] ${goalSlug}: goal→main CONFLICT — promotion HELD, NOT stamped (${merge.reason})`);
          continue;
        }
        if (merge.missingBranch) {
          // No goal branch (shouldn't reach here — allOnGoalBranch implies a branch — but be safe).
          result.notReady.push(goalSlug);
          continue;
        }
        if (!merge.merged || !merge.mergeSha) {
          result.notReady.push(goalSlug);
          console.warn(`[goal-main-promote] ${goalSlug}: not merged (${merge.reason ?? "unknown"})`);
          continue;
        }
        // Reva (deploy-guardian) — open an ATOMIC deploy-watch over the goal→main deploy BEFORE the shipped
        // stamp/fold (the watch snapshots the pre-deploy baseline; do it as close to the merge as possible).
        // This is the highest-blast-radius deploy in the system (a whole goal's many specs in one merge), and
        // it was previously UNWATCHED — Gate A's watch only covers per-spec `claude/*` merges, which goal-bound
        // specs no longer take. An atomic watch ESCALATES a regression instead of auto-reverting a whole goal
        // (the regression bar is tuned for tiny per-phase diffs). Best-effort — never blocks the promotion.
        try {
          const { openDeployWatch } = await import("@/lib/deploy-guardian");
          await openDeployWatch({
            admin,
            branch: `goal/${goalSlug}`,
            mergeSha: merge.mergeSha,
            workspaceId,
            slug: goalSlug,
            isAtomic: true,
          });
        } catch (e) {
          console.warn(`[goal-main-promote] ${goalSlug} deploy-watch open failed (continuing):`, e instanceof Error ? e.message : e);
        }
        // Promotion effects — the SHIPPED stamp (the only shipped-writer) + fold trigger.
        const effects = await applyGoalPromotionEffects(workspaceId, goalSlug, merge.mergeSha);
        result.promoted.push(goalSlug);
        result.effects[goalSlug] = effects;
        console.log(
          `[goal-main-promote] ATOMIC promoted ${goalSlug} → main (${merge.mergeSha.slice(0, 8)}); stamped ${effects.phasesStamped} phase(s) across ${effects.stampedSpecs.length} spec(s) shipped; folds: ${effects.foldsTriggered.join(", ") || "—"}`,
        );
      } catch (e) {
        result.notReady.push(goalSlug);
        console.warn(`[goal-main-promote] ${goalSlug} promote threw (continuing):`, e instanceof Error ? e.message : e);
      }
    }
    return result;
  } catch (e) {
    console.error("[goal-main-promote] pass failed:", e instanceof Error ? e.message : e);
    return result;
  }
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
  // Read the spec IN THE JOB'S workspace (not the default-workspace fallback): a built phase carries a
  // build_sha and reads `in_progress` in the DB, so the next ⏳ is the first phase that is still `planned`.
  // Passing workspaceId is load-bearing — the branch-build chain advance (E3) fires for a spec in a
  // non-default workspace (e.g. the noop-pipeline test in fdc11e10-…), where getSpec(slug) alone would
  // resolve the WRONG workspace and find no/incorrect phases.
  const spec = await getSpec(slug, workspaceId);
  if (!spec) return null;
  const next = spec.card.phases.find((p) => p.status === "planned");
  if (!next) return null; // no ⏳ phase left → the chain is complete (all phases ✅/built)
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
    // TRUST THE MERGE + TAG ITS PROVENANCE (phase-pr-provenance). Which phase(s) did THIS merge ship?
    //
    // ⭐ ship-all-phases-on-squash-merge (post-merge-ships-only-one-phase fix): under M1's branch-accumulation
    // model ALL of a spec's phases accumulate onto ONE `claude/build-{slug}` branch, and the auto-merge
    // ACCUMULATION GATE only squash-merges that branch once EVERY phase is built (no phase still `planned`).
    // A squash-merge collapses the whole branch into ONE commit on main — so it ships the WHOLE spec
    // ATOMICALLY, regardless of how many phases its diff spans or which phase the merged build job's
    // `instructions` happen to NAME. The old code keyed on the named-phase shortcut FIRST: a director-initiated /
    // chain build whose `instructions` said "Phase 2" stamped ONLY P2 and left P1 `in_progress` forever
    // (noop-pipeline-test-4 / #837 — P1 in_progress, merge_sha=NULL while P2 shipped). So: when the spec is
    // FULLY ACCUMULATED, stamp EVERY non-terminal phase shipped with this merge SHA — the named-phase parse is
    // a fallback for the (now-rare) case a single PR merged a partial branch. This makes the post-merge advance
    // idempotent + re-runnable: a re-run over an already-merged spec whose P1 stayed `in_progress` RECONCILES
    // it (stampPhaseShipped on a shipped phase is inert; the in_progress phase flips shipped + carries the SHA).
    //
    //   (1) accumulation-complete (the normal squash-merge) → stamp ALL non-terminal phases (whole-spec atomic);
    //   (2) else the phase(s) the build's instructions NAME ("Phase N") — mapped to positions (partial merge);
    //   (3) else the FIRST not-yet-shipped phase (lowest position whose status isn't shipped/rejected).
    const shippedPositions = new Set<number>();
    let accumulationComplete = false;
    if (phases.length > 1) {
      try {
        const acc = await isSpecAccumulationComplete(workspaceId, slug);
        accumulationComplete = acc.complete;
      } catch {
        // Accumulation read failed → fall through to the named/next heuristics (don't blanket-ship on an unknown).
        accumulationComplete = false;
      }
    }
    const named = parsePhaseIndices(opts.instructions, phases.length); // 0-based indices
    if (accumulationComplete) {
      // ⭐ A squash-merge of a fully-accumulated branch ships the WHOLE spec — stamp every non-terminal phase.
      for (const p of phases) {
        if (p.status !== "shipped" && p.status !== "rejected") shippedPositions.add(p.position);
      }
    } else if (named.length) {
      // map named 0-based indices → phase positions (1-indexed `position`, ordered ASC)
      for (const i of named) {
        const p = phases[i];
        if (p) shippedPositions.add(p.position);
      }
    } else {
      // Single-phase spec, or a build with no named phase — advance the first not-yet-shipped phase.
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

export interface MergedSpecPhaseReconcileResult {
  /** spec slugs whose un-shipped phases were back-filled to shipped this pass (+ stamped with the merge SHA). */
  reconciled: string[];
  /** total phases flipped to shipped across all reconciled specs this pass. */
  phasesStamped: number;
}

/**
 * STANDING-PASS RECOVERY for ship-all-phases-on-squash-merge (post-merge-ships-only-one-phase fix). The
 * merge hook ([[applyMergedBuildEffects]]) now stamps EVERY phase of a fully-accumulated squash-merge, but it
 * only runs on the `completed→merged` TRANSITION — it never re-fires for a job that already flipped `merged`.
 * So a spec that ALREADY merged under the old (one-phase-only) hook is STUCK: e.g. noop-pipeline-test-4 / #837
 * had P1 left `in_progress` (merge_sha=NULL) while P2 shipped. This is the re-runnable reconcile that recovers
 * those: every standing pass, find a `merged` build job whose spec still has a NON-terminal phase, and stamp
 * each remaining phase shipped with the merge SHA (recovered from an already-shipped sibling phase — the
 * squash-merge commit — falling back to the job's `last_merge_sha`/build SHA if the spec_phases row carries it).
 *
 * Strictly idempotent + safe to run forever: a spec whose every phase is already shipped/rejected is skipped
 * (no un-shipped phase), and stampPhaseShipped on an already-shipped phase is inert. Only a `merged`-job spec
 * with a resolvable merge SHA is touched — a merged spec we can't prove a SHA for is LEFT for the audit path
 * (we never blanket-ship without provenance). Best-effort per spec; never throws.
 */
export async function reconcileMergedSpecPhases(adminClient?: Admin): Promise<MergedSpecPhaseReconcileResult> {
  const out: MergedSpecPhaseReconcileResult = { reconciled: [], phasesStamped: 0 };
  const admin = adminClient || createAdminClient();
  try {
    const { data: jobs } = await admin
      .from("agent_jobs")
      .select("workspace_id, spec_slug, created_at")
      .eq("kind", "build")
      .eq("status", "merged")
      .order("created_at", { ascending: false })
      .limit(200);
    const seen = new Set<string>();
    for (const j of (jobs ?? []) as Array<{ workspace_id: string; spec_slug: string }>) {
      const slug = j.spec_slug;
      if (!slug) continue;
      const key = `${j.workspace_id}:${slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const spec = await getSpecFromDb(j.workspace_id, slug);
        if (!spec) continue;
        const phases = spec.phases ?? [];
        if (!phases.length) continue; // a one-shot spec carries its provenance at the card, not per-phase
        const unshipped = phases.filter((p) => p.status !== "shipped" && p.status !== "rejected");
        if (!unshipped.length) continue; // fully shipped already — nothing to recover (the common case)
        // Recover the squash-merge SHA from an already-shipped sibling phase (the merge that landed the branch).
        // If NO phase is shipped yet we have no merge provenance to copy → leave it for the audit path.
        const shippedSibling = phases.find((p) => p.status === "shipped" && p.merge_sha);
        const mergeSha = shippedSibling?.merge_sha ?? null;
        const pr = shippedSibling?.pr ?? null;
        if (!mergeSha) continue; // can't prove a merge SHA → don't blanket-ship (audit-spec-shipped-state owns that)
        await Promise.all(
          unshipped.map((p) => stampPhaseShipped(j.workspace_id, slug, p.position, { merge_sha: mergeSha, pr })),
        );
        out.phasesStamped += unshipped.length;
        out.reconciled.push(slug);
        console.log(
          `[merged-phase-reconcile] ${slug}: back-filled ${unshipped.length} un-shipped phase(s) → shipped (merge ${mergeSha.slice(0, 8)})`,
        );
        // The spec now rolls up to shipped — fire the post-ship hooks the original merge would have (deduped).
        try {
          await enqueueSpecTestIfDue(j.workspace_id, slug, "shipped");
        } catch {
          /* best-effort — the daily spec-test backlog cron backstops */
        }
        try {
          await autoQueueUnblockedBy(j.workspace_id, slug);
        } catch {
          /* best-effort */
        }
      } catch (e) {
        console.warn(`[merged-phase-reconcile] ${slug} reconcile threw (continuing):`, e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    console.warn("[merged-phase-reconcile] pass failed (continuing):", e instanceof Error ? e.message : e);
  }
  return out;
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
