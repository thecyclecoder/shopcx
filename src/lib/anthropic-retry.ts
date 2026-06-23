/**
 * Anthropic dependency-failure classification — the shared "is this a
 * retryable outage or a terminal bug?" decision for every raw-fetch Claude
 * call on the customer-facing path.
 *
 * The rule (agent-outage-resilience spec, Phase 1): a Claude/API failure must
 * NEVER be silently swallowed into `""`/a default decision that lets the
 * caller proceed on missing data. Instead it must THROW so the Inngest run
 * retries — and the THROW is classified:
 *
 *   • retryable dependency failure (Anthropic 429 / 5xx / 529-overloaded /
 *     timeout, or a network-level fetch failure) → `AnthropicDependencyError`
 *     (a plain Error → Inngest retries it with exponential backoff; with
 *     `OUTAGE_SPANNING_RETRIES` the backoff spans hours, so a 1-hour outage
 *     parks-and-drains: the work retries and completes on recovery).
 *   • terminal logic/auth error (4xx other than 429 — a malformed request,
 *     bad key, etc.) → `NonRetriableError` (fail fast; never burn hours of
 *     retries on a bug).
 *
 * Genuinely-optional enrichment may still degrade gracefully, but the caller
 * must opt into that EXPLICITLY (e.g. a `claude(..., { optional: true })`
 * flag) — it is never the accidental default.
 */

import { NonRetriableError } from "inngest";

/**
 * Inngest caps a function at 20 retries. We use the ceiling for customer-facing
 * Claude-dependent functions so the default exponential backoff curve extends
 * out to hours — enough to span a multi-hour Anthropic outage. Terminal logic
 * errors fail fast via `NonRetriableError` regardless of this, so a real bug is
 * never retried 20 times.
 */
export const OUTAGE_SPANNING_RETRIES = 20;

/**
 * Is this `api.anthropic.com` HTTP status a transient dependency failure worth
 * retrying across an outage (vs a terminal request/auth bug)?
 *
 *   408 request timeout · 409 conflict · 425 too early · 429 rate limit ·
 *   5xx incl. 529 (overloaded) → transient, retry.
 *   400/401/403/404/422 → request/auth bug, will never succeed on retry.
 */
export function isRetryableAnthropicStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * Thrown for a retryable Anthropic dependency failure. A plain `Error`
 * subclass — Inngest retries plain throws by default; the named class lets
 * callers (and the Phase-2 circuit-breaker's local failure counter) recognise
 * a dependency outage as distinct from a logic bug.
 */
export class AnthropicDependencyError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "AnthropicDependencyError";
    this.status = status;
  }
}

/**
 * Turn a non-2xx Anthropic response into the right throw: retryable status →
 * `AnthropicDependencyError` (run retries with backoff); terminal status →
 * `NonRetriableError` (fail fast). Returns `never`.
 */
export function throwForAnthropicStatus(status: number, where: string): never {
  const msg = `Anthropic ${where} returned ${status}`;
  if (isRetryableAnthropicStatus(status)) throw new AnthropicDependencyError(msg, status);
  throw new NonRetriableError(msg);
}

/**
 * A network-level fetch failure (DNS, connection reset, socket hang up,
 * timeout) is always a transient dependency failure → retry. Returns `never`.
 */
export function throwForAnthropicNetworkError(err: unknown, where: string): never {
  const detail = err instanceof Error ? err.message : String(err);
  throw new AnthropicDependencyError(`Anthropic ${where} network failure: ${detail}`);
}

/**
 * Is a *caught* throw a retryable dependency failure? True for our own
 * `AnthropicDependencyError` and for raw undici/network fetch failures
 * (`TypeError: fetch failed` + ECONNRESET/ETIMEDOUT/… causes). Used where a
 * call site catches errors generically (the orchestrator's top-level catch,
 * the analyzer cron) and must re-throw / defer the outage cases while still
 * degrading on genuine logic errors. A `NonRetriableError` is deliberately
 * NOT matched.
 */
export function isRetryableThrownError(err: unknown): boolean {
  if (err instanceof AnthropicDependencyError) return true;
  if (err instanceof NonRetriableError) return false;
  if (err instanceof Error) {
    if (/fetch failed|network|terminated|socket hang up|other side closed/i.test(err.message)) return true;
    const cause = (err as { cause?: unknown }).cause;
    if (
      cause instanceof Error &&
      /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|UND_ERR|socket hang up|terminated/i.test(cause.message)
    ) {
      return true;
    }
  }
  return false;
}
