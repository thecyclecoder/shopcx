/**
 * No-progress circuit-breaker for the Sonnet orchestrator (Phase 3 of
 * ticket-merge-summary-and-context-cap).
 *
 * When a merged (or otherwise long-running) ticket sees M consecutive
 * inbound customer messages with NO intervening outbound response and NO
 * action executed, we are almost certainly stuck in a Goodhart loop:
 * every new inbound triggers another Opus turn (`ai_turn_count >= 1`
 * routes to Opus per [[libraries/model-picker]]) but the orchestrator
 * has nothing new to say, so we pay the model bill and the customer
 * gets no new state. The circuit breaks that loop: surface the ticket
 * (system note + escalation) INSTEAD of paying for another full-context
 * Opus pass.
 *
 * ties into:
 *   - [[libraries/sonnet-orchestrator-v2]] context assembly + rollup
 *     (Phase 1/2 — the summary/prefix stops the cache-recost loop for
 *     tickets that ARE making progress; this guard stops it for tickets
 *     that aren't)
 *   - [[libraries/ticket-analyzer]] downstream grader signal
 *     ("no_progress_context_cap" escalation_reason is a distinct axis
 *     from "customer complained" that the CS-director digest can
 *     surface separately)
 *
 * Kept in its own file so the pure predicates below are unit-testable
 * with no DB, and the DB-touching applyNoProgressCircuit stays a thin
 * wrapper around them.
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * How many consecutive inbound customer messages with no outbound
 * response / no executed action trip the circuit. Small enough to catch
 * a stuck ticket after two clear failures; large enough that a customer
 * sending "wait" then "actually…" back-to-back doesn't over-trigger.
 */
export const NO_PROGRESS_M = 3;

/**
 * Message shape the streak counter reads. Kept minimal so any caller
 * that has these four fields can feed the pure predicate directly.
 */
export interface StreakMessage {
  direction: string | null;
  author_type: string | null;
  visibility?: string | null;
  body?: string | null;
}

/**
 * A system message body that indicates an ACTION WAS EXECUTED — a real
 * state change from the orchestrator's side. Matches the same patterns
 * that the convo renderer in sonnet-orchestrator-v2.ts treats as
 * "counts as progress" so the two views can't disagree.
 */
const ACTION_MARKERS = [
  "Action completed:",
  "Action failed:",
  "Applied",
  "Added",
  "Redeemed",
  "Removed",
  "Swapped",
  "Skipped",
  "Resumed",
  "Changed",
  "refund",
  "Refund",
  "All done",
  "Here's what we",
];

function isActionSystemMessage(m: StreakMessage): boolean {
  if (m.author_type !== "system") return false;
  const body = (m.body || "") as string;
  return ACTION_MARKERS.some((marker) => body.includes(marker));
}

/**
 * Count how many consecutive inbound customer messages sit at the END of
 * the chronological message list without an intervening outbound reply
 * or an action-executed system note. Ignores non-action system notes
 * (routing / merges / status flips) so those don't mask the streak.
 *
 * Pure — no I/O — kept exported for the unit test.
 *
 * @param messages ascending chronological order (oldest → newest)
 */
export function inboundStreakSinceLastResponse(messages: StreakMessage[]): number {
  let streak = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.direction === "inbound" && m.author_type === "customer") {
      streak++;
      continue;
    }
    // A "we did the thing" system note resets — state changed. Checked
    // BEFORE the generic outbound branch so an action-tagged system
    // note (`author_type='system' + direction='outbound'`) resets on
    // its action marker, not on the direction alone.
    if (isActionSystemMessage(m)) return streak;
    // An outbound agent/AI/customer-facing reply resets the streak — the
    // orchestrator DID say something. Deliberately excludes
    // `author_type='system'` non-action notes (routing / model-picker
    // breadcrumbs / merge stubs are direction='outbound' too but carry
    // no real state) — those pass through to the "skip past" branch
    // below so they don't mask a genuine no-progress streak.
    if (m.direction === "outbound" && m.author_type !== "system") return streak;
    // Anything else (routing notes, model-picker breadcrumbs, merge
    // stubs) is neither progress nor regress — skip past.
  }
  return streak;
}

/**
 * Circuit trip predicate. Pure — no I/O — kept exported for the unit
 * test. Named failing state (spec Phase-3 verification): "a no-progress
 * ticket stops escalating context/model and is surfaced instead of
 * silently re-charged."
 */
export function shouldTripNoProgressCircuit(inboundStreak: number): boolean {
  return inboundStreak >= NO_PROGRESS_M;
}

/**
 * Fetch the recent message tail for a ticket, evaluate the streak, and
 * — if the circuit trips — write the observable escalation + system
 * note (compare-and-set guarded on ticket id + workspace) so the ticket
 * is surfaced to a human INSTEAD of the next Opus pass firing. Returns
 * `true` when the caller should skip the paid orchestrator call.
 *
 * Idempotent: if the escalation_reason is already `no_progress_context_cap`
 * the update matches zero rows (compare-and-set) and we still short-circuit
 * the call — no repeated system-note noise. This is the compare-and-set
 * discipline the director coaching calls out (see approval-inbox.ts guard).
 */
export async function applyNoProgressCircuit(
  admin: Admin,
  workspaceId: string,
  ticketId: string,
): Promise<{ tripped: boolean; streak: number }> {
  // Look back at the recent chronological tail. 30 covers the streak
  // threshold plus the last reset point comfortably; older messages
  // don't affect the streak, so no need to fetch them.
  const { data: recent } = await admin
    .from("ticket_messages")
    .select("direction, author_type, visibility, body")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .limit(30);
  const chronological = (recent || []).slice().reverse() as StreakMessage[];
  const streak = inboundStreakSinceLastResponse(chronological);

  if (!shouldTripNoProgressCircuit(streak)) {
    return { tripped: false, streak };
  }

  // Compare-and-set: only apply the circuit's escalation if THIS row is
  // still un-escalated (or escalated for a different reason). The
  // .select("id") assertion protects us from an async race where a
  // human just escalated to a real owner — we don't overwrite that.
  const { data: written } = await admin
    .from("tickets")
    .update({
      escalated_at: new Date().toISOString(),
      escalation_reason: "no_progress_context_cap",
      updated_at: new Date().toISOString(),
    })
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .is("escalated_at", null)
    .select("id");

  // Even when the update matched zero rows (ticket was already
  // escalated), we STILL short-circuit the orchestrator call — the
  // stuck-loop shouldn't keep paying just because a human already
  // owned it. The system-note is only written on a fresh trip so we
  // don't spam the ticket on every consecutive turn.
  if (written && written.length === 1) {
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: `[System] No-progress circuit: ${streak} inbound customer message${streak === 1 ? "" : "s"} in a row with no outbound reply or action executed — surfaced for human review instead of paying for another Opus pass. See docs/brain/specs/ticket-merge-summary-and-context-cap.md Phase 3.`,
    });
  }

  return { tripped: true, streak };
}
