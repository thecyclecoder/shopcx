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
  // Deterministic pre-filter close from [[libraries/automated-sender]] via
  // unified-ticket-handler.ts § 1a2 (`outreach-automated-sender-pre-filter`
  // step). The handler writes the sysNote body
  //   "[System] Automated-sender pre-filter tripped (sender=…) —
  //    deterministically closed, no AI response, classify-bucket skipped
  //    (zero AI cost)."
  // The close IS a real state change (open → auto_resolve) and counts as
  // progress — a run of pre-filter-closed inbounds must not silently
  // accumulate as no_progress_context_cap. Ground-truth case: ticket
  // 91579acf-67ef-4cb3-be89-0c9da7dac7af — 13 auto-merged TestFlight
  // "AdsGPT" spam invites, every one pre-filter-closed, escalated to the
  // CS Director with no remedy before this marker landed.
  "Automated-sender pre-filter tripped",
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
 * — if the circuit trips — either (a) re-send a cancel journey when the
 * loop is a routine cancel + the ticket has an active cancel journey
 * available (in-leash tool that keeps the customer moving) OR (b) write
 * the observable escalation + system note (compare-and-set guarded on
 * ticket id + workspace) so the ticket is surfaced to a human. Returns
 * `tripped: true` in either case so the caller skips the paid
 * orchestrator call.
 *
 * Idempotent: if the escalation_reason is already `no_progress_context_cap`
 * the update matches zero rows (compare-and-set) and we still short-circuit
 * the call — no repeated system-note noise. This is the compare-and-set
 * discipline the director coaching calls out (see approval-inbox.ts guard).
 *
 * ⭐ Routine-cancel re-send (ticket 6c12a925). A stuck loop where the
 * customer keeps asking "cancel my subscription" and the AI has no
 * in-leash tool ([[action-executor]] `directActionHandlers` exposes no
 * cancel action) dead-ends at human review — the customer is trapped
 * even though the fix is a click on the cancel journey's confirm
 * button. Instead: launch a fresh cancel journey. The launcher
 * auto-detects a prior `saved_%` outcome on this ticket via
 * [[cancel-journey-guard]] `hasRecentSavedRemedy` and routes past
 * remedies straight to confirm-cancel — cancellation still completes
 * only via the customer's own journey button, we just get them to
 * that button. Escalation is skipped on a successful re-send (the
 * ticket is progressing again).
 */
export async function applyNoProgressCircuit(
  admin: Admin,
  workspaceId: string,
  ticketId: string,
): Promise<{ tripped: boolean; streak: number; resent: boolean }> {
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
    return { tripped: false, streak, resent: false };
  }

  // ── Routine-cancel in-leash re-send (before escalation) ──
  // Any of the recent inbound customer messages that formed the streak
  // asking to cancel is enough — one clear "cancel my subscription"
  // buried under two follow-ups still routes here.
  const streakInbounds = chronological
    .slice(-streak)
    .filter((m) => m.direction === "inbound" && m.author_type === "customer");
  const { looksLikeCancelIntent } = await import("@/lib/cancel-journey-guard");
  const isRoutineCancel = streakInbounds.some((m) => looksLikeCancelIntent(m.body ?? null));

  let resent = false;
  if (isRoutineCancel) {
    resent = await attemptCancelJourneyResend(admin, workspaceId, ticketId);
    if (resent) {
      // A re-sent journey IS the progress — do not escalate, do not
      // pay for another Opus pass. The launcher already wrote its own
      // delivery note + `j:cancel-subscription` tag; add one more note
      // that explains the WHY so a human scanning the thread understands
      // why the no_progress circuit didn't escalate.
      await admin.from("ticket_messages").insert({
        ticket_id: ticketId,
        direction: "outbound",
        visibility: "internal",
        author_type: "system",
        body: `[System] No-progress circuit: ${streak} inbound in a row asking to cancel — re-sent a fresh cancel journey (routed past any prior saved remedy) instead of escalating to human review with no in-leash tool. See docs/brain/journeys/cancel.md § "Route past remedies on re-request".`,
      });
      return { tripped: true, streak, resent: true };
    }
    // Re-send failed (no active journey, no subscription, etc.) — fall
    // through to the escalation path. A stuck loop with no in-leash
    // tool still needs a human.
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

  return { tripped: true, streak, resent: false };
}

/**
 * Look up the active cancel-journey definition for this workspace and
 * launch it via [[journey-delivery]] `launchJourneyForTicket`. Returns
 * `true` on a successful delivery. Kept separate from
 * `applyNoProgressCircuit` so a caller could invoke it directly (Sol's
 * cheap-execution path in the future) and so the escalation-side of
 * the circuit stays uncoupled from the launcher.
 *
 * Reads all inputs from the DB — the ticket's channel, customer_id, and
 * the workspace's active cancel journey. Returns `false` if any of them
 * is missing (no active journey for the workspace, no customer, no
 * channel) so the caller can fall through to escalation.
 */
export async function attemptCancelJourneyResend(
  admin: Admin,
  workspaceId: string,
  ticketId: string,
): Promise<boolean> {
  const { data: ticket } = await admin
    .from("tickets")
    .select("customer_id, channel")
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!ticket) return false;
  const t = ticket as { customer_id: string | null; channel: string | null };
  if (!t.customer_id || !t.channel) return false;

  const { data: journey } = await admin
    .from("journey_definitions")
    .select("id, name, trigger_intent, slug")
    .eq("workspace_id", workspaceId)
    .eq("trigger_intent", "cancel_subscription")
    .eq("is_active", true)
    .maybeSingle();
  if (!journey) return false;
  const j = journey as { id: string; name: string; trigger_intent: string; slug: string };

  const { launchJourneyForTicket } = await import("@/lib/journey-delivery");
  const launched = await launchJourneyForTicket({
    workspaceId,
    ticketId,
    customerId: t.customer_id,
    journeyId: j.id,
    journeyName: j.name,
    triggerIntent: j.trigger_intent,
    channel: t.channel,
    // Plain, un-branded lead-in — the no_progress circuit isn't Sol/Sonnet,
    // there's no persona context here. The mini-site header carries the
    // brand; the CTA text below carries the action.
    leadIn:
      "It sounds like you'd still like to cancel. The link below takes you straight to the confirmation — one click and it's done.",
    ctaText: "Confirm cancellation",
    // Redundant belt-and-suspenders — the launcher will auto-detect a
    // prior saved_% outcome via [[cancel-journey-guard]] anyway, but a
    // no_progress re-send is by definition "customer keeps re-asking,"
    // so the terminal route is the right one even if there's no saved
    // remedy row (customer just kept typing "cancel" over an orchestrator
    // stall).
    directToCancelTerminal: true,
  });
  return launched;
}
