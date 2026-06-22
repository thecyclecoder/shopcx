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
import { ACTIVE_STATUSES, type AgentJob, type PendingAction } from "@/lib/agent-jobs";
import { getSpecBlockers, phaseEmoji } from "@/lib/brain-roadmap";

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
  opts: { slug: string; instructions?: string | null; verify?: boolean },
): Promise<ActionResult<{ job: AgentJob; alreadyActive?: boolean; queuedBehindActive?: boolean; fold?: boolean }>> {
  const gate = await assertOwner(workspaceId, userId);
  if (!gate.ok) return gate;

  const slug = opts.slug;
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/i.test(slug)) {
    return { ok: false, status: 400, error: "bad slug" };
  }

  const admin = createAdminClient();

  // "Mark verified & archive" → coalesce into ONE batch fold-build (enqueue_fold). Mirrors the route.
  if (opts.verify === true) {
    const { data: foldData, error: foldErr } = await admin.rpc("enqueue_fold", {
      p_workspace: workspaceId,
      p_slug: slug,
      p_user: userId,
    });
    if (foldErr) return { ok: false, status: 500, error: foldErr.message };
    const job = (Array.isArray(foldData) ? foldData[0] : foldData) as AgentJob;
    return { ok: true, job, fold: true };
  }

  const instructions = typeof opts.instructions === "string" && opts.instructions.trim() ? opts.instructions : null;

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
    // A plain Build tap (no instructions) coalesces into the live build — re-building the whole spec
    // while it's already building is pointless. But a Report Issue / scoped fix carries NEW, distinct
    // instructions that must NEVER be silently dropped (the bug this fixes): enqueue a distinct follow-up
    // `build` row that the box runs after the active build (it serializes per-spec). See
    // docs/brain/specs/fix-report-issue-dropped.md.
    if (!instructions) return { ok: true, job: existing as AgentJob, alreadyActive: true };
    const { data: followUp, error: followErr } = await admin
      .from("agent_jobs")
      .insert({ workspace_id: workspaceId, spec_slug: slug, status: "queued", instructions, created_by: userId })
      .select("*")
      .single();
    if (followErr) return { ok: false, status: 500, error: followErr.message };
    return { ok: true, job: followUp as AgentJob, queuedBehindActive: true };
  }

  const { data: job, error } = await admin
    .from("agent_jobs")
    .insert({ workspace_id: workspaceId, spec_slug: slug, status: "queued", instructions, created_by: userId })
    .select("*")
    .single();
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, job: job as AgentJob };
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
  opts: { jobId: string; actionId: string; decision: "approve" | "decline" },
): Promise<ActionResult<{ job: AgentJob }>> {
  const gate = await assertOwner(workspaceId, userId);
  if (!gate.ok) return gate;
  if (typeof opts.jobId !== "string" || typeof opts.actionId !== "string" || (opts.decision !== "approve" && opts.decision !== "decline")) {
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

  const actions: PendingAction[] = (job.pending_actions || []).map((a) =>
    a.id === opts.actionId ? { ...a, status: opts.decision === "approve" ? "approved" : "declined" } : a,
  );
  if (!actions.some((a) => a.id === opts.actionId)) return { ok: false, status: 404, error: "action not found" };

  // Resume only once every action has a decision; otherwise keep waiting on the rest.
  const stillPending = actions.some((a) => a.status === "pending");
  const patch: Record<string, unknown> = { pending_actions: actions, updated_at: new Date().toISOString() };
  if (!stillPending) patch.status = "queued_resume";

  const { data: updated, error } = await admin.from("agent_jobs").update(patch).eq("id", opts.jobId).select("*").single();
  if (error) return { ok: false, status: 500, error: error.message };
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
