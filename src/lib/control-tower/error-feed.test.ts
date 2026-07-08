/**
 * Unit tests for the PURE error-feed noise filters (error-feed-monitoring + its noise-drop
 * specs). Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/error-feed.test.ts
 *
 * Focus: isBareLifecycle must drop the bare Lambda lifecycle/proxy wrapper that opened
 * Control Tower signature `vercel:ebdf493a37c60c34` (error-feed-drop-bare-502-proxy-wrapper
 * spec). The original `$`-anchored proxy-summary regex never matched the real proxy line —
 * which carries trailing tokens (duration/region/bytes) after `status=NNN` — so `.every()`
 * failed and the wrapper was captured as a redundant open incident on a healthy, ticketed
 * Appstle 502 loop.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isBareInngestStepErrorMiddlewareLog,
  isBareLifecycle,
  isForeignGoTrueAuthLogNoise,
  isForeignGoTrueEdgeNoise,
  isInngestStepWrappedNonErrorLog,
  isTransientClientNetworkAbort,
  isTransientInngestStepRetryThrow,
  isTransientInngestTransportError,
  isTransientShopifyWebhookHmacFailure,
  isTransientSupabaseEdgeHandshakeError,
  isTransientSupabaseLogNoise,
  isTransientUndiciHeadersTimeout,
} from "./error-feed";

// Regression fixture: the leaked vercel:ebdf493a37c60c34 blob — a bare Lambda lifecycle
// wrapper around the deliberate /api/portal Appstle 502 (669ms, 343MB/2048MB). The proxy
// summary carries trailing tokens after status=502, which the old `$`-anchored regex missed.
const BARE_502_BLOB = `START RequestId: 1d4f8c2a-9b3e-4a51-8f0c-2e6d7a9b1c33 Version: $LATEST
[POST] /api/portal?route=removeLineItem status=502 669ms
END RequestId: 1d4f8c2a-9b3e-4a51-8f0c-2e6d7a9b1c33
REPORT RequestId: 1d4f8c2a-9b3e-4a51-8f0c-2e6d7a9b1c33	Duration: 669.12 ms	Billed Duration: 670 ms	Memory Size: 2048 MB	Max Memory Used: 343 MB`;

test("isBareLifecycle drops the leaked vercel:ebdf493a37c60c34 bare 502 proxy wrapper", () => {
  assert.equal(isBareLifecycle(BARE_502_BLOB), true);
});

test("isBareLifecycle tolerates trailing tokens after status=NNN (no $ anchor)", () => {
  // duration / region / byte-count trailers Vercel appends to the proxy summary line.
  assert.equal(isBareLifecycle("[POST] /api/portal?route=removeLineItem status=502"), true);
  assert.equal(isBareLifecycle("[POST] /api/portal?route=removeLineItem status=502 669ms"), true);
  assert.equal(isBareLifecycle("[GET] /api/foo status=500 12ms iad1 1234b"), true);
});

test("isBareLifecycle drops a wrapper with split REPORT metric lines", () => {
  const blob = `START RequestId: abc Version: $LATEST
[GET] /api/portal status=500 5ms
END RequestId: abc
REPORT RequestId: abc
Duration: 5.01 ms
Billed Duration: 6 ms
Memory Size: 2048 MB
Max Memory Used: 120 MB
XRAY TraceId: 1-abc-def	SegmentId: 123	Sampled: true`;
  assert.equal(isBareLifecycle(blob), true);
});

test("isBareLifecycle KEEPS a lifecycle block that carries a real error body", () => {
  const blob = `START RequestId: abc Version: $LATEST
2026-06-24T00:00:00.000Z	abc	ERROR	Task timed out after 10.00 seconds
END RequestId: abc
REPORT RequestId: abc	Duration: 10000.00 ms`;
  assert.equal(isBareLifecycle(blob), false);
});

test("isBareLifecycle KEEPS an uncaught-exception stack (not bare)", () => {
  const blob = `START RequestId: abc Version: $LATEST
TypeError: Cannot read properties of undefined (reading 'id')
    at handler (/var/task/route.js:42:11)
END RequestId: abc`;
  assert.equal(isBareLifecycle(blob), false);
});

test("isBareLifecycle returns false on empty / whitespace-only input", () => {
  assert.equal(isBareLifecycle(""), false);
  assert.equal(isBareLifecycle("   \n  \n"), false);
});

// ── isTransientInngestTransportError (error-feed-drop-inngest-transport-http-unreachable) ──
// Regression fixture: the exact http_unreachable transport blob that opened Control Tower
// signature `inngest:06e8cf82e141fbaa` — Inngest couldn't get a clean reply from our Vercel
// SDK URL on the shopcx-platform-director-cron every-15-min beat (a deploy-boundary reap), the cron
// body itself never threw, and the next beat recovered. Classifying it `transient` keeps a
// first sighting from minting a fresh OPEN incident that pages Platform owners.
const HTTP_UNREACHABLE_BLOB =
  "http_unreachable: Error performing request to SDK URL: Your server reset the connection while we were reading the reply: Unexpected ending response";

test("isTransientInngestTransportError matches the inngest:06e8cf82e141fbaa http_unreachable blob", () => {
  assert.equal(isTransientInngestTransportError("Error", HTTP_UNREACHABLE_BLOB), true);
});

test("isTransientInngestTransportError matches on the error NAME too (errName carries the class)", () => {
  assert.equal(isTransientInngestTransportError("http_unreachable", "some downstream detail"), true);
});

test("isTransientInngestTransportError matches each transport-family phrase", () => {
  assert.equal(isTransientInngestTransportError("Error", "Error performing request to SDK URL"), true);
  assert.equal(isTransientInngestTransportError("Error", "Your server reset the connection mid-reply"), true);
  assert.equal(isTransientInngestTransportError("Error", "Unexpected ending response"), true);
});

test("isTransientInngestTransportError KEEPS a real application throw (not transport noise)", () => {
  assert.equal(
    isTransientInngestTransportError("TypeError", "Cannot read properties of undefined (reading 'id')"),
    false,
  );
  assert.equal(isTransientInngestTransportError("Error", "Avalara tax calc returned 422"), false);
});

test("isTransientInngestTransportError returns false on empty / nullish input", () => {
  assert.equal(isTransientInngestTransportError(null, null), false);
  assert.equal(isTransientInngestTransportError("", "   "), false);
  assert.equal(isTransientInngestTransportError(undefined, undefined), false);
});

// ── isTransientInngestStepRetryThrow (error-feed-drop-inngest-step-retry-throws) ──
// Regression fixture: the exact mid-retry throw that opened Control Tower signature
// `vercel:0ffd0e07c0fe9336` — socialPublish detected a transient Meta Graph failure
// (codes 1/2/4/17/32/341/613/5xx/429 per isTransientGraph) and threw so Inngest re-runs
// the step with backoff (PUBLISH_RETRIES=4 ⇒ attempt 1/5 means 4 attempts remain). The
// function body never finally-failed; minting a fresh OPEN incident on every transient
// blip pages Platform owners on a healthy retry loop. Classifying it `transient` keeps
// a first sighting from paging while the recur window still catches a chronic failure.
const INNGEST_RETRY_BLOB =
  "Error: transient publish failure (attempt 1/5): Please reduce the amount of data you're asking for, then retry your request";

test("isTransientInngestStepRetryThrow matches the vercel:0ffd0e07c0fe9336 mid-retry throw", () => {
  assert.equal(isTransientInngestStepRetryThrow("/api/inngest", INNGEST_RETRY_BLOB), true);
});

test("isTransientInngestStepRetryThrow matches any (attempt N/M) with N<M (retries remain)", () => {
  assert.equal(isTransientInngestStepRetryThrow("/api/inngest", "x (attempt 2/5): y"), true);
  assert.equal(isTransientInngestStepRetryThrow("/api/inngest", "x (attempt 3/5): y"), true);
  assert.equal(isTransientInngestStepRetryThrow("/api/inngest", "x (attempt 4/5): y"), true);
  // Case-insensitive + whitespace-tolerant marker.
  assert.equal(isTransientInngestStepRetryThrow("/api/inngest", "x (Attempt 1 / 4): y"), true);
});

test("isTransientInngestStepRetryThrow KEEPS the FINAL attempt (N==M) — terminal failure", () => {
  // The final attempt's throw IS the terminal failure (no retries remain) — recordError
  // should treat it as a real error, not transient, so it pages on first sighting.
  assert.equal(isTransientInngestStepRetryThrow("/api/inngest", "x (attempt 5/5): y"), false);
  assert.equal(isTransientInngestStepRetryThrow("/api/inngest", "x (attempt 4/4): y"), false);
});

test("isTransientInngestStepRetryThrow KEEPS a non-/api/inngest path even with the marker", () => {
  // The marker only matters on the Inngest webhook route — a different route saying
  // "(attempt 1/5)" is some other unrelated string, not a step-retry throw.
  assert.equal(isTransientInngestStepRetryThrow("/api/portal", "transient publish failure (attempt 1/5)"), false);
  assert.equal(isTransientInngestStepRetryThrow("/api/foo", "x (attempt 1/5) y"), false);
});

test("isTransientInngestStepRetryThrow KEEPS a real /api/inngest error without the attempt marker", () => {
  // A real bug on /api/inngest (no `(attempt N/M)` marker) — pages on first sighting.
  assert.equal(
    isTransientInngestStepRetryThrow("/api/inngest", "TypeError: Cannot read properties of undefined (reading 'id')"),
    false,
  );
  assert.equal(isTransientInngestStepRetryThrow("/api/inngest", "function failed after retries"), false);
});

test("isTransientInngestStepRetryThrow returns false on empty / nullish input", () => {
  assert.equal(isTransientInngestStepRetryThrow(null, null), false);
  assert.equal(isTransientInngestStepRetryThrow(undefined, undefined), false);
  assert.equal(isTransientInngestStepRetryThrow("", ""), false);
  assert.equal(isTransientInngestStepRetryThrow("/api/inngest", ""), false);
});

// ── isTransientSupabaseLogNoise (error-feed-supabase-logs-transient-5xx-scoping) ──
// The supabase-logs poller recorded EVERY edge 5xx + every Postgres ERROR with no transient
// flag, so this cluster's simultaneous transient 500s on GET /rest/v1/loop_heartbeats +
// GET /rest/v1/customers (DB-saturation collateral that self-healed) minted a hard OPEN paged
// incident. Classifying a momentary edge 5xx / statement-timeout as transient auto-resolves a
// first sighting; the recur window still surfaces a chronic endpoint that 5xxs every poll.

test("isTransientSupabaseLogNoise treats any edge API 5xx as transient (saturation collateral)", () => {
  assert.equal(isTransientSupabaseLogNoise("api", { statusCode: 500 }), true);
  assert.equal(isTransientSupabaseLogNoise("api", { statusCode: "502" }), true);
  assert.equal(isTransientSupabaseLogNoise("api", { statusCode: " 503 " }), true);
  assert.equal(isTransientSupabaseLogNoise("api", { statusCode: 599 }), true);
});

test("isTransientSupabaseLogNoise KEEPS a non-5xx API status (4xx / nonsense not transient)", () => {
  assert.equal(isTransientSupabaseLogNoise("api", { statusCode: 429 }), false);
  assert.equal(isTransientSupabaseLogNoise("api", { statusCode: 404 }), false);
  assert.equal(isTransientSupabaseLogNoise("api", { statusCode: 600 }), false);
  assert.equal(isTransientSupabaseLogNoise("api", { statusCode: "5xx" }), false);
  assert.equal(isTransientSupabaseLogNoise("api", { statusCode: null }), false);
});

test("isTransientSupabaseLogNoise treats a Postgres statement-timeout / saturation ERROR as transient", () => {
  assert.equal(
    isTransientSupabaseLogNoise("postgres", { severity: "ERROR", message: "canceling statement due to statement timeout" }),
    true,
  );
  assert.equal(isTransientSupabaseLogNoise("postgres", { severity: "ERROR", message: "terminating connection due to administrator command" }), true);
  assert.equal(isTransientSupabaseLogNoise("postgres", { severity: "ERROR", message: "sorry, too many clients already" }), true);
  assert.equal(isTransientSupabaseLogNoise("postgres", { severity: "ERROR", message: "could not serialize access due to concurrent update" }), true);
});

test("isTransientSupabaseLogNoise KEEPS a real Postgres bug (constraint ERROR / FATAL / PANIC) — pages", () => {
  assert.equal(
    isTransientSupabaseLogNoise("postgres", { severity: "ERROR", message: 'duplicate key value violates unique constraint "customers_pkey"' }),
    false,
  );
  // FATAL/PANIC are crashes — never the self-healing transient class, even on a timeout phrasing.
  assert.equal(isTransientSupabaseLogNoise("postgres", { severity: "FATAL", message: "the database system is starting up" }), false);
  assert.equal(isTransientSupabaseLogNoise("postgres", { severity: "PANIC", message: "could not write to file" }), false);
});

test("isTransientSupabaseLogNoise scopes GoTrue browser-abort noise as transient (context canceled / deadline exceeded)", () => {
  // A signed-in browser unmounting mid-request logs the exact "timeout: context canceled"
  // phrase against GET /user — that's the client going away, not a real auth failure.
  assert.equal(
    isTransientSupabaseLogNoise("auth", { severity: "error", message: "Unhandled server error: timeout: context canceled" }),
    true,
  );
  assert.equal(
    isTransientSupabaseLogNoise("auth", { severity: "error", message: "context deadline exceeded" }),
    true,
  );
  // The Go net-layer variant when the request context dies mid-dial — same class,
  // different phrase (error-feed-supabase-logs-transient-auth-dial-canceled).
  assert.equal(
    isTransientSupabaseLogNoise("auth", {
      severity: "error",
      message:
        "Unhandled server error: failed to connect to host=localhost user=supabase_auth_admin database=postgres: dial error (dial tcp [::1]:5432: operation was canceled)",
    }),
    true,
  );
});

test("isTransientUndiciHeadersTimeout — only 'fetch failed' + HeadersTimeout cause is transient (restored undici spec)", () => {
  assert.equal(
    isTransientUndiciHeadersTimeout("TypeError: fetch failed\n  [cause]: HeadersTimeoutError: Headers Timeout Error"),
    true,
  );
  assert.equal(isTransientUndiciHeadersTimeout("TypeError: fetch failed [cause]: UND_ERR_HEADERS_TIMEOUT"), true);
  // 'fetch failed' from a DIFFERENT cause (DNS/TLS/our own throw) is NOT this class — pages.
  assert.equal(isTransientUndiciHeadersTimeout("TypeError: fetch failed\n  [cause]: getaddrinfo ENOTFOUND api.example.com"), false);
  // The cause without the fetch-failed marker (some unrelated log) is not it either.
  assert.equal(isTransientUndiciHeadersTimeout("HeadersTimeoutError somewhere"), false);
  assert.equal(isTransientUndiciHeadersTimeout(""), false);
  assert.equal(isTransientUndiciHeadersTimeout(null), false);
});

test("isTransientSupabaseLogNoise scopes GoTrue dial i/o timeout as transient (timeout sibling of dial ... canceled)", () => {
  // When GoTrue's dial timer fires before the TCP handshake completes, Go emits
  // `failed to connect to host=... : dial error (dial tcp [::1]:5432: i/o timeout)` — the
  // TIMEOUT sibling of the already-scoped `dial ... canceled` shape. Same self-healing
  // class; the recur window catches a chronic dial-timeout spike
  // (error-feed-scope-supabase-auth-dial-io-timeout-transient).
  assert.equal(
    isTransientSupabaseLogNoise("auth", {
      severity: "error",
      message: "dial tcp [::1]:5432: i/o timeout",
    }),
    true,
  );
  assert.equal(
    isTransientSupabaseLogNoise("auth", {
      severity: "error",
      message:
        "Unhandled server error: failed to connect to host=localhost user=supabase_auth_admin database=postgres: dial error (dial tcp [::1]:5432: i/o timeout)",
    }),
    true,
  );
  // A bare `i/o timeout` phrase without the `dial` shape is NOT this class — some other
  // Go net.OpError variant — and stays paged on first sighting.
  assert.equal(
    isTransientSupabaseLogNoise("auth", { severity: "error", message: "read tcp: i/o timeout" }),
    false,
  );
});

test("isTransientSupabaseLogNoise scopes GoTrue 504 gateway-timeout as transient (restored auth-504 spec)", () => {
  // The 2026-07-04 incident shape: `504: Processing this request timed out, please retry
  // after a moment.` A gateway timeout under load, same self-healing class as the
  // context-deadline shape — a one-off pages nobody; a chronic 504 spike recurs + surfaces.
  assert.equal(
    isTransientSupabaseLogNoise("auth", { severity: "error", message: "504: Processing this request timed out, please retry after a moment." }),
    true,
  );
});

// ── isForeignGoTrueEdgeNoise (error-feed-drop-supabase-gotrue-504-edge-noise) ──
// Supabase's own /auth/v1/user 504 on edge_logs — foreign-owned surface, no lever from us.
// The transient class still recurred inside TRANSIENT_RECUR_WINDOW_MS and escalated on
// every cycle; drop AT CAPTURE to the exact shape only.

test("isForeignGoTrueEdgeNoise drops /auth/v1/user + 504 (numeric or string)", () => {
  assert.equal(isForeignGoTrueEdgeNoise("/auth/v1/user", 504), true);
  assert.equal(isForeignGoTrueEdgeNoise("/auth/v1/user", "504"), true);
  assert.equal(isForeignGoTrueEdgeNoise("/auth/v1/user", " 504 "), true);
});

test("isForeignGoTrueEdgeNoise KEEPS /auth/v1/user on other 5xx (real GoTrue outages still page)", () => {
  assert.equal(isForeignGoTrueEdgeNoise("/auth/v1/user", 500), false);
  assert.equal(isForeignGoTrueEdgeNoise("/auth/v1/user", 502), false);
  assert.equal(isForeignGoTrueEdgeNoise("/auth/v1/user", 503), false);
});

test("isForeignGoTrueEdgeNoise KEEPS a 504 on non-auth paths (rest/v1 still pages)", () => {
  assert.equal(isForeignGoTrueEdgeNoise("/rest/v1/customers", 504), false);
  assert.equal(isForeignGoTrueEdgeNoise("/rest/v1/", 504), false);
  assert.equal(isForeignGoTrueEdgeNoise("/auth/v1/token", 504), false);
  assert.equal(isForeignGoTrueEdgeNoise("/", 504), false);
});

test("isForeignGoTrueEdgeNoise returns false on missing path/status", () => {
  assert.equal(isForeignGoTrueEdgeNoise(null, 504), false);
  assert.equal(isForeignGoTrueEdgeNoise(undefined, 504), false);
  assert.equal(isForeignGoTrueEdgeNoise("", 504), false);
  assert.equal(isForeignGoTrueEdgeNoise("/auth/v1/user", null), false);
  assert.equal(isForeignGoTrueEdgeNoise("/auth/v1/user", undefined), false);
  assert.equal(isForeignGoTrueEdgeNoise("/auth/v1/user", ""), false);
  assert.equal(isForeignGoTrueEdgeNoise("/auth/v1/user", "5xx"), false);
});

// ── isForeignGoTrueAuthLogNoise (error-feed-drop-supabase-gotrue-504-auth-log-noise) ──
// The auth_logs sibling of isForeignGoTrueEdgeNoise: the same GoTrue saturation blip
// surfaces on the app-level auth_logs surface as msg `504: Processing this request timed
// out…` + event_message JSON `"path":"/user"` + `"method":"GET"`. Foreign-owned, no lever
// from us; scoping into the transient class still recurred inside TRANSIENT_RECUR_WINDOW_MS
// and escalated on every cycle. Drop AT CAPTURE to the exact shape only.

test("isForeignGoTrueAuthLogNoise drops the exact 504 GoTrue /user shape", () => {
  const eventMessage =
    '{"component":"api","level":"error","method":"GET","msg":"504: Processing this request timed out, please retry after a moment.","path":"/user","status":504,"time":"2026-07-06T18:00:00Z"}';
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "504: Processing this request timed out, please retry after a moment.",
      eventMessage,
    ),
    true,
  );
  // Trailing detail in msg after the 504 prefix stays dropped (same class of GoTrue timeout).
  assert.equal(
    isForeignGoTrueAuthLogNoise("504: Processing this request timed out — retry", eventMessage),
    true,
  );
  // Leading whitespace tolerated.
  assert.equal(
    isForeignGoTrueAuthLogNoise("  504: Processing this request timed out", eventMessage),
    true,
  );
});

test("isForeignGoTrueAuthLogNoise KEEPS a non-504 auth error (invalid JWT, rate limit)", () => {
  const jwtEvent =
    '{"component":"api","level":"error","method":"GET","msg":"invalid JWT: signature mismatch","path":"/user","status":401}';
  assert.equal(isForeignGoTrueAuthLogNoise("invalid JWT: signature mismatch", jwtEvent), false);
  const rateEvent =
    '{"component":"api","level":"error","method":"POST","msg":"rate limit exceeded","path":"/token","status":429}';
  assert.equal(isForeignGoTrueAuthLogNoise("rate limit exceeded", rateEvent), false);
});

test("isForeignGoTrueAuthLogNoise KEEPS a 504 on a non-/user path (real GoTrue outage elsewhere)", () => {
  // /token — the real auth-signing surface. A 504 here IS a real GoTrue outage worth paging.
  const tokenEvent =
    '{"component":"api","level":"error","method":"POST","msg":"504: Processing this request timed out, please retry after a moment.","path":"/token","status":504}';
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "504: Processing this request timed out, please retry after a moment.",
      tokenEvent,
    ),
    false,
  );
  // /admin — same principle.
  const adminEvent =
    '{"component":"api","level":"error","method":"GET","msg":"504: Processing this request timed out, please retry after a moment.","path":"/admin/users","status":504}';
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "504: Processing this request timed out, please retry after a moment.",
      adminEvent,
    ),
    false,
  );
});

test("isForeignGoTrueAuthLogNoise KEEPS a 504 on /user with a non-GET method", () => {
  // A POST/DELETE to /user would be a mutation surface — a 504 there isn't the getUser noise.
  const postEvent =
    '{"component":"api","level":"error","method":"POST","msg":"504: Processing this request timed out, please retry after a moment.","path":"/user","status":504}';
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "504: Processing this request timed out, please retry after a moment.",
      postEvent,
    ),
    false,
  );
});

test("isForeignGoTrueAuthLogNoise returns false on missing / empty inputs", () => {
  const eventMessage =
    '{"component":"api","level":"error","method":"GET","msg":"504: Processing this request timed out, please retry after a moment.","path":"/user","status":504}';
  assert.equal(isForeignGoTrueAuthLogNoise(null, eventMessage), false);
  assert.equal(isForeignGoTrueAuthLogNoise(undefined, eventMessage), false);
  assert.equal(isForeignGoTrueAuthLogNoise("", eventMessage), false);
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "504: Processing this request timed out, please retry after a moment.",
      null,
    ),
    false,
  );
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "504: Processing this request timed out, please retry after a moment.",
      undefined,
    ),
    false,
  );
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "504: Processing this request timed out, please retry after a moment.",
      "",
    ),
    false,
  );
});

test("isTransientSupabaseLogNoise KEEPS a real auth error (invalid JWT, rate limit) — pages", () => {
  assert.equal(isTransientSupabaseLogNoise("auth", { severity: "error", message: "invalid JWT: signature mismatch" }), false);
  assert.equal(isTransientSupabaseLogNoise("auth", { severity: "error", message: "rate limit exceeded" }), false);
  assert.equal(isTransientSupabaseLogNoise("auth", { severity: "error", message: "" }), false);
  assert.equal(isTransientSupabaseLogNoise("auth", { severity: "error", message: null }), false);
});

test("isTransientSupabaseLogNoise returns false on empty postgres message", () => {
  assert.equal(isTransientSupabaseLogNoise("postgres", { severity: "ERROR", message: "" }), false);
  assert.equal(isTransientSupabaseLogNoise("postgres", { severity: "ERROR", message: null }), false);
});

// ── isBareInngestStepErrorMiddlewareLog (error-feed-drop-bare-inngest-step-error-middleware-log) ──
// The Inngest SDK's LoggerMiddleware.onStepError fires on every step throw with
// `proxyLogger.error({ err: arg.error }, 'Inngest step error')`. Vercel's drain serializes only
// the bare Pino msg field, so what reaches our ingester is the literal label with no body.
// Terminal failures are already captured on source='inngest' by inngest-failure-capture.ts —
// the bare middleware log on /api/inngest is duplicate noise that opened Control Tower
// signature `vercel:b1daa612f563f5e9`.

test("isBareInngestStepErrorMiddlewareLog drops the exact bare label on /api/inngest", () => {
  assert.equal(isBareInngestStepErrorMiddlewareLog("Inngest step error", "/api/inngest"), true);
  assert.equal(isBareInngestStepErrorMiddlewareLog("  Inngest step error  ", "/api/inngest"), true);
});

test("isBareInngestStepErrorMiddlewareLog KEEPS the same label on a different path", () => {
  assert.equal(isBareInngestStepErrorMiddlewareLog("Inngest step error", "/api/other"), false);
  assert.equal(isBareInngestStepErrorMiddlewareLog("Inngest step error", null), false);
  assert.equal(isBareInngestStepErrorMiddlewareLog("Inngest step error", undefined), false);
});

test("isBareInngestStepErrorMiddlewareLog KEEPS a non-bare message on /api/inngest (real body)", () => {
  // Same label PLUS additional detail Vercel managed to surface ⇒ not bare, still captured.
  assert.equal(
    isBareInngestStepErrorMiddlewareLog("Inngest step error: TypeError: x is undefined", "/api/inngest"),
    false,
  );
  // An unrelated message on /api/inngest is also kept.
  assert.equal(
    isBareInngestStepErrorMiddlewareLog("Task timed out after 10s", "/api/inngest"),
    false,
  );
});

test("isBareInngestStepErrorMiddlewareLog returns false on empty / nullish input", () => {
  assert.equal(isBareInngestStepErrorMiddlewareLog("", "/api/inngest"), false);
  assert.equal(isBareInngestStepErrorMiddlewareLog("   ", "/api/inngest"), false);
});

// The sibling bare label — Inngest SDK's `wrapFunctionHandler` emits
// `proxyLogger.error({ err }, 'Inngest function error')` on every function-handler
// rejection, same `{ err }, <label>` shape as onStepError. The bare middleware log on
// /api/inngest opened Control Tower signature `vercel:dcc421bdd0ffd0a5` — the second
// bare label noise on top of the authoritative inngest/function.failed capture
// (error-feed-drop-bare-inngest-function-error-middleware-log).

test("isBareInngestStepErrorMiddlewareLog drops the exact 'Inngest function error' label on /api/inngest", () => {
  assert.equal(isBareInngestStepErrorMiddlewareLog("Inngest function error", "/api/inngest"), true);
  assert.equal(isBareInngestStepErrorMiddlewareLog("  Inngest function error  ", "/api/inngest"), true);
});

test("isBareInngestStepErrorMiddlewareLog KEEPS 'Inngest function error' on a different path", () => {
  assert.equal(isBareInngestStepErrorMiddlewareLog("Inngest function error", "/api/other"), false);
  assert.equal(isBareInngestStepErrorMiddlewareLog("Inngest function error", null), false);
  assert.equal(isBareInngestStepErrorMiddlewareLog("Inngest function error", undefined), false);
});

test("isBareInngestStepErrorMiddlewareLog KEEPS a non-bare 'Inngest function error' on /api/inngest (real body)", () => {
  // Same label PLUS additional detail Vercel managed to surface ⇒ not bare, still captured.
  assert.equal(
    isBareInngestStepErrorMiddlewareLog("Inngest function error: TypeError: x is undefined", "/api/inngest"),
    false,
  );
});

// ── isTransientShopifyWebhookHmacFailure (error-feed-shopify-webhook-hmac-transient) ──
// /api/webhooks/shopify(-returns) rejects an unverified request with a 401 + a
// console.error("Shopify webhook HMAC failed for topic=… shop=…"). A single such log is a
// one-off probe (Shopify wiring check, scanner, stale-secret retry) — classifying it
// transient auto-resolves a first sighting (recorded, not paged); a chronic signing bug
// would recur within the window and still surface. The false positive that opened
// Control Tower `vercel:fc64a1540851bf79`.

test("isTransientShopifyWebhookHmacFailure matches the shopify-route HMAC-failure log", () => {
  assert.equal(
    isTransientShopifyWebhookHmacFailure(
      "/api/webhooks/shopify",
      "Shopify webhook HMAC failed for topic=customers/update shop=acme.myshopify.com",
    ),
    true,
  );
});

test("isTransientShopifyWebhookHmacFailure matches the shopify-returns-route HMAC-failure log", () => {
  assert.equal(
    isTransientShopifyWebhookHmacFailure(
      "/api/webhooks/shopify-returns",
      "Shopify returns webhook HMAC failed for topic=returns/create shop=acme.myshopify.com",
    ),
    true,
  );
});

test("isTransientShopifyWebhookHmacFailure is case-insensitive on the path", () => {
  assert.equal(
    isTransientShopifyWebhookHmacFailure(
      "/API/Webhooks/Shopify",
      "Shopify webhook HMAC failed for topic=x shop=y",
    ),
    true,
  );
});

test("isTransientShopifyWebhookHmacFailure KEEPS the same message on a different path", () => {
  // A log from any other path (e.g. relayed/forwarded) is not the shopify-route signature.
  assert.equal(
    isTransientShopifyWebhookHmacFailure(
      "/api/webhooks/meta",
      "Shopify webhook HMAC failed for topic=x shop=y",
    ),
    false,
  );
  assert.equal(
    isTransientShopifyWebhookHmacFailure(null, "Shopify webhook HMAC failed for topic=x shop=y"),
    false,
  );
});

test("isTransientShopifyWebhookHmacFailure KEEPS an unrelated error on the shopify route", () => {
  // A JSON parse failure, a downstream throw — different prefix, kept + paged.
  assert.equal(
    isTransientShopifyWebhookHmacFailure(
      "/api/webhooks/shopify",
      "Shopify webhook error (orders/create): TypeError: Cannot read properties of undefined",
    ),
    false,
  );
  assert.equal(
    isTransientShopifyWebhookHmacFailure("/api/webhooks/shopify", "Unexpected token in JSON"),
    false,
  );
});

test("isTransientShopifyWebhookHmacFailure returns false on empty / nullish input", () => {
  assert.equal(isTransientShopifyWebhookHmacFailure(null, null), false);
  assert.equal(isTransientShopifyWebhookHmacFailure(undefined, undefined), false);
  assert.equal(isTransientShopifyWebhookHmacFailure("", ""), false);
  assert.equal(isTransientShopifyWebhookHmacFailure("/api/webhooks/shopify", ""), false);
});

// ── isTransientClientNetworkAbort (error-feed-drop-safari-load-failed-client-network-abort-noise) ──
// Every browser has a fixed TypeError message for a cancelled/aborted fetch — Safari
// 'Load failed', Chrome/Firefox 'Failed to fetch' / 'NetworkError when attempting to
// fetch resource', iOS URLSession 'The network connection was lost'. With an empty
// stack, that's the aborted-fetch class — mobile-Safari counterpart to the Node stream-abort
// noise. Classifying it transient auto-resolves a first sighting (recorded, not paged);
// a chronic client outage would recur within the window and still surface. The false
// positive that opened Control Tower `client:fe00dcba3e396856` on one iPhone Safari
// 26.5 user hitting /dashboard/roadmap.

test("isTransientClientNetworkAbort matches Safari 'Load failed' with empty stack", () => {
  assert.equal(isTransientClientNetworkAbort("Load failed", null), true);
  assert.equal(isTransientClientNetworkAbort("Load failed", ""), true);
  assert.equal(isTransientClientNetworkAbort("Load failed", undefined), true);
  // Case-insensitive on the message.
  assert.equal(isTransientClientNetworkAbort("load failed", ""), true);
  assert.equal(isTransientClientNetworkAbort("  Load failed  ", ""), true);
});

test("isTransientClientNetworkAbort matches Chrome/Firefox 'Failed to fetch' with empty stack", () => {
  assert.equal(isTransientClientNetworkAbort("Failed to fetch", null), true);
  assert.equal(isTransientClientNetworkAbort("Failed to fetch", ""), true);
});

test("isTransientClientNetworkAbort matches Firefox 'NetworkError when attempting to fetch resource' with empty stack", () => {
  assert.equal(
    isTransientClientNetworkAbort("NetworkError when attempting to fetch resource", null),
    true,
  );
  // Firefox sometimes ships a trailing period.
  assert.equal(
    isTransientClientNetworkAbort("NetworkError when attempting to fetch resource.", ""),
    true,
  );
});

test("isTransientClientNetworkAbort matches iOS URLSession 'The network connection was lost' with empty stack", () => {
  assert.equal(isTransientClientNetworkAbort("The network connection was lost", null), true);
  assert.equal(isTransientClientNetworkAbort("The network connection was lost.", ""), true);
});

test("isTransientClientNetworkAbort matches bare 'network error' with empty stack (Chrome fetch-abort TypeError)", () => {
  assert.equal(isTransientClientNetworkAbort("network error", null), true);
  assert.equal(isTransientClientNetworkAbort("Network error", ""), true);
  assert.equal(isTransientClientNetworkAbort("network error.", null), true);
  assert.equal(isTransientClientNetworkAbort("  Network Error  ", undefined), true);
});

test("isTransientClientNetworkAbort KEEPS the same message with a real stack (code-throw)", () => {
  // A real code-throw carrying the same literal string ships a stack with a frame in our
  // code — that's an application bug we want captured + paged, not swallowed as transient.
  const realStack = `TypeError: Load failed
    at fetchRoadmap (webpack-internal:///./src/app/dashboard/roadmap/page.tsx:42:15)
    at DashboardRoadmap (webpack-internal:///./src/app/dashboard/roadmap/page.tsx:12:5)`;
  assert.equal(isTransientClientNetworkAbort("Load failed", realStack), false);
  assert.equal(isTransientClientNetworkAbort("Failed to fetch", "at foo (bar.js:1:1)"), false);
  assert.equal(
    isTransientClientNetworkAbort("network error", "at fetchRoadmap (page.tsx:1:1)"),
    false,
  );
});

test("isTransientClientNetworkAbort KEEPS an unrelated message (not the abort family)", () => {
  assert.equal(isTransientClientNetworkAbort("TypeError: undefined is not an object", null), false);
  assert.equal(isTransientClientNetworkAbort("Cannot read properties of undefined", ""), false);
  assert.equal(isTransientClientNetworkAbort("Load failed to render", ""), false); // substring, not exact
  assert.equal(isTransientClientNetworkAbort("Something failed to fetch data", ""), false);
});

test("isTransientClientNetworkAbort returns false on empty / nullish message", () => {
  assert.equal(isTransientClientNetworkAbort(null, null), false);
  assert.equal(isTransientClientNetworkAbort(undefined, undefined), false);
  assert.equal(isTransientClientNetworkAbort("", ""), false);
  assert.equal(isTransientClientNetworkAbort("   ", null), false);
});

// ── isTransientSupabaseEdgeHandshakeError (error-feed-drop-supabase-edge-ssl-handshake-noise) ──
// When Supabase's Cloudflare edge briefly can't complete SSL handshake with the origin,
// its response body is Cloudflare's HTML `525: SSL handshake failed` page — not JSON. The
// shortlink route's best-effort click-logging RPC receives that HTML body as
// rpcErr.message and console.error's it (src/app/api/sl/[slug]/route.ts:144), which the
// Vercel log drain surfaces as an ERR /api/sl/[slug] entry. The redirect itself is
// healthy; classifying it transient auto-resolves a first sighting (recorded, not paged)
// while the recur window still surfaces a chronic upstream outage. The false positive
// that opened Control Tower `vercel:be569a72ccfdbf14`.

// Regression fixture: the leaked vercel:be569a72ccfdbf14 blob — the classic Cloudflare
// 525 error page (no-js + oldie preamble + <title> + cf-error-details) naming supabase.co.
const CF_525_SUPABASE_BLOB = `<!DOCTYPE html>
<html lang="en-US" class="no-js ie6 oldie">
<head>
<title>vqfxwvxsrezoivwmyhux.supabase.co | 525: SSL handshake failed</title>
</head>
<body>
<div class="cf-error-details cf-error-525">
<h1>Error 525</h1>
<h2>SSL handshake failed</h2>
</div>
</body>
</html>`;

test("isTransientSupabaseEdgeHandshakeError matches the vercel:be569a72ccfdbf14 leaked 525 blob", () => {
  assert.equal(isTransientSupabaseEdgeHandshakeError(CF_525_SUPABASE_BLOB), true);
});

test("isTransientSupabaseEdgeHandshakeError matches the sibling 526 (Invalid SSL certificate) shape", () => {
  const blob = `<!DOCTYPE html>
<html lang="en-US" class="no-js ie6 oldie">
<head><title>foo.supabase.co | 526: Invalid SSL certificate</title></head>
<body><div class="cf-error-details">Error 526</div></body>
</html>`;
  assert.equal(isTransientSupabaseEdgeHandshakeError(blob), true);
});

test("isTransientSupabaseEdgeHandshakeError matches when only cf-error-details is present (newer Cloudflare template)", () => {
  const blob = `<html><body>
<div class="cf-error-details cf-error-525">
<span>bar.supabase.co</span>
<h2>SSL handshake failed</h2>
</div>
</body></html>`;
  assert.equal(isTransientSupabaseEdgeHandshakeError(blob), true);
});

test("isTransientSupabaseEdgeHandshakeError KEEPS a Cloudflare 525 page for a different host (unrelated upstream)", () => {
  const blob = `<!DOCTYPE html>
<html lang="en-US" class="no-js ie6 oldie">
<head><title>api.acme.com | 525: SSL handshake failed</title></head>
<body><div class="cf-error-details">Error 525</div></body>
</html>`;
  assert.equal(isTransientSupabaseEdgeHandshakeError(blob), false);
});

test("isTransientSupabaseEdgeHandshakeError KEEPS a real Supabase JSON error carrying the words 'SSL handshake'", () => {
  // A genuine Supabase JSON error (no Cloudflare HTML preamble, no cf-error-details) that
  // happens to mention SSL handshake in the message — a real bug, still paged.
  const json = `{"code":"PGRST301","message":"SSL handshake failed with upstream from supabase.co client","hint":null}`;
  assert.equal(isTransientSupabaseEdgeHandshakeError(json), false);
});

test("isTransientSupabaseEdgeHandshakeError KEEPS a Cloudflare page without the SSL 5xx marker", () => {
  // Cloudflare 502/503/522 pages for supabase.co are a different failure mode — no SSL
  // handshake marker, so this classifier ignores them (they may or may not be transient
  // via other classifiers; this one only claims the SSL-handshake noise class).
  const blob = `<!DOCTYPE html>
<html lang="en-US" class="no-js ie6 oldie">
<head><title>foo.supabase.co | 522: Connection timed out</title></head>
<body><div class="cf-error-details">Error 522</div></body>
</html>`;
  assert.equal(isTransientSupabaseEdgeHandshakeError(blob), false);
});

test("isTransientSupabaseEdgeHandshakeError returns false on empty / nullish input", () => {
  assert.equal(isTransientSupabaseEdgeHandshakeError(null), false);
  assert.equal(isTransientSupabaseEdgeHandshakeError(undefined), false);
  assert.equal(isTransientSupabaseEdgeHandshakeError(""), false);
  assert.equal(isTransientSupabaseEdgeHandshakeError("   "), false);
});

// ── isInngestStepWrappedNonErrorLog (error-feed-drop-inngest-step-wrapped-non-error-noise) ──
// A step handler throwing a non-Error (e.g. `throw {foo: 'bar'}`) makes Inngest's
// `buildStepErrorOp` wrap it as `new Error(String(error))` — literally `Error: [object Object]`
// — and Pino's LoggerMiddleware.onStepError logs the wrapped Error. Vercel's drain surfaces the
// wrapped Error's STACK, which has zero application frames because the wrapping happened inside
// the SDK (only compiled Inngest chunk frames like `M.buildStepErrorOp` / `M.tryExecuteStep` /
// `steps-found` / `M._start`). Terminal failures are already captured on source='inngest' by
// inngest-failure-capture.ts, so the vercel-side variant is duplicate noise — the false positive
// that opened Control Tower `vercel:d48a64ae867f66dd`.

// Regression fixture: the wrapped non-Error message + SDK-only stack shape Vercel surfaces.
const STEP_WRAPPED_NON_ERROR_BLOB = `Error: [object Object]
    at M.buildStepErrorOp (/var/task/.next/server/chunks/inngest-abc.js:12:34)
    at M.tryExecuteStep (/var/task/.next/server/chunks/inngest-abc.js:56:78)
    at steps-found (/var/task/.next/server/chunks/inngest-abc.js:90:12)
    at M._start (/var/task/.next/server/chunks/inngest-abc.js:100:5)`;

test("isInngestStepWrappedNonErrorLog drops the vercel:d48a64ae867f66dd wrapped non-Error blob on /api/inngest", () => {
  assert.equal(isInngestStepWrappedNonErrorLog(STEP_WRAPPED_NON_ERROR_BLOB, "/api/inngest"), true);
});

test("isInngestStepWrappedNonErrorLog KEEPS the same blob on a different path", () => {
  assert.equal(isInngestStepWrappedNonErrorLog(STEP_WRAPPED_NON_ERROR_BLOB, "/api/other"), false);
  assert.equal(isInngestStepWrappedNonErrorLog(STEP_WRAPPED_NON_ERROR_BLOB, null), false);
  assert.equal(isInngestStepWrappedNonErrorLog(STEP_WRAPPED_NON_ERROR_BLOB, undefined), false);
});

test("isInngestStepWrappedNonErrorLog KEEPS the same message with a frame in our code (real app throw)", () => {
  // A real application throw carrying the same literal string ships a stack with a frame
  // in `src/`/`app/` — that's an application bug we want captured + paged, not swallowed.
  const withSrcFrame = `Error: [object Object]
    at handler (/var/task/.next/server/src/lib/inngest/publish.js:42:15)
    at M.buildStepErrorOp (/var/task/.next/server/chunks/inngest-abc.js:12:34)
    at M.tryExecuteStep (/var/task/.next/server/chunks/inngest-abc.js:56:78)`;
  assert.equal(isInngestStepWrappedNonErrorLog(withSrcFrame, "/api/inngest"), false);
  const withAppFrame = `Error: [object Object]
    at handler (/var/task/.next/server/app/api/inngest/route.js:1:1)
    at M.buildStepErrorOp (/var/task/.next/server/chunks/inngest-abc.js:12:34)`;
  assert.equal(isInngestStepWrappedNonErrorLog(withAppFrame, "/api/inngest"), false);
});

test("isInngestStepWrappedNonErrorLog KEEPS a real body / real stack (not the wrapped non-Error shape)", () => {
  // Real message, real stack — actionable, kept.
  const realErr = `TypeError: Cannot read properties of undefined (reading 'id')
    at handler (/var/task/.next/server/src/lib/inngest/publish.js:42:15)
    at M.tryExecuteStep (/var/task/.next/server/chunks/inngest-abc.js:56:78)`;
  assert.equal(isInngestStepWrappedNonErrorLog(realErr, "/api/inngest"), false);
  // The wrapped-non-Error prefix but WITHOUT a buildStepErrorOp frame — not this class.
  const noWrapFrame = `Error: [object Object]
    at somewhereElse (/var/task/.next/server/chunks/other.js:1:1)`;
  assert.equal(isInngestStepWrappedNonErrorLog(noWrapFrame, "/api/inngest"), false);
  // The buildStepErrorOp frame but a DIFFERENT message (not the wrapped-object literal).
  const wrongPrefix = `Error: Task timed out after 10s
    at M.buildStepErrorOp (/var/task/.next/server/chunks/inngest-abc.js:12:34)`;
  assert.equal(isInngestStepWrappedNonErrorLog(wrongPrefix, "/api/inngest"), false);
});

test("isInngestStepWrappedNonErrorLog returns false on empty / nullish message", () => {
  assert.equal(isInngestStepWrappedNonErrorLog("", "/api/inngest"), false);
  assert.equal(isInngestStepWrappedNonErrorLog("   ", "/api/inngest"), false);
  // No `at …` frame at all — not a stack; not this class.
  assert.equal(isInngestStepWrappedNonErrorLog("Error: [object Object]", "/api/inngest"), false);
});
