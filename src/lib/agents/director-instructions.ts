/**
 * director-instructions — the per-director mutable instruction store + the CEO-gated coach write path
 * (worker-grading-and-director-management Phase 7). The TOP rung of the cascade: the CEO coaches the
 * Platform/DevOps Director (Ada) the same way she coaches her workers (worker-instructions), one level
 * UP. See docs/brain/tables/director_instructions.md + docs/brain/tables/director_coaching_log.md.
 *
 *   • `loadDirectorInstructions` / `appendDirectorInstructions` — the RUNTIME load. Her decision prompts
 *     (the approval investigation + board-grooming) append her ACTIVE guidance every run, so coaching
 *     changes what she does autonomously with NO deploy.
 *   • `coachDirector` — the CEO-GATED write (from the coaching chat, on approval). Amends her instruction
 *     set (a new active version superseding any prior for the same class) + logs the CEO→director message.
 *   • `getDirectorCoachingHistory` — her coaching history for her profile page.
 *
 * north-star chain: CEO → director → worker. The director NEVER edits her own instructions — only the CEO
 * coaches her: `coachDirector` requires `coachedBy` (the 'ceo' seat), and the tables are service-role-
 * write-only (the box session runs read-only). Mirror worker-instructions.ts one level up.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface DirectorInstruction {
  id: string;
  workspaceId: string;
  directorFunction: string;
  errorClass: string;
  guidance: string;
  triggeringPattern: string;
  reasoning: string;
  status: "active" | "superseded" | "reverted" | string;
  version: number;
  supersedesId: string | null;
  coachedBy: string;
  sourceThreadId: string | null;
  createdAt: string;
}

export interface DirectorCoachingEntry {
  id: string;
  workspaceId: string;
  directorFunction: string;
  coachedBy: string;
  errorClass: string;
  triggeringPattern: string;
  oldInstruction: string | null;
  newInstruction: string;
  reasoning: string;
  instructionId: string | null;
  sourceThreadId: string | null;
  attempt: number;
  kind: string;
  createdAt: string;
}

interface InstructionRow {
  id: string;
  workspace_id: string;
  director_function: string;
  error_class: string;
  guidance: string;
  triggering_pattern: string | null;
  reasoning: string | null;
  status: string;
  version: number;
  supersedes_id: string | null;
  coached_by: string;
  source_thread_id: string | null;
  created_at: string;
}

interface CoachingRow {
  id: string;
  workspace_id: string;
  director_function: string;
  coached_by: string;
  error_class: string;
  triggering_pattern: string | null;
  old_instruction: string | null;
  new_instruction: string | null;
  reasoning: string | null;
  instruction_id: string | null;
  source_thread_id: string | null;
  attempt: number;
  kind: string;
  created_at: string;
}

const INSTRUCTION_COLS =
  "id, workspace_id, director_function, error_class, guidance, triggering_pattern, reasoning, status, version, supersedes_id, coached_by, source_thread_id, created_at";
const COACHING_COLS =
  "id, workspace_id, director_function, coached_by, error_class, triggering_pattern, old_instruction, new_instruction, reasoning, instruction_id, source_thread_id, attempt, kind, created_at";

function toInstruction(r: InstructionRow): DirectorInstruction {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    directorFunction: r.director_function,
    errorClass: r.error_class,
    guidance: r.guidance,
    triggeringPattern: r.triggering_pattern ?? "",
    reasoning: r.reasoning ?? "",
    status: r.status,
    version: r.version,
    supersedesId: r.supersedes_id,
    coachedBy: r.coached_by,
    sourceThreadId: r.source_thread_id,
    createdAt: r.created_at,
  };
}

function toCoaching(r: CoachingRow): DirectorCoachingEntry {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    directorFunction: r.director_function,
    coachedBy: r.coached_by,
    errorClass: r.error_class,
    triggeringPattern: r.triggering_pattern ?? "",
    oldInstruction: r.old_instruction,
    newInstruction: r.new_instruction ?? "",
    reasoning: r.reasoning ?? "",
    instructionId: r.instruction_id,
    sourceThreadId: r.source_thread_id,
    attempt: r.attempt,
    kind: r.kind,
    createdAt: r.created_at,
  };
}

/**
 * Load a director's ACTIVE guidance, newest-first. Best-effort: returns [] if the table isn't present yet
 * (so a runtime caller never crashes on a missing migration).
 */
export async function loadDirectorInstructions(admin: Admin, workspaceId: string, directorFunction: string): Promise<DirectorInstruction[]> {
  try {
    const { data, error } = await admin
      .from("director_instructions")
      .select(INSTRUCTION_COLS)
      .eq("workspace_id", workspaceId)
      .eq("director_function", directorFunction)
      .eq("status", "active")
      .order("created_at", { ascending: false });
    if (error) {
      console.warn(`[director-instructions] load failed (${directorFunction}):`, error.message);
      return [];
    }
    return (data ?? []).map((r) => toInstruction(r as InstructionRow));
  } catch (err) {
    console.warn("[director-instructions] loadDirectorInstructions threw:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** Render active guidance as a prompt block (empty string when there are none). */
export function formatDirectorInstructions(instructions: DirectorInstruction[]): string {
  if (!instructions.length) return "";
  const lines = instructions.map((i, idx) => {
    const why = i.reasoning ? ` (because ${i.reasoning})` : "";
    return `${idx + 1}. ${i.guidance}${why}`;
  });
  return [`## Coaching from the CEO (obey these — they override your defaults within your leash)`, ...lines].join("\n");
}

/**
 * The RUNTIME helper her decision prompts call: append her active CEO coaching to a base prompt. Returns
 * the base prompt unchanged when there's no guidance. Never throws (best-effort).
 */
export async function appendDirectorInstructions(admin: Admin, workspaceId: string, directorFunction: string, basePrompt: string): Promise<string> {
  const instructions = await loadDirectorInstructions(admin, workspaceId, directorFunction);
  const block = formatDirectorInstructions(instructions);
  return block ? `${basePrompt}\n\n${block}` : basePrompt;
}

export interface CoachDirectorInput {
  workspaceId: string;
  /** the director being coached (a function slug, e.g. 'platform'). */
  directorFunction: string;
  /** the coaching seat — 'ceo' (the gate: the director can't coach herself). */
  coachedBy: string;
  /** the class of decision the guidance addresses (supersede/dedup key). */
  errorClass: string;
  /** the new learning: "when you see X, do Y instead". */
  guidance: string;
  /** the human-readable triggering pattern (what prompted the coaching). */
  triggeringPattern: string;
  /** the "why" (the Z). */
  reasoning: string;
  /** the coaching thread this was distilled from, if any. */
  sourceThreadId?: string | null;
}

export interface CoachDirectorResult {
  instruction: DirectorInstruction;
  coaching: DirectorCoachingEntry;
  attempt: number;
}

/**
 * The CEO-GATED coach action (mirror worker-instructions.coachAgent one level up). Amends the director's
 * instruction set (a new active version superseding any prior active for the SAME class), logs the
 * CEO→director message (old→new diff + the attempt count), and returns both rows. Throws on a write error.
 *
 * CEO-gated: `coachedBy` is REQUIRED — the director never supplies it for herself, and the tables are
 * service-role-write-only.
 */
export async function coachDirector(admin: Admin, input: CoachDirectorInput): Promise<CoachDirectorResult> {
  if (!input.coachedBy) throw new Error("coachDirector: coachedBy (the coaching seat) is required — coaching is CEO-gated");

  // Find the prior active instruction for this (director, class) → supersede it (versioning + the diff).
  const { data: priorRows } = await admin
    .from("director_instructions")
    .select(INSTRUCTION_COLS)
    .eq("workspace_id", input.workspaceId)
    .eq("director_function", input.directorFunction)
    .eq("error_class", input.errorClass)
    .eq("status", "active")
    .order("version", { ascending: false })
    .limit(1);
  const prior = priorRows && priorRows[0] ? toInstruction(priorRows[0] as InstructionRow) : null;

  // Attempt count = prior coaching messages for this (director, class) + 1.
  const { count: priorCoachings } = await admin
    .from("director_coaching_log")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", input.workspaceId)
    .eq("director_function", input.directorFunction)
    .eq("error_class", input.errorClass)
    .eq("kind", "coaching");
  const attempt = (priorCoachings ?? 0) + 1;

  // Insert the new ACTIVE instruction (it supersedes the prior).
  const { data: insRow, error: insErr } = await admin
    .from("director_instructions")
    .insert({
      workspace_id: input.workspaceId,
      director_function: input.directorFunction,
      error_class: input.errorClass,
      guidance: input.guidance,
      triggering_pattern: input.triggeringPattern,
      reasoning: input.reasoning,
      status: "active",
      version: prior ? prior.version + 1 : 1,
      supersedes_id: prior?.id ?? null,
      coached_by: input.coachedBy,
      source_thread_id: input.sourceThreadId ?? null,
    })
    .select(INSTRUCTION_COLS)
    .single();
  if (insErr) throw insErr;
  const instruction = toInstruction(insRow as InstructionRow);

  // Retire the prior active instruction for this class.
  if (prior) {
    await admin.from("director_instructions").update({ status: "superseded", updated_at: new Date().toISOString() }).eq("id", prior.id);
  }

  // Log the CEO→director message (the visible communication).
  const { data: logRow, error: logErr } = await admin
    .from("director_coaching_log")
    .insert({
      workspace_id: input.workspaceId,
      director_function: input.directorFunction,
      coached_by: input.coachedBy,
      error_class: input.errorClass,
      triggering_pattern: input.triggeringPattern,
      old_instruction: prior?.guidance ?? null,
      new_instruction: input.guidance,
      reasoning: input.reasoning,
      instruction_id: instruction.id,
      source_thread_id: input.sourceThreadId ?? null,
      attempt,
      kind: "coaching",
    })
    .select(COACHING_COLS)
    .single();
  if (logErr) throw logErr;

  return { instruction, coaching: toCoaching(logRow as CoachingRow), attempt };
}

/** A director's coaching history (newest-first) for her profile page. Best-effort. */
export async function getDirectorCoachingHistory(admin: Admin, workspaceId: string, directorFunction: string, limit = 50): Promise<DirectorCoachingEntry[]> {
  try {
    const { data } = await admin
      .from("director_coaching_log")
      .select(COACHING_COLS)
      .eq("workspace_id", workspaceId)
      .eq("director_function", directorFunction)
      .order("created_at", { ascending: false })
      .limit(limit);
    return (data ?? []).map((r) => toCoaching(r as CoachingRow));
  } catch (err) {
    console.warn("[director-instructions] getDirectorCoachingHistory threw:", err instanceof Error ? err.message : err);
    return [];
  }
}
