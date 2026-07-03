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

export type GradeDimension = "auto-approval" | "goal-escort";

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
      : `You are grading ONE GOAL-ESCORT: the director escorted an ALREADY-APPROVED goal's milestone to landing — sequencing its unblocked specs through the build → merge → fold chain. The question is whether the milestone LANDED CLEAN under the director's escort.

THE DEFINING RULE — GRADE SOUNDNESS SEPARATELY FROM OUTCOME:
  • soundness (1-10): did the director escort RESPONSIBLY — only sequencing unblocked, in-sequence specs of a goal the CEO already greenlit (never starting a new goal, never jumping a blocker), and surfacing/escalating rather than forcing anything outside the leash?
  • outcome (1-10): did the milestone LAND CLEAN — every linked spec shipped (merged, tsc/CI green), with no regression escalated against those specs afterward? A milestone that shipped fully and stayed green scores HIGH; one with a stranded/failed spec or a regression escalation scores lower.
  • grade (1-10): the overall escort grade. Weight SOUNDNESS at least as heavily as outcome — a responsibly-sequenced escort that hit an unavoidable external snag is not a bad call.`;

  return `You are the CEO of ShopCX grading the calls of your Platform/DevOps Director — an autonomous director you supervise (the CEO → Director → tool chain, operational-rules § supervisable autonomy). The director auto-approves low-risk platform requests within a leash and escorts already-approved goals to landing; you grade whether each of its calls was the RIGHT one, 1–10.

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

/**
 * The single per-call entrypoint the spec names — gradeDirectorCall(decision, dimension). Dispatches to
 * the dimension-specific grader. For 'auto-approval' pass `approvalDecisionId`; for 'goal-escort' pass a
 * resolved MilestoneContext. (The sweep below builds these; this is the unit the verification probes.)
 */
export async function gradeDirectorCall(opts: {
  dimension: GradeDimension;
  workspaceId: string;
  approvalDecisionId?: string;
  context?: MilestoneContext;
  admin?: Admin;
}): Promise<DirectorGradeResult> {
  if (opts.dimension === "auto-approval") {
    if (!opts.approvalDecisionId) return { ok: false, reason: "missing_approval_decision_id" };
    return gradeAutoApproval({ approvalDecisionId: opts.approvalDecisionId, admin: opts.admin });
  }
  if (!opts.context) return { ok: false, reason: "missing_milestone_context" };
  return gradeGoalEscort({ context: opts.context, workspaceId: opts.workspaceId, admin: opts.admin });
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
    console.warn(`[director-grader] escort-candidate resolve failed ws=${workspaceId} fn=${directorFunction}: ${e instanceof Error ? e.message : String(e)}`);
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
    console.warn(`[director-grader] sweep failed ws=${opts.workspaceId}: ${e instanceof Error ? e.message : String(e)}`);
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
    console.warn(`[director-grader] pickDirectorGradeBatch failed ws=${opts.workspaceId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}
