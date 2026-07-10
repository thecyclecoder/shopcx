/**
 * sol-coaching-signal — the shared "messy turns, but recovered" signal that BOTH Cora tiers emit so
 * June (CS Director) can digest repeat patterns and commission a fix.
 *
 * The two graders judge the ENDING (see [[cora-triage-pass]] + [[ticket-analyzer]]): a ticket that
 * ended resolved with a happy customer is NOT escalated. But the PATH there is still worth learning
 * from — Sol contradicted a policy then corrected it, took three turns to find the order, mis-picked
 * a tool then recovered. None of that warrants a June call (the customer was fine), but if the SAME
 * stumble recurs across many tickets it's a systemic Sol gap June should fix at the source.
 *
 * So each grader emits ONE `sol_messy_turns` [[../tables/director_activity]] row per ticket whose
 * ENDING was fine but whose MIDDLE was messy:
 *   - the CHEAP pass ([[cora-triage-pass]]) emits it on a clean-close ticket it did NOT flag for a
 *     deep session (needs_review=false) but where Haiku still saw recovered mid-turn stumbles.
 *   - CORA (the deep box session, [[ticket-analyzer]]) emits it when her verdict is "no escalation"
 *     (satisfactory end) but issues remained.
 * ONE tier emits per ticket per handling — a flagged ticket is handled by Cora, so the cheap pass
 * stays silent on it; there is no double-count.
 *
 * June's weekly digest ([[cs-director-digest]]) groups these by signal class, counts DISTINCT tickets,
 * and surfaces an `early_warning` storyline + a proposed `add_rule` fix once a class repeats across
 * ≥ threshold tickets. This is the north-star loop: a bounded proxy (per-ticket coaching flag) rolls
 * up to the objective-owner (June) who decides the systemic fix — never a silent per-ticket auto-edit.
 * See [[../operational-rules]] § North star.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { recordDirectorActivity } from "@/lib/director-activity";

type Admin = ReturnType<typeof createAdminClient>;

/** The action_kind on the emitted director_activity row — the key June's digest reader selects on. */
export const SOL_MESSY_TURNS_KIND = "sol_messy_turns";

/**
 * The controlled vocabulary of MESSY-MIDDLE (recovered) patterns. These are distinct from the
 * TERMINAL-failure signals in [[cora-triage-pass]] `TRIAGE_SIGNALS` (which describe a BAD ENDING and
 * drive escalation) — every signal here describes a stumble that was RECOVERED by the end, so the
 * ticket was NOT escalated. Both graders map their observations into this set; June aggregates by it.
 */
export const SOL_MESSY_TURN_SIGNALS = [
  "contradiction_recovered",   // stated a wrong/contradictory position, then corrected it
  "policy_misstate_recovered", // mis-stated a policy mid-turn, then got it right
  "slow_resolution",           // took materially more turns than the ask warranted
  "repeated_clarification",    // re-asked for info the customer had already given
  "wrong_tool_recovered",      // picked the wrong action/tool first, then the right one
  "tone_miss_recovered",       // an empathy/tone miss that didn't sink the outcome
] as const;

export type SolMessyTurnSignal = (typeof SOL_MESSY_TURN_SIGNALS)[number];

const ALLOWED = new Set<string>([...SOL_MESSY_TURN_SIGNALS]);

/** Keep only known signals; dedupe; drop everything else. Exported for the graders + tests. */
export function normalizeMessyTurnSignals(signals: readonly string[] | null | undefined): SolMessyTurnSignal[] {
  if (!Array.isArray(signals)) return [];
  const seen = new Set<SolMessyTurnSignal>();
  for (const s of signals) {
    if (typeof s === "string" && ALLOWED.has(s)) seen.add(s as SolMessyTurnSignal);
  }
  return [...seen];
}

/**
 * Emit ONE `sol_messy_turns` coaching signal for a ticket whose ending was fine but middle was messy.
 * Best-effort + never throws (mirrors `recordDirectorActivity`) — a coaching signal that crashed the
 * grade it follows would be strictly worse. A no-op when no known signal survives normalization (an
 * empty set is not a pattern worth a row).
 *
 * `tier` is 'cheap' (the Haiku triage pass) or 'cora' (the deep box session) — carried in metadata so
 * June's digest + any audit can see which grader raised it.
 */
export async function recordSolMessyTurns(
  admin: Admin,
  input: {
    workspaceId: string;
    ticketId: string;
    tier: "cheap" | "cora";
    signals: readonly string[];
    score?: number;
    summary?: string;
  },
): Promise<{ recorded: boolean }> {
  const signals = normalizeMessyTurnSignals(input.signals);
  if (signals.length === 0) return { recorded: false };
  const reason =
    input.summary?.trim() ||
    `Recovered mid-turn stumbles (${signals.join(", ")}) on a ticket that ended satisfactorily — coaching signal, not an escalation.`;
  const res = await recordDirectorActivity(admin, {
    workspaceId: input.workspaceId,
    directorFunction: "cs", // June (CS Director) owns Sol's coaching objective
    actionKind: SOL_MESSY_TURNS_KIND,
    specSlug: null,
    reason,
    metadata: {
      ticket_id: input.ticketId,
      tier: input.tier,
      signals,
      ...(typeof input.score === "number" ? { score: input.score } : {}),
    },
  });
  return { recorded: res.recorded };
}
