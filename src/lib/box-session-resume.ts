/**
 * Detects the "resumed box session no longer exists on its account" failure signature so a resumable
 * box-chat turn (director-coach, dev-ask, roadmap-chat, ticket-improve) can retry ONCE with a null
 * (fresh) session — rebuilding context from the thread transcript — instead of hard-wedging on the
 * dead session id.
 *
 * See [[../../docs/brain/libraries/director-coach-threads]] · fresh-fallback behavior.
 */

/**
 * True when the raw box-run output carries the missing-session signature:
 *   `No conversation found with session ID: <uuid>`
 * (the surface that `claude --resume` emits when the account no longer has the conversation —
 * box restart, session-store rotation, or expiry). Case-insensitive so a stray casing shift in the
 * upstream CLI text does not silently downgrade a retry to a fail.
 */
export function isMissingSessionError(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;
  return /No conversation found with session ID/i.test(raw);
}

/**
 * True when a resumed box-chat run should be retried ONCE with a fresh (null) session:
 *   - the caller actually resumed (sessionId was set),
 *   - the run errored,
 *   - it produced no assistant reply,
 *   - and the raw output carries the missing-session signature.
 *
 * A capped-account wall or a parse failure returns false — those are handled elsewhere
 * (account-pool failover / normal failTurn).
 */
export function shouldRetryFresh(input: {
  sessionId: string | null | undefined;
  isError: boolean;
  reply: string | null | undefined;
  raw: string;
}): boolean {
  if (!input.sessionId) return false;
  if (!input.isError) return false;
  if (input.reply && input.reply.length > 0) return false;
  return isMissingSessionError(input.raw);
}
