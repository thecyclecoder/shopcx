/**
 * Meta Graph (v21.0) transient-error retry/backoff — Iteration Engine ingest resilience.
 *
 * The iteration engine's daily run was dying at stage 1 (ingest) on Meta's
 * transient `meta_400: Service temporarily unavailable` (Graph error code 2)
 * because the v21.0 Graph clients (`graphGet` in [[meta__performance]],
 * `metaGet`/`metaPost` in [[meta-ads]]) had no retry — any routine Meta wobble
 * failed the whole run and re-failed identically every morning.
 *
 * This is the shared fetch wrapper those clients now call. It classifies Meta's
 * error detail (code / error_subcode / is_transient) and retries TRANSIENT
 * failures (is_transient, code 1/2, HTTP 429, HTTP 5xx) with bounded exponential
 * backoff + jitter. FATAL errors (190 token, 200/10/803 permissions, plain 400
 * validation) still fail fast so a real misconfiguration surfaces immediately.
 * A genuine sustained outage still throws after the attempt budget — resilience,
 * not silent swallowing. Transient retries are `console.warn`-logged
 * (code/subcode/attempt) per the engine's "supervisable, not silent" invariant.
 *
 * See docs/brain/specs/iteration-engine-ingest-resilience.md (Phase 1).
 */

const RETRY_ATTEMPTS = 4; // total attempts (1 initial + 3 retries)
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 8000;

/**
 * The extended Error shape thrown by [[graphError]]. `metaClass` is set on a
 * PERMANENT / api-removed classification ([[isPermanentGraphError]]) so a
 * caller catching a Graph throw can distinguish "vendor removed the endpoint
 * we depended on" from an ordinary fatal / transient wobble.
 *
 * Introduced by [[../../docs/brain/specs/bianca-actually-graduates-crowned-winners-and-a-dead-meta-verb-cannot-fail-silently]]
 * Phase 2 — the ASC-removal incident (Meta removed Advantage+ Shopping Campaign
 * creation) sat silent because there was no signal that a WHOLE CAPABILITY had
 * disappeared behind a Graph endpoint, distinct from a transient rate limit or
 * a stale token. `metaClass='permanent_api_removed'` is that signal.
 */
export type GraphErrorClass = "permanent_api_removed";

export interface GraphError extends Error {
  metaCode?: number;
  metaSubcode?: number;
  httpStatus?: number;
  metaClass?: GraphErrorClass;
}

/** Build the canonical `meta_<status>: <detail>` error, preserving Meta's code/subcode + HTTP status. */
export function graphError(status: number, error: any): GraphError {
  // Meta's useful detail is in error_user_title/msg, falling back to the terse `message`.
  const detail = error?.error_user_title
    ? `${error.error_user_title}: ${error.error_user_msg || ""}`
    : error?.message || "graph_error";
  const e = new Error(`meta_${status}: ${detail}`.trim()) as GraphError;
  e.metaCode = error?.code;
  e.metaSubcode = error?.error_subcode;
  // Attach the HTTP status so callers can classify edge 5xx (e.g. Facebook 504 gateway
  // timeout — Facebook returns HTML, no JSON body, so metaCode/subcode are undefined and
  // only httpStatus distinguishes it from a fatal 400 validation error).
  e.httpStatus = status;
  if (isPermanentGraphError(status, error)) {
    e.metaClass = "permanent_api_removed";
  }
  return e;
}

/**
 * Transient = worth retrying. Meta surfaces these as code 1 ("unknown, retry
 * later") / code 2 ("Service temporarily unavailable" — note: arrives on an HTTP
 * 400, so we MUST classify on the Graph code, not the HTTP status), an explicit
 * `is_transient` flag, HTTP 429 (rate limit), or any HTTP 5xx. Everything else
 * (invalid/expired token 190, permission 200/10/803, plain 400 validation) is
 * fatal and fails fast.
 */
export function isTransientGraphError(status: number, error: any): boolean {
  if (error?.is_transient === true) return true;
  const code = typeof error?.code === "number" ? error.code : Number(error?.code);
  if (code === 1 || code === 2) return true;
  if (status === 429) return true;
  if (status >= 500) return true;
  return false;
}

/**
 * PERMANENT / api-removed = a Meta-side capability we depend on has been
 * removed. Retrying burns quota to reach the same wall; the correct response
 * is to fail loudly, name the capability, and require a human code change.
 *
 * Seeded by the incident that motivated this classification:
 * **Meta removed Advantage+ Shopping Campaign creation** (code `100` subcode
 * `2490568`, "ASC campaigns no longer supported"). The cold-scaler minting
 * function ([[../meta-ads]] `getOrCreateColdScalerCampaign`) had zero live
 * callers, so the breakage sat undetected until the CEO went to crown two
 * Superfood Tabs winners by hand on 2026-07-27 and the mint failed in his
 * face.
 *
 * Also matches the shape Meta uses for other removed / deprecated surfaces —
 * message patterns `/no longer supported|deprecated|not supported with v\d+/i`
 * (case-insensitive) — so a future removed endpoint that carries a different
 * code/subcode but Meta's canonical wording still classifies correctly.
 *
 * Distinct from FATAL (a token or permission issue is caller-fixable) and
 * TRANSIENT (a wobble is retry-able). Permanent-class errors NEVER retry.
 *
 * Introduced by [[../../docs/brain/specs/bianca-actually-graduates-crowned-winners-and-a-dead-meta-verb-cannot-fail-silently]]
 * Phase 2.
 */
export function isPermanentGraphError(status: number, error: any): boolean {
  const code = typeof error?.code === "number" ? error.code : Number(error?.code);
  const subcode =
    typeof error?.error_subcode === "number" ? error.error_subcode : Number(error?.error_subcode);
  // Exact seed signature: Meta code 100 subcode 2490568 = "ASC campaigns no longer supported".
  if (code === 100 && subcode === 2490568) return true;
  // Message-shape fallback — Meta's canonical wording for a removed/deprecated surface. Only
  // fires on HTTP 400 to avoid a message-similar 5xx classifying as permanent instead of
  // transient (the isTransient path above already claims 5xx first, but belt-and-suspenders).
  if (status === 400) {
    const rawMsg = typeof error?.message === "string" ? error.message : "";
    const rawTitle = typeof error?.error_user_title === "string" ? error.error_user_title : "";
    const rawUser = typeof error?.error_user_msg === "string" ? error.error_user_msg : "";
    const haystack = `${rawMsg} ${rawTitle} ${rawUser}`.toLowerCase();
    if (/\bno longer supported\b/.test(haystack)) return true;
    if (/\bdeprecated\b/.test(haystack)) return true;
    if (/not supported with v\d+/.test(haystack)) return true;
  }
  return false;
}

/**
 * Optional module-level handler invoked when [[graphFetchJson]] classifies a
 * response as [[isPermanentGraphError]]. Kept as a fire-and-forget hook so the
 * pure graph-retry primitive stays DB-free and testable in isolation — the
 * real escalation SDK ([[dead-verb-escalation]] `escalateDeadMetaVerb`)
 * registers itself here at process start so any `graphFetchJson` caller reaches
 * the CEO card without knowing to wrap.
 *
 * Errors thrown by the handler are swallowed (a broken escalation must not
 * mask the underlying permanent throw; the caller still receives the tagged
 * GraphError).
 */
export interface PermanentGraphErrorContext {
  /** The label passed to `graphFetchJson` — the calling function + endpoint. */
  label: string;
  /** HTTP status Meta returned (typically 400 for a code-100 removal). */
  status: number;
  /** The tagged Error the caller will receive. Inspect `metaClass` / `metaCode` / `metaSubcode`. */
  error: GraphError;
}

type PermanentGraphErrorHandler = (ctx: PermanentGraphErrorContext) => void | Promise<void>;

let permanentGraphErrorHandler: PermanentGraphErrorHandler | null = null;

/**
 * Register a fire-and-forget handler invoked on every permanent-class Graph
 * error. See [[../../docs/brain/specs/bianca-actually-graduates-crowned-winners-and-a-dead-meta-verb-cannot-fail-silently]]
 * Phase 2 — the CEO card is raised through this seam by
 * [[./dead-verb-escalation]] at import time.
 */
export function registerPermanentGraphErrorHandler(fn: PermanentGraphErrorHandler | null): void {
  permanentGraphErrorHandler = fn;
}

/**
 * Return the current registered handler (or null). Exported for tests that
 * install a spy handler and want to snapshot / restore the prior state.
 */
export function getPermanentGraphErrorHandler(): PermanentGraphErrorHandler | null {
  return permanentGraphErrorHandler;
}

function firePermanentGraphErrorHandler(ctx: PermanentGraphErrorContext): void {
  const handler = permanentGraphErrorHandler;
  if (!handler) return;
  try {
    const result = handler(ctx);
    // A Promise return type is allowed — silently catch to keep graph-retry pure.
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch((err) => {
        console.warn("[graph-retry] permanent-error handler threw (swallowed)", { err });
      });
    }
  } catch (err) {
    console.warn("[graph-retry] permanent-error handler threw (swallowed)", { err });
  }
}

/**
 * Issue a Graph request (the thunk re-runs each attempt so the fetch is fresh),
 * parse JSON, and retry transient failures with bounded exponential backoff +
 * jitter. Returns the parsed JSON on success; throws the canonical graphError on
 * a fatal error or once the attempt budget is exhausted.
 *
 * PERMANENT / api-removed errors ([[isPermanentGraphError]]) NEVER retry — the
 * removed endpoint will not come back, retrying only burns quota to reach the
 * same wall. Instead we fire the registered permanent-error handler ([[../../docs/brain/specs/bianca-actually-graduates-crowned-winners-and-a-dead-meta-verb-cannot-fail-silently]]
 * Phase 2 — the CEO card wire) so the loss is visible immediately, then throw
 * the tagged GraphError (`metaClass='permanent_api_removed'`) so the caller
 * can distinguish it from an ordinary fatal.
 */
export async function graphFetchJson(makeRequest: () => Promise<Response>, label: string): Promise<any> {
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    const res = await makeRequest();
    const json = await res.json().catch(() => ({}));
    if (res.ok && !json.error) return json;

    const err = json.error || {};

    // Permanent = a Meta-side surface we depend on has been removed. Never retry:
    // the endpoint won't return, retrying only burns quota. Fire the escalation
    // handler (fire-and-forget) so a CEO card surfaces the exact capability, then
    // throw the tagged GraphError so the caller can branch on `metaClass`.
    if (isPermanentGraphError(res.status, err)) {
      const tagged = graphError(res.status, err);
      firePermanentGraphErrorHandler({ label, status: res.status, error: tagged });
      console.warn(
        `[graph-retry] ${label} PERMANENT meta error code=${err.code} subcode=${err.error_subcode} ` +
          `http=${res.status} — API surface removed; not retrying, escalating.`,
      );
      throw tagged;
    }

    if (!isTransientGraphError(res.status, err) || attempt === RETRY_ATTEMPTS) {
      throw graphError(res.status, err);
    }

    const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
    const delay = backoff + Math.floor(Math.random() * backoff * 0.25);
    console.warn(
      `[graph-retry] ${label} transient meta error code=${err.code} subcode=${err.error_subcode} ` +
        `http=${res.status} attempt=${attempt}/${RETRY_ATTEMPTS} — retrying in ${delay}ms`,
    );
    await new Promise((r) => setTimeout(r, delay));
  }
  // Unreachable (the attempt===RETRY_ATTEMPTS branch above always throws), but keeps TS happy.
  throw new Error(`meta_graph_retry_exhausted: ${label}`);
}
