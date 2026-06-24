/**
 * worker-instructions — the per-worker mutable instruction store + the director-gated coach write path
 * (worker-coaching-loop spec, Phase 1). See docs/brain/tables/agent_instructions.md +
 * docs/brain/tables/agent_coaching_log.md.
 *
 * The mechanism the DevOps Director uses to TEACH its workers without a deploy:
 *   • `loadAgentInstructions` / `appendAgentInstructions` — the RUNTIME load. Every worker run reads
 *     its ACTIVE guidance and appends it to the base prompt (called from scripts/builder-worker.ts).
 *   • `coachAgent` — the DIRECTOR-GATED write. When the director spots a repeated mistake it amends the
 *     worker's instruction set (a new active version, superseding any prior for the same error class),
 *     logs the director→worker message (the old→new diff + pattern), posts it to the #directors board,
 *     and records a director_activity row. Coaching = a data write, not a deploy.
 *   • `revertCoaching` — every amendment is reversible (status → 'reverted').
 *   • `getAgentCoachingHistory` — the worker's coaching history for its profile page.
 *
 * north-star chain: CEO → director → worker. The worker NEVER edits its own instructions — only its
 * director coaches it. Enforced two ways: `coachAgent` requires a `coachedBy` director slug, and the
 * tables are service-role-write-only (a worker runs read-only and has no write path). See
 * [[docs/brain/operational-rules.md]] § North star.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** A row in `agent_instructions` — one versioned learning for a worker. */
export interface AgentInstruction {
  id: string;
  workspaceId: string;
  agentKind: string;
  errorClass: string;
  guidance: string;
  triggeringPattern: string;
  reasoning: string;
  status: "active" | "superseded" | "reverted" | string;
  version: number;
  supersedesId: string | null;
  coachedBy: string;
  sourceGradeId: string | null;
  createdAt: string;
}

/** A row in `agent_coaching_log` — one director→worker communication. */
export interface AgentCoachingEntry {
  id: string;
  workspaceId: string;
  agentKind: string;
  coachedBy: string;
  errorClass: string;
  triggeringPattern: string;
  oldInstruction: string | null;
  newInstruction: string;
  reasoning: string;
  instructionId: string | null;
  sourceActivityIds: string[];
  attempt: number;
  kind: "coaching" | "code-bug-route" | "escalation" | string;
  recheckStatus: "pending" | "stuck" | "recurred" | string;
  recheckedAt: string | null;
  boardMessageId: string | null;
  createdAt: string;
}

interface InstructionRow {
  id: string;
  workspace_id: string;
  agent_kind: string;
  error_class: string;
  guidance: string;
  triggering_pattern: string | null;
  reasoning: string | null;
  status: string;
  version: number;
  supersedes_id: string | null;
  coached_by: string;
  source_grade_id: string | null;
  created_at: string;
}

interface CoachingRow {
  id: string;
  workspace_id: string;
  agent_kind: string;
  coached_by: string;
  error_class: string;
  triggering_pattern: string | null;
  old_instruction: string | null;
  new_instruction: string | null;
  reasoning: string | null;
  instruction_id: string | null;
  source_activity_ids: unknown;
  attempt: number;
  kind: string;
  recheck_status: string;
  rechecked_at: string | null;
  board_message_id: string | null;
  created_at: string;
}

function toInstruction(r: InstructionRow): AgentInstruction {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    agentKind: r.agent_kind,
    errorClass: r.error_class,
    guidance: r.guidance,
    triggeringPattern: r.triggering_pattern ?? "",
    reasoning: r.reasoning ?? "",
    status: r.status,
    version: r.version,
    supersedesId: r.supersedes_id,
    coachedBy: r.coached_by,
    sourceGradeId: r.source_grade_id,
    createdAt: r.created_at,
  };
}

function toCoaching(r: CoachingRow): AgentCoachingEntry {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    agentKind: r.agent_kind,
    coachedBy: r.coached_by,
    errorClass: r.error_class,
    triggeringPattern: r.triggering_pattern ?? "",
    oldInstruction: r.old_instruction,
    newInstruction: r.new_instruction ?? "",
    reasoning: r.reasoning ?? "",
    instructionId: r.instruction_id,
    sourceActivityIds: Array.isArray(r.source_activity_ids) ? (r.source_activity_ids as string[]) : [],
    attempt: r.attempt,
    kind: r.kind,
    recheckStatus: r.recheck_status,
    recheckedAt: r.rechecked_at,
    boardMessageId: r.board_message_id,
    createdAt: r.created_at,
  };
}

const INSTRUCTION_COLS =
  "id, workspace_id, agent_kind, error_class, guidance, triggering_pattern, reasoning, status, version, supersedes_id, coached_by, source_grade_id, created_at";
const COACHING_COLS =
  "id, workspace_id, agent_kind, coached_by, error_class, triggering_pattern, old_instruction, new_instruction, reasoning, instruction_id, source_activity_ids, attempt, kind, recheck_status, rechecked_at, board_message_id, created_at";

/**
 * Load a worker's ACTIVE guidance (the learnings it should obey), newest-first. Best-effort: returns
 * [] if the table isn't present yet (so a runtime caller never crashes on a missing migration).
 */
export async function loadAgentInstructions(
  admin: Admin,
  workspaceId: string,
  agentKind: string,
): Promise<AgentInstruction[]> {
  try {
    const { data, error } = await admin
      .from("agent_instructions")
      .select(INSTRUCTION_COLS)
      .eq("workspace_id", workspaceId)
      .eq("agent_kind", agentKind)
      .eq("status", "active")
      .order("created_at", { ascending: false });
    if (error) {
      console.warn(`[worker-instructions] load failed (${agentKind}):`, error.message);
      return [];
    }
    return (data ?? []).map((r) => toInstruction(r as InstructionRow));
  } catch (err) {
    console.warn("[worker-instructions] loadAgentInstructions threw:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** Render active guidance as a prompt block (empty string when there are none). */
export function formatAgentInstructions(instructions: AgentInstruction[]): string {
  if (!instructions.length) return "";
  const lines = instructions.map((i, idx) => {
    const why = i.reasoning ? ` (because ${i.reasoning})` : "";
    return `${idx + 1}. ${i.guidance}${why}`;
  });
  return [
    `## Coaching guidance (learnings from your director — obey these)`,
    `Your director has coached you on past mistakes. Apply each learning before deciding:`,
    ...lines,
  ].join("\n");
}

/**
 * The RUNTIME helper a worker run calls: append the worker's active coaching guidance to its base
 * prompt. Returns the base prompt unchanged when there is no guidance. Never throws.
 */
export async function appendAgentInstructions(
  admin: Admin,
  workspaceId: string,
  agentKind: string,
  basePrompt: string,
): Promise<string> {
  const instructions = await loadAgentInstructions(admin, workspaceId, agentKind);
  const block = formatAgentInstructions(instructions);
  return block ? `${basePrompt}\n\n${block}` : basePrompt;
}

export interface CoachAgentInput {
  workspaceId: string;
  /** the worker being coached (an agent_jobs kind, e.g. 'repair'). */
  agentKind: string;
  /** the SUPERVISING director's function slug (e.g. 'platform') — the gate: a worker can't pass this for itself. */
  coachedBy: string;
  /** the class of mistake (supersede/dedup key). */
  errorClass: string;
  /** the new learning: "when you see X, do Y instead". */
  guidance: string;
  /** the human-readable triggering pattern (the repeated mistake). */
  triggeringPattern: string;
  /** the "why" (the Z). */
  reasoning: string;
  /** the director_activity rows that prompted it. */
  sourceActivityIds?: string[];
  /** the director_decision_grade that prompted it (director-loop-grading), if any. */
  sourceGradeId?: string | null;
}

export interface CoachAgentResult {
  instruction: AgentInstruction;
  coaching: AgentCoachingEntry;
  attempt: number;
}

/**
 * The DIRECTOR-GATED coach action. Amends a worker's instruction set (a new active version that
 * supersedes any prior active instruction for the SAME error class), logs the director→worker message
 * (old→new diff + pattern + the activity rows that prompted it + the attempt count), and returns both
 * rows. The board post + director_activity write are done by the caller (the coaching pass) so this
 * stays a pure data write that any host can reuse. Throws on a write error (the caller decides recovery).
 *
 * Director-gated: `coachedBy` is REQUIRED and is the supervising director's slug — the worker never
 * supplies it for itself, and the tables are service-role-write-only.
 */
export async function coachAgent(admin: Admin, input: CoachAgentInput): Promise<CoachAgentResult> {
  if (!input.coachedBy) throw new Error("coachAgent: coachedBy (the supervising director) is required — coaching is director-gated");

  // Find the prior active instruction for this (worker, class) → supersede it (versioning + the diff).
  const { data: priorRows } = await admin
    .from("agent_instructions")
    .select(INSTRUCTION_COLS)
    .eq("workspace_id", input.workspaceId)
    .eq("agent_kind", input.agentKind)
    .eq("error_class", input.errorClass)
    .eq("status", "active")
    .order("version", { ascending: false })
    .limit(1);
  const prior = priorRows && priorRows[0] ? toInstruction(priorRows[0] as InstructionRow) : null;

  // Attempt count = prior coaching messages for this (worker, class) + 1.
  const { count: priorCoachings } = await admin
    .from("agent_coaching_log")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", input.workspaceId)
    .eq("agent_kind", input.agentKind)
    .eq("error_class", input.errorClass)
    .eq("kind", "coaching");
  const attempt = (priorCoachings ?? 0) + 1;

  // Insert the new ACTIVE instruction (it supersedes the prior).
  const { data: insRow, error: insErr } = await admin
    .from("agent_instructions")
    .insert({
      workspace_id: input.workspaceId,
      agent_kind: input.agentKind,
      error_class: input.errorClass,
      guidance: input.guidance,
      triggering_pattern: input.triggeringPattern,
      reasoning: input.reasoning,
      status: "active",
      version: prior ? prior.version + 1 : 1,
      supersedes_id: prior?.id ?? null,
      coached_by: input.coachedBy,
      source_grade_id: input.sourceGradeId ?? null,
    })
    .select(INSTRUCTION_COLS)
    .single();
  if (insErr) throw insErr;
  const instruction = toInstruction(insRow as InstructionRow);

  // Retire the prior active instruction for this class.
  if (prior) {
    await admin.from("agent_instructions").update({ status: "superseded", updated_at: new Date().toISOString() }).eq("id", prior.id);
  }

  // Log the director→worker message (the visible communication).
  const { data: logRow, error: logErr } = await admin
    .from("agent_coaching_log")
    .insert({
      workspace_id: input.workspaceId,
      agent_kind: input.agentKind,
      coached_by: input.coachedBy,
      error_class: input.errorClass,
      triggering_pattern: input.triggeringPattern,
      old_instruction: prior?.guidance ?? null,
      new_instruction: input.guidance,
      reasoning: input.reasoning,
      instruction_id: instruction.id,
      source_activity_ids: input.sourceActivityIds ?? [],
      attempt,
      kind: "coaching",
      recheck_status: "pending",
    })
    .select(COACHING_COLS)
    .single();
  if (logErr) throw logErr;

  return { instruction, coaching: toCoaching(logRow as CoachingRow), attempt };
}

/** Stamp the #directors board post id onto a coaching log row (after the caller posts it). */
export async function linkCoachingBoardPost(admin: Admin, coachingId: string, boardMessageId: string): Promise<void> {
  await admin.from("agent_coaching_log").update({ board_message_id: boardMessageId }).eq("id", coachingId);
}

/** Revert a coaching amendment — the learning stops being loaded (status → 'reverted'). Reversible by design. */
export async function revertCoaching(admin: Admin, instructionId: string): Promise<void> {
  await admin
    .from("agent_instructions")
    .update({ status: "reverted", updated_at: new Date().toISOString() })
    .eq("id", instructionId);
}

/** A worker's coaching history (its profile page reads this), newest-first. */
export async function getAgentCoachingHistory(
  admin: Admin,
  workspaceId: string,
  agentKind: string,
  limit = 50,
): Promise<AgentCoachingEntry[]> {
  try {
    const { data, error } = await admin
      .from("agent_coaching_log")
      .select(COACHING_COLS)
      .eq("workspace_id", workspaceId)
      .eq("agent_kind", agentKind)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      console.warn(`[worker-instructions] history failed (${agentKind}):`, error.message);
      return [];
    }
    return (data ?? []).map((r) => toCoaching(r as CoachingRow));
  } catch (err) {
    console.warn("[worker-instructions] getAgentCoachingHistory threw:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** Update a coaching log row's post-coaching re-check verdict ('stuck' = fixed · 'recurred' = didn't take). */
export async function recordRecheck(
  admin: Admin,
  coachingId: string,
  status: "stuck" | "recurred",
): Promise<void> {
  await admin
    .from("agent_coaching_log")
    .update({ recheck_status: status, rechecked_at: new Date().toISOString() })
    .eq("id", coachingId);
}
