/**
 * worker-coaching — the DevOps Director's coaching brain (worker-coaching-loop spec, Phase 1). See
 * docs/brain/libraries/agent-coaching.md + docs/brain/specs/worker-coaching-loop.md.
 *
 * This is the supervisory pass that closes the loop: detect a worker's repeated mistake →
 * route (guidance gap vs code bug) → coach (amend the worker's instructions, log + post the message)
 * OR route a real code bug to Repair OR escalate to the CEO after N failed coachings → and re-check
 * that past coachings stuck.
 *
 *   • `detectRepeatedErrors` — group recent director_activity by (worker, disposition class) and surface
 *     the classes a worker applied repeatedly. The CONCRETE wrongness signal we trust without the
 *     grading loop: a SIGNATURE the worker dismissed that came BACK (recurred) — a correct dismissal
 *     makes a problem stop. (Grades from director-loop-grading become an extra input once it ships.)
 *   • `classifyCoachingRoute` — guidance gap (coach) vs code bug (→ Repair/Regression). A genuine code
 *     defect is NOT a guidance gap — coaching ≠ patching bugs.
 *   • `runAgentCoachingPass` — the standing pass. dry-run by default; `apply:true` writes.
 *
 * north-star: the director optimizes a bounded proxy (worker decision quality) and answers to the CEO.
 * Coaching is reversible guidance done within the leash; a class that won't fix after N coachings
 * ESCALATES to the CEO (a deeper redesign) — never infinite re-coaching. CEO → director → worker.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { getPersona } from "@/lib/agents/personas";
import { postDirectorMessage } from "@/lib/agents/director-board";
import { recordDirectorActivity } from "@/lib/director-activity";
import { enqueueRepairJob } from "@/lib/repair-agent";
import {
  coachAgent,
  linkCoachingBoardPost,
  getAgentCoachingHistory,
  recordRecheck,
  type AgentCoachingEntry,
} from "@/lib/agents/agent-instructions";

type Admin = ReturnType<typeof createAdminClient>;

/** The supervising director for the workers in this spec (the Platform/DevOps Director, "Ada"). */
export const COACHING_DIRECTOR_FUNCTION = "platform";
/** Look-back window for the repeated-error detector. */
export const COACHING_WINDOW_DAYS = 14;
/** A disposition class a worker applied at least this many times is a candidate pattern. */
export const REPEAT_ERROR_THRESHOLD = 3;
/** After this many coaching attempts on the SAME class that still recurs → escalate to the CEO. */
export const COACHING_ATTEMPTS_BEFORE_ESCALATE = 2;

// ── Blameless box-outage classifier ───────────────────────────────────────────────────────────────
// agent-coach-auto-resolves-blameless-box-outage-grade-batches-instead-of-escalating Phase 1.
//
// A worker's low grade CAN come from the BOX going down mid-run rather than a real worker mistake:
// the Claude CLI drops with `authentication_failed` / `Not logged in` when its account credentials
// evict, the Claude-down breaker trips (`Claude is down (breaker tripped) — auto-resumes on recovery`),
// or the same identical box-level runtime error stamps every action in the same window. Those are
// INFRA failures — the worker never actually reached its judgment layer. Coaching them wastes a slot
// and (worse) parks a needs_attention card that pages the CEO each cycle while the outage grades
// age out.
//
// The classifier here is PURE: it takes the coach batch's low grades (each with the grader's
// reasoning + the underlying agent_jobs row's error / log_tail) and returns { blameless } — a batch
// is blameless-outage iff EVERY low grade matches a box-level infra signature AND NONE reflects a
// genuine worker-attributable slip. One real judgment slip in the batch means the whole batch stays
// COACHABLE — a real low grade that merely CO-OCCURRED with an outage grade must not be masked.
//
// Phase 2 wires this into `runAgentCoachingPass` + `runAgentCoachJob` — Phase 1 lands the classifier
// + its test only.
export const BLAMELESS_OUTAGE_SIGNATURES: { key: string; pattern: RegExp }[] = [
  { key: "cli_auth_failed", pattern: /authentication[_ ]failed/i },
  { key: "cli_not_logged_in", pattern: /not logged in/i },
  { key: "cli_login_prompt", pattern: /please\s*(run|use|log\s*in).{0,20}\/?login/i },
  { key: "claude_breaker_tripped", pattern: /claude is down.{0,40}breaker tripped/i },
  { key: "breaker_tripped", pattern: /breaker tripped/i },
  { key: "blocked_on_dependency_claude", pattern: /blocked_on_dependency.{0,40}claude/i },
];

/** Concrete anti-signals: strings the batch carries that PROVE at least one low grade is a genuine
 *  worker slip, even if a co-occurring outage signature also matched. When one of these appears in
 *  a low grade's grader reasoning, we treat the low grade as WORKER-attributable — not blameless.
 *  Kept CONSERVATIVE (the false-negative direction) so a real coachable batch never gets swallowed
 *  by outage co-occurrence; the classifier's job is to protect against the false-positive of
 *  coaching an outage, not to auto-clear every close-call. */
const WORKER_ATTRIBUTABLE_MARKERS: RegExp[] = [
  /wrong\s+(disposition|verdict|call|route|choice)/i,
  /mis(-|)?diagnosed|misjudged|missed a real/i,
  /false[- ]positive|false[- ]negative/i,
  /root[- ]cause.{0,30}not\s+identified/i,
  /rebuild\s+churn|repeat\s+churn/i,
  /symptom(-|,)?\s*not\s*root/i,
];

export interface CoachBatchLowGrade {
  /** agent_action_grades.id — the row the coach batch groups over. */
  gradeId: string;
  /** The grader's stored reasoning (paraphrased LLM text). */
  gradeReasoning: string | null;
  /** The underlying concluded agent_jobs.error, if any. */
  jobError: string | null;
  /** The underlying concluded agent_jobs.log_tail, if any. */
  jobLogTail: string | null;
}

export interface BlamelessOutageVerdict {
  blameless: boolean;
  /** The signature key that dominates the batch when blameless (highest count); null when not blameless. */
  dominantSignature: string | null;
  /** Per-grade evidence — which signature matched (if any), and whether a worker-attributable marker fired. */
  perGrade: Array<{ gradeId: string; matchedSignature: string | null; workerAttributable: boolean }>;
  /** Terse reason string suitable for a director_activity metadata field / log tail. */
  reason: string;
}

function detectOutageSignature(text: string): string | null {
  for (const s of BLAMELESS_OUTAGE_SIGNATURES) if (s.pattern.test(text)) return s.key;
  return null;
}

function hasWorkerAttributableMarker(text: string): boolean {
  for (const p of WORKER_ATTRIBUTABLE_MARKERS) if (p.test(text)) return true;
  return false;
}

/**
 * Classify a coach batch's low grades — blameless-outage iff EVERY low grade matches one of the
 * box-level infra signatures AND NONE carries a worker-attributable marker. An empty batch is not
 * blameless (nothing to auto-resolve). A single genuine slip in the batch (per WORKER_ATTRIBUTABLE_
 * MARKERS) demotes the whole batch to NOT blameless — the outage grades ride with the real slip and
 * the normal coach → route-to-repair → escalate path runs untouched.
 */
export function classifyBlamelessOutageBatch(lows: CoachBatchLowGrade[]): BlamelessOutageVerdict {
  if (!lows.length) {
    return { blameless: false, dominantSignature: null, perGrade: [], reason: "empty_batch" };
  }
  const perGrade = lows.map((l) => {
    const blob = `${l.gradeReasoning ?? ""}\n${l.jobError ?? ""}\n${l.jobLogTail ?? ""}`;
    return {
      gradeId: l.gradeId,
      matchedSignature: detectOutageSignature(blob),
      workerAttributable: hasWorkerAttributableMarker(blob),
    };
  });

  const unmatched = perGrade.find((g) => g.matchedSignature === null);
  if (unmatched) {
    return {
      blameless: false,
      dominantSignature: null,
      perGrade,
      reason: `low_grade_${unmatched.gradeId}_matched_no_box_outage_signature`,
    };
  }
  const workerSlip = perGrade.find((g) => g.workerAttributable);
  if (workerSlip) {
    return {
      blameless: false,
      dominantSignature: null,
      perGrade,
      reason: `low_grade_${workerSlip.gradeId}_carries_worker_attributable_marker`,
    };
  }
  // Every low grade matched a box-outage signature and none is worker-attributable — blameless. Pick
  // the dominant signature (the one most low grades share) for the audit trail.
  const counts = new Map<string, number>();
  for (const g of perGrade) counts.set(g.matchedSignature!, (counts.get(g.matchedSignature!) ?? 0) + 1);
  const dominant = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
  return {
    blameless: true,
    dominantSignature: dominant,
    perGrade,
    reason: `all_${lows.length}_low_grades_matched_box_outage_signature_${dominant}`,
  };
}

// ── Phase 2: dedup window + pure decision fn for auto-resolving a blameless batch ────────────────
//
// The classifier says "blameless." The wiring says WHAT the coach does with that verdict:
//
//   1. If the classifier says NOT blameless → the existing coach path runs untouched (route to Repair
//      for a code-bug class · coach for a guidance gap · roll into a fix spec after the loop guard).
//   2. If the classifier says blameless AND there is NO recent `blameless_outage` audit row for this
//      (workspace, agent_kind) → mint ONE audit row (`agent_coaching_log` with kind='blameless_outage',
//      recheck_status='stuck' since there is nothing to re-check on an outage) so the run is accounted
//      for, and mark the coach job `completed`. NEVER `needs_attention` — an outage is not a park.
//   3. If a recent `blameless_outage` audit row already exists inside BLAMELESS_OUTAGE_DEDUP_MS → the
//      recurring outage grades aging out must NOT re-mint a card every cycle: just mark the coach job
//      `completed` and reference the existing audit row. This is the dedup the spec calls out.
//
// The decision function is PURE — it takes the classifier verdict and the recent audit rows and returns
// the action. The DB writes happen at the call site (runAgentCoachJob).
export const BLAMELESS_OUTAGE_DEDUP_MS = 24 * 60 * 60 * 1000;

export interface BlamelessOutageAuditRow {
  id: string;
  /** ISO timestamp — `agent_coaching_log.created_at`. */
  createdAt: string;
}

export type CoachBatchOutcome =
  | { action: "proceed_to_coach"; reason: string }
  | { action: "record_blameless_outage"; dominantSignature: string; reason: string }
  | { action: "auto_resolve_deduped"; existingId: string; reason: string };

/**
 * Given the classifier verdict + any recent `blameless_outage` audit rows for (workspace, agent_kind),
 * decide what the coach lane does with this batch. Pure — no DB / IO — so the runAgentCoachJob wiring
 * is fully testable without stubbing Supabase.
 *
 * `now` is injectable so a test can freeze time; production callers use `Date.now()` (the default).
 */
export function decideBlamelessOutageOutcome(
  verdict: BlamelessOutageVerdict,
  recentAuditRows: BlamelessOutageAuditRow[],
  now: number = Date.now(),
): CoachBatchOutcome {
  if (!verdict.blameless) return { action: "proceed_to_coach", reason: verdict.reason };
  const cutoff = now - BLAMELESS_OUTAGE_DEDUP_MS;
  const dedup = recentAuditRows.find((r) => {
    const t = new Date(r.createdAt).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  if (dedup) return { action: "auto_resolve_deduped", existingId: dedup.id, reason: verdict.reason };
  return {
    action: "record_blameless_outage",
    dominantSignature: verdict.dominantSignature ?? "unknown_box_outage",
    reason: verdict.reason,
  };
}

/** Dispositions that are JUDGMENT calls (a wrong one is a guidance gap → coachable). */
const DISMISSAL_VERDICTS = new Set([
  "transient",
  "foreign",
  "false-positive",
  "already-fixed",
  "monitor-false-positive",
  "foreign-app-noise",
  "dismissed",
]);
/** Dispositions that point at a genuine code defect (→ route to Repair/Regression, never coach). */
const CODE_BUG_VERDICTS = new Set(["real-bug"]);

/** A repeated-error candidate: a worker applied one disposition class N times in the window. */
export interface RepeatedErrorCandidate {
  agentKind: string;
  /** the disposition/verdict that is the class (e.g. 'foreign'). */
  errorClass: string;
  occurrences: number;
  /** distinct signatures the worker applied this disposition to. */
  signatures: string[];
  /** signatures that RECURRED (the concrete wrongness signal — a correct disposition makes them stop). */
  recurredSignatures: string[];
  /** the director_activity row ids that make up the pattern. */
  activityIds: string[];
  /** a couple of the reasons the worker gave (for the human-readable triggering pattern). */
  sampleReasons: string[];
  /** the spec/slug context, if the activity carried one. */
  specSlug: string | null;
}

interface ActivityRow {
  id: string;
  director_function: string;
  action_kind: string;
  spec_slug: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** Map an action_kind to its worker kind when the activity row carries no job_id (best-effort fallback). */
function workerKindFromAction(actionKind: string): string | null {
  if (actionKind.includes("regression")) return "regression";
  if (actionKind.includes("repair")) return "repair";
  if (actionKind.includes("db_health") || actionKind.includes("db-health")) return "db_health";
  return null;
}

/**
 * Detect each worker's repeated disposition classes from director_activity. Resolves the worker kind via
 * metadata.agent_kind → metadata.job_id (agent_jobs.kind) → action_kind. A candidate is returned for
 * every (worker, disposition) the worker applied ≥ REPEAT_ERROR_THRESHOLD times in the window; the
 * caller decides which to coach (those with a recurred signature, or a grade saying it was wrong).
 */
export async function detectRepeatedErrors(
  admin: Admin,
  workspaceId: string,
  opts: { windowDays?: number; threshold?: number } = {},
): Promise<RepeatedErrorCandidate[]> {
  const windowDays = opts.windowDays ?? COACHING_WINDOW_DAYS;
  const threshold = opts.threshold ?? REPEAT_ERROR_THRESHOLD;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await admin
    .from("director_activity")
    .select("id, director_function, action_kind, spec_slug, reason, metadata, created_at")
    .eq("workspace_id", workspaceId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) {
    console.warn("[worker-coaching] detect read failed:", error.message);
    return [];
  }
  const rows = (data ?? []) as ActivityRow[];

  // Resolve worker kinds for rows that carry a job_id but no explicit agent_kind.
  const jobIds = new Set<string>();
  for (const r of rows) {
    const m = r.metadata ?? {};
    if (!m.agent_kind && typeof m.job_id === "string") jobIds.add(m.job_id);
  }
  const jobKind = new Map<string, string>();
  if (jobIds.size) {
    const { data: jobs } = await admin.from("agent_jobs").select("id, kind").in("id", Array.from(jobIds));
    for (const j of (jobs ?? []) as { id: string; kind: string }[]) jobKind.set(j.id, j.kind);
  }

  // Group by (agentKind, disposition class). A "disposition" is the verdict in metadata; fall back to
  // the action_kind (e.g. 'dismissed_regression') so a worker that records no verdict still groups.
  interface Group {
    agentKind: string;
    errorClass: string;
    activityIds: string[];
    signatures: string[];
    sigCounts: Map<string, number>;
    reasons: string[];
    specSlug: string | null;
  }
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const m = r.metadata ?? {};
    const agentKind =
      (typeof m.agent_kind === "string" && m.agent_kind) ||
      (typeof m.job_id === "string" && jobKind.get(m.job_id)) ||
      workerKindFromAction(r.action_kind);
    if (!agentKind) continue;
    const verdict = typeof m.verdict === "string" && m.verdict ? m.verdict : r.action_kind;
    const signature = typeof m.signature === "string" ? m.signature : "";
    const key = `${agentKind}|${verdict}`;
    let g = groups.get(key);
    if (!g) {
      g = { agentKind, errorClass: verdict, activityIds: [], signatures: [], sigCounts: new Map(), reasons: [], specSlug: r.spec_slug };
      groups.set(key, g);
    }
    g.activityIds.push(r.id);
    if (signature) {
      if (!g.signatures.includes(signature)) g.signatures.push(signature);
      g.sigCounts.set(signature, (g.sigCounts.get(signature) ?? 0) + 1);
    }
    if (r.reason && g.reasons.length < 3) g.reasons.push(r.reason);
  }

  const candidates: RepeatedErrorCandidate[] = [];
  for (const g of groups.values()) {
    if (g.activityIds.length < threshold) continue;
    const recurred = Array.from(g.sigCounts.entries()).filter(([, n]) => n > 1).map(([s]) => s);
    candidates.push({
      agentKind: g.agentKind,
      errorClass: g.errorClass,
      occurrences: g.activityIds.length,
      signatures: g.signatures,
      recurredSignatures: recurred,
      activityIds: g.activityIds,
      sampleReasons: g.reasons,
      specSlug: g.specSlug,
    });
  }
  return candidates;
}

/** guidance-gap (coach) vs code-bug (→ Repair). A real defect is never an instruction tweak. */
export function classifyCoachingRoute(candidate: RepeatedErrorCandidate): "guidance-gap" | "code-bug" {
  if (CODE_BUG_VERDICTS.has(candidate.errorClass)) return "code-bug";
  return "guidance-gap";
}

/** Compose the default learning text for a coachable candidate (the LLM director may override this). */
function composeGuidance(c: RepeatedErrorCandidate): { guidance: string; triggeringPattern: string; reasoning: string } {
  const sig = c.recurredSignatures[0] || c.signatures[0] || "this class of problem";
  const isDismissal = DISMISSAL_VERDICTS.has(c.errorClass);
  const triggeringPattern = `You applied "${c.errorClass}" to ${c.signatures.length || c.occurrences} problem(s)` +
    (c.recurredSignatures.length ? ` and ${c.recurredSignatures.length} of them came back (e.g. "${sig}")` : ` ${c.occurrences} times`) + ".";
  const reasoning = c.recurredSignatures.length
    ? `the same problem recurred after you dispositioned it "${c.errorClass}", so that disposition isn't holding — it was likely wrong`
    : `you keep applying "${c.errorClass}" to this class of problem; double-check it isn't a real issue you're under-calling`;
  const guidance = isDismissal
    ? `Before dismissing a problem like "${sig}" as "${c.errorClass}", verify it is genuinely not ours / transient — if it recurs, treat it as a real issue and trace the root cause instead of dismissing it again.`
    : `When you reach "${c.errorClass}" on a problem like "${sig}", slow down and re-check the root cause — this disposition has been a repeated miss.`;
  return { guidance, triggeringPattern, reasoning };
}

/** One human-readable board line: "🛠️ Ada coached 🔴 Remi: <message>". */
function boardLine(directorFn: string, agentKind: string, verb: string, message: string): string {
  const dp = getPersona(directorFn);
  const wp = getPersona(agentKind);
  return `${dp.emoji} ${dp.name} ${verb} ${wp.emoji} ${wp.name}: ${message}`;
}

export interface CoachingPassOutcome {
  agentKind: string;
  errorClass: string;
  action: "coached" | "routed-to-repair" | "escalated" | "surfaced";
  detail: string;
  attempt?: number;
  instructionId?: string;
  coachingId?: string;
}

export interface CoachingPassResult {
  applied: boolean;
  candidates: number;
  outcomes: CoachingPassOutcome[];
  rechecked: { coachingId: string; status: "stuck" | "recurred" }[];
}

/**
 * The standing coaching pass. Detects repeated errors, then for each COACHABLE candidate (one with a
 * recurred-signature wrongness signal, unless `coachAll` is set): routes a code bug to Repair, escalates
 * to the CEO if it has already been coached ≥ COACHING_ATTEMPTS_BEFORE_ESCALATE times and still recurs,
 * else coaches the worker (amend instructions + log the message + post the board update). Frequency-only
 * candidates (no recurrence) are SURFACED for director review, never auto-coached (no false coaching).
 * Also re-checks pending past coachings: did the class recur after the coaching? → 'recurred' else 'stuck'.
 *
 * dry-run by default — pass `apply:true` to write. Returns a structured plan/result either way.
 */
export async function runAgentCoachingPass(
  admin: Admin,
  workspaceId: string,
  opts: { apply?: boolean; coachAll?: boolean; directorFunction?: string } = {},
): Promise<CoachingPassResult> {
  const apply = opts.apply === true;
  const directorFn = opts.directorFunction ?? COACHING_DIRECTOR_FUNCTION;
  const candidates = await detectRepeatedErrors(admin, workspaceId);
  const outcomes: CoachingPassOutcome[] = [];

  // ── Post-coaching re-check: for each pending coaching, did its class recur AFTER the coaching? ──
  const rechecked: { coachingId: string; status: "stuck" | "recurred" }[] = [];
  const recheckOutcome = await recheckPendingCoachings(admin, workspaceId, { apply });
  rechecked.push(...recheckOutcome);

  for (const c of candidates) {
    const coachable = opts.coachAll === true || c.recurredSignatures.length > 0;
    if (!coachable) {
      outcomes.push({
        agentKind: c.agentKind,
        errorClass: c.errorClass,
        action: "surfaced",
        detail: `applied "${c.errorClass}" ${c.occurrences}× with no recurrence — surfaced for director review, not auto-coached.`,
      });
      continue;
    }

    const route = classifyCoachingRoute(c);

    // Code bug → route to Repair, never an instruction tweak.
    if (route === "code-bug") {
      const sig = c.signatures[0] || `${c.agentKind}-${c.errorClass}`;
      const line = boardLine(directorFn, c.agentKind, "flagged a code bug behind", `repeated "${c.errorClass}" on "${sig}" is a real defect — routing to Repair, not coaching.`);
      if (apply) {
        await enqueueRepairJob(admin, { source: "coaching-router", signature: sig, title: `Coaching router: repeated ${c.errorClass} from ${c.agentKind} (${sig})` });
        await recordDirectorActivity(admin, {
          workspaceId,
          directorFunction: directorFn,
          actionKind: "coaching_routed_to_repair",
          specSlug: c.specSlug,
          reason: line,
          metadata: { agent_kind: c.agentKind, error_class: c.errorClass, signature: sig, source_activity_ids: c.activityIds },
        });
        await postDirectorMessage({ workspaceId, author: "director", authorFunction: directorFn, body: line, kind: "update", metadata: { agent_kind: c.agentKind, error_class: c.errorClass, kind: "code-bug-route" } });
      }
      outcomes.push({ agentKind: c.agentKind, errorClass: c.errorClass, action: "routed-to-repair", detail: line });
      continue;
    }

    // Guidance gap → escalate if already coached N times and still recurring, else coach.
    const priorAttempts = await countCoachings(admin, workspaceId, c.agentKind, c.errorClass);
    if (priorAttempts >= COACHING_ATTEMPTS_BEFORE_ESCALATE) {
      const line = boardLine(directorFn, c.agentKind, "escalated to the CEO about", `"${c.errorClass}" has recurred after ${priorAttempts} coaching attempts — the instruction approach isn't working; needs a deeper look.`);
      if (apply) {
        await recordDirectorActivity(admin, {
          workspaceId,
          directorFunction: directorFn,
          actionKind: "escalated_coaching",
          specSlug: c.specSlug,
          reason: line,
          metadata: { agent_kind: c.agentKind, error_class: c.errorClass, attempts: priorAttempts, source_activity_ids: c.activityIds },
        });
        await postDirectorMessage({ workspaceId, author: "director", authorFunction: directorFn, body: line, kind: "update", mentions: ["ceo"], metadata: { agent_kind: c.agentKind, error_class: c.errorClass, kind: "escalation" } });
      }
      outcomes.push({ agentKind: c.agentKind, errorClass: c.errorClass, action: "escalated", detail: line, attempt: priorAttempts });
      continue;
    }

    // Coach.
    const { guidance, triggeringPattern, reasoning } = composeGuidance(c);
    const line = boardLine(directorFn, c.agentKind, "coached", `${triggeringPattern} ${guidance}`);
    if (apply) {
      const res = await coachAgent(admin, {
        workspaceId,
        agentKind: c.agentKind,
        coachedBy: directorFn,
        errorClass: c.errorClass,
        guidance,
        triggeringPattern,
        reasoning,
        sourceActivityIds: c.activityIds,
      });
      const post = await postDirectorMessage({ workspaceId, author: "director", authorFunction: directorFn, body: line, kind: "update", mentions: [c.agentKind], metadata: { agent_kind: c.agentKind, error_class: c.errorClass, coaching_id: res.coaching.id, kind: "coaching" } });
      await linkCoachingBoardPost(admin, res.coaching.id, post.id);
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: directorFn,
        actionKind: "coached_worker",
        specSlug: c.specSlug,
        reason: line,
        metadata: { agent_kind: c.agentKind, error_class: c.errorClass, attempt: res.attempt, instruction_id: res.instruction.id, source_activity_ids: c.activityIds },
      });
      outcomes.push({ agentKind: c.agentKind, errorClass: c.errorClass, action: "coached", detail: line, attempt: res.attempt, instructionId: res.instruction.id, coachingId: res.coaching.id });
    } else {
      outcomes.push({ agentKind: c.agentKind, errorClass: c.errorClass, action: "coached", detail: `[dry-run] ${line}`, attempt: priorAttempts + 1 });
    }
  }

  return { applied: apply, candidates: candidates.length, outcomes, rechecked };
}

/** How many coaching messages (kind='coaching') a worker has received for a class. */
async function countCoachings(admin: Admin, workspaceId: string, agentKind: string, errorClass: string): Promise<number> {
  const { count } = await admin
    .from("agent_coaching_log")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("agent_kind", agentKind)
    .eq("error_class", errorClass)
    .eq("kind", "coaching");
  return count ?? 0;
}

/**
 * For every coaching whose re-check is still pending, decide whether the learning stuck: did the same
 * (worker, class) disposition recur in director_activity AFTER the coaching timestamp? Recurred →
 * 'recurred' (counts toward escalation next pass); none since → 'stuck'. Best-effort; returns the verdicts.
 */
export async function recheckPendingCoachings(
  admin: Admin,
  workspaceId: string,
  opts: { apply?: boolean } = {},
): Promise<{ coachingId: string; status: "stuck" | "recurred" }[]> {
  const apply = opts.apply === true;
  const { data } = await admin
    .from("agent_coaching_log")
    .select("id, agent_kind, error_class, created_at")
    .eq("workspace_id", workspaceId)
    .eq("kind", "coaching")
    .eq("recheck_status", "pending")
    .order("created_at", { ascending: false })
    .limit(200);
  const pending = (data ?? []) as { id: string; agent_kind: string; error_class: string; created_at: string }[];
  const out: { coachingId: string; status: "stuck" | "recurred" }[] = [];

  for (const p of pending) {
    // Did the worker's disposition class recur after we coached it? (We look for director_activity rows
    // for this worker carrying this verdict, created after the coaching.)
    const { data: after } = await admin
      .from("director_activity")
      .select("id, action_kind, metadata, created_at")
      .eq("workspace_id", workspaceId)
      .gt("created_at", p.created_at)
      .order("created_at", { ascending: false })
      .limit(500);
    let recurred = false;
    for (const r of (after ?? []) as ActivityRow[]) {
      const m = r.metadata ?? {};
      const wk = (typeof m.agent_kind === "string" && m.agent_kind) || workerKindFromAction(r.action_kind);
      const verdict = typeof m.verdict === "string" && m.verdict ? m.verdict : r.action_kind;
      if (wk === p.agent_kind && verdict === p.error_class) { recurred = true; break; }
    }
    // Only conclude 'stuck' once the coaching has had time to take effect (≥1 day old); otherwise leave pending.
    const ageMs = Date.now() - new Date(p.created_at).getTime();
    if (!recurred && ageMs < 24 * 60 * 60 * 1000) continue;
    const status: "stuck" | "recurred" = recurred ? "recurred" : "stuck";
    if (apply) await recordRecheck(admin, p.id, status);
    out.push({ coachingId: p.id, status });
  }
  return out;
}

// Re-export the history reader so callers can pull a worker's coaching history from one module.
export { getAgentCoachingHistory };
export type { AgentCoachingEntry };
