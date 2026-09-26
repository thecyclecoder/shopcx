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
  isForeignAppstleUnskipUpstream500,
  isForeignBraintreeVaultGatewayRejection,
  isForeignBraintreeVaultProcessorDecline,
  isForeignEasyPostReturnsSweepMissingCarrierCredentials,
  isForeignEasyPostReturnsSweepRateLimit,
  isForeignGoTrueAuthLogNoise,
  isForeignGoTrueEdgeNoise,
  isForeignSupabasePostgresAmbiguousOidIntrospectionNoise,
  isForeignSupabasePostgresOrdersNameLookupNoise,
  isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise,
  isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise,
  isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise,
  isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise,
  isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise,
  isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise,
  isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise,
  isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise,
  isForeignSupabasePostgresPoliciesKindLookupNoise,
  isForeignSupabasePostgresMissingControlTowerEventsLookupNoise,
  isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise,
  isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise,
  isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise,
  isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise,
  isForeignSupabasePostgresAggregateIntrospectionNoise,
  isInngestStepWrappedNonErrorLog,
  isInngestTerminalFailureMirrorLog,
  isTransientAnthropicOverloadError,
  isTransientAppstleFrequencyUpstreamTimeout,
  isTransientClientNetworkAbort,
  isTransientInngestStepRetryThrow,
  isTransientInngestTransportError,
  isTransientKlaviyoReviewsFetch5xx,
  isTransientShopifyWebhookHmacFailure,
  isTransientSupabaseEdgeHandshakeError,
  isTransientSupabaseEdgeHtmlBody,
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
  // The exact wire shape from Control Tower `vercel:694d6c93d00ffabd`: an Inngest
  // `step.run(...)` fetch call trips undici's headers-timeout, the outer Error wraps the
  // TypeError with `{ cause }`, and Node's `util.inspect` emits the bracketed wrapped-error
  // form — the `]` between `TypeError` and `:` breaks the plain `TypeError: fetch failed`
  // substring, and `Headers Timeout Error` (three spaced words) is the underlying Error's
  // `.message`, not the class-name `HeadersTimeoutError` or code `UND_ERR_HEADERS_TIMEOUT`
  // (error-feed-headers-timeout-classifier-match-bracketed-cause-).
  assert.equal(
    isTransientUndiciHeadersTimeout(
      "[Error [TypeError]: fetch failed] { stepId: 'discover', [cause]: Error: Headers Timeout Error }",
    ),
    true,
  );
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

test("isTransientSupabaseLogNoise scopes /authorize browser-abort via event_message.error (supabase-logs:a30ffe4489dd6ffb)", () => {
  // On GoTrue's /authorize (PKCE flow_state), the browser-abort marker lives INSIDE the
  // event_message JSON's `error` field — the top-level msg is only `500: Error creating
  // flow state` and never mentions the abort itself. Fold the inner `error` into the same
  // browser-abort set as msg so a user closing the Google-login tab mid-OAuth stops
  // minting page-worthy incidents
  // ([[../specs/error-feed-scope-supabase-authorize-flow-state-context-cance]]).
  const eventMessage = JSON.stringify({
    action: "authorize",
    error: "context canceled",
    method: "GET",
    path: "/authorize",
    status: 500,
  });
  assert.equal(
    isTransientSupabaseLogNoise("auth", {
      severity: "error",
      message: "500: Error creating flow state",
      eventMessage,
    }),
    true,
  );
});

test("isTransientSupabaseLogNoise KEEPS a real /authorize error inside event_message (invalid JWT still pages)", () => {
  // A genuine authorize failure whose event_message.error is NOT a browser-abort marker
  // (e.g. `invalid JWT`, `signature mismatch`, non-abort 5xx) must still page on first
  // sighting — only the abort shapes are folded into the transient class.
  const eventMessage = JSON.stringify({
    action: "authorize",
    error: "invalid JWT: unable to parse or verify signature",
    method: "GET",
    path: "/authorize",
    status: 401,
  });
  assert.equal(
    isTransientSupabaseLogNoise("auth", {
      severity: "error",
      message: "401: invalid JWT",
      eventMessage,
    }),
    false,
  );
});

test("isTransientSupabaseLogNoise tolerates a bad/non-JSON event_message (falls back to msg-only)", () => {
  // A malformed event_message (not JSON, or JSON without an `error` field) must be a no-op —
  // the msg-only path still applies. Neither of these should throw, and neither should flip
  // a non-abort msg into transient.
  assert.equal(
    isTransientSupabaseLogNoise("auth", { severity: "error", message: "invalid JWT", eventMessage: "not-json-at-all" }),
    false,
  );
  assert.equal(
    isTransientSupabaseLogNoise("auth", { severity: "error", message: "invalid JWT", eventMessage: JSON.stringify({ noise: true }) }),
    false,
  );
  // And an abort marker in msg STILL scopes even when event_message is garbage.
  assert.equal(
    isTransientSupabaseLogNoise("auth", { severity: "error", message: "context canceled", eventMessage: "not-json" }),
    true,
  );
});

// ── isForeignSupabasePostgresAggregateIntrospectionNoise ──
// The exact Postgres ERROR `"array_agg" is an aggregate function` surfaces on Supabase's
// postgres_logs feed at severity ERROR when a catalog/introspection query probes a
// built-in aggregate as if it were a scalar function. Foreign-owned surface, no lever from
// us; drop AT CAPTURE to the exact trimmed phrase. Real Postgres bugs (constraint
// violations, FATAL/PANIC, non-timeout ERRORs) still surface.

test("isForeignSupabasePostgresAggregateIntrospectionNoise drops the exact array_agg introspection message", () => {
  assert.equal(
    isForeignSupabasePostgresAggregateIntrospectionNoise('"array_agg" is an aggregate function'),
    true,
  );
  // Leading/trailing whitespace is tolerated (trimmed).
  assert.equal(
    isForeignSupabasePostgresAggregateIntrospectionNoise('  "array_agg" is an aggregate function  '),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresAggregateIntrospectionNoise('\n"array_agg" is an aggregate function\n'),
    true,
  );
});

test("isForeignSupabasePostgresAggregateIntrospectionNoise KEEPS a non-matching Postgres ERROR (constraint violation) so real bugs still page", () => {
  assert.equal(
    isForeignSupabasePostgresAggregateIntrospectionNoise(
      'duplicate key value violates unique constraint "orders_pkey"',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresAggregateIntrospectionNoise(
      'null value in column "customer_id" of relation "orders" violates not-null constraint',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresAggregateIntrospectionNoise("canceling statement due to statement timeout"),
    false,
  );
  // A different aggregate carrying the same shape must still page — the pin is exact.
  assert.equal(
    isForeignSupabasePostgresAggregateIntrospectionNoise('"count" is an aggregate function'),
    false,
  );
  // A super-string of the exact message stays captured — the equality is exact, not a
  // substring test, so an introspection tool wrapping the message in extra context still pages.
  assert.equal(
    isForeignSupabasePostgresAggregateIntrospectionNoise(
      'ERROR: "array_agg" is an aggregate function at line 3',
    ),
    false,
  );
});

test("isForeignSupabasePostgresAggregateIntrospectionNoise returns false on empty / nullish input", () => {
  assert.equal(isForeignSupabasePostgresAggregateIntrospectionNoise(null), false);
  assert.equal(isForeignSupabasePostgresAggregateIntrospectionNoise(undefined), false);
  assert.equal(isForeignSupabasePostgresAggregateIntrospectionNoise(""), false);
  assert.equal(isForeignSupabasePostgresAggregateIntrospectionNoise("   "), false);
});

// ── isForeignSupabasePostgresMissingControlTowerEventsLookupNoise ──
// The ad hoc `select * from public.control_tower_events` lookup by an external tool or a
// stale exploratory query. `control_tower_events` is NOT part of the product schema, so the
// relation-missing ERROR is repair work for a query we don't own. Drop AT CAPTURE only when
// BOTH the exact relation-missing message AND the SELECT-lookup shape are present; a
// relation-missing error on any other table (a real product-schema regression) still pages.

test("isForeignSupabasePostgresMissingControlTowerEventsLookupNoise drops the ad hoc SELECT lookup on the exact relation-missing shape", () => {
  assert.equal(
    isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(
      'relation "public.control_tower_events" does not exist',
      "select * from public.control_tower_events",
    ),
    true,
  );
  // The unqualified (no `public.`) variant is the same class — Postgres sometimes reports
  // the message without the schema qualifier depending on the caller's search_path.
  assert.equal(
    isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(
      'relation "control_tower_events" does not exist',
      "select id, ts from control_tower_events",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(
      'relation "public.control_tower_events" does not exist',
      "select * from public.control_tower_events where ts > now() - interval '1 hour' order by ts desc limit 100",
    ),
    true,
  );
  // Case-insensitive on the query (Postgres normalizes to lowercase in the log, but a hand
  // -typed uppercase SELECT should still drop).
  assert.equal(
    isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(
      'relation "public.control_tower_events" does not exist',
      "SELECT * FROM public.control_tower_events",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(
      'ERROR: relation "public.control_tower_events" does not exist',
      "select * from public.control_tower_events",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(
      '  relation "public.control_tower_events" does not exist  ',
      "   select * from public.control_tower_events   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingControlTowerEventsLookupNoise KEEPS a relation-missing error for any OTHER table (a real product-schema regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(
      'relation "public.orders" does not exist',
      "select * from public.orders",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(
      'relation "public.tickets" does not exist',
      "select * from public.tickets where id = $1",
    ),
    false,
  );
  // A similarly-named foreign table that isn't ours must still page (defence against a
  // renamed / moved control_tower_* table breaking a live query).
  assert.equal(
    isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(
      'relation "public.control_tower_alerts" does not exist',
      "select * from public.control_tower_alerts",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingControlTowerEventsLookupNoise KEEPS a non-SELECT statement shape (a real code-bug on this name still pages)", () => {
  // An INSERT / UPDATE / DELETE / DDL against control_tower_events indicates real code
  // trying to write the table — a bug we WANT to see, not the ad hoc read we drop.
  assert.equal(
    isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(
      'relation "public.control_tower_events" does not exist',
      "insert into public.control_tower_events (id, ts) values ($1, now())",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(
      'relation "public.control_tower_events" does not exist',
      "update public.control_tower_events set resolved_at = now() where id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(
      'relation "public.control_tower_events" does not exist',
      "delete from public.control_tower_events where id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingControlTowerEventsLookupNoise KEEPS a non-relation-missing message shape on this table (a different Postgres error still pages)", () => {
  // A permission denied / column-missing / constraint / other ERROR on the same table name
  // is NOT the ad hoc missing-relation lookup we drop; the pin is exact.
  assert.equal(
    isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(
      'permission denied for relation "public.control_tower_events"',
      "select * from public.control_tower_events",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(
      'column "resolved_at" does not exist',
      "select * from public.control_tower_events",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingControlTowerEventsLookupNoise returns false on empty / nullish input", () => {
  assert.equal(isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(null, null), false);
  assert.equal(isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(undefined, undefined), false);
  assert.equal(isForeignSupabasePostgresMissingControlTowerEventsLookupNoise("", ""), false);
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured (an unqualified miss with no lookup context should surface).
  assert.equal(
    isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(
      'relation "public.control_tower_events" does not exist',
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(
      'relation "public.control_tower_events" does not exist',
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise ──
// The Supabase SQL Editor lookup that confuses `loop_alerts` with `error_events` —
// `select * from public.loop_alerts where title / signature = ...`, columns that live
// on `error_events`, not `loop_alerts`. Foreign-owned surface, no lever from ShopCX —
// drop AT CAPTURE only when BOTH the exact column-missing message (`title` or
// `signature`) AND the bare SELECT-lookup shape on `loop_alerts` are present. A JOIN
// (real code shape), a different relation, or a FATAL/PANIC still pages.

test("isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise drops the ad hoc SELECT lookup on the exact column-missing shape", () => {
  // The two exact messages we've seen — `title` and `signature`, both columns that live
  // on error_events, not loop_alerts.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      'column "title" does not exist',
      "select * from public.loop_alerts where title ilike '%boom%'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      'column "signature" does not exist',
      "select * from public.loop_alerts where signature = 'supabase-logs:0e3379f172768a91'",
    ),
    true,
  );
  // The unqualified (no `public.`) variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      'column "title" does not exist',
      "select id, ts from loop_alerts where title ilike '%foo%'",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      'column "title" does not exist',
      "select * from public.loop_alerts where title ilike '%err%' order by ts desc limit 100",
    ),
    true,
  );
  // Case-insensitive on the query (Postgres normalizes to lowercase in the log, but a
  // hand-typed uppercase SELECT should still drop).
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      'column "signature" does not exist',
      "SELECT * FROM public.loop_alerts WHERE signature = 'x'",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      'ERROR: column "title" does not exist',
      "select * from public.loop_alerts where title ilike '%boom%'",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      '  column "title" does not exist  ',
      "   select * from public.loop_alerts where title = 'x'   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise KEEPS the SAME column-missing message on a DIFFERENT relation (a real product-schema regression still pages)", () => {
  // A table that DOES have `title` (a rename, a missed migration) missing it is a real
  // regression we want to see.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      'column "title" does not exist',
      "select * from public.tickets where title ilike '%foo%'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      'column "signature" does not exist',
      "select * from public.error_events where signature = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise KEEPS a JOIN shape (a real code shape that joins loop_alerts with error_events still pages)", () => {
  // The real code shape when a caller actually means to project loop_alerts's title /
  // signature is a JOIN with error_events — the FROM is error_events (or another
  // relation), not `loop_alerts`, so the pin fails and the row is captured / paged. A
  // real column-missing on this class is a code bug we DO want to see.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      'column "title" does not exist',
      "select ee.title, la.id from public.error_events ee join public.loop_alerts la on la.signature_id = ee.signature_id where ee.title ilike '%boom%'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      'column "signature" does not exist',
      "select la.id from public.error_events ee join public.loop_alerts la on la.id = ee.loop_alert_id where ee.signature = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise KEEPS a FATAL / PANIC / constraint violation on loop_alerts (a different Postgres error still pages)", () => {
  // A FATAL / PANIC / constraint violation on loop_alerts is a different message class —
  // the pin is exact, only the confused-column-lookup shape is dropped.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      "database is shutting down",
      "select * from public.loop_alerts where title ilike '%x%'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      'duplicate key value violates unique constraint "loop_alerts_pkey"',
      "select * from public.loop_alerts where title = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      "canceling statement due to statement timeout",
      "select * from public.loop_alerts where signature = 'x'",
    ),
    false,
  );
  // A permission-denied on the relation is still a foreign-owned surface, but it's a
  // different pin (relation-level, not column-level) — the sibling relation-missing drop
  // is the one that filters that class. Here we confirm this helper stays out of it.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      'permission denied for relation "public.loop_alerts"',
      "select * from public.loop_alerts where title = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise KEEPS a non-SELECT statement shape (a real code-bug on this name still pages)", () => {
  // INSERT / UPDATE / DELETE against loop_alerts referencing a missing column is real
  // code trying to write the table — a bug we WANT to see, not the ad hoc read we drop.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      'column "title" does not exist',
      "insert into public.loop_alerts (title) values ('x')",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      'column "signature" does not exist',
      "update public.loop_alerts set signature = 'x' where id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise KEEPS a DIFFERENT column-missing on loop_alerts (a real column rename still pages)", () => {
  // A real loop_alerts column (e.g. `resolved_at`) going missing is a schema regression
  // we DO want to see — the pin is `title` / `signature` only, not any column name.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      'column "resolved_at" does not exist',
      "select * from public.loop_alerts where resolved_at is null",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise returns false on empty / nullish input", () => {
  assert.equal(isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(null, null), false);
  assert.equal(isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(undefined, undefined), false);
  assert.equal(isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise("", ""), false);
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      'column "title" does not exist',
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(
      'column "title" does not exist',
      null,
    ),
    false,
  );
});


// ── isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise ──
// The ad hoc `select ... from error_events` lookup by an external SQL client that mistyped
// the column name (our schema has `first_seen_at`, not `first_seen`). Drop AT CAPTURE only
// when BOTH the exact column-missing message AND the SELECT-lookup shape naming the bare
// `first_seen` token are present; a column-missing error on any other table (a real schema
// regression), a non-SELECT statement on error_events, or a typo naming the real
// `first_seen_at` column, still pages.

test("isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise drops the ad hoc SELECT lookup on the exact column-missing shape", () => {
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen does not exist",
      "select id, first_seen from public.error_events",
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column public.error_events.first_seen does not exist",
      "select id, first_seen from public.error_events",
    ),
    true,
  );
  // Unqualified table name in the query (search_path resolution) — still the ad hoc shape.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen does not exist",
      "select first_seen from error_events",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen does not exist",
      "select first_seen, count(*) from public.error_events where first_seen > now() - interval '1 hour' order by first_seen desc limit 100",
    ),
    true,
  );
  // Case-insensitive on the query (Postgres normalizes to lowercase in the log, but a hand
  // -typed uppercase SELECT should still drop).
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen does not exist",
      "SELECT FIRST_SEEN FROM PUBLIC.ERROR_EVENTS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "ERROR: column error_events.first_seen does not exist",
      "select first_seen from public.error_events",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "  column error_events.first_seen does not exist  ",
      "   select first_seen from public.error_events   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise KEEPS a column-missing error for any OTHER table (a real product-schema regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column orders.first_seen does not exist",
      "select first_seen from public.orders",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column tickets.first_seen does not exist",
      "select first_seen from public.tickets where id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise KEEPS a non-SELECT statement shape (a real code-bug on this column still pages)", () => {
  // An INSERT / UPDATE / DELETE / DDL naming the missing column indicates real code trying
  // to write the table — a bug we WANT to see, not the ad hoc read we drop.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen does not exist",
      "insert into public.error_events (id, first_seen) values ($1, now())",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen does not exist",
      "update public.error_events set first_seen = now() where id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen does not exist",
      "delete from public.error_events where first_seen < now() - interval '1 day'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise KEEPS a message that names the real `first_seen_at` column (a different mistype still pages)", () => {
  // If the message says `first_seen_at` (the real column) does not exist, that's a
  // genuinely different error — e.g. the column was renamed / dropped in a bad migration.
  // The pin is exact on `first_seen` (no `_at`), so this row stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen_at does not exist",
      "select first_seen_at from public.error_events",
    ),
    false,
  );
  // Same guard on the query side — if the SELECT names `first_seen_at`, our word-boundary
  // regex refuses to match (the `_at` suffix disqualifies the bare `first_seen` token).
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen does not exist",
      "select first_seen_at from public.error_events",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise KEEPS a non-column-missing message shape on this table (a different Postgres error still pages)", () => {
  // A permission denied / relation-missing / constraint / other ERROR on error_events is
  // NOT the ad hoc missing-column lookup we drop; the pin is exact.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      'permission denied for relation "public.error_events"',
      "select first_seen from public.error_events",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      'relation "public.error_events" does not exist',
      "select first_seen from public.error_events",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise returns false on empty / nullish input", () => {
  assert.equal(isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(null, null), false);
  assert.equal(isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(undefined, undefined), false);
  assert.equal(isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise("", ""), false);
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured (an unqualified miss with no lookup context should surface).
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise ──
// The ad hoc `select ... metadata ... from public.error_events` lookup by an external tool
// or a stale exploratory query. `error_events` is a real product table but no ShopCX code
// path / migration / view / function / trigger references an `error_events.metadata` column,
// so the column-missing ERROR is repair work for a query we don't own. Drop AT CAPTURE only
// when BOTH the exact column-missing message AND the SELECT-lookup shape are present; a
// column-missing error on any other column of error_events (a real schema regression), on
// `metadata` for any other table, or via a non-SELECT statement (real code-bug) still pages.

test("isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise drops the ad hoc SELECT lookup on the exact column-missing shape", () => {
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "column error_events.metadata does not exist",
      "select metadata from public.error_events",
    ),
    true,
  );
  // The `public.` qualified variant of the message is the same class — Postgres sometimes
  // includes the schema on the column name depending on the caller's search_path.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "column public.error_events.metadata does not exist",
      "select id, metadata from public.error_events",
    ),
    true,
  );
  // Bare / unqualified `from error_events` (no `public.` prefix) is the same shape.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "column error_events.metadata does not exist",
      "select id, metadata from error_events",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "column error_events.metadata does not exist",
      "select metadata from public.error_events where first_seen_at > now() - interval '1 hour' order by first_seen_at desc limit 100",
    ),
    true,
  );
  // Case-insensitive on the query (Postgres normalizes to lowercase in the log, but a hand
  // -typed uppercase SELECT should still drop).
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "column error_events.metadata does not exist",
      "SELECT metadata FROM public.error_events",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "ERROR: column error_events.metadata does not exist",
      "select metadata from public.error_events",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "  column error_events.metadata does not exist  ",
      "   select metadata from public.error_events   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise KEEPS a column-missing error on OTHER tables (a real code bug on another table still pages)", () => {
  // `metadata` on a table that isn't ours (or a table where metadata SHOULD exist) is a
  // real code bug we WANT to see, not the ad hoc read on error_events we drop.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "column orders.metadata does not exist",
      "select metadata from public.orders",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "column tickets.metadata does not exist",
      "select id, metadata from public.tickets where id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise KEEPS a column-missing error for a DIFFERENT column on error_events (a real schema regression still pages)", () => {
  // A missing `signature` / `first_seen_at` on error_events is a live-column regression
  // we DO want to page on — the pin is exact to `metadata`.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "column error_events.signature does not exist",
      "select signature from public.error_events",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "column error_events.first_seen_at does not exist",
      "select first_seen_at from public.error_events",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug on this name still pages)", () => {
  // An INSERT / UPDATE / DELETE / DDL against error_events with a `metadata` field
  // indicates real code trying to WRITE the column — a bug we WANT to see, not the ad
  // hoc read we drop.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "column error_events.metadata does not exist",
      "insert into public.error_events (id, metadata) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "column error_events.metadata does not exist",
      "update public.error_events set metadata = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "column error_events.metadata does not exist",
      "delete from public.error_events where metadata is null",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise KEEPS a non-column-missing message shape on this table (FATAL / PANIC / other Postgres error still pages)", () => {
  // A relation-missing / permission-denied / FATAL / PANIC error on the same table name
  // is NOT the ad hoc missing-column lookup we drop; the pin is exact.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      'relation "public.error_events" does not exist',
      "select metadata from public.error_events",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      'permission denied for relation "public.error_events"',
      "select metadata from public.error_events",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "FATAL: sorry, too many clients already",
      "select metadata from public.error_events",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "PANIC: could not write to file",
      "select metadata from public.error_events",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(null, null), false);
  assert.equal(isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(undefined, undefined), false);
  assert.equal(isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise("", ""), false);
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured (an unqualified miss with no lookup context should surface).
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "column error_events.metadata does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(
      "column error_events.metadata does not exist",
      null,
    ),
    false,
  );
});


// ── isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise ──
// The ad hoc `select ... <column> ... from public.error_events` lookup by an external tool
// or a stale exploratory query. `error_events` is a real product table with a stable known
// column set — a raw SELECT that names a column we don't own only comes from an external
// caller, so the column-missing ERROR is repair work for a query we don't own. Drop AT
// CAPTURE only when BOTH a column-missing message pinned to `error_events.<any-unquoted-
// identifier>` AND the SELECT-lookup shape are present; a column-missing error on any OTHER
// table, or on `error_events` via a non-SELECT statement (real code-bug shape), still pages.
// This generic form subsumes the earlier per-column drops (`metadata`, `first_seen_at`).

test("isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise drops the ad hoc SELECT lookup on any error_events column", () => {
  // `metadata` — the first observed instance (subsumes the earlier per-column drop).
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      "select metadata from public.error_events",
    ),
    true,
  );
  // `first_seen_at` — the second observed instance (subsumes the sibling per-column drop).
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.first_seen_at does not exist",
      "select first_seen_at from public.error_events",
    ),
    true,
  );
  // Any other unquoted-identifier column name is the same class — the pin is on the
  // `error_events.` prefix and the SELECT-lookup shape, not the specific column.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.foo_bar does not exist",
      "select foo_bar from public.error_events",
    ),
    true,
  );
  // The `public.` qualified variant of the message is the same class — Postgres sometimes
  // includes the schema on the column name depending on the caller's search_path.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column public.error_events.metadata does not exist",
      "select id, metadata from public.error_events",
    ),
    true,
  );
  // Bare / unqualified `from error_events` (no `public.` prefix) is the same shape.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      "select id, metadata from error_events",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      "select metadata from public.error_events where first_seen_at > now() - interval '1 hour' order by first_seen_at desc limit 100",
    ),
    true,
  );
  // Case-insensitive on the query (Postgres normalizes to lowercase in the log, but a hand
  // -typed uppercase SELECT should still drop).
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      "SELECT metadata FROM public.error_events",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "ERROR: column error_events.metadata does not exist",
      "select metadata from public.error_events",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "  column error_events.metadata does not exist  ",
      "   select metadata from public.error_events   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise KEEPS a column-missing error on OTHER tables (a real code bug on another table still pages)", () => {
  // A missing column on any OTHER table is a real code bug we WANT to see, not the ad hoc
  // read on error_events we drop. The pin is `error_events.` only.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column orders.metadata does not exist",
      "select metadata from public.orders",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column tickets.metadata does not exist",
      "select id, metadata from public.tickets where id = $1",
    ),
    false,
  );
  // A table whose name happens to end in `error_events` still doesn't match — the pin
  // requires the exact table name at the start.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column archived_error_events.metadata does not exist",
      "select metadata from public.archived_error_events",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug on this name still pages)", () => {
  // An INSERT / UPDATE / DELETE / DDL against error_events with a bogus column indicates
  // real code trying to WRITE the column — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      "insert into public.error_events (id, metadata) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.first_seen_at does not exist",
      "update public.error_events set first_seen_at = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      "delete from public.error_events where metadata is null",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise KEEPS a non-column-missing message shape on this table (FATAL / PANIC / other Postgres error still pages)", () => {
  // A relation-missing / permission-denied / FATAL / PANIC error on the same table name
  // is NOT the ad hoc missing-column lookup we drop; the pin is on the column-missing
  // shape only.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      'relation "public.error_events" does not exist',
      "select metadata from public.error_events",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      'permission denied for relation "public.error_events"',
      "select metadata from public.error_events",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "FATAL: sorry, too many clients already",
      "select metadata from public.error_events",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "PANIC: could not write to file",
      "select metadata from public.error_events",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(null, null), false);
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise("", ""), false);
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured (an unqualified miss with no lookup context should surface).
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      null,
    ),
    false,
  );
});


// ── isForeignSupabasePostgresAmbiguousOidIntrospectionNoise ──
// The exact Postgres ERROR `column reference "oid" is ambiguous` surfaces on Supabase's
// postgres_logs feed at severity ERROR when a catalog-introspection query joins two
// pg_catalog tables (each carrying its own `oid` column) without qualifying the reference.
// None of our own SQL emits this — every ShopCX `oid` reference is qualified — so the row
// is from an external / manual catalog probe (Control Tower `supabase-logs:6961407f61ea9a08`).
// Drop AT CAPTURE to the exact phrase; real Postgres bugs (a different ambiguous column,
// FATAL/PANIC, constraint violations, statement timeouts) still surface.

test("isForeignSupabasePostgresAmbiguousOidIntrospectionNoise drops the exact ambiguous-oid message", () => {
  assert.equal(
    isForeignSupabasePostgresAmbiguousOidIntrospectionNoise('column reference "oid" is ambiguous'),
    true,
  );
  // Leading/trailing whitespace tolerated (trimmed).
  assert.equal(
    isForeignSupabasePostgresAmbiguousOidIntrospectionNoise('  column reference "oid" is ambiguous  '),
    true,
  );
  // Newline padding is tolerated by the trim.
  assert.equal(
    isForeignSupabasePostgresAmbiguousOidIntrospectionNoise('\ncolumn reference "oid" is ambiguous\n'),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check (mirrors the sibling
  // missing-relation drop's behavior).
  assert.equal(
    isForeignSupabasePostgresAmbiguousOidIntrospectionNoise('ERROR: column reference "oid" is ambiguous'),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresAmbiguousOidIntrospectionNoise('ERROR:  column reference "oid" is ambiguous'),
    true,
  );
});

test("isForeignSupabasePostgresAmbiguousOidIntrospectionNoise KEEPS a different ambiguous-column message (real query bug still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresAmbiguousOidIntrospectionNoise('column reference "id" is ambiguous'),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresAmbiguousOidIntrospectionNoise('column reference "customer_id" is ambiguous'),
    false,
  );
});

test("isForeignSupabasePostgresAmbiguousOidIntrospectionNoise KEEPS unrelated Postgres ERRORs and FATALs so real bugs still page", () => {
  assert.equal(
    isForeignSupabasePostgresAmbiguousOidIntrospectionNoise(
      'duplicate key value violates unique constraint "orders_pkey"',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresAmbiguousOidIntrospectionNoise("canceling statement due to statement timeout"),
    false,
  );
  // A FATAL crash surfaced on postgres_logs must still page — the pin is exact.
  assert.equal(
    isForeignSupabasePostgresAmbiguousOidIntrospectionNoise(
      "the database system is in recovery mode",
    ),
    false,
  );
  // A super-string of the exact message stays captured — the equality is exact.
  assert.equal(
    isForeignSupabasePostgresAmbiguousOidIntrospectionNoise(
      'column reference "oid" is ambiguous at character 42',
    ),
    false,
  );
});

test("isForeignSupabasePostgresAmbiguousOidIntrospectionNoise returns false on empty / nullish / whitespace-only input", () => {
  assert.equal(isForeignSupabasePostgresAmbiguousOidIntrospectionNoise(null), false);
  assert.equal(isForeignSupabasePostgresAmbiguousOidIntrospectionNoise(undefined), false);
  assert.equal(isForeignSupabasePostgresAmbiguousOidIntrospectionNoise(""), false);
  assert.equal(isForeignSupabasePostgresAmbiguousOidIntrospectionNoise("   "), false);
  assert.equal(isForeignSupabasePostgresAmbiguousOidIntrospectionNoise("\n\t  "), false);
});

// ── isForeignSupabasePostgresOrdersNameLookupNoise ──
// A foreign / stale PostgREST direct-REST client reads `/rest/v1/orders?select=...name...`
// against our `public.orders` table. The `orders` table exists but has no `name` column
// (ShopCX uses first_name / last_name / internal UUID id). Foreign-owned surface, no
// lever from us — drop AT CAPTURE only when BOTH the exact column-missing message on
// `orders.name` AND the bare SELECT-lookup shape on `orders` are present. A column-
// missing on any other table, a different column on orders, or a non-SELECT statement
// still pages.

test("isForeignSupabasePostgresOrdersNameLookupNoise drops the ad hoc SELECT lookup on the exact orders.name column-missing shape", () => {
  // The captured PostgREST direct-REST shape — unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "column orders.name does not exist",
      "select id, name from public.orders where id = '00000000-0000-0000-0000-000000000000'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "column public.orders.name does not exist",
      "select id, name from public.orders where id = '00000000-0000-0000-0000-000000000000'",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "column orders.name does not exist",
      "select name from orders limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "column orders.name does not exist",
      "select id, name from public.orders where workspace_id = '00000000' order by created_at desc limit 100",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "column orders.name does not exist",
      "SELECT id, name FROM public.orders WHERE id = 'x'",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "ERROR: column orders.name does not exist",
      "select name from public.orders where id = 'x'",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "  column orders.name does not exist  ",
      "   select name from public.orders   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresOrdersNameLookupNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a name column still pages)", () => {
  // A table that DOES have a `name` column missing it is a real schema regression.
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "column customers.name does not exist",
      "select name from public.customers where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "column products.name does not exist",
      "select name from public.products where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresOrdersNameLookupNoise KEEPS a DIFFERENT column-missing on orders (a real column rename still pages)", () => {
  // A real orders column (e.g. `first_name`) going missing is a schema regression we DO
  // want to see — the pin is `name` only, not any column name.
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "column orders.first_name does not exist",
      "select first_name from public.orders where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "column orders.status does not exist",
      "select status from public.orders where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresOrdersNameLookupNoise KEEPS a non-SELECT statement shape (a real code-bug that writes orders.name still pages)", () => {
  // INSERT / UPDATE / DELETE against orders referencing a bogus column is real code
  // trying to write the table — a bug we WANT to see, not the ad hoc read we drop.
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "column orders.name does not exist",
      "insert into public.orders (name) values ('x')",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "column orders.name does not exist",
      "update public.orders set name = 'x' where id = 'y'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "column orders.name does not exist",
      "delete from public.orders where name = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresOrdersNameLookupNoise KEEPS a FATAL / PANIC / constraint violation / other Postgres ERROR on orders (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "database is shutting down",
      "select id from public.orders where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      'duplicate key value violates unique constraint "orders_pkey"',
      "select id from public.orders where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "canceling statement due to statement timeout",
      "select id from public.orders where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      'permission denied for relation "public.orders"',
      "select id from public.orders where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      'relation "public.orders" does not exist',
      "select id from public.orders where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresOrdersNameLookupNoise returns false on empty / nullish input", () => {
  assert.equal(isForeignSupabasePostgresOrdersNameLookupNoise(null, null), false);
  assert.equal(isForeignSupabasePostgresOrdersNameLookupNoise(undefined, undefined), false);
  assert.equal(isForeignSupabasePostgresOrdersNameLookupNoise("", ""), false);
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "column orders.name does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresOrdersNameLookupNoise(
      "column orders.name does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/spec_phases?select=...workspace_id...` (or the `spec_slug` twin) against
// our `public.spec_phases` table. The `spec_phases` table exists but has no
// `workspace_id` and no `spec_slug` column — those live on the parent `public.specs`
// row (`workspace_id` / `slug`). Foreign-owned surface, no lever from us — drop AT
// CAPTURE only when BOTH the exact column-missing message on one of the two off-
// schema columns AND the bare SELECT-lookup shape on `spec_phases` are present. A
// column-missing on any other table, a different column on `spec_phases`, or a
// non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise drops the ad hoc SELECT lookup on the exact spec_phases.workspace_id / spec_slug column-missing shape", () => {
  // The captured PostgREST direct-REST shape — unqualified and public.-qualified variants,
  // for both off-schema columns.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.workspace_id does not exist",
      "select id, workspace_id from public.spec_phases where id = '00000000-0000-0000-0000-000000000000'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column public.spec_phases.workspace_id does not exist",
      "select id, workspace_id from public.spec_phases where id = '00000000-0000-0000-0000-000000000000'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.spec_slug does not exist",
      "select id, spec_slug from public.spec_phases where spec_slug = 'foo'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column public.spec_phases.spec_slug does not exist",
      "select spec_slug from public.spec_phases limit 10",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.workspace_id does not exist",
      "select workspace_id from spec_phases limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.workspace_id does not exist",
      "select id, workspace_id from public.spec_phases where workspace_id = '00000000' order by position asc limit 100",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.workspace_id does not exist",
      "SELECT id, workspace_id FROM public.spec_phases WHERE id = 'x'",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "ERROR: column spec_phases.workspace_id does not exist",
      "select workspace_id from public.spec_phases where id = 'x'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "ERROR:  column spec_phases.spec_slug does not exist",
      "select spec_slug from public.spec_phases where spec_slug = 'x'",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "  column spec_phases.workspace_id does not exist  ",
      "   select workspace_id from public.spec_phases   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise KEEPS a column-missing error on any OTHER table (a table that DOES have workspace_id / spec_slug still pages)", () => {
  // `specs` itself has `workspace_id` — a real column-missing there is a schema regression.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column specs.workspace_id does not exist",
      "select workspace_id from public.specs where id = 'x'",
    ),
    false,
  );
  // Any product table with a real workspace_id column that goes missing should page.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column customers.workspace_id does not exist",
      "select workspace_id from public.customers where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column tickets.workspace_id does not exist",
      "select workspace_id from public.tickets where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise KEEPS a DIFFERENT column-missing on spec_phases (a real schema regression still pages)", () => {
  // A real spec_phases column (e.g. `spec_id` or `position`) going missing is a schema
  // regression we DO want to see — the pin is `workspace_id` / `spec_slug` only, not any
  // column name.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.spec_id does not exist",
      "select spec_id from public.spec_phases where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.position does not exist",
      "select position from public.spec_phases where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.slug does not exist",
      "select slug from public.spec_phases where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise KEEPS a join whose FROM is NOT spec_phases (real product join-through-specs still pages)", () => {
  // The real product read shape joins through `public.specs` (FROM specs) — if a
  // `column spec_phases.workspace_id does not exist` surfaces on that shape, it is a
  // real code bug we DO want to page on. The classifier only matches when
  // spec_phases is the FROM target of a bare SELECT.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.workspace_id does not exist",
      "select s.id from public.specs s join public.spec_phases sp on sp.spec_id = s.id where s.workspace_id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise KEEPS a non-SELECT statement shape (a real code-bug that writes spec_phases still pages)", () => {
  // INSERT / UPDATE / DELETE against spec_phases referencing a bogus workspace_id column
  // is real code trying to write the table — a bug we WANT to see, not the ad hoc read
  // we drop.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.workspace_id does not exist",
      "insert into public.spec_phases (workspace_id, position) values ('x', 1)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.workspace_id does not exist",
      "update public.spec_phases set workspace_id = 'x' where id = 'y'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.spec_slug does not exist",
      "delete from public.spec_phases where spec_slug = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise KEEPS a FATAL / PANIC / constraint violation / other Postgres ERROR on spec_phases (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "database is shutting down",
      "select id from public.spec_phases where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      'duplicate key value violates unique constraint "spec_phases_spec_position"',
      "select id from public.spec_phases where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "canceling statement due to statement timeout",
      "select id from public.spec_phases where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      'permission denied for relation "public.spec_phases"',
      "select id from public.spec_phases where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      'relation "public.spec_phases" does not exist',
      "select id from public.spec_phases where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise returns false on empty / nullish input", () => {
  assert.equal(isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(null, null), false);
  assert.equal(isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(undefined, undefined), false);
  assert.equal(isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise("", ""), false);
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.workspace_id does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.workspace_id does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads `/rest/v1/smart_patterns?select=
// ...content...` against our `public.smart_patterns` table. The `smart_patterns` table
// exists (workspace-scoped classifier patterns) but has no `content` column — text lives
// in `phrases` / `embedding_text` / `description` / `name`. Foreign-owned surface, no
// lever from us — drop AT CAPTURE only when BOTH the exact column-missing message on
// `smart_patterns.content` AND the bare SELECT-lookup shape on `smart_patterns` are
// present. A column-missing on any other table, a different column on smart_patterns, or
// a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise drops the ad hoc SELECT lookup on the exact smart_patterns.content column-missing shape", () => {
  // The captured PostgREST direct-REST shape — unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "column smart_patterns.content does not exist",
      "select id, content from public.smart_patterns where id = '00000000-0000-0000-0000-000000000000'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "column public.smart_patterns.content does not exist",
      "select id, content from public.smart_patterns where id = '00000000-0000-0000-0000-000000000000'",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "column smart_patterns.content does not exist",
      "select content from smart_patterns limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "column smart_patterns.content does not exist",
      "select id, content from public.smart_patterns where workspace_id = '00000000' order by created_at desc limit 100",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "column smart_patterns.content does not exist",
      "SELECT id, content FROM public.smart_patterns WHERE id = 'x'",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "ERROR: column smart_patterns.content does not exist",
      "select content from public.smart_patterns where id = 'x'",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "  column smart_patterns.content does not exist  ",
      "   select content from public.smart_patterns   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a content column still pages)", () => {
  // A table that DOES have a `content` column missing it is a real schema regression.
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "column ticket_messages.content does not exist",
      "select content from public.ticket_messages where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "column policies.content does not exist",
      "select content from public.policies where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise KEEPS a DIFFERENT column-missing on smart_patterns (a real column rename still pages)", () => {
  // A real smart_patterns column (e.g. `phrases`, `embedding_text`, `description`) going
  // missing is a schema regression we DO want to see — the pin is `content` only.
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "column smart_patterns.phrases does not exist",
      "select phrases from public.smart_patterns where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "column smart_patterns.embedding_text does not exist",
      "select embedding_text from public.smart_patterns where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "column smart_patterns.description does not exist",
      "select description from public.smart_patterns where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug that writes smart_patterns.content still pages)", () => {
  // INSERT / UPDATE / DELETE against smart_patterns referencing a bogus column is real
  // code trying to write the table — a bug we WANT to see, not the ad hoc read we drop.
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "column smart_patterns.content does not exist",
      "insert into public.smart_patterns (content) values ('x')",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "column smart_patterns.content does not exist",
      "update public.smart_patterns set content = 'x' where id = 'y'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "column smart_patterns.content does not exist",
      "delete from public.smart_patterns where content = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise KEEPS a FATAL / PANIC / constraint violation / other Postgres ERROR on smart_patterns (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "database is shutting down",
      "select id from public.smart_patterns where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      'duplicate key value violates unique constraint "smart_patterns_pkey"',
      "select id from public.smart_patterns where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "canceling statement due to statement timeout",
      "select id from public.smart_patterns where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      'permission denied for relation "public.smart_patterns"',
      "select id from public.smart_patterns where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      'relation "public.smart_patterns" does not exist',
      "select id from public.smart_patterns where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "column smart_patterns.content does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(
      "column smart_patterns.content does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/spec_status_history?select=...created_at...` against our
// `public.spec_status_history` audit table. The table exists but its timestamp column is
// `at`, not `created_at`. Foreign-owned surface, no lever from us — drop AT CAPTURE only
// when BOTH the exact column-missing message on `spec_status_history.created_at` AND the
// bare SELECT-lookup shape on `spec_status_history` are present. A column-missing on any
// other table, a different column on `spec_status_history`, or a non-SELECT statement
// still pages.

test("isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise drops the ad hoc SELECT lookup on the exact spec_status_history.created_at column-missing shape", () => {
  // The captured PostgREST direct-REST shape — unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "column spec_status_history.created_at does not exist",
      "select id, created_at from public.spec_status_history order by created_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "column public.spec_status_history.created_at does not exist",
      "select id, created_at from public.spec_status_history order by created_at desc limit 100",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "column spec_status_history.created_at does not exist",
      "select created_at from spec_status_history limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "column spec_status_history.created_at does not exist",
      "select spec_slug, created_at from public.spec_status_history where field = 'status' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "column spec_status_history.created_at does not exist",
      "SELECT ID, CREATED_AT FROM PUBLIC.SPEC_STATUS_HISTORY",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "ERROR: column spec_status_history.created_at does not exist",
      "select created_at from public.spec_status_history",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "  column spec_status_history.created_at does not exist  ",
      "   select created_at from public.spec_status_history   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a created_at column still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "column orders.created_at does not exist",
      "select created_at from public.orders where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "column tickets.created_at does not exist",
      "select created_at from public.tickets where id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise KEEPS a DIFFERENT column-missing on spec_status_history (the real `at` column renamed still pages)", () => {
  // The real timestamp column is `at`. If someone breaks that, we want to see it.
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "column spec_status_history.at does not exist",
      "select at from public.spec_status_history where spec_slug = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "column spec_status_history.spec_slug does not exist",
      "select spec_slug from public.spec_status_history where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing spec_status_history.created_at still pages)", () => {
  // INSERT / UPDATE / DELETE against spec_status_history referencing a bogus column is
  // real code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "column spec_status_history.created_at does not exist",
      "insert into public.spec_status_history (id, created_at) values ($1, now())",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "column spec_status_history.created_at does not exist",
      "update public.spec_status_history set created_at = now() where id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "column spec_status_history.created_at does not exist",
      "delete from public.spec_status_history where created_at < now() - interval '90 days'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on spec_status_history (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "database is shutting down",
      "select id from public.spec_status_history where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      'duplicate key value violates unique constraint "spec_status_history_pkey"',
      "select id from public.spec_status_history where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "canceling statement due to statement timeout",
      "select id from public.spec_status_history where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      'permission denied for relation "public.spec_status_history"',
      "select id from public.spec_status_history where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      'relation "public.spec_status_history" does not exist',
      "select id from public.spec_status_history where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "column spec_status_history.created_at does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(
      "column spec_status_history.created_at does not exist",
      null,
    ),
    false,
  );
});

// -- isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise --
// A stale / hand-typed ad hoc SELECT against `public.approval_decisions` that references
// the non-existent `agent_jobs.branch_name` column and dangles at the end. Postgres
// reports it as `syntax error at end of input`. Foreign-owned surface - no lever from
// us - drop AT CAPTURE only when ALL of the exact end-of-input syntax message, the bare
// SELECT-lookup shape on approval_decisions, AND the `agent_jobs.branch_name` marker are
// present.

test("isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise drops the ad hoc SELECT syntax-error lookup on the exact approval_decisions + agent_jobs.branch_name shape", () => {
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "syntax error at end of input",
      "select id, agent_jobs.branch_name from public.approval_decisions where",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "syntax error at end of input",
      "select agent_jobs.branch_name from approval_decisions",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "syntax error at end of input",
      "select ad.id, agent_jobs.branch_name from public.approval_decisions ad where ad.workspace_id = 'x' order by",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "syntax error at end of input",
      "SELECT ID, AGENT_JOBS.BRANCH_NAME FROM PUBLIC.APPROVAL_DECISIONS",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "ERROR: syntax error at end of input",
      "select agent_jobs.branch_name from public.approval_decisions",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "  syntax error at end of input  ",
      "   select agent_jobs.branch_name from public.approval_decisions   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise KEEPS a syntax error on any OTHER query", () => {
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "syntax error at end of input",
      "select id from public.orders where",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "syntax error at end of input",
      "select id from public.tickets where status =",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "syntax error at end of input",
      "select id from public.approval_decisions where",
    ),
    false,
  );
});

test("isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise KEEPS a DIFFERENT syntax-error message class", () => {
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "syntax error at or near \"where\"",
      "select agent_jobs.branch_name from public.approval_decisions where",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "syntax error at or near \",\"",
      "select agent_jobs.branch_name from public.approval_decisions,",
    ),
    false,
  );
});

test("isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise KEEPS a non-SELECT statement shape", () => {
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "syntax error at end of input",
      "insert into public.approval_decisions (id, note) values (agent_jobs.branch_name,",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "syntax error at end of input",
      "update public.approval_decisions set note = agent_jobs.branch_name where",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "syntax error at end of input",
      "delete from public.approval_decisions where id = agent_jobs.branch_name and",
    ),
    false,
  );
});

test("isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise KEEPS a column-missing / constraint / FATAL / permission ERROR on approval_decisions", () => {
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "column agent_jobs.branch_name does not exist",
      "select agent_jobs.branch_name from public.approval_decisions",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "database is shutting down",
      "select agent_jobs.branch_name from public.approval_decisions",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      'duplicate key value violates unique constraint "approval_decisions_pkey"',
      "select agent_jobs.branch_name from public.approval_decisions",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "canceling statement due to statement timeout",
      "select agent_jobs.branch_name from public.approval_decisions",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      'permission denied for relation "public.approval_decisions"',
      "select agent_jobs.branch_name from public.approval_decisions",
    ),
    false,
  );
});

test("isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise("", ""),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "syntax error at end of input",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(
      "syntax error at end of input",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/specs?select=...archived_at...` (or `folded_at`, or `deferred_at`) against
// our `public.specs` card table. The `specs` table exists but records lifecycle state
// via `status text` (with a `folded` value and a `deferred` value) + a `deferred boolean`
// flag — none of these three timestamp columns exist. Foreign-owned surface, no lever
// from us — drop AT CAPTURE only when BOTH the exact column-missing message (on one of
// the three obsolete names) AND the bare SELECT-lookup shape on `specs` are present. A
// column-missing on any other table, a different column on `specs`, or a non-SELECT
// statement still pages.

test("isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise drops the ad hoc SELECT lookup on the exact specs.archived_at column-missing shape", () => {
  // The captured PostgREST direct-REST shape — unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.archived_at does not exist",
      "select id, slug, archived_at from public.specs order by archived_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column public.specs.archived_at does not exist",
      "select id, slug, archived_at from public.specs order by archived_at desc limit 100",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.archived_at does not exist",
      "select archived_at from specs limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.archived_at does not exist",
      "select id, archived_at from public.specs where workspace_id = '00000000' order by archived_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.archived_at does not exist",
      "SELECT ID, ARCHIVED_AT FROM PUBLIC.SPECS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "ERROR: column specs.archived_at does not exist",
      "select archived_at from public.specs",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "  column specs.archived_at does not exist  ",
      "   select archived_at from public.specs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise also drops the sibling folded_at and deferred_at shapes", () => {
  // folded_at — the state is stored in specs.status = 'folded', no folded_at timestamp.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.folded_at does not exist",
      "select id, slug, folded_at from public.specs order by folded_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column public.specs.folded_at does not exist",
      "select folded_at from public.specs",
    ),
    true,
  );
  // deferred_at — the state is stored in specs.deferred boolean, no deferred_at timestamp.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.deferred_at does not exist",
      "select id, slug, deferred_at from public.specs order by deferred_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column public.specs.deferred_at does not exist",
      "select deferred_at from public.specs",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have one of these timestamp columns still pages)", () => {
  // tickets DOES carry archived_at (20260330000028_ticket_auto_archive.sql) — a real
  // schema regression there must still page.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column tickets.archived_at does not exist",
      "select archived_at from public.tickets where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column orders.archived_at does not exist",
      "select archived_at from public.orders where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column policies.folded_at does not exist",
      "select folded_at from public.policies where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise KEEPS a DIFFERENT column-missing on specs (a real column rename still pages)", () => {
  // Any real specs column (`status`, `deferred`, `owner`, `parent`, `slug`, `title`)
  // going missing is a schema regression we DO want to see — the pin covers the three
  // obsolete archive-timestamp names only.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.status does not exist",
      "select status from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.deferred does not exist",
      "select deferred from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.owner does not exist",
      "select owner from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.slug does not exist",
      "select slug from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing specs.archived_at still pages)", () => {
  // INSERT / UPDATE / DELETE against specs referencing a bogus timestamp column is real
  // code trying to write the table — a bug we WANT to see, not the ad hoc read we drop.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.archived_at does not exist",
      "insert into public.specs (id, archived_at) values ($1, now())",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.folded_at does not exist",
      "update public.specs set folded_at = now() where id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.deferred_at does not exist",
      "delete from public.specs where deferred_at < now() - interval '90 days'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on specs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "database is shutting down",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      'duplicate key value violates unique constraint "specs_ws_slug"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "canceling statement due to statement timeout",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      'permission denied for relation "public.specs"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      'relation "public.specs" does not exist',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.archived_at does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.folded_at does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/spec_phases?select=...idx...` against our `public.spec_phases` table. The
// table exists but its ordering column is `position`, not `idx`. Foreign-owned surface,
// no lever from us — drop AT CAPTURE only when BOTH the exact column-missing message on
// `spec_phases.idx` AND the bare SELECT-lookup shape on `spec_phases` are present. A
// column-missing on any other table, a different column on `spec_phases`, or a
// non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise drops the ad hoc SELECT lookup on the exact spec_phases.idx column-missing shape", () => {
  // The captured PostgREST direct-REST shape — unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "column spec_phases.idx does not exist",
      "select id, idx from public.spec_phases order by idx asc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "column public.spec_phases.idx does not exist",
      "select id, idx from public.spec_phases order by idx asc limit 100",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "column spec_phases.idx does not exist",
      "select idx from spec_phases limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "column spec_phases.idx does not exist",
      "select spec_id, idx from public.spec_phases where spec_id = 'x' order by idx asc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "column spec_phases.idx does not exist",
      "SELECT ID, IDX FROM PUBLIC.SPEC_PHASES",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "ERROR: column spec_phases.idx does not exist",
      "select idx from public.spec_phases",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "  column spec_phases.idx does not exist  ",
      "   select idx from public.spec_phases   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have an idx column still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "column jobs.idx does not exist",
      "select idx from public.jobs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "column phases.idx does not exist",
      "select idx from public.phases where id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise KEEPS a DIFFERENT column-missing on spec_phases (the real `position` column renamed still pages)", () => {
  // The real ordering column is `position`. If someone breaks that, we want to see it.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "column spec_phases.position does not exist",
      "select position from public.spec_phases where spec_id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "column spec_phases.spec_id does not exist",
      "select spec_id from public.spec_phases where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise KEEPS a JOIN across other tables (a real code shape referencing spec_phases still pages)", () => {
  // A JOIN with another table is a real query shape — not the ad hoc direct-REST read.
  // The regex is anchored on `from (public.)?spec_phases` as the FIRST FROM target; a
  // JOIN whose first FROM is a different table won't match.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "column spec_phases.idx does not exist",
      "select s.slug, p.idx from public.specs s join public.spec_phases p on p.spec_id = s.id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing spec_phases.idx still pages)", () => {
  // INSERT / UPDATE / DELETE against spec_phases referencing a bogus column is real code
  // trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "column spec_phases.idx does not exist",
      "insert into public.spec_phases (spec_id, idx, title) values ($1, 1, 'x')",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "column spec_phases.idx does not exist",
      "update public.spec_phases set idx = 2 where id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "column spec_phases.idx does not exist",
      "delete from public.spec_phases where idx > 3",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on spec_phases (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "database is shutting down",
      "select id from public.spec_phases where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      'duplicate key value violates unique constraint "spec_phases_spec_position"',
      "select id from public.spec_phases where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "canceling statement due to statement timeout",
      "select id from public.spec_phases where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      'permission denied for relation "public.spec_phases"',
      "select id from public.spec_phases where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      'relation "public.spec_phases" does not exist',
      "select id from public.spec_phases where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "column spec_phases.idx does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(
      "column spec_phases.idx does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise ──
// A foreign / stale PostgREST / SQL Editor client runs a legacy approval-history read that
// LEFT-JOINs `public.approval_decisions` to `public.agent_jobs` and asks for `aj.payload`
// / `aj.branch_name` — columns that do not exist on the current `agent_jobs` schema
// (`supabase/migrations/20260618120000_agent_jobs.sql` + its follow-ons). Foreign-owned
// surface, no lever from us — drop AT CAPTURE only when BOTH the exact column-missing
// message on `agent_jobs.payload` / `agent_jobs.branch_name` AND a SELECT that names BOTH
// `approval_decisions` AND `agent_jobs` are present. A column-missing on any other table,
// a different column on `agent_jobs`, a bare SELECT on `agent_jobs` alone (real product
// code), or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise drops the stale approval-history join on the exact agent_jobs.payload / agent_jobs.branch_name column-missing shape", () => {
  // The observed shape — approval_decisions LEFT JOIN agent_jobs, selecting a legacy
  // `aj.payload` column that no longer exists.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column agent_jobs.payload does not exist",
      "select ad.id, aj.payload from public.approval_decisions ad left join public.agent_jobs aj on aj.id = ad.agent_job_id order by ad.at desc limit 100",
    ),
    true,
  );
  // The sibling legacy column `aj.branch_name` — same shape, same drop.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column agent_jobs.branch_name does not exist",
      "select ad.id, aj.branch_name from public.approval_decisions ad left join public.agent_jobs aj on aj.id = ad.agent_job_id",
    ),
    true,
  );
  // public.-qualified column-missing variants.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column public.agent_jobs.payload does not exist",
      "select aj.payload from approval_decisions ad left join agent_jobs aj on aj.id = ad.agent_job_id",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column public.agent_jobs.branch_name does not exist",
      "select aj.branch_name from approval_decisions ad left join agent_jobs aj on aj.id = ad.agent_job_id",
    ),
    true,
  );
  // Case-insensitive on the query — SQL keywords may be uppercase in a copy-pasted read.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column agent_jobs.payload does not exist",
      "SELECT AD.ID, AJ.PAYLOAD FROM PUBLIC.APPROVAL_DECISIONS AD LEFT JOIN PUBLIC.AGENT_JOBS AJ ON AJ.ID = AD.AGENT_JOB_ID",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "ERROR: column agent_jobs.payload does not exist",
      "select aj.payload from public.approval_decisions ad left join public.agent_jobs aj on aj.id = ad.agent_job_id",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "  column agent_jobs.payload does not exist  ",
      "   select aj.payload from public.approval_decisions ad left join public.agent_jobs aj on aj.id = ad.agent_job_id   ",
    ),
    true,
  );
  // A different JOIN keyword (INNER JOIN) or a comma-in-FROM shape is still the same
  // stale approval-history read.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column agent_jobs.payload does not exist",
      "select aj.payload from public.approval_decisions ad inner join public.agent_jobs aj on aj.id = ad.agent_job_id",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column agent_jobs.payload does not exist",
      "select aj.payload from public.approval_decisions ad, public.agent_jobs aj where aj.id = ad.agent_job_id",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise KEEPS a column-missing error on any OTHER table (a real schema regression on a different table still pages)", () => {
  // A table that DOES have a `payload` column missing it is a real schema regression.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column agent_action_grades.payload does not exist",
      "select payload from public.approval_decisions ad left join public.agent_action_grades aj on aj.id = ad.grade_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column ticket_messages.branch_name does not exist",
      "select branch_name from public.approval_decisions ad left join public.ticket_messages t on t.id = ad.ticket_id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise KEEPS a DIFFERENT column-missing on agent_jobs (a real agent_jobs column rename still pages)", () => {
  // Real agent_jobs columns going missing is a schema regression we DO want to see —
  // the pin covers `payload` and `branch_name` only, not any column name.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column agent_jobs.kind does not exist",
      "select aj.kind from public.approval_decisions ad left join public.agent_jobs aj on aj.id = ad.agent_job_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column agent_jobs.status does not exist",
      "select aj.status from public.approval_decisions ad left join public.agent_jobs aj on aj.id = ad.agent_job_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column agent_jobs.spec_slug does not exist",
      "select aj.spec_slug from public.approval_decisions ad left join public.agent_jobs aj on aj.id = ad.agent_job_id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise KEEPS a bare SELECT on agent_jobs alone (real product-code read regressing on the schema still pages)", () => {
  // A bare `select payload from agent_jobs` (no `approval_decisions` join) could be real
  // product code reading agent_jobs after a schema regression — we want to see it. The
  // drop is scoped to the approval-history join shape only.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column agent_jobs.payload does not exist",
      "select payload from public.agent_jobs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column agent_jobs.branch_name does not exist",
      "select branch_name from public.agent_jobs where kind = 'build'",
    ),
    false,
  );
  // Neither table alone — some other approval reader that references neither table but
  // triggers the same message from a different code path — stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column agent_jobs.payload does not exist",
      "select payload from public.something_else where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise KEEPS a non-SELECT statement shape (a real code-bug writing agent_jobs.payload still pages)", () => {
  // INSERT / UPDATE / DELETE against agent_jobs referencing a bogus column is real code
  // trying to write the table — a bug we WANT to see, not the ad hoc read we drop.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column agent_jobs.payload does not exist",
      "insert into public.agent_jobs (id, payload) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column agent_jobs.branch_name does not exist",
      "update public.agent_jobs set branch_name = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column agent_jobs.payload does not exist",
      "delete from public.agent_jobs where payload is null",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on agent_jobs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "database is shutting down",
      "select aj.payload from public.approval_decisions ad left join public.agent_jobs aj on aj.id = ad.agent_job_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      'duplicate key value violates unique constraint "agent_jobs_pkey"',
      "select aj.payload from public.approval_decisions ad left join public.agent_jobs aj on aj.id = ad.agent_job_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "canceling statement due to statement timeout",
      "select aj.payload from public.approval_decisions ad left join public.agent_jobs aj on aj.id = ad.agent_job_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      'permission denied for relation "public.agent_jobs"',
      "select aj.payload from public.approval_decisions ad left join public.agent_jobs aj on aj.id = ad.agent_job_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      'relation "public.agent_jobs" does not exist',
      "select aj.payload from public.approval_decisions ad left join public.agent_jobs aj on aj.id = ad.agent_job_id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column agent_jobs.payload does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(
      "column agent_jobs.payload does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/specs?select=...archived...` against our `public.specs` table. The table
// exists but has no `archived` column — a spec's terminal lifecycle state is `folded`
// on `specs.status` (M4 fold), not a boolean archive flag. Foreign-owned surface, no
// lever from us — drop AT CAPTURE only when BOTH the exact column-missing message on
// `specs.archived` AND the bare SELECT-lookup shape on `specs` are present. A column-
// missing on any other table, a different column on `specs`, or a non-SELECT statement
// still pages.

test("isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise drops the ad hoc SELECT lookup on the exact specs.archived column-missing shape", () => {
  // The captured PostgREST direct-REST shape — unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "column specs.archived does not exist",
      "select id, archived from public.specs where archived = false limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "column public.specs.archived does not exist",
      "select id, archived from public.specs where archived = false limit 100",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "column specs.archived does not exist",
      "select archived from specs limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "column specs.archived does not exist",
      "select slug, archived from public.specs where slug = 'x' order by slug asc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "column specs.archived does not exist",
      "SELECT ID, ARCHIVED FROM PUBLIC.SPECS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "ERROR: column specs.archived does not exist",
      "select archived from public.specs",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "  column specs.archived does not exist  ",
      "   select archived from public.specs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have an archived column still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "column tickets.archived does not exist",
      "select archived from public.tickets where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "column playbooks.archived does not exist",
      "select archived from public.playbooks where id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise KEEPS a DIFFERENT column-missing on specs (the real `status` column renamed still pages)", () => {
  // The real terminal-state column is `status` (values include `folded`). If someone
  // breaks that, we want to see it.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "column specs.status does not exist",
      "select status from public.specs where slug = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "column specs.slug does not exist",
      "select slug from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise KEEPS a column-missing on a sibling `spec_*` table (spec_phases.archived / spec_status_history.archived still pages)", () => {
  // The pin is `specs.archived` only — a `spec_phases.archived` or
  // `spec_status_history.archived` shape must NOT collapse into this drop.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "column spec_phases.archived does not exist",
      "select archived from public.spec_phases where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "column spec_status_history.archived does not exist",
      "select archived from public.spec_status_history where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing specs.archived still pages)", () => {
  // INSERT / UPDATE / DELETE against specs referencing a bogus column is real code
  // trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "column specs.archived does not exist",
      "insert into public.specs (slug, archived) values ($1, false)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "column specs.archived does not exist",
      "update public.specs set archived = true where slug = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "column specs.archived does not exist",
      "delete from public.specs where archived = true",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on specs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "database is shutting down",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      'duplicate key value violates unique constraint "specs_pkey"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "canceling statement due to statement timeout",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      'permission denied for relation "public.specs"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      'relation "public.specs" does not exist',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "column specs.archived does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(
      "column specs.archived does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresPoliciesKindLookupNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/policies?select=...kind...` against our `public.policies` table. The table
// exists but is keyed by `slug` and has no `kind` column by design. Foreign-owned
// surface, no lever from us — drop AT CAPTURE only when BOTH the exact column-missing
// message on `policies.kind` AND the bare SELECT-lookup shape on `policies` are present.
// A column-missing on any other table, a different column on `policies`, or a
// non-SELECT statement still pages.

test("isForeignSupabasePostgresPoliciesKindLookupNoise drops the ad hoc SELECT lookup on the exact policies.kind column-missing shape", () => {
  // The captured PostgREST direct-REST shape — unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "column policies.kind does not exist",
      "select id, kind from public.policies where workspace_id = 'x'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "column public.policies.kind does not exist",
      "select id, kind from public.policies where workspace_id = 'x'",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "column policies.kind does not exist",
      "select kind from policies limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "column policies.kind does not exist",
      "select slug, kind from public.policies where workspace_id = 'x' order by slug asc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "column policies.kind does not exist",
      "SELECT ID, KIND FROM PUBLIC.POLICIES",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "ERROR: column policies.kind does not exist",
      "select kind from public.policies",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "  column policies.kind does not exist  ",
      "   select kind from public.policies   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresPoliciesKindLookupNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a kind column still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "column journeys.kind does not exist",
      "select kind from public.journeys where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "column jobs.kind does not exist",
      "select kind from public.jobs where id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresPoliciesKindLookupNoise KEEPS a DIFFERENT column-missing on policies (the real `slug` column renamed still pages)", () => {
  // Real column drift on the table is a schema regression we DO want to see.
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "column policies.slug does not exist",
      "select slug from public.policies where workspace_id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "column policies.workspace_id does not exist",
      "select workspace_id from public.policies where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresPoliciesKindLookupNoise KEEPS a JOIN across other tables (a real code shape referencing policies still pages)", () => {
  // A JOIN with another table is a real query shape — not the ad hoc direct-REST read.
  // The regex is anchored on `from (public.)?policies` as the FIRST FROM target; a
  // JOIN whose first FROM is a different table won't match.
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "column policies.kind does not exist",
      "select w.name, p.kind from public.workspaces w join public.policies p on p.workspace_id = w.id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresPoliciesKindLookupNoise KEEPS a non-SELECT statement shape (a real code-bug writing policies.kind still pages)", () => {
  // INSERT / UPDATE / DELETE against policies referencing a bogus column is real code
  // trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "column policies.kind does not exist",
      "insert into public.policies (slug, kind) values ($1, 'x')",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "column policies.kind does not exist",
      "update public.policies set kind = 'x' where id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "column policies.kind does not exist",
      "delete from public.policies where kind = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresPoliciesKindLookupNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on policies (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "database is shutting down",
      "select id from public.policies where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      'duplicate key value violates unique constraint "policies_workspace_id_slug_version_key"',
      "select id from public.policies where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "canceling statement due to statement timeout",
      "select id from public.policies where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      'permission denied for relation "public.policies"',
      "select id from public.policies where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      'relation "public.policies" does not exist',
      "select id from public.policies where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresPoliciesKindLookupNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "column policies.kind does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresPoliciesKindLookupNoise(
      "column policies.kind does not exist",
      null,
    ),
    false,
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

// ── isForeignGoTrueAuthLogNoise (error-feed-drop-supabase-gotrue-auth-log-context-deadline-us) ──
// Supabase's own GoTrue `/user` handler timing out on its Postgres backend, arriving on the
// auth_logs feed. Foreign-owned surface, no lever from our side; the transient-recur window
// escalated the chronic saturation (supabase-logs:9f39fe11dd105b2a). Drop AT CAPTURE — exact
// phrase only so `context canceled` / `dial ... i/o timeout` / `invalid JWT` stay unaffected.

test("isForeignGoTrueAuthLogNoise drops the exact phrase (case + whitespace insensitive)", () => {
  assert.equal(isForeignGoTrueAuthLogNoise("Unhandled server error: context deadline exceeded"), true);
  assert.equal(isForeignGoTrueAuthLogNoise("unhandled server error: context deadline exceeded"), true);
  assert.equal(isForeignGoTrueAuthLogNoise("  Unhandled server error: context deadline exceeded  "), true);
});

// ── isForeignGoTrueAuthLogNoise (error-feed-drop-supabase-gotrue-timeout-context-canceled) ──
// Shape (e): msg-only mirror of shape (a) — GoTrue's outer-request-timeout wrapper firing on
// its Postgres backend (`timeout:` prefix in Go's error phrasing). Foreign-owned surface,
// no lever from our side; the transient recur-window empirically failed to absorb the
// ~2/day cadence (supabase-logs:c9eb05fd1d3fb82c, 15 occ / 7 days). Drop AT CAPTURE — the
// exact phrase only so plain `context canceled` (real browser-abort noise, still transient)
// is untouched.

test("isForeignGoTrueAuthLogNoise drops the exact 'timeout: context canceled' phrase (case + whitespace insensitive)", () => {
  assert.equal(isForeignGoTrueAuthLogNoise("Unhandled server error: timeout: context canceled"), true);
  assert.equal(isForeignGoTrueAuthLogNoise("unhandled server error: timeout: context canceled"), true);
  assert.equal(isForeignGoTrueAuthLogNoise("  Unhandled server error: timeout: context canceled  "), true);
});

test("isForeignGoTrueAuthLogNoise KEEPS other GoTrue error phrases (plain context canceled / invalid JWT / rate-limit)", () => {
  // The browser-abort sibling WITHOUT the `timeout:` prefix — a real client-goes-away signal
  // on other paths (including /authorize). Still routed through the transient class.
  assert.equal(isForeignGoTrueAuthLogNoise("Unhandled server error: context canceled"), false);
  assert.equal(isForeignGoTrueAuthLogNoise("context canceled"), false);
  // Actionable GoTrue errors — must still surface / page on first sighting.
  assert.equal(isForeignGoTrueAuthLogNoise("invalid JWT: signature mismatch"), false);
  assert.equal(isForeignGoTrueAuthLogNoise("rate limit exceeded"), false);
});

// ── isForeignGoTrueAuthLogNoise (error-feed-drop-supabase-gotrue-auth-log-localhost-dial-time) ──
// GoTrue → its own localhost Postgres can't finish the dial before its own dial timer
// fires (i/o timeout) or the parent context dies mid-dial (operation was canceled). Foreign
// infrastructure, no lever from our side; chronic recur (7 occ / 9h) escalated the transient
// allowlist entry (supabase-logs:0ca9220a8f0d2405). Drop AT CAPTURE — narrow markers gate the
// drop to Supabase-internal dialing so a real dial failure against OUR remote pooler still pages.

test("isForeignGoTrueAuthLogNoise drops the localhost dial i/o timeout shape", () => {
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "Unhandled server error: failed to connect to `host=localhost user=supabase_auth_admin database=postgres`: dial error (dial tcp [::1]:5432: i/o timeout)",
    ),
    true,
  );
  // Sibling phrasing without backticks — still drops.
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "Unhandled server error: failed to connect to host=localhost user=supabase_auth_admin database=postgres: dial error (dial tcp [::1]:5432: i/o timeout)",
    ),
    true,
  );
  // Leading whitespace still drops (trimStart applies).
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "  Unhandled server error: failed to connect to host=localhost user=supabase_auth_admin database=postgres: dial error (dial tcp [::1]:5432: i/o timeout)",
    ),
    true,
  );
});

test("isForeignGoTrueAuthLogNoise drops the localhost dial 'operation was canceled' sibling", () => {
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "Unhandled server error: failed to connect to `host=localhost user=supabase_auth_admin database=postgres`: dial error (dial tcp [::1]:5432: operation was canceled)",
    ),
    true,
  );
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "Unhandled server error: failed to connect to host=localhost user=supabase_auth_admin database=postgres: dial error (dial tcp [::1]:5432: operation was canceled)",
    ),
    true,
  );
});

test("isForeignGoTrueAuthLogNoise KEEPS a remote-pooler dial failure (no host=localhost / no supabase_auth_admin marker)", () => {
  // A real Postgres pooler on OUR side — different host and user, still transient (retryable
  // reachability blip) but NOT dropped at capture. `isTransientSupabaseLogNoise` covers it.
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "Unhandled server error: failed to connect to host=db.superfoods.co user=postgres database=postgres: dial error (dial tcp 10.0.0.5:5432: i/o timeout)",
    ),
    false,
  );
  // Right shape, wrong user (some other Supabase-internal role) — still keeps.
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "Unhandled server error: failed to connect to host=localhost user=postgres database=postgres: dial error (dial tcp [::1]:5432: i/o timeout)",
    ),
    false,
  );
  // Right shape, wrong host (a real pooler hostname) but supabase_auth_admin user — still
  // keeps (localhost marker is REQUIRED — this is what pins the shape to internal dialing).
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "Unhandled server error: failed to connect to host=db.internal user=supabase_auth_admin database=postgres: dial error (dial tcp 10.0.0.5:5432: i/o timeout)",
    ),
    false,
  );
});

test("isForeignGoTrueAuthLogNoise KEEPS the localhost prefix without a dial timeout phrase", () => {
  // A different failure mode against the same host — real auth-admin outage still pages.
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "Unhandled server error: failed to connect to host=localhost user=supabase_auth_admin database=postgres: FATAL: password authentication failed",
    ),
    false,
  );
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "Unhandled server error: failed to connect to host=localhost user=supabase_auth_admin database=postgres: connection refused",
    ),
    false,
  );
});

test("isForeignGoTrueAuthLogNoise returns false on empty/nullish", () => {
  assert.equal(isForeignGoTrueAuthLogNoise(null), false);
  assert.equal(isForeignGoTrueAuthLogNoise(undefined), false);
  assert.equal(isForeignGoTrueAuthLogNoise(""), false);
  assert.equal(isForeignGoTrueAuthLogNoise("   "), false);
});

test("isForeignGoTrueAuthLogNoise KEEPS a longer/prefixed variant (postgres/api kinds unaffected — different shapes)", () => {
  // A postgres statement-timeout row + an api 5xx row carry different phrasing and go
  // through their own kind branches — nothing here would drop them by accident. The
  // helper is purely a msg-string exact-match, so a non-equal string is always kept.
  assert.equal(isForeignGoTrueAuthLogNoise("statement timeout"), false);
  assert.equal(isForeignGoTrueAuthLogNoise("api 502 GET /rest/v1/loop_heartbeats"), false);
  // A longer/embedded variant — the exact-match contract keeps it (only the bare phrase drops).
  assert.equal(
    isForeignGoTrueAuthLogNoise("prefix Unhandled server error: context deadline exceeded suffix"),
    false,
  );
});

// ── isForeignGoTrueAuthLogNoise (error-feed-drop-supabase-gotrue-auth-log-unable-to-fetch-rec) ──
// GoTrue's `/user` SELECT-on-auth.users emits `Unhandled server error: unable to fetch
// records: context canceled` when the parent HTTP request context dies mid-query — normal
// browser behavior (tab close, navigation away, React StrictMode double-mount aborting an
// in-flight `supabase.auth.getUser()`). Already routed through the transient class via the
// `context canceled` substring, but the signature recurs inside `TRANSIENT_RECUR_WINDOW_MS`
// and paged a Platform owner on a healthy loop (supabase-logs:f5b02a707c3d4e49). Drop AT
// CAPTURE — exact phrase only so a plain `context canceled` on any non-/user path stays
// transient via `isTransientSupabaseLogNoise`.

test("isForeignGoTrueAuthLogNoise drops the exact 'unable to fetch records: context canceled' phrase (case + whitespace insensitive)", () => {
  assert.equal(
    isForeignGoTrueAuthLogNoise("Unhandled server error: unable to fetch records: context canceled"),
    true,
  );
  assert.equal(
    isForeignGoTrueAuthLogNoise("unhandled server error: unable to fetch records: context canceled"),
    true,
  );
  assert.equal(
    isForeignGoTrueAuthLogNoise("  Unhandled server error: unable to fetch records: context canceled  "),
    true,
  );
});

test("isForeignGoTrueAuthLogNoise KEEPS a plain 'context canceled' on a non-/user path (still routed through the transient class)", () => {
  // A plain `context canceled` on a different path — NOT the exact (d) or (e) phrase, so
  // still captured. `isTransientSupabaseLogNoise('auth', …)` still tags it transient.
  assert.equal(isForeignGoTrueAuthLogNoise("context canceled"), false);
  // A longer/embedded variant of the exact (d) phrase — the exact-match contract keeps it.
  assert.equal(
    isForeignGoTrueAuthLogNoise(
      "prefix Unhandled server error: unable to fetch records: context canceled suffix",
    ),
    false,
  );
  // Actionable GoTrue errors still surface / page on first sighting.
  assert.equal(isForeignGoTrueAuthLogNoise("invalid JWT: signature mismatch"), false);
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

// ── isTransientAppstleFrequencyUpstreamTimeout (vercel-appstle-frequency-upstream-timeout-transient-classifi) ──
// `src/lib/appstle.ts` `updateBillingInterval` logs `console.error("Appstle frequency update
// failed:", err)` and then RECOVERS via `verifyBillingInterval` — the log-drain line is a
// pre-recovery sighting of a 20s abort the code already knows how to handle. Classifying it
// transient auto-resolves a first sighting (recorded, not paged); a chronic Appstle outage
// would recur within the window and still surface. Both `/api/inngest` (the durable step)
// and `/api/portal` (the customer portal frequency route) call the SAME helper + share the
// same 20s abort + `verifyBillingInterval` recovery, so their timeout lines are the same
// signature. The false positives that opened Control Tower `vercel:cec725132e1eef09`
// (`/api/inngest`) and later `vercel:63b8e91c77459378` (`/api/portal`).

test("isTransientAppstleFrequencyUpstreamTimeout matches the captured /api/inngest signature", () => {
  assert.equal(
    isTransientAppstleFrequencyUpstreamTimeout(
      "/api/inngest",
      "Appstle frequency update failed: Error: upstream_timeout",
    ),
    true,
  );
});

test("isTransientAppstleFrequencyUpstreamTimeout matches when the message carries a trailing stack", () => {
  assert.equal(
    isTransientAppstleFrequencyUpstreamTimeout(
      "/api/inngest",
      "Appstle frequency update failed: Error: upstream_timeout\n    at loggedAppstleFetch (src/lib/appstle.ts:120:11)",
    ),
    true,
  );
});

test("isTransientAppstleFrequencyUpstreamTimeout KEEPS a non-timeout Appstle failure (paged)", () => {
  // A 4xx/5xx response from Appstle carries a different error class — not the 20s abort's
  // upstream_timeout marker — so the first sighting stays captured and paged.
  assert.equal(
    isTransientAppstleFrequencyUpstreamTimeout(
      "/api/inngest",
      "Appstle frequency update failed: Error: Appstle API error: 500",
    ),
    false,
  );
  assert.equal(
    isTransientAppstleFrequencyUpstreamTimeout(
      "/api/inngest",
      "Appstle frequency update failed: TypeError: Cannot read properties of undefined (reading 'apiKey')",
    ),
    false,
  );
});

test("isTransientAppstleFrequencyUpstreamTimeout matches the captured /api/portal signature", () => {
  // The customer portal frequency route (`/api/portal`) calls the SAME
  // `updateBillingInterval` helper as `/api/inngest`, so its 20s abort surfaces the identical
  // pre-recovery line — auto-resolve on first sighting (Control Tower
  // `vercel:63b8e91c77459378`).
  assert.equal(
    isTransientAppstleFrequencyUpstreamTimeout(
      "/api/portal",
      "Appstle frequency update failed: Error: upstream_timeout",
    ),
    true,
  );
  assert.equal(
    isTransientAppstleFrequencyUpstreamTimeout(
      "/api/portal",
      "Appstle frequency update failed: Error: upstream_timeout\n    at loggedAppstleFetch (src/lib/appstle.ts:120:11)",
    ),
    true,
  );
});

test("isTransientAppstleFrequencyUpstreamTimeout KEEPS a non-timeout Appstle failure on /api/portal (paged)", () => {
  // The allowlist widens ONLY the timeout marker — an unrelated Appstle failure on
  // `/api/portal` (e.g. a real 5xx, a JSON parse throw) still opens + pages on first
  // sighting.
  assert.equal(
    isTransientAppstleFrequencyUpstreamTimeout(
      "/api/portal",
      "Appstle frequency update failed: Error: Appstle API error: 500",
    ),
    false,
  );
  assert.equal(
    isTransientAppstleFrequencyUpstreamTimeout(
      "/api/portal",
      "Appstle frequency update failed: TypeError: Cannot read properties of undefined (reading 'apiKey')",
    ),
    false,
  );
});

test("isTransientAppstleFrequencyUpstreamTimeout KEEPS a non-allowlisted path even with the marker", () => {
  // The allowlist is the exact set of routes that call `updateBillingInterval` — anything
  // else carrying the same marker is a different signature (a different caller, a copy-paste
  // in an unrelated surface) and stays captured / paged.
  assert.equal(
    isTransientAppstleFrequencyUpstreamTimeout(
      "/api/webhooks/appstle",
      "Appstle frequency update failed: Error: upstream_timeout",
    ),
    false,
  );
  assert.equal(
    isTransientAppstleFrequencyUpstreamTimeout(
      null,
      "Appstle frequency update failed: Error: upstream_timeout",
    ),
    false,
  );
});

test("isTransientAppstleFrequencyUpstreamTimeout KEEPS an unrelated error on /api/inngest", () => {
  // Any other Inngest error carrying the words `upstream_timeout` but WITHOUT the Appstle
  // frequency-update label is a different signature — stays captured / paged.
  assert.equal(
    isTransientAppstleFrequencyUpstreamTimeout(
      "/api/inngest",
      "Some other job failed: Error: upstream_timeout",
    ),
    false,
  );
  // And the Appstle label WITHOUT the upstream_timeout marker (a different Appstle failure
  // class — e.g. a schema mismatch, a 4xx) is not this signature either.
  assert.equal(
    isTransientAppstleFrequencyUpstreamTimeout(
      "/api/inngest",
      "Appstle frequency update failed: Error: Unauthorized (401)",
    ),
    false,
  );
});

test("isTransientAppstleFrequencyUpstreamTimeout returns false on empty / nullish input", () => {
  assert.equal(isTransientAppstleFrequencyUpstreamTimeout(null, null), false);
  assert.equal(isTransientAppstleFrequencyUpstreamTimeout(undefined, undefined), false);
  assert.equal(isTransientAppstleFrequencyUpstreamTimeout("", ""), false);
  assert.equal(isTransientAppstleFrequencyUpstreamTimeout("/api/inngest", ""), false);
});

// ── isForeignAppstleUnskipUpstream500 (error-feed-drop-appstle-unskip-upstream-500-noise) ──
// `src/lib/appstle.ts` `appstleUnskipOrder` logs `console.error(\`Appstle unskip order error
// for ${id}:\`, text)` when Appstle's own `unskip-order` endpoint 500s, then returns a
// structured `{ success: false }` — the dunning-recovery step continues with the failure
// result. The log-drain line is a foreign-owned upstream 500 the code already handles; the
// false positive that repeatedly reopened Control Tower `vercel:5959f3e309a7800c`. Wired
// in `/api/webhooks/vercel-logs` `isError` as a CAPTURE-TIME DROP — the log is skipped
// before it becomes a group so `recordError` never sees it and repeats cannot reopen the
// vendor-owned incident on the transient-recurrence window (previous behavior). Non-500
// Appstle unskip failures (Not Found, Unauthorized) and the sibling `Appstle unskip order
// failed` catch-branch throw carry different markers and stay captured / paged.

test("isForeignAppstleUnskipUpstream500 matches the captured /api/inngest signature", () => {
  assert.equal(
    isForeignAppstleUnskipUpstream500(
      "/api/inngest",
      "Appstle unskip order error for 1234567890: Internal Server Error",
    ),
    true,
  );
});

test("isForeignAppstleUnskipUpstream500 matches when the message carries a trailing stack", () => {
  assert.equal(
    isForeignAppstleUnskipUpstream500(
      "/api/inngest",
      "Appstle unskip order error for 1234567890: Internal Server Error\n    at appstleUnskipOrder (src/lib/appstle.ts:589:13)",
    ),
    true,
  );
});

test("isForeignAppstleUnskipUpstream500 KEEPS a non-500 Appstle unskip failure (paged)", () => {
  // A 4xx from Appstle carries a different body — not the `Internal Server Error` marker —
  // so the first sighting stays captured and paged.
  assert.equal(
    isForeignAppstleUnskipUpstream500(
      "/api/inngest",
      "Appstle unskip order error for 1234567890: Not Found",
    ),
    false,
  );
  assert.equal(
    isForeignAppstleUnskipUpstream500(
      "/api/inngest",
      "Appstle unskip order error for 1234567890: Unauthorized",
    ),
    false,
  );
});

test("isForeignAppstleUnskipUpstream500 KEEPS the sibling `Appstle unskip order failed` throw log (paged)", () => {
  // `appstleUnskipOrder`'s catch branch logs a DIFFERENT prefix — `Appstle unskip order
  // failed:` — when `loggedAppstleFetch` itself throws (a real infra fault, not an Appstle
  // 500 body). Different signature, stays captured / paged.
  assert.equal(
    isForeignAppstleUnskipUpstream500(
      "/api/inngest",
      "Appstle unskip order failed: Error: upstream_timeout",
    ),
    false,
  );
});

test("isForeignAppstleUnskipUpstream500 KEEPS a non-Appstle Internal Server Error on /api/inngest (paged)", () => {
  // Any other Inngest error carrying `Internal Server Error` but WITHOUT the Appstle unskip
  // prefix is a different signature — stays captured / paged.
  assert.equal(
    isForeignAppstleUnskipUpstream500(
      "/api/inngest",
      "Some other job failed: Internal Server Error",
    ),
    false,
  );
  assert.equal(
    isForeignAppstleUnskipUpstream500(
      "/api/inngest",
      "Internal Server Error",
    ),
    false,
  );
});

test("isForeignAppstleUnskipUpstream500 KEEPS a non-allowlisted path even with the marker", () => {
  // Only `/api/inngest` (the dunning recovery function) reaches `appstleUnskipOrder` today.
  // Any other path carrying the same body is a different caller / signature and stays
  // captured / paged.
  assert.equal(
    isForeignAppstleUnskipUpstream500(
      "/api/webhooks/appstle",
      "Appstle unskip order error for 1234567890: Internal Server Error",
    ),
    false,
  );
  assert.equal(
    isForeignAppstleUnskipUpstream500(
      "/api/portal",
      "Appstle unskip order error for 1234567890: Internal Server Error",
    ),
    false,
  );
  assert.equal(
    isForeignAppstleUnskipUpstream500(
      null,
      "Appstle unskip order error for 1234567890: Internal Server Error",
    ),
    false,
  );
});

test("isForeignAppstleUnskipUpstream500 returns false on empty / nullish input", () => {
  assert.equal(isForeignAppstleUnskipUpstream500(null, null), false);
  assert.equal(isForeignAppstleUnskipUpstream500(undefined, undefined), false);
  assert.equal(isForeignAppstleUnskipUpstream500("", ""), false);
  assert.equal(isForeignAppstleUnskipUpstream500("/api/inngest", ""), false);
});

test("capture-time drop keeps adjacent Appstle unskip failures (Not Found / Unauthorized / unskip order failed)", () => {
  // The route's `isError` calls this predicate to drop the log BEFORE it becomes a group,
  // so the same acceptance shape decides what recordError sees. Prove the drop-path intent:
  // the exact `/api/inngest` Appstle Internal Server Error body is dropped; the three
  // adjacent messages named in the spec's verification stay kept and reach recordError.
  const path = "/api/inngest";
  assert.equal(
    isForeignAppstleUnskipUpstream500(
      path,
      "Appstle unskip order error for 1234567890: Internal Server Error",
    ),
    true,
    "dropped: the exact vendor 500 body",
  );
  assert.equal(
    isForeignAppstleUnskipUpstream500(path, "Appstle unskip order error for 1234567890: Not Found"),
    false,
    "kept: 4xx Not Found body",
  );
  assert.equal(
    isForeignAppstleUnskipUpstream500(
      path,
      "Appstle unskip order error for 1234567890: Unauthorized",
    ),
    false,
    "kept: 4xx Unauthorized body",
  );
  assert.equal(
    isForeignAppstleUnskipUpstream500(path, "Appstle unskip order failed: Error: upstream_timeout"),
    false,
    "kept: sibling catch-branch throw log (different prefix)",
  );
});

// ── isForeignBraintreeVaultProcessorDecline (error-feed-drop-braintree-portal-vault-processor-decline-noise) ──
// `src/lib/portal/handlers/payment-method-update.ts` calls
// `vaultAndMigratePaymentMethod` in a try/catch and, on any throw, logs
// `console.error(\`[portal/payment-method-update] vault failed: ${msg}\`)` then
// returns HTTP 502 `{ error: 'vault_failed' }`. When the customer's own issuer
// declines the card, the Braintree SDK throws with a processor-decline body — a
// per-customer issuer decision the code can never prevent. Wired in
// `/api/webhooks/vercel-logs` `isError` as a CAPTURE-TIME DROP for the
// allow-listed processor-decline text families. Non-decline vault failures (SDK
// broken, connectivity, auth misconfig) carry different marker text and stay
// captured / paged.

test("isForeignBraintreeVaultProcessorDecline drops the captured 'Life cycle' issuer decline", () => {
  assert.equal(
    isForeignBraintreeVaultProcessorDecline(
      "/api/portal",
      "[portal/payment-method-update] vault failed: Cannot Authorize at this time (Life cycle)",
    ),
    true,
  );
});

test("isForeignBraintreeVaultProcessorDecline drops other allow-listed processor-decline bodies", () => {
  const path = "/api/portal";
  for (const body of [
    "Insufficient Funds",
    "Do Not Honor",
    "Pick Up Card",
    "Expired Card",
    "Invalid Card Number",
    "Card Not Activated",
    "Restricted Card",
    "Closed Card",
    "Declined",
    "No Account",
  ]) {
    assert.equal(
      isForeignBraintreeVaultProcessorDecline(path, `[portal/payment-method-update] vault failed: ${body}`),
      true,
      `dropped: ${body}`,
    );
  }
});

test("isForeignBraintreeVaultProcessorDecline KEEPS an unknown-tail vault failure (paged)", () => {
  // A real Braintree SDK / integration fault carries a different body (e.g. the
  // SDK's own `paymentMethod.create failed`, an auth misconfig, a connectivity
  // throw). Same prefix, different tail — stays captured / paged.
  assert.equal(
    isForeignBraintreeVaultProcessorDecline(
      "/api/portal",
      "[portal/payment-method-update] vault failed: paymentMethod.create failed",
    ),
    false,
  );
  assert.equal(
    isForeignBraintreeVaultProcessorDecline(
      "/api/portal",
      "[portal/payment-method-update] vault failed: no_braintree_customer",
    ),
    false,
  );
});

test("isForeignBraintreeVaultProcessorDecline KEEPS a non-allowlisted path even with the decline body", () => {
  // Only `/api/portal` (the portal payment-method-update handler) reaches this
  // call site today. Any other path carrying the same body is a different
  // caller / signature and stays captured / paged.
  assert.equal(
    isForeignBraintreeVaultProcessorDecline(
      "/api/journey/token/submit-payment",
      "[portal/payment-method-update] vault failed: Cannot Authorize at this time (Life cycle)",
    ),
    false,
  );
  assert.equal(
    isForeignBraintreeVaultProcessorDecline(
      "/api/inngest",
      "[portal/payment-method-update] vault failed: Insufficient Funds",
    ),
    false,
  );
  assert.equal(
    isForeignBraintreeVaultProcessorDecline(
      null,
      "[portal/payment-method-update] vault failed: Do Not Honor",
    ),
    false,
  );
});

test("isForeignBraintreeVaultProcessorDecline KEEPS an unrelated console.error on /api/portal", () => {
  // Any other portal log without the vault-failed prefix is a different
  // signature and stays captured / paged.
  assert.equal(
    isForeignBraintreeVaultProcessorDecline(
      "/api/portal",
      "[portal/some-other-handler] failed: Cannot Authorize at this time (Life cycle)",
    ),
    false,
  );
  assert.equal(
    isForeignBraintreeVaultProcessorDecline(
      "/api/portal",
      "Some unrelated 500",
    ),
    false,
  );
});

test("isForeignBraintreeVaultProcessorDecline is case-insensitive on the tail marker", () => {
  assert.equal(
    isForeignBraintreeVaultProcessorDecline(
      "/api/portal",
      "[portal/payment-method-update] vault failed: cannot authorize at this time (life cycle)",
    ),
    true,
  );
  assert.equal(
    isForeignBraintreeVaultProcessorDecline(
      "/api/portal",
      "[portal/payment-method-update] vault failed: INSUFFICIENT FUNDS",
    ),
    true,
  );
  assert.equal(
    isForeignBraintreeVaultProcessorDecline(
      "/api/portal",
      "[portal/payment-method-update] vault failed: CLOSED CARD",
    ),
    true,
  );
});

test("isForeignBraintreeVaultProcessorDecline returns false on empty / nullish input", () => {
  assert.equal(isForeignBraintreeVaultProcessorDecline(null, null), false);
  assert.equal(isForeignBraintreeVaultProcessorDecline(undefined, undefined), false);
  assert.equal(isForeignBraintreeVaultProcessorDecline("", ""), false);
  assert.equal(isForeignBraintreeVaultProcessorDecline("/api/portal", ""), false);
});

// ── isForeignBraintreeVaultGatewayRejection (error-feed-drop-braintree-portal-vault-gateway-rejection-noise) ──
// Sibling of the processor-decline filter above. Same call site
// (`src/lib/portal/handlers/payment-method-update.ts` → `[portal/payment-method-update]
// vault failed: <msg>` + HTTP 502), but the tail carries the MERCHANT-side Braintree
// risk-rule rejection instead of an issuer decline — `Gateway Rejected: <reason>` for
// one of nine documented reasons (avs, avs_and_cvv, cvv, duplicate, fraud,
// risk_threshold, three_d_secure, application_incomplete, token_issuance). No code
// change on our side can prevent a per-customer / per-risk-rule rejection, so wire the
// filter into `/api/webhooks/vercel-logs` `isError` as a CAPTURE-TIME DROP.

test("isForeignBraintreeVaultGatewayRejection drops the avs rejection", () => {
  assert.equal(
    isForeignBraintreeVaultGatewayRejection(
      "/api/portal",
      "[portal/payment-method-update] vault failed: Gateway Rejected: avs",
    ),
    true,
  );
});

test("isForeignBraintreeVaultGatewayRejection drops the fraud rejection", () => {
  assert.equal(
    isForeignBraintreeVaultGatewayRejection(
      "/api/portal",
      "[portal/payment-method-update] vault failed: Gateway Rejected: fraud",
    ),
    true,
  );
});

test("isForeignBraintreeVaultGatewayRejection drops the three_d_secure rejection", () => {
  assert.equal(
    isForeignBraintreeVaultGatewayRejection(
      "/api/portal",
      "[portal/payment-method-update] vault failed: Gateway Rejected: three_d_secure",
    ),
    true,
  );
});

test("isForeignBraintreeVaultGatewayRejection drops the remaining allow-listed rejection reasons", () => {
  const path = "/api/portal";
  for (const reason of [
    "avs_and_cvv",
    "cvv",
    "duplicate",
    "risk_threshold",
    "application_incomplete",
    "token_issuance",
  ]) {
    assert.equal(
      isForeignBraintreeVaultGatewayRejection(
        path,
        `[portal/payment-method-update] vault failed: Gateway Rejected: ${reason}`,
      ),
      true,
      `dropped: ${reason}`,
    );
  }
});

test("isForeignBraintreeVaultGatewayRejection KEEPS a real vault_failed carrying an unrelated Braintree error class", () => {
  // Negative case — a genuine SDK/integration fault (paymentMethod.create failed,
  // Braintree API timeout, no_braintree_customer) carries a different tail. Same
  // prefix, no `gateway rejected: <reason>` marker → stays captured / paged.
  assert.equal(
    isForeignBraintreeVaultGatewayRejection(
      "/api/portal",
      "[portal/payment-method-update] vault failed: paymentMethod.create failed",
    ),
    false,
  );
  assert.equal(
    isForeignBraintreeVaultGatewayRejection(
      "/api/portal",
      "[portal/payment-method-update] vault failed: Braintree API timeout",
    ),
    false,
  );
  assert.equal(
    isForeignBraintreeVaultGatewayRejection(
      "/api/portal",
      "[portal/payment-method-update] vault failed: no_braintree_customer",
    ),
    false,
  );
  // A processor-decline body (issuer said no AFTER auth) is the SIBLING class handled
  // by `isForeignBraintreeVaultProcessorDecline`, not by this filter.
  assert.equal(
    isForeignBraintreeVaultGatewayRejection(
      "/api/portal",
      "[portal/payment-method-update] vault failed: Cannot Authorize at this time (Life cycle)",
    ),
    false,
  );
});

test("isForeignBraintreeVaultGatewayRejection KEEPS a non-allowlisted path even with a rejection body", () => {
  assert.equal(
    isForeignBraintreeVaultGatewayRejection(
      "/api/journey/token/submit-payment",
      "[portal/payment-method-update] vault failed: Gateway Rejected: fraud",
    ),
    false,
  );
  assert.equal(
    isForeignBraintreeVaultGatewayRejection(
      null,
      "[portal/payment-method-update] vault failed: Gateway Rejected: avs",
    ),
    false,
  );
});

test("isForeignBraintreeVaultGatewayRejection is case-insensitive on the tail marker", () => {
  assert.equal(
    isForeignBraintreeVaultGatewayRejection(
      "/api/portal",
      "[portal/payment-method-update] vault failed: gateway rejected: fraud",
    ),
    true,
  );
  assert.equal(
    isForeignBraintreeVaultGatewayRejection(
      "/api/portal",
      "[portal/payment-method-update] vault failed: GATEWAY REJECTED: AVS",
    ),
    true,
  );
});

test("isForeignBraintreeVaultGatewayRejection returns false on empty / nullish input", () => {
  assert.equal(isForeignBraintreeVaultGatewayRejection(null, null), false);
  assert.equal(isForeignBraintreeVaultGatewayRejection(undefined, undefined), false);
  assert.equal(isForeignBraintreeVaultGatewayRejection("", ""), false);
  assert.equal(isForeignBraintreeVaultGatewayRejection("/api/portal", ""), false);
});

// ── isForeignEasyPostReturnsSweepRateLimit (error-feed-scope-easypost-returns-sweep-rate-limit-noise) ──
// `src/lib/inngest/returns-reconcile-sweep.ts` logs `[returns-reconcile-sweep] lookupTracking
// failed for return <id> (tracking <n>): <err>` when EasyPost's account-level throttle throws
// on the per-row `lookupTracking` call, then returns from the row-worker — the row is skipped
// and re-picked on the next daily sweep. The log-drain line is a foreign-vendor rate-limit
// burst the code already handles; the false positive that opened Control Tower
// `vercel:53af50d6c3a578ec` (39 identical lines in ~15s). Classifying it transient
// auto-resolves a first sighting (recorded, not paged); a chronic EasyPost outage would
// recur within the window and still surface.

test("isForeignEasyPostReturnsSweepRateLimit matches the captured /api/inngest signature", () => {
  assert.equal(
    isForeignEasyPostReturnsSweepRateLimit(
      "/api/inngest",
      "[returns-reconcile-sweep] lookupTracking failed for return 1234abcd-5678-90ef-1234-567890abcdef (tracking 9400111899223345678901): Error: You are being temporarily rate-limited due to excessive resource consumption. Contact support@easypost.com if this problem persists.",
    ),
    true,
  );
});

test("isForeignEasyPostReturnsSweepRateLimit KEEPS a non-rate-limit EasyPost failure (paged)", () => {
  // A real EasyPost bug on the same sweep — bad tracking number, carrier not recognized,
  // etc. — carries a different marker and stays captured / paged so a genuine outage still
  // surfaces on first sighting.
  assert.equal(
    isForeignEasyPostReturnsSweepRateLimit(
      "/api/inngest",
      "[returns-reconcile-sweep] lookupTracking failed for return 1234abcd-5678-90ef-1234-567890abcdef (tracking 9400111899223345678901): Error: bad tracking number",
    ),
    false,
  );
});

test("isForeignEasyPostReturnsSweepRateLimit KEEPS the same rate-limit message on a non-/api/inngest path (paged)", () => {
  // Only the returns-reconcile-sweep Inngest function reaches this call site today. If some
  // other caller starts emitting the same body from a different path, that's a NEW surface
  // and stays captured / paged — a re-scope would land in this same classifier.
  assert.equal(
    isForeignEasyPostReturnsSweepRateLimit(
      "/api/portal",
      "[returns-reconcile-sweep] lookupTracking failed for return 1234abcd-5678-90ef-1234-567890abcdef (tracking 9400111899223345678901): Error: You are being temporarily rate-limited due to excessive resource consumption.",
    ),
    false,
  );
});

// ── isForeignEasyPostReturnsSweepMissingCarrierCredentials (error-feed-scope-easypost-returns-sweep-missing-carrier-credentials) ──
// Sibling of the rate-limit predicate on the identical call site. When the returns-sweep's
// per-row `lookupTracking` call hits a tracking number whose carrier the EasyPost account
// holds NO credentials for, the client throws with the exact `Credentials not found for
// the specified carrier` body — the row is skipped and re-picked on the next daily sweep
// and there is no lever to pull on our side. The false positive that opened Control Tower
// signature `vercel:d9475d06cd1245a7` and sat parked for 41 days. Unlike the rate-limit
// case this condition is PERMANENT for a given carrier rather than passing, so recurrence
// on the daily sweep is EXPECTED and must not be re-escalated to a paging signal.

test("isForeignEasyPostReturnsSweepMissingCarrierCredentials matches the captured /api/inngest signature", () => {
  assert.equal(
    isForeignEasyPostReturnsSweepMissingCarrierCredentials(
      "/api/inngest",
      "[returns-reconcile-sweep] lookupTracking failed for return 1234abcd-5678-90ef-1234-567890abcdef (tracking 9400111899223345678901): Error: Credentials not found for the specified carrier.",
    ),
    true,
  );
});

test("isForeignEasyPostReturnsSweepMissingCarrierCredentials KEEPS a bad-tracking-number failure on the same sweep (paged)", () => {
  // A real EasyPost bug on the same sweep — bad tracking number, genuine outage — carries
  // a different marker and stays captured / paged so a real problem still surfaces on first
  // sighting.
  assert.equal(
    isForeignEasyPostReturnsSweepMissingCarrierCredentials(
      "/api/inngest",
      "[returns-reconcile-sweep] lookupTracking failed for return 1234abcd-5678-90ef-1234-567890abcdef (tracking 9400111899223345678901): Error: bad tracking number",
    ),
    false,
  );
});

test("isForeignEasyPostReturnsSweepMissingCarrierCredentials KEEPS the same credentials body on a non-/api/inngest path (paged)", () => {
  // Only the returns-reconcile-sweep Inngest function reaches this call site today. If some
  // other caller starts emitting the same body from a different path, that's a NEW surface
  // and stays captured / paged.
  assert.equal(
    isForeignEasyPostReturnsSweepMissingCarrierCredentials(
      "/api/portal",
      "[returns-reconcile-sweep] lookupTracking failed for return 1234abcd-5678-90ef-1234-567890abcdef (tracking 9400111899223345678901): Error: Credentials not found for the specified carrier.",
    ),
    false,
  );
});

test("isForeignEasyPostReturnsSweepMissingCarrierCredentials KEEPS the same credentials body without the sweep prefix (paged)", () => {
  // The credentials body arriving from some other EasyPost caller on the same /api/inngest
  // path (not the returns-sweep) stays captured / paged — the narrow three-condition shape
  // is what keeps this predicate from silencing unrelated failures on the same path.
  assert.equal(
    isForeignEasyPostReturnsSweepMissingCarrierCredentials(
      "/api/inngest",
      "[some-other-caller] lookupTracking failed: Error: Credentials not found for the specified carrier.",
    ),
    false,
  );
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

// ── isInngestTerminalFailureMirrorLog (vercel-inngest-terminal-failure-mirror-filter) ──
// Inngest SDK's LoggerMiddleware.wrapFunctionHandler catches the final terminal throw and
// logs `{err}, 'Inngest function error'`. Vercel's drain surfaces the label PLUS the wrapped
// err (message + stack), so this variant slips past the bare-label filter
// (isBareInngestStepErrorMiddlewareLog matches ONLY the exact label with no body) and past
// isInngestStepWrappedNonErrorLog (which matches SDK-only frames, no app frame). Terminal
// failures are already authoritatively captured on source='inngest' by
// inngest-failure-capture.ts with the real function id — the mirror opened Control Tower
// `vercel:6d4f3f4eee64afcf` on the meta_500 exhaustion of shopcx-media-buyer-test-cadence.

// Regression fixture: the meta_500 mirror stack shape — the SDK label + wrapped err.message
// (Meta API error 500) + wrapFunctionHandler frame + a real src/lib/inngest/ frame.
const INNGEST_TERMINAL_FAILURE_META_500_BLOB = `Inngest function error err: Error: Meta API error (500): {"error":{"message":"An unknown error occurred","type":"OAuthException","code":1}}
    at metaFetchJson (/var/task/.next/server/chunks/8000-meta.js:100:15)
    at syncMetaInsightsForLevel (/var/task/.next/server/chunks/8000-meta.js:250:22)
    at handler (/var/task/.next/server/src/lib/inngest/media-buyer-test-cadence.js:132:15)
    at M.wrapFunctionHandler (/var/task/.next/server/chunks/inngest-abc.js:42:34)
    at M.tryExecuteHandler (/var/task/.next/server/chunks/inngest-abc.js:88:15)`;

test("isInngestTerminalFailureMirrorLog drops the vercel:6d4f3f4eee64afcf meta_500 mirror on /api/inngest", () => {
  assert.equal(
    isInngestTerminalFailureMirrorLog(INNGEST_TERMINAL_FAILURE_META_500_BLOB, "/api/inngest"),
    true,
  );
});

test("isInngestTerminalFailureMirrorLog KEEPS the same blob on a different path (unrelated Vercel error)", () => {
  assert.equal(
    isInngestTerminalFailureMirrorLog(INNGEST_TERMINAL_FAILURE_META_500_BLOB, "/api/other"),
    false,
  );
  assert.equal(
    isInngestTerminalFailureMirrorLog(INNGEST_TERMINAL_FAILURE_META_500_BLOB, null),
    false,
  );
  assert.equal(
    isInngestTerminalFailureMirrorLog(INNGEST_TERMINAL_FAILURE_META_500_BLOB, undefined),
    false,
  );
});

test("isInngestTerminalFailureMirrorLog KEEPS a bare 'Inngest function error' label (no err body — handled upstream)", () => {
  // The bare-label case is already dropped by isBareInngestStepErrorMiddlewareLog; this
  // classifier only targets the mirror-with-body variant that slips past the bare filter.
  assert.equal(isInngestTerminalFailureMirrorLog("Inngest function error", "/api/inngest"), false);
});

test("isInngestTerminalFailureMirrorLog KEEPS an /api/inngest error with no SDK wrapper frame", () => {
  // A middleware throw outside wrapFunctionHandler (e.g. a route-level bug) has no
  // authoritative source='inngest' capture — stay captured / paged.
  const withoutSdkFrame = `Error: TypeError: Cannot read properties of undefined (reading 'id')
    at handler (/var/task/.next/server/src/lib/inngest/media-buyer-test-cadence.js:132:15)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)`;
  assert.equal(isInngestTerminalFailureMirrorLog(withoutSdkFrame, "/api/inngest"), false);
});

test("isInngestTerminalFailureMirrorLog KEEPS a wrapFunctionHandler stack with NO frame in our inngest source", () => {
  // A blob that carries the SDK label + wrapFunctionHandler frame but lacks any frame in
  // src/lib/inngest/ (or app/api/inngest/) doesn't map to an app function with an
  // authoritative capture — stay captured / paged.
  const noAppInngestFrame = `Inngest function error err: Error: some middleware bug
    at M.wrapFunctionHandler (/var/task/.next/server/chunks/inngest-abc.js:42:34)
    at M.tryExecuteHandler (/var/task/.next/server/chunks/inngest-abc.js:88:15)`;
  assert.equal(isInngestTerminalFailureMirrorLog(noAppInngestFrame, "/api/inngest"), false);
});

test("isInngestTerminalFailureMirrorLog KEEPS an unrelated /api/inngest error with no Inngest label", () => {
  const unrelated = `Error: something else entirely
    at handler (/var/task/.next/server/src/lib/inngest/media-buyer-test-cadence.js:132:15)`;
  assert.equal(isInngestTerminalFailureMirrorLog(unrelated, "/api/inngest"), false);
});

test("isInngestTerminalFailureMirrorLog matches an app-level api/inngest route frame variant", () => {
  // The app-router route file (app/api/inngest/route.ts) — the alternate location an
  // Inngest handler frame can surface from in a compiled Vercel build.
  const appRouteVariant = `Inngest function error err: Error: Meta API error (500): body
    at handler (/var/task/.next/server/app/api/inngest/route.js:42:15)
    at M.wrapFunctionHandler (/var/task/.next/server/chunks/inngest-abc.js:42:34)`;
  assert.equal(isInngestTerminalFailureMirrorLog(appRouteVariant, "/api/inngest"), true);
});

test("isInngestTerminalFailureMirrorLog returns false on empty / nullish message", () => {
  assert.equal(isInngestTerminalFailureMirrorLog("", "/api/inngest"), false);
  assert.equal(isInngestTerminalFailureMirrorLog("   ", "/api/inngest"), false);
});

// ── isTransientSupabaseEdgeHtmlBody (error-feed-drop-supabase-edge-html-body-noise-reland) ──
// Supabase's edge momentarily unreachable → Cloudflare returns a `521 Web server is down`
// HTML error page instead of JSON. supabase-js surfaces that raw HTML as an error message,
// and callers like `computePlatformScorecard` throw with a message like
// `... upsert failed: ? <!DOCTYPE html>...supabase.co | 521: Web server is`. The next daily
// beat idempotently heals via the done-guard + snapshot upsert. Classifying it transient
// auto-resolves a first sighting (recorded, not paged); a chronic edge outage would recur
// within the window and still surface. The false positive that opened Control Tower
// `vercel:a0844c1b5be72bb7` (and its sibling `vercel:848a7b6d02c1e88c`). Re-land of PR #1115
// after a false-positive Reva revert on 2026-07-04.

test("isTransientSupabaseEdgeHtmlBody matches the vercel:a0844c1b5be72bb7 521 HTML body blob", () => {
  const blob = `platform_scorecard_snapshots upsert failed: ? <!DOCTYPE html>
<html lang="en-US">
<head><title>supabase.co | 521: Web server is down</title></head>
<body>...supabase.co | 521: Web server is down...</body>
</html>`;
  assert.equal(isTransientSupabaseEdgeHtmlBody(blob), true);
});

test("isTransientSupabaseEdgeHtmlBody matches each Cloudflare 5xx status word (521-524 / 'Web server')", () => {
  for (const marker of ["Web server", "521", "522", "523", "524"]) {
    assert.equal(
      isTransientSupabaseEdgeHtmlBody(
        `caller failed: <!DOCTYPE html> ... project.supabase.co ... ${marker} ...`,
      ),
      true,
      `marker=${marker}`,
    );
  }
});

test("isTransientSupabaseEdgeHtmlBody KEEPS a real supabase-js JSON error (PostgrestError shape)", () => {
  // A structured supabase-js error is a real bug (constraint, RLS, bad payload) — stay
  // captured / paged on first sighting. No `<!DOCTYPE html>` in these shapes.
  assert.equal(
    isTransientSupabaseEdgeHtmlBody(
      `{ code: '23505', message: 'duplicate key value violates unique constraint', details: null, hint: null }`,
    ),
    false,
  );
  assert.equal(
    isTransientSupabaseEdgeHtmlBody(
      `PostgrestError: JWT expired (code=PGRST301) — supabase.co /rest/v1/customers`,
    ),
    false,
  );
});

test("isTransientSupabaseEdgeHtmlBody KEEPS a bare <!DOCTYPE html> with no supabase.co marker", () => {
  // An HTML-parse failure from an UNRELATED upstream (Shopify page, Meta login wall, our
  // own 500 page) also carries `<!DOCTYPE html>`. Without the `supabase.co` marker it's not
  // the supabase-edge class — stay captured / paged so a genuinely unrelated HTML-body bug
  // still surfaces.
  assert.equal(
    isTransientSupabaseEdgeHtmlBody(
      `<!DOCTYPE html><html><head><title>521: Web server is down</title></head></html>`,
    ),
    false,
  );
  assert.equal(
    isTransientSupabaseEdgeHtmlBody(
      `Unexpected HTML from shopify.com/admin: <!DOCTYPE html> ... 502 Bad Gateway ...`,
    ),
    false,
  );
});

test("isTransientSupabaseEdgeHtmlBody KEEPS a supabase.co HTML body WITHOUT a Cloudflare 5xx marker", () => {
  // A 4xx / auth-wall HTML body from the supabase edge (e.g. 403 / rate limit page) is a
  // real classify-and-look failure, not the transient CF 5xx class.
  assert.equal(
    isTransientSupabaseEdgeHtmlBody(
      `<!DOCTYPE html> ... project.supabase.co ... 403 Forbidden ...`,
    ),
    false,
  );
});

test("isTransientSupabaseEdgeHtmlBody returns false on empty / nullish input", () => {
  assert.equal(isTransientSupabaseEdgeHtmlBody(null), false);
  assert.equal(isTransientSupabaseEdgeHtmlBody(undefined), false);
  assert.equal(isTransientSupabaseEdgeHtmlBody(""), false);
  assert.equal(isTransientSupabaseEdgeHtmlBody("   "), false);
});

// ── isTransientAnthropicOverloadError (error-feed-classify-anthropic-overload-5xx-transient) ──
// Anthropic 529 (Overloaded) and 5xx more broadly are already retryable in `anthropic-retry`
// (`isRetryableAnthropicStatus`) and factored into the `claude-health` breaker. A best-effort
// caller like `src/lib/fraud-detector.ts` catches the throw and logs `[fraud] AI screen error:
// Error: AI API error: 529` — Vercel drains it into the error feed and, without a classifier,
// mints a fresh OPEN paged incident on a loop that already handled the failure. Classify it
// transient so a first sighting auto-resolves; a chronic recurrence within the window still
// escalates. The false positive that opened Control Tower `vercel:ca4ae59dcd07707a`.

test("isTransientAnthropicOverloadError matches the fraud-detector 529 log shape", () => {
  assert.equal(
    isTransientAnthropicOverloadError("[fraud] AI screen error: Error: AI API error: 529"),
    true,
  );
});

test("isTransientAnthropicOverloadError matches AI API error across the 5xx band", () => {
  for (const status of ["500", "502", "503", "504", "520", "529"]) {
    assert.equal(
      isTransientAnthropicOverloadError(`[fraud] AI screen error: Error: AI API error: ${status}`),
      true,
      `status=${status}`,
    );
  }
});

// `fraud-generate-summary` (`src/lib/inngest/fraud-detection.ts:174`) throws
// `Anthropic API error: ${response.status}` — the sibling of the `AI API error:` shape from
// `src/lib/fraud-detector.ts:704`. Vercel drained an Anthropic 529 as a first-sighting OPEN
// paged incident (`vercel:752bb49488e5aa72`) because the classifier only matched the older
// `AI` prefix. The widened alternation covers both.
test("isTransientAnthropicOverloadError matches the fraud-generate-summary 529 throw shape", () => {
  assert.equal(
    isTransientAnthropicOverloadError("Error: Anthropic API error: 529"),
    true,
  );
});

test("isTransientAnthropicOverloadError matches Anthropic API error across the 5xx band", () => {
  for (const status of ["500", "502", "503", "504", "520", "529"]) {
    assert.equal(
      isTransientAnthropicOverloadError(`Error: Anthropic API error: ${status}`),
      true,
      `status=${status}`,
    );
  }
});

test("isTransientAnthropicOverloadError matches the throwForAnthropicStatus 'returned 5NN' shape", () => {
  assert.equal(
    isTransientAnthropicOverloadError("AnthropicDependencyError: Anthropic messages returned 529"),
    true,
  );
  assert.equal(
    isTransientAnthropicOverloadError("Error: Anthropic screen returned 503"),
    true,
  );
});

test("isTransientAnthropicOverloadError matches raw api.anthropic.com 5xx / overloaded leaks", () => {
  assert.equal(
    isTransientAnthropicOverloadError(
      "fetch https://api.anthropic.com/v1/messages failed with status 529",
    ),
    true,
  );
  assert.equal(
    isTransientAnthropicOverloadError(
      "api.anthropic.com replied: { type: 'error', error: { type: 'overloaded_error' } }",
    ),
    true,
  );
});

test("isTransientAnthropicOverloadError KEEPS a 4xx logic bug (still pages)", () => {
  // A 4xx is a request/auth bug — never succeeds on retry, so it stays captured / paged.
  assert.equal(
    isTransientAnthropicOverloadError("[fraud] AI screen error: Error: AI API error: 400"),
    false,
  );
  assert.equal(
    isTransientAnthropicOverloadError("Error: AI API error: 401"),
    false,
  );
  assert.equal(
    isTransientAnthropicOverloadError("Anthropic messages returned 404"),
    false,
  );
});

test("isTransientAnthropicOverloadError KEEPS an unrelated 5xx (no Anthropic marker)", () => {
  // A 5xx from some other upstream is a real classify-and-look failure — no Anthropic marker,
  // so it stays paged. `api.anthropic.com` is the gate for the raw-upstream path.
  assert.equal(
    isTransientAnthropicOverloadError("upstream returned 503 from api.stripe.com"),
    false,
  );
  assert.equal(
    isTransientAnthropicOverloadError("[some-other] error: 529 from api.example.com"),
    false,
  );
});

test("isTransientAnthropicOverloadError returns false on empty / nullish input", () => {
  assert.equal(isTransientAnthropicOverloadError(null), false);
  assert.equal(isTransientAnthropicOverloadError(undefined), false);
  assert.equal(isTransientAnthropicOverloadError(""), false);
  assert.equal(isTransientAnthropicOverloadError("   "), false);
});

// ── isTransientKlaviyoReviewsFetch5xx (error-feed-classify-klaviyo-reviews-fetch-5xx-transient) ──
// `src/lib/klaviyo.ts` `fetchAllReviews` (:118) and `syncReviewPage` (:154) log
// `console.error(\`Klaviyo reviews fetch failed: ${res.status}\`)` on a non-ok Klaviyo
// response and RECOVER (break page loop / return graceful no-op); reviews are idempotent by
// `external_id`, so the next daily beat re-syncs. Classifying the pre-recovery 5xx transient
// auto-resolves a first sighting; a chronic Klaviyo outage would recur and still surface.
// Control Tower `vercel:a7d8086bb71bbfe3`.

test("isTransientKlaviyoReviewsFetch5xx matches the captured /api/inngest 5xx signature", () => {
  assert.equal(
    isTransientKlaviyoReviewsFetch5xx(
      "/api/inngest",
      "Klaviyo reviews fetch failed: 503",
    ),
    true,
  );
  assert.equal(
    isTransientKlaviyoReviewsFetch5xx(
      "/api/inngest",
      "Klaviyo reviews fetch failed: 500",
    ),
    true,
  );
  assert.equal(
    isTransientKlaviyoReviewsFetch5xx(
      "/api/inngest",
      "Klaviyo reviews fetch failed: 599",
    ),
    true,
  );
});

test("isTransientKlaviyoReviewsFetch5xx KEEPS a 4xx (paged — auth/bad-request is a real bug)", () => {
  assert.equal(
    isTransientKlaviyoReviewsFetch5xx(
      "/api/inngest",
      "Klaviyo reviews fetch failed: 401",
    ),
    false,
  );
  assert.equal(
    isTransientKlaviyoReviewsFetch5xx(
      "/api/inngest",
      "Klaviyo reviews fetch failed: 429",
    ),
    false,
  );
});

test("isTransientKlaviyoReviewsFetch5xx KEEPS a different Klaviyo log prefix (paged)", () => {
  assert.equal(
    isTransientKlaviyoReviewsFetch5xx(
      "/api/inngest",
      "Klaviyo profiles fetch failed: 503",
    ),
    false,
  );
  assert.equal(
    isTransientKlaviyoReviewsFetch5xx(
      "/api/inngest",
      "Some other job failed: 500",
    ),
    false,
  );
});

test("isTransientKlaviyoReviewsFetch5xx KEEPS a mismatched path (paged)", () => {
  assert.equal(
    isTransientKlaviyoReviewsFetch5xx(
      "/api/webhooks/klaviyo",
      "Klaviyo reviews fetch failed: 503",
    ),
    false,
  );
  assert.equal(
    isTransientKlaviyoReviewsFetch5xx(
      null,
      "Klaviyo reviews fetch failed: 503",
    ),
    false,
  );
});

test("isTransientKlaviyoReviewsFetch5xx returns false on empty / nullish / non-5xx-tail input", () => {
  assert.equal(isTransientKlaviyoReviewsFetch5xx(null, null), false);
  assert.equal(isTransientKlaviyoReviewsFetch5xx(undefined, undefined), false);
  assert.equal(isTransientKlaviyoReviewsFetch5xx("", ""), false);
  assert.equal(isTransientKlaviyoReviewsFetch5xx("/api/inngest", ""), false);
  // Prefix present but no parseable status token.
  assert.equal(
    isTransientKlaviyoReviewsFetch5xx("/api/inngest", "Klaviyo reviews fetch failed:"),
    false,
  );
  assert.equal(
    isTransientKlaviyoReviewsFetch5xx(
      "/api/inngest",
      "Klaviyo reviews fetch failed: unknown",
    ),
    false,
  );
});
