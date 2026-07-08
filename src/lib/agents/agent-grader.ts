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
import { postDirectorMessage } from "@/lib/agents/director-board";
import { recordDirectorActivity } from "@/lib/director-activity";
import { getPersona } from "@/lib/agents/personas";
import { ownerFunctionForKind } from "@/lib/agents/approval-inbox";

/** The director (Ada) + an agent's persona name for board lines. */
function nm(kind: string): string {
  return getPersona(kind).name;
}

/**
 * Announce a director action on the #directors board + the activity feed (best-effort) — so coaching,
 * grade-slip escalations, and recoveries are VISIBLE, not just silent DB writes.
 */
async function announceOnBoard(admin: Admin, workspaceId: string, body: string, actionKind: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    await postDirectorMessage({ workspaceId, author: "director", authorFunction: PLATFORM, body, kind: "update", metadata });
  } catch (e) {
    console.warn(`[agent-grader] board post failed: ${e instanceof Error ? e.message : e}`);
  }
  try {
    await recordDirectorActivity(admin, { workspaceId, directorFunction: PLATFORM, actionKind, specSlug: null, reason: body, metadata });
  } catch {
    /* best-effort */
  }
}

type Admin = ReturnType<typeof createAdminClient>;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GRADER_MODEL = SONNET_MODEL;

/**
 * agent_jobs statuses that mean a worker action CONCLUDED — only then is it gradeable.
 *
 * `merged` is the build's TERMINAL SUCCESS state (building → completed → merged = PR landed on `main`;
 * `SUCCESSFUL_BUILD_STATUSES` in agent-jobs.ts), not in-flight. The `build` rubric below literally scores
 * "PR merged clean", so a `merged` build is the canonical thing to grade. A post-merge finalization step
 * that leaves the job at `merged` (never re-flipping it to `completed`) must NOT starve worker grading —
 * the worker's atomic action already concluded. (Omitting `merged` here silently no-op'd every merged
 * build for days — the same STARVED-grading root cause as the director grader.)
 */
const TERMINAL_JOB_STATUSES = new Set(["completed", "merged", "failed", "needs_attention"]);

/**
 * Grader-result `reason`s that mean a benign in-flight race, NOT a grader defect — mirrors the
 * director-grader's INFLIGHT_SKIP_REASONS. `not_concluded` happens when director triage re-queues a
 * job (needs_attention → queued) between the sweep snapshot and gradeAgentAction's re-fetch;
 * `job_not_found` is the same shape one step further (the row was already finalized + collected).
 * Both are expected during normal director churn and must stay silent — only true grader errors
 * (grader_http_429, parse_failed, …) should hit console.error and surface in the Vercel error feed.
 */
const AGENT_INFLIGHT_SKIP_REASONS = new Set(["not_concluded", "job_not_found"]);

/** The standing performance window — last N graded jobs per worker (the spec's locked config). */
export const ROLLUP_WINDOW = 10;

/** A worker is "proven" once its last-ROLLUP_WINDOW average is ≥ this — it then gets graded WAY less often
 *  (only a small spot-check of its successes) so the grading budget flows to unproven/struggling workers.
 *  Lowered 9→8 (grading-graduated-sample-rate) — 9.0 was so high it almost never engaged, so nearly every
 *  action got graded. 8.0 is the "strong" tier at which spot-checking starts (the 6-7 acceptable / 8-9 strong
 *  break in the SCORING rubric). Failures short-circuit any sample rate — see gradeSampleRateForAvg. */
export const PROVEN_AVG = 8;
/** How often a PROVEN worker's successes still get spot-checked (≈1 in 5 beats). Its FAILURES always grade.
 *  Reused as the 8 ≤ avg < 9 tier of gradeSampleRateForAvg (graduated sample rate). */
export const GRADE_PROVEN_SAMPLE = 0.2;
/**
 * Graduated per-worker success sample rate keyed to its rolling average — the share of a worker's
 * SUCCESSFUL jobs to grade this beat. Replaces the old binary proven/not throttle so that a worker
 * that slips one tier is caught by heavier grading on the very next beat (self-re-arm), while a
 * consistently-excellent worker still gets a light-touch spot-check floor (never 0 — a regression
 * would otherwise be invisible until failures start landing). FAILURES are always graded and short-
 * circuit this rate — see selectGradingBatch (isFail).
 *
 * Grading is a statistical read: sampling a batch of a worker's good work is enough to detect drift;
 * grading every single action is over-measurement (Goodhart — [[../operational-rules]] § North star).
 *
 *   count < COACH_MIN_SAMPLE-ish OR avg == null → 1.0  (too little data — grade all until we have a read)
 *   avg < 7                                     → 1.0  (learning zone — full grading; the coaching signal lives here)
 *   7 ≤ avg < 8                                 → 0.5  ("sample, not all" begins)
 *   8 ≤ avg < 9                                 → GRADE_PROVEN_SAMPLE  (proven — spot-check)
 *   avg ≥ 9                                     → 0.1  (excellent — light-touch floor; never 0)
 */
export function gradeSampleRateForAvg(avg: number | null, count: number): number {
  if (avg === null || count < 5) return 1.0; // insufficient data — grade all until we have a read
  if (avg < 7) return 1.0; // learning zone
  if (avg < 8) return 0.5; // sampling begins
  if (avg < 9) return GRADE_PROVEN_SAMPLE; // proven — spot-check
  return 0.1; // excellent — light-touch floor (never 0 so a regression is still catchable)
}
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
 * not just the noisiest). The un-selected jobs stay ungraded and ride a later beat.
 *
 * ada-grading-sampled-adaptive-cadence (2026-07-02): env-overridable via AGENT_GRADE_BATCH_CAP so an
 * operator can lower the per-pass ceiling (e.g. during a Max-budget squeeze) without a redeploy. */
export const GRADE_BATCH_CAP = ((): number => {
  const raw = Number(process.env.AGENT_GRADE_BATCH_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 12;
})();
/**
 * ada-grading-sampled-adaptive-cadence Phase 1: PER-WORKSPACE grading cadence — a grading pass runs at
 * most once per GRADE_CADENCE_MS (~2h). Enforced in `agentGradingBatchReady` via a MAX(created_at) read
 * on `agent_action_grades` for the workspace: if the last-graded-at is within the cadence window, the
 * pass is a no-op regardless of how many ungraded jobs have accumulated (they ride the next window).
 * This decouples grading spend from the ~5-min cron beat — a workspace that just graded 12 jobs is
 * silent for ~2h, so a runaway grading pass can't burn a Max session bank in minutes (the observed
 * failure mode: 32 grades in minutes). Env-overridable via AGENT_GRADE_CADENCE_MS so an operator can
 * tighten/loosen without a redeploy. */
export const GRADE_CADENCE_MS = ((): number => {
  const raw = Number(process.env.AGENT_GRADE_CADENCE_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2 * 60 * 60 * 1000;
})();
/** agent_jobs statuses that mean the worker action FAILED — always graded (the high-signal mistakes),
 *  UNLESS the error text says the failure was an infra cancellation (see `INFRA_CANCEL_ERR_RE`). */
const FAILED_JOB_STATUSES = new Set(["failed", "needs_attention"]);
/**
 * ada-grading-sampled-adaptive-cadence Phase 1: errors that mark the job as an INFRA CANCELLATION
 * (the box reaper killed a stuck/zombied session; a Max session budget cap tripped; a spec was
 * cancelled between claim and completion) — NOT a worker mistake to coach on. These are excluded
 * from the failure-priority set (`isFail` returns false) so they flow through the SUCCESS sample-
 * rate path — a runaway/reap doesn't drag a worker's rollup down (Vault fell to 2.0/10 on 2026-07-02
 * from a string of reaper-killed security-review jobs the grader treated as real failures). Genuine
 * `tsc failed` / `build failed` / conflict errors don't match this pattern and stay in the priority
 * set. Spec-stated keywords (runaway/zombie/cancelled) + the actual box-reaper stamps
 * (stale-session / session died / reaper) so this catches what prod stamps, not just the spec text. */
export const INFRA_CANCEL_ERR_RE = /runaway|zombie|cancelled|stale-session|session died|reaper/i;
/** Is this concluded-job error the mark of an infra cancellation (reaper kill / session budget)?
 *  A `null`/empty error is never an infra cancellation — a genuine `failed` with no error text is
 *  still a worker mistake to grade. Pure fn — exercised directly by the local sampler harness. */
export function isInfraCancelledError(err: string | null | undefined): boolean {
  return typeof err === "string" && err.length > 0 && INFRA_CANCEL_ERR_RE.test(err);
}
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
  "spec-review": { name: "Vale", criteria: "caught real spec defects (mangled phases · missing owner/parent/blockers · missing Verification) · no false-fix calls on sound specs · diagnoses match the markdown (Phase 3: QUALITY only — pass/needs_fix; planned/deferred is Ada's call, not Vale's)" },
  "migration-fix": { name: "Mira", criteria: "migration applied/repaired correctly · audit cleared · no data loss" },
  "pr-resolve": { name: "Pax", criteria: "conflicts resolved without lost work · clean rebase · queue left mergeable" },
  fold: { name: "Fenn", criteria: "folded into the right brain pages · cross-links correct · archived cleanly" },
  "coverage-register": { name: "Cole", criteria: "correct registry entry / exemption · no real coverage gap missed" },
  monitor: { name: "Tao", criteria: "accurate alerts (signal not noise) · caught real stalls" },
  plan: { name: "Pia", criteria: "sound decomposition · correct `blocked_by` · no orphan specs" },
  "product-seed": { name: "Piper", criteria: "product correctly seeded · page built · orderable" },
  "spec-chat": { name: "Sage", criteria: "accurate, grounded answers · correct DB spec authoring on finalize (writes the throwaway scratch buffer under docs/brain/specs/ that the worker parses and authors to `public.specs` + `public.spec_phases` via the author-spec SDK's `upsertSpec` — the .md is a transport buffer in a worktree the worker discards, NEVER a committed spec file and NEVER the source of truth) · read-only honored" },
  "dev-ask": { name: "Dex", criteria: "accurate, grounded answers · correct spec edits · read-only honored" },
  "security-review": { name: "Vault", criteria: "real vulnerabilities caught (not noise) · correct severity · no false-positives on safe diffs · a sound, actionable fix when flagged · produced a parseable verdict" },
  // `triage-escalations` is deliberately NOT a worker rubric — it is June's (CS Director) OWN escalation
  // triage, a DIRECTOR-tier component of June herself, so it is graded by the CEO, not by June's own
  // worker sweep (a director never grades her own work — that is grading yourself, not the layer below).
  // Since june-review-replaces-solver-skeptic-quorum-triage, the triage cron emits `cs-director-call`
  // jobs (one per escalated ticket) and the CEO grades each verdict via the director-grader
  // `cs_director_call` dimension ([[director-grader]]). See docs/brain/functions/platform.md § leash and
  // docs/brain/libraries/agent-grader.md § who-grades-whom.
  "ticket-improve": { name: "Sol", criteria: "the ticket genuinely improved (clearer, correctly categorized/tagged) · no meaning changed · customer voice preserved" },
  // ticket-analyzer-becomes-box-agent-under-june Phase 2 — the per-ticket QC grader box lane
  // (kind='ticket-analyze', owner='cs'). ownerFunctionForKind('ticket-analyze')='cs' via the
  // Control Tower registry, so gradeableKindsForFunction('cs') picks this up and the CS Director's
  // sweep grades every concluded verdict against this rubric.
  "ticket-analyze": { name: "Anya", criteria: "score matched the AI's real conversation quality · issues are concrete + type-correct · severity actions fired only on real severe issues (no false-escalate on positive close) · no analyzer_locked/do_not_reply/ai_disabled/agent_intervened violations · reasoning cites the transcript" },
  // prompt-auto-review-becomes-box-agent-under-june Phase 2 — Prue reviews proposed sonnet_prompts as a
  // supervised box-session agent under June (CS Director). ownerFunctionForKind('prompt-review')==='cs'
  // (Control Tower registry `agent:prompt-review`), so gradeableKindsForFunction('cs') picks this up
  // and the CS director sweep grades it — same discipline as ticket-improve / ticket-analyze.
  "prompt-review": { name: "Prue", criteria: "correct decision per proposal (accept sound rules · reject weak/redundant/voice-violating ones · supersede-not-delete when replacing an approved rule) · well-grounded reasoning citing similar prompts / policies / voice rules · calibrated confidence (no tentative accepts · no low-confidence noise) · never re-routes to a human queue" },
};

/** The agent_jobs `kind`s the worker grader scores (rubric-backed). */
export const GRADEABLE_KINDS = Object.keys(AGENT_RUBRICS);

/**
 * The rubric-backed kinds a given DIRECTOR's grading sweep is allowed to grade — the ones whose
 * owning function in the Control Tower registry (via [[approval-inbox]] `ownerFunctionForKind`) is
 * that director's function. Enforces the north-star cascade rule "a director grades only its own
 * charge" ([[../specs/director-grades-only-own-charge]], [[../operational-rules]] § North star):
 * a supervisor owns the layer BELOW it, not adjacent departments. So Ada (`fn='platform'`) grades
 * the platform-owned workers (build/fold/spec-test/repair/pr-resolve/security-review/spec-review/
 * plan/dev-ask/spec-chat/coverage-register/db_health) but NOT the CS/CMO/Retention/Growth workers
 * (ticket-improve, ticket-analyze, product-seed, migration-fix, storefront-optimizer). A kind
 * unmapped by `ownerFunctionForKind` is treated as NOT owned (never graded by a reaching-in
 * director) — a cross-function worker stays UNGRADED until its own director runs its own sweep.
 * Grading is a DIRECTOR-tier supervisory function; no director → no worker grading. Never a
 * CEO reach-in fail-safe (ungraded-until-their-director-is-live is the intended behavior).
 *
 * Mirrors [[approval-inbox]] `ownerFunctionForKind` — the same owner-scoping the approval router
 * already enforces. Same source of truth (Control Tower registry), no second copy.
 */
export function gradeableKindsForFunction(fn: string): string[] {
  return GRADEABLE_KINDS.filter((k) => ownerFunctionForKind(k) === fn);
}

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

/** The `model` stamp for a grade produced by the box-hosted grader (Max session — no API bill). Keeps
 *  agent_action_grades.model queryable so a box-grade vs API-grade split is visible in dashboards, and
 *  a stale-cost audit can spot the deployed sweep re-firing after Phase 1. */
const BOX_GRADE_MODEL = "box-max-session";

/** Persist one agent grade — UPDATE in place if a row exists, else INSERT. Never clobbers a human grade. */
async function upsertGrade(
  admin: Admin,
  existing: ExistingGradeRow | null,
  job: JobRow,
  graded: { json: GraderJson; costCents: number; usage: { input_tokens?: number; output_tokens?: number }; modelOverride?: string },
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
    model: graded.modelOverride ?? GRADER_MODEL,
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

/**
 * Apply a grade produced by the box-hosted grading session (grading-cascade-to-box-sessions Phase 1)
 * — a Max `claude -p` that reads the REAL merged diff. Reuses the same UNIQUE(agent_job_id) upsert +
 * human-override invariant as the deployed gradeAgentAction path, so the rollup + coaching cascade
 * fire identically off box-written grades. Concluded-only + rubric-gated + idempotent. `model` is
 * stamped `box-max-session` so a per-source split stays queryable; no `ai_token_usage` write (Max sub
 * has no per-token API bill — the CEO directive was $0 marginal grading).
 */
export async function applyBoxGrade(opts: { agentJobId: string; grade: number; reasoning: string; admin?: Admin }): Promise<AgentGradeResult> {
  const admin = opts.admin ?? createAdminClient();
  const { data } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, kind, spec_slug, status, error, log_tail, pr_url, pending_actions, created_at")
    .eq("id", opts.agentJobId)
    .maybeSingle();
  if (!data) return { ok: false, reason: "job_not_found" };
  const job = data as JobRow;

  if (!AGENT_RUBRICS[job.kind]) return { ok: false, reason: "not_a_gradeable_worker" };
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

  return upsertGrade(admin, existingRow, job, {
    json: { grade: opts.grade, reasoning: opts.reasoning },
    costCents: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelOverride: BOX_GRADE_MODEL,
  });
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

export interface UngradedJob {
  id: string;
  created_at: string;
  kind: string;
  status: string;
  /** The concluded job's `error` string — used by `isInfraCancelledError` to KEEP infra-cancelled
   *  failures out of the failure-priority set (they aren't worker mistakes). Nullable for legacy
   *  callers/harnesses; a missing value is treated as "no infra cancellation". */
  error?: string | null;
}

/**
 * The concluded, ungraded worker actions for a workspace (returned OLDEST-FIRST — the pool the cadence
 * grades). Two starvation traps this query MUST avoid (both bit prod — fix-starved-grading round 2):
 *
 *  1. RECENCY WINDOW. The job fetch orders `created_at` DESCENDING then re-sorts ascending — it must
 *     sample the NEWEST `limit` gradeable jobs, not the oldest. Ordering ascending clipped the window to
 *     the OLDEST 1000 gradeable jobs, which are 100% already-graded once grading has ever run — so the
 *     recent backlog NEVER entered the window and `ungraded` was permanently ~0 (the heartbeat read
 *     `considered:0`, "nothing to grade", while hundreds of fresh concluded jobs sat ungraded). Recent
 *     work is exactly what we want to grade, so the window must track the tail, not the head.
 *  2. GRADED-SET COMPLETENESS. PostgREST caps a single response at 1000 rows regardless of `.limit()`,
 *     so the already-graded set (one row per ever-graded job — thousands over time) must be PAGINATED.
 *     A truncated graded set would falsely re-surface old graded jobs as "ungraded" and waste LLM spend.
 */
async function ungradedConcludedJobs(admin: Admin, workspaceId: string, limit = 1000, fn: string = PLATFORM): Promise<UngradedJob[]> {
  // Paginate the graded set past the 1000-row PostgREST response cap (thousands of grades accumulate).
  const gradedJobs = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await admin
      .from("agent_action_grades")
      .select("agent_job_id")
      .eq("workspace_id", workspaceId)
      .range(from, from + 999);
    const rows = (data as Array<{ agent_job_id: string }> | null) ?? [];
    for (const r of rows) gradedJobs.add(r.agent_job_id);
    if (rows.length < 1000) break;
  }

  // director-grades-only-own-charge: a director's sweep grades only the kinds ITS function owns —
  // so the pool is filtered to `gradeableKindsForFunction(fn)`, not the full GRADEABLE_KINDS. An
  // empty owned set for a function is a legitimate NO-OP (that director has no workers to grade
  // yet), never a fall-through to another function's charge.
  const ownedKinds = gradeableKindsForFunction(fn);
  if (!ownedKinds.length) return [];

  // Fetch the NEWEST `limit` gradeable concluded jobs (descending), then re-sort ascending so callers
  // still get oldest-first (the batch-ready gate reads ungraded[0] as the oldest). Descending is what
  // keeps the window on the recent tail instead of the long-graded head.
  const { data: jobs } = await admin
    .from("agent_jobs")
    .select("id, created_at, kind, status, error")
    .eq("workspace_id", workspaceId)
    .in("kind", ownedKinds)
    .in("status", Array.from(TERMINAL_JOB_STATUSES))
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((jobs as UngradedJob[]) || [])
    .filter((j) => !gradedJobs.has(j.id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * Pick which ≤cap jobs this session grades from the ungraded pool (the spec's bounded cadence): EVERY
 * failure first (failed/needs_attention — the high-signal mistakes, newest first), then fill the rest with
 * a round-robin-by-worker random sample of the successes — so a noisy worker (fold/pr-resolve) can't crowd
 * out a spot-check of a quieter one. Un-selected jobs stay ungraded and ride a later beat. Math.random is
 * fine here (this is library code, not a workflow script).
 *
 * Per-kind throttling is GRADUATED (grading-graduated-sample-rate): the caller passes each active kind's
 * rolling {average,count} and the sample rate comes from gradeSampleRateForAvg — a slip pulls the sampled
 * average into a heavier tier next beat (self-re-arm), so we never lock a worker into a binary "proven"
 * state that only re-arms on failures.
 */
export function selectGradingBatch(
  pool: UngradedJob[],
  cap: number,
  rollupByKind: Map<string, { average: number | null; count: number }> = new Map(),
): UngradedJob[] {
  if (pool.length <= cap) return pool;
  const chosen: UngradedJob[] = [];
  const taken = new Set<string>();
  // ada-grading-sampled-adaptive-cadence Phase 1: an infra-cancelled failure is NOT a worker mistake
  // (the box reaper killed a stuck session; a Max-budget cap tripped) — so it does NOT get failure-
  // priority grading. It flows through the SUCCESS sample-rate path instead. Genuine tsc/build
  // failures don't match the pattern and stay in the priority set. See `INFRA_CANCEL_ERR_RE`.
  const isFail = (j: UngradedJob) => FAILED_JOB_STATUSES.has(j.status) && !isInfraCancelledError(j.error ?? null);
  const sampleRate = (kind: string): number => {
    const r = rollupByKind.get(kind);
    return gradeSampleRateForAvg(r?.average ?? null, r?.count ?? 0);
  };
  // Group by kind; within a kind, failures first (high-signal), then newest-first.
  const byKind = new Map<string, UngradedJob[]>();
  for (const j of pool) {
    const list = byKind.get(j.kind) ?? [];
    list.push(j);
    byKind.set(j.kind, list);
  }
  for (const list of byKind.values()) {
    list.sort((a, b) => (isFail(b) ? 1 : 0) - (isFail(a) ? 1 : 0) || b.created_at.localeCompare(a.created_at));
  }
  // COVERAGE PASS (worker-grading-coverage): grade ONE job from EVERY active kind first, so each worker gets
  // graded each beat. The old order (all failures first, then a round-robin of the leftover room) let noisy,
  // high-failure kinds (spec-test/build) eat the whole cap and STARVE quiet, success-heavy workers — that's
  // why Remi (regression) had 0 grades despite a long-standing rubric, and Vault (security) was never graded.
  // Each SUCCESSFUL top job is taken with probability = the kind's graduated sample rate (excellent → 0.1,
  // proven → 0.2, sampling → 0.5, learning/unknown → 1.0). FAILURES short-circuit the sample — a slip from a
  // high-avg worker is exactly what we must catch. So a proven worker's successes are graded way less often,
  // freeing the budget for unproven/struggling workers, but its failures still surface promptly.
  const queues = Array.from(byKind.entries());
  queues.sort(() => Math.random() - 0.5);
  for (const [kind, q] of queues) {
    if (chosen.length >= cap) break;
    const top = q[0];
    if (!top) continue;
    if (!isFail(top) && Math.random() >= sampleRate(kind)) continue; // throttle successes by the graduated rate
    q.shift();
    chosen.push(top);
    taken.add(top.id);
  }
  // FAILURE FILL: every remaining failure, newest-first (a worker mistake is always worth learning from —
  // including a high-average worker's, which is the signal that may pull its rollup back into a heavier tier).
  const failures = pool.filter((j) => !taken.has(j.id) && isFail(j)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const f of failures) { if (chosen.length >= cap) break; chosen.push(f); taken.add(f.id); }
  // ROUND-ROBIN FILL: remaining successes, one per kind — each still subject to the kind's graduated sample
  // rate, so a proven worker's leftover successes don't soak up spot-check budget meant for the rest.
  const rq = Array.from(byKind.entries()).filter(([, q]) => q.length);
  let progressed = true;
  while (chosen.length < cap && progressed) {
    progressed = false;
    for (const [kind, q] of rq) {
      const j = q.shift();
      if (!j || taken.has(j.id)) continue;
      if (!isFail(j) && Math.random() >= sampleRate(kind)) continue; // throttle successes by the graduated rate
      chosen.push(j);
      taken.add(j.id);
      progressed = true;
      if (chosen.length >= cap) break;
    }
  }
  return chosen;
}

/**
 * The pure per-workspace cadence gate: given the last time a grade landed for this workspace and now,
 * is a new grading pass allowed yet? A no-op if `< GRADE_CADENCE_MS` has elapsed since the last graded
 * row. `null` last-graded (never graded) is always past cadence — the first pass is unrestricted.
 * Exposed for the local sampler harness (spec Verification) so the ~2h floor is testable without a DB.
 * ada-grading-sampled-adaptive-cadence Phase 1.
 */
export function withinGradeCadence(lastGradedAtIso: string | null, now: number = Date.now(), cadenceMs: number = GRADE_CADENCE_MS): boolean {
  if (!lastGradedAtIso) return false;
  const last = new Date(lastGradedAtIso).getTime();
  if (!Number.isFinite(last)) return false;
  return now - last < cadenceMs;
}

/**
 * When did this workspace last land an `agent_action_grades` row (for a kind THIS director owns)? The
 * cadence gate's heartbeat — bounded to the director's charge so a Growth/CS director's grade doesn't
 * silence Ada's platform grading. Best-effort; a missing row / query error returns null (treated as
 * past cadence — never blocks the FIRST pass). ada-grading-sampled-adaptive-cadence Phase 1.
 */
async function lastGradedAtForWorkspace(admin: Admin, workspaceId: string, fn: string): Promise<string | null> {
  const ownedKinds = gradeableKindsForFunction(fn);
  if (!ownedKinds.length) return null;
  const { data } = await admin
    .from("agent_action_grades")
    .select("created_at")
    .eq("workspace_id", workspaceId)
    .in("agent_kind", ownedKinds)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = (data as { created_at: string } | null) ?? null;
  return row?.created_at ?? null;
}

/**
 * Is the worker-grading batch ready to run? Two gates, in order:
 *  1. CADENCE (ada-grading-sampled-adaptive-cadence Phase 1): a pass runs at most once per
 *     GRADE_CADENCE_MS (~2h) per workspace — a second call within the window is a hard no-op
 *     (`reason: 'within_cadence'`), even if failures are queued. Prevents a runaway grader from
 *     burning a Max session bank (32 grades in minutes).
 *  2. BACKLOG: ≥ BATCH_MIN ungraded concluded jobs OR the oldest is older than BATCH_FALLBACK_MS
 *     (the ~3h fallback so a small trickle still gets graded). Failures (`failed`/`needs_attention`
 *     that aren't infra cancellations) also make the batch ready promptly — so real worker mistakes
 *     don't have to wait for the batch fill. Infra-cancelled "failures" don't count here for the
 *     same reason they don't count in `selectGradingBatch`: they aren't worker mistakes.
 * False when nothing is ungraded. Best-effort — a query error yields `ready:false` (never a false-
 * positive burn).
 */
export async function agentGradingBatchReady(
  admin: Admin,
  workspaceId: string,
  now: number = Date.now(),
  fn: string = PLATFORM,
): Promise<{ ready: boolean; ungraded: number; reason?: string }> {
  try {
    // Cadence gate FIRST — a workspace inside the window is a hard no-op regardless of backlog. A
    // large backlog waits until the window opens; the next pass drains up to GRADE_BATCH_CAP.
    const lastGradedAt = await lastGradedAtForWorkspace(admin, workspaceId, fn);
    if (withinGradeCadence(lastGradedAt, now)) {
      // Still fetch ungraded so the heartbeat can distinguish "cadence-suppressed with real backlog"
      // from "cadence-suppressed and idle". Bounded and cheap; the pool query is already paginated.
      const ungraded = await ungradedConcludedJobs(admin, workspaceId, 1000, fn);
      return { ready: false, ungraded: ungraded.length, reason: "within_cadence" };
    }
    const ungraded = await ungradedConcludedJobs(admin, workspaceId, 1000, fn);
    if (!ungraded.length) return { ready: false, ungraded: 0 };
    const oldestAgeMs = now - new Date(ungraded[0].created_at).getTime();
    // A GENUINE failure is high-signal (a worker mistake to coach on) → grade it promptly, don't wait
    // for the batch. An INFRA-cancelled failure (`isInfraCancelledError`) is NOT — mirrors the
    // priority-set filter in `selectGradingBatch` so the batch-ready gate and the batch selection
    // agree on what "failure" means. Otherwise a workspace churning reaper-killed jobs would grade
    // continuously (every beat: hasFailure=true, ready=true, drain 12, repeat) — the exact runaway
    // the cadence gate is preventing.
    const hasFailure = ungraded.some((j) => FAILED_JOB_STATUSES.has(j.status) && !isInfraCancelledError(j.error ?? null));
    const ready = hasFailure || ungraded.length >= BATCH_MIN || oldestAgeMs >= BATCH_FALLBACK_MS;
    return { ready, ungraded: ungraded.length };
  } catch (e) {
    console.warn(`[worker-grader] batch-ready check failed ws=${workspaceId}: ${e instanceof Error ? e.message : String(e)}`);
    return { ready: false, ungraded: 0 };
  }
}

/**
 * Pick the batch of agent_job_ids for the box-hosted grader to grade (grading-cascade-to-box-sessions
 * Phase 1). Same selection logic as the deployed sweep — failures first, then a fair round-robin sample
 * of successes, proven workers throttled — but returns the IDs for platform-director-cron to hand off to
 * a new `agent-grade` `agent_jobs` row. The box lane reads each id's REAL diff and writes the grade via
 * applyBoxGrade. A no-op (empty array) while nothing is ungraded.
 */
export async function pickAgentGradeBatch(opts: { workspaceId: string; admin?: Admin; limit?: number; cap?: number; fn?: string }): Promise<UngradedJob[]> {
  const admin = opts.admin ?? createAdminClient();
  const fn = opts.fn ?? PLATFORM;
  try {
    const pool = await ungradedConcludedJobs(admin, opts.workspaceId, opts.limit ?? 500, fn);
    if (!pool.length) return [];
    // Per-kind rolling {average,count} → each kind's graduated sample rate (gradeSampleRateForAvg).
    const rollupByKind = new Map<string, { average: number | null; count: number }>();
    for (const kind of new Set(pool.map((j) => j.kind))) {
      const r = await computeAgentRollup(admin, opts.workspaceId, kind);
      rollupByKind.set(kind, { average: r.average, count: r.count });
    }
    return selectGradingBatch(pool, opts.cap ?? GRADE_BATCH_CAP, rollupByKind);
  } catch (e) {
    console.warn(`[worker-grader] pickAgentGradeBatch failed ws=${opts.workspaceId}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
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
 *
 * NOTE: as of grading-cascade-to-box-sessions Phase 1 the primary grade path moved to the box-hosted
 * `agent-grade` lane (which reads the REAL diff). This deployed-runtime sweep stays as a fallback the
 * caller can invoke when a workspace's box lane can't be reached; retire it once the box lane is proven
 * green for a full rollup window (worker-grading-and-director-management Phase 2 review).
 */
export async function gradeConcludedAgentActions(opts: { workspaceId: string; admin?: Admin; limit?: number; cap?: number; fn?: string }): Promise<{ considered: number; graded: number; gradedKinds: string[] }> {
  const admin = opts.admin ?? createAdminClient();
  const fn = opts.fn ?? PLATFORM;
  let considered = 0;
  let graded = 0;
  const gradedKinds = new Set<string>();
  if (!ANTHROPIC_API_KEY) return { considered, graded, gradedKinds: [] };

  try {
    const pool = await ungradedConcludedJobs(admin, opts.workspaceId, opts.limit ?? 500, fn);
    // Graduated sample rate per kind — compute each active kind's rolling {average,count} so
    // selectGradingBatch can throttle its successes by the tier (learning=1.0 · sampling=0.5 · proven=0.2 ·
    // excellent=0.1). Failures always grade regardless (isFail short-circuits the sample).
    const rollupByKind = new Map<string, { average: number | null; count: number }>();
    for (const kind of new Set(pool.map((j) => j.kind))) {
      const r = await computeAgentRollup(admin, opts.workspaceId, kind);
      rollupByKind.set(kind, { average: r.average, count: r.count });
    }
    // Bounded session: ≤ GRADE_BATCH_CAP jobs — a coverage pass (every active worker), then failures, then a
    // fair sample, with each kind's successes throttled by its graduated rate; the rest stay ungraded for a later beat.
    const batch = selectGradingBatch(pool, opts.cap ?? GRADE_BATCH_CAP, rollupByKind);
    for (const j of batch) {
      considered++;
      const r = await gradeAgentAction({ agentJobId: j.id, admin });
      if (r.ok && !r.idempotent_update) {
        graded++;
        if (r.agent_kind) gradedKinds.add(r.agent_kind);
      } else if (!r.ok && !AGENT_INFLIGHT_SKIP_REASONS.has(r.reason ?? "")) {
        // LOUD: a grade attempt that FAILED for a TRUE grader error (grader_http_429 / parse_failed /
        // not_a_gradeable_worker / no_api_key) must not silently vanish into considered>0,graded==0.
        // Log it so a rate-limited/erroring grader is diagnosable from the runtime logs. In-flight
        // skips (not_concluded / job_not_found) are benign TOCTOU races with director triage and
        // stay silent — mirrors director-grader.ts INFLIGHT_SKIP_REASONS.
        console.error(`[worker-grader] grade attempt failed job=${j.id} kind=${j.kind}: ${r.reason}`);
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
  recovered?: boolean;
  needsEscalation?: boolean;
  attempt?: number;
  instructionId?: string;
  reason?: string;
}

/**
 * Coaching learning shape — the durable rule the box coach session distills from the low-graded jobs'
 * REAL diffs, then hands to coachAgent via applyBoxCoaching. Was returned by the deployed synthesizeCoaching
 * API call (retired in grading-cascade-to-box-sessions Phase 2 — no more `agent_coaching_synthesis`
 * `ai_token_usage` rows). See docs/brain/libraries/agent-grader.md.
 */
export interface CoachingLearning {
  errorClass: string;
  triggeringPattern: string;
  guidance: string;
  reasoning: string;
}

const GRADER_ACTIVE_BUILD = ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume", "blocked_on_usage", "blocked_on_dependency"];

/**
 * director-grades-agents: when an agent persistently underperforms despite coaching, the Director does NOT
 * escalate it to the CEO — it ROLLS the accumulated coaching into a fix spec that hardens the agent's mandate
 * (a real build), then archives the coaching as "rolled into mandates". The supervisory loop graduates ephemeral
 * coaching into a durable fix instead of pinging the CEO. Deterministic render + GitHub commit + build enqueue.
 */
export async function rollCoachingIntoFixSpec(
  admin: Admin,
  opts: { workspaceId: string; agentKind: string; rollupAvg: number | null; attempts: number },
): Promise<{ ok: boolean; slug?: string; reason?: string }> {
  const slug = `agent-mandate-hardening-${opts.agentKind.replace(/[^a-z0-9-]/gi, "")}`;
  // Dedupe — a fix-spec build for this agent already in flight? Don't re-author.
  const { data: live } = await admin.from("agent_jobs").select("id").eq("workspace_id", opts.workspaceId).eq("spec_slug", slug).eq("kind", "build").in("status", GRADER_ACTIVE_BUILD).limit(1);
  if (live && live.length) return { ok: false, reason: "fix-spec build already in flight" };

  const { data: coachings } = await admin
    .from("agent_coaching_log")
    .select("error_class, triggering_pattern, new_instruction, reasoning")
    .eq("workspace_id", opts.workspaceId)
    .eq("agent_kind", opts.agentKind)
    .eq("kind", "coaching")
    .not("recheck_status", "in", "(stuck,rolled_in)")
    .order("created_at", { ascending: false })
    .limit(12);
  const rows = (coachings as Array<{ error_class: string | null; triggering_pattern: string | null; new_instruction: string | null; reasoning: string | null }>) ?? [];
  const persona = getPersona(opts.agentKind);
  const bullets = rows.length
    ? rows.map((r) => `- **When ${r.triggering_pattern || r.error_class || "the slip pattern"}:** ${r.new_instruction || "(see agent_coaching_log)"}${r.reasoning ? ` — ${r.reasoning}` : ""}`).join("\n")
    : "- (the open coaching entries in agent_coaching_log for this agent)";
  // author-mandate-hardening-through-db-chokepoint (2026-07-02): author the fix spec into public.specs via the
  // authorSpecRowStructured CHOKEPOINT — NOT a docs/brain/specs/*.md commit. The build pipeline reads
  // public.specs; the old ghCommitSpec path wrote an ORPHAN .md with no DB row, so every roll parked
  // `spec_row_missing` and NEVER built (silently dropping the coaching — the bug that broke agent-mandate
  // hardening for every agent). Landing it in_review flows it through Vale + the director disposition like
  // any other spec; the pipeline builds it once reviewed (no manual build enqueue, no premature .md).
  const { authorSpecRowStructured } = await import("../author-spec");
  let authored = false;
  try {
    authored = await authorSpecRowStructured(
      opts.workspaceId,
      slug,
      {
        title: `Harden the ${persona.name} agent — roll persistent coaching into its mandate`,
        summary: `The ${persona.name} agent (\`${opts.agentKind}\`) sits at ${opts.rollupAvg?.toFixed(1) ?? "?"}/10 after ${opts.attempts} coaching attempts that didn't stick. Rather than escalate to the CEO, bake the accumulated coaching into the agent's permanent mandate/prompt/code so it improves at the mandate level (director grades agents: low score → durable fix spec, never a CEO escalation).`,
        owner: "platform",
        parent: `[[../functions/platform]] — the platform-director graduates persistent coaching into a durable agent fix.`,
        blocked_by: [],
        why: `The ${opts.agentKind} agent sits at ${opts.rollupAvg?.toFixed(1) ?? "?"}/10 after ${opts.attempts} coaching attempts that didn't stick — the coaching must be baked into the mandate, not left as ephemeral instructions.`,
        what: `When this spec ships, the ${opts.agentKind} agent's coaching is permanently folded into its prompt/run-job so it improves by default on every future run.`,
        phases: [
          {
            title: `Phase 1 — bake the coaching into the ${opts.agentKind} agent`,
            body: [
              `Make the accumulated coaching PERMANENT behavior of the \`${opts.agentKind}\` agent — fold it into its run-job + prompt in \`scripts/builder-worker.ts\` and the relevant \`src/lib/agents/*\`, NOT ephemeral appended \`agent_instructions\`. Once baked, the agent follows it by default.`,
              ``,
              `The accumulated coaching to bake in (archived as rolled-into-mandates):`,
              bullets,
            ].join("\n"),
            verification: `The build's diff modifies the ${opts.agentKind} agent's prompt/run-job (scripts/builder-worker.ts) or src/lib/agents/* to incorporate the coaching above (not only agent_instructions) — grep the changed files for the baked-in guidance. \`npx tsc --noEmit\` clean.`,
            status: "planned",
            why: `The ${opts.agentKind} agent sits at ${opts.rollupAvg?.toFixed(1) ?? "?"}/10 after ${opts.attempts} coaching attempts that didn't stick — the coaching must be baked into the mandate permanently.`,
            what: `When this phase ships, the accumulated coaching is folded into the ${opts.agentKind} agent's prompt/run-job so it applies on every future run without re-coaching.`,
          },
        ],
      },
      "planned",
      { intendedStatusSetBy: "director:platform" },
    );
  } catch (err) {
    return { ok: false, reason: `author failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!authored) return { ok: false, reason: "author write failed" };
  // Archive the open coachings as "rolled into mandates" so they stop counting toward the loop-guard + are retired.
  await admin
    .from("agent_coaching_log")
    .update({ recheck_status: "rolled_in", rechecked_at: new Date().toISOString() })
    .eq("workspace_id", opts.workspaceId)
    .eq("agent_kind", opts.agentKind)
    .eq("kind", "coaching")
    .not("recheck_status", "in", "(stuck,rolled_in)");
  return { ok: true, slug };
}

/**
 * Detect a worker's grade slip and, when it has slipped, ENQUEUE a box-hosted coaching synthesis pass
 * (grading-cascade-to-box-sessions Phase 2: an `agent-coach` `agent_jobs` row → runAgentCoachJob →
 * `applyBoxCoaching`, which reads the low-graded jobs' REAL diffs on Max and calls `coachAgent`).
 * Slip = the rolling average fell below COACH_LOW_ROLLUP (≥ COACH_MIN_SAMPLE grades in the window) OR
 * dropped more than DROP_THRESHOLD vs the prior window. The Director (PLATFORM) is the coachedBy gate
 * (applied by `applyBoxCoaching`). After PLATFORM_DIRECTOR_LOOP_GUARD_MAX coaching attempts that never
 * stuck, the slip stops re-coaching and the coaching is ROLLED INTO A FIX SPEC that hardens the agent
 * (rollCoachingIntoFixSpec — deterministic, still inline here) — never a CEO escalation. `coached=true`
 * on the return now means "the box coach lane has been dispatched (or was already in flight)" — the
 * actual coachAgent DB write lands from the box job within a few minutes.
 */
export async function detectGradeDropCoaching(opts: { workspaceId: string; agentKind: string; admin?: Admin; fn?: string; alreadyCoachedKinds?: string[] }): Promise<CoachingTriggerResult> {
  const admin = opts.admin ?? createAdminClient();
  const fn = opts.fn ?? PLATFORM;
  // director-grades-only-own-charge: a director coaches ONLY the workers its function owns. If a stale
  // caller iterates past a cross-function kind (e.g. platform-director-cron before Phase 1's loop-scope
  // fix), refuse to coach — a slip in a CS/CMO/Retention/Growth worker never triggers THIS director's
  // fix-spec + coaching. An unmapped kind (`ownerFunctionForKind` returns null) is also NOT owned — no
  // reach-in. `computeAgentRollup` is still returned (so a dashboard view of "what would slip" is
  // faithful — this function is the ACTION gate, not a rollup gate).
  if (ownerFunctionForKind(opts.agentKind) !== fn) {
    const rollup: AgentRollup = { agentKind: opts.agentKind, count: 0, average: null, priorAverage: null, drop: null };
    return { agentKind: opts.agentKind, rollup, slipped: false, coached: false, reason: "not_owned_by_director" };
  }
  const rollup = await computeAgentRollup(admin, opts.workspaceId, opts.agentKind);

  const lowByAvg = rollup.average !== null && rollup.count >= COACH_MIN_SAMPLE && rollup.average < COACH_LOW_ROLLUP;
  const lowByDrop = rollup.drop !== null && rollup.drop > DROP_THRESHOLD;
  const slipped = lowByAvg || lowByDrop;
  if (!slipped) {
    // RECOVERY: the agent was below the bar in the prior window and has climbed back above it — the
    // coaching took. Announce it once (deduped vs a recent agent_recovered activity row).
    const recovered = rollup.priorAverage != null && rollup.priorAverage < COACH_LOW_ROLLUP && rollup.average != null && rollup.average >= COACH_LOW_ROLLUP;
    if (recovered) {
      const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count: recent } = await admin
        .from("director_activity")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", opts.workspaceId)
        .eq("action_kind", "agent_recovered")
        .eq("director_function", PLATFORM)
        .gte("created_at", sinceIso)
        .filter("metadata->>agent_kind", "eq", opts.agentKind);
      if (!recent) {
        await announceOnBoard(
          admin,
          opts.workspaceId,
          `📈 ${nm(PLATFORM)}'s coaching took — ${nm(opts.agentKind)} (\`${opts.agentKind}\`) recovered to ${rollup.average?.toFixed(1)}/10 (was ${rollup.priorAverage?.toFixed(1)}).`,
          "agent_recovered",
          { agent_kind: opts.agentKind, average: rollup.average, prior: rollup.priorAverage },
        );
      }
      return { agentKind: opts.agentKind, rollup, slipped: false, coached: false, recovered: true };
    }
    return { agentKind: opts.agentKind, rollup, slipped: false, coached: false, reason: "no_slip" };
  }
  // consolidate-grade-coach-one-session: the grade session already synthesized + applied this kind's
  // coaching INLINE (same context, no extra hydration) via applyBoxCoaching. Skip the redundant separate
  // `agent-coach` enqueue — this call is now only the recovery-announce + fallback path. A slipped kind
  // that WAS coached inline this beat needs no second lane.
  if (opts.alreadyCoachedKinds?.includes(opts.agentKind)) {
    return { agentKind: opts.agentKind, rollup, slipped, coached: true, reason: "coached_inline" };
  }

  // grading-cascade-to-box-sessions Phase 2: the coaching synthesis LLM call moved off Anthropic's API
  // to a box `agent-coach` session on Max, so the deployed cron no longer needs an ANTHROPIC_API_KEY to
  // drive the coaching cascade — it just enqueues the box job.

  // Loop-guard: too many coaching attempts that never STUCK for this worker → escalate, don't re-coach
  // (recheck_status ∈ pending｜stuck｜recurred — a 'stuck' learning is resolved; pending/recurred is open).
  const { count: openCoachings } = await admin
    .from("agent_coaching_log")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", opts.workspaceId)
    .eq("agent_kind", opts.agentKind)
    .eq("kind", "coaching")
    .not("recheck_status", "in", "(stuck,rolled_in)"); // 'stuck' = took; 'rolled_in' = baked into a fix spec already
  if ((openCoachings ?? 0) >= PLATFORM_DIRECTOR_LOOP_GUARD_MAX) {
    // Coached too many times without it sticking → do NOT escalate to the CEO. ROLL the coaching into a fix
    // spec that hardens the agent's mandate (a real build), and archive the coaching as rolled-into-mandates.
    const roll = await rollCoachingIntoFixSpec(admin, { workspaceId: opts.workspaceId, agentKind: opts.agentKind, rollupAvg: rollup.average, attempts: openCoachings ?? 0 });
    if (roll.ok) {
      await announceOnBoard(
        admin,
        opts.workspaceId,
        `🛠️ ${nm(PLATFORM)} rolled ${nm(opts.agentKind)}'s coaching into a fix spec [[${roll.slug}]] — coached ${openCoachings}× without it sticking (${rollup.average?.toFixed(1)}/10), so it's now a build that hardens the agent at the mandate level; the coaching is archived as rolled-into-mandates.`,
        "rolled_coaching_into_spec",
        { agent_kind: opts.agentKind, slug: roll.slug, average: rollup.average, attempts: openCoachings },
      );
      return { agentKind: opts.agentKind, rollup, slipped, coached: false, needsEscalation: false, reason: "rolled_into_fix_spec" };
    }
    // Roll didn't author (fix-spec build already in flight, or no GitHub token) — still NEVER escalate to the CEO.
    return { agentKind: opts.agentKind, rollup, slipped, coached: false, needsEscalation: false, reason: roll.reason || "roll_skipped" };
  }

  // The low-graded recent actions that prompted the slip — the coaching material the box session will
  // read. Pass the agent_action_grades row ids (`source_grade_id` on the resulting coaching_log row) +
  // the agent_job_ids so the box coach lane can git-show each merged diff.
  const { data: lows } = await admin
    .from("agent_action_grades")
    .select("id, grade, reasoning, spec_slug, agent_job_id")
    .eq("workspace_id", opts.workspaceId)
    .eq("agent_kind", opts.agentKind)
    .lt("grade", COACH_LOW_ROLLUP)
    .order("created_at", { ascending: false })
    .limit(ROLLUP_WINDOW);
  const lowRows = (lows as Array<{ id: string; grade: number; reasoning: string | null; spec_slug: string | null; agent_job_id: string }>) ?? [];
  if (!lowRows.length) return { agentKind: opts.agentKind, rollup, slipped, coached: false, reason: "no_low_grades" };

  // grading-cascade-to-box-sessions Phase 2: the coaching synthesis LLM call moved to a box session on
  // Max that reads the REAL diffs (git-show / git-diff origin/main...origin/<branch>) instead of the
  // paraphrased stored grade reasoning the deployed synthesizeCoaching used. This function no longer
  // calls the Anthropic API — it ENQUEUES ONE `agent-coach` `agent_jobs` row per (workspace,
  // agent_kind) slip. The box coach lane (scripts/builder-worker.ts → runAgentCoachJob) synthesizes
  // the durable learning from the diffs, then writes agent_coaching_log via `applyBoxCoaching` (which
  // re-checks the loop-guard + rollup + calls coachAgent — the pure DB write is unchanged). No API
  // bill; ai_token_usage purpose=agent_coaching_synthesis rows stop accruing.
  //
  // Dedup: skip re-enqueue while an agent-coach job for this (workspace, agent_kind) is already
  // queued/building/needs_input — one box session per slip at a time, no daily pileup. `instructions`
  // is stored as a JSON-encoded TEXT column (not jsonb), so a simple ilike against the encoded
  // agent_kind field matches (the payload uses double-quotes, matching JSON.stringify).
  const kindNeedle = `%"agent_kind":"${opts.agentKind}"%`;
  const { data: inflight } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", opts.workspaceId)
    .eq("kind", "agent-coach")
    .ilike("instructions", kindNeedle)
    .in("status", ["queued", "queued_resume", "claimed", "building", "needs_input", "needs_approval"])
    .limit(1);
  if (inflight && inflight.length) {
    return { agentKind: opts.agentKind, rollup, slipped, coached: true, reason: "coach_job_in_flight" };
  }

  const payload = {
    agent_kind: opts.agentKind,
    low_grade_ids: lowRows.map((r) => r.id),
    low_agent_job_ids: lowRows.map((r) => r.agent_job_id),
    rollup_average: rollup.average,
    rollup_drop: rollup.drop,
    open_coaching_count: openCoachings ?? 0,
    // director-grades-only-own-charge: the enqueuing director's function — so `applyBoxCoaching`
    // on the box side re-verifies the coach applies only within THIS director's charge.
    fn,
  };
  const { error: insErr } = await admin.from("agent_jobs").insert({
    workspace_id: opts.workspaceId,
    spec_slug: "agent-coach",
    kind: "agent-coach",
    status: "queued",
    created_by: null,
    instructions: JSON.stringify(payload),
  });
  if (insErr) {
    console.error(`[worker-grader] agent-coach enqueue failed ws=${opts.workspaceId} kind=${opts.agentKind}: ${insErr.message}`);
    return { agentKind: opts.agentKind, rollup, slipped, coached: false, reason: `enqueue_failed:${insErr.message}` };
  }
  return { agentKind: opts.agentKind, rollup, slipped, coached: true, reason: "coach_job_enqueued" };
}

// ── grading-cascade-to-box-sessions Phase 2: box-hosted coaching synthesis ─────────────────────────────

/**
 * Apply a coaching learning produced by the box-hosted synthesis session (grading-cascade-to-box-sessions
 * Phase 2) — a Max `claude -p` that read the low-graded jobs' REAL merged diffs and distilled the
 * recurring code mistake into ONE durable rule. Reuses `coachAgent` (the same DIRECTOR-GATED DB write
 * the deployed path used) so `agent_coaching_log` + `agent_instructions` versioning + the loop-guard
 * cascade fire identically. Idempotent + rollup-safe:
 *
 *   • Rollup RE-CHECK: the slip may have recovered while the coach job sat queued (a fresh batch of
 *     high grades landed) — bail with reason='recovered_before_coach' instead of writing a stale rule.
 *   • Loop-guard RE-CHECK: open coachings may have climbed past PLATFORM_DIRECTOR_LOOP_GUARD_MAX
 *     while queued — hand back to rollCoachingIntoFixSpec instead of adding attempt N+1.
 *
 * Announces the coaching on #directors + logs a `coached_agent` activity row — same board post the
 * deployed path emitted. Returns the coachAgent write metadata so the box lane can log the attempt.
 * See docs/brain/libraries/agent-grader.md · docs/brain/tables/agent_coaching_log.md.
 */
export async function applyBoxCoaching(opts: {
  workspaceId: string;
  agentKind: string;
  learning: CoachingLearning;
  sourceGradeId?: string | null;
  admin?: Admin;
  fn?: string;
}): Promise<{ ok: boolean; coached?: boolean; attempt?: number; instructionId?: string; reason?: string }> {
  const admin = opts.admin ?? createAdminClient();
  const fn = opts.fn ?? PLATFORM;
  // director-grades-only-own-charge: refuse to write coaching for a kind this director doesn't own.
  // detectGradeDropCoaching already enforces this on the enqueue side; belt-and-suspenders here so a
  // stale `agent-coach` job queued before the Phase-1 fix (or a hand-rolled apply) can't quietly
  // write a cross-function learning through PLATFORM.
  if (ownerFunctionForKind(opts.agentKind) !== fn) {
    return { ok: false, reason: "not_owned_by_director" };
  }
  const rollup = await computeAgentRollup(admin, opts.workspaceId, opts.agentKind);

  // Recovery re-check — the slip may have healed while the coach job sat queued.
  const lowByAvg = rollup.average !== null && rollup.count >= COACH_MIN_SAMPLE && rollup.average < COACH_LOW_ROLLUP;
  const lowByDrop = rollup.drop !== null && rollup.drop > DROP_THRESHOLD;
  if (!(lowByAvg || lowByDrop)) {
    return { ok: true, coached: false, reason: "recovered_before_coach" };
  }

  // Loop-guard re-check — attempts may have crossed the max while queued.
  const { count: openCoachings } = await admin
    .from("agent_coaching_log")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", opts.workspaceId)
    .eq("agent_kind", opts.agentKind)
    .eq("kind", "coaching")
    .not("recheck_status", "in", "(stuck,rolled_in)");
  if ((openCoachings ?? 0) >= PLATFORM_DIRECTOR_LOOP_GUARD_MAX) {
    const roll = await rollCoachingIntoFixSpec(admin, { workspaceId: opts.workspaceId, agentKind: opts.agentKind, rollupAvg: rollup.average, attempts: openCoachings ?? 0 });
    if (roll.ok) {
      await announceOnBoard(
        admin,
        opts.workspaceId,
        `🛠️ ${nm(PLATFORM)} rolled ${nm(opts.agentKind)}'s coaching into a fix spec [[${roll.slug}]] — coached ${openCoachings}× without it sticking (${rollup.average?.toFixed(1)}/10), so it's now a build that hardens the agent at the mandate level; the coaching is archived as rolled-into-mandates.`,
        "rolled_coaching_into_spec",
        { agent_kind: opts.agentKind, slug: roll.slug, average: rollup.average, attempts: openCoachings },
      );
    }
    return { ok: true, coached: false, reason: roll.ok ? "rolled_into_fix_spec" : roll.reason || "roll_skipped" };
  }

  if (!opts.learning?.errorClass || !opts.learning?.guidance) {
    return { ok: false, reason: "invalid_learning" };
  }

  try {
    const result = await coachAgent(admin, {
      workspaceId: opts.workspaceId,
      agentKind: opts.agentKind,
      coachedBy: PLATFORM,
      errorClass: opts.learning.errorClass,
      guidance: opts.learning.guidance,
      triggeringPattern: opts.learning.triggeringPattern,
      reasoning: opts.learning.reasoning,
      sourceGradeId: opts.sourceGradeId ?? null,
    });
    await announceOnBoard(
      admin,
      opts.workspaceId,
      `🛠️ ${nm(PLATFORM)} coached ${nm(opts.agentKind)}: ${opts.learning.guidance}`,
      "coached_agent",
      {
        agent_kind: opts.agentKind,
        error_class: opts.learning.errorClass,
        kind: "coaching",
        rollup_avg: rollup.average,
        model: "box-max-session",
      },
    );
    return { ok: true, coached: true, attempt: result.attempt, instructionId: result.instruction.id };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
