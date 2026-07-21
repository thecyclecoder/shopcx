/**
 * Director-decision grader — the CEO's supervisory feedback signal (director-loop-grading spec,
 * Phase 3; M5 of the devops-director goal). One level UP the org chart from the shipped storefront
 * campaign grader (src/lib/storefront/campaign-grader.ts) and the acquisition gap grader
 * (src/lib/acquisition-gap-grader.ts): there a director grades a TOOL's output; here the CEO grades
 * the Platform/DevOps DIRECTOR's own CALLS — 1–10 + reasoning — and those grades train it and
 * tighten/loosen the leash (Phase 4).
 *
 * Two DIMENSIONS, each one gradeable "call":
 *   • auto-approval — one approval_decisions row the director auto-approved (decided_by='director',
 *                     autonomous=true). Was the cause+fix SOUND and within the leash — and did it
 *                     HOLD UP (the target build concluded clean, no rollback / repeat-failure after)?
 *   • goal-escort   — one (goal_slug, milestone) the director escorted to landing. Did the milestone
 *                     LAND CLEAN — every spec shipped, no regression escalated against it?
 *
 * The defining invariant (inherited from the campaign grader): SOUNDNESS is scored SEPARATELY from
 * OUTCOME. A sound auto-approval that later needed a rare, reversible tweak still grades well if the
 * reasoning was right; a careless approval that happened to be fine grades low. The grader must not
 * reward outcome luck (docs/brain/specs/director-loop-grading.md § Safety).
 *
 * The grader is a SUPERVISED TOOL (operational-rules § North star): it scores a bounded proxy
 * (decision quality); the CEO owns the objective and overrides it. Every grade is human-overridable
 * and the override is recorded (graded_by='human'/overridden_by), never silently lost. Only APPROVED
 * director_grader_prompts rules (the CEO-calibrated rubric corrections) reach the grader's prompt.
 *
 * Idempotent per call per dimension (the partial uniques on director_decision_grades): a re-run
 * UPDATEs the row in place, never duplicates, and never clobbers a human override. Fired on the M1
 * standing cadence (platform-director-cron) over recently-CONCLUDED calls.
 *
 * See docs/brain/tables/director_decision_grades.md · docs/brain/libraries/director-grader.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { logAiUsage, usageCostCents } from "@/lib/ai-usage";
import { SONNET_MODEL } from "@/lib/ai-models";
import { PLATFORM } from "@/lib/agents/platform-director";
import { GROWTH } from "@/lib/agents/growth-director";
import { getGoals } from "@/lib/brain-roadmap";

type Admin = ReturnType<typeof createAdminClient>;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GRADER_MODEL = SONNET_MODEL;

/** The `model` stamp for a grade produced by the box-hosted grader (Max session — no API bill). Keeps
 *  director_decision_grades.model queryable so a box-grade vs API-grade split is visible in dashboards,
 *  and a stale-cost audit can spot the deployed sweep re-firing after Phase 3. Mirrors the same constant
 *  in [[agent-grader]] for the worker cascade. */
const BOX_DIRECTOR_GRADE_MODEL = "box-max-session";

/**
 * agent_jobs statuses that mean a build CONCLUDED — only then is an auto-approval gradeable.
 *
 * `merged` is the build's TERMINAL SUCCESS state, not an in-flight one: a build goes
 * building → completed (pre-push `tsc` passed, PR opened cleanly) → merged (the PR landed on `main`).
 * `merged` is `SUCCESSFUL_BUILD_STATUSES` in agent-jobs.ts — the work EXECUTED and SHIPPED. A post-merge
 * finalization step that doesn't re-flip the job to `completed` (it stays `merged`) must NOT starve grading:
 * the director's APPROVAL call already concluded the moment the work landed, so it is fully gradeable.
 * (Historically only {completed, failed, needs_attention} were here, so every `merged` build silently
 * no-op'd grading for days — the STARVED-grading root cause. See docs/brain/libraries/director-grader.md.)
 */
const TERMINAL_JOB_STATUSES = new Set(["completed", "merged", "failed", "needs_attention"]);

/**
 * The gradeable director-call dimensions.
 * - `auto-approval` / `goal-escort` — the Platform/Growth Director's calls (director-loop-grading Phase 3).
 * - `cs_director_call` / `cs_storyline_precedent` — the CS Director (💬 June) branches added by the
 *   cs-director-grade-with-antigoodhart-rubric-no-fewest-escalations spec (Phase 1). The rubric for
 *   these two dimensions BAKES IN an anti-Goodhart guardrail: the CS Director is NEVER graded on
 *   frequency of founder escalations — refund-everyone minimizes pages while destroying the objective.
 *   The seed calibration rule lives in director_grader_prompts at status='approved' + sort_order=10
 *   (supabase/migrations/20260919120000_cs_director_grader_anti_goodhart_clause.sql) so the deployed
 *   grader prompt injects the clause without a per-workspace CEO approval step.
 *
 * Phase 1 adds the code-side dimensions + `gradeCsDirectorCall` + `gradeCsStorylinePrecedent`
 * exported grader entrypoints. Phase 2 wires the box-lane picker + writer (extending
 * `pickDirectorGradeBatch` + `applyBoxDirectorGrade` + the director_decision_grades CHECK
 * constraint) — until Phase 2 lands, the Phase 1 grader entrypoints compute the grade + reasoning
 * (calibrated by the anti-Goodhart clause) and RETURN them to the caller; they do not persist yet.
 */
export type GradeDimension = "auto-approval" | "goal-escort" | "cs_director_call" | "cs_storyline_precedent";

/** Convenience — the CS-Director dimensions Phase 1 introduces. */
const CS_DIRECTOR_DIMENSIONS: readonly GradeDimension[] = ["cs_director_call", "cs_storyline_precedent"] as const;
export function isCsDirectorDimension(d: GradeDimension): boolean {
  return CS_DIRECTOR_DIMENSIONS.includes(d);
}

export interface DirectorGradeResult {
  ok: boolean;
  reason?: string;
  grade_id?: string;
  dimension?: GradeDimension;
  grade?: number;
  idempotent_update?: boolean;
}

interface GraderJson {
  grade: number;
  soundness: number;
  outcome: number;
  reasoning: string;
}

interface ApprovalDecisionRow {
  id: string;
  workspace_id: string;
  agent_job_id: string | null;
  pending_action_id: string | null;
  raised_by_function: string;
  routed_to_function: string;
  decided_by: string;
  decision: string;
  reasoning: string | null;
  autonomous: boolean;
  created_at: string;
}

interface TargetJobRow {
  id: string;
  kind: string;
  spec_slug: string | null;
  status: string;
  error: string | null;
  log_tail: string | null;
  pending_actions: Array<{ id?: string; type?: string; summary?: string; cmd?: string; status?: string }> | null;
  created_at: string;
}

interface ExistingGradeRow {
  id: string;
  grade: number | null;
  graded_by: string;
}

// ── Shared grader plumbing (mirror campaign-grader / gap-grader) ──────────────────────────────────

/**
 * Build the director-grader system prompt: the static rubric for the dimension + any APPROVED
 * director_grader_prompts calibration rules (CEO-approved corrections to the grader's scoring).
 * Mirrors buildCampaignGraderSystemPrompt / buildGapGraderSystemPrompt.
 */
export async function buildDirectorGraderSystemPrompt(admin: Admin, workspaceId: string, dimension: GradeDimension): Promise<string> {
  const { data: rules } = await admin
    .from("director_grader_prompts")
    .select("title, content")
    .eq("workspace_id", workspaceId)
    .eq("status", "approved")
    .order("sort_order", { ascending: true });

  const rulesBlock = (rules || []).length
    ? "\n\nCALIBRATION RULES (apply these — they are CEO-approved adjustments to the rubric):\n\n" +
      (rules || []).map((r) => `• ${r.title}\n  ${r.content}`).join("\n\n")
    : "";

  const dimensionBlock =
    dimension === "auto-approval"
      ? `You are grading ONE AUTO-APPROVAL: the director, acting as a live+autonomous approver, auto-approved a platform tool's Approval Request (a repair / db-health / additive-migration / monitoring fix) WITHIN ITS LEASH instead of escalating to you, the CEO. The question is whether that was the RIGHT call.

THE DEFINING RULE — GRADE SOUNDNESS SEPARATELY FROM OUTCOME:
  • soundness (1-10): was the call SOUND AT DECISION TIME? Did the director's stated reasoning actually confirm the cause + fix were correct, scoped, low-risk, reversible, and genuinely within the leash (no destructive/irreversible DDL, no goal-touching, no rubber-stamp)? A SOUND approval whose build later needed a rare, reversible tweak still scores HIGH — the reasoning was right. A careless, unconfirmed rubber-stamp that happened to be fine scores LOW.
  • outcome (1-10): did the approved work HOLD UP? The target build concluding clean (completed, no repeat-failure / rollback / re-escalation of the same spec afterward) is a good outcome; a target that failed, went needs_attention, or whose spec re-failed shortly after is a poor one.
  • grade (1-10): the overall call grade. Weight SOUNDNESS at least as heavily as outcome — we are training a director to make SOUND CALLS within its leash, not to get lucky. Do NOT reward a lucky rubber-stamp; do NOT punish a sound approval that hit a rare, reversible bump.`
      : dimension === "goal-escort"
      ? `You are grading ONE GOAL-ESCORT: the director escorted an ALREADY-APPROVED goal's milestone to landing — sequencing its unblocked specs through the build → merge → fold chain. The question is whether the milestone LANDED CLEAN under the director's escort.

THE DEFINING RULE — GRADE SOUNDNESS SEPARATELY FROM OUTCOME:
  • soundness (1-10): did the director escort RESPONSIBLY — only sequencing unblocked, in-sequence specs of a goal the CEO already greenlit (never starting a new goal, never jumping a blocker), and surfacing/escalating rather than forcing anything outside the leash?
  • outcome (1-10): did the milestone LAND CLEAN — every linked spec shipped (merged, tsc/CI green), with no regression escalated against those specs afterward? A milestone that shipped fully and stayed green scores HIGH; one with a stranded/failed spec or a regression escalation scores lower.
  • grade (1-10): the overall escort grade. Weight SOUNDNESS at least as heavily as outcome — a responsibly-sequenced escort that hit an unavoidable external snag is not a bad call.`
      : dimension === "cs_director_call"
      ? `You are grading ONE CS-DIRECTOR HARD CALL: the CS Director (💬 June — the THIRD rung of the escalation ladder, above box-escalation-triage's solver→skeptic quorum) picked ONE escalated ticket the triage quorum could not vote on and emitted ONE typed verdict — approve_remedy | author_spec | escalate_founder. The question is whether that hard call was the RIGHT one and whether it HELD UP.

ANTI-GOODHART GUARDRAIL — READ THIS BEFORE SCORING:
  The CS Director is NEVER graded on frequency of founder escalations. A refund-everyone strategy that minimizes founder pages must NEVER score high — that proxy destroys the objective (customer trust + margin). Grade on SOUNDNESS of the hard call, OUTCOME TRUTHFULNESS verified against ticket_resolution_events, and whether storyline judgment calls held up as policy.

TIER-LADDER-BEFORE-ESCALATION CHECK (cs-director-treats-tier-eligible-out-of-policy-refund-as-playbook-offer-not-escalation Phase 2) — CRITICAL:
  Before scoring an out-of-policy refund/return call, cross-check the PLAYBOOK EXCEPTION-TIER ELIGIBILITY section of the call's brief (loaded by scripts/builder-worker.ts via src/lib/cs-director-playbook-tier-eligibility.ts, from the playbook / playbook_exceptions rows verbatim — never hardcoded). The Refund playbook is DESIGNED to save a tier-eligible customer via Tier-1 (store_credit_return) / Tier-2 (refund_return) offers routed through the offer_exception step; escalating that customer to the founder wastes a sanctioned save and burns customer trust while the ladder still had a legal move.
  • REWARD an approve_remedy that routes a tier-eligible out-of-policy refund back into the playbook's offer_exception step (the Tier-1/Tier-2 sanctioned save) when the customer clears ≥1 tier AND no disqualifier applies (previous_exception, has_chargeback, has_chargeback_on_order). A verdict whose reasoning explicitly cites the tier the customer cleared (e.g. \`Tier 1 "Return for Store Credit" → store_credit_return\`) scores HIGH on soundness — the CS Director consulted the ladder before deciding.
  • PENALIZE an escalate_founder on an out-of-policy refund/return when the brief showed \`eligible_for_offer=true\` on a matching playbook (a tier offer with no disqualifier was available). That is the ticket 87ce35a1 failure mode: a $1569-LTV / 19-order customer escalated to the founder for a renewal refund the Refund playbook's Tier-1/Tier-2 was designed to save. Reasoning MUST cite the missed tier by name when this penalty applies — the CEO is training June to consult the ladder first, escalate second.
  • DO NOT PENALIZE escalate_founder when the customer clears NO tier, a disqualifier applies, or the call is a genuine out-of-leash / storyline / precedent judgment. Those are exactly the calls the third rung exists for.

THE DEFINING RULE — GRADE SOUNDNESS SEPARATELY FROM OUTCOME:
  • soundness (1-10): was the diagnosis + verdict SOUND AT DECISION TIME? Did the CS Director's reasoning actually confirm the root cause from the ticket + ticket_resolution_events write-ahead ledger (every prior orchestrator turn) + linked customer/subscriptions/orders — not just the paraphrased triage summary? A remedy that recites the customer's grievance without cross-checking the ledger scores LOW even if the customer walked away happy. An escalate_founder call with a stated policy-gap rationale scores HIGH — surfacing an out-of-leash situation is the point of the third rung. An author_spec call that named a specific analyzer/rule gap scores HIGH. On a tier-eligible out-of-policy refund/return, an escalate_founder that ignored the ladder scores LOW (see TIER-LADDER CHECK above); an approve_remedy routing to offer_exception that cites the specific tier scores HIGH.
  • outcome (1-10): did the call HOLD UP over the T+7d follow-up window? For approve_remedy: the linked ticket_resolution_events.verified_outcome resolved to 'confirmed' (DB verify passed) and no re-open / re-escalation of the same customer surfaced within 7d. For author_spec: the seeded spec landed on the roadmap and either shipped or is progressing. For escalate_founder: the CEO's disposition confirmed the situation was truly out-of-leash (a false-alarm founder page is a poor outcome, and a founder page the tier ladder could have saved is an especially poor outcome — see TIER-LADDER CHECK). Do NOT infer outcome from "did the customer refund" — a refund-everyone remedy that "resolved" the ticket while destroying margin is the exact Goodhart failure this rubric refuses to reward.
  • grade (1-10): the overall hard-call grade. Weight SOUNDNESS at least as heavily as outcome. NEVER let escalation frequency itself drive the grade — a CS Director that escalates the RIGHT calls is doing its job; a CS Director that never escalates by refund-everyone is failing; a CS Director that escalates a call the sanctioned tier ladder was designed to save is ALSO failing (the anti-Goodhart cascade cuts BOTH directions).`
      : `You are grading ONE CS-STORYLINE PRECEDENT: the CS Director surfaced a precedent-judgment-call storyline (a novel pattern the escalation ladder had no rule for) and the CEO approved it INTO POLICY — a rule / macro / analyzer signal / remedy playbook now live in the CS system. The question is whether that judgment call HELD UP over the following 30d without new counter-evidence.

ANTI-GOODHART GUARDRAIL — READ THIS BEFORE SCORING:
  The CS Director is NEVER graded on frequency of founder escalations. A storyline that codified refund-everyone-for-this-pattern must NEVER score high on outcome — it minimizes friction while destroying margin and undermines the actual objective. Grade on soundness of the judgment call AT PRECEDENT TIME and on how the policy actually LANDED over the 30d holdup window (repeat customers, refund rate, agent-reversal rate — not "did founder pages go down").

THE DEFINING RULE — GRADE SOUNDNESS SEPARATELY FROM OUTCOME:
  • soundness (1-10): was the storyline / precedent SOUND at the moment the CEO approved it? Did the CS Director's stated reasoning name a specific pattern (customer segment × product × failure mode), tie it to real ticket_resolution_events evidence, and propose a targeted policy rather than a blanket refund? A precedent grounded in ledger-evidence scores HIGH. A precedent that generalizes from one loud customer scores LOW.
  • outcome (1-10): did the policy HOLD UP over the 30d window? Positive signals: fewer repeat escalations on the same pattern; the agent-reversal rate against the new rule stayed low; no new counter-evidence surfaced (a second ticket where the rule fired but the RIGHT answer was different). Negative signals: the rule was reversed by a CEO override, or a new counter-example forced an emergency amendment. NEVER count "founder pages went down" as a positive outcome — that is the Goodhart trap.
  • grade (1-10): the overall precedent grade. Weight SOUNDNESS at least as heavily as outcome. A policy that held up on truthfully verified signals scores HIGH; a policy that appeared to work only because it maximized refunds scores LOW.`;

  const directorFraming = isCsDirectorDimension(dimension)
    ? `You are the CEO of ShopCX grading the calls of your CS Director (💬 June) — an autonomous director you supervise (the CEO → Director → tool chain, operational-rules § supervisable autonomy). The CS Director sits at the THIRD RUNG of the escalation ladder, above the box-escalation-triage solver→skeptic quorum: when the quorum can't vote, June makes the hard call (approve_remedy | author_spec | escalate_founder) and — where a precedent survives — turns that judgment call into policy. You grade whether each of her calls was the RIGHT one, 1–10.`
    : `You are the CEO of ShopCX grading the calls of your Platform/DevOps Director — an autonomous director you supervise (the CEO → Director → tool chain, operational-rules § supervisable autonomy). The director auto-approves low-risk platform requests within a leash and escorts already-approved goals to landing; you grade whether each of its calls was the RIGHT one, 1–10.`;

  return `${directorFraming}

${dimensionBlock}

SCORING (1-10), each axis:
  10 — exemplary. 8-9 — strong. 6-7 — acceptable. 4-5 — mediocre. 2-3 — poor. 1 — indefensible.${rulesBlock}

OUTPUT (JSON only, no prose around it):
{
  "grade": <integer 1-10>,
  "soundness": <integer 1-10>,
  "outcome": <integer 1-10>,
  "reasoning": "<2-4 sentences: why the call was sound or careless at decision time, and how it actually landed — kept distinct>"
}`;
}

/** Call the LLM grader and parse the strict JSON. Mirror campaign-grader.runGrader. */
async function runGrader(
  system: string,
  userMsg: string,
  workspaceId: string,
): Promise<{ json: GraderJson; costCents: number; usage: unknown } | { error: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: GRADER_MODEL, max_tokens: 1000, system, messages: [{ role: "user", content: userMsg }] }),
  });
  if (!res.ok) return { error: `grader_http_${res.status}` };

  const data = await res.json();
  const text = (data.content?.[0] as { text?: string })?.text?.trim() || "";
  const usage = data.usage;
  const costCents = usage
    ? usageCostCents(GRADER_MODEL, {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_creation_tokens: usage.cache_creation_input_tokens || 0,
        cache_read_tokens: usage.cache_read_input_tokens || 0,
      })
    : 0;
  await logAiUsage({ workspaceId, model: GRADER_MODEL, usage, purpose: "director_decision_grading" });

  let parsed: GraderJson | null = null;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]) as GraderJson;
  } catch {
    /* fall through */
  }
  const valid = parsed && [parsed.grade, parsed.soundness, parsed.outcome].every((n) => typeof n === "number" && n >= 1 && n <= 10);
  if (!valid) return { error: "parse_failed" };
  return { json: parsed as GraderJson, costCents, usage };
}

function clampGrade(n: number): number {
  return Math.max(1, Math.min(10, Math.round(n)));
}

/** Persist one agent grade — UPDATE in place if a row exists, else INSERT. Never clobbers a human grade. */
async function upsertGrade(
  admin: Admin,
  existing: ExistingGradeRow | null,
  key: {
    dimension: GradeDimension;
    workspaceId: string;
    directorFunction: string;
    approvalDecisionId?: string | null;
    goalSlug?: string | null;
    milestone?: string | null;
  },
  graded: { json: GraderJson; costCents: number; usage: unknown; modelOverride?: string },
): Promise<DirectorGradeResult> {
  if (existing && existing.graded_by === "human") {
    // The CEO owns this grade — the agent never re-writes a human override.
    return { ok: true, grade_id: existing.id, dimension: key.dimension, grade: existing.grade ?? undefined, idempotent_update: true };
  }
  const grade = clampGrade(graded.json.grade);
  const now = new Date().toISOString();
  const usage = graded.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  const payload = {
    workspace_id: key.workspaceId,
    director_function: key.directorFunction,
    dimension: key.dimension,
    approval_decision_id: key.approvalDecisionId ?? null,
    goal_slug: key.goalSlug ?? null,
    milestone: key.milestone ?? null,
    grade,
    reasoning: graded.json.reasoning,
    graded_by: "agent" as const,
    model: graded.modelOverride ?? GRADER_MODEL,
    input_tokens: usage?.input_tokens || 0,
    output_tokens: usage?.output_tokens || 0,
    cost_cents: graded.costCents,
    updated_at: now,
  };
  if (existing) {
    await admin.from("director_decision_grades").update(payload).eq("id", existing.id);
    return { ok: true, grade_id: existing.id, dimension: key.dimension, grade, idempotent_update: true };
  }
  const { data: ins, error } = await admin.from("director_decision_grades").insert(payload).select("id").single();
  if (error) return { ok: false, reason: error.message };
  return { ok: true, grade_id: ins?.id, dimension: key.dimension, grade };
}

/**
 * Apply a director grade produced by the box-hosted grading session (grading-cascade-to-box-sessions
 * Phase 3) — a Max `claude -p` that git-shows the approved diff (auto-approval) or the merged member
 * specs (goal-escort) and grades from concrete file:line, not the director's own `reasoning` string.
 * Mirrors [[agent-grader]] `applyBoxGrade`: reuses the same partial-unique upsert + `graded_by='human'`
 * override invariant, so the leash-adjustment recommender + calibration-rule proposals + the report
 * grid fire identically off box-written grades. Concluded-only + idempotent. `model` is stamped
 * `box-max-session`; no `ai_token_usage` write (Max sub has no per-token API bill — the CEO directive
 * was $0 marginal grading).
 *
 * For an auto-approval, the target build must still be terminal (`completed｜merged｜failed｜needs_attention`);
 * an in-flight target returns `not_concluded` so a benign TOCTOU race (director triage re-queued the
 * build between pick and apply) stays a no-op instead of a stale grade.
 */
export async function applyBoxDirectorGrade(opts: {
  dimension: GradeDimension;
  workspaceId: string;
  directorFunction: string;
  approvalDecisionId?: string;
  goalSlug?: string;
  milestone?: string;
  grade: number;
  reasoning: string;
  admin?: Admin;
}): Promise<DirectorGradeResult> {
  const admin = opts.admin ?? createAdminClient();

  if (opts.dimension === "auto-approval") {
    if (!opts.approvalDecisionId) return { ok: false, reason: "missing_approval_decision_id" };
    const { data: dec } = await admin
      .from("approval_decisions")
      .select("id, workspace_id, agent_job_id, decided_by, decision, autonomous")
      .eq("id", opts.approvalDecisionId)
      .maybeSingle();
    if (!dec) return { ok: false, reason: "decision_not_found" };
    const decision = dec as { id: string; workspace_id: string; agent_job_id: string | null; decided_by: string; decision: string; autonomous: boolean };

    // Phase 7/Fix-2 (check 74b737bdbda6fa8d): a destructive-action approval is decided_by='ceo'
    // (the human decided Ada's out-of-leash raise) but Ada's RAISE is the graded call. It carries
    // a `deterministic-raise-marker` row written by [[migration-safety]]
    // `writeDestructiveActionDecisionGrade`. Look up the existing row FIRST so we can accept the
    // ceo-decided path when it's marker-anchored — the standard director-decided gate would
    // otherwise reject with `not_a_director_approval` and starve the accountability rail.
    const { data: existing } = await admin
      .from("director_decision_grades")
      .select("id, grade, graded_by, model")
      .eq("approval_decision_id", decision.id)
      .maybeSingle();
    const existingRow = (existing as (ExistingGradeRow & { model?: string | null }) | null) ?? null;
    const isDestructiveMarker = existingRow?.model === "deterministic-raise-marker";

    const isDirectorApproved = decision.decided_by === "director" && decision.decision === "approved";
    if (!isDirectorApproved && !isDestructiveMarker) return { ok: false, reason: "not_a_director_approval" };

    // Re-check the target build's terminal-status — a benign TOCTOU: the box picked while terminal,
    // director triage re-queued it back to `queued` before the box's grade landed.
    if (decision.agent_job_id) {
      const { data: job } = await admin
        .from("agent_jobs")
        .select("status")
        .eq("id", decision.agent_job_id)
        .maybeSingle();
      if (job && !TERMINAL_JOB_STATUSES.has((job as { status: string }).status)) {
        return { ok: false, reason: "not_concluded" };
      }
    }

    if (existingRow && existingRow.graded_by === "human") {
      return { ok: true, grade_id: existingRow.id, dimension: "auto-approval", grade: existingRow.grade ?? undefined, idempotent_update: true };
    }

    return upsertGrade(
      admin,
      existingRow,
      {
        dimension: "auto-approval",
        workspaceId: decision.workspace_id,
        directorFunction: opts.directorFunction || PLATFORM,
        approvalDecisionId: decision.id,
      },
      {
        json: { grade: opts.grade, soundness: opts.grade, outcome: opts.grade, reasoning: opts.reasoning },
        costCents: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelOverride: BOX_DIRECTOR_GRADE_MODEL,
      },
    );
  }

  // goal-escort
  if (!opts.goalSlug || !opts.milestone) return { ok: false, reason: "missing_goal_escort_key" };
  const { data: existing } = await admin
    .from("director_decision_grades")
    .select("id, grade, graded_by")
    .eq("workspace_id", opts.workspaceId)
    .eq("dimension", "goal-escort")
    .eq("goal_slug", opts.goalSlug)
    .eq("milestone", opts.milestone)
    .maybeSingle();
  const existingRow = (existing as ExistingGradeRow) ?? null;
  if (existingRow && existingRow.graded_by === "human") {
    return { ok: true, grade_id: existingRow.id, dimension: "goal-escort", grade: existingRow.grade ?? undefined, idempotent_update: true };
  }

  return upsertGrade(
    admin,
    existingRow,
    {
      dimension: "goal-escort",
      workspaceId: opts.workspaceId,
      directorFunction: opts.directorFunction || PLATFORM,
      goalSlug: opts.goalSlug,
      milestone: opts.milestone,
    },
    {
      json: { grade: opts.grade, soundness: opts.grade, outcome: opts.grade, reasoning: opts.reasoning },
      costCents: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelOverride: BOX_DIRECTOR_GRADE_MODEL,
    },
  );
}

// ── auto-approval dimension ───────────────────────────────────────────────────────────────────────

/**
 * Optional outcome-engine context for a graded auto-approval. Right now only Growth Director's
 * `propose_policy_activation` approvals carry it (the activated iteration_policy's per-run actions +
 * their realized ROAS / status mix — the "did this policy hold up" signal that replaces the
 * platform-side repeat-failure count for the iteration loop). The grader splices this block in
 * underneath the regular HOW-IT-LANDED summary when present.
 */
export interface IterationPolicyOutcome {
  policyId: string;
  version: number | null;
  runs: Array<{
    runId: string;
    status: string;
    snapshotDate: string | null;
    counts: Record<string, unknown> | null;
  }>;
  actions: Array<{
    actionType: string;
    status: string;
    outcomeRoas: number | null;
    outcomeWindowDays: number | null;
  }>;
}

function summarizeActions(actions: IterationPolicyOutcome["actions"]): string {
  if (!actions.length) return "  (no iteration_actions decided under this policy yet — too early to score the outcome)";
  const byStatus = new Map<string, number>();
  const roasSeen: number[] = [];
  for (const a of actions) {
    byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
    if (typeof a.outcomeRoas === "number" && Number.isFinite(a.outcomeRoas)) roasSeen.push(a.outcomeRoas);
  }
  const breakdown = Array.from(byStatus.entries())
    .map(([s, n]) => `${s}=${n}`)
    .join(", ");
  const roasLine = roasSeen.length
    ? `  realized outcome_roas across ${roasSeen.length} reconciled action(s): mean ${(roasSeen.reduce((a, b) => a + b, 0) / roasSeen.length).toFixed(2)} (min ${Math.min(...roasSeen).toFixed(2)}, max ${Math.max(...roasSeen).toFixed(2)})`
    : "  outcome_roas: (not yet reconciled — reconcilePriorActions has not back-filled this window)";
  return [`  iteration_actions status mix: ${breakdown}`, roasLine].join("\n");
}

function formatIterationOutcomeBlock(o: IterationPolicyOutcome): string {
  const runHeader = o.runs.length
    ? o.runs
        .map(
          (r) =>
            `    - run ${r.runId.slice(0, 8)} · status=${r.status}${r.snapshotDate ? ` · day=${r.snapshotDate}` : ""}`,
        )
        .join("\n")
    : "    (no iteration_runs yet under this policy)";
  return [
    ``,
    `  ITERATION-ENGINE OUTCOME (the realized signal that supersedes repeat-failure count for policy-activation approvals):`,
    `  policy ${o.policyId.slice(0, 8)}${o.version != null ? ` (v${o.version})` : ""}`,
    `  iteration_runs that executed under this policy:`,
    runHeader,
    summarizeActions(o.actions),
  ].join("\n");
}

/** Compact, gradeable description of one auto-approval: the director's reasoning + how the build landed. */
function formatAutoApprovalForGrading(
  decision: ApprovalDecisionRow,
  job: TargetJobRow | null,
  repeatFailures: number,
  iterationOutcome?: IterationPolicyOutcome | null,
): string {
  const approvedAction = (job?.pending_actions || []).find((a) => a.status === "approved") || (job?.pending_actions || [])[0] || {};
  const concluded = job ? (TERMINAL_JOB_STATUSES.has(job.status) ? job.status : `still in-flight (${job.status})`) : "(target job gone)";
  return [
    `AUTO-APPROVAL — approval_decision ${decision.id}`,
    `  raised by: ${decision.raised_by_function} · routed to: ${decision.routed_to_function} · decided_by: ${decision.decided_by} (autonomous=${decision.autonomous})`,
    `  target build: kind=${job?.kind ?? "?"} · spec=${job?.spec_slug ?? "—"}`,
    `  approved action: type=${approvedAction.type ?? "?"} · ${approvedAction.summary ?? "(no summary)"}`,
    approvedAction.cmd ? `  command run on approval: ${approvedAction.cmd}` : "",
    ``,
    `  THE DIRECTOR'S STATED REASONING (what it claimed made this sound + in-leash):`,
    `  ${decision.reasoning || "(none recorded — a bare rubber-stamp is itself a red flag)"}`,
    ``,
    `  HOW IT LANDED:`,
    `  target build concluded: ${concluded}`,
    job?.error ? `  target error: ${job.error.slice(0, 400)}` : "",
    `  later repeat-failures of the same spec after this approval: ${repeatFailures}`,
    job?.log_tail ? `  build log tail:\n${job.log_tail.slice(-1200)}` : "",
    iterationOutcome ? formatIterationOutcomeBlock(iterationOutcome) : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Load the iteration-engine outcome for a Growth Director policy-activation approval. The
 * `propose_policy_activation` action runs `authorIterationPolicy` then `activateIterationPolicy`,
 * and the worker records a `director_activity` row of `action_kind='activated_iteration_policy'`
 * carrying `metadata.policy_id` (see scripts/builder-worker.ts § growth-director runner). From that
 * policy_id we can read every iteration_run that ran under it + every iteration_action it produced,
 * with the reconcilePriorActions-backfilled `outcome_roas` already in place — the realized signal
 * the spec wants us to grade against.
 *
 * Best-effort: any read failure / missing metadata returns null so the grader still grades on
 * soundness + repeat-failure count alone.
 */
async function loadIterationOutcomeForApproval(
  admin: Admin,
  decision: ApprovalDecisionRow,
  approvedActionType: string | undefined,
): Promise<IterationPolicyOutcome | null> {
  if (approvedActionType !== "propose_policy_activation" && approvedActionType !== "iteration_policy_activation") return null;
  if (!decision.agent_job_id) return null;
  try {
    const { data: activity } = await admin
      .from("director_activity")
      .select("metadata")
      .eq("workspace_id", decision.workspace_id)
      .eq("action_kind", "activated_iteration_policy")
      .order("created_at", { ascending: false })
      .limit(20);
    const row = ((activity as Array<{ metadata: Record<string, unknown> | null }>) ?? []).find(
      (r) => typeof r.metadata?.job_id === "string" && r.metadata.job_id === decision.agent_job_id,
    );
    const policyId = (row?.metadata?.policy_id as string | undefined) ?? null;
    const version = (row?.metadata?.version as number | undefined) ?? null;
    if (!policyId) return null;

    const { data: runs } = await admin
      .from("iteration_runs")
      .select("id, status, snapshot_date, counts")
      .eq("workspace_id", decision.workspace_id)
      .eq("policy_version_id", policyId)
      .order("started_at", { ascending: false })
      .limit(20);
    const runRows = ((runs as Array<{ id: string; status: string; snapshot_date: string | null; counts: Record<string, unknown> | null }>) ?? []).map((r) => ({
      runId: r.id,
      status: r.status,
      snapshotDate: r.snapshot_date,
      counts: r.counts ?? null,
    }));

    const { data: actions } = await admin
      .from("iteration_actions")
      .select("action_type, status, outcome_roas, outcome_window_days")
      .eq("workspace_id", decision.workspace_id)
      .eq("policy_version_id", policyId)
      .order("created_at", { ascending: false })
      .limit(100);
    const actionRows = ((actions as Array<{ action_type: string; status: string; outcome_roas: number | null; outcome_window_days: number | null }>) ?? []).map((a) => ({
      actionType: a.action_type,
      status: a.status,
      outcomeRoas: a.outcome_roas == null ? null : Number(a.outcome_roas),
      outcomeWindowDays: a.outcome_window_days,
    }));

    return { policyId, version, runs: runRows, actions: actionRows };
  } catch {
    return null;
  }
}

/** Count later failed/needs_attention builds of the same spec after the approval — the "did it hold up" signal. */
async function countRepeatFailures(admin: Admin, decision: ApprovalDecisionRow, job: TargetJobRow | null): Promise<number> {
  if (!job?.spec_slug) return 0;
  try {
    const { data } = await admin
      .from("agent_jobs")
      .select("id, status")
      .eq("workspace_id", decision.workspace_id)
      .eq("spec_slug", job.spec_slug)
      .in("status", ["failed", "needs_attention"])
      .gt("created_at", decision.created_at)
      .neq("id", job.id)
      .limit(50);
    return (data as Array<{ id: string }> | null)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Grade ONE auto-approval (an approval_decisions row). Concluded-only + idempotent + human-safe. */
export async function gradeAutoApproval(opts: { approvalDecisionId: string; admin?: Admin }): Promise<DirectorGradeResult> {
  if (!ANTHROPIC_API_KEY) return { ok: false, reason: "no_api_key" };
  const admin = opts.admin ?? createAdminClient();

  const { data: dec } = await admin
    .from("approval_decisions")
    .select("id, workspace_id, agent_job_id, pending_action_id, raised_by_function, routed_to_function, decided_by, decision, reasoning, autonomous, created_at")
    .eq("id", opts.approvalDecisionId)
    .maybeSingle();
  if (!dec) return { ok: false, reason: "decision_not_found" };
  const decision = dec as ApprovalDecisionRow;
  // Only the director's OWN autonomous approvals are a "director call" — a CEO/human seat isn't graded here.
  if (decision.decided_by !== "director" || decision.decision !== "approved") return { ok: false, reason: "not_a_director_approval" };

  let job: TargetJobRow | null = null;
  if (decision.agent_job_id) {
    const { data } = await admin
      .from("agent_jobs")
      .select("id, kind, spec_slug, status, error, log_tail, pending_actions, created_at")
      .eq("id", decision.agent_job_id)
      .maybeSingle();
    job = (data as TargetJobRow) ?? null;
  }
  // Not gradeable until the build it approved has actually concluded (did it hold up?).
  if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) return { ok: false, reason: "not_concluded" };

  const { data: existing } = await admin
    .from("director_decision_grades")
    .select("id, grade, graded_by")
    .eq("approval_decision_id", decision.id)
    .maybeSingle();
  const existingRow = (existing as ExistingGradeRow) ?? null;
  if (existingRow && existingRow.graded_by === "human") {
    return { ok: true, grade_id: existingRow.id, dimension: "auto-approval", grade: existingRow.grade ?? undefined, idempotent_update: true };
  }

  const repeatFailures = await countRepeatFailures(admin, decision, job);
  const approvedActionType = ((job?.pending_actions || []).find((a) => a.status === "approved") || (job?.pending_actions || [])[0])?.type;
  const iterationOutcome = await loadIterationOutcomeForApproval(admin, decision, approvedActionType);
  const system = await buildDirectorGraderSystemPrompt(admin, decision.workspace_id, "auto-approval");
  const userMsg = `Grade this auto-approval call. Return the JSON only.\n\n${formatAutoApprovalForGrading(decision, job, repeatFailures, iterationOutcome)}`;

  const graded = await runGrader(system, userMsg, decision.workspace_id);
  if ("error" in graded) return { ok: false, reason: graded.error };
  // Stamp the director function from the approval's routed_to_function — that's the director whose
  // call this was. Falls back to Platform if the routing field was somehow blank (historical rows).
  const directorFunction = decision.routed_to_function || PLATFORM;
  return upsertGrade(
    admin,
    existingRow,
    { dimension: "auto-approval", workspaceId: decision.workspace_id, directorFunction, approvalDecisionId: decision.id },
    graded,
  );
}

// ── goal-escort dimension ─────────────────────────────────────────────────────────────────────────

interface MilestoneContext {
  goalSlug: string;
  goalTitle: string;
  milestoneId: string;
  milestoneName: string;
  /** The director that escorted this goal — function slug ('platform' | 'growth' | …). */
  directorFunction: string;
  specs: Array<{ slug: string; status: string }>;
  escortReasons: string[];
  regressionCount: number;
}

/** Compact, gradeable description of one escorted milestone. */
function formatGoalEscortForGrading(ctx: MilestoneContext): string {
  return [
    `GOAL-ESCORT — goal "${ctx.goalTitle}" (${ctx.goalSlug}) · milestone ${ctx.milestoneId || "—"}: ${ctx.milestoneName}`,
    `  the milestone's specs (must all be shipped to land clean):`,
    ...ctx.specs.map((s) => `    - ${s.slug}: ${s.status}`),
    ``,
    `  WHAT THE DIRECTOR DID (its escort activity for this goal):`,
    ...(ctx.escortReasons.length ? ctx.escortReasons.map((r) => `    • ${r}`) : ["    (no escort activity recorded for this goal)"]),
    ``,
    `  regression / escalation activity logged against this goal's specs afterward: ${ctx.regressionCount}`,
  ].join("\n");
}

/** Grade ONE escorted milestone (goal_slug + milestone). Concluded-only (milestone shipped) + idempotent + human-safe. */
export async function gradeGoalEscort(opts: { context: MilestoneContext; workspaceId: string; admin?: Admin }): Promise<DirectorGradeResult> {
  if (!ANTHROPIC_API_KEY) return { ok: false, reason: "no_api_key" };
  const admin = opts.admin ?? createAdminClient();
  const ctx = opts.context;

  const { data: existing } = await admin
    .from("director_decision_grades")
    .select("id, grade, graded_by")
    .eq("workspace_id", opts.workspaceId)
    .eq("dimension", "goal-escort")
    .eq("goal_slug", ctx.goalSlug)
    .eq("milestone", ctx.milestoneId)
    .maybeSingle();
  const existingRow = (existing as ExistingGradeRow) ?? null;
  if (existingRow && existingRow.graded_by === "human") {
    return { ok: true, grade_id: existingRow.id, dimension: "goal-escort", grade: existingRow.grade ?? undefined, idempotent_update: true };
  }

  const system = await buildDirectorGraderSystemPrompt(admin, opts.workspaceId, "goal-escort");
  const userMsg = `Grade this goal-escort call. Return the JSON only.\n\n${formatGoalEscortForGrading(ctx)}`;

  const graded = await runGrader(system, userMsg, opts.workspaceId);
  if ("error" in graded) return { ok: false, reason: graded.error };
  return upsertGrade(
    admin,
    existingRow,
    {
      dimension: "goal-escort",
      workspaceId: opts.workspaceId,
      directorFunction: ctx.directorFunction || PLATFORM,
      goalSlug: ctx.goalSlug,
      milestone: ctx.milestoneId,
    },
    graded,
  );
}

// ── CS-Director dimensions (cs-director-grade-with-antigoodhart-rubric-no-fewest-escalations Phase 1) ─

/**
 * Compact, gradeable context for ONE CS-Director hard call — the payload
 * `gradeCsDirectorCall` renders into the user message. Phase 1 keeps the shape
 * caller-authored (the caller builds it from `director_activity`, the ticket, and
 * the ticket_resolution_events ledger) so we're not coupling the grader to a
 * (still-scaffolded) storyline schema.
 */
export interface CsDirectorCallContext {
  csDirectorCallId: string;
  ticketId: string;
  /** The typed verdict the CS Director emitted (`approve_remedy` | `author_spec` | `escalate_founder`). */
  decision: string;
  /** June's stated reasoning — the "why" the CEO grades. */
  reasoning: string;
  /** A one-line summary of the remedy (approve_remedy) or the seeded spec (author_spec), if any. */
  actionSummary?: string;
  /** The most recent ticket_resolution_events row for the ticket — the write-ahead-ledger snapshot the outcome is verified against. */
  latestResolutionEvent?: {
    turnIndex: number;
    problem: string | null;
    confidence: number | null;
    verifiedOutcome: string | null;
    stagedAt: string;
    shippedAt: string | null;
    verifiedAt: string | null;
  } | null;
  /** Count of re-escalations of the same ticket within the T+7d follow-up window — the "did it hold up" signal. */
  reescalationsIn7d: number;
  /** The CS-Director row's created_at — anchors the T+7d follow-up window. */
  calledAt: string;
}

/** Compact, gradeable context for ONE CS-storyline precedent. Phase 1 keeps the shape caller-authored;
 *  Phase 2 will build it from the storyline row + the 30d policy-holdup signal set. */
export interface CsStorylinePrecedentContext {
  storylineId: string;
  workspaceId: string;
  /** A short human-readable label for the precedent (customer segment × product × failure mode). */
  precedentLabel: string;
  /** The CS Director's original judgment-call reasoning — the "why this pattern deserves a policy". */
  reasoning: string;
  /** The CEO's disposition when the precedent was approved into policy (approved / approved_with_amendments). */
  ceoDisposition: string;
  /** A one-line summary of the policy the CEO approved (macro / rule / analyzer signal / playbook). */
  policySummary: string;
  /** Signals gathered over the 30d holdup window — none of these are "fewer founder pages". */
  holdupSignals?: {
    windowDays: number;
    repeatEscalationsOnPattern: number;
    agentReversalsAgainstPolicy: number;
    counterEvidenceCases: number;
    policyReversedByCeo: boolean;
  } | null;
  /** The precedent's approved_at — anchors the 30d policy-holdup window. */
  approvedAt: string;
}

function formatCsDirectorCallForGrading(ctx: CsDirectorCallContext): string {
  const rev = ctx.latestResolutionEvent;
  return [
    `CS-DIRECTOR HARD CALL — cs_director_call ${ctx.csDirectorCallId}`,
    `  ticket: ${ctx.ticketId}`,
    `  decision: ${ctx.decision}`,
    ctx.actionSummary ? `  action summary: ${ctx.actionSummary}` : "",
    ``,
    `  THE CS DIRECTOR'S STATED REASONING (why the hard call was sound + within-scope):`,
    `  ${ctx.reasoning || "(none recorded — a bare escalation with no reasoning is itself a red flag)"}`,
    ``,
    `  OUTCOME TRUTHFULNESS (verified against ticket_resolution_events, T+7d follow-up window):`,
    rev
      ? `  latest resolution event: turn ${rev.turnIndex} · problem="${rev.problem ?? "—"}" · confidence=${rev.confidence ?? "—"} · verified_outcome=${rev.verifiedOutcome ?? "(still open)"} · staged=${rev.stagedAt} · shipped=${rev.shippedAt ?? "—"} · verified=${rev.verifiedAt ?? "—"}`
      : `  no ticket_resolution_events row found for this ticket — treat outcome as UNVERIFIED`,
    `  re-escalations of the same ticket within 7d after the call: ${ctx.reescalationsIn7d}`,
    `  call made at: ${ctx.calledAt}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function formatCsStorylinePrecedentForGrading(ctx: CsStorylinePrecedentContext): string {
  const s = ctx.holdupSignals;
  return [
    `CS-STORYLINE PRECEDENT — storyline ${ctx.storylineId}`,
    `  precedent: ${ctx.precedentLabel}`,
    `  CEO disposition: ${ctx.ceoDisposition}`,
    `  policy landed: ${ctx.policySummary}`,
    ``,
    `  THE CS DIRECTOR'S STATED REASONING (why this precedent deserved a policy):`,
    `  ${ctx.reasoning || "(none recorded)"}`,
    ``,
    `  30D POLICY HOLDUP SIGNALS (NOT founder-page frequency — anti-Goodhart guardrail):`,
    s
      ? `  window=${s.windowDays}d · repeat-escalations on pattern=${s.repeatEscalationsOnPattern} · agent-reversals against policy=${s.agentReversalsAgainstPolicy} · counter-evidence cases=${s.counterEvidenceCases} · policy reversed by CEO=${s.policyReversedByCeo}`
      : `  no holdup signals gathered yet — treat outcome as UNVERIFIED`,
    `  approved at: ${ctx.approvedAt}`,
  ].join("\n");
}

/**
 * Grade ONE CS-Director hard call (cs-director-grade-with-antigoodhart-rubric-no-fewest-escalations Phase 1).
 *
 * The rubric baked into `buildDirectorGraderSystemPrompt` for `dimension='cs_director_call'` explicitly
 * REJECTS grading on "fewest founder escalations" (Goodhart); it grades on soundness of the hard call,
 * outcome truthfulness verified against ticket_resolution_events, and how the call held up over T+7d.
 * The seed calibration rule in director_grader_prompts (status='approved', sort_order=10 — migration
 * 20260919120000_cs_director_grader_anti_goodhart_clause.sql) is auto-injected so the CEO's
 * anti-Goodhart clause is always in the prompt without a per-workspace re-approval step.
 *
 * Phase 1 boundary — PERSISTENCE IS PHASE 2. This function computes { grade, soundness, outcome,
 * reasoning } from the LLM and RETURNS them to the caller. Phase 2 extends `applyBoxDirectorGrade`
 * to accept the CS dimensions + relaxes the director_decision_grades CHECK constraint + adds the
 * `cs_director_call_id` / `cs_storyline_id` key columns, at which point the box lane's
 * `runDirectorGradeJob` invokes this function then writes via `applyBoxDirectorGrade`. Until Phase 2
 * lands, calling this from the deployed sweep is a no-op-safe read: it never touches
 * director_decision_grades so it can't hit the CHECK constraint.
 */
export async function gradeCsDirectorCall(opts: {
  context: CsDirectorCallContext;
  workspaceId: string;
  admin?: Admin;
}): Promise<DirectorGradeResult> {
  if (!ANTHROPIC_API_KEY) return { ok: false, reason: "no_api_key" };
  const admin = opts.admin ?? createAdminClient();

  const system = await buildDirectorGraderSystemPrompt(admin, opts.workspaceId, "cs_director_call");
  const userMsg = `Grade this CS-Director hard call. Return the JSON only.\n\n${formatCsDirectorCallForGrading(opts.context)}`;

  const graded = await runGrader(system, userMsg, opts.workspaceId);
  if ("error" in graded) return { ok: false, reason: graded.error };
  return {
    ok: true,
    dimension: "cs_director_call",
    grade: clampGrade(graded.json.grade),
    reason: graded.json.reasoning,
  };
}

/**
 * Grade ONE CS-storyline precedent — the 30d policy-holdup grader
 * (cs-director-grade-with-antigoodhart-rubric-no-fewest-escalations Phase 1).
 *
 * Mirrors `gradeCsDirectorCall`: reads the caller-authored context, builds the prompt with the
 * anti-Goodhart clause auto-injected from director_grader_prompts, calls the LLM, and returns
 * the grade + reasoning. Persistence is Phase 2 (extend applyBoxDirectorGrade + relax the CHECK
 * constraint + add `cs_storyline_id`). The rubric explicitly refuses to score "founder pages went
 * down" as a positive outcome — the storyline is graded on soundness at precedent-time and on the
 * REAL holdup signals (repeat escalations on the pattern, agent-reversals against the policy,
 * counter-evidence cases, whether the CEO reversed the rule).
 */
export async function gradeCsStorylinePrecedent(opts: {
  context: CsStorylinePrecedentContext;
  workspaceId: string;
  admin?: Admin;
}): Promise<DirectorGradeResult> {
  if (!ANTHROPIC_API_KEY) return { ok: false, reason: "no_api_key" };
  const admin = opts.admin ?? createAdminClient();

  const system = await buildDirectorGraderSystemPrompt(admin, opts.workspaceId, "cs_storyline_precedent");
  const userMsg = `Grade this CS-storyline precedent. Return the JSON only.\n\n${formatCsStorylinePrecedentForGrading(opts.context)}`;

  const graded = await runGrader(system, userMsg, opts.workspaceId);
  if ("error" in graded) return { ok: false, reason: graded.error };
  return {
    ok: true,
    dimension: "cs_storyline_precedent",
    grade: clampGrade(graded.json.grade),
    reason: graded.json.reasoning,
  };
}

/**
 * The single per-call entrypoint the spec names — gradeDirectorCall(decision, dimension). Dispatches to
 * the dimension-specific grader. For 'auto-approval' pass `approvalDecisionId`; for 'goal-escort' pass a
 * resolved MilestoneContext; for 'cs_director_call' / 'cs_storyline_precedent' pass the CS-dimension
 * context (spec Phase 1). The sweep below builds the Platform/Growth contexts; the CS-Director contexts
 * are built by the box lane in Phase 2.
 */
export async function gradeDirectorCall(opts: {
  dimension: GradeDimension;
  workspaceId: string;
  approvalDecisionId?: string;
  context?: MilestoneContext;
  csDirectorCallContext?: CsDirectorCallContext;
  csStorylinePrecedentContext?: CsStorylinePrecedentContext;
  admin?: Admin;
}): Promise<DirectorGradeResult> {
  if (opts.dimension === "auto-approval") {
    if (!opts.approvalDecisionId) return { ok: false, reason: "missing_approval_decision_id" };
    return gradeAutoApproval({ approvalDecisionId: opts.approvalDecisionId, admin: opts.admin });
  }
  if (opts.dimension === "goal-escort") {
    if (!opts.context) return { ok: false, reason: "missing_milestone_context" };
    return gradeGoalEscort({ context: opts.context, workspaceId: opts.workspaceId, admin: opts.admin });
  }
  if (opts.dimension === "cs_director_call") {
    if (!opts.csDirectorCallContext) return { ok: false, reason: "missing_cs_director_call_context" };
    return gradeCsDirectorCall({ context: opts.csDirectorCallContext, workspaceId: opts.workspaceId, admin: opts.admin });
  }
  // dimension === "cs_storyline_precedent"
  if (!opts.csStorylinePrecedentContext) return { ok: false, reason: "missing_cs_storyline_precedent_context" };
  return gradeCsStorylinePrecedent({ context: opts.csStorylinePrecedentContext, workspaceId: opts.workspaceId, admin: opts.admin });
}

/**
 * Public alias the growth-adopt-meta-iteration-engine spec (Phase 2) names —
 * `gradeDirectorDecision`. Identical signature + behavior as `gradeDirectorCall`; we expose both so
 * the Growth-side callsites can read against the spec's preferred verb without renaming the existing
 * Platform-side wiring.
 */
export const gradeDirectorDecision = gradeDirectorCall;

// ── The standing-cadence sweep (fired from platform-director-cron, M1) ───────────────────────────────

/**
 * `considered` represents work that SHOULD be graded right now — not work that's still in flight.
 * These reasons mean the grader correctly deferred (the target hasn't concluded yet, or the row
 * has gone missing); they MUST NOT inflate `considered`, or the grading-starved monitor pages
 * whenever the director has open auto-approvals (which is basically always). An LLM/parse/HTTP
 * error path is NOT in this set — that's genuine starvation and should page.
 */
export const INFLIGHT_SKIP_REASONS = new Set(["not_concluded", "no_target", "decision_not_found"]);
export function isInflightSkip(r: DirectorGradeResult): boolean {
  return !r.ok && !!r.reason && INFLIGHT_SKIP_REASONS.has(r.reason);
}

/**
 * Per-result counter update for the sweep — extracted so the tally semantics are a pure function
 * the test can drive directly without stubbing Supabase + the LLM. In-flight skips bump neither
 * counter; a real grade bumps both; an LLM/parse/HTTP error bumps `considered` (genuine starvation).
 */
export function tallySweepResult(state: { considered: number; graded: number }, r: DirectorGradeResult): void {
  if (isInflightSkip(r)) return;
  state.considered++;
  if (r.ok && !r.idempotent_update) state.graded++;
}

/**
 * Resolve the escorted milestones the named director OWNS that have CONCLUDED (every spec shipped)
 * and that the director actually escorted (an `escorted_goal` activity row for the goal under that
 * director_function). Each is one gradeable goal-escort call. Best-effort.
 *
 * Phase 2 (growth-adopt-meta-iteration-engine): now parameterized on `directorFunction` so the same
 * sweep grades the Growth Director's escorts (when it grows that responsibility) without rewriting
 * the goal pool to PLATFORM. The default stays PLATFORM for backwards-compat with existing callers.
 */
async function concludedEscortedMilestones(
  admin: Admin,
  workspaceId: string,
  directorFunction: string = PLATFORM,
): Promise<MilestoneContext[]> {
  const out: MilestoneContext[] = [];
  try {
    const goals = (await getGoals()).filter((g) => g.owner === directorFunction);
    if (!goals.length) return out;

    // Goals the director actually escorted (logged an `escorted_goal` activity row).
    const { data: escortRows } = await admin
      .from("director_activity")
      .select("reason, metadata")
      .eq("workspace_id", workspaceId)
      .eq("director_function", directorFunction)
      .eq("action_kind", "escorted_goal")
      .order("created_at", { ascending: false })
      .limit(500);
    const escortByGoal = new Map<string, string[]>();
    for (const r of (escortRows as Array<{ reason: string; metadata: Record<string, unknown> | null }>) || []) {
      const slug = typeof r.metadata?.goal_slug === "string" ? (r.metadata.goal_slug as string) : null;
      if (!slug) continue;
      const list = escortByGoal.get(slug) ?? [];
      if (list.length < 6 && r.reason) list.push(r.reason);
      escortByGoal.set(slug, list);
    }

    for (const goal of goals) {
      if (!escortByGoal.has(goal.slug)) continue; // the director never escorted this goal → not its call
      for (const m of goal.milestones) {
        if (m.status !== "shipped") continue; // only a CONCLUDED (fully-shipped) milestone is gradeable
        if (!m.specSlugs.length) continue;
        out.push({
          goalSlug: goal.slug,
          goalTitle: goal.title,
          milestoneId: m.id || m.name,
          milestoneName: m.name,
          directorFunction,
          specs: m.specSlugs.map((slug) => ({ slug, status: "shipped" })),
          escortReasons: escortByGoal.get(goal.slug) ?? [],
          regressionCount: 0,
        });
      }
    }
  } catch (e) {
    console.warn(`[director-grader] escort-candidate resolve failed ws=${workspaceId} fn=${directorFunction}: ${errText(e)}`);
  }
  return out;
}

/**
 * The standing-cadence grading sweep (called from platform-director-cron, the M1 beat): grade every
 * recently-CONCLUDED director call that has no grade yet — both dimensions. Best-effort + idempotent
 * (an already-graded call is skipped; gradeDirectorCall upserts in place if re-run). Skips a human-
 * overridden grade. A no-op while the director made no calls (dormant pre-Phase-4 → zero candidates).
 */
export async function gradeConcludedDirectorCalls(opts: { workspaceId: string; admin?: Admin }): Promise<{ considered: number; graded: number }> {
  const admin = opts.admin ?? createAdminClient();
  const state = { considered: 0, graded: 0 };
  if (!ANTHROPIC_API_KEY) return state;

  try {
    // Already-graded keys → skip (don't re-spend the LLM on a settled grade). PAGINATE past the
    // 1000-row PostgREST response cap (a single `.limit(5000)` still returns at most 1000) — a
    // truncated graded set would falsely re-surface settled grades as ungraded and re-spend the LLM,
    // the same truncation trap the worker grader's pool query hit (fix-starved-grading round 2).
    const gradedApprovals = new Set<string>();
    const gradedEscorts = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data: gradeRows } = await admin
        .from("director_decision_grades")
        .select("dimension, approval_decision_id, goal_slug, milestone")
        .eq("workspace_id", opts.workspaceId)
        .range(from, from + 999);
      const rows = (gradeRows as Array<{ dimension: string; approval_decision_id: string | null; goal_slug: string | null; milestone: string | null }>) || [];
      for (const r of rows) {
        if (r.dimension === "auto-approval" && r.approval_decision_id) gradedApprovals.add(r.approval_decision_id);
        else if (r.dimension === "goal-escort" && r.goal_slug) gradedEscorts.add(`${r.goal_slug}:${r.milestone ?? ""}`);
      }
      if (rows.length < 1000) break;
    }

    // ── auto-approval — every autonomous director approval ──────────────────────────────────────
    const { data: decisions } = await admin
      .from("approval_decisions")
      .select("id")
      .eq("workspace_id", opts.workspaceId)
      .eq("decided_by", "director")
      .eq("decision", "approved")
      .eq("autonomous", true)
      .order("created_at", { ascending: false })
      .limit(500);
    for (const d of (decisions as Array<{ id: string }>) || []) {
      if (gradedApprovals.has(d.id)) continue;
      // Grade FIRST, then count — `considered` must reflect work that should be graded NOW.
      // An in-flight target (the grader correctly deferred) is NOT starvation; an LLM/parse error IS.
      tallySweepResult(state, await gradeAutoApproval({ approvalDecisionId: d.id, admin }));
    }

    // ── goal-escort — every concluded escorted milestone for every live director ───────────────
    // Mirror the auto-approval gate for symmetry: a milestone that isn't truly concluded must not
    // tick `considered`. `concludedEscortedMilestones` already pre-filters to `status='shipped'`,
    // so in practice every row here is gradeable; the gate stays in place defensively in case
    // `gradeGoalEscort` ever grows an in-flight skip reason of its own. We sweep BOTH Platform and
    // Growth so the Growth Director's goal-escort calls (when it grows that responsibility) feed
    // the same standing cadence — no second cron is needed.
    for (const fn of [PLATFORM, GROWTH]) {
      for (const ctx of await concludedEscortedMilestones(admin, opts.workspaceId, fn)) {
        if (gradedEscorts.has(`${ctx.goalSlug}:${ctx.milestoneId}`)) continue;
        tallySweepResult(state, await gradeGoalEscort({ context: ctx, workspaceId: opts.workspaceId, admin }));
      }
    }
  } catch (e) {
    console.warn(`[director-grader] sweep failed ws=${opts.workspaceId}: ${errText(e)}`);
  }
  return state;
}

// ── grading-cascade-to-box-sessions Phase 3: pick the batch of director calls to grade box-side ──────

/** Cap the number of director calls one box grading session grades in a batch. Mirrors GRADE_BATCH_CAP
 *  in [[agent-grader]]. Kept small: a director grade turn reads the approved diff + touched files, which
 *  is roughly a build-sized read per call. */
const DIRECTOR_GRADE_BATCH_CAP = 8;

/** One ungraded director call the box grader will inspect. Discriminated on `dimension`. */
export type DirectorGradeCandidate =
  | { dimension: "auto-approval"; approval_decision_id: string; director_function: string }
  | { dimension: "goal-escort"; goal_slug: string; milestone: string; director_function: string; goal_title: string; milestone_name: string; spec_slugs: string[] };

/**
 * Pick the batch of ungraded, CONCLUDED director calls for the box-hosted grader (grading-cascade-to-
 * box-sessions Phase 3). Mirrors [[agent-grader]] `pickAgentGradeBatch` for the director layer — the
 * cron calls this, then inserts ONE `director-grade` `agent_jobs` row per batch-ready workspace with
 * `instructions.candidates = […]`. The box lane (`scripts/builder-worker.ts` → `runDirectorGradeJob`)
 * reads each call's REAL approved diff (or the merged member specs of an escorted milestone) and writes
 * `director_decision_grades` via `applyBoxDirectorGrade` (same partial-unique upsert + human-override
 * invariant as the deployed sweep's `upsertGrade`). A no-op (empty array) while nothing is ungraded.
 *
 * Selection: (1) auto-approvals whose target build is at a terminal status (`completed｜merged｜failed｜
 * needs_attention`) and aren't already graded, then (2) concluded escorted milestones for both PLATFORM
 * and GROWTH directors that aren't already graded. Truncated to DIRECTOR_GRADE_BATCH_CAP — the rest
 * ride the next beat. `graded_by='human'` rows never re-appear (the deployed sweep's pagination logic
 * is re-used verbatim: the graded set is a partial-unique key, and applyBoxDirectorGrade also skips
 * a human override).
 */
export async function pickDirectorGradeBatch(opts: {
  workspaceId: string;
  admin?: Admin;
  cap?: number;
}): Promise<DirectorGradeCandidate[]> {
  const admin = opts.admin ?? createAdminClient();
  const cap = opts.cap ?? DIRECTOR_GRADE_BATCH_CAP;
  const out: DirectorGradeCandidate[] = [];

  try {
    // Already-graded set — paginated past the 1000-row PostgREST cap (same trap the sweep hit, round
    // 2 of fix-starved-grading). Skipping this would false-resurface settled grades and re-spend a box
    // session.
    const gradedApprovals = new Set<string>();
    const gradedEscorts = new Set<string>();
    // Phase 7/Fix-2 (check 74b737bdbda6fa8d): destructive-action approvals carry a
    // `deterministic-raise-marker` placeholder row written by [[migration-safety]]
    // `writeDestructiveActionDecisionGrade`. It is a MARKER, not a real grade — the box
    // sweep still needs to re-grade it. Track those approval_decision_ids so we can
    // re-surface them as candidates (below) even though a row already exists in
    // director_decision_grades. Also carries the recorded director_function so the
    // candidate routes to the raising director (Ada / Platform) rather than the CEO
    // fallback the routed_to_function='ceo' decision alone would imply.
    const markerCandidates = new Map<string, string>();
    for (let from = 0; ; from += 1000) {
      const { data: gradeRows } = await admin
        .from("director_decision_grades")
        .select("dimension, approval_decision_id, goal_slug, milestone, model, director_function")
        .eq("workspace_id", opts.workspaceId)
        .range(from, from + 999);
      const rows = (gradeRows as Array<{ dimension: string; approval_decision_id: string | null; goal_slug: string | null; milestone: string | null; model: string | null; director_function: string | null }>) || [];
      for (const r of rows) {
        if (r.dimension === "auto-approval" && r.approval_decision_id) {
          if (r.model === "deterministic-raise-marker") {
            // A marker row is UNGRADED — still owes a real box-sweep grade. Keep it OUT
            // of the graded set so the destructive approval remains a candidate.
            markerCandidates.set(r.approval_decision_id, r.director_function || PLATFORM);
          } else {
            gradedApprovals.add(r.approval_decision_id);
          }
        } else if (r.dimension === "goal-escort" && r.goal_slug) gradedEscorts.add(`${r.goal_slug}:${r.milestone ?? ""}`);
      }
      if (rows.length < 1000) break;
    }

    // ── destructive-action (marker-anchored) candidates ─────────────────────────────────────────
    // Phase 7/Fix-2: destructive-action approvals are decided_by='ceo' (the human decided the
    // out-of-leash raise), which the director-decided query below intentionally excludes.
    // Surface them here via the marker row so the box director-grade sweep grades the RAISE
    // even though the CEO — not Ada — decided the specific approval. Still terminal-gated by
    // the target agent_job's status.
    if (markerCandidates.size) {
      const markerIds = Array.from(markerCandidates.keys());
      const { data: mDecs } = await admin
        .from("approval_decisions")
        .select("id, agent_job_id")
        .in("id", markerIds);
      const mDecRows = (mDecs as Array<{ id: string; agent_job_id: string | null }>) || [];
      const mJobIds = Array.from(new Set(mDecRows.map((d) => d.agent_job_id).filter((x): x is string => !!x)));
      const mTerminal = new Set<string>();
      if (mJobIds.length) {
        const { data: mJobRows } = await admin
          .from("agent_jobs")
          .select("id, status")
          .in("id", mJobIds);
        for (const j of ((mJobRows as Array<{ id: string; status: string }>) || [])) {
          if (TERMINAL_JOB_STATUSES.has(j.status)) mTerminal.add(j.id);
        }
      }
      for (const d of mDecRows) {
        if (out.length >= cap) break;
        // Same terminal-gate as the director-decided path: a marker-anchored approval whose
        // target build is still in-flight defers to the next beat.
        if (d.agent_job_id && !mTerminal.has(d.agent_job_id)) continue;
        out.push({
          dimension: "auto-approval",
          approval_decision_id: d.id,
          director_function: markerCandidates.get(d.id) || PLATFORM,
        });
      }
    }

    // ── auto-approval candidates (director-decided, autonomous) ─────────────────────────────────
    const { data: decisions } = await admin
      .from("approval_decisions")
      .select("id, agent_job_id, routed_to_function")
      .eq("workspace_id", opts.workspaceId)
      .eq("decided_by", "director")
      .eq("decision", "approved")
      .eq("autonomous", true)
      .order("created_at", { ascending: false })
      .limit(500);

    const ungradedDecisions = ((decisions as Array<{ id: string; agent_job_id: string | null; routed_to_function: string | null }>) || []).filter(
      (d) => !gradedApprovals.has(d.id) && !markerCandidates.has(d.id),
    );

    if (ungradedDecisions.length) {
      // Pre-filter to CONCLUDED targets in one batched read — the sweep's per-row lookup is fine at
      // its scale but here we want a compact skip so the batch isn't dominated by in-flight targets.
      const targetIds = Array.from(new Set(ungradedDecisions.map((d) => d.agent_job_id).filter((x): x is string => !!x)));
      const terminalTargets = new Set<string>();
      if (targetIds.length) {
        const { data: jobRows } = await admin
          .from("agent_jobs")
          .select("id, status")
          .in("id", targetIds);
        for (const j of ((jobRows as Array<{ id: string; status: string }>) || [])) {
          if (TERMINAL_JOB_STATUSES.has(j.status)) terminalTargets.add(j.id);
        }
      }

      for (const d of ungradedDecisions) {
        if (out.length >= cap) break;
        // A director approval with NO target job is a rare shape (a bare policy call); allow it —
        // it's terminal by definition (nothing to wait on). Otherwise gate on target-terminal.
        if (d.agent_job_id && !terminalTargets.has(d.agent_job_id)) continue;
        out.push({
          dimension: "auto-approval",
          approval_decision_id: d.id,
          director_function: d.routed_to_function || PLATFORM,
        });
      }
    }

    // ── goal-escort candidates ───────────────────────────────────────────────────────────────────
    for (const fn of [PLATFORM, GROWTH]) {
      if (out.length >= cap) break;
      for (const ctx of await concludedEscortedMilestones(admin, opts.workspaceId, fn)) {
        if (out.length >= cap) break;
        if (gradedEscorts.has(`${ctx.goalSlug}:${ctx.milestoneId}`)) continue;
        out.push({
          dimension: "goal-escort",
          goal_slug: ctx.goalSlug,
          milestone: ctx.milestoneId,
          director_function: ctx.directorFunction,
          goal_title: ctx.goalTitle,
          milestone_name: ctx.milestoneName,
          spec_slugs: ctx.specs.map((s) => s.slug),
        });
      }
    }
  } catch (e) {
    console.warn(`[director-grader] pickDirectorGradeBatch failed ws=${opts.workspaceId}: ${errText(e)}`);
  }
  return out;
}
