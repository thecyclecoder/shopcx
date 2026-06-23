/**
 * Worker-action grader — the DevOps Director's supervisory feedback signal over its workers
 * (worker-grading-and-director-management spec, P1). One level DOWN the org chart from the director
 * grader (src/lib/agents/director-grader.ts): there the CEO grades the Platform/DevOps DIRECTOR's own
 * CALLS; here the Director (Ada) grades each WORKER's concluded actions — 1–10 + reasoning — and a
 * slipping standing rollup triggers a coachWorker pass (the CEO → Director → Worker cascade).
 *
 * The gradeable unit is ONE concluded agent_jobs row — the worker's atomic action: a build merged, an
 * error fixed/dismissed, an index proposed, a spec verified. Grading is idempotent per job (the UNIQUE
 * on worker_action_grades.agent_job_id), human-overridable (graded_by='human' is never re-written by the
 * agent), and BATCHED — gradeConcludedWorkerActions grades the whole accumulated batch in one box
 * session (P2 cadence), not one session per job, to keep box cost bounded.
 *
 * The defining invariant (inherited from the director grader): CRAFT is scored SEPARATELY from OUTCOME.
 * A worker whose disposition was right but hit a rare external bump still grades well; one that got a
 * clean outcome by luck while skipping the work grades low. The grader is a SUPERVISED TOOL
 * (operational-rules § North star): it scores a bounded proxy (action quality); the Director owns the
 * objective and overrides it, and only APPROVED worker_grader_prompts rules (the CEO-calibrated rubric)
 * reach the grader's prompt.
 *
 *   • gradeConcludedWorkerActions — the batched grading sweep (every concluded, ungraded job).
 *   • computeWorkerRollup        — a worker's standing score: the last-10 average + the prior-10 trend.
 *   • detectGradeDropCoaching    — rollup < 7 OR a >1.5 drop → coachWorker (escalate to the CEO after N).
 *
 * See docs/brain/tables/worker_action_grades.md · docs/brain/libraries/worker-grader.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { logAiUsage, usageCostCents } from "@/lib/ai-usage";
import { SONNET_MODEL } from "@/lib/ai-models";
import { getPersona } from "@/lib/agents/personas";
import { coachWorker, linkCoachingBoardPost } from "@/lib/agents/worker-instructions";
import { postDirectorMessage } from "@/lib/agents/director-board";
import { recordDirectorActivity } from "@/lib/director-activity";
import { COACHING_DIRECTOR_FUNCTION, COACHING_ATTEMPTS_BEFORE_ESCALATE } from "@/lib/agents/worker-coaching";

type Admin = ReturnType<typeof createAdminClient>;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GRADER_MODEL = SONNET_MODEL;

/** agent_jobs statuses that mean a worker's action CONCLUDED — only then is it gradeable. */
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "needs_attention"]);
/** Cap on how many ungraded jobs one batched grading session scores (keeps box cost bounded). */
const GRADING_BATCH_CAP = 60;

/** The standing-performance window: the last N graded jobs per worker → the rollup score. */
export const ROLLUP_WINDOW = 10;
/** Rollup below this fires a coaching pass. */
export const LOW_ROLLUP_THRESHOLD = 7;
/** A rollup drop bigger than this (vs the prior window) fires a coaching pass. */
export const GRADE_DROP_THRESHOLD = 1.5;
/** Don't coach on a thin window — need at least this many grades before a rollup is trustworthy. */
export const MIN_GRADES_FOR_COACHING = 5;
/** The supersede/dedup error class a grade-rollup coaching writes (so the escalate-after-N guard works). */
export const GRADE_ROLLUP_CLASS = "grade-rollup-slip";

export interface WorkerGradeResult {
  ok: boolean;
  reason?: string;
  grade_id?: string;
  grade?: number;
  idempotent_update?: boolean;
}

interface GraderJson {
  grade: number;
  reasoning: string;
}

interface JobRow {
  id: string;
  workspace_id: string;
  kind: string;
  spec_slug: string | null;
  status: string;
  error: string | null;
  log_tail: string | null;
  pr_url: string | null;
  pr_number: number | null;
  instructions: string | null;
  pending_actions: Array<{ id?: string; type?: string; summary?: string; cmd?: string; status?: string }> | null;
  created_at: string;
}

interface ExistingGradeRow {
  id: string;
  grade: number | null;
  graded_by: string;
}

// ── Per-worker rubrics (the spec's "what good = 10 means" table; calibratable via worker_grader_prompts) ──
const RUBRICS: Record<string, string> = {
  build:
    "spec phases satisfied · tsc clean · PR merged clean (no conflict markers) · no rebuild churn.",
  repair:
    "real root-cause (not symptom) · the fix held (the error didn't recur) · correctly dismissed noise · scoped.",
  regression:
    "caught a real regression · correctly dismissed flaky ones · the authored fix spec is sound.",
  db_health:
    "correct EXPLAIN diagnosis · the index/fix actually addresses the slow query · no foreign/sunset false-positives.",
  "spec-test":
    "caught real drift / false-✅ · no false alarms · verification matched live prod.",
  "migration-fix":
    "migration applied/repaired correctly · audit cleared · no data loss.",
  "pr-resolve":
    "conflicts resolved without lost work · clean rebase · queue left mergeable.",
  fold:
    "folded into the right brain pages · cross-links correct · archived cleanly.",
  "coverage-register":
    "correct registry entry / exemption · no real coverage gap missed.",
  monitor:
    "accurate alerts (signal not noise) · caught real stalls.",
  plan:
    "sound decomposition · correct blocked_by · no orphan specs.",
  "product-seed":
    "product correctly seeded · page built · orderable.",
  "spec-chat":
    "accurate, grounded answers · correct spec edits · read-only honored.",
  "dev-ask":
    "accurate, grounded answers · correct spec edits · read-only honored.",
};

function clampGrade(n: number): number {
  return Math.max(1, Math.min(10, Math.round(n)));
}

// ── Grader plumbing (mirror director-grader) ──────────────────────────────────────────────────────

/**
 * Build the worker-grader system prompt: the generic frame + the per-worker rubric (the spec's table)
 * + any APPROVED worker_grader_prompts calibration rules (CEO-approved corrections), where a rule with
 * worker_kind=null is global and one with a matching worker_kind is worker-specific. Mirrors
 * buildDirectorGraderSystemPrompt.
 */
export async function buildWorkerGraderSystemPrompt(admin: Admin, workspaceId: string, workerKind: string): Promise<string> {
  const { data: rules } = await admin
    .from("worker_grader_prompts")
    .select("title, content, worker_kind")
    .eq("workspace_id", workspaceId)
    .eq("status", "approved")
    .or(`worker_kind.is.null,worker_kind.eq.${workerKind}`)
    .order("sort_order", { ascending: true });

  const rulesBlock = (rules || []).length
    ? "\n\nCALIBRATION RULES (apply these — they are CEO-approved adjustments to the rubric):\n\n" +
      (rules || []).map((r) => `• ${r.title}\n  ${r.content}`).join("\n\n")
    : "";

  const persona = getPersona(workerKind);
  const rubric = RUBRICS[workerKind] || "the action was correct, scoped, and held up.";

  return `You are the Platform/DevOps Director of ShopCX grading ONE concluded action by your worker ${persona.name} (the '${workerKind}' worker — ${persona.role}). The worker autonomously did one job; you grade whether it was done WELL, 1–10. You supervise this worker (the CEO → Director → Worker chain, operational-rules § supervisable autonomy) — your grades train it and trigger coaching when its standing performance slips.

WHAT "10" MEANS FOR THIS WORKER (the rubric):
  ${rubric}

THE DEFINING RULE — GRADE CRAFT SEPARATELY FROM OUTCOME:
  • craft: was the WORK sound — the right root-cause / decision / scope, the rubric actually satisfied, nothing skipped or rubber-stamped? Good craft that hit a rare, external bump still grades HIGH.
  • outcome: did the action HOLD UP — the build merged clean and didn't re-fail, the dismissal stuck, the fix didn't recur, the verification matched prod? A clean outcome reached by LUCK while skipping the work grades LOW.
  • grade (1–10): the overall action grade. Weight CRAFT at least as heavily as outcome — we are training a worker to do SOUND WORK, not to get lucky. A job that ended 'failed' or 'needs_attention' is usually a poor outcome, but judge whether the worker's craft was nonetheless sound (e.g. it correctly surfaced a genuinely human-needed problem).

SCORING (1-10): 10 — exemplary. 8-9 — strong. 6-7 — acceptable. 4-5 — mediocre. 2-3 — poor. 1 — indefensible.${rulesBlock}

OUTPUT (JSON only, no prose around it):
{
  "grade": <integer 1-10>,
  "reasoning": "<2-4 sentences: the craft (was the work sound) and the outcome (did it hold up), kept distinct>"
}`;
}

/** Call the LLM grader and parse the strict JSON. Mirror director-grader.runGrader. */
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
  await logAiUsage({ workspaceId, model: GRADER_MODEL, usage, purpose: "worker_action_grading" });

  let parsed: GraderJson | null = null;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]) as GraderJson;
  } catch {
    /* fall through */
  }
  const valid = parsed && typeof parsed.grade === "number" && parsed.grade >= 1 && parsed.grade <= 10;
  if (!valid) return { error: "parse_failed" };
  return { json: parsed as GraderJson, costCents, usage };
}

/** Compact, gradeable description of one concluded worker action. */
function formatJobForGrading(job: JobRow, repeatFailures: number): string {
  const approvedAction = (job.pending_actions || []).find((a) => a.status === "approved" || a.status === "done") || (job.pending_actions || [])[0] || {};
  return [
    `WORKER ACTION — agent_job ${job.id} · worker=${job.kind}`,
    `  spec/target: ${job.spec_slug ?? "—"}`,
    job.instructions ? `  instructions: ${String(job.instructions).slice(0, 400)}` : "",
    approvedAction.type ? `  gated action: type=${approvedAction.type} · ${approvedAction.summary ?? "(no summary)"}${approvedAction.cmd ? ` · cmd=${approvedAction.cmd}` : ""}` : "",
    ``,
    `  HOW IT CONCLUDED:`,
    `  terminal status: ${job.status}`,
    job.pr_url ? `  PR: ${job.pr_url}${job.pr_number ? ` (#${job.pr_number})` : ""}` : "",
    job.error ? `  error: ${job.error.slice(0, 400)}` : "",
    `  later repeat-failures of the same spec after this job: ${repeatFailures}`,
    job.log_tail ? `  log tail:\n${job.log_tail.slice(-1400)}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Count later failed/needs_attention jobs of the same spec after this one — the "did it hold up" signal. */
async function countRepeatFailures(admin: Admin, job: JobRow): Promise<number> {
  if (!job.spec_slug) return 0;
  try {
    const { data } = await admin
      .from("agent_jobs")
      .select("id")
      .eq("workspace_id", job.workspace_id)
      .eq("spec_slug", job.spec_slug)
      .in("status", ["failed", "needs_attention"])
      .gt("created_at", job.created_at)
      .neq("id", job.id)
      .limit(50);
    return (data as Array<{ id: string }> | null)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Persist one agent grade — UPDATE in place if a row exists, else INSERT. Never clobbers a human grade. */
async function upsertGrade(
  admin: Admin,
  existing: ExistingGradeRow | null,
  job: JobRow,
  graded: { json: GraderJson; costCents: number; usage: unknown },
): Promise<WorkerGradeResult> {
  if (existing && existing.graded_by === "human") {
    return { ok: true, grade_id: existing.id, grade: existing.grade ?? undefined, idempotent_update: true };
  }
  const grade = clampGrade(graded.json.grade);
  const now = new Date().toISOString();
  const usage = graded.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  const payload = {
    workspace_id: job.workspace_id,
    worker_kind: job.kind,
    agent_job_id: job.id,
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
    await admin.from("worker_action_grades").update(payload).eq("id", existing.id);
    return { ok: true, grade_id: existing.id, grade, idempotent_update: true };
  }
  const { data: ins, error } = await admin.from("worker_action_grades").insert(payload).select("id").single();
  if (error) return { ok: false, reason: error.message };
  return { ok: true, grade_id: ins?.id, grade };
}

/** Grade ONE concluded worker action (an agent_jobs row). Concluded-only + idempotent + human-safe. */
export async function gradeWorkerAction(opts: { agentJobId: string; admin?: Admin }): Promise<WorkerGradeResult> {
  if (!ANTHROPIC_API_KEY) return { ok: false, reason: "no_api_key" };
  const admin = opts.admin ?? createAdminClient();

  const { data } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, kind, spec_slug, status, error, log_tail, pr_url, pr_number, instructions, pending_actions, created_at")
    .eq("id", opts.agentJobId)
    .maybeSingle();
  if (!data) return { ok: false, reason: "job_not_found" };
  const job = data as JobRow;
  // Not gradeable until the worker's action has actually concluded (did the work hold up?).
  if (!TERMINAL_JOB_STATUSES.has(job.status)) return { ok: false, reason: "not_concluded" };

  const { data: existing } = await admin
    .from("worker_action_grades")
    .select("id, grade, graded_by")
    .eq("agent_job_id", job.id)
    .maybeSingle();
  const existingRow = (existing as ExistingGradeRow) ?? null;
  if (existingRow && existingRow.graded_by === "human") {
    return { ok: true, grade_id: existingRow.id, grade: existingRow.grade ?? undefined, idempotent_update: true };
  }

  const repeatFailures = await countRepeatFailures(admin, job);
  const system = await buildWorkerGraderSystemPrompt(admin, job.workspace_id, job.kind);
  const userMsg = `Grade this worker action. Return the JSON only.\n\n${formatJobForGrading(job, repeatFailures)}`;

  const graded = await runGrader(system, userMsg, job.workspace_id);
  if ("error" in graded) return { ok: false, reason: graded.error };
  return upsertGrade(admin, existingRow, job, graded);
}

/**
 * The BATCHED grading sweep (fired on the P2 cadence — ≥5 ungraded concluded jobs OR a ~3h fallback):
 * grade every concluded, ungraded worker action in ONE session (not one session per job — keeps box cost
 * bounded). Best-effort + idempotent (an already-graded job is skipped; gradeWorkerAction upserts in
 * place if re-run). A no-op while there is nothing to grade.
 */
export async function gradeConcludedWorkerActions(opts: { workspaceId: string; admin?: Admin; limit?: number }): Promise<{ considered: number; graded: number }> {
  const admin = opts.admin ?? createAdminClient();
  let considered = 0;
  let graded = 0;
  if (!ANTHROPIC_API_KEY) return { considered, graded };

  try {
    // Already-graded job ids → skip (don't re-spend the LLM on a settled grade).
    const { data: gradeRows } = await admin
      .from("worker_action_grades")
      .select("agent_job_id")
      .eq("workspace_id", opts.workspaceId)
      .limit(20000);
    const gradedJobs = new Set<string>();
    for (const r of (gradeRows as Array<{ agent_job_id: string }>) || []) gradedJobs.add(r.agent_job_id);

    // Every concluded worker action, newest-first, capped per session.
    const { data: jobs } = await admin
      .from("agent_jobs")
      .select("id, status")
      .eq("workspace_id", opts.workspaceId)
      .in("status", Array.from(TERMINAL_JOB_STATUSES))
      .order("created_at", { ascending: false })
      .limit(500);
    const cap = opts.limit ?? GRADING_BATCH_CAP;
    for (const j of (jobs as Array<{ id: string }>) || []) {
      if (gradedJobs.has(j.id)) continue;
      if (graded >= cap) break;
      considered++;
      const r = await gradeWorkerAction({ agentJobId: j.id, admin });
      if (r.ok && !r.idempotent_update) graded++;
    }
  } catch (e) {
    console.warn(`[worker-grader] sweep failed ws=${opts.workspaceId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { considered, graded };
}

// ── Rollup (the standing performance score) ─────────────────────────────────────────────────────────

export interface WorkerRollup {
  workerKind: string;
  /** mean of the last ROLLUP_WINDOW graded jobs (the standing score). */
  average: number | null;
  /** mean of the PRIOR ROLLUP_WINDOW (the window before this one), null if too few grades. */
  priorAverage: number | null;
  /** priorAverage − average: a POSITIVE number is a DROP (performance fell). */
  drop: number;
  count: number;
  priorCount: number;
  trend: "up" | "flat" | "down" | "unknown";
  /** the worst recent grade's reasoning — the concrete signal for coaching guidance. */
  worstRecentReasoning: string | null;
  /** the lowest grade in the current window. */
  worstRecentGrade: number | null;
}

function mean(ns: number[]): number | null {
  if (!ns.length) return null;
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

/**
 * A worker's standing performance: the last-ROLLUP_WINDOW average + the prior-window trend. Reads the
 * most recent 2×ROLLUP_WINDOW graded jobs (grade not null) for the worker, newest-first.
 */
export async function computeWorkerRollup(opts: { workspaceId: string; workerKind: string; admin?: Admin }): Promise<WorkerRollup> {
  const admin = opts.admin ?? createAdminClient();
  const empty: WorkerRollup = {
    workerKind: opts.workerKind,
    average: null,
    priorAverage: null,
    drop: 0,
    count: 0,
    priorCount: 0,
    trend: "unknown",
    worstRecentReasoning: null,
    worstRecentGrade: null,
  };
  const { data } = await admin
    .from("worker_action_grades")
    .select("grade, reasoning, created_at")
    .eq("workspace_id", opts.workspaceId)
    .eq("worker_kind", opts.workerKind)
    .not("grade", "is", null)
    .order("created_at", { ascending: false })
    .limit(ROLLUP_WINDOW * 2);
  const rows = ((data as Array<{ grade: number; reasoning: string | null }>) || []).filter((r) => typeof r.grade === "number");
  if (!rows.length) return empty;

  const last = rows.slice(0, ROLLUP_WINDOW);
  const prior = rows.slice(ROLLUP_WINDOW, ROLLUP_WINDOW * 2);
  const average = mean(last.map((r) => r.grade));
  const priorAverage = mean(prior.map((r) => r.grade));
  const drop = average != null && priorAverage != null ? priorAverage - average : 0;
  const trend: WorkerRollup["trend"] =
    priorAverage == null ? "unknown" : drop > 0.5 ? "down" : drop < -0.5 ? "up" : "flat";
  // The worst job in the current window — the concrete thing coaching points at.
  const worst = last.reduce<{ grade: number; reasoning: string | null } | null>((acc, r) => (!acc || r.grade < acc.grade ? r : acc), null);

  return {
    workerKind: opts.workerKind,
    average,
    priorAverage,
    drop,
    count: last.length,
    priorCount: prior.length,
    trend,
    worstRecentReasoning: worst?.reasoning ?? null,
    worstRecentGrade: worst?.grade ?? null,
  };
}

/** Every worker kind that has at least one grade in this workspace. */
async function workerKindsWithGrades(admin: Admin, workspaceId: string): Promise<string[]> {
  const { data } = await admin
    .from("worker_action_grades")
    .select("worker_kind")
    .eq("workspace_id", workspaceId)
    .limit(20000);
  const kinds = new Set<string>();
  for (const r of (data as Array<{ worker_kind: string }>) || []) if (r.worker_kind) kinds.add(r.worker_kind);
  return Array.from(kinds);
}

// ── Grade-drop coaching ─────────────────────────────────────────────────────────────────────────────

export interface GradeDropOutcome {
  workerKind: string;
  trigger: "low-rollup" | "grade-drop";
  rollup: WorkerRollup;
  action: "coached" | "escalated" | "skipped";
  detail: string;
  coachingId?: string;
  instructionId?: string;
}

export interface GradeDropResult {
  applied: boolean;
  considered: number;
  outcomes: GradeDropOutcome[];
}

/** One human-readable board line: "🛠️ Ada coached 🟠 Bo: <message>". Mirror worker-coaching.boardLine. */
function boardLine(directorFn: string, workerKind: string, verb: string, message: string): string {
  const dp = getPersona(directorFn);
  const wp = getPersona(workerKind);
  return `${dp.emoji} ${dp.name} ${verb} ${wp.emoji} ${wp.name}: ${message}`;
}

/** How many grade-rollup coaching messages a worker has received (drives the escalate-after-N guard). */
async function countRollupCoachings(admin: Admin, workspaceId: string, workerKind: string): Promise<number> {
  const { count } = await admin
    .from("worker_coaching_log")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("worker_kind", workerKind)
    .eq("error_class", GRADE_ROLLUP_CLASS)
    .eq("kind", "coaching");
  return count ?? 0;
}

/**
 * Detect each worker whose standing rollup has SLIPPED — average < LOW_ROLLUP_THRESHOLD (7) OR a drop of
 * more than GRADE_DROP_THRESHOLD (1.5) vs the prior window — and coach it: amend its instructions
 * (coachWorker, supersede/dedup on GRADE_ROLLUP_CLASS), post the #directors board line, record a
 * director_activity row. A worker already coached on this class ≥ COACHING_ATTEMPTS_BEFORE_ESCALATE
 * times and still slipping ESCALATES to the CEO instead (the existing loop-guard — never infinite
 * re-coaching). Skips a worker with too thin a window (< MIN_GRADES_FOR_COACHING).
 *
 * dry-run by default — pass `apply:true` to write. Returns a structured plan/result either way.
 */
export async function detectGradeDropCoaching(opts: {
  workspaceId: string;
  admin?: Admin;
  apply?: boolean;
  directorFunction?: string;
}): Promise<GradeDropResult> {
  const admin = opts.admin ?? createAdminClient();
  const apply = opts.apply === true;
  const directorFn = opts.directorFunction ?? COACHING_DIRECTOR_FUNCTION;
  const outcomes: GradeDropOutcome[] = [];
  let considered = 0;

  const kinds = await workerKindsWithGrades(admin, opts.workspaceId);
  for (const workerKind of kinds) {
    const rollup = await computeWorkerRollup({ workspaceId: opts.workspaceId, workerKind, admin });
    if (rollup.average == null || rollup.count < MIN_GRADES_FOR_COACHING) continue; // thin window — don't coach
    const low = rollup.average < LOW_ROLLUP_THRESHOLD;
    const dropped = rollup.priorAverage != null && rollup.drop > GRADE_DROP_THRESHOLD;
    if (!low && !dropped) continue;
    considered++;
    const trigger: GradeDropOutcome["trigger"] = dropped ? "grade-drop" : "low-rollup";

    // Already coached on this class N times and still slipping → escalate to the CEO (loop-guard).
    const priorAttempts = await countRollupCoachings(admin, opts.workspaceId, workerKind);
    if (priorAttempts >= COACHING_ATTEMPTS_BEFORE_ESCALATE) {
      const line = boardLine(
        directorFn,
        workerKind,
        "escalated to the CEO about",
        `rollup is ${rollup.average?.toFixed(1)}/10 after ${priorAttempts} coaching attempts — coaching isn't lifting it; needs a deeper look.`,
      );
      if (apply) {
        await recordDirectorActivity(admin, {
          workspaceId: opts.workspaceId,
          directorFunction: directorFn,
          actionKind: "escalated_grade_drop",
          specSlug: null,
          reason: line,
          metadata: { worker_kind: workerKind, error_class: GRADE_ROLLUP_CLASS, rollup_average: rollup.average, attempts: priorAttempts },
        });
        await postDirectorMessage({ workspaceId: opts.workspaceId, author: "director", authorFunction: directorFn, body: line, kind: "update", mentions: ["ceo"], metadata: { worker_kind: workerKind, error_class: GRADE_ROLLUP_CLASS, kind: "escalation" } });
      }
      outcomes.push({ workerKind, trigger, rollup, action: "escalated", detail: line });
      continue;
    }

    // Coach: compose the guidance from the rollup numbers + the worst recent grade's reasoning.
    const triggeringPattern = dropped
      ? `Your last-${rollup.count} grade average fell to ${rollup.average?.toFixed(1)}/10 (down ${rollup.drop.toFixed(1)} from ${rollup.priorAverage?.toFixed(1)}).`
      : `Your last-${rollup.count} grade average is ${rollup.average?.toFixed(1)}/10 — below the ${LOW_ROLLUP_THRESHOLD}/10 bar.`;
    const reasoning = rollup.worstRecentReasoning
      ? `your standing grade slipped; the worst recent action (graded ${rollup.worstRecentGrade}/10) was: ${rollup.worstRecentReasoning.slice(0, 400)}`
      : `your standing grade slipped below the bar — recent actions are not meeting the rubric`;
    const rubric = RUBRICS[workerKind] || "the action was correct, scoped, and held up";
    const guidance = `Your recent work is grading low. Before concluding each job, re-check it against your rubric (${rubric}). Slow down on the step the worst grades flagged rather than rushing to a terminal status.`;
    const line = boardLine(directorFn, workerKind, "coached", `${triggeringPattern} ${guidance}`);

    if (apply) {
      const res = await coachWorker(admin, {
        workspaceId: opts.workspaceId,
        workerKind,
        coachedBy: directorFn,
        errorClass: GRADE_ROLLUP_CLASS,
        guidance,
        triggeringPattern,
        reasoning,
        sourceActivityIds: [],
        sourceGradeId: null,
      });
      const post = await postDirectorMessage({ workspaceId: opts.workspaceId, author: "director", authorFunction: directorFn, body: line, kind: "update", mentions: [workerKind], metadata: { worker_kind: workerKind, error_class: GRADE_ROLLUP_CLASS, coaching_id: res.coaching.id, kind: "coaching" } });
      await linkCoachingBoardPost(admin, res.coaching.id, post.id);
      await recordDirectorActivity(admin, {
        workspaceId: opts.workspaceId,
        directorFunction: directorFn,
        actionKind: "coached_grade_drop",
        specSlug: null,
        reason: line,
        metadata: { worker_kind: workerKind, error_class: GRADE_ROLLUP_CLASS, rollup_average: rollup.average, drop: rollup.drop, attempt: res.attempt, instruction_id: res.instruction.id },
      });
      outcomes.push({ workerKind, trigger, rollup, action: "coached", detail: line, coachingId: res.coaching.id, instructionId: res.instruction.id });
    } else {
      outcomes.push({ workerKind, trigger, rollup, action: "coached", detail: `[dry-run] ${line}` });
    }
  }

  return { applied: apply, considered, outcomes };
}
