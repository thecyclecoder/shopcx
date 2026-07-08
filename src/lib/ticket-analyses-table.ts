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

/** One row of `public.ticket_analyses` (fields the app reads today). */
export interface TicketAnalysisRow {
  id: string;
  workspace_id: string;
  ticket_id: string;
  window_start: string;
  window_end: string;
  score: number | null;
  issues: { type: string; description: string }[];
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
  issues: { type: string; description: string }[];
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
 */
export async function applyAgentRescore(input: {
  analysisId: string;
  workspaceId: string;
  score?: number;
  summary?: string;
  issues?: unknown;
  source: string; // e.g. 'escalation-triage:approved'
}): Promise<{ ok: boolean; error: string | null }> {
  const admin = createAdminClient();
  const patch: Record<string, unknown> = {
    admin_score: input.score,
    admin_score_reason: `Rescored by ${input.source}`,
    admin_corrected_at: new Date().toISOString(),
  };
  if (typeof input.summary === "string") patch.summary = input.summary;
  if (input.issues !== undefined) patch.issues = input.issues;
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
