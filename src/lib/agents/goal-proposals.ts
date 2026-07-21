/**
 * Director-proposed goals (director-proposed-goals spec, Phase 1) — a director can AUTHOR + SURFACE a goal,
 * but it does NOT activate one. The CEO's greenlight stays the activation gate (north star: the CEO owns
 * objectives, directors own progress within approved ones — operational-rules § North star).
 *
 * The lifecycle this module owns (post goal-greenlight-button-and-author-writes-db Phase 2 — the DB row is
 * authoritative; the markdown commit is a transitional mirror retired in goal-readers-from-db-retire-parsegoal):
 *   1. A director proposes a goal for ITS OWN function → `proposeGoal` writes a `public.goals` row
 *      (`status='proposed'`, `proposer_function`, `owner`, `body`, optional `parent_goal_id`) + any milestones
 *      parsed from the body's `## Decomposition` block as `public.goal_milestones` rows via `upsertGoal`,
 *      then enqueues a `proposed-goal` agent_jobs row (no GitHub commit from this code path — the box worker
 *      owns the transitional mirror commit, exactly like db_health/coverage-register).
 *   2. The box worker's `runProposedGoalJob` commits the mirror artifact `docs/brain/goals/{slug}.md` with
 *      `**Status:** proposed` (an inert artifact — the escort skips it, Pia doesn't decompose it) for the
 *      git-history record, and parks the job `needs_approval` with ONE `greenlight_goal` action. It writes
 *      a `proposed_goal` director_activity row. The roadmap readers themselves no longer read this
 *      markdown — they read `public.goals` directly (goal-readers-from-db-retire-parsegoal).
 *   3. The approval-routing-engine reconciler surfaces it as an Approval Request. Goals NEVER route to a
 *      director — `proposed-goal` is deliberately NOT a first-class Node in the canonical registry
 *      ([[../control-tower/node-registry]]) and is NOT in approval-inbox's KIND_TO_FUNCTION_SHIM, so
 *      `resolveApprover` falls through to the CEO even when the proposing director is live + autonomous.
 *   4. On CEO greenlight the worker flips the row via `setGoalStatus(goalId, 'greenlit')` (the RESUME
 *      path); on decline it flips the row to `folded` (the active board filters folded rows). The DB row is
 *      authoritative for every reader. A director never greenlights any goal — its own or another's.
 *
 * This module is the PURE side (markdown render + the self-function scope check + the decomposition-block
 * milestone extractor) plus the enqueuer; the GitHub mirror commit lives in `scripts/builder-worker.ts`
 * `runProposedGoalJob`.
 *
 * See docs/brain/specs/director-proposed-goals.md · docs/brain/specs/goal-greenlight-button-and-author-writes-db.md
 * · docs/brain/libraries/goal-proposals.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { upsertGoal, getGoal, type GoalMilestoneInput } from "@/lib/goals-table";

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
  /** goal-greenlight-button-and-author-writes-db Phase 2 — when the proposer is the plan-goal planner
   *  authoring a SUBGOAL (a milestone too big for one spec), the parent goal's `public.goals.id` goes here.
   *  Most proposals (a director-coach goal, a top-level director-proposed goal) leave this undefined. The
   *  acyclicity rail (`goals_parent_cycle` trigger) rejects a self-ancestor. */
  parentGoalId?: string;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHY this goal exists. HARD gated at the
   *  chokepoint (`proposeGoal` rejects a proposal with empty `why`). Reconcile: `outcome` IS the goal's
   *  WHAT — we do not carry a separate `what` field. */
  why: string;
}

/** A goal slug is lowercase-kebab (mirrors the spec/goal slug guard in brain-roadmap). */
export function isValidGoalSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

/**
 * pia-decomposition-emits-plain-slug-blocked-by Phase 1 — normalize ONE Pia-emitted `blocked_by` entry to
 * a plain member spec slug (`kebab-case`, matches `isValidGoalSlug`) or return `null` when the entry is
 * junk / unresolvable. The build-gating (`areSpecsGoalMates` + the Kahn sort in [[libraries/agent-jobs]])
 * looks blockers up in `public.specs` by their exact slug and does NOT split on `:`, so a namespaced
 * `goalSlug:specSlug` entry resolves to no spec ⇒ the gate silently treats it as an external blocker and
 * lets the dependent build out of order (the 2026-07-07 Sol-goal build shipped its M2 spec before its
 * declared M1 blocker for exactly this reason). Applied at the plan-goal write path in
 * `parsePlannerSpecs` (scripts/builder-worker.ts) so the DB row stores plain slugs the gate can resolve.
 *
 * Accepts:
 *   - a plain slug: `sol-ticket-direction-artifact` → unchanged
 *   - a namespaced slug: `sol-agent-boot-goal:sol-ticket-direction-artifact` → last colon-segment
 *   - a wikilink: `[[sol-ticket-direction-artifact]]` → inside the brackets
 *   - a wikilink with a `../specs/` path prefix: `[[../specs/foo]]` → `foo`
 *   - a wikilink with a `#phase-anchor` suffix: `[[../specs/foo#phase-2]]` → `foo`
 * Rejects anything that after normalization isn't a lowercase-kebab slug (returns `null`).
 */
export function normalizePlannerBlockedBySlug(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  const bracketMatch = s.match(/^\[\[(.+?)\]\]$/);
  if (bracketMatch) s = bracketMatch[1].trim();
  s = s.replace(/^(?:\.\.\/)+specs\//, "");
  s = s.replace(/#.*$/, "");
  if (s.includes(":")) {
    const parts = s.split(":").map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return null;
    s = parts[parts.length - 1];
  }
  s = s.trim();
  if (!s || !isValidGoalSlug(s)) return null;
  return s;
}

/**
 * pia-decomposition-emits-plain-slug-blocked-by Phase 1 — normalize a whole planner `blocked_by` LIST.
 * Filters non-strings, runs each survivor through `normalizePlannerBlockedBySlug`, drops the spec's own
 * slug (self-block), and dedupes while preserving first-seen order. A non-array input yields `[]` (the
 * planner sometimes omits the field entirely — treat as "no declared prerequisites").
 */
export function normalizePlannerBlockedByList(raw: unknown, selfSlug: string): string[] {
  if (!Array.isArray(raw)) return [];
  const self = (selfSlug || "").trim().toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const norm = normalizePlannerBlockedBySlug(entry);
    if (!norm || norm === self || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
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
    // pm-structured-intent-and-refs Phase 1 — surface the plain-language WHY at the top of the mirror
    // artifact. `outcome` remains the WHAT (reconcile-don't-duplicate); together they read as the
    // human-first intent header.
    input.why ? `**Why:** ${input.why}` : "",
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
 * Pull the top-level `- ` bullets out of the artifact's `## Decomposition` block as `goal_milestones`
 * rows. Each bullet becomes one milestone: position is the bullet order (1-indexed); title is the bullet's
 * first non-empty text, lightly cleaned (strip the leading `**M1 — ` / `**` markers + a trailing period);
 * body is the rest of the bullet's lines joined (or null when there's only a title). Lines that aren't
 * inside `## Decomposition`, or that fall before the first bullet, are ignored. Returns `[]` for the
 * default placeholder body (`_Awaiting CEO greenlight — Pia decomposes…_`) — Pia owns decomposition then.
 *
 * Pure — no DB / fs access. A tiny standalone slicer kept on the proposer code path so it avoids a
 * cross-import into the heavier brain-roadmap module.
 */
export function extractDecompositionMilestones(artifact: string): GoalMilestoneInput[] {
  const lines = artifact.split("\n");
  const decomp: string[] = [];
  let inside = false;
  for (const l of lines) {
    if (/^##\s+Decomposition\b/i.test(l)) { inside = true; continue; }
    if (inside && /^##\s/.test(l)) break;
    if (inside) decomp.push(l);
  }
  const blocks: string[][] = [];
  let cur: string[] | null = null;
  for (const l of decomp) {
    if (/^[-*]\s/.test(l)) {
      if (cur) blocks.push(cur);
      cur = [l];
    } else if (cur) {
      cur.push(l);
    }
  }
  if (cur) blocks.push(cur);
  const milestones: GoalMilestoneInput[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const first = block[0].replace(/^[-*]\s+/, "").trim();
    if (!first) continue;
    // Skip the default placeholder paragraph that buildProposedGoalMarkdown emits when no body is supplied.
    if (/^_?Awaiting CEO greenlight/i.test(first)) continue;
    // Strip bold + a leading `M\d+ —` label so the title is the human-readable phrase. Keep the M-id when
    // the writer used `**M1 — Title.**` so the milestone's title carries it (the rollup doesn't depend on
    // the id; it's a display affordance).
    let title = first;
    const boldM = title.match(/^\*\*\s*(.+?)\.?\s*\*\*/);
    if (boldM) title = boldM[1].trim();
    title = title.replace(/\.+$/, "").trim();
    if (!title) continue;
    const rest = block.slice(1).map((l) => l.trim()).filter(Boolean).join("\n").trim();
    milestones.push({ position: i + 1, title, body: rest || null });
  }
  return milestones;
}

/**
 * Enqueue a director-proposed goal. Validates the self-function scope rail + the slug, then:
 *
 *  1. **Writes the goal row** ([[goal-greenlight-button-and-author-writes-db]] Phase 2). Calls `upsertGoal`
 *     with `status='proposed'`, `proposer_function`, `owner`, `body=` the rendered artifact, and N
 *     `public.goal_milestones` rows extracted from the artifact's `## Decomposition` block (zero when the
 *     proposer left decomposition to Pia). When `parentGoalId` is set (the planner SUBGOAL case), it goes
 *     onto the row; the `goals_parent_cycle` trigger guards acyclicity.
 *
 *  2. Inserts a `proposed-goal` agent_jobs row (status `queued`) carrying the goal slug. The box worker
 *     parks it `needs_approval` (→ routes to the CEO). No GitHub commit from this code path or the worker —
 *     the goal lives in `public.goals` (the per-goal markdown was retired in
 *     [[goal-readers-from-db-retire-parsegoal]]).
 *
 * The row write is AUTHORITATIVE: the row IS the goal (readers + the greenlight flip are DB-only). A write
 * failure ABORTS the proposal (returns `{ok:false}`) — we never enqueue a greenlight job for a goal that
 * has no row to flip.
 *
 * Returns the new agent_jobs `jobId` on success.
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
  // pm-structured-intent-and-refs Phase 1 — the plain-language WHY is required (`outcome` remains the
  // WHAT — reconcile-don't-duplicate). A goal without a why is unreadable to humans + gives the CEO's
  // greenlight surface no motivation string.
  if (!input.why || !input.why.trim()) {
    return { ok: false, error: "a plain-language WHY is required (pm-structured-intent-and-refs Phase 1) — describe why this goal exists so humans + agents share the intent." };
  }

  const artifact = buildProposedGoalMarkdown(input);

  // Step 1 — write the public.goals row + any seeded milestones (AUTHORITATIVE: the row IS the goal; the
  // readers + the greenlight flip are DB-only). A write failure ABORTS the proposal — we never enqueue a
  // greenlight job for a goal that has no row to flip (the RESUME path requires the row).
  // Clobber guard: refuse to silently overwrite an existing goal of the same slug. A row that's already
  // greenlit/complete must not be reset to `proposed` by a stray re-proposal — the lifecycle is
  // propose → greenlight, not propose → reset.
  try {
    const existing = await getGoal(workspaceId, input.slug);
    if (existing && existing.status && existing.status !== "proposed") {
      return { ok: false, error: `goal ${input.slug} already exists (status ${existing.status}) — refusing to re-propose` };
    }
    await upsertGoal(
      workspaceId,
      {
        slug: input.slug,
        title: input.title,
        body: artifact,
        outcome: input.outcome,
        success_metric: input.successMetric ?? null,
        owner: input.ownerFunction,
        proposer_function: input.proposerFunction,
        parent_goal_id: input.parentGoalId ?? null,
        status: "proposed",
        // pm-structured-intent-and-refs Phase 1 — persist the plain-language WHY column on the goal row
        // (chokepoint-gated non-empty above). `outcome` continues to carry the WHAT.
        why: input.why.trim(),
      },
      extractDecompositionMilestones(artifact),
    );
  } catch (e) {
    const why = errText(e);
    console.error(`[goal-proposals] proposeGoal row write failed for ${input.slug}:`, why);
    return { ok: false, error: `could not write goal row for ${input.slug}: ${why}` };
  }

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
