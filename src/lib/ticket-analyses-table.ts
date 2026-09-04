/**
 * ticket-analyses-table — the typed read/write surface for `public.ticket_analyses`
 * ([[../tables/ticket_analyses]]).
 *
 * Phase 2 of docs/brain/specs/ticket-analyzer-becomes-box-agent-under-june.md. Mirrors the
 * specs-table PM SDK ([[../operational-rules]] § Database is the spec): every write to the
 * `ticket_analyses` table goes through the narrow writers here (`insertAnalysis`,
 * `applyAdminOverride`, `applyAgentRescore`), never a raw `.from('ticket_analyses').insert(…)`
 * or `.update(…)`. The static guard `scripts/_check-ticket-analyses-sdk-compliance.ts` scans
 * `src/lib/**` + `scripts/builder-worker.ts` and CI-red on any raw write outside the SDK.
 *
 * Reads (`getLatestForTicket`, `listForTicket`) are exposed too so the same callers can drop
 * their raw `.from('ticket_analyses').select(…)` chains in one migration; the guard is
 * write-only (mirrors the PM-SDK guard's WRITE_VERBS scope).
 *
 * Service-role only (the row has RLS `select` for workspace members; `all` for `service_role`).
 * All callers go through `createAdminClient()`.
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * One element of `TicketAnalysisRow.issues`. Refutation fields are stamped by
 * `refuteAnalysisIssue` when a reviewer determines the finding is void — every
 * consumer that DECIDES on findings must then filter through `activeIssues(row)`.
 * Historical rows lack these fields (JSONB, no migration), so all three are
 * optional and read as null when absent.
 */
export interface TicketAnalysisIssue {
  type: string;
  description: string;
  refuted_at?: string | null;
  refuted_by?: string | null;
  refutation_reason?: string | null;
}

/** One row of `public.ticket_analyses` (fields the app reads today). */
export interface TicketAnalysisRow {
  id: string;
  workspace_id: string;
  ticket_id: string;
  window_start: string;
  window_end: string;
  score: number | null;
  issues: TicketAnalysisIssue[];
  action_items: { priority: string; description: string }[];
  summary: string | null;
  admin_score: number | null;
  admin_score_reason: string | null;
  admin_corrected_at: string | null;
  admin_corrected_by: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  trigger: string | null;
  ai_message_count: number;
  /**
   * Whether the analyzer run that produced THIS row was billed against the Max subscription
   * (a box lane, $0 marginal) or against a real per-token API bill (the deployed analyzer's
   * fallback path). Null on historical rows (unknown). Mirrors the apiBilled flag on
   * [[fleet-cost]] recordAgentJobCost — 'max' ↔ apiBilled=false, 'api' ↔ apiBilled=true.
   */
  billing_source: "max" | "api" | null;
  created_at: string;
}

/** Insert input — the analyzer-authored fields. Admin-override fields land via `applyAdminOverride`. */
export interface InsertAnalysisInput {
  workspaceId: string;
  ticketId: string;
  windowStart: string;
  windowEnd: string;
  score: number;
  issues: TicketAnalysisIssue[];
  actionItems: { priority: string; description: string }[];
  summary: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  /** 'auto_close' | 'manual_close' | 'reopen_close' | 'manual' — same enum ticket_analyses.trigger takes. */
  trigger: string;
  aiMessageCount: number;
  /**
   * True when the analyzer run was billed against the paid API (deployed-analyzer fallback path
   * when the box is down); false when it ran on the Max subscription box lane. Mirrors the
   * apiBilled flag on [[fleet-cost]] recordAgentJobCost so the SAME contract flows all the way
   * into `ticket_analyses.billing_source` — we NEVER invent a parallel concept. Undefined =
   * historical/unknown; the row is persisted with `billing_source: null` so the honest "we
   * didn't record it" tag is preserved (not retroactively mislabelled as either lane).
   */
  apiBilled?: boolean;
}

/**
 * Insert a fresh `ticket_analyses` row from the analyzer's verdict. The single writer callers use
 * from Phase 1's `applyAnalyzerVerdict` (src/lib/ticket-analyzer.ts) — the row's `id` is returned
 * so the caller can thread it through downstream audit writes (the analyzer's system note carries
 * the analysis id; Phase 2 director_activity records it in metadata).
 */
export async function insertAnalysis(input: InsertAnalysisInput): Promise<{ id: string | null; error: string | null }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ticket_analyses")
    .insert({
      workspace_id: input.workspaceId,
      ticket_id: input.ticketId,
      window_start: input.windowStart,
      window_end: input.windowEnd,
      score: input.score,
      issues: input.issues,
      action_items: input.actionItems,
      summary: input.summary,
      model: input.model,
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
      cost_cents: input.costCents,
      trigger: input.trigger,
      ai_message_count: input.aiMessageCount,
      billing_source:
        input.apiBilled === undefined
          ? null
          : input.apiBilled
          ? "api"
          : "max",
    })
    .select("id")
    .single();
  if (error) return { id: null, error: error.message };
  return { id: (data as { id: string } | null)?.id ?? null, error: null };
}

/**
 * The latest analysis on a ticket (highest window_end). Used by the analyzer's window resolver
 * ("start of the next window = last window_end", src/lib/ticket-analyzer.ts) and by the admin-
 * override + rescore paths ("which row to correct").
 */
export async function getLatestForTicket(
  ticketId: string,
  opts?: { workspaceId?: string; select?: string },
): Promise<Record<string, unknown> | null> {
  const admin = createAdminClient();
  const select = opts?.select ?? "id, ticket_id, workspace_id, score, issues, summary, window_end";
  let q = admin.from("ticket_analyses").select(select).eq("ticket_id", ticketId);
  if (opts?.workspaceId) q = q.eq("workspace_id", opts.workspaceId);
  const { data } = await q.order("window_end", { ascending: false }).limit(1).maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

/**
 * All analyses on a ticket, oldest→newest. Used by the ticket-analysis viewer +
 * inspect-playbook-vs-analysis debug script. Callers pass a projection so we don't fetch the whole
 * (occasionally-wide) row set by default.
 */
export async function listForTicket(
  ticketId: string,
  opts?: { workspaceId?: string; select?: string; limit?: number; order?: "asc" | "desc" },
): Promise<Record<string, unknown>[]> {
  const admin = createAdminClient();
  const select = opts?.select ?? "id, score, admin_score, issues, action_items, summary, created_at, window_end";
  let q = admin.from("ticket_analyses").select(select).eq("ticket_id", ticketId);
  if (opts?.workspaceId) q = q.eq("workspace_id", opts.workspaceId);
  q = q.order("created_at", { ascending: (opts?.order ?? "asc") === "asc" });
  if (opts?.limit) q = q.limit(opts.limit);
  const { data } = await q;
  return ((data as Record<string, unknown>[] | null) ?? []);
}

/**
 * Human admin override — the calibration signal that drives grader_prompts. The write is a
 * compare-and-set against the row `id` AND the `workspace_id` we authenticated the caller on, so
 * a cross-workspace id sneak (the admin route's `admin_score` update) can never overwrite another
 * workspace's row. `.select("id")` confirms exactly one row transitioned.
 *
 * `admin_corrected_at` is stamped by the SDK (not the caller) so every override lands with a
 * server-owned timestamp — a caller-provided timestamp could otherwise drift on clock skew.
 */
export async function applyAdminOverride(input: {
  analysisId: string;
  workspaceId: string;
  score: number;
  reason: string;
  correctedBy: string;
}): Promise<{ ok: boolean; error: string | null }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ticket_analyses")
    .update({
      admin_score: input.score,
      admin_score_reason: input.reason,
      admin_corrected_at: new Date().toISOString(),
      admin_corrected_by: input.correctedBy,
    })
    .eq("id", input.analysisId)
    .eq("workspace_id", input.workspaceId) // guard: never cross workspaces on a raw id
    .select("id");
  if (error) return { ok: false, error: error.message };
  const rows = (data as { id: string }[] | null) ?? [];
  if (rows.length !== 1) return { ok: false, error: `applyAdminOverride: ${rows.length} rows transitioned (expected 1)` };
  return { ok: true, error: null };
}

/**
 * Agent-authored rescore (from the escalation-triage `ticket_analysis_rescore` approved todo) —
 * corrects the box's own prior score + summary + issues in place. Distinct from `applyAdminOverride`
 * because the caller is an AGENT proposal, not a human — no `admin_corrected_by` (only humans set
 * that column), and the free-text reason names the escalation-triage source. Same compare-and-set
 * guard as `applyAdminOverride`.
 *
 * CARRY-FORWARD GUARD (spec: refuted-qc-findings-must-be-marked-not-just-argued Phase 1). A
 * rescore that REPLACES `issues` cannot silently drop refutations recorded by
 * `refuteAnalysisIssue` — that would revive a finding a reviewer already disproved. So:
 *   1. Read the existing row's `issues` first;
 *   2. If any existing element has `refuted_at != null`, carry those refutation fields forward
 *      onto the same index of the new array;
 *   3. If the new array is SHORTER than the highest refuted index, refuse the write (returns
 *      `{ ok:false, error }`) — the caller must include a slot for every refuted entry.
 */
export async function applyAgentRescore(input: {
  analysisId: string;
  workspaceId: string;
  score?: number;
  summary?: string;
  issues?: TicketAnalysisIssue[];
  source: string; // e.g. 'escalation-triage:approved'
}): Promise<{ ok: boolean; error: string | null }> {
  const admin = createAdminClient();
  let nextIssues: TicketAnalysisIssue[] | undefined = input.issues;
  if (nextIssues !== undefined) {
    const { data: existing, error: readErr } = await admin
      .from("ticket_analyses")
      .select("issues")
      .eq("id", input.analysisId)
      .eq("workspace_id", input.workspaceId)
      .maybeSingle();
    if (readErr) return { ok: false, error: readErr.message };
    if (!existing) return { ok: false, error: "applyAgentRescore: analysis row not found" };
    const prev = ((existing as { issues: TicketAnalysisIssue[] | null }).issues) ?? [];
    let highestRefutedIdx = -1;
    for (let i = 0; i < prev.length; i += 1) {
      if (prev[i]?.refuted_at) highestRefutedIdx = i;
    }
    if (highestRefutedIdx >= nextIssues.length) {
      return {
        ok: false,
        error: `applyAgentRescore: new issues array (len=${nextIssues.length}) is shorter than highest refuted index (${highestRefutedIdx}) — refutation would be lost`,
      };
    }
    nextIssues = nextIssues.map((next, i) => {
      const prevIssue = prev[i];
      if (prevIssue?.refuted_at) {
        return {
          ...next,
          refuted_at: prevIssue.refuted_at,
          refuted_by: prevIssue.refuted_by ?? null,
          refutation_reason: prevIssue.refutation_reason ?? null,
        };
      }
      return next;
    });
  }
  const patch: Record<string, unknown> = {
    admin_score: input.score,
    admin_score_reason: `Rescored by ${input.source}`,
    admin_corrected_at: new Date().toISOString(),
  };
  if (typeof input.summary === "string") patch.summary = input.summary;
  if (nextIssues !== undefined) patch.issues = nextIssues;
  const { data, error } = await admin
    .from("ticket_analyses")
    .update(patch)
    .eq("id", input.analysisId)
    .eq("workspace_id", input.workspaceId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  const rows = (data as { id: string }[] | null) ?? [];
  if (rows.length !== 1) return { ok: false, error: `applyAgentRescore: ${rows.length} rows transitioned (expected 1)` };
  return { ok: true, error: null };
}

/**
 * Stamp ONE element of `ticket_analyses.issues` as refuted. Ground truth: ticket b28e7744
 * (Juana) — Cora's deep pass raised two 'inaccuracy' findings that were both wrong; a reviewer
 * refuted them in an internal note that same afternoon, but the analysis row itself was never
 * touched, and four hours later the CS director cited the same substance and escalated to the
 * founder. This SDK writer makes the refutation a durable, machine-readable fact on the row so
 * every downstream consumer (via `activeIssues`) stops treating a disproven finding as live.
 *
 * Semantics:
 *   - Bounds-checks `issueIndex` against the current array (out-of-range → `{ ok:false, error }`,
 *     never a silent no-op).
 *   - Refuting an already-refuted entry is idempotent — the original `refuted_at` / `refuted_by`
 *     / `refutation_reason` are preserved (a re-run doesn't overwrite the audit trail).
 *   - Same compare-and-set guard as the neighbouring writers: `.eq("id", …).eq("workspace_id", …)
 *     .select("id")` asserting exactly one row transitioned.
 */
export async function refuteAnalysisIssue(input: {
  analysisId: string;
  workspaceId: string;
  issueIndex: number;
  reason: string;
  refutedBy: string;
}): Promise<{ ok: boolean; error: string | null }> {
  if (!Number.isInteger(input.issueIndex) || input.issueIndex < 0) {
    return { ok: false, error: `refuteAnalysisIssue: issueIndex must be a non-negative integer (got ${input.issueIndex})` };
  }
  if (!input.reason.trim()) {
    return { ok: false, error: "refuteAnalysisIssue: reason must be non-empty" };
  }
  if (!input.refutedBy.trim()) {
    return { ok: false, error: "refuteAnalysisIssue: refutedBy must be non-empty" };
  }
  const admin = createAdminClient();
  const { data: existing, error: readErr } = await admin
    .from("ticket_analyses")
    .select("id, ticket_id, issues")
    .eq("id", input.analysisId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!existing) return { ok: false, error: "refuteAnalysisIssue: analysis row not found" };
  const existingRow = existing as { id: string; ticket_id: string; issues: TicketAnalysisIssue[] | null };
  const issues = existingRow.issues ?? [];
  if (input.issueIndex >= issues.length) {
    return {
      ok: false,
      error: `refuteAnalysisIssue: issueIndex ${input.issueIndex} out of range (issues.length=${issues.length})`,
    };
  }
  const current = issues[input.issueIndex];
  if (current.refuted_at) {
    // idempotent: preserve the original refutation and do NOT re-post the thread note.
    return { ok: true, error: null };
  }
  const nextIssues = issues.map((issue, i) =>
    i === input.issueIndex
      ? {
          ...issue,
          refuted_at: new Date().toISOString(),
          refuted_by: input.refutedBy,
          refutation_reason: input.reason,
        }
      : issue,
  );
  const { data, error } = await admin
    .from("ticket_analyses")
    .update({ issues: nextIssues })
    .eq("id", input.analysisId)
    .eq("workspace_id", input.workspaceId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  const rows = (data as { id: string }[] | null) ?? [];
  if (rows.length !== 1) return { ok: false, error: `refuteAnalysisIssue: ${rows.length} rows transitioned (expected 1)` };

  // Phase 3: post the companion `[Cora Analysis — REFUTED]` internal note on the thread so a
  // thread-reading director sees the claim and its rebuttal adjacent (b28e7744 failure mode).
  // Dynamic import to avoid a load-time circular ticket-analyzer ↔ ticket-analyses-table dep.
  // Best-effort — the row write is authoritative; the note is a thread-side mirror.
  try {
    const { postCoraRefutedNote } = await import("@/lib/ticket-analyzer");
    await postCoraRefutedNote(admin, {
      ticketId: existingRow.ticket_id,
      issueType: current.type,
      reason: input.reason,
      refutedBy: input.refutedBy,
      analysisId: existingRow.id,
    });
  } catch (err) {
    console.warn("[ticket-analyses-table] refuteAnalysisIssue: thread note failed:", err instanceof Error ? err.message : err);
  }

  return { ok: true, error: null };
}

/**
 * The accessor every DECIDING consumer switches to (Phase 2). Returns only issues whose
 * `refuted_at` is null — a refuted entry stops driving reopen/escalate, research-recipe
 * selection, and the daily report. A surface that DISPLAYS the audit trail keeps the full
 * `row.issues` and marks refuted entries; only decision surfaces call `activeIssues`.
 */
export function activeIssues(row: { issues: TicketAnalysisIssue[] | null | undefined }): TicketAnalysisIssue[] {
  const issues = row.issues ?? [];
  return issues.filter((issue) => !issue?.refuted_at);
}
