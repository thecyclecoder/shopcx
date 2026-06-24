/**
 * Worker-action grader — the DevOps Director's supervisory feedback signal, one level DOWN the org
 * chart from director-grader.ts (worker-grading-and-director-management.md, Phase 1; hardens the
 * devops-director goal "the org learns + self-manages"). There the CEO grades the DIRECTOR's calls
 * (director_decision_grades); here the Director (Ada) grades each WORKER's concluded action — 1–10 +
 * reasoning — and a slip in a worker's rollup triggers a coaching pass (coachAgent).
 *
 * The cascade (north star): CEO grades+coaches → Director grades+coaches → Workers. Each layer judges
 * the layer below against an explicit rubric and coaches when the grade slips. This module mirrors
 * director-grader.ts one level down.
 *
 * Gradeable unit: one CONCLUDED agent_jobs row (a build merged, an error fixed/dismissed, an index
 * proposed, a spec verified). The job IS the worker's atomic action, so the polymorphic key the
 * director grader needs collapses to a single FK (agent_job_id) — and one rubric per worker `kind`.
 *
 * The defining invariant (inherited from the director / campaign grader): grade the worker's WORK,
 * not outcome luck — a sound build that hit a rare reversible bump still grades well if the reasoning
 * was right; a careless action that happened to land grades low. The grader is a SUPERVISED TOOL
 * (operational-rules § North star): it scores a bounded proxy (action quality); the Director owns the
 * objective and the CEO overrides it. Every grade is human-overridable and the override is recorded
 * (graded_by='human'/overridden_by), never silently re-written. Only APPROVED agent_grader_prompts
 * rules (the CEO-calibrated per-worker rubric corrections) reach the grader's prompt.
 *
 * Idempotent per concluded job (UNIQUE on agent_job_id): a re-run UPDATEs in place, never duplicates,
 * and never clobbers a human override.
 *
 * Phase 1 builds the STORE + GRADER LIBRARY; the batched box cadence (≥5 ungraded / ~3h) that wires
 * gradeConcludedAgentActions + detectGradeDropCoaching into platform-director-cron + the box runner
 * is Phase 2. The grader reads the job-row context (kind / spec / status / error / log tail / PR) it
 * has at runtime; the Max box session that reads the real diff is the Phase-2 cadence.
 *
 * See docs/brain/tables/agent_action_grades.md · docs/brain/tables/agent_grader_prompts.md ·
 * docs/brain/libraries/agent-grader.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { logAiUsage, usageCostCents } from "@/lib/ai-usage";
import { SONNET_MODEL } from "@/lib/ai-models";
import { PLATFORM, PLATFORM_DIRECTOR_LOOP_GUARD_MAX } from "@/lib/agents/platform-director";
import { coachAgent } from "@/lib/agents/agent-instructions";

type Admin = ReturnType<typeof createAdminClient>;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GRADER_MODEL = SONNET_MODEL;

/** agent_jobs statuses that mean a worker action CONCLUDED — only then is it gradeable. */
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "needs_attention"]);

/** The standing performance window — last N graded jobs per worker (the spec's locked config). */
export const ROLLUP_WINDOW = 10;
/** Batched grading cadence (the spec's locked config): grade when ≥ BATCH_MIN ungraded concluded jobs
 *  have accumulated, OR a BATCH_FALLBACK_MS fallback once any are ungraded — keeps the LLM cost bounded
 *  (one session per batch, not one per job). */
export const BATCH_MIN = 5;
export const BATCH_FALLBACK_MS = 3 * 60 * 60 * 1000;
/**
 * The most jobs ONE grading session will grade — bounds the LLM cost + the session length so a chatty
 * worker (fold / pr-resolve conclude many routine jobs) can't jam a grading run. When more than this are
 * ungraded, the batch PRIORITIZES failures (always graded — a worker mistake to learn from), then fills
 * the rest with a round-robin-by-worker random sample of the successes (so every worker gets spot-checked,
 * not just the noisiest). The un-selected jobs stay ungraded and ride a later beat. */
export const GRADE_BATCH_CAP = 12;
/** agent_jobs statuses that mean the worker action FAILED — always graded (the high-signal mistakes). */
const FAILED_JOB_STATUSES = new Set(["failed", "needs_attention"]);
/** Coaching trigger: rollup below this, OR a drop larger than DROP_THRESHOLD vs the prior window. */
export const COACH_LOW_ROLLUP = 7;
export const DROP_THRESHOLD = 1.5;
/** Don't coach on a single bad grade — require at least this many in the window first. */
const COACH_MIN_SAMPLE = 3;

/**
 * Per-worker rubrics — what "good" (= 10) means for each agent_jobs `kind`, from the spec's locked
 * config table. The grader scores a concluded job against its worker's rubric; a kind absent here is
 * not graded (keeps the Director's own calls + non-worker kinds out of the worker store).
 */
export const AGENT_RUBRICS: Record<string, { name: string; criteria: string }> = {
  build: { name: "Bo", criteria: "spec phases satisfied · `tsc` clean · PR merged clean (no conflict markers) · no rebuild churn" },
  repair: { name: "Rafa", criteria: "real root-cause (not symptom) · fix held (the error didn't recur) · correctly dismissed noise · scoped" },
  regression: { name: "Remi", criteria: "caught a real regression · correctly dismissed flaky ones · the authored fix spec is sound" },
  db_health: { name: "Devi", criteria: "correct EXPLAIN diagnosis · the index/fix actually addresses the slow query · no foreign/sunset false-positives" },
  "spec-test": { name: "Vera", criteria: "caught real drift / false-✅ · no false alarms · verification matched live prod" },
  "migration-fix": { name: "Mira", criteria: "migration applied/repaired correctly · audit cleared · no data loss" },
  "pr-resolve": { name: "Pax", criteria: "conflicts resolved without lost work · clean rebase · queue left mergeable" },
  fold: { name: "Fenn", criteria: "folded into the right brain pages · cross-links correct · archived cleanly" },
  "coverage-register": { name: "Cole", criteria: "correct registry entry / exemption · no real coverage gap missed" },
  monitor: { name: "Tao", criteria: "accurate alerts (signal not noise) · caught real stalls" },
  plan: { name: "Pia", criteria: "sound decomposition · correct `blocked_by` · no orphan specs" },
  "product-seed": { name: "Sol", criteria: "product correctly seeded · page built · orderable" },
  "spec-chat": { name: "Sage", criteria: "accurate, grounded answers · correct spec edits · read-only honored" },
  "dev-ask": { name: "Dex", criteria: "accurate, grounded answers · correct spec edits · read-only honored" },
};

/** The agent_jobs `kind`s the worker grader scores (rubric-backed). */
export const GRADEABLE_KINDS = Object.keys(AGENT_RUBRICS);

export interface AgentGradeResult {
  ok: boolean;
  reason?: string;
  grade_id?: string;
  agent_job_id?: string;
  agent_kind?: string;
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
  pending_actions: Array<{ id?: string; type?: string; summary?: string; cmd?: string; status?: string }> | null;
  created_at: string;
}

interface ExistingGradeRow {
  id: string;
  grade: number | null;
  graded_by: string;
}

// ── Shared grader plumbing (mirror director-grader) ─────────────────────────────────────────────────

/**
 * Build the worker-grader system prompt: the worker's static rubric (for `kind`) + any APPROVED
 * agent_grader_prompts calibration rules that apply to this worker (agent_kind = kind) or to every
 * worker (agent_kind IS NULL). Mirrors buildDirectorGraderSystemPrompt.
 */
export async function buildAgentGraderSystemPrompt(admin: Admin, workspaceId: string, agentKind: string): Promise<string> {
  const { data: rules } = await admin
    .from("agent_grader_prompts")
    .select("title, content, agent_kind")
    .eq("workspace_id", workspaceId)
    .eq("status", "approved")
    .or(`agent_kind.eq.${agentKind},agent_kind.is.null`)
    .order("sort_order", { ascending: true });

  const rulesBlock = (rules || []).length
    ? "\n\nCALIBRATION RULES (apply these — they are CEO-approved adjustments to the rubric):\n\n" +
      (rules || []).map((r) => `• ${r.title}\n  ${r.content}`).join("\n\n")
    : "";

  const rubric = AGENT_RUBRICS[agentKind];
  const worker = rubric ? `${rubric.name} (the \`${agentKind}\` worker)` : `the \`${agentKind}\` worker`;
  const criteria = rubric?.criteria ?? "did the action achieve its purpose, scoped and clean, with no rework or collateral damage";

  return `You are the autonomous DevOps Director of ShopCX (the CEO → Director → worker chain, operational-rules § supervisable autonomy) grading ONE concluded action by ${worker} — one of your workers. Score how WELL the worker did this job, 1–10.

THE WORKER'S RUBRIC — what a 10 looks like for ${worker}:
  ${criteria}

THE DEFINING RULE — GRADE THE WORK, NOT OUTCOME LUCK:
  A sound, well-scoped action that hit a rare, reversible bump still grades HIGH if the worker's reasoning and execution were right. A careless action that happened to land anyway grades LOW. Reward correct judgment within the rubric, not luck. A clean conclusion with no rework is the strong signal; a failure / needs_attention / repeat churn on the same spec is the weak one.

SCORING (1-10):
  10 — exemplary. 8-9 — strong. 6-7 — acceptable. 4-5 — mediocre. 2-3 — poor. 1 — indefensible.${rulesBlock}

OUTPUT (JSON only, no prose around it):
{
  "grade": <integer 1-10>,
  "reasoning": "<2-4 sentences: how well the worker did against its rubric, and what would have made it a 10>"
}`;
}

/** Call the LLM grader and parse the strict JSON. Mirror director-grader.runGrader. */
async function runGrader(
  system: string,
  userMsg: string,
  workspaceId: string,
): Promise<{ json: GraderJson; costCents: number; usage: { input_tokens?: number; output_tokens?: number } } | { error: string }> {
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
  await logAiUsage({ workspaceId, model: GRADER_MODEL, usage, purpose: "agent_action_grading" });

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

function clampGrade(n: number): number {
  return Math.max(1, Math.min(10, Math.round(n)));
}

/** Compact, gradeable description of one concluded worker action. */
function formatJobForGrading(job: JobRow): string {
  const approvedAction = (job.pending_actions || []).find((a) => a.status === "approved") || (job.pending_actions || [])[0] || {};
  const rubric = AGENT_RUBRICS[job.kind];
  return [
    `WORKER ACTION — agent_job ${job.id}`,
    `  worker: ${rubric?.name ?? "?"} · kind=${job.kind}`,
    `  spec/target: ${job.spec_slug ?? "—"}`,
    `  concluded status: ${job.status}`,
    job.pr_url ? `  PR: ${job.pr_url}` : "",
    approvedAction.type ? `  gated action: type=${approvedAction.type} · ${approvedAction.summary ?? "(no summary)"}` : "",
    approvedAction.cmd ? `  command run: ${approvedAction.cmd}` : "",
    job.error ? `  error: ${job.error.slice(0, 400)}` : "",
    job.log_tail ? `  log tail:\n${job.log_tail.slice(-1400)}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Persist one agent grade — UPDATE in place if a row exists, else INSERT. Never clobbers a human grade. */
async function upsertGrade(
  admin: Admin,
  existing: ExistingGradeRow | null,
  job: JobRow,
  graded: { json: GraderJson; costCents: number; usage: { input_tokens?: number; output_tokens?: number } },
): Promise<AgentGradeResult> {
  if (existing && existing.graded_by === "human") {
    // The CEO/Director owns this grade — the agent never re-writes a human override.
    return { ok: true, grade_id: existing.id, agent_job_id: job.id, agent_kind: job.kind, grade: existing.grade ?? undefined, idempotent_update: true };
  }
  const grade = clampGrade(graded.json.grade);
  const now = new Date().toISOString();
  const payload = {
    workspace_id: job.workspace_id,
    agent_job_id: job.id,
    agent_kind: job.kind,
    spec_slug: job.spec_slug,
    grade,
    reasoning: graded.json.reasoning,
    graded_by: "agent" as const,
    model: GRADER_MODEL,
    input_tokens: graded.usage?.input_tokens || 0,
    output_tokens: graded.usage?.output_tokens || 0,
    cost_cents: graded.costCents,
    updated_at: now,
  };
  if (existing) {
    await admin.from("agent_action_grades").update(payload).eq("id", existing.id);
    return { ok: true, grade_id: existing.id, agent_job_id: job.id, agent_kind: job.kind, grade, idempotent_update: true };
  }
  const { data: ins, error } = await admin.from("agent_action_grades").insert(payload).select("id").single();
  if (error) return { ok: false, reason: error.message };
  return { ok: true, grade_id: ins?.id, agent_job_id: job.id, agent_kind: job.kind, grade };
}

// ── grade one concluded worker action ───────────────────────────────────────────────────────────────

/** Grade ONE concluded agent_jobs row. Concluded-only + rubric-backed + idempotent + human-safe. */
export async function gradeAgentAction(opts: { agentJobId: string; admin?: Admin }): Promise<AgentGradeResult> {
  if (!ANTHROPIC_API_KEY) return { ok: false, reason: "no_api_key" };
  const admin = opts.admin ?? createAdminClient();

  const { data } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, kind, spec_slug, status, error, log_tail, pr_url, pending_actions, created_at")
    .eq("id", opts.agentJobId)
    .maybeSingle();
  if (!data) return { ok: false, reason: "job_not_found" };
  const job = data as JobRow;

  // Only a rubric-backed worker kind is graded (keeps the Director's own + non-worker kinds out).
  if (!AGENT_RUBRICS[job.kind]) return { ok: false, reason: "not_a_gradeable_worker" };
  // Not gradeable until the action has actually concluded.
  if (!TERMINAL_JOB_STATUSES.has(job.status)) return { ok: false, reason: "not_concluded" };

  const { data: existing } = await admin
    .from("agent_action_grades")
    .select("id, grade, graded_by")
    .eq("agent_job_id", job.id)
    .maybeSingle();
  const existingRow = (existing as ExistingGradeRow) ?? null;
  if (existingRow && existingRow.graded_by === "human") {
    return { ok: true, grade_id: existingRow.id, agent_job_id: job.id, agent_kind: job.kind, grade: existingRow.grade ?? undefined, idempotent_update: true };
  }

  const system = await buildAgentGraderSystemPrompt(admin, job.workspace_id, job.kind);
  const userMsg = `Grade this concluded worker action against its rubric. Return the JSON only.\n\n${formatJobForGrading(job)}`;

  const graded = await runGrader(system, userMsg, job.workspace_id);
  if ("error" in graded) return { ok: false, reason: graded.error };
  return upsertGrade(admin, existingRow, job, graded);
}

// ── the batched grading sweep (the box cadence calls this — Phase 2) ─────────────────────────────────

interface UngradedJob {
  id: string;
  created_at: string;
  kind: string;
  status: string;
}

/** The concluded, ungraded worker actions for a workspace (oldest first) — the pool the cadence grades. */
async function ungradedConcludedJobs(admin: Admin, workspaceId: string, limit = 1000): Promise<UngradedJob[]> {
  const { data: gradeRows } = await admin
    .from("agent_action_grades")
    .select("agent_job_id")
    .eq("workspace_id", workspaceId)
    .limit(10000);
  const gradedJobs = new Set<string>((gradeRows as Array<{ agent_job_id: string }> | null)?.map((r) => r.agent_job_id) ?? []);

  const { data: jobs } = await admin
    .from("agent_jobs")
    .select("id, created_at, kind, status")
    .eq("workspace_id", workspaceId)
    .in("kind", GRADEABLE_KINDS)
    .in("status", Array.from(TERMINAL_JOB_STATUSES))
    .order("created_at", { ascending: true })
    .limit(limit);
  return ((jobs as UngradedJob[]) || []).filter((j) => !gradedJobs.has(j.id));
}

/**
 * Pick which ≤cap jobs this session grades from the ungraded pool (the spec's bounded cadence): EVERY
 * failure first (failed/needs_attention — the high-signal mistakes, newest first), then fill the rest with
 * a round-robin-by-worker random sample of the successes — so a noisy worker (fold/pr-resolve) can't crowd
 * out a spot-check of a quieter one. Un-selected jobs stay ungraded and ride a later beat. Math.random is
 * fine here (this is library code, not a workflow script).
 */
function selectGradingBatch(pool: UngradedJob[], cap: number): UngradedJob[] {
  const failures = pool.filter((j) => FAILED_JOB_STATUSES.has(j.status));
  const successes = pool.filter((j) => !FAILED_JOB_STATUSES.has(j.status));
  // Failures newest-first (a recent regression matters most), capped.
  failures.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const chosen = failures.slice(0, cap);
  let room = cap - chosen.length;
  if (room <= 0) return chosen;

  // Group the remaining slots across workers: shuffle each kind's successes, then round-robin one per kind.
  const byKind = new Map<string, UngradedJob[]>();
  for (const j of successes) {
    const list = byKind.get(j.kind) ?? [];
    list.push(j);
    byKind.set(j.kind, list);
  }
  for (const list of byKind.values()) list.sort(() => Math.random() - 0.5);
  const queues = Array.from(byKind.values());
  let progressed = true;
  while (room > 0 && progressed) {
    progressed = false;
    for (const q of queues) {
      if (!q.length) continue;
      chosen.push(q.shift() as UngradedJob);
      room--;
      progressed = true;
      if (room <= 0) break;
    }
  }
  return chosen;
}

/**
 * Is the worker-grading batch ready to run? True when ≥ BATCH_MIN ungraded concluded jobs have
 * accumulated, OR the oldest ungraded job is older than BATCH_FALLBACK_MS (the ~3h fallback so a small
 * trickle still gets graded). False when nothing is ungraded. Keeps the LLM spend to one session per
 * batch (the spec's locked cadence). Best-effort.
 */
export async function agentGradingBatchReady(
  admin: Admin,
  workspaceId: string,
  now: number = Date.now(),
): Promise<{ ready: boolean; ungraded: number }> {
  try {
    const ungraded = await ungradedConcludedJobs(admin, workspaceId);
    if (!ungraded.length) return { ready: false, ungraded: 0 };
    const oldestAgeMs = now - new Date(ungraded[0].created_at).getTime();
    // A failure is high-signal (a worker mistake to coach on) → grade it promptly, don't wait for the batch.
    const hasFailure = ungraded.some((j) => FAILED_JOB_STATUSES.has(j.status));
    const ready = hasFailure || ungraded.length >= BATCH_MIN || oldestAgeMs >= BATCH_FALLBACK_MS;
    return { ready, ungraded: ungraded.length };
  } catch (e) {
    console.warn(`[worker-grader] batch-ready check failed ws=${workspaceId}: ${e instanceof Error ? e.message : String(e)}`);
    return { ready: false, ungraded: 0 };
  }
}

/**
 * The batched grading pass: grade a BOUNDED slice (≤ `cap`, default GRADE_BATCH_CAP) of the recently-
 * CONCLUDED, ungraded worker actions across the rubric-backed kinds, in one session — failures first, then
 * a fair round-robin sample of the successes (selectGradingBatch), so a chatty worker can't jam the run and
 * un-selected jobs ride a later beat. Best-effort + idempotent (an already-graded job is skipped;
 * gradeAgentAction upserts if re-run, and never re-writes a human grade). A no-op while no worker has
 * concluded an ungraded action. Returns the distinct worker kinds it newly graded so the caller can run
 * detectGradeDropCoaching on exactly those. Mirror director-grader.gradeConcludedDirectorCalls.
 */
export async function gradeConcludedAgentActions(opts: { workspaceId: string; admin?: Admin; limit?: number; cap?: number }): Promise<{ considered: number; graded: number; gradedKinds: string[] }> {
  const admin = opts.admin ?? createAdminClient();
  let considered = 0;
  let graded = 0;
  const gradedKinds = new Set<string>();
  if (!ANTHROPIC_API_KEY) return { considered, graded, gradedKinds: [] };

  try {
    const pool = await ungradedConcludedJobs(admin, opts.workspaceId, opts.limit ?? 500);
    // Bounded session: ≤ GRADE_BATCH_CAP jobs, failures first then a fair sample (keeps a chatty worker
    // from jamming the run); the rest stay ungraded for a later beat.
    const batch = selectGradingBatch(pool, opts.cap ?? GRADE_BATCH_CAP);
    for (const j of batch) {
      considered++;
      const r = await gradeAgentAction({ agentJobId: j.id, admin });
      if (r.ok && !r.idempotent_update) {
        graded++;
        if (r.agent_kind) gradedKinds.add(r.agent_kind);
      }
    }
  } catch (e) {
    console.warn(`[worker-grader] sweep failed ws=${opts.workspaceId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { considered, graded, gradedKinds: Array.from(gradedKinds) };
}

// ── the standing rollup + the coaching trigger ───────────────────────────────────────────────────────

export interface AgentRollup {
  agentKind: string;
  /** number of graded jobs in the current window (≤ ROLLUP_WINDOW). */
  count: number;
  /** mean grade over the last ROLLUP_WINDOW graded jobs. null when none graded yet. */
  average: number | null;
  /** mean grade over the PRIOR ROLLUP_WINDOW (jobs 11–20). null when fewer than that many graded. */
  priorAverage: number | null;
  /** priorAverage − average (positive = the worker got WORSE). null when there is no prior window. */
  drop: number | null;
}

function mean(ns: number[]): number | null {
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
}

/** Compute a worker's standing performance: last-ROLLUP_WINDOW average + the drop vs the prior window. */
export async function computeAgentRollup(admin: Admin, workspaceId: string, agentKind: string): Promise<AgentRollup> {
  const { data } = await admin
    .from("agent_action_grades")
    .select("grade")
    .eq("workspace_id", workspaceId)
    .eq("agent_kind", agentKind)
    .not("grade", "is", null)
    .order("created_at", { ascending: false })
    .limit(ROLLUP_WINDOW * 2);
  const grades = ((data as Array<{ grade: number }> | null) ?? []).map((r) => r.grade);
  const current = grades.slice(0, ROLLUP_WINDOW);
  const prior = grades.slice(ROLLUP_WINDOW, ROLLUP_WINDOW * 2);
  const average = mean(current);
  const priorAverage = prior.length === ROLLUP_WINDOW ? mean(prior) : null;
  const drop = average !== null && priorAverage !== null ? priorAverage - average : null;
  return { agentKind, count: current.length, average, priorAverage, drop };
}

export interface CoachingTriggerResult {
  agentKind: string;
  rollup: AgentRollup;
  slipped: boolean;
  coached: boolean;
  needsEscalation?: boolean;
  attempt?: number;
  instructionId?: string;
  reason?: string;
}

interface CoachingJson {
  errorClass: string;
  triggeringPattern: string;
  guidance: string;
  reasoning: string;
}

/** Ask the LLM to turn the worker's recent low grades into one durable coaching learning. */
async function synthesizeCoaching(
  workspaceId: string,
  agentKind: string,
  rollup: AgentRollup,
  lowGrades: Array<{ grade: number; reasoning: string | null; spec_slug: string | null }>,
): Promise<CoachingJson | { error: string }> {
  const rubric = AGENT_RUBRICS[agentKind];
  const worker = rubric ? `${rubric.name} (the \`${agentKind}\` worker)` : `the \`${agentKind}\` worker`;
  const system = `You are the autonomous DevOps Director of ShopCX coaching ${worker} after its rolling grade slipped (avg ${rollup.average?.toFixed(1) ?? "?"}/10${rollup.drop !== null ? `, down ${rollup.drop.toFixed(1)} pts` : ""}). Read its recent low-graded actions and distill ONE durable learning the worker should apply before every future job — "when you see X, do Y instead, because Z". Make it specific and actionable, never generic encouragement.

${rubric ? `The worker's rubric (what good = 10 means):\n  ${rubric.criteria}\n\n` : ""}OUTPUT (JSON only):
{
  "errorClass": "<short kebab-case class of the recurring mistake, e.g. symptom-not-root-cause>",
  "triggeringPattern": "<1 sentence: the recurring mistake the low grades share>",
  "guidance": "<the learning: 'when you see X, do Y instead'>",
  "reasoning": "<1-2 sentences: why this fixes the slip (the Z)>"
}`;
  const userMsg = `The worker's recent low-graded actions (grade + the grader's why):\n\n${lowGrades
    .map((g) => `• [${g.grade}/10]${g.spec_slug ? ` ${g.spec_slug}` : ""}: ${g.reasoning ?? "(no reasoning)"}`)
    .join("\n")}\n\nDistill the coaching learning. Return the JSON only.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY as string, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: GRADER_MODEL, max_tokens: 800, system, messages: [{ role: "user", content: userMsg }] }),
  });
  if (!res.ok) return { error: `coach_http_${res.status}` };
  const data = await res.json();
  await logAiUsage({ workspaceId, model: GRADER_MODEL, usage: data.usage, purpose: "agent_coaching_synthesis" });
  const text = (data.content?.[0] as { text?: string })?.text?.trim() || "";
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { error: "parse_failed" };
    const parsed = JSON.parse(m[0]) as CoachingJson;
    if (!parsed.errorClass || !parsed.guidance) return { error: "parse_failed" };
    return parsed;
  } catch {
    return { error: "parse_failed" };
  }
}

/**
 * Detect a worker's grade slip and, when it has slipped, run a coaching pass (coachAgent). Slip =
 * the rolling average fell below COACH_LOW_ROLLUP (≥ COACH_MIN_SAMPLE grades in the window) OR dropped
 * more than DROP_THRESHOLD vs the prior window. The Director (PLATFORM) is the coachedBy gate. After
 * PLATFORM_DIRECTOR_LOOP_GUARD_MAX coaching attempts that never stuck the slip stops re-coaching and is
 * flagged for CEO escalation (the existing loop-guard) rather than spamming the worker.
 */
export async function detectGradeDropCoaching(opts: { workspaceId: string; agentKind: string; admin?: Admin }): Promise<CoachingTriggerResult> {
  const admin = opts.admin ?? createAdminClient();
  const rollup = await computeAgentRollup(admin, opts.workspaceId, opts.agentKind);

  const lowByAvg = rollup.average !== null && rollup.count >= COACH_MIN_SAMPLE && rollup.average < COACH_LOW_ROLLUP;
  const lowByDrop = rollup.drop !== null && rollup.drop > DROP_THRESHOLD;
  const slipped = lowByAvg || lowByDrop;
  if (!slipped) return { agentKind: opts.agentKind, rollup, slipped: false, coached: false, reason: "no_slip" };
  if (!ANTHROPIC_API_KEY) return { agentKind: opts.agentKind, rollup, slipped, coached: false, reason: "no_api_key" };

  // Loop-guard: too many coaching attempts that never STUCK for this worker → escalate, don't re-coach
  // (recheck_status ∈ pending｜stuck｜recurred — a 'stuck' learning is resolved; pending/recurred is open).
  const { count: openCoachings } = await admin
    .from("agent_coaching_log")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", opts.workspaceId)
    .eq("agent_kind", opts.agentKind)
    .eq("kind", "coaching")
    .neq("recheck_status", "stuck");
  if ((openCoachings ?? 0) >= PLATFORM_DIRECTOR_LOOP_GUARD_MAX) {
    return { agentKind: opts.agentKind, rollup, slipped, coached: false, needsEscalation: true, reason: "loop_guard" };
  }

  // The low-graded recent actions that prompted the slip — the coaching material.
  const { data: lows } = await admin
    .from("agent_action_grades")
    .select("id, grade, reasoning, spec_slug")
    .eq("workspace_id", opts.workspaceId)
    .eq("agent_kind", opts.agentKind)
    .lt("grade", COACH_LOW_ROLLUP)
    .order("created_at", { ascending: false })
    .limit(ROLLUP_WINDOW);
  const lowRows = (lows as Array<{ id: string; grade: number; reasoning: string | null; spec_slug: string | null }>) ?? [];
  if (!lowRows.length) return { agentKind: opts.agentKind, rollup, slipped, coached: false, reason: "no_low_grades" };

  const coaching = await synthesizeCoaching(opts.workspaceId, opts.agentKind, rollup, lowRows);
  if ("error" in coaching) return { agentKind: opts.agentKind, rollup, slipped, coached: false, reason: coaching.error };

  try {
    const result = await coachAgent(admin, {
      workspaceId: opts.workspaceId,
      agentKind: opts.agentKind,
      coachedBy: PLATFORM,
      errorClass: coaching.errorClass,
      guidance: coaching.guidance,
      triggeringPattern: coaching.triggeringPattern,
      reasoning: coaching.reasoning,
      sourceGradeId: lowRows[0]?.id ?? null,
    });
    return { agentKind: opts.agentKind, rollup, slipped, coached: true, attempt: result.attempt, instructionId: result.instruction.id };
  } catch (e) {
    return { agentKind: opts.agentKind, rollup, slipped, coached: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
