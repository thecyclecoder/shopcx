import { errText } from "@/lib/error-text";
/**
 * agent-jobs-update-retry-and-error-surface Phase 1 — the retry + surface helper for the
 * box worker's shared `agent_jobs` update chokepoint (`scripts/builder-worker.ts:update`).
 *
 * Wiring: `scripts/builder-worker.ts:update` calls this helper INSIDE its existing
 * `needs_input` guard and BEFORE its `stampNeedsAttentionClass` fan-out, so the retry
 * policy sits at the single chokepoint every job kind already funnels through.
 *
 * ── Problem the helper closes ──
 * The Control Tower's Management-Logs feed recorded repeated `521 PATCH /rest/v1/agent_jobs`
 * failures — a Cloudflare "Web server is down" gateway blip served in front of PostgREST.
 * The worker's `update` used to fire and forget the write: it never inspected Supabase's
 * `{ data, error, status }` return, so a transient 521 silently dropped the transition
 * (build job stays `running` past terminal, `needs_input` never lands, the dispatch loop
 * proceeds as if the row was updated). Signature: `supabase-logs:68fda858b6ae7a63`.
 *
 * ── What the helper does ──
 * Wraps a single Supabase update call in a bounded retry that:
 *   • treats a THROWN network/fetch failure (ECONNRESET / ETIMEDOUT / `fetch failed`) as
 *     transient — the socket died mid-request, the row was probably not written;
 *   • treats a RETURNED `{ error, status }` with an HTTP 5xx / no `status` + a 5xx-shaped
 *     message as transient — PostgREST is behind Cloudflare so a 5xx is nearly always the
 *     gateway, not a PostgREST invariant;
 *   • fails fast on a 4xx / a PostgREST `error.code` starting `PGRST` (schema / RLS / bad
 *     patch) — a real bug, retrying just burns attempts and delays the surface;
 *   • runs at most `attempts` tries (default 4) with exponential backoff (`baseDelayMs`
 *     doubling per attempt) — quick enough that a healthy blip clears in < 2 s, bounded
 *     enough that a chronic outage surfaces as a typed `AgentJobsUpdateError` rather than
 *     hanging the worker's single-flight lane.
 *
 * ── Contract with the worker ──
 * On success (any attempt) the helper returns `{ ok: true, attempts, response }` and the
 * caller proceeds with the existing needs-attention classifier / follow-up work. On
 * exhaustion the helper THROWS `AgentJobsUpdateError` carrying `{ jobId, attemptedStatus,
 * attempts, lastError, lastResponse }` — the caller MUST propagate the throw (do NOT
 * catch-and-continue) so the dispatch loop cannot proceed as if the row was updated.
 *
 * ── What this file is NOT ──
 * A generic Supabase retry wrapper. This helper is scoped to the `agent_jobs` update
 * chokepoint by design: the classification of transient-vs-terminal is different for a
 * queue-state PATCH than for a generic mutation (a data-integrity error on a queue write
 * is still fail-fast; a queue write to a row that raced past its terminal state is not
 * something we retry-into-existence, we surface it).
 *
 * ── Test surface ──
 * See `src/lib/agents/agent-jobs-update-retry.test.ts` — mocked `runOnce` proves a 521 is
 * retried, the eventual success path stays clean, and an exhausted 521 throws with the
 * jobId + attempted status baked into the message (the spec's Verification bullet).
 */

/**
 * Shape returned by a Supabase-js `.from(t).update(p).eq('id', id)` call.
 *
 * We only care about the two fields the retry policy branches on — `error` (null on a
 * successful write, PostgrestError-shaped on a caller-visible failure) and `status`
 * (the HTTP status Supabase-js copies out of the underlying fetch Response). Both are
 * optional here so the helper stays framework-agnostic in tests.
 */
export type AgentJobsUpdateResponse = {
  error?: { message?: string; code?: string | null; details?: string | null; hint?: string | null } | null;
  status?: number | null;
  statusText?: string | null;
};

export type AgentJobsUpdateRunOnce = () => Promise<AgentJobsUpdateResponse>;

export type AgentJobsUpdateRetryOpts = {
  jobId: string;
  /** The `patch.status` the worker is trying to land — surfaced in the final throw for triage. */
  attemptedStatus?: string | null;
  /** Bounded attempt cap, default 4 (initial + 3 retries). Clamped to [1, 8]. */
  attempts?: number;
  /** First backoff delay in ms, default 250. Doubles each retry. */
  baseDelayMs?: number;
  /**
   * Sleep function — injectable so the unit test doesn't burn real time. Defaults to a
   * `setTimeout`-backed promise; the test passes a no-op that resolves synchronously.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Console-like sink for the pre-throw failure log. Defaults to `console.error` in prod
   * so the box worker's stdout carries the terminal breadcrumb; overridable in tests.
   */
  logger?: {
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
};

export type AgentJobsUpdateSuccess = {
  ok: true;
  attempts: number;
  response: AgentJobsUpdateResponse;
};

/**
 * Typed failure the helper throws once the bounded retry is exhausted. The dispatch loop
 * MUST NOT catch-and-continue this — the whole point is that the loop stops treating the
 * row as updated when it wasn't. Rethrown by the worker's `update` chokepoint.
 */
export class AgentJobsUpdateError extends Error {
  readonly jobId: string;
  readonly attemptedStatus: string | null;
  readonly attempts: number;
  readonly lastError: AgentJobsUpdateResponse["error"] | null;
  readonly lastResponse: AgentJobsUpdateResponse | null;
  readonly lastThrown: unknown;

  constructor(args: {
    jobId: string;
    attemptedStatus: string | null;
    attempts: number;
    lastError: AgentJobsUpdateResponse["error"] | null;
    lastResponse: AgentJobsUpdateResponse | null;
    lastThrown: unknown;
  }) {
    const errMsg =
      args.lastError?.message ??
      (args.lastThrown instanceof Error ? args.lastThrown.message : String(args.lastThrown ?? "unknown"));
    const status = args.lastResponse?.status ?? "?";
    super(
      `agent_jobs update failed after ${args.attempts} attempt(s) [job=${args.jobId} attemptedStatus=${
        args.attemptedStatus ?? "?"
      } lastStatus=${status}]: ${errMsg}`,
    );
    this.name = "AgentJobsUpdateError";
    this.jobId = args.jobId;
    this.attemptedStatus = args.attemptedStatus;
    this.attempts = args.attempts;
    this.lastError = args.lastError;
    this.lastResponse = args.lastResponse;
    this.lastThrown = args.lastThrown;
  }
}

/**
 * Classify a thrown error as transient (retry) vs terminal (fail fast).
 *
 * Transient class: node-fetch / undici network failures — `fetch failed`, `ECONNRESET`,
 * `ETIMEDOUT`, `EAI_AGAIN`, `socket hang up`, `network`, `timeout`. These almost always
 * mean the write didn't reach PostgREST (the row was NOT written), so a retry is the
 * correct action — the alternative is silently losing the transition.
 *
 * Terminal class: anything else that manages to throw. Retrying a bug-shaped throw wastes
 * attempts and delays the observable surface.
 */
export function isTransientAgentJobsUpdateThrow(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("socket hang up") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("eai_again") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound")
  );
}

/**
 * Classify a returned `{ error, status }` as transient (retry) vs terminal (fail fast).
 *
 * A PostgREST error whose `code` starts with `PGRST` is a schema / RLS / bad-patch bug —
 * terminal, retrying just delays the surface.
 * A returned HTTP 5xx is nearly always the gateway (Cloudflare 521/522/523/524, or an
 * edge 5xx passthrough) — transient, retry.
 * Anything that surfaces the number 521 in the error message (Cloudflare's brand of
 * "web server is down") is the exact signature this helper was authored against.
 */
export function isTransientAgentJobsUpdateResponse(resp: AgentJobsUpdateResponse): boolean {
  const err = resp.error;
  if (!err) return false;
  const code = String(err.code ?? "").toUpperCase();
  if (code.startsWith("PGRST")) return false;
  const status = Number(resp.status ?? 0);
  if (status >= 500 && status <= 599) return true;
  const msg = String(err.message ?? "").toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("521") ||
    msg.includes("522") ||
    msg.includes("523") ||
    msg.includes("524") ||
    msg.includes("bad gateway") ||
    msg.includes("gateway time-out") ||
    msg.includes("gateway timeout") ||
    msg.includes("service unavailable") ||
    msg.includes("web server is down") ||
    msg.includes("fetch failed") ||
    msg.includes("network")
  );
}

const DEFAULT_SLEEP = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Bounded-retry chokepoint for the box worker's `agent_jobs` update. Returns
 * `AgentJobsUpdateSuccess` on any successful attempt; throws `AgentJobsUpdateError` once
 * attempts are exhausted so the caller cannot silently proceed.
 */
export async function writeAgentJobsUpdateWithRetry(
  runOnce: AgentJobsUpdateRunOnce,
  opts: AgentJobsUpdateRetryOpts,
): Promise<AgentJobsUpdateSuccess> {
  const attempts = Math.min(8, Math.max(1, opts.attempts ?? 4));
  const baseDelayMs = Math.max(0, opts.baseDelayMs ?? 250);
  const sleep = opts.sleep ?? DEFAULT_SLEEP;
  const warn = opts.logger?.warn ?? ((m: string) => console.warn(m));
  const errorLog = opts.logger?.error ?? ((m: string) => console.error(m));

  let lastResponse: AgentJobsUpdateResponse | null = null;
  let lastThrown: unknown = null;
  let lastError: AgentJobsUpdateResponse["error"] | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resp = await runOnce();
      lastResponse = resp;
      if (!resp.error) {
        return { ok: true, attempts: attempt, response: resp };
      }
      lastError = resp.error;
      const transient = isTransientAgentJobsUpdateResponse(resp);
      if (!transient) {
        // Terminal PostgREST / non-5xx — do not retry, surface immediately.
        break;
      }
      if (attempt < attempts) {
        warn(
          `[agent-jobs-update-retry] job=${opts.jobId} attemptedStatus=${
            opts.attemptedStatus ?? "?"
          } attempt=${attempt}/${attempts} transient supabase error status=${
            resp.status ?? "?"
          } "${String(resp.error.message ?? "")}" — retrying in ${baseDelayMs * 2 ** (attempt - 1)}ms`,
        );
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    } catch (err) {
      lastThrown = err;
      lastResponse = null;
      lastError = null;
      const transient = isTransientAgentJobsUpdateThrow(err);
      if (!transient) throw err; // terminal throw — surface immediately, don't wrap
      if (attempt < attempts) {
        warn(
          `[agent-jobs-update-retry] job=${opts.jobId} attemptedStatus=${
            opts.attemptedStatus ?? "?"
          } attempt=${attempt}/${attempts} transient thrown="${
            errText(err)
          }" — retrying in ${baseDelayMs * 2 ** (attempt - 1)}ms`,
        );
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  const failure = new AgentJobsUpdateError({
    jobId: opts.jobId,
    attemptedStatus: opts.attemptedStatus ?? null,
    attempts,
    lastError,
    lastResponse,
    lastThrown,
  });
  errorLog(`[agent-jobs-update-retry] SURFACED ${failure.message}`);
  throw failure;
}
