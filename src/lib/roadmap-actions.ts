/**
 * Roadmap build-console actions — the owner-gated, server-revalidated mutations behind both the
 * dashboard buttons AND the Slack Roadmap Console. The logic lives here ONCE: the HTTP routes
 * (`/api/roadmap/{build,answer,approve}`, `/api/branches/[number]/merge`) and the Slack
 * events/interactions handlers both call these, so there is no second copy of the approval logic.
 *
 * Every function takes an explicit `(workspaceId, userId)` and re-checks the owner gate itself —
 * the caller's identity is never trusted. Slack identity (slack-identity.ts) is a UX filter on top;
 * this is the security boundary. See docs/brain/specs/slack-roadmap-console-run-the-build-console-from-slack.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import {
  ACTIVE_STATUSES,
  evaluateGoalMemberEnqueueAdmission,
  getLiveJobForSlug,
  phaseScopedInstructions,
  type AgentJob,
  type PendingAction,
} from "@/lib/agent-jobs";
import { getSpec, getSpecBlockers, phaseEmoji } from "@/lib/brain-roadmap";
import { routingOwnerForJobAsync, mirrorWebDecisionToAdaSlack } from "@/lib/agents/approval-inbox";
import { resolveApproverLive, CEO } from "@/lib/agents/approval-router";
import { recordApprovalDecision } from "@/lib/agents/approval-decisions";

export type ActionResult<T> =
  | ({ ok: true } & T)
  | { ok: false; status: number; error: string };

const REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";

function ghToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}

async function gh(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: text ? JSON.parse(text) : {} };
}

/** Server-side owner gate — the single source of truth both the dashboard and Slack revalidate against. */
async function assertOwner(workspaceId: string, userId: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .single();
  if (!member) return { ok: false, status: 403, error: "Forbidden" };
  if (member.role !== "owner") return { ok: false, status: 403, error: "Only the workspace owner can do that" };
  return { ok: true };
}

// ── Build / fix-build dispatch (mirrors POST /api/roadmap/build) ──

export async function queueRoadmapBuild(
  workspaceId: string,
  userId: string,
  opts: { slug: string; instructions?: string | null; verify?: boolean; chainPhases?: boolean },
): Promise<ActionResult<{ job: AgentJob; alreadyActive?: boolean; queuedBehindActive?: boolean; fold?: boolean; chainPhases?: boolean }>> {
  const gate = await assertOwner(workspaceId, userId);
  if (!gate.ok) return gate;

  const slug = opts.slug;
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/i.test(slug)) {
    return { ok: false, status: 400, error: "bad slug" };
  }

  const admin = createAdminClient();

  // "Mark verified & archive" → coalesce into ONE batch fold-build (enqueue_fold). Mirrors the route.
  if (opts.verify === true) {
    // fold-guard-live-build (Phase 1): refuse to archive a spec while a build/spec-test job for it is still
    // live — folding it would orphan the running build (its spec markdown moves to archive.d/, so a paused
    // build's spec page 404s the instant the fold merges). The owner re-taps once the build is terminal; the
    // auto-fold gate likewise skips a slug with a live job. Verify is the manual mirror of that gate.
    const live = await getLiveJobForSlug(workspaceId, slug, admin);
    if (live) {
      return {
        ok: false,
        status: 409,
        error: `Can't archive — a ${live.kind} build for this spec is still live (${live.status}). It'll fold once that build finishes.`,
      };
    }
    const { data: foldData, error: foldErr } = await admin.rpc("enqueue_fold", {
      p_workspace: workspaceId,
      p_slug: slug,
      p_user: userId,
    });
    if (foldErr) return { ok: false, status: 500, error: foldErr.message };
    const job = (Array.isArray(foldData) ? foldData[0] : foldData) as AgentJob;
    return { ok: true, job, fold: true };
  }

  let instructions = typeof opts.instructions === "string" && opts.instructions.trim() ? opts.instructions : null;

  // review-agent Phase 1 — in_review hard-stop: a spec parked in the `in_review` column is awaiting owner
  // approval and is NOT cleared to build. This is THE guardrail — every build path (BuildButton, Slack
  // `/build`, the planner, the autonomous chain) routes through this enqueue chokepoint, so an in_review
  // spec can't be built by ANY caller. Verify/fold (handled above) is exempt; it retires an already-shipped
  // spec, not a build. The owner approves the spec out of in_review (→ planned) before it's buildable.
  //
  // spec-authoring-writes-db-and-worker-materialize Phase 2: read `public.specs.status` directly (the
  // future-canonical surface, trigger-maintained from `spec_phases`). Falls back to the markdown-overlay
  // `spec_card_state.status` path when no row exists yet (pre-backfill / unauthored slug).
  {
    const { getSpec: getSpecRow } = await import("@/lib/specs-table");
    const row = await getSpecRow(workspaceId, slug);
    const statusFromRow = row?.status ?? null;
    if (statusFromRow === "in_review") {
      return { ok: false, status: 409, error: "spec is in review — not approved to build yet" };
    }
    if (statusFromRow === null) {
      const reviewSpec = await getSpec(slug, workspaceId);
      if (reviewSpec?.card.status === "in_review") {
        return { ok: false, status: 409, error: "spec is in review — not approved to build yet" };
      }
    }
  }

  // "Build all phases" (build-all-phases-chain Phase 1): queue the spec's FIRST ⏳ phase, tagged
  // chain_phases so the post-merge step (reconcileMergedJobs → queueNextChainedPhase) auto-queues the next
  // ⏳ phase once this one merges (composing with auto-ship-pipeline auto-merge), chaining to all-✅ with no
  // owner clicks between phases. Scope the build to that one phase (same instruction the per-phase Build and
  // the chain step use). A spec with no phase structure falls through to a normal whole-spec build.
  let chainPhases = false;
  if (opts.chainPhases === true) {
    // spec-status-db-driven Phase 1: pass workspaceId so spec.card.phases reflects DB-authoritative
    // per-phase status (the DB is the source of truth post-backfill — markdown lags by a deploy).
    const spec = await getSpec(slug, workspaceId);
    const phases = spec?.card.phases ?? [];
    const next = phases.find((p) => p.status === "planned");
    if (next) {
      chainPhases = true;
      instructions = phaseScopedInstructions(next.title);
    } else if (phases.length > 0) {
      // Every phase already shipped/cut — nothing left to chain.
      return { ok: false, status: 409, error: "All phases are already built — nothing to chain." };
    }
    // phases.length === 0 → no phase structure to chain; fall through to a normal whole-spec build.
  }

  // Build gate (spec-blockers): refuse to enqueue a build for a spec whose prerequisites haven't shipped.
  // This is the single enqueue chokepoint — BuildButton, the Slack `/build`, and the planner all route
  // here — so a blocked spec can't be queued by ANY path. Verify/fold (handled above) is exempt; it retires
  // an already-shipped spec, not a build. A blocker is uncleared until its blocking spec ships (or is
  // archived/folded), so this never permanently blocks. No job row is inserted when blocked.
  const blockers = await getSpecBlockers(slug);
  const uncleared = blockers.filter((b) => !b.cleared);
  if (uncleared.length) {
    const list = uncleared.map((b) => `${b.slug} (${phaseEmoji(b.status)})`).join(", ");
    return { ok: false, status: 409, error: `Blocked by: ${list}` };
  }

  // One active build per spec — but only for a plain Build tap (no new instructions).
  const { data: existing } = await admin
    .from("agent_jobs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .in("status", ACTIVE_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) {
    // A plain Build tap (no instructions) OR a "Build all" chain coalesces into the live build — re-building
    // the whole spec (or re-chaining) while it's already building is pointless, and the chain advances itself
    // once the active build merges. But a Report Issue / scoped fix carries NEW, distinct instructions that
    // must NEVER be silently dropped (the bug this fixes): enqueue a distinct follow-up `build` row the box
    // runs after the active build (it serializes per-spec). See docs/brain/specs/fix-report-issue-dropped.md.
    if (!instructions || chainPhases) return { ok: true, job: existing as AgentJob, alreadyActive: true };
    const { data: followUp, error: followErr } = await admin
      .from("agent_jobs")
      .insert({ workspace_id: workspaceId, spec_slug: slug, status: "queued", instructions, created_by: userId })
      .select("*")
      .single();
    if (followErr) return { ok: false, status: 500, error: followErr.message };
    return { ok: true, job: followUp as AgentJob, queuedBehindActive: true };
  }

  // goal-member-builds-gate-at-enqueue-not-at-claim Phase 1 — enqueue-time admission gate. Refuse
  // to insert a build row for a goal-bound spec while ANY sibling goal-mate build is already
  // active (queued/claimed/building/…). The owner-visible response mirrors the blocked-by 409 —
  // the button clears itself the moment the sibling completes and the reactive path re-enqueues.
  // Fail-open on a resolve error (returns {ok:true}) — the claim-time serializer is still a
  // backstop for any row that slipped past.
  const admission = await evaluateGoalMemberEnqueueAdmission(workspaceId, slug);
  if (!admission.ok) {
    return { ok: false, status: 409, error: `Serialized — ${admission.reason}` };
  }

  // Only reference chain_phases when actually chaining — a normal build omits it so the DB default
  // (false) applies and the insert doesn't break if it lands before the chain_phases migration.
  const row: Record<string, unknown> = { workspace_id: workspaceId, spec_slug: slug, status: "queued", instructions, created_by: userId };
  if (chainPhases) row.chain_phases = true;
  const { data: job, error } = await admin
    .from("agent_jobs")
    .insert(row)
    .select("*")
    .single();
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, job: job as AgentJob, chainPhases: chainPhases || undefined };
}

// ── Create PR for a build whose branch pushed but `gh pr create` failed (build-recover-pr-create) ──

/** The exact `error` string the worker stamps when a build succeeds + pushes its branch but the final
 * `gh pr create` step fails (builder-worker.ts). Recovering this re-opens the PR for the pushed branch
 * instead of discarding the completed build via Rebuild. Kept in sync with BuildButton's client gate. */
export const PR_CREATE_FAILED_ERROR = "branch pushed but PR creation failed";

/**
 * Cheap status/error/branch gate the card uses to offer **Create PR** instead of Rebuild. Branch
 * existence on origin is the real, evidence-gated check — re-verified server-side in `createPrForJob`.
 */
export function isPrCreateRecoverable(job: Pick<AgentJob, "status" | "error" | "spec_branch" | "kind">): boolean {
  // build-kind only — a fold/plan PR-create failure carries extra state (pending_folds) this path
  // wouldn't reconcile, and the spec scopes recovery to already-pushed `claude/*` BUILD branches.
  return (
    job.kind === "build" &&
    job.status === "needs_attention" &&
    job.error === PR_CREATE_FAILED_ERROR &&
    !!job.spec_branch?.startsWith("claude/")
  );
}

/**
 * Recover a build that succeeded and pushed its `claude/*` branch but whose `gh pr create` failed: open a
 * PR for that already-pushed branch against `main`, then flip the job → `completed` with the new PR. Never
 * pushes code, never touches `main` — it only opens a PR for work already on origin. Idempotent: if a PR
 * already exists for the branch it adopts it (attaches its url/number) instead of erroring on a duplicate.
 *
 * Evidence-gated: refuses unless the job is the recoverable PR-create-failed sub-case AND the branch still
 * exists on origin — a genuinely-stuck `needs_attention` (no pushed branch, dirty-resolver human-merge) keeps
 * its human-attention treatment, never a misleading Create PR.
 */
export async function createPrForJob(
  workspaceId: string,
  userId: string,
  opts: { jobId: string },
): Promise<ActionResult<{ job: AgentJob; adopted: boolean }>> {
  const gate = await assertOwner(workspaceId, userId);
  if (!gate.ok) return gate;
  if (typeof opts.jobId !== "string" || !opts.jobId) return { ok: false, status: 400, error: "bad jobId" };
  if (!ghToken()) return { ok: false, status: 400, error: "GitHub not configured" };

  const admin = createAdminClient();
  const { data: jobRow } = await admin
    .from("agent_jobs")
    .select("*")
    .eq("id", opts.jobId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const job = jobRow as AgentJob | null;
  if (!job) return { ok: false, status: 404, error: "job not found" };
  if (!isPrCreateRecoverable(job)) return { ok: false, status: 409, error: "job is not a recoverable PR-create failure" };
  const branch = job.spec_branch as string;

  // Guardrail: only ever a claude/* build branch that EXISTS on origin — never push, never touch main.
  if (!branch.startsWith("claude/")) return { ok: false, status: 403, error: "Only claude/* build branches can be recovered" };
  const ref = await gh("GET", `/repos/${REPO}/git/ref/heads/${branch}`);
  if (!ref.ok) {
    return { ok: false, status: 409, error: `Branch ${branch} not found on origin (${ref.status}) — nothing pushed to open a PR for` };
  }

  const owner = REPO.split("/")[0];
  const findOpen = async (): Promise<{ url: string; number: number } | null> => {
    const res = await gh("GET", `/repos/${REPO}/pulls?head=${owner}:${branch}&state=open`);
    if (res.ok && Array.isArray(res.json) && (res.json as unknown[]).length) {
      const pr = (res.json as unknown as Array<{ html_url: string; number: number }>)[0];
      return { url: pr.html_url, number: pr.number };
    }
    return null;
  };

  // Idempotent adopt-existing, else create.
  let adopted = false;
  let pr = await findOpen();
  if (pr) {
    adopted = true;
  } else {
    const created = await gh("POST", `/repos/${REPO}/pulls`, {
      title: job.spec_slug,
      head: branch,
      base: "main",
      body: `Recovered PR for an already-pushed build branch — the build succeeded but the original \`gh pr create\` failed (transient). Opened via the Create PR card action. See docs/brain/specs/build-recover-pr-create.md.`,
      draft: false,
    });
    if (created.ok) {
      pr = { url: created.json.html_url as string, number: created.json.number as number };
    } else {
      // A create can fail on a duplicate-PR race — re-check for an open PR before surfacing an error.
      pr = await findOpen();
      if (pr) adopted = true;
      else return { ok: false, status: 502, error: `PR create failed (${created.status}: ${(created.json.message as string) || ""})` };
    }
  }

  const { data: updated, error } = await admin
    .from("agent_jobs")
    .update({ status: "completed", pr_url: pr.url, pr_number: pr.number, error: null, updated_at: new Date().toISOString() })
    .eq("id", job.id)
    .select("*")
    .single();
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, job: updated as AgentJob, adopted };
}

// ── Answer open questions (mirrors POST /api/roadmap/answer) ──

export async function answerRoadmapBuild(
  workspaceId: string,
  userId: string,
  opts: { jobId: string; answers: { id: string; q?: string; answer: string }[] },
): Promise<ActionResult<{ job: AgentJob }>> {
  const gate = await assertOwner(workspaceId, userId);
  if (!gate.ok) return gate;
  if (typeof opts.jobId !== "string" || !Array.isArray(opts.answers)) {
    return { ok: false, status: 400, error: "bad payload" };
  }

  const admin = createAdminClient();
  const { data: job } = await admin
    .from("agent_jobs")
    .select("*")
    .eq("id", opts.jobId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!job) return { ok: false, status: 404, error: "job not found" };
  if ((job as AgentJob).status !== "needs_input") {
    return { ok: false, status: 409, error: "job is not awaiting input" };
  }

  const { data: updated, error } = await admin
    .from("agent_jobs")
    .update({ answers: opts.answers, status: "queued_resume", updated_at: new Date().toISOString() })
    .eq("id", opts.jobId)
    .select("*")
    .single();
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, job: updated as AgentJob };
}

// ── Approve / decline a gated prod action (mirrors POST /api/roadmap/approve) ──

export async function approveRoadmapAction(
  workspaceId: string,
  userId: string,
  opts: {
    jobId: string;
    actionId: string;
    decision: "approve" | "decline" | "reject";
    notes?: string;
    /**
     * ada-slack-routed-approvals Phase 4 — `slack-inbox` (the in-Slack inbox card tap) skips the
     * web→Slack mirror, since its handler updates the card locally without the "(in web inbox)"
     * suffix. Any other caller (web inbox, slack-roadmap-console) defaults to `web` and triggers
     * the mirror so the routed Slack card / chat-mode thread stays in sync.
     */
    source?: "web" | "slack-inbox";
  },
): Promise<ActionResult<{ job: AgentJob }>> {
  const gate = await assertOwner(workspaceId, userId);
  if (!gate.ok) return gate;
  const DECISIONS = ["approve", "decline", "reject"] as const;
  if (typeof opts.jobId !== "string" || typeof opts.actionId !== "string" || !DECISIONS.includes(opts.decision)) {
    return { ok: false, status: 400, error: "bad payload" };
  }

  const admin = createAdminClient();
  const { data: jobRow } = await admin
    .from("agent_jobs")
    .select("*")
    .eq("id", opts.jobId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const job = jobRow as AgentJob | null;
  if (!job) return { ok: false, status: 404, error: "job not found" };
  if (job.status !== "needs_approval") return { ok: false, status: 409, error: "job is not awaiting approval" };

  // 'reject' is the optimizer-hero-preview-gate's reject-with-notes: it doesn't decline the campaign — it
  // sends free-text notes back so the worker regenerates a fresh hero candidate and re-surfaces it for
  // preview. Marked `reject_regen` (no longer pending) so the job resumes; the notes ride on the action.
  const target = (job.pending_actions || []).find((a) => a.id === opts.actionId);
  if (!target) return { ok: false, status: 404, error: "action not found" };
  if (opts.decision === "reject") {
    const notes = typeof opts.notes === "string" ? opts.notes.trim() : "";
    if (!notes) return { ok: false, status: 400, error: "reject requires notes" };
    if (target.type !== "storefront_campaign" || target.stage !== "preview") {
      return { ok: false, status: 409, error: "this action has no image preview to reject" };
    }
  }

  const newStatus: PendingAction["status"] =
    opts.decision === "approve" ? "approved" : opts.decision === "reject" ? "reject_regen" : "declined";
  const actions: PendingAction[] = (job.pending_actions || []).map((a) =>
    a.id === opts.actionId
      ? { ...a, status: newStatus, ...(opts.decision === "reject" ? { reject_notes: opts.notes!.trim() } : {}) }
      : a,
  );

  // Resume only once every action has a decision; otherwise keep waiting on the rest.
  const stillPending = actions.some((a) => a.status === "pending");
  const patch: Record<string, unknown> = { pending_actions: actions, updated_at: new Date().toISOString() };
  if (!stillPending) patch.status = "queued_resume";

  const { data: updated, error } = await admin.from("agent_jobs").update(patch).eq("id", opts.jobId).select("*").single();
  if (error) return { ok: false, status: 500, error: error.message };

  // Supervisable-autonomy ledger (approval-routing-engine Phase 3): record every TERMINAL routed
  // decision so the CEO can always audit what was decided + why. A 'reject' is reject-with-notes —
  // it sends a hero candidate back for regeneration, NOT a terminal approve/decline, so it isn't
  // logged here (the request re-surfaces). Best-effort: never break the approve path on a ledger miss.
  if (opts.decision === "approve" || opts.decision === "decline") {
    try {
      // box-agent-model-tiers P3: a proposed-model-tier job routes by its TARGET agent kind, not the
      // proposal kind, so the ledger's raised/routed functions match the inbox routing it was decided in.
      // plan-approval-routes-by-goal-owner: a plan job routes by its GOAL's owner (DB read), not the planner's
      // platform default — routingOwnerForJobAsync keeps the ledger's raised/routed in lockstep with the inbox.
      const ownerFn = await routingOwnerForJobAsync(admin, job);
      const raisedBy = ownerFn ?? CEO;
      const routedTo = await resolveApproverLive(ownerFn);
      await recordApprovalDecision(admin, {
        workspaceId,
        agentJobId: job.id,
        pendingActionId: opts.actionId,
        raisedByFunction: raisedBy,
        routedToFunction: routedTo,
        // A human owner is deciding here: 'ceo' when it routed to the fail-safe root, else a human
        // override of a director's queue. The autonomous director path (decided_by='director',
        // autonomous=true) is recorded by that future auto-approver, not this human endpoint.
        decidedBy: routedTo === CEO ? "ceo" : "human",
        decision: opts.decision === "approve" ? "approved" : "declined",
        reasoning: typeof opts.notes === "string" && opts.notes.trim() ? opts.notes.trim() : null,
        autonomous: false,
      });
    } catch {
      // ledger is best-effort; the decision already landed on the job.
    }
  }

  // ada-slack-routed-approvals Phase 4: mirror a non-Slack-inbox decision back to the routed Slack
  // card (or chat-mode thread) in #cto-ada so the two surfaces never show stale state. Best-effort
  // — `mirrorWebDecisionToAdaSlack` swallows its own errors so a Slack outage never blocks a
  // decision that already landed on the job. Skipped on `slack-inbox` source (that handler updates
  // the card locally, without the "(in web inbox)" suffix) and on `reject` (regen, not terminal).
  if ((opts.decision === "approve" || opts.decision === "decline") && opts.source !== "slack-inbox") {
    await mirrorWebDecisionToAdaSlack(admin, workspaceId, opts.jobId, opts.actionId, opts.decision);
  }

  return { ok: true, job: updated as AgentJob };
}

// ── Squash-merge a claude/* PR (mirrors POST /api/branches/[number]/merge) ──

export async function mergeClaudePr(
  workspaceId: string,
  userId: string,
  prNumber: number,
): Promise<ActionResult<{ merged: true; sha: unknown }>> {
  const gate = await assertOwner(workspaceId, userId);
  if (!gate.ok) return gate;
  if (!Number.isInteger(prNumber) || prNumber <= 0) return { ok: false, status: 400, error: "bad PR number" };
  if (!ghToken()) return { ok: false, status: 400, error: "GitHub not configured" };

  // Re-validate safety server-side — never trust the client's view.
  const pr = await gh("GET", `/repos/${REPO}/pulls/${prNumber}`);
  if (!pr.ok) return { ok: false, status: 502, error: `PR fetch failed (${pr.status})` };
  const head = (pr.json.head as { ref?: string } | undefined)?.ref;
  if (pr.json.state !== "open") return { ok: false, status: 409, error: "PR is not open" };
  if (!head?.startsWith("claude/")) return { ok: false, status: 403, error: "Only claude/* PRs can be merged here" };
  const state = pr.json.mergeable_state as string | undefined;
  if (pr.json.mergeable !== true || (state !== "clean" && state !== "behind")) {
    return { ok: false, status: 409, error: `Not safe to merge (mergeable_state: ${state || "unknown"})` };
  }

  const merge = await gh("PUT", `/repos/${REPO}/pulls/${prNumber}/merge`, {
    merge_method: "squash",
    commit_title: `${pr.json.title as string} (#${prNumber})`,
  });
  if (!merge.ok) return { ok: false, status: 502, error: `Merge failed: ${(merge.json.message as string) || merge.status}` };

  // Best-effort: stamp the originating todo as merged + delete the branch.
  const admin = createAdminClient();
  const prUrl = pr.json.html_url as string | undefined;
  if (prUrl) {
    const { data: todos } = await admin
      .from("agent_todos")
      .select("id, execution_result")
      .eq("workspace_id", workspaceId)
      .eq("status", "executed");
    const match = (todos || []).find((t) => (t.execution_result as { pr_url?: string } | null)?.pr_url === prUrl);
    if (match) {
      await admin
        .from("agent_todos")
        .update({
          execution_result: { ...((match.execution_result as object) || {}), merged_at: new Date().toISOString() },
          updated_at: new Date().toISOString(),
        })
        .eq("id", match.id);
    }
  }
  if (head) await gh("DELETE", `/repos/${REPO}/git/refs/heads/${head}`).catch(() => {});

  // A merged fold just wrote a new archive.d/{slug}.md but (by design) NOT archive.md/README — kick the
  // single-writer regen so the human-readable aggregates catch up within minutes instead of up-to-a-day.
  // See docs/brain/inngest/brain-index-refresh.md (Phase 3).
  if (head?.startsWith("claude/fold-")) {
    await inngest.send({ name: "brain/index.refresh", data: { reason: "fold-merge", prNumber } }).catch(() => {});
  }

  return { ok: true, merged: true, sha: merge.json.sha };
}
