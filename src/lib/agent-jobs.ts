/**
 * agent_jobs — the build queue (server-side helpers). The dashboard "Build" button
 * inserts a row; the box worker claims it via claim_agent_job() and drives it to a PR.
 * See docs/brain/specs/roadmap-build-console.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getRoadmap, getSpec, listArchivedSlugs, type Phase } from "@/lib/brain-roadmap";
import { rollupPhaseStatus } from "@/lib/spec-card-state";
import { getSpec as getSpecFromDb, listSpecs, stampPhaseShipped, stampSpecMergeProvenance, isSpecAccumulationComplete, type SpecStatus } from "@/lib/specs-table";

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
 *   Approval Request → auto-approve within the leash, else escalate to the CEO)
 * | 'goal-fold' (goal-fold-from-db-row — the post-M5 finalize lane: fold ONE complete goal into the
 *   permanent brain + retire its row. The SIBLING of 'fold' for goals; owns a `claude/goal-fold-*`
 *   branch and, like 'fold', authors brain-doc-only changes the system itself produced — so it counts
 *   as a legitimate branch owner for the auto-merge success gate).
 * | 'mario' (mario-stall-detector — the M3 detector cron `marioStallCron` enqueues one of these per
 *   stalled spec; each row carries a `MarioBrief` JSON payload on `instructions` so the M4 reasoning
 *   agent can pick it up without re-reading. Dedupe: one active mario row per spec_slug, enforced
 *   at the app layer by [[../lib/mario]] `enqueueMarioJob`). */
export type JobKind = "build" | "plan" | "fold" | "goal-fold" | "product-seed" | "ticket-improve" | "migration-fix" | "pr-resolve" | "platform-director" | "security-review" | "proposed-model-tier" | "audit-spec-shipped-state" | "spec-review" | "mario";

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

// spec-timecard-chokepoint-instrumentation Phase 3 — emit a `job_queued` timecard whenever an enqueue
// helper below successfully inserts an `agent_jobs` row that CARRIES a `spec_slug`. Skipped when the
// slug is null (a per-workspace triage sweep has no spec target). Best-effort: recordTimecardEvent
// swallows insert errors, and we wrap the dynamic import too so a load failure never leaks into the
// enqueue caller's control flow. Callers pass their name as `actor` so the ledger records who queued.
async function emitJobQueued(
  admin: Admin,
  input: {
    workspace_id: string;
    spec_slug: string | null | undefined;
    kind: string;
    job_id: string | null | undefined;
    actor: string;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  if (!input.spec_slug) return; // triage sweep + other spec-less kinds skip the ledger
  try {
    const { recordTimecardEvent } = await import("@/lib/spec-timecards");
    await recordTimecardEvent(admin, {
      workspace_id: input.workspace_id,
      spec_slug: input.spec_slug,
      phase_index: null,
      event_kind: "job_queued",
      actor: input.actor,
      metadata: {
        kind: input.kind,
        ...(input.job_id ? { job_id: input.job_id } : {}),
        ...(input.extra ?? {}),
      },
    });
  } catch (e) {
    console.warn(
      `[timecards] job_queued emit failed spec=${input.spec_slug} kind=${input.kind}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

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
 * brain → moved to docs/brain/archive.d/) OR its DB status override was set to folded/deferred (the
 * cancel-jobs-for-archived-specs-reads-db-fold-not-just-markdown fix — a DB fold with no markdown archive
 * file no longer leaves the spec's build/spec-test jobs stuck) any still-non-terminal build/spec-test job
 * for that slug is an ORPHAN: it lingers as a paused/active item whose spec is retired and answering it
 * is meaningless. Cancel each (status → `completed` with a clear "spec archived" reason,
 * questions/pending_actions cleared) so no dead paused/active item survives. The preventive guard
 * (getLiveJobForSlug, refused at the fold path) makes this rare; this is the belt-and-suspenders that
 * catches a race the gate missed.
 *
 * The FS archive (docs/brain/archive.d/) is global; DB-archived slugs (specs.status = 'folded' | 'deferred')
 * are workspace-scoped, so we group jobs by workspace_id and check each workspace's DB-archived set
 * separately — never treating a "slug X is folded in workspace A" as reason to cancel workspace B's job of
 * the same slug. Global by default (all workspaces); pass `workspaceId` to scope it (e.g. a fold-merge
 * reconcile). Idempotent — terminal jobs are never touched. Best-effort: a single failed update doesn't
 * abort the rest.
 */
// reap-needs-attention-jobs-for-archived-specs Phase 1 — the reaper's status set is a LOCAL
// superset of ACTIVE_STATUSES that ALSO includes 'needs_attention'. A folded/deferred/FS-archived
// spec's parked needs_attention build job is superseded by definition (its spec page no longer
// exists), so it should be reaped alongside its still-active siblings. ACTIVE_STATUSES stays
// intact for every other caller (fold-guard, in-flight seams, resume gates) — the widening only
// applies to the archived-spec cleanup path, gated by the same filterJobsForArchivedSpecs
// membership check. Ada's platform-director 'builds stuck >90m' signal used to re-flag an
// already-shipped spec every standing pass because this uncatchable job lingered forever.
export const REAPABLE_STATUSES_FOR_ARCHIVED_SPECS: JobStatus[] = [...ACTIVE_STATUSES, "needs_attention"];

export async function cancelJobsForArchivedSpecs(opts?: { workspaceId?: string; admin?: Admin }): Promise<{ cancelled: number; slugs: string[]; prsClosedOk: number; prResolveCancelled: number }> {
  const admin = opts?.admin || createAdminClient();

  // 1) Fetch every reapable build/spec-test job first (optionally scoped) so we can group by
  //    workspace and apply that workspace's DB-archived set separately from the global FS archive.
  //    "Reapable" = ACTIVE_STATUSES ∪ {'needs_attention'}: an archived spec's parked
  //    needs_attention job is orphaned and must be swept alongside its still-active siblings.
  //    pr-resolve-fold-closes-orphan-pr (Phase 2): also select pr_number + spec_branch — a folded
  //    spec's still-open PR is the orphan the storm rides on; we close it here (and reap its
  //    pr-resolve jobs) so the standing-pass dirty-PR backstop has nothing left to re-enqueue.
  let query = admin
    .from("agent_jobs")
    .select("id, spec_slug, workspace_id, kind, pr_number, spec_branch")
    .in("kind", ["build", "spec-test"])
    .in("status", REAPABLE_STATUSES_FOR_ARCHIVED_SPECS);
  if (opts?.workspaceId) query = query.eq("workspace_id", opts.workspaceId);
  const { data, error } = await query;
  if (error || !data?.length) return { cancelled: 0, slugs: [], prsClosedOk: 0, prResolveCancelled: 0 };
  const jobs = data as { id: string; spec_slug: string; workspace_id: string; kind: string; pr_number: number | null; spec_branch: string | null }[];

  // 2) FS archive (global, cross-workspace) + per-workspace DB-archived slug sets via the specs-table SDK
  //    (folded ∪ deferred). Reading .from('specs') directly here would bypass the "database is the spec"
  //    SDK chokepoint — listSpecs is the sanctioned reader.
  const fsArchived = new Set(await listArchivedSlugs());
  const workspaceIds = [...new Set(jobs.map((j) => j.workspace_id))];
  const dbArchivedByWs = new Map<string, Set<string>>();
  await Promise.all(
    workspaceIds.map(async (ws) => {
      const [folded, deferred] = await Promise.all([
        listSpecs(ws, { status: "folded" }),
        listSpecs(ws, { status: "deferred" }),
      ]);
      dbArchivedByWs.set(ws, new Set([...folded.map((s) => s.slug), ...deferred.map((s) => s.slug)]));
    }),
  );

  // 3) A job is cancellable iff its spec is FS-archived OR DB-archived in its own workspace.
  const cancellable = filterJobsForArchivedSpecs(jobs, fsArchived, dbArchivedByWs);
  if (!cancellable.length) return { cancelled: 0, slugs: [], prsClosedOk: 0, prResolveCancelled: 0 };

  const reason = "spec archived — build auto-cancelled (the spec was folded/deferred; its spec page no longer exists)";
  const slugs: string[] = [];
  for (const j of cancellable) {
    const { error: upErr } = await admin
      .from("agent_jobs")
      .update({ status: "completed", error: reason, questions: [], pending_actions: [], updated_at: new Date().toISOString() })
      .eq("id", j.id);
    if (!upErr) slugs.push(j.spec_slug);
  }

  // 4) pr-resolve-fold-closes-orphan-pr (Phase 2): for each cancelled BUILD job carrying an open PR
  //    (pr_number != null + spec_branch startsWith 'claude/'), close the PR + reap its pr-resolve
  //    jobs. Only build-kind jobs mint the claude/* PR, so spec-test jobs contribute nothing here.
  //    Both mutations are guarded (workspace_id scope + kind='pr-resolve' filter on the cancel; the
  //    GH close re-verifies state/repo/branch/SHA before PATCH), and both are best-effort — a GH
  //    failure never rolls back the build-job cancellation above.
  const orphanPrs = collectArchivedSpecOpenPrs(cancellable);
  let prsClosedOk = 0;
  let prResolveCancelled = 0;
  if (orphanPrs.length) {
    const { closeArchivedSpecPr } = await import("./github-pr-resolve");
    const nowIso = new Date().toISOString();
    for (const p of orphanPrs) {
      // (a) Reap this PR's pr-resolve jobs (compare-and-set scoped to workspace + kind + pr_number
      //     + REAPABLE_STATUSES so a race that transitioned the row to terminal never overwrites it).
      const cancelReason = `spec archived — pr-resolve reaped (${p.specSlug} was folded/shipped; the PR is being auto-closed)`;
      const { data: reaped } = await admin
        .from("agent_jobs")
        .update({ status: "completed", error: cancelReason, questions: [], pending_actions: [], updated_at: nowIso })
        .eq("workspace_id", p.workspaceId)
        .eq("kind", "pr-resolve")
        .eq("pr_number", p.prNumber)
        .in("status", REAPABLE_STATUSES_FOR_ARCHIVED_SPECS)
        .select("id");
      prResolveCancelled += Array.isArray(reaped) ? reaped.length : 0;

      // (b) Close the PR on GitHub. Idempotent: closeArchivedSpecPr returns ok=true reason='not-open'
      //     if the PR was already closed/merged, and ok=false (no mutation) on any auth-drift.
      try {
        const closed = await closeArchivedSpecPr(p.prNumber, p.branch, p.specSlug);
        if (closed.ok) prsClosedOk += 1;
      } catch {
        /* best-effort — a GH failure doesn't block the next PR or roll back the DB cancels */
      }
    }
  }

  return { cancelled: slugs.length, slugs, prsClosedOk, prResolveCancelled };
}

/**
 * pr-resolve-fold-closes-orphan-pr (Phase 2) — PURE decision helper. Given the archived-spec build/spec-test
 * jobs the caller has already narrowed via [[filterJobsForArchivedSpecs]], return the subset that carry an
 * OPEN claude/* PR that must be auto-closed. Only `build` kind mints the claude/* PR; `spec-test` never
 * carries a build PR of its own. Fold-safe: a job with no pr_number, no spec_branch, or a spec_branch that
 * isn't a `claude/*` build branch is DROPPED (never mutated). Deduped on (workspace_id, pr_number) so a
 * spec with more than one same-PR build job never triggers two closes.
 */
export function collectArchivedSpecOpenPrs<
  J extends { spec_slug: string; workspace_id: string; kind: string; pr_number: number | null; spec_branch: string | null },
>(cancellable: J[]): Array<{ workspaceId: string; prNumber: number; branch: string; specSlug: string }> {
  const seen = new Set<string>();
  const out: Array<{ workspaceId: string; prNumber: number; branch: string; specSlug: string }> = [];
  for (const j of cancellable) {
    if (j.kind !== "build") continue; // spec-test doesn't own the PR
    if (typeof j.pr_number !== "number") continue;
    if (typeof j.spec_branch !== "string") continue;
    if (!j.spec_branch.startsWith("claude/")) continue;
    const key = `${j.workspace_id}:${j.pr_number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ workspaceId: j.workspace_id, prNumber: j.pr_number, branch: j.spec_branch, specSlug: j.spec_slug });
  }
  return out;
}

/**
 * PURE decision half of [[cancelJobsForArchivedSpecs]] — no DB. Given the live build/spec-test jobs, the
 * FS-archived slug set (global), and the per-workspace DB-archived slug set, return the subset of jobs
 * whose spec is archived (FS OR DB in its own workspace). Exported so it can be unit-tested without a
 * Supabase client — the assertion the spec's Verification calls for: a DB-folded spec's active build job
 * is included in the cancel set even when the FS archive is empty.
 */
export function filterJobsForArchivedSpecs<J extends { spec_slug: string; workspace_id: string }>(
  jobs: J[],
  fsArchived: ReadonlySet<string>,
  dbArchivedByWs: ReadonlyMap<string, ReadonlySet<string>>,
): J[] {
  return jobs.filter((j) => fsArchived.has(j.spec_slug) || (dbArchivedByWs.get(j.workspace_id)?.has(j.spec_slug) ?? false));
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
 * goal-fold/pr-resolve job to `completed` after its pre-push `tsc --noEmit` passed and the PR opened
 * cleanly, and to `merged` once that PR landed. Every other status is a partial/errored/paused build. */
export const SUCCESSFUL_BUILD_STATUSES: JobStatus[] = ["completed", "merged"];

/** The job kinds that OWN a claude/* PR branch (each sets `spec_branch` to the branch). `goal-fold` is
 *  here for the SAME reason as `fold`: it stamps `spec_branch = claude/goal-fold-…` and authors
 *  system-produced brain-doc changes — so a completed goal-fold legitimately OWNS its branch and clears
 *  the auto-merge success gate (without it, a goal-fold PR read "no build job owns this branch" forever). */
const BRANCH_OWNING_KINDS: JobKind[] = ["build", "fold", "goal-fold", "pr-resolve"];

/** The branch-owning kinds whose `spec_slug` is the REAL spec slug (the spec-building kinds). A `build`
 * job stamps `spec_branch = claude/build-{slug}` and carries the actual spec slug. The other owning
 * kinds do NOT: a `fold` job's branch is `claude/fold-…`, a `goal-fold` job's branch is
 * `claude/goal-fold-…` and its `spec_slug` is the GOAL slug, and a `pr-resolve` job stamps a PSEUDO-slug
 * `pr-<number>` (it runs against a PR, not a spec). So the SLUG/workspace returned by the build-success
 * gate must be resolved from a `build` job, never from a `fold`/`goal-fold`/`pr-resolve` owning job whose
 * slug would misdirect the per-branch spec-test lookup. (plan jobs are excluded too: their `spec_slug`
 * holds the GOAL slug and they don't own a `claude/build-*` branch — see the JobKind doc above.) */
const REAL_SLUG_BUILD_KINDS: JobKind[] = ["build"];

/** Derive the real spec slug from a `claude/build-<slug>` branch name. Returns null for any other ref
 * (e.g. `claude/fold-…`) — the caller then has no slug and the per-branch tests gate stays closed. */
function slugFromBuildBranch(branch: string): string | null {
  const prefix = "claude/build-";
  return branch.startsWith(prefix) ? branch.slice(prefix.length) || null : null;
}

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
 *
 * SLUG-RESOLUTION DISCIPLINE (the M4 tests-gate fix): the build-STATUS verdict legitimately uses the
 * newest owning job — a `pr-resolve` that just cleaned the branch reading `completed` is the branch in a
 * good state. BUT the returned `specSlug`/`workspaceId` (which the M4 auto-merge tests-gate feeds to
 * `isSpecTestGreenForBranch`) MUST be the REAL spec slug — and a `pr-resolve` owning job carries a PSEUDO
 * slug `pr-<number>`, a `fold` job an unrelated fold slug. Returning that pseudo-slug wedged the gate:
 * there is no `spec_test_runs` row for `pr-<n>`, so a CLEAN, spec-test-approved PR read `spec-test=pending`
 * and never auto-merged. So the slug/workspace are resolved SEPARATELY from the newest `build` job for the
 * branch (REAL_SLUG_BUILD_KINDS), falling back to deriving the slug from the `claude/build-<slug>` branch
 * name. We NEVER return a `pr-<n>` pseudo-slug.
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

    // Resolve the REAL spec slug + workspace from the newest `build` job for the branch — NOT from the
    // newest owning job (which may be a `pr-resolve` carrying a `pr-<n>` pseudo-slug, or a `fold` job).
    // If the newest owning job IS itself a build, that's already the right source. Otherwise look up the
    // latest build job; fall back to deriving the slug from the branch name. The status verdict still
    // comes from `job` (the newest owning job) above.
    let realSlug: string | null = null;
    let realWorkspaceId: string | null = null;
    if (REAL_SLUG_BUILD_KINDS.includes(job.kind)) {
      realSlug = job.spec_slug;
      realWorkspaceId = job.workspace_id;
    } else {
      const { data: buildData } = await admin
        .from("agent_jobs")
        .select("workspace_id, spec_slug")
        .eq("spec_branch", branch)
        .in("kind", REAL_SLUG_BUILD_KINDS)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const buildJob = buildData as { workspace_id: string; spec_slug: string } | null;
      if (buildJob) {
        realSlug = buildJob.spec_slug;
        realWorkspaceId = buildJob.workspace_id;
      } else {
        // No build job (e.g. a manually-pushed `claude/build-*` branch the resolver later adopted) —
        // derive the slug from the branch name. workspace_id stays the owning job's (best available).
        realSlug = slugFromBuildBranch(branch);
        realWorkspaceId = job.workspace_id;
      }
    }
    // Defensive belt-and-suspenders: a `pr-<n>` pseudo-slug must NEVER escape this function.
    if (realSlug && /^pr-\d+$/.test(realSlug)) realSlug = slugFromBuildBranch(branch);

    if (SUCCESSFUL_BUILD_STATUSES.includes(job.status)) {
      return { ok: true, status: job.status, reason: `${job.kind} job ${job.status}`, workspaceId: realWorkspaceId, specSlug: realSlug };
    }
    return {
      ok: false,
      status: job.status,
      reason: `${job.kind} job is ${job.status} (not completed/merged)`,
      workspaceId: realWorkspaceId,
      specSlug: realSlug,
    };
  } catch (e) {
    return { ok: false, status: null, reason: `build-job lookup failed: ${e instanceof Error ? e.message : e}`, workspaceId: null, specSlug: null };
  }
}

const GH_REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";
function ghToken() {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}

/** The pre-merge test context for a goal-compiled spec: its own `claude/build-*` branch (built off the goal
 *  branch, so the accumulated code is present) + the freshest preview URL captured for it (from a prior build
 *  or spec-test job). Returns null when no preview has been captured — the caller then SKIPS rather than
 *  false-fail against main. The `claude/*` branch name satisfies the worker's pre-merge testable gate. */
async function resolveGoalMemberTestContext(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  slug: string,
): Promise<{ spec_branch: string; preview_url: string } | null> {
  const { data } = await admin
    .from("agent_jobs")
    .select("spec_branch, preview_url, created_at")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .not("preview_url", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const row = (data ?? [])[0] as { spec_branch: string | null; preview_url: string | null } | undefined;
  const preview = row?.preview_url?.trim();
  if (!preview) return null;
  return { spec_branch: row?.spec_branch?.trim() || `claude/build-${slug}`, preview_url: preview };
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

  // goal-compiled-tests-on-goal-branch: a spec that is a member of an INCOMPLETE goal lives on the GOAL
  // BRANCH, not main — goal members promote atomically only when the whole goal lands on main (Gate C).
  // A shipped-lane spec-test runs against main/production, where the goal-compiled code doesn't exist yet,
  // so EVERY check false-fails ("migration/route/table missing" — because they're on the goal branch). That
  // stale 'issues' verdict then blocks the goal's OWN promotion: a self-inflicted deadlock (the 2026-07-09
  // media-buyer jam — sensor-trust-probe/shadow-mode/per-cohort each showed 4-9 auto-fails that were pure
  // wrong-context false-fails). So route a goal-compiled spec's test to its OWN `claude/build-*` branch
  // preview (built off the goal branch → the code IS present), which the worker's pre-merge testable gate
  // accepts. If no preview is resolvable, SKIP rather than false-fail against main.
  let branchCtx: { spec_branch: string; preview_url: string } | null = null;
  const goalSlug = await resolveGoalSlugForSpec(workspaceId, slug);
  if (goalSlug) {
    const { getGoal } = await import("@/lib/goals-table");
    const goal = await getGoal(workspaceId, goalSlug);
    // main_merge_sha is NULL until the goal's atomic M5 promotion lands on main (same signal spec-drift uses
    // for its goal-pending guard). NULL ⇒ the members' code is on the goal branch, not main ⇒ route to branch.
    if (goal && !goal.main_merge_sha) {
      branchCtx = await resolveGoalMemberTestContext(admin, workspaceId, slug);
      if (!branchCtx) {
        return { enqueued: false, reason: `goal-compiled (${goalSlug} not promoted to main) with no branch preview — skipped main-context re-verify to avoid false-fails` };
      }
    }
  }

  const { data: inserted, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: workspaceId,
      spec_slug: slug,
      kind: "spec-test",
      status: "queued",
      created_by: null,
      ...(branchCtx ?? {}),
    })
    .select("id")
    .single();
  if (error) return { enqueued: false, reason: `insert-failed: ${error.message}` };
  await emitJobQueued(admin, {
    workspace_id: workspaceId,
    spec_slug: slug,
    kind: "spec-test",
    job_id: (inserted as { id?: string } | null)?.id ?? null,
    actor: "enqueueSpecTestIfDue",
  });
  return { enqueued: true };
}

/**
 * bo-reactive-gated-build-enqueue Phase 1 — the SINGLE chokepoint for enqueueing a `kind='build'`
 * agent_jobs row for a spec. Parallel of Vale's `enqueueSpecReviewIfDue` (src/lib/agents/spec-review.ts)
 * and Bo's shipped-lane `enqueueSpecTestIfDue` (above): one cheap `getSpec` read, gate on the same
 * BUILD-ELIGIBILITY predicate Ada's front-door lanes apply (`specReviewDone` + not deferred + not
 * shipped + auto_build != false + blockers cleared), plus a one-in-flight guard so a duplicate call
 * no-ops instead of stacking a redundant row.
 *
 * Every reactive/agent-driven enqueue path (autoQueueUnblockedBy, Phase-2 `buildOnEligible` consumer,
 * Ada's own lanes as an optional collapse) MUST route through here so Bo never gets a `queued` row
 * for an un-Vale-passed / deferred / blocked spec. The claim-time backstops (claimHeldForUnreviewedSpec
 * in builder-worker.ts + evaluateClaimTimeBuildGate) stay in place as the last line of defense — but
 * this stops the premature row from ever appearing on the CEO's board.
 *
 * DELIBERATE OVERRIDES (raw `.insert({ kind:'build' })`) that intentionally bypass this gate MUST
 * carry an inline `// intentional override: <why>` comment. Known overrides today:
 *   - pre-merge-fix.ts (regression-fix spec auto-authored on a pre-merge test RED — the fix ships fast
 *     regardless of Vale, review lands after);
 *   - director-directives.ts `enqueuePriorityBuild` (CEO-approved directive);
 *   - needs-attention-route.ts (auto-authored child spec from a parked build — same fix-flow speed);
 *   - agent-jobs.ts `queueNextChainedPhase` (chain continuation — the prior phase already merged, so
 *     the spec has passed Vale by construction);
 *   - agent-grader.ts (director-authored coaching-hardening spec);
 *   - Ada's own lanes in platform-director.ts already gate on `specReviewDone`, so their raw inserts
 *     are equivalent to routing through here.
 *
 * Distinct `reason` values so a cron/heartbeat log stays legible: 'spec-not-found', 'already-shipped',
 * 'deferred', 'in-review-pending-disposition', 'not-review-passed', 'auto-build-off', 'blocked',
 * 'in-flight'.
 */
export async function enqueueBuildIfDue(
  workspaceId: string,
  slug: string,
  opts?: {
    createdBy?: string | null;
    instructions?: string | null;
    /** parallel-build-serialized-merge-and-deadlock-autobreak Phase 1 — skip the
     *  Phase-1 goal-mate admission gate. Only the deadlock auto-break sets this:
     *  when a goal's designated head-of-line has no in-flight build but other
     *  race-artifact mates are queued, admission would refuse the head; the
     *  auto-break has already verified this is the head, so it must land. Every
     *  other caller MUST leave this false — bypassing admission for a non-head
     *  would re-open the goal-mate collision Phase 1 closed. */
    bypassGoalMemberAdmission?: boolean;
  },
): Promise<{ enqueued: boolean; reason?: string; jobId?: string }> {
  const admin = createAdminClient();

  const spec = await getSpec(slug, workspaceId);
  if (!spec) return { enqueued: false, reason: "spec-not-found" };
  const card = spec.card;

  // Order matches Ada's `isBuildableSpec` predicate (platform-director.ts:610) — a shipped spec is
  // "already done", a deferred one is parked, and only THEN do we test the review-pass gate. Each
  // check emits a distinct reason so the heartbeat log names the exact eligibility miss.
  if (card.status === "shipped") return { enqueued: false, reason: "already-shipped" };
  if (card.status === "deferred") return { enqueued: false, reason: "deferred" };
  // retire-vale-spec-review-becomes-deterministic-authoring-gate Phase 2 — the legacy in_review +
  // not-review-passed hard-stops are RETIRED. Vale's LLM lane is gone; every spec that reaches
  // `public.specs` passed the deterministic gate ([[spec-review-gate]]) synchronously at author time.
  // "reviewed" is TRUE by construction the instant a row exists. A fresh, phased, well-formed spec
  // derives `planned`/`in_progress` via the phase rollup — never `in_review` — and the build enqueues
  // freely. Ada's disposition lane keeps routing planned/deferred as a director judgment call
  // (spec-dispose.selectDispositionCandidates); but that judgment does not gate the build claim path.
  if (card.autoBuild === false) return { enqueued: false, reason: "auto-build-off" };
  if (card.blockedBy.some((b) => !b.cleared)) return { enqueued: false, reason: "blocked" };

  // One-in-flight guard — mirrors enqueueSpecReviewIfDue's shape (spec-review.ts:100-107). A build
  // already carrying this spec (queued / queued_resume / claimed / building) means a duplicate call
  // is a no-op, never a stack.
  const { data: inflight } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("kind", "build")
    .in("status", ["queued", "queued_resume", "building", "claimed"])
    .limit(1);
  if (inflight && inflight.length) return { enqueued: false, reason: "in-flight" };

  // goal-member-builds-gate-at-enqueue-not-at-claim Phase 1 — enqueue-time admission gate. Before
  // this the same-spec in-flight guard above only stopped a duplicate for THIS spec; a
  // goal-MATE (a different spec of the same goal) could still land as a second `queued` row
  // and race the first. The claim-time serializer would then requeue the loser each tick, but
  // the CEO's board still showed both cards live. Gate here so the loser never enqueues; the
  // reactive path (buildOnEligible / autoQueueUnblockedBy) re-fires when the sibling completes.
  // Fail-open on any resolve error (the claim-time serializer is still in place as a backstop).
  //
  // parallel-build-serialized-merge-and-deadlock-autobreak Phase 1 — the auto-break passes
  // `bypassGoalMemberAdmission:true` when it needs to force-enqueue a designated head-of-line
  // that admission would otherwise refuse (its own siblings are race-artifact `queued` rows).
  // Only that one narrow caller sets it; everything else falls through the gate as before.
  if (!opts?.bypassGoalMemberAdmission) {
    const admission = await evaluateGoalMemberEnqueueAdmission(workspaceId, slug);
    if (!admission.ok) return { enqueued: false, reason: admission.reason };
  }

  const { data: inserted, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: workspaceId,
      spec_slug: slug,
      kind: "build",
      status: "queued",
      created_by: opts?.createdBy ?? null,
      instructions: opts?.instructions ?? null,
    })
    .select("id")
    .single();
  if (error) return { enqueued: false, reason: `insert-failed: ${error.message}` };
  await emitJobQueued(admin, {
    workspace_id: workspaceId,
    spec_slug: slug,
    kind: "build",
    job_id: inserted?.id ?? null,
    actor: "enqueueBuildIfDue",
    extra: opts?.createdBy ? { created_by: opts.createdBy } : undefined,
  });
  return { enqueued: true, jobId: inserted?.id };
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
  opts?: { force?: boolean },
): Promise<{ enqueued: boolean; reason?: string }> {
  if (!branch || !branch.startsWith("claude/")) return { enqueued: false, reason: "not a claude/* branch" };
  const origin = (previewUrl || "").replace(/\/$/, "");
  if (!origin) return { enqueued: false, reason: "no preview_url" };
  const force = opts?.force === true;

  const admin = createAdminClient();

  // Dedupe — mirrors the `enqueueSpecTestIfDue` chokepoint shape (a `.from(...).select("id")` SQL
  // probe + first hit wins), keyed per-BRANCH so a pre-merge run on branch A doesn't block a run on
  // branch B. But an `error` verdict is a TRANSIENT (the run couldn't produce a parseable verdict —
  // a reaped session, a self-update restart), NOT a real result — so we must NOT treat it as
  // "already tested". Narrow the block to two cases (spectest-error-visible-and-rerunnable Phase 1):
  //   (a) an OPEN spec-test job for the same (workspace, slug, branch) is still in flight
  //       (ACTIVE_STATUSES) — a queued/claimed/building job IS the re-run; adding another would stack;
  //   (b) the latest `spec_test_runs` row for (workspace, slug, branch) already carries a REAL
  //       verdict — approved / needs_human / issues — i.e. the preview WAS successfully tested; a
  //       redundant re-run against the same preview would just re-derive the same result.
  // A latest verdict of `error` (or NO run row + only a terminal `failed` spec-test job) falls
  // through both branches → the enqueue proceeds, unwedging the branch. The upstream
  // `backstopPreMergeChecks` still loop-guards standing-pass auto-recovery so a genuinely erroring
  // run can't spin forever.
  //
  // premerge-spectest-rerun-and-visibility Phase 3 — an OWNER-initiated re-run from the dashboard
  // passes `force: true` and skips (b) entirely (an owner clicking Re-run has already decided the
  // stale terminal verdict should not gate them, and the API path just fresh-captured the branch's
  // preview so the re-test hits current code). (a) still applies — never stack a spec-test on top of
  // one that is already in flight for the same branch.
  const { data: openJob } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("kind", "spec-test")
    .eq("spec_branch", branch)
    .in("status", ACTIVE_STATUSES)
    .limit(1);
  if (openJob && openJob.length) return { enqueued: false, reason: "in-flight" };
  if (!force) {
    const { data: latestRun } = await admin
      .from("spec_test_runs")
      .select("agent_verdict, run_at")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", slug)
      .eq("spec_branch", branch)
      .order("run_at", { ascending: false })
      .limit(1);
    if (latestRun && latestRun.length) {
      const row = latestRun[0] as { agent_verdict: string | null; run_at: string };
      const verdict = row.agent_verdict;
      if (verdict === "approved" || verdict === "needs_human" || verdict === "issues") {
        // premerge-spectest-rerun-and-visibility Phase 1 — treat the latest terminal verdict as STALE when
        // the branch has NEWER work than the run: a `build` or `pr-resolve` agent_jobs row for this
        // spec_branch whose updated_at > latestRun.run_at means the branch's CODE has changed since we
        // last tested (e.g. a pr-resolve just merged main into the branch, or a next-phase build pushed
        // to it). Without this check the branch is silently wedged forever — the root cause seen live on
        // spec-brain-refs: the fix landed via pr-resolve, but its stale `issues` verdict permanently
        // blocked re-testing on the same branch. No churn: a spec-test run itself creates no
        // build/pr-resolve row, so after the re-test the branch settles until the next real push.
        const { data: newer } = await admin
          .from("agent_jobs")
          .select("id")
          .eq("spec_branch", branch)
          .in("kind", ["build", "pr-resolve"])
          .gt("updated_at", row.run_at)
          .limit(1);
        if (!newer || !newer.length) {
          return { enqueued: false, reason: `already tested (${verdict})` };
        }
        // Newer build/pr-resolve exists → stale verdict; fall through and re-enqueue.
      }
      // verdict === "error" (or null) → transient; fall through and re-enqueue.
    }
  }

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
  const { data: inserted, error } = await admin.from("agent_jobs").insert(insertRow).select("id").single();
  if (error) return { enqueued: false, reason: `insert-failed: ${error.message}` };
  await emitJobQueued(admin, {
    workspace_id: workspaceId,
    spec_slug: slug,
    kind: "spec-test",
    job_id: (inserted as { id?: string } | null)?.id ?? null,
    actor: "enqueuePreMergeSpecTest",
    extra: { spec_branch: branch },
  });
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
  /**
   * fixes-as-phases self-heal: force the re-test past the "already tested this preview / existing verdict"
   * dedup. Set when the build that just accumulated completed a `kind='fix'` phase — the prior `issues`
   * run tested the PRE-fix code and MUST be superseded, or the fix silently stalls (the fused-premerge-
   * security case: Fix built, no re-test ran, PR held forever). [[pre-merge-fix]].
   */
  force?: boolean;
}): Promise<{ enqueued: boolean; reason?: string }> {
  const { workspaceId, slug, branch, previewUrl, force } = args;
  try {
    if (!branch || !branch.startsWith("claude/")) return { enqueued: false, reason: "not a claude/* branch" };
    const origin = (previewUrl || "").replace(/\/$/, "");
    if (!origin) return { enqueued: false, reason: "no preview URL yet" };
    // Only fire once the WHOLE spec is built on the branch — testing a half-accumulated branch would test a
    // partial spec. Same predicate the auto-merge accumulation gate + isSpecPromoteEligible read.
    const acc = await isSpecAccumulationComplete(workspaceId, slug);
    if (!acc.complete) return { enqueued: false, reason: `not fully accumulated yet (${acc.reason})` };
    return await enqueuePreMergeSpecTest(workspaceId, slug, branch, origin, force ? { force: true } : undefined);
  } catch (e) {
    return { enqueued: false, reason: `trigger errored: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * ⭐ fused-premerge-security-authoritative-drop-standalone Phase 3 — RETIRED. The pre-merge branch-mode
 * standalone security enqueue is gone; the FUSED spec-test session is now the SOLE pre-merge branch-mode
 * producer of security verdicts (Phase 2 wired `applyFusedSecurityAsBranchVerdict` in
 * [[../../scripts/builder-worker]] to insert the branch-mode `security-review` row directly from the
 * evidence-backed fused envelope). This function now no-ops so the two preview-ready-hook callers +
 * `backstopPreMergeChecks` don't error — the pre-merge branch-mode `enqueueSecurityReviewJob` path is
 * effectively dead. The signature is preserved for compat; a future cleanup can strip the callers.
 *
 * Post-merge `diff` mode + `dep-watch` are NOT affected — those still enqueue standalone
 * `security-review` jobs via `enqueueSecurityReviewJob` (diff / dep-watch) and remain the authoritative
 * post-merge / daily-CVE producers. Only pre-merge BRANCH mode is retired.
 *
 * Historical: under consolidate-premerge-checks-one-session the pre-merge was briefly fused with a
 * self-declared `security.status="clean"` envelope (a rubber-stamp risk). isolate-premerge-security-verdict
 * reversed that to a standalone enqueue. Now the fused envelope carries STRUCTURED per-check evidence
 * (Phase 1) that a rubber-stamp cannot satisfy — a bare `clean` downgrades to `needs_human` in
 * [[security-envelope]] `classifyFusedSecurityEnvelope`, so it's SAFE to make the fused row authoritative
 * and drop the standalone (Phase 2 + 3). Best-effort + never throws.
 */
export async function maybeEnqueuePreMergeSecurityOnAccumulation(_args: {
  workspaceId: string;
  slug: string;
  branch: string | null;
  previewUrl: string | null;
  prNumber?: number | null;
}): Promise<{ enqueued: boolean; reason?: string }> {
  return {
    enqueued: false,
    reason: "retired: fused spec-test session is the sole pre-merge branch-mode security producer (fused-premerge-security-authoritative-drop-standalone Phase 3)",
  };
}

/**
 * STANDING-PASS BACKSTOP for BOTH pre-merge triggers (spec-test + security). The Gate-A class gap: both
 * pre-merge enqueues fire ONLY from the build's fire-and-forget preview-capture READY callback. If that
 * poll misses READY (worker restart mid-poll, a slow/late preview, a transient Vercel/DB hiccup) the
 * enqueue never happens — and (for security) it had no caller at all — so a fully-built branch sits
 * `in_testing` forever (the same standing-pass-backstop gap Gate-A had: event-only, no re-evaluation).
 *
 * This is the reliable re-evaluation: every standing pass, enumerate the latest build job per
 * `claude/build-{slug}` branch that carries a READY preview, and (idempotently) fire the pre-merge
 * spec-test trigger for any fully-accumulated branch. The underlying enqueue dedupes (spec-test per
 * (workspace, slug, branch)), so re-running every pass is safe + cheap. Mirrors
 * `promoteEligibleSpecsToGoalBranch`'s candidate-enumeration shape.
 *
 * fused-premerge-security-authoritative-drop-standalone Phase 3 — the SECURITY leg of the backstop is
 * gone. The fused spec-test session is now the sole pre-merge branch-mode security producer
 * ([[../../scripts/builder-worker]] `applyFusedSecurityAsBranchVerdict` writes the branch-mode
 * `security-review` row from `runSpecTestJob`'s evidence-backed fused envelope). `securityEnqueued`
 * stays on the result shape for backward-compat and is always empty. Best-effort per branch; never throws.
 */
export interface PreMergeBackstopResult {
  /** branches whose pre-merge spec-test was (re-)enqueued this pass. */
  specTestEnqueued: string[];
  /**
   * fused-premerge-security-authoritative-drop-standalone Phase 3 — always empty. Retained for
   * backward-compat with the platform-director's standing-pass logging + existing callers that
   * enumerate the field. The fused spec-test session writes the pre-merge security-review row
   * directly (Phase 2), so no separate branch-mode enqueue happens here.
   */
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
      // deleted-spec skip: a build job whose spec ROW is GONE (the CEO deleted a redundant/malformed spec —
      // the pm-detail-page + pr-resolve dismissals on 2026-07-02) has nothing to pre-merge-test or promote,
      // yet its `claude/build-*` branch lingers. Without this, the backstop re-enqueues a spec-test EVERY
      // pass — each parks ("spec gone") → a fresh "Parked spec-test" card + wasted spec-test tokens (a
      // contributor to the spec-test budget breach). getSpecFromDb null = deleted (or a transient read miss,
      // in which case a one-tick skip is harmless — the next pass retries).
      if (!specRow) continue;
      if (specRow.status === "shipped" || specRow.status === "folded") continue;

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
      // ⭐ premerge-spectest-rerun-and-visibility Phase 2 — REFRESH-ON-CHANGE. Even when the
      // build row already carries a READY preview_url, that URL can be STALE if the branch has
      // newer work than the latest spec_test_run — e.g. a pr-resolve merge commit that pushed a
      // fix onto the branch but never re-captured a preview onto THIS row. Phase 1 unblocks the
      // re-enqueue for a changed branch; without Phase 2 that re-enqueue would probe the OLD
      // preview and re-fail. So when the branch has changed since its last run, ask Vercel for
      // the branch's newest deployment: if its state is READY (Vercel finished building the new
      // push), persist that fresh URL onto this row via capturePreviewUrlForJob (idempotent,
      // advances only forward) and use it for the enqueue; if NOT READY (still QUEUED /
      // BUILDING / ERROR / CANCELED), skip this pass entirely so the re-test never runs against
      // a stale or non-READY preview — the next standing pass retries. Gated behind
      // "branch has newer build/pr-resolve than latest run" so the Vercel call is bounded to
      // real change events, not every standing pass on every branch.
      try {
        const { data: latestRun } = await admin
          .from("spec_test_runs")
          .select("run_at")
          .eq("workspace_id", j.workspace_id)
          .eq("spec_slug", slug)
          .eq("spec_branch", branch)
          .order("run_at", { ascending: false })
          .limit(1);
        if (latestRun && latestRun.length) {
          const runAt = (latestRun[0] as { run_at: string }).run_at;
          const { data: newer } = await admin
            .from("agent_jobs")
            .select("id")
            .eq("spec_branch", branch)
            .in("kind", ["build", "pr-resolve"])
            .gt("updated_at", runAt)
            .limit(1);
          if (newer && newer.length) {
            const { getLatestReadyDeploymentForBranch, previewHttpsUrl } = await import("@/lib/vercel-project");
            const lookup = await getLatestReadyDeploymentForBranch(branch, null);
            // The branch's NEWEST deployment must be READY — otherwise Vercel is still building
            // the new push (or the deployment errored/was canceled). A READY older-than-newest
            // deployment isn't good enough; using it would re-test the pre-change code.
            if (!lookup.latest || lookup.latest.state !== "READY") {
              console.log(
                `[pre-merge-backstop] Phase 2: branch ${branch} changed since last run but newest deployment not READY (${lookup.latest?.state ?? "none"}) — retry next pass`,
              );
              continue;
            }
            const freshUrl = previewHttpsUrl(lookup.latest);
            if (!freshUrl) continue;
            const { capturePreviewUrlForJob } = await import("@/lib/preview-capture");
            const cap = await capturePreviewUrlForJob({ jobId: j.id, branch, commitSha: null });
            previewUrl = cap.previewUrl ?? freshUrl;
            console.log(`[pre-merge-backstop] Phase 2: refreshed preview for changed branch ${branch} → ${previewUrl}`);
          }
        }
      } catch (e) {
        console.warn(
          `[pre-merge-backstop] Phase 2 refresh-on-change for ${branch} failed (skipping):`,
          e instanceof Error ? e.message : e,
        );
        continue;
      }
      out.scanned++;
      // spectest-error-visible-and-rerunnable Phase 1 — LOOP-GUARDED auto-recovery: with the
      // enqueue's dedup narrowed (an `error` verdict no longer blocks re-enqueue), the backstop
      // now re-fires an errored pre-merge spec-test naturally on the next pass. Guard so a
      // genuinely-erroring run (a real repro-able crash, not a one-off reap) doesn't spin forever
      // — cap the auto-recovery at ONE retry per branch: if ≥2 error verdicts already exist for
      // (slug, branch), skip the standing-pass re-fire. A manual TestNow re-fire (Phase 2 route)
      // bypasses this cap; the guard is only for silent standing-pass loops.
      let skipSpecTest = false;
      try {
        const { data: errorRuns } = await admin
          .from("spec_test_runs")
          .select("id")
          .eq("workspace_id", j.workspace_id)
          .eq("spec_slug", slug)
          .eq("spec_branch", branch)
          .eq("agent_verdict", "error")
          .limit(2);
        if (errorRuns && errorRuns.length >= 2) skipSpecTest = true;
      } catch {
        /* best-effort — if the count read blips, fall through to normal enqueue (its dedup still guards). */
      }
      if (!skipSpecTest) {
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
      }
      // fused-premerge-security-authoritative-drop-standalone Phase 3 — the security leg is GONE.
      // The fused spec-test session (enqueued above) is now the sole pre-merge branch-mode security
      // producer via [[../../scripts/builder-worker]] applyFusedSecurityAsBranchVerdict, which writes
      // the authoritative branch-mode `security-review` row directly from the evidence-backed fused
      // envelope. `out.securityEnqueued` stays on the result shape for backward-compat and is always
      // empty — the fused row is written from runSpecTestJob's completion, not from a separate enqueue.
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
    const { isGoalParentExempt } = await import("@/lib/goals-table");
    const seen = new Set<string>();
    const exemptByGoal = new Map<string, boolean>(); // memoize parent-exemption per (workspace:goalSlug)
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
      // PARENT-GOAL SKIP (parent-goal-not-goal-branch-promotable): a PARENT goal (`is_parent`, or structurally
      // — has child goals / no buildable specs) is EXEMPT from the atomic goal-branch promotion flow (its
      // sub-goals promote independently). Never seed a `goal/{slug}` branch or promote a spec under it. This
      // mirrors `promoteCompleteGoalsToMain`'s parent exemption — M4 (seed/integrate) lacked it, so re-linking
      // a parent goal's already-shipped specs (the growth-director milestone restore) spuriously seeded a goal
      // branch for a goal that has nothing to accumulate. Memoized per goal.
      const exKey = `${j.workspace_id}:${goalSlug}`;
      let exempt = exemptByGoal.get(exKey);
      if (exempt === undefined) {
        exempt = (await isGoalParentExempt(j.workspace_id, goalSlug)).exempt;
        exemptByGoal.set(exKey, exempt);
      }
      if (exempt) { result.skipped.push(slug); continue; }
      // TERMINAL-SPEC SKIP (all-shipped goal seeds nothing): a spec already `shipped`/`folded` landed one-off on
      // main — it bypassed the goal-branch flow entirely, so promoting it now would spuriously seed a goal
      // branch for a done goal. A goal whose member specs are ALL terminal yields zero candidates ⇒ no branch
      // seeded (the requested "skip an all-shipped goal" guard, applied at spec granularity so a goal with SOME
      // in-flight specs still promotes those).
      const specRow = await getSpecFromDb(j.workspace_id, slug);
      if (specRow && (specRow.status === "shipped" || specRow.status === "folded")) { result.skipped.push(slug); continue; }
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
        // parallel-build-serialized-merge-and-deadlock-autobreak Phase 3 — an irreducible rebase
        // conflict (two parallel goal-mates touched the same file at merge time) escalates rather
        // than force-merging. Record one `director_activity` row per escalation + skip; the human
        // resolves via the existing pr-resolve flow.
        if (merge.escalated) {
          result.conflicts.push(c.slug);
          console.warn(`[goal-promote] ${c.slug} → goal/${c.goalSlug}: ESCALATED (irreducible rebase conflict) — ${merge.reason}`);
          try {
            const { recordDirectorActivity } = await import("@/lib/director-activity");
            await recordDirectorActivity(admin, {
              workspaceId: c.workspaceId,
              directorFunction: "platform",
              actionKind: "goal_branch_merge_escalated",
              specSlug: c.slug,
              reason: `serialized rebase-merge (parallel-build Phase 3) escalated: ${merge.reason}. Spec branch ${c.branch} → goal/${c.goalSlug} held; the standing pr-resolve flow (or a human) must reconcile the file overlap before promotion.`,
              metadata: {
                actor: "serialized-rebase-merge-guard",
                goal_slug: c.goalSlug,
                spec_branch: c.branch,
                rebased: merge.rebased,
                autonomous: true,
              },
            });
          } catch {
            /* audit is best-effort — the escalation already surfaced via the conflicts array */
          }
          continue;
        }
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
          `[goal-promote] merged ${c.branch} → goal/${c.goalSlug}${merge.created ? " (seeded from main)" : ""}${merge.rebased ? " (rebased first)" : ""}; stamped goal_branch_sha=${merge.mergeSha.slice(0, 8)}`,
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
// serialize-goal-member-spec-builds Phase 1 — the DISPATCH-TIME serializer.
// ─────────────────────────────────────────────────────────────────────────────
// A goal's member spec builds MUST NOT run concurrently. Grounded in the 2026-07-06 jam: 8 kind='build'
// jobs for guaranteed-ticket-handling member specs all cleared their individual blocked_by leg at once
// and ran concurrently off origin/goal/guaranteed-ticket-handling; #1245/#1246/#1248 collided on
// action-executor.ts imports + the refund handlers and parked DIRTY / needs_attention. The existing
// claim-time blocked_by leg gates each spec individually against ITS OWN blockers, but says nothing
// about goal-mates that ALSO happen to be dispatch-ready this tick — so N goal-mates all pass and race.
//
// This helper is the missing check: for a goal-bound spec, refuse the claim unless (b) NO other build
// job for the same goal is in-flight, AND (c) this spec is the earliest not-yet-built goal-member in
// blocked_by-topological order. Cross-goal parallelism is preserved (two DIFFERENT goals with ready
// specs both dispatch — the check no-ops for one-off specs and for members of other goals).
//
// The "earliest" is a Kahn head: a candidate whose goal-mate blockers are ALL already on the goal
// branch (or shipped) — the same clearance the existing gate + [[sequencePromoteCandidates]] use. Ties
// break by slug so the choice is deterministic across ticks. Read-only against public.specs + goals-
// table SDK + agent_jobs (no raw PM writes). Best-effort per read; a resolver failure fails CLOSED (we
// return { ok: false } and hold — never falsely release a serialized dispatch).
export type GoalMemberBuildDispatchResult =
  | { ok: true }
  | { ok: false; reason: string };

/** The state one goal-member spec presents to the serializer — extracted so the decision is a pure
 *  predicate (unit-testable) and only the reader below has any DB dependency. */
export interface GoalMemberDispatchState {
  slug: string;
  onGoalBranch: boolean;
  status: SpecStatus | null;
  blockedBy: string[];
}

/** An in-flight sibling build row surfaced to the serializer — one active agent_jobs row per goal-mate. */
export interface GoalMemberInflightRow {
  slug: string;
  status: string;
}

/** The PURE core of `evaluateGoalMemberBuildDispatch`. Given the goal + this spec's slug + the full
 *  member state + the in-flight sibling rows, decide whether this spec may dispatch. Kept pure so the
 *  named failing state — "given a goal with 2+ ready member specs, exactly one is claimable at a time"
 *  — is testable without a Supabase seam. Ties break by slug so the decision is deterministic. */
export function decideGoalMemberBuildDispatch(input: {
  slug: string;
  goalSlug: string;
  members: GoalMemberDispatchState[];
  inflight: GoalMemberInflightRow[];
}): GoalMemberBuildDispatchResult {
  const { slug, goalSlug, members, inflight } = input;
  if (members.length === 0) return { ok: true };

  // Earliest ready head — a member is "unbuilt" if not yet on the goal branch and not shipped/folded.
  // A ready head has every goal-mate blocker already on the goal branch (external blockers are the
  // existing gate's concern). Sort by slug so the choice is deterministic across ticks. Computed FIRST
  // (before the in-flight guard) because the guard below must know WHICH in-flight mate is legitimate.
  const memberBySlug = new Map(members.map((m) => [m.slug, m] as const));
  const unbuilt = members.filter(
    (m) => !m.onGoalBranch && m.status !== "shipped" && m.status !== "folded",
  );
  if (unbuilt.length === 0) return { ok: true };

  const readyHeads: string[] = [];
  for (const c of unbuilt) {
    let ready = true;
    for (const b of c.blockedBy) {
      if (b === c.slug) continue;
      const bMember = memberBySlug.get(b);
      if (!bMember) continue; // external / cross-goal blocker — not our concern here
      if (!bMember.onGoalBranch) {
        ready = false;
        break;
      }
    }
    if (ready) readyHeads.push(c.slug);
  }
  if (readyHeads.length === 0) {
    return {
      ok: false,
      reason: `no goal-member of ${goalSlug} has all goal-mate blockers on the goal branch this tick — held; escort re-releases next tick`,
    };
  }
  readyHeads.sort();
  const earliest = readyHeads[0];

  // (b) In-flight guard — hold ONLY when the in-flight goal-mate that holds the slot IS the earliest
  //     ready head. A genuinely-building goal-mate is ALWAYS itself the earliest (it is unbuilt +
  //     alphabetically-first for the whole time it builds, since nothing new integrates while it runs),
  //     so it legitimately owns the serial slot and everyone else must wait — this preserves the
  //     2026-07-06 collision guard (#1245/#1246/#1248 on action-executor.ts). But a NON-earliest
  //     in-flight mate is a same-sweep claim-race artifact: the box fills several build lanes per tick,
  //     sets each to `building`, THEN post-hoc re-queues the losers via this predicate. If a
  //     non-earliest artifact were allowed to block, the whole goal LIVELOCKS — the box claims N mates,
  //     each sees the others `building`, rule (b) holds ALL of them (incl. the true earliest), and they
  //     churn on the 90s cooldown forever with 0 progress (observed 2026-07-12: ceo-org-control-tower +
  //     director-chats-in-message-center stalled at 0 building / 8 queued). So the earliest is never
  //     blocked by a non-earliest artifact; it always wins its slot. Cross-goal parallelism is untouched
  //     (a different goalSlug carries a different member set).
  const inflightSlotHolder = inflight.find((r) => r.slug !== slug && r.slug === earliest);
  if (inflightSlotHolder) {
    return {
      ok: false,
      reason: `another goal-member build is in-flight for goal ${goalSlug} (${inflightSlotHolder.slug} status=${inflightSlotHolder.status}); serialized to prevent hot-file collisions`,
    };
  }

  // (c) Only the earliest ready head may dispatch. A non-earliest member is held regardless of in-flight
  //     state (this is what catches every non-slot-holder, including the race artifacts above).
  if (earliest !== slug) {
    return {
      ok: false,
      reason: `${slug} is not the earliest ready goal-member of ${goalSlug} (${earliest} is next); serialized within the goal`,
    };
  }
  return { ok: true };
}

export async function evaluateGoalMemberBuildDispatch(
  workspaceId: string,
  slug: string,
): Promise<GoalMemberBuildDispatchResult> {
  const goalSlug = await resolveGoalSlugForSpec(workspaceId, slug);
  if (!goalSlug) return { ok: true }; // one-off — no serialization

  const { goalBranchState } = await import("@/lib/specs-table");
  const state = await goalBranchState(workspaceId, goalSlug);
  if (state.specs.length === 0) return { ok: true }; // race: goal resolved but has no members

  const memberSlugs = state.specs.map((s) => s.slug);
  // In-flight seam — any OTHER goal-mate build with an active status. Same ACTIVE_STATUSES seam used by
  // [[enqueueBuildIfDue]] + fold-guard (queued/queued_resume are pre-claim; claimed/building/…
  // /blocked_on_usage all hold a live session).
  const admin = createAdminClient();
  const { data: inflightRows } = await admin
    .from("agent_jobs")
    .select("spec_slug, status")
    .eq("workspace_id", workspaceId)
    .eq("kind", "build")
    .in("spec_slug", memberSlugs)
    .in("status", ["claimed", "building", "needs_input", "needs_approval", "queued_resume", "blocked_on_usage"])
    .neq("spec_slug", slug);
  const inflight: GoalMemberInflightRow[] = (inflightRows ?? []).map((r) => ({
    slug: (r as { spec_slug: string }).spec_slug,
    status: (r as { status: string }).status,
  }));

  // Read each member's blocked_by via getSpecFromDb (the SDK — no raw PM SQL).
  const members: GoalMemberDispatchState[] = [];
  for (const m of state.specs) {
    const spec = await getSpecFromDb(workspaceId, m.slug);
    members.push({
      slug: m.slug,
      onGoalBranch: m.onGoalBranch,
      status: m.status,
      blockedBy: spec?.blocked_by ?? [],
    });
  }

  return decideGoalMemberBuildDispatch({ slug, goalSlug, members, inflight });
}

// ─────────────────────────────────────────────────────────────────────────────
// goal-member-builds-gate-at-enqueue-not-at-claim Phase 1 — enqueue-time admission gate.
// parallel-build-serialized-merge-and-deadlock-autobreak Phase 2 — DAG-aware admission.
// ─────────────────────────────────────────────────────────────────────────────
// The goal-member serializer (evaluateGoalMemberBuildDispatch above + the claim-time legs 4 in
// scripts/builder-worker.ts) enforces goal-mate ordering AFTER the row is already queued: N
// goal-mates land as `queued` rows, then the claim-gate picks one and re-queues the rest each
// tick until they release. That works, but it burns claim-gate ticks on rows that should never
// have been admitted, and (pre-Phase-2) forced every goal single-file through one lane.
//
// This gate moves the "no CONFLICTING goal-mate in-flight" check UP to enqueue time. Before
// enqueueBuildIfDue / queueNextChainedPhase / queueRoadmapBuild inserts a build agent_jobs row
// for a goal-bound spec, it consults evaluateGoalMemberEnqueueAdmission — which under Phase 2
// applies TWO rules (see decideGoalMemberEnqueueAdmission for details):
//   (1) LANE CAP — refuse if the goal already saturates its parallel-lane cap
//       (`GOAL_MEMBER_MAX_PARALLEL_LANES`, matching the box's build pool).
//   (2) BLOCKER-IN-FLIGHT — refuse if any of THIS spec's transitive blockers (within the goal's
//       DAG) is still in-flight. Mutually-independent mates (no direct or transitive blocker
//       relationship) admit CONCURRENTLY — the whole point of Phase 2 (was: blanket "any
//       sibling in-flight refuses", which single-filed every goal through one lane).
// The refused spec stays ELIGIBLE-BUT-UNQUEUED — the reactive enqueue path (buildOnEligible /
// autoQueueUnblockedBy) or the chain reconciler re-queues it the moment the blocker completes.
//
// This does NOT retire the claim-time serializer — that's Phase 2's job. The claim-time gate
// still runs as a defense in depth (any queued row that slipped past the admission gate — e.g.
// via a deliberate raw-insert override the enqueue helpers document — is still serialized at
// claim time). Fail-open on any resolve error (return {ok:true}) so a transient DB glitch never
// falsely blocks an unrelated one-off enqueue.

/** The result of an enqueue-admission check — `ok:true` admits the enqueue, `ok:false` refuses
 *  with a reason legible in the caller's log. Mirrors GoalMemberBuildDispatchResult's shape so
 *  the two serializer legs stay recognizable side-by-side. */
export type GoalMemberEnqueueAdmissionResult =
  | { ok: true }
  | { ok: false; reason: string };

/** parallel-build-serialized-merge-and-deadlock-autobreak Phase 2 — the per-goal parallel
 *  concurrency ceiling. A goal admits at most this many builds at once even when every mate
 *  is mutually independent by blocked_by. Kept module-level so the predicate + async wrapper +
 *  tests share the constant. Chosen to match the box's build/plan pool cap
 *  (`MAX_CONCURRENT = 10` in scripts/builder-worker.ts) — a single goal never starves the box
 *  even when its DAG is fully-independent, and any goal-mates over the cap are held here rather
 *  than piling up as queued rows the claim-gate would reject each tick. */
export const GOAL_MEMBER_MAX_PARALLEL_LANES = 10;

/** The PURE core of `evaluateGoalMemberEnqueueAdmission`.
 *
 *  Phase 2 — DAG-aware admission. Replaces the blanket "any sibling in-flight refuses" rule
 *  (which forced dependency-independent goal-mates single-file, wasting the box's lanes) with:
 *   1. LANE CAP — the count of in-flight OTHER goal-mates must be strictly less than `laneCap`
 *      (default `GOAL_MEMBER_MAX_PARALLEL_LANES`). This is the global concurrency guard — a
 *      goal never floods the box's build pool.
 *   2. BLOCKER-IN-FLIGHT — this spec's TRANSITIVE blocked_by set within the goal's DAG must
 *      not intersect the in-flight set. If any ancestor in the blocker chain is still building
 *      (queued/claimed/building/…), admission is refused; the reactive path re-fires when the
 *      blocker merges. This is the DEFENSE-IN-DEPTH belt against a race where the caller's
 *      `enqueueBuildIfDue` `blocked` gate saw the blocker `cleared` a tick before this
 *      admission read sees it `queued`.
 *
 *  Mutually-independent specs (no direct or transitive blocker relationship) pass BOTH checks
 *  and admit concurrently — the whole point of Phase 2. A self-row in the input is a defense-
 *  in-depth belt against a stale read (the reader also .neq's on slug); it MUST NOT false-
 *  positive-refuse a legitimate re-enqueue of THIS spec.
 *
 *  `members` is REQUIRED for the DAG walk. When absent (legacy caller / a resolver miss), we
 *  fall back to a lane-cap-only check that admits mutually-independent goal-mates concurrently
 *  — the safer default under Phase 2 (an over-admission is handled by the claim-time
 *  serializer + the deadlock-autobreak; an under-admission is exactly the Phase 1 stall we're
 *  fixing). */
export function decideGoalMemberEnqueueAdmission(input: {
  slug: string;
  goalSlug: string;
  inflight: GoalMemberInflightRow[];
  members?: GoalMemberDispatchState[];
  laneCap?: number;
}): GoalMemberEnqueueAdmissionResult {
  const { slug, goalSlug, inflight, members, laneCap = GOAL_MEMBER_MAX_PARALLEL_LANES } = input;

  // Defense-in-depth: strip any self-row (mirrors the reader's `.neq('spec_slug', slug)`) so a
  // legitimate re-enqueue for THIS spec is never falsely blocked.
  const otherInflight = inflight.filter((r) => r.slug !== slug);

  // (1) LANE CAP — global concurrency guard. Refuse when the goal already saturates its
  //     parallel lanes; every extra in-flight goal-mate would just pile up as a queued row.
  if (otherInflight.length >= laneCap) {
    return {
      ok: false,
      reason: `serialized-goal-mate-lane-cap: goal ${goalSlug} already has ${otherInflight.length} in-flight goal-mate build(s) (>= cap ${laneCap}); admission held until a slot frees`,
    };
  }

  // (2) BLOCKER-IN-FLIGHT — transitive walk over this spec's blocked_by within the goal's DAG.
  //     Only fires when `members` is provided (see doc comment for the fallback rationale).
  //     Ignores external blockers (a slug not in the goal's member set) — those are the async
  //     reader's / enqueueBuildIfDue's blocked_by gate's concern, not the goal-serializer's.
  if (members && members.length > 0) {
    const memberBySlug = new Map(members.map((m) => [m.slug, m] as const));
    const thisSpec = memberBySlug.get(slug);
    const transitiveBlockers = new Set<string>();
    const seen = new Set<string>();
    const queue: string[] = [];
    if (thisSpec) {
      for (const b of thisSpec.blockedBy) queue.push(b);
    }
    while (queue.length) {
      const b = queue.shift() as string;
      if (seen.has(b) || b === slug) continue;
      seen.add(b);
      const bMember = memberBySlug.get(b);
      if (!bMember) continue; // external / cross-goal blocker — not our concern here
      transitiveBlockers.add(b);
      for (const bb of bMember.blockedBy) queue.push(bb);
    }
    const blockingInFlight = otherInflight.find((r) => transitiveBlockers.has(r.slug));
    if (blockingInFlight) {
      return {
        ok: false,
        reason: `serialized-goal-mate-blocker-in-flight: goal ${goalSlug} blocker ${blockingInFlight.slug} (${blockingInFlight.status}) is in-flight; admission held until it merges`,
      };
    }
  }

  // Passed both gates — mutually-independent goal-mates admit concurrently. This is the
  // Phase 2 unlock: the CEO's board actually uses the box's parallel lanes instead of
  // single-filing every goal through one slot.
  return { ok: true };
}

/** The DB reader — resolve the goal, list its members (with blocked_by via `getSpecFromDb`),
 *  query agent_jobs for any goal-mate row in ACTIVE_STATUSES, then invoke the pure predicate.
 *  Fail-open: any resolver miss returns {ok:true} so a transient DB error never falsely blocks
 *  the enqueue (the claim-time serializer + the caller's in-flight-per-slug guard remain as
 *  backstops).
 *
 *  Phase 2 — the `.neq('spec_slug', slug)` filter is DROPPED because the DAG walk needs to
 *  know whether a goal-mate that HAPPENS to share this slug's name is in-flight (e.g. a race
 *  where the same spec's prior job hasn't cleared). The pure predicate's self-row filter
 *  catches it as defense-in-depth. */
export async function evaluateGoalMemberEnqueueAdmission(
  workspaceId: string,
  slug: string,
): Promise<GoalMemberEnqueueAdmissionResult> {
  const goalSlug = await resolveGoalSlugForSpec(workspaceId, slug);
  if (!goalSlug) return { ok: true }; // one-off / not goal-bound — no serialization

  const { goalBranchState } = await import("@/lib/specs-table");
  const state = await goalBranchState(workspaceId, goalSlug);
  if (state.specs.length === 0) return { ok: true }; // race: goal resolved but has no members

  const memberSlugs = state.specs.map((s) => s.slug);
  const admin = createAdminClient();
  const { data: inflightRows } = await admin
    .from("agent_jobs")
    .select("spec_slug, status")
    .eq("workspace_id", workspaceId)
    .eq("kind", "build")
    .in("spec_slug", memberSlugs)
    .in("status", ACTIVE_STATUSES);
  const inflight: GoalMemberInflightRow[] = (inflightRows ?? []).map((r) => ({
    slug: (r as { spec_slug: string }).spec_slug,
    status: (r as { status: string }).status,
  }));

  // Phase 2 — read each member's blocked_by so the transitive DAG walk in the pure predicate
  // knows the true blocker chain. Mirrors the pattern in `evaluateGoalMemberBuildDispatch`.
  const members: GoalMemberDispatchState[] = [];
  for (const m of state.specs) {
    const spec = await getSpecFromDb(workspaceId, m.slug);
    members.push({
      slug: m.slug,
      onGoalBranch: m.onGoalBranch,
      status: m.status,
      blockedBy: spec?.blocked_by ?? [],
    });
  }

  return decideGoalMemberEnqueueAdmission({ slug, goalSlug, inflight, members });
}

// ─────────────────────────────────────────────────────────────────────────────
// goal-member-builds-gate-at-enqueue-not-at-claim Phase 2 — release the NEXT
// eligible goal-member on completion of the active one.
// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 slammed the enqueue door: a second goal-mate can't join the queue while a first is
// in-flight. That leaves a hole though — if the first one MERGES and no reactive path enqueues
// the next (Vale reactive lane / autoQueueUnblockedBy don't fire until the WHOLE spec ships),
// the goal's serial slot goes idle until the next platform-director standing pass sweeps it
// up. Under Phase 1 alone that turned "one at a time" into "one every few minutes".
//
// This helper is the release: it runs from `applyMergedBuildEffects` (the shared post-merge
// body — reconcileMergedJobs + handleAutoMergedBuildBranch), AFTER `queueNextChainedPhase`, so
// a chain_phases=true spec's next phase queues FIRST and re-occupies the goal's slot. If the
// completed spec has no chain continuation (or all phases are shipped), the release iterates
// the goal's remaining members in alphabetical order and calls `enqueueBuildIfDue` on each
// until one is admitted. `enqueueBuildIfDue`'s Vale / blocked_by / auto_build gates still
// apply — a not-yet-review-passed / blocked member is skipped and the NEXT candidate tried.
// Phase 1's `evaluateGoalMemberEnqueueAdmission` gate guarantees at most one lands (any second
// insert fails admission), so a re-run of the release is idempotent.

/** The unit `pickNextGoalMemberCandidates` reads — a spec of a goal, plus the shape flags the
 *  release cares about (has it shipped? is it already on the goal branch? we want NEITHER). */
export interface GoalMemberReleaseCandidate {
  slug: string;
  status: SpecStatus | null;
  onGoalBranch: boolean;
}

/** The PURE core of `admitNextGoalMemberOnCompletion`. Given the completed spec + the goal's
 *  member roster, return the ORDERED list of slugs to attempt (sorted alphabetically — the
 *  same Kahn-tiebreak the Phase-1 predicate uses so a re-run picks the same head).
 *
 *  Filters out (a) the just-completed spec itself (its own chain path handles that), (b) any
 *  member already on the goal branch (Gate B done — nothing fresh to admit), and (c) any
 *  member already `shipped`/`folded` (post-Gate-B done). A member without any of those flags
 *  is a candidate; the async caller then delegates to `enqueueBuildIfDue`, which STILL applies
 *  the review/blocker/auto_build gates before inserting a row. */
export function pickNextGoalMemberCandidates(input: {
  completedSlug: string;
  members: GoalMemberReleaseCandidate[];
}): string[] {
  return input.members
    .filter((m) => m.slug !== input.completedSlug)
    .filter((m) => m.status !== "shipped" && m.status !== "folded")
    .filter((m) => !m.onGoalBranch)
    .map((m) => m.slug)
    .sort();
}

/** The DB reader — resolve the goal, list its member roster (via `goalBranchState`), pick the
 *  ordered next-to-admit candidates via the pure predicate, then walk them calling
 *  `enqueueBuildIfDue`. Returns the slug that was admitted, or null (no eligible member —
 *  every other goal-mate is shipped/folded/on-goal-branch/blocked/etc.). Best-effort per
 *  candidate: a resolver miss on one slug logs + moves on to the next. Never throws — the
 *  caller runs it as one of several best-effort post-merge steps. */
export async function admitNextGoalMemberOnCompletion(
  workspaceId: string,
  completedSlug: string,
): Promise<string | null> {
  try {
    const goalSlug = await resolveGoalSlugForSpec(workspaceId, completedSlug);
    if (!goalSlug) return null; // one-off / not goal-bound — no goal slot to release

    const { goalBranchState } = await import("@/lib/specs-table");
    const state = await goalBranchState(workspaceId, goalSlug);
    if (state.specs.length === 0) return null; // race: goal resolved but has no members

    const candidates = pickNextGoalMemberCandidates({
      completedSlug,
      members: state.specs.map((s) => ({ slug: s.slug, status: s.status, onGoalBranch: s.onGoalBranch })),
    });
    if (candidates.length === 0) return null;

    for (const slug of candidates) {
      try {
        const res = await enqueueBuildIfDue(workspaceId, slug, {
          instructions: `goal-member serial release (Phase 2): prior goal-mate ${completedSlug} merged — admitting the next eligible member of goal ${goalSlug}.`,
        });
        if (res.enqueued) {
          console.log(
            `[goal-member-release] admitted ${slug} on completion of ${completedSlug} (goal ${goalSlug}); jobId=${res.jobId}`,
          );
          return slug;
        }
        // parallel-build-serialized-merge-and-deadlock-autobreak Phase 2 — a lane-cap refusal
        // means the goal already saturates its parallel-lane budget; no later candidate would
        // admit either, so stop iterating. A blocker-in-flight refusal (or the legacy
        // "serialized-goal-mate-in-flight" reason from a pre-Phase-2 fallback caller) is
        // candidate-specific — the NEXT candidate might be independent of the in-flight
        // blocker, so keep walking. Any other reason (`already-shipped`, `deferred`,
        // `in-review-pending-disposition`, `not-review-passed`, `auto-build-off`, `blocked`,
        // `in-flight`) is a legitimate skip; try the next candidate.
        if (res.reason && res.reason.startsWith("serialized-goal-mate-lane-cap")) {
          console.log(
            `[goal-member-release] goal ${goalSlug} at parallel-lane cap — no fresh release possible (${res.reason})`,
          );
          return null;
        }
        if (res.reason && res.reason.startsWith("serialized-goal-mate-in-flight")) {
          console.log(
            `[goal-member-release] legacy fallback path indicates slot already re-occupied for goal ${goalSlug} — no fresh release needed (${res.reason})`,
          );
          return null;
        }
      } catch (e) {
        console.warn(
          `[goal-member-release] enqueueBuildIfDue threw for ${slug} (continuing):`,
          e instanceof Error ? e.message : e,
        );
      }
    }
    return null;
  } catch (e) {
    console.warn(
      `[goal-member-release] release pass threw for ${completedSlug} (best-effort, no-op):`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// parallel-build-serialized-merge-and-deadlock-autobreak Phase 1 — advance a
// stalled goal-serializer head-of-line.
// ─────────────────────────────────────────────────────────────────────────────
// `decideGoalMemberBuildDispatch` (above) names an 'earliest ready head' and
// holds every non-earliest sibling. If that head has NO active build job (never
// enqueued, or the next chained phase was never queued), the whole goal
// DEADLOCKS: the ejected siblings claim→reject every tick, the head never
// starts, and Phase 2's `admitNextGoalMemberOnCompletion` release only fires on
// completion — which never comes. Observed 2026-07-15 on
// bianca-cold-scaler-cohort-and-daily-ceiling: 'cohort-and-ceiling' was the
// earliest but never enqueued; siblings behind it churned on the requeue
// cooldown until a human intervened.
//
// This auto-break runs from the same claim-time hook that ejects the sibling:
// when the claim-time serializer refuses this spec, we ALSO check whether the
// earliest actually has an in-flight job. If NOT, we auto-enqueue the earliest
// (`enqueueBuildIfDue`, bypassing the Phase-1 goal-mate admission gate that
// would otherwise refuse — the earliest IS the designated slot-holder; the
// non-earliest queued mates are race artifacts that will re-eject at claim
// time). A `director_activity` audit row records the break. A short cooldown
// (dedupe against recent auto-break rows) prevents thrash — the auto-break
// fires ONCE per stall per grace window; if the resulting enqueue also stalls,
// the operator sees the audit trail rather than a churn loop.
//
// Fail-open per unit — a resolver miss returns { autoBroken: false } and the
// caller's requeue path is unaffected. Cross-goal parallelism is untouched
// (one-off / not-goal-bound specs no-op here).

/** Verdict from the deadlock-auto-break pure predicate — either the earliest
 *  head is missing from the in-flight set (deadlocked, auto-break should fire)
 *  or a reason we skip. */
export type GoalMemberDeadlockAutoBreakDecision =
  | { deadlocked: true; earliest: string }
  | { deadlocked: false; reason: string };

/** The PURE core of `autoBreakGoalMemberDeadlockIfDue`. Given the member
 *  roster + the current in-flight set (ANY active status, incl. `queued`),
 *  compute the earliest-ready head (Kahn head, alphabetically ties-break) and
 *  return `deadlocked: true` iff that head has NO row in the in-flight set.
 *  Kept pure so the named failing state — "earliest ready head has no in-flight
 *  build job → auto-break fires" — is unit-testable without a Supabase seam. */
export function decideGoalMemberDeadlockAutoBreak(input: {
  members: GoalMemberDispatchState[];
  inflight: GoalMemberInflightRow[];
}): GoalMemberDeadlockAutoBreakDecision {
  const { members, inflight } = input;
  if (members.length === 0) return { deadlocked: false, reason: "no-members" };

  const memberBySlug = new Map(members.map((m) => [m.slug, m] as const));
  const unbuilt = members.filter(
    (m) => !m.onGoalBranch && m.status !== "shipped" && m.status !== "folded",
  );
  if (unbuilt.length === 0) {
    return { deadlocked: false, reason: "no-unbuilt-members" };
  }

  const readyHeads: string[] = [];
  for (const c of unbuilt) {
    let ready = true;
    for (const b of c.blockedBy) {
      if (b === c.slug) continue;
      const bMember = memberBySlug.get(b);
      if (!bMember) continue; // external / cross-goal blocker — not our concern here
      if (!bMember.onGoalBranch) {
        ready = false;
        break;
      }
    }
    if (ready) readyHeads.push(c.slug);
  }
  if (readyHeads.length === 0) {
    return {
      deadlocked: false,
      reason: "no-ready-head: every unbuilt member still has a goal-mate blocker unbuilt",
    };
  }
  readyHeads.sort();
  const earliest = readyHeads[0];

  // Deadlock iff the earliest is NOT in the in-flight set at all (no queued /
  // claimed / building / needs_input / etc. row). If the earliest is present in
  // any active status, the serializer is working correctly — the head owns the
  // slot; no auto-break needed.
  const headInFlight = inflight.some((r) => r.slug === earliest);
  if (headInFlight) {
    return {
      deadlocked: false,
      reason: `head-in-flight: earliest ready head ${earliest} already has an active build row`,
    };
  }

  return { deadlocked: true, earliest };
}

/** Result of the async auto-break — carries the enqueued slug on success so the
 *  caller can log it in its requeue reason. */
export type GoalMemberDeadlockAutoBreakResult =
  | { autoBroken: true; earliest: string; jobId: string | null }
  | { autoBroken: false; reason: string };

/** How long a fresh auto-break for the same earliest slug is suppressed after
 *  we already broke it once. Short enough that a truly-stuck goal (e.g. the
 *  auto-broken build itself immediately failed pre-flight and left no in-flight
 *  row) recovers on the next standing tick; long enough that we don't hammer
 *  director_activity every 90s claim-cooldown. Kept module-level so the tests
 *  and the caller share the constant. */
export const GOAL_MEMBER_DEADLOCK_AUTOBREAK_COOLDOWN_MS = 3 * 60 * 1000;

/** The DB reader — resolve the goal, list its members, read the in-flight
 *  goal-mate rows (across ALL ACTIVE_STATUSES — we need to know if the earliest
 *  is queued/claimed/building/etc., not just building), invoke the pure
 *  predicate, and if it says `deadlocked` enqueue the earliest via a bypass
 *  path (the Phase-1 admission gate would refuse because non-earliest race
 *  artifacts are queued; the earliest IS the designated slot-holder so the
 *  bypass is safe). Emits ONE `director_activity` audit row (`actor` =
 *  `serializer-deadlock-autobreak`) so the operator sees the intervention.
 *  Fail-open: any resolver miss returns `autoBroken:false` with a reason. */
export async function autoBreakGoalMemberDeadlockIfDue(
  workspaceId: string,
  ejectedSlug: string,
): Promise<GoalMemberDeadlockAutoBreakResult> {
  try {
    const goalSlug = await resolveGoalSlugForSpec(workspaceId, ejectedSlug);
    if (!goalSlug) return { autoBroken: false, reason: "not-goal-bound" };

    const { goalBranchState } = await import("@/lib/specs-table");
    const state = await goalBranchState(workspaceId, goalSlug);
    if (state.specs.length === 0) return { autoBroken: false, reason: "goal-has-no-members" };

    const memberSlugs = state.specs.map((s) => s.slug);
    const admin = createAdminClient();

    // Load in-flight goal-mate rows — ALL active statuses, INCLUDING the
    // caller's own. If the earliest is already in-flight (queued / claimed /
    // building / …), the predicate short-circuits with `head-in-flight` and we
    // never enqueue.
    const { data: inflightRows } = await admin
      .from("agent_jobs")
      .select("spec_slug, status")
      .eq("workspace_id", workspaceId)
      .eq("kind", "build")
      .in("spec_slug", memberSlugs)
      .in("status", ACTIVE_STATUSES);
    const inflight: GoalMemberInflightRow[] = (inflightRows ?? []).map((r) => ({
      slug: (r as { spec_slug: string }).spec_slug,
      status: (r as { status: string }).status,
    }));

    const members: GoalMemberDispatchState[] = [];
    for (const m of state.specs) {
      const spec = await getSpecFromDb(workspaceId, m.slug);
      members.push({
        slug: m.slug,
        onGoalBranch: m.onGoalBranch,
        status: m.status,
        blockedBy: spec?.blocked_by ?? [],
      });
    }

    const decision = decideGoalMemberDeadlockAutoBreak({ members, inflight });
    if (!decision.deadlocked) return { autoBroken: false, reason: decision.reason };
    const { earliest } = decision;

    // Grace window — if we already auto-broke for this earliest within the
    // cooldown, skip. The auto-break's insert may still be settling (or the
    // resulting build may have failed pre-flight and vanished); do NOT hammer
    // the audit trail on every 90s requeue tick.
    const cooldownCutoff = new Date(Date.now() - GOAL_MEMBER_DEADLOCK_AUTOBREAK_COOLDOWN_MS).toISOString();
    const { data: recentBreaks } = await admin
      .from("director_activity")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("action_kind", "serializer_deadlock_auto_broken")
      .eq("spec_slug", earliest)
      .gte("created_at", cooldownCutoff)
      .limit(1);
    if (recentBreaks && recentBreaks.length) {
      return { autoBroken: false, reason: `cooldown: recent auto-break for ${earliest} within ${GOAL_MEMBER_DEADLOCK_AUTOBREAK_COOLDOWN_MS}ms` };
    }

    // Bypass the Phase-1 goal-mate admission gate — the earliest IS the
    // designated slot-holder; the other queued mates are race artifacts that
    // will re-eject at the next claim tick. `enqueueBuildIfDue` still applies
    // shipped/deferred/blocked_by/auto_build gates on the earliest itself, so
    // the bypass is scoped narrowly to the goal-mate serializer.
    const enq = await enqueueBuildIfDue(workspaceId, earliest, {
      instructions: `serializer-deadlock-autobreak: goal ${goalSlug} head-of-line ${earliest} had no in-flight build while sibling ${ejectedSlug} was serialized-and-ejected; auto-enqueuing the head to break the stall.`,
      bypassGoalMemberAdmission: true,
    });
    if (!enq.enqueued) {
      return {
        autoBroken: false,
        reason: `earliest ${earliest} not admissible: ${enq.reason ?? "unknown"}`,
      };
    }

    // Supervisor-visible audit — one row per intervention, so the operator can
    // see WHY the earliest was force-enqueued and correlate with the log.
    try {
      const { recordDirectorActivity } = await import("@/lib/director-activity");
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: "platform",
        actionKind: "serializer_deadlock_auto_broken",
        specSlug: earliest,
        reason: `goal-member serializer auto-break: goal ${goalSlug} head-of-line ${earliest} had no in-flight build; sibling ${ejectedSlug} was serialized-and-ejected. Force-enqueued ${earliest} to advance the stalled head.`,
        metadata: {
          actor: "serializer-deadlock-autobreak",
          goal_slug: goalSlug,
          ejected_slug: ejectedSlug,
          job_id: enq.jobId ?? null,
          autonomous: true,
        },
      });
    } catch {
      /* audit is best-effort — the enqueue already landed */
    }

    console.log(
      `[serializer-deadlock-autobreak] goal=${goalSlug} advanced stalled head ${earliest} (ejected sibling ${ejectedSlug}); jobId=${enq.jobId ?? "(unknown)"}`,
    );
    return { autoBroken: true, earliest, jobId: enq.jobId ?? null };
  } catch (e) {
    console.warn(
      `[serializer-deadlock-autobreak] auto-break threw for ${ejectedSlug} (best-effort, no-op):`,
      e instanceof Error ? e.message : e,
    );
    return { autoBroken: false, reason: "threw" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// serialize-goal-member-spec-builds Phase 2 — auto-re-drive a DIRTY goal-member PR.
// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 serialized within-goal dispatch (only one goal-mate builds at a time). Phase 2 handles the
// EXISTING PR that goes DIRTY after the fact: another goal-mate merged onto the goal branch, so this
// PR is now `mergeable_state ∈ {"dirty","behind"}` against its base. Pre-fix, the PR sat parked on the
// board waiting for a human. Post-fix, the reconciler detects it via `getPr(prNumber).mergeableState`
// and enqueues a `pr-resolve` job (the existing rebase-or-rebuild executor — [[github-pr-resolve]]),
// so the PR self-heals back to MERGEABLE without a human touch.
//
// SAFETY (Phase 2 verification — "a PR whose GitHub state can't be read is left untouched"):
//   • FAIL CLOSED on a getPr read failure — never guess DIRTY without a positive read.
//   • FAIL CLOSED on `mergeableState === null` — GitHub is still computing merge state.
//   • FAIL CLOSED on `mergeableState === "unknown"` — GitHub returned the uncertain enum, treat as no-op.
//   • Only re-drives goal-member PRs (one-off / non-goal-bound specs are handled by the existing
//     [[detectAndEnqueueDirtyPrs]] against origin/main).
//
// SCOPE: matches the existing dirty-PR resolver's contract — the enqueue is IDEMPOTENT
// (enqueuePrResolveJob dedupes per PR + is retry-capped), so a repeat detection across ticks is a no-op.

/** The subset of `getPr`'s ok-shape the Phase 2 predicate reads — kept independent of the caller's
 *  full read so the predicate is unit-testable without a fetch stub. */
export interface GoalMemberPrGithubState {
  ok: boolean;
  state?: string;
  merged?: boolean;
  mergeableState?: string | null;
}

/** Which mergeable_state values indicate a goal-member PR needs re-drive. `dirty` = literal conflict;
 *  `behind` = base advanced (a goal-mate merged, no conflict yet but the PR isn't fast-forwardable).
 *  `unstable` is deliberately NOT included — the PR is mergeable, just has a red check; the auto-merge
 *  gate handles that (no rebase needed). `unknown` / `blocked` / null all abstain (fail closed). */
export const GOAL_MEMBER_REDRIVE_MERGEABLE_STATES = new Set(["dirty", "behind"]);

/** PURE Phase 2 predicate — "should this goal-member PR be re-driven?" Given the getPr outcome, decide
 *  `redrive` vs `skip` with a reason. Fail closed on any uncertain / read-failed input. Split out so the
 *  named failing state ("a PR whose GitHub state can't be read is left untouched") is testable end-to-
 *  end without a fetch stub. */
export function decideGoalMemberPrRedrive(pr: GoalMemberPrGithubState): {
  action: "redrive" | "skip";
  reason: string;
} {
  if (!pr.ok) return { action: "skip", reason: "github read failed — fail closed (no false re-drive)" };
  if (pr.merged) return { action: "skip", reason: "PR already merged — nothing to re-drive" };
  if (pr.state !== "open") return { action: "skip", reason: `PR state=${pr.state ?? "(missing)"} — only open PRs are re-drivable` };
  const state = pr.mergeableState;
  if (!state) return { action: "skip", reason: "mergeable_state absent — fail closed (GitHub still computing)" };
  if (state === "unknown") return { action: "skip", reason: "mergeable_state=unknown — fail closed until GitHub settles" };
  if (!GOAL_MEMBER_REDRIVE_MERGEABLE_STATES.has(state)) {
    return { action: "skip", reason: `mergeable_state=${state} — not a re-drive state (clean/unstable/blocked are handled elsewhere)` };
  }
  return { action: "redrive", reason: `mergeable_state=${state} — enqueuing pr-resolve to merge the goal branch into the PR branch` };
}

export interface DirtyGoalMemberReconcileResult {
  checked: number;
  redriven: number;
  skipped: number;
  readFailed: number;
  prs: Array<{ prNumber: number; slug: string; mergeableState: string | null; action: "redrive" | "skip"; reason: string; enqueued: boolean }>;
}

/**
 * serialize-goal-member-spec-builds Phase 2 — the reconciler: enumerate open goal-member build PRs,
 * read each via `getPr`, and enqueue a `pr-resolve` job for every one whose live mergeable_state says
 * it needs re-drive (`dirty` / `behind`). Runs alongside the existing dirty-PR standing pass but scoped
 * to GOAL-MEMBER PRs — Phase 1 stopped these from being CREATED concurrently; Phase 2 makes existing
 * ones self-heal when the goal branch advances beneath them.
 *
 * Enumeration source: `agent_jobs` rows with kind='build' + pr_number != null + status ∈
 * (completed / merged / needs_attention — the terminal-ish states that carry an open PR that may have
 * gone stale). We RE-ASSERT the PR is actually open + goal-bound before enqueueing — the row's
 * `pr_number` is a proxy for "a PR exists"; the confirming predicate is the live `getPr` read + the
 * `resolveGoalSlugForSpec` result (per Bo's mutation-gating coaching: never let a row proxy stand in
 * for the live condition at the action point). Best-effort per PR; never throws.
 */
export async function reconcileDirtyGoalMemberPrs(
  adminClient?: Admin,
): Promise<DirtyGoalMemberReconcileResult> {
  const result: DirtyGoalMemberReconcileResult = { checked: 0, redriven: 0, skipped: 0, readFailed: 0, prs: [] };
  const admin = adminClient || createAdminClient();
  const { getPr, enqueuePrResolveJob } = await import("@/lib/github-pr-resolve");

  // Candidate rows — build jobs carrying a PR number. Filter to plausibly-open PRs (completed +
  // needs_attention are the two states a still-open goal-member PR realistically sits in after its
  // build finished; merged/failed we skip via the .in filter). Order newest-first so the most-recent
  // job per spec is checked first — the older duplicate rows dedupe naturally on getPr's `merged`/
  // `state !== open` skip.
  const { data: rows } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, spec_slug, spec_branch, pr_number, status")
    .eq("kind", "build")
    .not("pr_number", "is", null)
    .in("status", ["completed", "needs_attention"])
    .order("created_at", { ascending: false })
    .limit(200);

  const seen = new Set<string>(); // dedupe per (workspace_id:pr_number) — one check per PR per pass
  for (const row of (rows ?? []) as Array<{ workspace_id: string; spec_slug: string | null; spec_branch: string | null; pr_number: number | null }>) {
    const prNumber = row.pr_number;
    const workspaceId = row.workspace_id;
    const branch = row.spec_branch ?? "";
    const slug = row.spec_slug ?? "";
    if (!prNumber || !branch || !slug || !branch.startsWith("claude/")) continue;
    const key = `${workspaceId}:${prNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // GOAL-BOUND filter — Phase 2 is the goal-member lane. A one-off spec whose PR is dirty is handled
    // by the existing detectAndEnqueueDirtyPrs (which runs against origin/main). Fail closed on the
    // goal-resolve — an unknown goal-membership is treated as non-goal-bound (leaves the PR to the
    // main-based dirty-PR lane, never to a wrong-branch resolver).
    let goalSlug: string | null = null;
    try {
      goalSlug = await resolveGoalSlugForSpec(workspaceId, slug);
    } catch {
      goalSlug = null;
    }
    if (!goalSlug) continue;

    result.checked++;
    const pr = await getPr(prNumber);
    if (!pr.ok) {
      result.readFailed++;
      result.prs.push({ prNumber, slug, mergeableState: null, action: "skip", reason: "github read failed", enqueued: false });
      continue;
    }
    const state = pr.mergeableState;
    const decision = decideGoalMemberPrRedrive({ ok: true, state: pr.state, merged: pr.merged, mergeableState: state });
    if (decision.action !== "redrive") {
      result.skipped++;
      result.prs.push({ prNumber, slug, mergeableState: state, action: "skip", reason: decision.reason, enqueued: false });
      continue;
    }

    // Enqueue — enqueuePrResolveJob dedupes per PR + is retry-capped, so a repeat detection across
    // ticks is inert. Best-effort: an insert failure leaves the row for the next tick.
    let enqueued = false;
    try {
      const r = await enqueuePrResolveJob(admin, { workspaceId, prNumber, branch });
      enqueued = r.enqueued === true;
    } catch (e) {
      console.warn(`[goal-member-redrive] pr-resolve enqueue failed for PR #${prNumber}:`, e instanceof Error ? e.message : e);
    }
    if (enqueued) result.redriven++;
    else result.skipped++;
    result.prs.push({ prNumber, slug, mergeableState: state, action: "redrive", reason: decision.reason, enqueued });
  }
  return result;
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
  /** spec slugs the reactive fold lane actually folded this pass (post-M5-goal-finalization). */
  foldedNow: string[];
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
 * Then it mirrors `applyMergedBuildEffects`'s post-ship hook in FULL (post-M5-goal-finalization — closing the
 * gap where a goal-bound spec shipped to main but never folded the way a one-off does):
 *   1. CARD-LEVEL provenance — `stampSpecMergeProvenance(slug, { pr: null, merge_sha })` for EVERY member
 *      spec (not just zero-phase one-shots). A goal-bound spec lands via the atomic goal→main merge with no
 *      per-spec PR, so `specs.merged_pr` stays null but `specs.last_merge_sha` must carry the M5 merge SHA —
 *      otherwise the card reads "shipped with no merge provenance" (drift-suspect) on the board.
 *   2. `enqueueSpecTestIfDue(ws, slug, "shipped")` — the spec-test entry (no-ops if a fresh run already exists,
 *      e.g. the pre-merge run; the existing green run carries the fold).
 *   3. `reactiveFoldOnGateComplete(ws, slug)` — the SAME reactive fold a one-off spec uses post-merge
 *      ([[applyMergedBuildEffects]]). This is the missing leg: M5 stamped shipped but never invoked the fold
 *      lane, so the goal-bound specs sat derived-shipped forever (a one-off folds because IT calls this). Now
 *      that the spec is genuinely derived-shipped (the in_testing deriver treats phase merge_sha as "on main")
 *      with a green spec-test + clean security, the fold gate folds it the instant M5 runs.
 * Best-effort per spec — one spec's stamp/fold failure never blocks the rest. Idempotent: a phase already
 * `shipped`/`rejected` is left as-is (stampPhaseShipped is a targeted update; re-stamping shipped is inert),
 * the reactive fold no-ops a spec already folded/ineligible, so a re-run after a partial promotion converges.
 */
export async function applyGoalPromotionEffects(
  workspaceId: string,
  goalSlug: string,
  mergeSha: string,
): Promise<GoalPromotionEffects> {
  const out: GoalPromotionEffects = { stampedSpecs: [], phasesStamped: 0, foldsTriggered: [], foldedNow: [] };
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
      }
      // CARD-LEVEL provenance for EVERY member spec (post-M5-goal-finalization), not just the zero-phase
      // one-shot. The atomic goal→main merge has no per-spec PR, so `merged_pr` stays null — but
      // `last_merge_sha` MUST carry the M5 SHA so the card reads "shipped + merge-stamped", not drift-suspect.
      await stampSpecMergeProvenance(workspaceId, slug, { pr: null, merge_sha: mergeSha });
      out.stampedSpecs.push(slug);
      // Trigger the fold pipeline for the now-shipped spec (mirror applyMergedBuildEffects' post-ship hook).
      try {
        const r = await enqueueSpecTestIfDue(workspaceId, slug, "shipped");
        if (r.enqueued) out.foldsTriggered.push(slug);
      } catch (e) {
        console.warn(`[goal-promote-effects] ${slug} fold-trigger failed (continuing):`, e instanceof Error ? e.message : e);
      }
      // REACTIVE FOLD — the leg the one-off path has and M5 was missing. Route the now-derived-shipped spec
      // through the SAME fold lane a one-off spec uses after merge ([[reactiveFoldOnGateComplete]] →
      // getAutoFoldEligibleSlugs → autoFoldVerifiedSpecs). No-ops unless the spec is genuinely fold-eligible
      // (derived-shipped ∧ machine spec-test pass ∧ clean security); when it is, it folds the instant M5 runs
      // instead of lingering on the active board. Idempotent + best-effort.
      try {
        const { reactiveFoldOnGateComplete } = await import("@/lib/spec-test-runs");
        const fold = await reactiveFoldOnGateComplete(workspaceId, slug, { reason: "goal→main M5 ship" });
        if (fold && fold.foldedSlugs.includes(slug)) out.foldedNow.push(slug);
      } catch (e) {
        console.warn(`[goal-promote-effects] ${slug} reactive fold failed (continuing):`, e instanceof Error ? e.message : e);
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

export interface GoalFinalizeResult {
  /** the goal's status was flipped greenlit → complete (the explicit lifecycle override). */
  completed: boolean;
  /** a kind='goal-fold' job was enqueued (or already in-flight) to fold the goal into the brain + retire it. */
  foldQueued: boolean;
  /** an existing in-flight/terminal goal-fold or already-folded goal short-circuited the enqueue. */
  reason?: string;
}

/**
 * post-M5-goal-finalization — RETIRE a goal that just promoted to main. A goal that completed the full path
 * (every member spec on the goal branch, then the atomic goal→main merge) was previously left lingering as
 * `greenlit`: M5 stamped the SPECS shipped but never touched the GOAL row, and nothing enqueued a goal-fold.
 * A promoted goal stuck `greenlit` would re-evaluate every standing pass (harmless but never settling) and
 * sit forever on the active board — the gap this closes so the Growth path retires cleanly.
 *
 * Two steps, both through the sanctioned SDK / lane (no raw PM SQL, no raw goal-status poke):
 *   1. `setGoalStatus(goalId, 'complete')` — the EXPLICIT lifecycle override the SDK doc sanctions for
 *      `greenlit → complete`. The board normally DERIVES `complete` (goalRowToCard, when every milestone
 *      rolls up), but the stored column stays `greenlit` after M5 — and the goal-fold lane's guard reads the
 *      STORED status (`getGoal().status === 'complete'`). So we make the derived truth explicit on the row so
 *      the fold lane accepts it. Idempotent: a goal already `complete`/`folded` skips the flip.
 *   2. Enqueue ONE `kind='goal-fold'` job (the existing goal-fold lane — `runGoalFoldJob` folds the goal's
 *      durable knowledge into the permanent brain pages, then flips the row to `folded`). Deduped: skips if a
 *      goal-fold job is already in-flight for the slug, or the goal is already `folded`.
 *
 * Best-effort + idempotent; never throws (a failure here never un-ships the promoted code). `agent_jobs` is
 * not a PM table, so the goal-fold enqueue is a plain insert (the goal-status write is the only PM write, via
 * the SDK).
 */
export async function finalizePromotedGoal(
  workspaceId: string,
  goalSlug: string,
  adminClient?: Admin,
): Promise<GoalFinalizeResult> {
  const out: GoalFinalizeResult = { completed: false, foldQueued: false };
  const admin = adminClient || createAdminClient();
  try {
    const { getGoal, setGoalStatus } = await import("@/lib/goals-table");
    const goal = await getGoal(workspaceId, goalSlug);
    if (!goal) return { ...out, reason: "no-goal-row" };
    if (goal.status === "folded") return { ...out, reason: "already-folded" };

    // (1) Explicit greenlit → complete override so the goal-fold lane's stored-status guard accepts it.
    if (goal.status !== "complete") {
      await setGoalStatus(goal.id, "complete", `goal-finalize:m5-promote:${goalSlug}`);
      out.completed = true;
    }

    // (2) Enqueue the goal-fold (deduped on an in-flight goal-fold for this slug). The lane flips → folded.
    const { data: inflight } = await admin
      .from("agent_jobs")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", goalSlug)
      .eq("kind", "goal-fold")
      .in("status", ["queued", "queued_resume", "building", "claimed", "needs_input"])
      .limit(1);
    if (inflight && inflight.length) return { ...out, reason: "goal-fold-in-flight" };

    const { data: inserted, error } = await admin
      .from("agent_jobs")
      .insert({
        workspace_id: workspaceId,
        spec_slug: goalSlug, // the goal-fold lane carries the GOAL slug on spec_slug
        kind: "goal-fold",
        status: "queued",
        created_by: null,
      })
      .select("id")
      .single();
    if (error) return { ...out, reason: `goal-fold-insert-failed: ${error.message}` };
    await emitJobQueued(admin, {
      workspace_id: workspaceId,
      spec_slug: goalSlug,
      kind: "goal-fold",
      job_id: (inserted as { id?: string } | null)?.id ?? null,
      actor: "finalizePromotedGoal",
    });
    out.foldQueued = true;
    return out;
  } catch (e) {
    console.warn(`[goal-finalize] ${goalSlug} finalize failed (continuing):`, e instanceof Error ? e.message : e);
    return { ...out, reason: e instanceof Error ? e.message : String(e) };
  }
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
  /** per promoted goal, the post-M5 finalize outcome (greenlit→complete + goal-fold enqueue). */
  finalized: Record<string, GoalFinalizeResult>;
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
  const result: PromoteGoalsToMainResult = { promoted: [], conflicts: [], parentExempt: [], notReady: [], effects: {}, finalized: {} };
  const admin = adminClient || createAdminClient();
  if (!ghToken()) return result;
  try {
    const { listGoals, isGoalParentExempt, stampGoalPromotedToMain, stampGoalPromotionHeld } = await import("@/lib/goals-table");
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
          // goal-promotion-fold-collision-and-held-surfacing Phase 2 — PERSIST the HELD state on the goal
          // row so the roadmap reader can surface "HELD — needs owner" with the exact conflict reason. The
          // 2026-07-06 centralized-commerce-sdk incident's root failure was invisibility: the 409 was
          // console.warn'd here and NOTHING else, so the founder found the goal live-broken. Fail OPEN if
          // the write itself throws — a promote-pass failure never blocks the next pass; the console.warn
          // + the in-memory `result.conflicts` still surface the conflict elsewhere.
          try {
            await stampGoalPromotionHeld(
              goal.id,
              merge.reason ?? "atomic goal→main merge returned 409 with no reason",
              `m5-promote:${goalSlug}`,
            );
          } catch (e) {
            console.warn(`[goal-main-promote] ${goalSlug} stampGoalPromotionHeld failed (continuing):`, e instanceof Error ? e.message : e);
          }
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
        // goal-promotion-fold-collision-and-held-surfacing Phase 2 — PERSIST the atomic merge SHA on the
        // goal row so the roadmap reader knows the goal's code has ACTUALLY landed on main. Also clears any
        // prior HELD reason (a previously-409'd goal that just landed drops its badge in the same write).
        // Runs BEFORE `applyGoalPromotionEffects` so any reader firing off the effect chain (spec-fold gate,
        // control-tower heartbeat) sees the promoted state. Best-effort — never blocks the effects.
        try {
          await stampGoalPromotedToMain(goal.id, merge.mergeSha, `m5-promote:${goalSlug}`);
        } catch (e) {
          console.warn(`[goal-main-promote] ${goalSlug} stampGoalPromotedToMain failed (continuing):`, e instanceof Error ? e.message : e);
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
        // Promotion effects — the SHIPPED stamp (the only shipped-writer) + per-spec fold trigger + reactive fold.
        const effects = await applyGoalPromotionEffects(workspaceId, goalSlug, merge.mergeSha);
        result.promoted.push(goalSlug);
        result.effects[goalSlug] = effects;
        // one-off-spec-depending-on-goal-work-blocks-on-the-goal-not-the-member-spec Phase 2 — the
        // OUTSIDE-DEPENDENT auto-queue leg. `applyGoalPromotionEffects` already fires
        // `autoQueueUnblockedBy(memberSpec.slug)` for each goal-mate leg. That path only catches
        // dependents whose stored `blocked_by` matches a member-spec slug AS A SPEC blocker — which is
        // the goal-mate case (Phase 1 leaves goal-mates as `kind:"spec"`). An OUTSIDE dependent's
        // resolved blocker is `kind:"goal"` with `slug=goalSlug`, so the per-member calls silently
        // skip it. This sweep releases those outside dependents the moment the goal's atomic promotion
        // stamped `main_merge_sha` (see [[autoQueueUnblockedByGoal]] for the pure predicate + guards).
        try {
          const outsideQueued = await autoQueueUnblockedByGoal(workspaceId, goalSlug);
          if (outsideQueued.length) {
            console.log(`[goal-main-promote] ${goalSlug} outside-dependent auto-queue → ${outsideQueued.join(", ")}`);
          }
        } catch (e) {
          console.warn(`[goal-main-promote] ${goalSlug} outside-dependent unblock failed (continuing):`, e instanceof Error ? e.message : e);
        }
        // post-M5-goal-finalization — RETIRE the goal itself: greenlit → complete (explicit override) + enqueue
        // the goal-fold lane (folds into the brain + flips → folded). Without this the promoted goal lingers as
        // `greenlit` on the active board forever (the gap observed live on noop-goal-v2).
        const finalize = await finalizePromotedGoal(workspaceId, goalSlug, admin);
        result.finalized[goalSlug] = finalize;
        console.log(
          `[goal-main-promote] ATOMIC promoted ${goalSlug} → main (${merge.mergeSha.slice(0, 8)}); stamped ${effects.phasesStamped} phase(s) across ${effects.stampedSpecs.length} spec(s) shipped; folded-now: ${effects.foldedNow.join(", ") || "—"}; goal-finalize: complete=${finalize.completed} fold-queued=${finalize.foldQueued}${finalize.reason ? ` (${finalize.reason})` : ""}`,
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

export interface CompletedGoalFoldResult {
  /** goals folded this pass (rollup 100%, non-parent) — `previous` is the derived status before the fold. */
  folded: { slug: string; previous: string }[];
  /** goals evaluated at 100% but KEPT — a parent (is_parent / has-children / no-specs) or already mid-fold. */
  kept: { slug: string; reason: string }[];
}

/**
 * completed-goal-self-archive — the STANDING reconciler that folds a COMPLETE NON-PARENT goal into the
 * Archive on its own, so a goal whose rollup reached 100% never sits stranded on the active board waiting
 * for a manual backfill.
 *
 * THE GAP THIS CLOSES: the atomic goal→main retire path (`promoteCompleteGoalsToMain` → `finalizePromotedGoal`)
 * fires ONLY for a goal that shipped THROUGH a goal branch. LEGACY goals whose member specs shipped one-off
 * (no `goal/{slug}` branch, so the M5 promoter never evaluated them) reach a 100% rollup but never get the
 * greenlit→complete + goal-fold enqueue — they linger forever as `greenlit`/`complete` on the active board
 * (the 8 goals Dylan hand-backfilled to `folded`). This is the FORWARD fix: every standing pass, any
 * non-parent 100% goal self-folds via the SAME sanctioned path, so completed goals self-archive — no manual
 * backfill.
 *
 * For each ACTIVE (non-folded) goal in the PM workspace (`getGoals` drops folded rows = never a candidate):
 *   1. ROLLUP 100% — require the DERIVED card `status === 'complete'` (every milestone rolls up complete =
 *      every member spec shipped|folded) AND `linkedSpecCount >= 1`. A goal with 0 specs or any milestone
 *      < 100% is LEFT ALONE — never fold an empty or partial goal.
 *   2. PARENT EXEMPTION — skip a PARENT goal via `isGoalParentExempt`: `is_parent` flag OR it HAS child
 *      goals (`goalHasChildGoals` counts EVERY child row, INCLUDING already-folded children — the structural
 *      signal that exempts `ceo-mode`, which has `is_parent=false` but 8 children) OR it has no buildable
 *      member specs. A parent stays active at 100% awaiting its sub-goals; it NEVER auto-folds. This is the
 *      critical guard: the parent test is is_parent OR has-children, not is_parent alone.
 *   3. FOLD — `finalizePromotedGoal` (the sanctioned retire path, reused from M5): greenlit/complete →
 *      complete (explicit override via `setGoalStatus`) + enqueue ONE `kind='goal-fold'` job (the lane folds
 *      the goal's durable knowledge into the brain archive doc, then flips status → `folded`). The goal moves
 *      to the Archive section next pass.
 *
 * IDEMPOTENT: a folded goal is off `getGoals` (never re-evaluated); `finalizePromotedGoal` no-ops an
 * already-folded goal and DEDUPES an in-flight goal-fold (a goal mid-fold is reported `kept`, never
 * double-enqueued). BOUNDED (the active goal set). LOGGED: one `reconciled_completed_goal_folded`
 * director_activity row per goal folded (never silent). Best-effort per goal — one goal's failure never
 * blocks the rest; never throws.
 */
export async function reconcileCompletedGoalsToFolded(
  workspaceId: string,
  adminClient?: Admin,
): Promise<CompletedGoalFoldResult> {
  const out: CompletedGoalFoldResult = { folded: [], kept: [] };
  const admin = adminClient || createAdminClient();
  try {
    const { getGoals } = await import("@/lib/brain-roadmap");
    const { isGoalParentExempt } = await import("@/lib/goals-table");
    const goals = await getGoals(workspaceId); // active (non-folded) GoalCards; rollup status DERIVED
    for (const goal of goals) {
      try {
        // (1) ROLLUP 100% — DERIVED complete (every milestone's specs shipped|folded) AND ≥1 member spec.
        //     status==='complete' already implies ≥1 milestone all-done; the linkedSpecCount guard is the
        //     explicit "never fold an empty 0-spec goal" belt-and-suspenders.
        if (goal.status !== "complete" || goal.linkedSpecCount < 1) continue;
        // (2) PARENT EXEMPTION — is_parent OR has child goals (incl. folded) OR no buildable specs → KEEP.
        const exempt = await isGoalParentExempt(workspaceId, goal.slug);
        if (exempt.exempt) {
          out.kept.push({ slug: goal.slug, reason: exempt.reason });
          continue;
        }
        // (3) FOLD via the sanctioned retire path (greenlit/complete → complete + goal-fold enqueue).
        const fin = await finalizePromotedGoal(workspaceId, goal.slug, admin);
        if (fin.foldQueued || fin.completed) {
          out.folded.push({ slug: goal.slug, previous: goal.status });
          // Supervisor-visible report: one director_activity row per goal folded (never silent).
          try {
            const { recordDirectorActivity } = await import("@/lib/director-activity");
            await recordDirectorActivity(admin, {
              workspaceId,
              directorFunction: "platform",
              actionKind: "reconciled_completed_goal_folded",
              specSlug: goal.slug,
              reason: `reconciler:completed-goal-self-archive folded the completed goal '${goal.slug}' — its rollup is 100% (${goal.linkedSpecCount} member spec(s) all shipped|folded across ${goal.milestones.length} milestone(s)) and it is NOT a parent goal, but it never retired (it shipped one-off, so the atomic goal→main path never evaluated it). Ran the sanctioned retire path (greenlit/complete → complete + goal-fold enqueue) so it self-archives into the brain + moves to the Archive section.`,
              metadata: {
                actor: "reconciler:completed-goal-self-archive",
                signal: "completed-goal-not-folded",
                linked_spec_count: goal.linkedSpecCount,
                milestones: goal.milestones.length,
                completed: fin.completed,
                fold_queued: fin.foldQueued,
                finalize_reason: fin.reason ?? null,
              },
            });
          } catch {
            /* audit is best-effort — the fold already enqueued */
          }
        } else {
          // already mid-fold (in-flight goal-fold deduped) or a benign no-op — record as kept for visibility.
          out.kept.push({ slug: goal.slug, reason: fin.reason ?? "finalize no-op" });
        }
      } catch (e) {
        console.warn(`[completed-goal-self-archive] ${goal.slug} fold threw (continuing):`, e instanceof Error ? e.message : e);
      }
    }
    return out;
  } catch (e) {
    console.error("[completed-goal-self-archive] pass failed:", e instanceof Error ? e.message : e);
    return out;
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
    // (The wider "any status" dedupe stays here as a superset of enqueueBuildIfDue's ACTIVE-only guard
    //  — after this spec ships once, we don't re-queue on a re-run of the unblock reconcile.)
    const { data: existing } = await admin
      .from("agent_jobs")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", dep.slug)
      .eq("kind", "build")
      .limit(1);
    if (existing && existing.length) continue;

    // bo-reactive-gated-build-enqueue Phase 1: route through the gated chokepoint instead of a raw
    // insert. Previously we filtered only `autoBuild!==false` + blockers cleared + dedup, so an
    // unblocked-but-un-Vale-passed dependent got a `queued` build row that the claim-gate then held
    // — the premature row the CEO saw on the board. enqueueBuildIfDue re-checks the FULL eligibility
    // gate (specReviewDone + not-deferred + not-shipped + auto_build + blockers + in-flight); if the
    // dependent hasn't passed Vale yet the enqueue no-ops here, and Phase 2's reactive
    // `build/spec-build-eligible` event re-fires when Vale passes.
    const res = await enqueueBuildIfDue(workspaceId, dep.slug, {
      instructions: `Auto-queued by spec-blockers: prerequisite ${shippedSlug} shipped, clearing the last blocker.`,
    });
    if (res.enqueued) queued.push(dep.slug);
  }
  return queued;
}

/**
 * one-off-spec-depending-on-goal-work-blocks-on-the-goal-not-the-member-spec Phase 2 — the
 * GOAL-shipping counterpart to `autoQueueUnblockedBy`. Called from `promoteCompleteGoalsToMain` the
 * moment `stampGoalPromotedToMain(goalId, mergeSha, …)` succeeds — the atomic goal→main promotion
 * just landed AND `goals.main_merge_sha` is now non-null. Every outside dependent whose LAST
 * uncleared blocker is a goal blocker on `goalSlug` is now enqueue-eligible; this fan-out enqueues
 * their build via the SAME gated chokepoint (`enqueueBuildIfDue`) the spec-shipping unblock uses.
 *
 * SCOPE — this ONLY re-releases outside dependents (a spec NOT in `goalSlug`). Goal-mates were
 * already released by the per-member `autoQueueUnblockedBy` calls in `applyGoalPromotionEffects`
 * (their blocker leg is a plain spec slug, not a goal blocker — Phase 1 leaves goal-mates as
 * `kind:"spec"`). This function is IDEMPOTENT with those calls: the goal-mate dependency's
 * blocked_by ISN'T `kind:"goal"`, so `isReadyForGoalUnblock` filters it out.
 *
 * Guards (Bo coaching — "confirming predicate at the action point"):
 *   - `isReadyForGoalUnblock` re-asserts BOTH "mentions THIS goal as a goal blocker" AND "every
 *     blocker is cleared" against the fresh roadmap read — so a card that just picked up a NEW
 *     external blocker between the goal ship and the sweep is correctly held.
 *   - Per-spec dedup on `agent_jobs` (any-status match) before enqueue — one auto-queue per spec.
 *   - `enqueueBuildIfDue` re-checks the FULL eligibility gate (specReviewDone + not-deferred +
 *     not-shipped + auto_build + blockers + in-flight) — an un-Vale-passed dependent no-ops here
 *     and the reactive `build/spec-build-eligible` event re-fires when Vale later passes.
 *
 * Best-effort per spec — one dependent's failure never blocks the rest. Never throws. Returns the
 * slugs it enqueued (empty when nothing changed).
 */
export async function autoQueueUnblockedByGoal(
  workspaceId: string,
  goalSlug: string,
): Promise<string[]> {
  if (!goalSlug || typeof goalSlug !== "string") return [];
  const { isReadyForGoalUnblock } = await import("@/lib/blocker-goal-normalize");
  // Fresh roadmap read — resolveBlockedBy already threads `goals.main_merge_sha` into the
  // goal-blocker's `cleared` predicate (Phase 1), so the sweep runs against the just-stamped state.
  const { specs } = await getRoadmap(workspaceId);
  const dependents = specs.filter((s) => isReadyForGoalUnblock(s, goalSlug));
  if (!dependents.length) return [];

  const admin = createAdminClient();
  const queued: string[] = [];
  for (const dep of dependents) {
    try {
      // Dedupe (same shape as `autoQueueUnblockedBy`): a card with ANY existing build job (queued /
      // in-flight / merged / failed) is skipped — the "one auto-queue per spec" guarantee. The
      // wider "any status" dedupe is a deliberate superset of `enqueueBuildIfDue`'s ACTIVE-only
      // guard so a re-run of this sweep (after another goal ships) never doubles up.
      const { data: existing } = await admin
        .from("agent_jobs")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("spec_slug", dep.slug)
        .eq("kind", "build")
        .limit(1);
      if (existing && existing.length) continue;

      const res = await enqueueBuildIfDue(workspaceId, dep.slug, {
        instructions: `Auto-queued by spec-blockers: goal ${goalSlug} landed on main, clearing the last blocker.`,
      });
      if (res.enqueued) queued.push(dep.slug);
    } catch (e) {
      console.warn(
        `[goal-unblock] ${dep.slug} auto-queue on goal ${goalSlug} failed (continuing):`,
        e instanceof Error ? e.message : e,
      );
    }
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
/**
 * chained-phase-session-resume Phase 1 — resume window: how fresh the prior phase's session must be to
 * warrant a `--resume`. Anthropic's prompt-cache TTL is ~1h; a resume past that reads the whole transcript
 * back at full price, so a fresh session is CHEAPER once we're out of the cache window. Sized under the
 * TTL to leave headroom (a chain of ~10-15 min phases stays well inside 55 min). Sourced from the prior
 * build job's `last_heartbeat_at` (or `updated_at` if never heartbeated).
 */
export const CHAINED_RESUME_WINDOW_MS = 55 * 60 * 1000;

/**
 * chained-phase-session-resume Phase 1 — transcript-size cap: after this many phases have already been
 * built on the same session, start fresh instead of resuming. Each resumed phase compounds the transcript
 * (Claude's context window + the 0.1x cache-read cost of re-serving the whole prior transcript), so past
 * some depth a fresh reset is cheaper AND avoids context-window pressure. Proxy: the number of
 * NON-`planned` phases in the spec BEFORE this next-phase queue (i.e. phases already built through this
 * chain). Kept modest — a very-long / many-phase spec should reset the session periodically.
 */
export const CHAINED_RESUME_MAX_PRIOR_PHASES = 5;

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

  // goal-member-builds-gate-at-enqueue-not-at-claim Phase 1 — enqueue-time admission gate. A
  // chain-continuation for a goal-bound spec is still a fresh `queued` row, so it must respect
  // the same "one goal-mate in-flight at a time" rule as the direct build-enqueue paths.
  // Silently skips (returns null) when a goal-mate is in-flight — the chain resumes on the next
  // reconciler pass once the sibling finishes (reconcileMergedJobs → this same helper).
  const admission = await evaluateGoalMemberEnqueueAdmission(workspaceId, slug);
  if (!admission.ok) {
    console.log(`[chain-advance] ${slug} chain hold: ${admission.reason}`);
    return null;
  }

  // chained-phase-session-resume Phase 1 — carry the just-merged phase's session onto the next phase's
  // build job so `runBuildJob` `--resume`s it (prior transcript served from cache ~0.1x) instead of
  // re-hydrating from scratch at full price. Guarded — if any guard fails we insert FRESH (`queued`, null
  // session) which is a safe, correctness-equivalent fallback: the branch already carries the phase code,
  // resume is purely an optimization.
  const resumeCandidate = await resolveChainedResumeCandidate(admin, workspaceId, slug, spec);

  // intentional override of enqueueBuildIfDue (bo-reactive-gated-build-enqueue Phase 1): a chained
  // phase continuation — the PRIOR phase just merged, so this spec passed Vale by construction (a
  // build only merges after review + all gates). Routing through the gated chokepoint here would
  // re-check the review-pass gate redundantly AND drop the session-resume/chain_phases fields the
  // helper doesn't accept. The dedup + in-flight guards above are the enqueueBuildIfDue equivalents
  // for this narrower "same phase already queued" case.
  const { data: inserted, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: workspaceId,
      spec_slug: slug,
      kind: "build",
      status: resumeCandidate ? "queued_resume" : "queued",
      created_by: null,
      chain_phases: true,
      instructions: scoped,
      claude_session_id: resumeCandidate?.sessionId ?? null,
      claude_session_config_dir: resumeCandidate?.sessionConfigDir ?? null,
    })
    .select("id")
    .single();
  if (error) return null;
  await emitJobQueued(admin, {
    workspace_id: workspaceId,
    spec_slug: slug,
    kind: "build",
    job_id: (inserted as { id?: string } | null)?.id ?? null,
    actor: "queueNextChainedPhase",
    extra: { chained: true, resumed: !!resumeCandidate },
  });
  return next.title;
}

/**
 * chained-phase-session-resume Phase 1 — the guarded decision: should the NEXT chained phase resume the
 * PRIOR phase's session, or start fresh? Reads the most recent build job for this spec that carries a
 * session id (typically the just-merged prior phase) and applies the spec's three guards:
 *
 *   (a) OWNING ACCOUNT HEALTHY — NOT enforced here. `resolveAccountForJob` already pins a resume to its
 *       owner and starts fresh (canStartFresh=true for a build) when that owner is capped, so we honor
 *       that path. Passing the session through even if the account is currently capped is safe: the
 *       dispatcher clears it and starts fresh on a healthy account. Checking here would race the account
 *       pool state (which lives only in the box worker process).
 *   (b) WITHIN THE CACHE WINDOW — gap since the prior job's `last_heartbeat_at` (fallback `updated_at`)
 *       must be under `CHAINED_RESUME_WINDOW_MS` (~55m, under the 1h prompt-cache TTL). Past it the
 *       transcript is cold and re-served at full price, so fresh is cheaper.
 *   (c) TRANSCRIPT NOT HUGE — count the phases already NON-`planned` in the spec (the chain depth so
 *       far). Past `CHAINED_RESUME_MAX_PRIOR_PHASES` the accumulated session is big enough that 0.1x
 *       cache-reads + context-window pressure argue for a fresh reset.
 *
 * Returns the session id + owning config dir to carry forward, or null to insert FRESH. Best-effort:
 * on any DB read failure returns null (fresh is the safe fallback).
 */
async function resolveChainedResumeCandidate(
  admin: Admin,
  workspaceId: string,
  slug: string,
  spec: NonNullable<Awaited<ReturnType<typeof getSpec>>>,
): Promise<{ sessionId: string; sessionConfigDir: string | null } | null> {
  // (c) transcript-size cap — proxy on phase depth so far. A spec whose chain has already produced N+
  // phases resets the session; this counts BEFORE we insert the next phase, i.e. it's the depth of the
  // chain the resume would be BUILDING ON.
  const priorPhaseCount = spec.card.phases.filter((p) => p.status !== "planned").length;
  if (priorPhaseCount > CHAINED_RESUME_MAX_PRIOR_PHASES) return null;

  const { data, error } = await admin
    .from("agent_jobs")
    .select("id, claude_session_id, claude_session_config_dir, last_heartbeat_at, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("kind", "build")
    .not("claude_session_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const sessionId = data.claude_session_id as string | null;
  if (!sessionId) return null;
  const sessionConfigDir = (data.claude_session_config_dir as string | null) ?? null;

  // (b) cache-window guard — gap since the prior job last emitted a heartbeat (fall back to updated_at
  // if the row predates the heartbeat column or never streamed).
  const beatStr = (data.last_heartbeat_at as string | null) ?? (data.updated_at as string | null);
  if (!beatStr) return null;
  const beatMs = Date.parse(beatStr);
  if (!Number.isFinite(beatMs)) return null;
  if (Date.now() - beatMs >= CHAINED_RESUME_WINDOW_MS) return null;

  return { sessionId, sessionConfigDir };
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
      // reactive-fold-on-gate-complete: a post-merge phase-ship that flips the spec derived-`shipped` is the
      // LAST gate when its spec-test + security already cleared (e.g. a re-merge / late phase-ship reconcile
      // of a spec already machine-tested + security-clean). Fire the reactive Gate-B trigger so it folds the
      // instant it ships instead of waiting for the daily backstop. The common fresh-merge case no-ops (the
      // post-merge security review the security-dependency hook just enqueued hasn't completed yet, so the spec
      // isn't eligible) and defers to the security-clean trigger. Idempotent + best-effort.
      try {
        const { reactiveFoldOnGateComplete } = await import("@/lib/spec-test-runs");
        await reactiveFoldOnGateComplete(workspaceId, slug, { reason: "post-merge ship" });
      } catch {
        /* best-effort — the security-clean trigger + the daily backstop still fold it */
      }
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
  // ship-time-data-backfills-run-and-ledgered-not-silently-dead-code Phase 1: scan the merged diff for
  // scripts/_backfill-*.ts additions, upsert them into the public.data_op_runs ledger, and ESCALATE any
  // row without a `ran` outcome to the CEO inbox. Mirrors the migration-drift safety net — a shipped
  // one-time data-op that silently never executes is a build-platform correctness hole. Best-effort +
  // idempotent (the detector dedupes its own escalation per (spec, script, UTC day)); the loop beats
  // its own heartbeat inside a try/finally so nothing here can break the merge hook.
  try {
    const { detectAndEscalateShipTimeBackfills } = await import("@/lib/ship-time-backfill-detector");
    await detectAndEscalateShipTimeBackfills({
      workspaceId,
      specSlug: slug,
      prNumber: opts.prNumber ?? null,
      mergeSha: opts.mergeSha ?? null,
    });
  } catch {
    /* best-effort — a missed detector pass fires again on the next merged claude/* build */
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
  // goal-member-builds-gate-at-enqueue-not-at-claim Phase 2 — release the next eligible goal-member.
  // Ordered AFTER `queueNextChainedPhase` so a chain_phases=true spec's next phase queues FIRST
  // and re-occupies the goal's serial slot (this release then observes it via the Phase 1 gate
  // and no-ops). A non-chain spec / a spec whose rollup just shipped leaves the slot open —
  // this loop then admits the alphabetically-first eligible goal-mate. Best-effort; the daily
  // platform-director standing pass is the backstop if this misses.
  try {
    await admitNextGoalMemberOnCompletion(workspaceId, slug);
  } catch {
    /* best-effort — the platform-director standing pass re-attempts a release next tick */
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
        // reactive-fold-on-gate-complete: this back-fill just flipped a stuck-merged spec derived-`shipped`
        // (the noop-pipeline-test-4 recovery case). If its spec-test + security already cleared (they often
        // have by the time this reconcile catches a stale merge), it is now fold-eligible — fire the reactive
        // Gate-B trigger so it folds on this reconcile pass instead of waiting for the daily backstop.
        // Idempotent + no-ops when a gate is still open. Best-effort.
        try {
          const { reactiveFoldOnGateComplete } = await import("@/lib/spec-test-runs");
          await reactiveFoldOnGateComplete(j.workspace_id, slug, { reason: "merged-phase reconcile", admin });
        } catch {
          /* best-effort — the daily spec-test-cron backstop still folds it */
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
