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
import { getGoals } from "@/lib/brain-roadmap";

type Admin = ReturnType<typeof createAdminClient>;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GRADER_MODEL = SONNET_MODEL;

/** agent_jobs statuses that mean a build CONCLUDED — only then is an auto-approval gradeable. */
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "needs_attention"]);

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
  key: { dimension: GradeDimension; workspaceId: string; approvalDecisionId?: string | null; goalSlug?: string | null; milestone?: string | null },
  graded: { json: GraderJson; costCents: number; usage: unknown },
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
    dimension: key.dimension,
    approval_decision_id: key.approvalDecisionId ?? null,
    goal_slug: key.goalSlug ?? null,
    milestone: key.milestone ?? null,
    grade,
    reasoning: graded.json.reasoning,
    graded_by: "agent" as const,
    model: GRADER_MODEL,
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

// ── auto-approval dimension ───────────────────────────────────────────────────────────────────────

/** Compact, gradeable description of one auto-approval: the director's reasoning + how the build landed. */
function formatAutoApprovalForGrading(decision: ApprovalDecisionRow, job: TargetJobRow | null, repeatFailures: number): string {
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
  ]
    .filter((l) => l !== "")
    .join("\n");
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
  const system = await buildDirectorGraderSystemPrompt(admin, decision.workspace_id, "auto-approval");
  const userMsg = `Grade this auto-approval call. Return the JSON only.\n\n${formatAutoApprovalForGrading(decision, job, repeatFailures)}`;

  const graded = await runGrader(system, userMsg, decision.workspace_id);
  if ("error" in graded) return { ok: false, reason: graded.error };
  return upsertGrade(admin, existingRow, { dimension: "auto-approval", workspaceId: decision.workspace_id, approvalDecisionId: decision.id }, graded);
}

// ── goal-escort dimension ─────────────────────────────────────────────────────────────────────────

interface MilestoneContext {
  goalSlug: string;
  goalTitle: string;
  milestoneId: string;
  milestoneName: string;
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
    { dimension: "goal-escort", workspaceId: opts.workspaceId, goalSlug: ctx.goalSlug, milestone: ctx.milestoneId },
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

// ── The standing-cadence sweep (fired from platform-director-cron, M1) ───────────────────────────────

/**
 * Resolve the escorted milestones the director OWNS that have CONCLUDED (every spec shipped) and that
 * the director actually escorted (an `escorted_goal` activity row for the goal). Each is one gradeable
 * goal-escort call. Best-effort.
 */
async function concludedEscortedMilestones(admin: Admin, workspaceId: string): Promise<MilestoneContext[]> {
  const out: MilestoneContext[] = [];
  try {
    const goals = (await getGoals()).filter((g) => g.owner === PLATFORM);
    if (!goals.length) return out;

    // Goals the director actually escorted (logged an `escorted_goal` activity row).
    const { data: escortRows } = await admin
      .from("director_activity")
      .select("reason, metadata")
      .eq("workspace_id", workspaceId)
      .eq("director_function", PLATFORM)
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
          specs: m.specSlugs.map((slug) => ({ slug, status: "shipped" })),
          escortReasons: escortByGoal.get(goal.slug) ?? [],
          regressionCount: 0,
        });
      }
    }
  } catch (e) {
    console.warn(`[director-grader] escort-candidate resolve failed ws=${workspaceId}: ${e instanceof Error ? e.message : String(e)}`);
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
  let considered = 0;
  let graded = 0;
  if (!ANTHROPIC_API_KEY) return { considered, graded };

  try {
    // Already-graded keys → skip (don't re-spend the LLM on a settled grade).
    const { data: gradeRows } = await admin
      .from("director_decision_grades")
      .select("dimension, approval_decision_id, goal_slug, milestone")
      .eq("workspace_id", opts.workspaceId)
      .limit(5000);
    const gradedApprovals = new Set<string>();
    const gradedEscorts = new Set<string>();
    for (const r of (gradeRows as Array<{ dimension: string; approval_decision_id: string | null; goal_slug: string | null; milestone: string | null }>) || []) {
      if (r.dimension === "auto-approval" && r.approval_decision_id) gradedApprovals.add(r.approval_decision_id);
      else if (r.dimension === "goal-escort" && r.goal_slug) gradedEscorts.add(`${r.goal_slug}:${r.milestone ?? ""}`);
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
      considered++;
      const r = await gradeAutoApproval({ approvalDecisionId: d.id, admin });
      if (r.ok && !r.idempotent_update) graded++;
    }

    // ── goal-escort — every concluded escorted milestone ────────────────────────────────────────
    for (const ctx of await concludedEscortedMilestones(admin, opts.workspaceId)) {
      if (gradedEscorts.has(`${ctx.goalSlug}:${ctx.milestoneId}`)) continue;
      considered++;
      const r = await gradeGoalEscort({ context: ctx, workspaceId: opts.workspaceId, admin });
      if (r.ok && !r.idempotent_update) graded++;
    }
  } catch (e) {
    console.warn(`[director-grader] sweep failed ws=${opts.workspaceId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { considered, graded };
}
