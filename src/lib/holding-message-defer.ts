/**
 * Deferred-holding wiring for the Sol frustration branch.
 *
 * SPEC: the-holding-message-only-sends-if-the-real-reply-is-actually-slow Phase 1.
 *
 * The frustration branch of the inflection detector used to dispatch
 * "We're looking into that for you." synchronously the moment a frustration
 * verdict came back. Sol's re-session then typically produced the real answer
 * within 0-3 minutes, so a customer who was already annoyed received a stall
 * followed almost immediately by the substantive reply — two messages where
 * one would have been better, and the first one reads as a brush-off.
 *
 * Fix: write the holding message as a PENDING outbound row with a short
 * `pending_send_at` deadline instead of dispatching it inline. The existing
 * `src/lib/inngest/deliver-pending-send.ts` cron already picks up rows whose
 * `pending_send_at` has passed and skips `send_cancelled` ones, so no new
 * delivery infrastructure is needed. When the substantive reply is sent for
 * the same ticket BEFORE the deadline passes, the pending holding row is
 * marked `send_cancelled = true` and never reaches the customer.
 *
 * This module is deliberately dependency-light — importing the inflection
 * detector pulls a large graph (Haiku transport, direction loader, agent-jobs
 * SDK), which the pure decision helper cannot depend on if it is to be
 * unit-testable without a box session.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The exact holding-message body the Sol frustration branch enqueues.
 * Fixed text — treated as the identifier for "this pending row is a holding
 * message" without adding a new schema column. The cancel query filters on
 * `body = HOLDING_MESSAGE_BODY` so it never cancels an unrelated pending row
 * (a scheduled review-request draft, a canary hold) that happens to be
 * pending on the same ticket. If the text ever changes, the cancel becomes a
 * no-op — safer than a false positive that hides a substantive send.
 */
export const HOLDING_MESSAGE_BODY = "We're looking into that for you.";

/**
 * How long to defer the holding message before the delivery cron picks it up.
 *
 * Chosen from the real 2026-08-25 wrong-merchant thread: the substantive
 * reply followed the holding message by roughly 0-3 minutes across the three
 * separate escalations on that ticket. 90 seconds sits at the low end of the
 * spec-pinned 60-120s range — long enough to suppress the fast case (which
 * accounts for the "sent seconds before the real answer" complaint), short
 * enough that a genuinely-slow investigation still gets the buy-patience
 * message before the customer gives up.
 *
 * The delivery cron `deliver-pending-sends` runs every 5 minutes
 * (`* /5 * * * *`, CEO 2026-07-11 monitoring-cost guardrail), so the effective
 * dispatch window is [90s, 90s + cron-tick-lag]. In practice, any reply that
 * completes within ~5 minutes will race the cron pick-up and win — the
 * cancel is a compare-and-set on `sent_at IS NULL`, so a holding row the
 * cron already dispatched is never retroactively marked cancelled (that
 * would make the ledger lie about what the customer received).
 */
export const HOLDING_DEFER_MS = 90_000;

/**
 * Pure decision predicate: given a pending row's timestamps and the current
 * time, should we cancel it in response to a substantive reply landing?
 *
 * Rules:
 *  - Already sent (`sentAt !== null`) → NO cancel. The customer already saw
 *    it; marking the row cancelled would rewrite history.
 *  - Deadline passed (`pendingSendAt <= now`) → NO cancel. The cron may have
 *    dispatched it in the interim; even if not, we treat the message as
 *    committed to send. This is the conservative choice — better to send a
 *    late holding message than to silently drop one the customer is about
 *    to receive.
 *  - Deadline in the future (`pendingSendAt > now`) AND not yet sent → YES
 *    cancel. This is the fast-reply case the spec is designed around.
 *
 * The DB write layers a compare-and-set on `sent_at IS NULL` + `send_cancelled = false`
 * on top of this predicate as a belt-and-suspenders race guard.
 */
export function shouldCancelPendingHolding(input: {
  pendingSendAt: Date | string | null;
  sentAt: Date | string | null;
  now: Date | number;
}): boolean {
  if (input.sentAt !== null) return false;
  if (input.pendingSendAt === null) return false;
  const nowMs = input.now instanceof Date ? input.now.getTime() : input.now;
  const deadlineMs =
    input.pendingSendAt instanceof Date
      ? input.pendingSendAt.getTime()
      : new Date(input.pendingSendAt).getTime();
  return deadlineMs > nowMs;
}

/**
 * Insert the holding message as a PENDING outbound row on the ticket.
 * Called from the frustration branch of `applyInflectionGate` via the
 * injected callback in `unified-ticket-handler.ts`.
 *
 *  - Sandbox mode: writes an INTERNAL draft row (mirrors `send()`'s sandbox
 *    branch) so nothing reaches the customer during dry-run testing.
 *  - Live mode: writes an external row with `pending_send_at = now + HOLDING_DEFER_MS`;
 *    the deliver-pending-sends cron ships it once the deadline passes AND
 *    no `send_cancelled` flag has been raised in the interim.
 *
 * Insert failures are surfaced by the caller's existing try/catch — the
 * outer swallow-on-holding-send-failure guard means a DB blip here still
 * does NOT block the bounce (spec Phase 1 bullet 4).
 */
export async function enqueuePendingHolding(
  admin: SupabaseClient,
  ticketId: string,
  sandbox: boolean,
): Promise<void> {
  if (sandbox) {
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "ai",
      body: `[AI Draft] ${HOLDING_MESSAGE_BODY}`,
    });
    return;
  }
  await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction: "outbound",
    visibility: "external",
    author_type: "ai",
    body: HOLDING_MESSAGE_BODY,
    pending_send_at: new Date(Date.now() + HOLDING_DEFER_MS).toISOString(),
  });
}

/**
 * Cancel any still-pending holding row for this ticket.
 *
 * Called from `send()` in unified-ticket-handler.ts before EVERY substantive
 * outbound insert — because the spec pins this at the reply chokepoint so
 * every path that answers the customer cancels the stall, not only the
 * re-session path that happens to know about it.
 *
 * The write is a compare-and-set: `.eq("body", HOLDING_MESSAGE_BODY)` +
 * `.is("sent_at", null)` + `.eq("send_cancelled", false)` — a holding row
 * the cron already dispatched is never retroactively marked cancelled.
 * `send_cancelled` is a `NOT NULL DEFAULT false` column on ticket_messages,
 * so equality against `false` is safe.
 *
 * Best-effort: a cancel failure MUST NOT block the substantive reply's
 * insert (same reason the frustration branch swallows on holding-send
 * failure — a diagnostic-substrate blip cannot hold up a customer answer).
 */
export async function cancelPendingHoldingMessagesForTicket(
  admin: SupabaseClient,
  ticketId: string,
): Promise<void> {
  try {
    await admin
      .from("ticket_messages")
      .update({ send_cancelled: true })
      .eq("ticket_id", ticketId)
      .eq("body", HOLDING_MESSAGE_BODY)
      .is("sent_at", null)
      .eq("send_cancelled", false)
      .not("pending_send_at", "is", null);
  } catch {
    // Cancel is best-effort — never block the substantive send on a ledger blip.
  }
}
