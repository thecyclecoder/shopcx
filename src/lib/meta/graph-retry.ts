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

/** Build the canonical `meta_<status>: <detail>` error, preserving Meta's code/subcode. */
export function graphError(status: number, error: any): Error & { metaCode?: number; metaSubcode?: number } {
  // Meta's useful detail is in error_user_title/msg, falling back to the terse `message`.
  const detail = error?.error_user_title
    ? `${error.error_user_title}: ${error.error_user_msg || ""}`
    : error?.message || "graph_error";
  const e = new Error(`meta_${status}: ${detail}`.trim()) as Error & { metaCode?: number; metaSubcode?: number };
  e.metaCode = error?.code;
  e.metaSubcode = error?.error_subcode;
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
 * Issue a Graph request (the thunk re-runs each attempt so the fetch is fresh),
 * parse JSON, and retry transient failures with bounded exponential backoff +
 * jitter. Returns the parsed JSON on success; throws the canonical graphError on
 * a fatal error or once the attempt budget is exhausted.
 */
export async function graphFetchJson(makeRequest: () => Promise<Response>, label: string): Promise<any> {
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    const res = await makeRequest();
    const json = await res.json().catch(() => ({}));
    if (res.ok && !json.error) return json;

    const err = json.error || {};
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
