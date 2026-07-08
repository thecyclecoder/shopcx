/**
 * ticket-directions — the SDK Sol's first-touch box session (runTicketHandleJob) uses to write /
 * supersede / read the durable Direction artifact backing `public.ticket_directions`. One live row
 * per ticket (partial UNIQUE on `ticket_id WHERE superseded_at IS NULL`); a rare inflection calls
 * `superseDirection` then `writeDirection` — never an in-place UPDATE. Every write goes through
 * a service-role client passed in by the caller (createAdminClient in the worker). See
 * docs/brain/tables/ticket_directions.md + docs/brain/libraries/ticket-directions.md +
 * docs/brain/specs/sol-ticket-direction-artifact-and-first-touch-box-session.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient;

export type TicketDirectionPath = "playbook" | "stateless" | "needs_info";

export interface TicketDirection {
  id: string;
  workspace_id: string;
  ticket_id: string;
  intent: string;
  context_summary: string;
  chosen_path: TicketDirectionPath;
  plan: Record<string, unknown>;
  guardrails: Record<string, unknown>;
  authored_by: string;
  authored_at: string;
  superseded_at: string | null;
  /**
   * Anti-runaway re-session counter — Phase 1 of
   * [[../specs/sol-runaway-re-session-cap-guardrail]]. Zero on the first Direction; incremented
   * by the router ([[../inflection-detector]] `reSessionSol` — Phase 2) on every re-session so
   * the cap check (`>= ai_channel_config.sol_max_resessions`) can fire.
   */
  resession_count: number;
}

const COLS =
  "id, workspace_id, ticket_id, intent, context_summary, chosen_path, plan, guardrails, authored_by, authored_at, superseded_at, resession_count";

/**
 * Insert one live Direction for a ticket. The DB-level partial UNIQUE
 * `(ticket_id) WHERE superseded_at IS NULL` guarantees exactly one live row per ticket —
 * a concurrent second `writeDirection` on the same ticket errors here (23505 unique_violation).
 * The caller (Sol's session) is expected to `superseDirection` first when re-authoring.
 */
export async function writeDirection(
  admin: Admin,
  input: {
    workspace_id: string;
    ticket_id: string;
    intent: string;
    context_summary: string;
    chosen_path: TicketDirectionPath;
    plan?: Record<string, unknown>;
    guardrails?: Record<string, unknown>;
    authored_by?: string;
  },
): Promise<TicketDirection> {
  const { data, error } = await admin
    .from("ticket_directions")
    .insert({
      workspace_id: input.workspace_id,
      ticket_id: input.ticket_id,
      intent: input.intent,
      context_summary: input.context_summary,
      chosen_path: input.chosen_path,
      plan: input.plan ?? {},
      guardrails: input.guardrails ?? {},
      authored_by: input.authored_by ?? "sol_box_session",
    })
    .select(COLS)
    .single();
  if (error) throw error;
  return data as TicketDirection;
}

/**
 * Mark the currently-live Direction for `ticket_id` as superseded. Compare-and-set on
 * `superseded_at IS NULL` (per Learning #1 — a re-assertion of the read-time invariant at the
 * write): if the live row got stamped by a racing caller between read and write, we get zero rows
 * back and return `null` so the caller can bail instead of overwriting a stale timestamp. Scoped by
 * `workspace_id` when supplied so a cross-workspace ticket-id collision can't cross the boundary.
 * Returns the superseded row (or null when no live row existed / another caller won the race).
 */
export async function superseDirection(
  admin: Admin,
  ticket_id: string,
  opts?: { workspace_id?: string },
): Promise<TicketDirection | null> {
  let q = admin
    .from("ticket_directions")
    .update({ superseded_at: new Date().toISOString() })
    .eq("ticket_id", ticket_id)
    .is("superseded_at", null);
  if (opts?.workspace_id) q = q.eq("workspace_id", opts.workspace_id);
  const { data, error } = await q.select(COLS);
  if (error) throw error;
  const rows = (data ?? []) as TicketDirection[];
  return rows[0] ?? null;
}

/**
 * Read the live Direction (superseded_at IS NULL) for a ticket, or null when Sol hasn't authored
 * one yet (or the last one was superseded and not re-authored). Downstream cheap-execution turns
 * drive off `chosen_path` + `plan` + `guardrails` here instead of re-running full-context reasoning.
 */
export async function getLiveDirection(
  admin: Admin,
  ticket_id: string,
  opts?: { workspace_id?: string },
): Promise<TicketDirection | null> {
  let q = admin
    .from("ticket_directions")
    .select(COLS)
    .eq("ticket_id", ticket_id)
    .is("superseded_at", null);
  if (opts?.workspace_id) q = q.eq("workspace_id", opts.workspace_id);
  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return (data as TicketDirection | null) ?? null;
}

/**
 * Alias for {@link getLiveDirection}. The Sol cheap-execution spec (M2) names the accessor
 * `loadLiveDirection` at its Phase-2 orchestrator wire-in; keeping both names is intentional so
 * downstream call sites can read the more precise verb (`load`) at the branch point without
 * changing the M1 SDK's shipped name.
 */
export const loadLiveDirection = getLiveDirection;

/**
 * Bump `resession_count` on the live Direction for `ticket_id`. Phase 2 of
 * [[../specs/sol-runaway-re-session-cap-guardrail]] — the router (`reSessionSol`) calls this
 * BEFORE it supersedes the live row so the incremented count is captured on the row about to
 * be superseded (the durable per-ticket bounce history the cap check reads on the NEXT
 * inflection).
 *
 * Compare-and-set on the CURRENT live row: `.eq('id', direction_id)` + `.is('superseded_at', null)`
 * + workspace_id scope (per Learning #1 — re-assert the read-time preconditions in the write
 * itself). If the live row got superseded by a racing caller between the caller's read and this
 * increment, `.select('id')` returns zero rows and we return `null` so the caller can bail
 * without double-counting.
 */
export async function incrementResessionCount(
  admin: Admin,
  input: { workspace_id: string; direction_id: string; from_count: number },
): Promise<number | null> {
  const { data, error } = await admin
    .from("ticket_directions")
    .update({ resession_count: input.from_count + 1 })
    .eq("id", input.direction_id)
    .eq("workspace_id", input.workspace_id)
    .is("superseded_at", null)
    .select("id");
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string }>;
  if (rows.length !== 1) return null;
  return input.from_count + 1;
}
