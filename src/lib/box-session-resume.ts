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

/** Minimum shape a box run result must expose for the fresh-fallback wrapper. */
export interface BoxRunResultLike {
  isError: boolean;
  raw: string;
}

/** The `withAccountFailover` / `runBoxClaude` return envelope. */
export interface FailoverEnvelope<T> {
  result: T | null;
  configDir: string | null;
  allCapped: boolean;
}

/**
 * The failover primitive the four resumable box-chat lanes already share
 * (`withAccountFailover` / `runBoxClaude` in `scripts/builder-worker.ts`).
 * Injected so this wrapper stays pure + unit-testable in `src/`.
 */
export type FailoverFn<T> = (
  pin: { sessionConfigDir?: string | null; sessionId?: string | null },
  run: (configDir: string, sessionId: string | null) => Promise<T>,
) => Promise<FailoverEnvelope<T>>;

/**
 * The ONE fresh-fallback wrapper every resumable box-chat lane (director-coach, dev-ask,
 * roadmap-chat, ticket-improve) routes through. A resumed run that comes back errored with the
 * missing-session signature (`isMissingSessionError(raw)`) is retried ONCE with `sessionId=null` so
 * the closure rebuilds full context from the thread transcript. Same account-pool failover
 * semantics on the retry (a cap during retry still hops → `allCapped:true` bubbles up so the caller
 * parks `blocked_on_usage`, exactly as before).
 *
 * The wrapper never persists to the DB — the caller does that with the returned `result.session`
 * (and MUST use `pickNextSession` below when writing the new session id back so a dead id can't be
 * re-saved on the freshly-retried path).
 *
 * `hasReply` is optional; when supplied the retry only fires when the errored run produced no
 * reply, matching each lane's failTurn shape. Omit it to retry on any errored resume with the
 * missing-session signature.
 */
export async function runBoxTurnWithFreshFallback<T extends BoxRunResultLike>(args: {
  pin: { sessionConfigDir?: string | null; sessionId?: string | null };
  run: (configDir: string, sessionId: string | null) => Promise<T>;
  failover: FailoverFn<T>;
  hasReply?: (result: T) => boolean;
  onFreshFallback?: () => void;
}): Promise<FailoverEnvelope<T> & { freshRetried: boolean }> {
  const first = await args.failover(args.pin, args.run);
  const priorSessionId = args.pin.sessionId ?? null;
  if (!priorSessionId) return { ...first, freshRetried: false };
  if (!first.result) return { ...first, freshRetried: false };
  if (!first.result.isError) return { ...first, freshRetried: false };
  if (!isMissingSessionError(first.result.raw)) return { ...first, freshRetried: false };
  if (args.hasReply && args.hasReply(first.result)) return { ...first, freshRetried: false };
  args.onFreshFallback?.();
  const fresh = await args.failover({ sessionId: null }, args.run);
  return { ...fresh, freshRetried: true };
}

/**
 * Compute the session id to persist back to the thread after a (possibly-fresh-retried) box turn.
 * A resumed run that errored with the missing-session signature must NEVER cause the dead prior
 * session id to be re-saved — otherwise the very next turn re-wedges on the same dead id. If the
 * new run produced a fresh session id, use it; else null out ONLY when the prior id is dead
 * (raw carries the missing-session signature) — otherwise the prior id is still the correct pin.
 */
export function pickNextSession(input: {
  newSession: string | null | undefined;
  priorSessionId: string | null | undefined;
  raw: string;
}): string | null {
  if (input.newSession) return input.newSession;
  const prior = input.priorSessionId ?? null;
  if (!prior) return null;
  return isMissingSessionError(input.raw) ? null : prior;
}
