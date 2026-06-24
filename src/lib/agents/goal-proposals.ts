/**
 * Director-proposed goals (director-proposed-goals spec, Phase 1) — a director can AUTHOR + SURFACE a goal,
 * but it does NOT activate one. The CEO's greenlight stays the activation gate (north star: the CEO owns
 * objectives, directors own progress within approved ones — operational-rules § North star).
 *
 * The lifecycle this module owns:
 *   1. A director proposes a goal for ITS OWN function → `proposeGoal` enqueues a `proposed-goal` agent_jobs
 *      row (no GitHub commit here — the box worker owns all commits, exactly like db_health/coverage-register).
 *   2. The box worker's `runProposedGoalJob` commits `docs/brain/goals/{slug}.md` with `**Status:** proposed`
 *      (an inert artifact — the escort skips it, Pia doesn't decompose it) and parks the job `needs_approval`
 *      with ONE `greenlight_goal` action. It writes a `proposed_goal` director_activity row.
 *   3. The approval-routing-engine reconciler surfaces it as an Approval Request. Goals NEVER route to a
 *      director — `proposed-goal` is deliberately absent from approval-inbox's KIND_TO_FUNCTION, so
 *      `resolveApprover` falls through to the CEO even when the proposing director is live + autonomous.
 *   4. On CEO greenlight the worker flips `**Status:** greenlit`; on decline it deletes the inert artifact
 *      (git history is the archive). A director never greenlights any goal — its own or another's.
 *
 * This module is the PURE side (markdown render + status flip + the self-function scope check) plus the
 * enqueuer; the GitHub commit/flip/delete lives in scripts/builder-worker.ts `runProposedGoalJob`.
 *
 * See docs/brain/specs/director-proposed-goals.md · docs/brain/libraries/goal-proposals.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The agent_jobs.kind for a director-proposed goal awaiting CEO greenlight. */
export const GOAL_PROPOSAL_KIND = "proposed-goal";

/** The single pending-action type a `proposed-goal` job carries — the CEO's plain greenlight/decline. */
export const GREENLIGHT_GOAL_ACTION_TYPE = "greenlight_goal";

/** The instructions JSON the enqueuer writes onto a `proposed-goal` job (read by the worker runner). */
export interface GoalProposalInstructions {
  slug: string;
  /** the function the goal belongs to (the DRI) — MUST equal `proposerFunction` (a director proposes only for itself). */
  ownerFunction: string;
  /** the function that authored the proposal (the proposing director). */
  proposerFunction: string;
  title: string;
  /** the full `docs/brain/goals/{slug}.md` markdown to commit (carries `**Status:** proposed`). */
  artifact: string;
  /** a one-line outcome for the Approval Request preview. */
  outcome?: string;
}

/** Fields a director hands in to propose a goal (the Phase 3 seat fills these; Phase 1 exposes the API). */
export interface ProposeGoalInput {
  proposerFunction: string;
  ownerFunction: string;
  slug: string;
  title: string;
  outcome: string;
  successMetric?: string;
  target?: string;
  /** extra markdown body appended after the metadata block (prose / a Decomposition draft). */
  body?: string;
}

/** A goal slug is lowercase-kebab (mirrors the spec/goal slug guard in brain-roadmap). */
export function isValidGoalSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

/**
 * The self-function scope rail: a director proposes ONLY for its own function. Returns an error string when
 * the proposer and owner disagree (or either is missing/blank), else null. Enforced before any commit so a
 * director can never author a goal for another function.
 */
export function assertProposerOwnsFunction(proposerFunction: string, ownerFunction: string): string | null {
  const p = (proposerFunction || "").trim();
  const o = (ownerFunction || "").trim();
  if (!p || !o) return "both a proposer and an owner function are required";
  if (p !== o) return `a director may propose a goal only for its OWN function — ${p} cannot author a goal owned by ${o}`;
  return null;
}

/** Render the full proposed-goal markdown — a board-parseable goal doc carrying `**Status:** proposed`. */
export function buildProposedGoalMarkdown(input: ProposeGoalInput): string {
  const fn = input.ownerFunction;
  const meta = [
    `**Status:** proposed`,
    `**Proposed-by:** [[../functions/${fn}]]`,
    `**Owner:** [[../functions/${fn}]]`,
    `**Outcome:** ${input.outcome}`,
    input.successMetric ? `**Success metric:** ${input.successMetric}` : "",
    input.target ? `**Target:** ${input.target}` : "",
  ].filter(Boolean);
  const sections = [
    `# ${input.title}`,
    "",
    meta.join("\n"),
    "",
    input.body?.trim() ? input.body.trim() : "## Decomposition\n\n_Awaiting CEO greenlight — Pia decomposes this into a milestone → spec tree once it's greenlit._",
    "",
    "## Ownership & mirrors",
    "",
    `Owner: [[../functions/${fn}]]. Proposed by [[../functions/${fn}]]; reports to [[ceo-mode]]. Proposed (director-authored) — inert until the CEO greenlights it.`,
    "",
  ];
  return sections.join("\n");
}

/**
 * Flip the `**Status:**` line of an existing goal markdown to `status` (e.g. proposed → greenlit on the CEO's
 * greenlight). Replaces the first `**Status:**` line in place; if the doc has none (a legacy CEO goal), inserts
 * one right under the H1. Pure — returns the new markdown.
 */
export function setGoalStatusLine(raw: string, status: GoalStatusLiteral): string {
  const lines = raw.split("\n");
  const idx = lines.findIndex((l) => /^\s*\*\*Status:\*\*/i.test(l));
  if (idx >= 0) {
    lines[idx] = `**Status:** ${status}`;
    return lines.join("\n");
  }
  const h1 = lines.findIndex((l) => l.startsWith("# "));
  if (h1 >= 0) {
    lines.splice(h1 + 1, 0, "", `**Status:** ${status}`);
    return lines.join("\n");
  }
  return `**Status:** ${status}\n\n${raw}`;
}

/** The status values the flip helper accepts (the GoalStatus union, kept local to avoid a cross-import cycle). */
export type GoalStatusLiteral = "proposed" | "greenlit" | "complete";

/**
 * Enqueue a director-proposed goal. Validates the self-function scope rail + the slug, then inserts a
 * `proposed-goal` agent_jobs row (status `queued`) carrying the rendered artifact in `instructions`. The box
 * worker commits the artifact + parks it `needs_approval` (→ routes to the CEO). No GitHub commit happens
 * here — keeping all commits in the worker (the db_health/coverage-register pattern). Best-effort insert.
 */
export async function proposeGoal(
  admin: Admin,
  workspaceId: string,
  input: ProposeGoalInput,
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  const scopeError = assertProposerOwnsFunction(input.proposerFunction, input.ownerFunction);
  if (scopeError) return { ok: false, error: scopeError };
  if (!isValidGoalSlug(input.slug)) return { ok: false, error: `invalid goal slug "${input.slug}" — use lowercase-kebab-case` };
  if (!input.title.trim()) return { ok: false, error: "a goal title is required" };
  if (!input.outcome.trim()) return { ok: false, error: "a goal outcome is required" };

  const artifact = buildProposedGoalMarkdown(input);
  const instructions: GoalProposalInstructions = {
    slug: input.slug,
    ownerFunction: input.ownerFunction,
    proposerFunction: input.proposerFunction,
    title: input.title,
    artifact,
    outcome: input.outcome,
  };
  const { data, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: workspaceId,
      spec_slug: input.slug, // the goal slug (deep-links to /dashboard/roadmap/goals/{slug})
      kind: GOAL_PROPOSAL_KIND,
      status: "queued",
      created_by: null,
      instructions: JSON.stringify(instructions),
    })
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, jobId: (data as { id?: string } | null)?.id };
}
