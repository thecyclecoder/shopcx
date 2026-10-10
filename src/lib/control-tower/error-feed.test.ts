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
  isForeignSupabasePostgresMissingOrderRefundsCustomerIdAdhocNoise,
  isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise,
  isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise,
  isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise,
  isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise,
  isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise,
  isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise,
  isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise,
  isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise,
  isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise,
  isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise,
  isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise,
  isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise,
  isForeignSupabasePostgresPoliciesKindLookupNoise,
  isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise,
  isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise,
  isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise,
  isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise,
  isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise,
  isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise,
  isForeignSupabasePostgresMissingSpecsTargetAdhocNoise,
  isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise,
  isForeignSupabasePostgresMissingSpecsIntentAdhocNoise,
  isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise,
  isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise,
  isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise,
  isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise,
  isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise,
  isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise,
  isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise,
  isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise,
  isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise,
  isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise,
  isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise,
  isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise,
  isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise,
  isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise,
  isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise,
  isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise,
  isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise,
  isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise,
  isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise,
  isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise,
  isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise,
  isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise,
  isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise,
  isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise,
  isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise,
  isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise,
  isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise,
  isForeignSupabasePostgresMissingSubscriptionsPausedAtColumnAdhocNoise,
  isForeignSupabasePostgresMissingSubscriptionsDeliveryAddressColumnAdhocNoise,
  isForeignSupabasePostgresMissingCustomersAddressColumnAdhocNoise,
  isForeignSupabasePostgresMissingJourneySessionsExpiresAtColumnAdhocNoise,
  isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise,
  isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise,
  isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise,
  isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise,
  isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise,
  isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise,
  isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise,
  isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise,
  isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise,
  isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation,
  isExpectedBillingForecastsPendingUniqViolation,
  isForeignSupabasePostgresMissingControlTowerEventsLookupNoise,
  isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise,
  isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise,
  isForeignSupabasePostgresMissingDashboardNotificationsDismissedAtColumnNoise,
  isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise,
  isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise,
  isForeignSupabasePostgresJsonbLikeOnAppstleContractSnapshotsRawAdhocNoise,
  isForeignSupabasePostgresUuidLikeOnSubscriptionsIdAdhocNoise,
  isForeignSupabasePostgresJsonbIlikeOnErrorEventsSampleAdhocNoise,
  isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise,
  isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise,
  isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise,
  isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise,
  isForeignSupabasePostgresMissingTicketMessagesSenderTypeAdhocNoise,
  isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise,
  isForeignSupabasePostgresMissingTicketAnalysesIntentsColumnAdhocNoise,
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

test("isTransientSupabaseLogNoise scopes Postgres `connection to client lost` FATAL as transient (supabase-logs:e039755e9900a8fa)", () => {
  // The exact client-disconnect FATAL Postgres emits when the client half-closes mid-query —
  // a healthy teardown signal, not a crash. Must route transient BEFORE the FATAL/PANIC keep.
  assert.equal(
    isTransientSupabaseLogNoise("postgres", { severity: "FATAL", message: "connection to client lost" }),
    true,
  );
  // A nearby FATAL that is a real crash (DB restart) must remain non-transient and page.
  assert.equal(
    isTransientSupabaseLogNoise("postgres", { severity: "FATAL", message: "the database system is shutting down" }),
    false,
  );
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


// ── isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise ──
// The stale Supabase Studio / direct-REST read of `loop_alerts?select=...closed_at...`
// against a column `loop_alerts` has never owned (Control Tower signature
// `supabase-logs:7dc04785e9561d24`). Drop AT CAPTURE only when BOTH the exact
// `column loop_alerts.closed_at does not exist` message AND the SELECT-lookup shape on
// `loop_alerts` (bare or PostgREST CTE wrapper) are present. A real column-missing on
// `tickets.closed_at`, a `loop_alerts` column rename (e.g. `resolved_at`), a non-SELECT
// write, or a FATAL/PANIC/constraint violation still surfaces / pages.

// ── isForeignSupabasePostgresMissingDashboardNotificationsDismissedAtColumnNoise ──
// A stale external/REST client reads `dashboard_notifications?select=...dismissed_at...`
// against a column the table never owned (Control Tower signature
// `supabase-logs:a6332efa5c7a5ea8`). Drop AT CAPTURE only when BOTH the exact
// `column dashboard_notifications.dismissed_at does not exist` message AND the
// SELECT-lookup shape (bare or PostgREST CTE wrapper) are present. A different missing
// column on the table, a non-SELECT write, or the same message via another statement
// still pages.

test("isForeignSupabasePostgresMissingDashboardNotificationsDismissedAtColumnNoise drops the exact message for both SELECT shapes", () => {
  // Bare SELECT-lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingDashboardNotificationsDismissedAtColumnNoise(
      "column dashboard_notifications.dismissed_at does not exist",
      "select id, dismissed_at from public.dashboard_notifications where dismissed_at is null",
    ),
    true,
  );
  // Unqualified-FROM variant.
  assert.equal(
    isForeignSupabasePostgresMissingDashboardNotificationsDismissedAtColumnNoise(
      "column dashboard_notifications.dismissed_at does not exist",
      "select dismissed_at from dashboard_notifications order by dismissed_at desc limit 10",
    ),
    true,
  );
  // PostgREST CTE wrapper shape.
  assert.equal(
    isForeignSupabasePostgresMissingDashboardNotificationsDismissedAtColumnNoise(
      "column dashboard_notifications.dismissed_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."dashboard_notifications"."id", "public"."dashboard_notifications"."dismissed_at" FROM "public"."dashboard_notifications" LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // `public.`-qualified message + `ERROR: ` prefix are both normalized before the check.
  assert.equal(
    isForeignSupabasePostgresMissingDashboardNotificationsDismissedAtColumnNoise(
      "ERROR: column public.dashboard_notifications.dismissed_at does not exist",
      'WITH pgrst_source AS ( SELECT "dismissed_at" FROM "public"."dashboard_notifications" )',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingDashboardNotificationsDismissedAtColumnNoise KEEPS a different column, a non-SELECT statement, and empty markers", () => {
  // A DIFFERENT missing column on the same table is a real regression and still pages.
  assert.equal(
    isForeignSupabasePostgresMissingDashboardNotificationsDismissedAtColumnNoise(
      "column dashboard_notifications.dismissed does not exist",
      "select dismissed from public.dashboard_notifications where dismissed is null",
    ),
    false,
  );
  // The exact message via a non-SELECT statement (INSERT/UPDATE write) still pages.
  assert.equal(
    isForeignSupabasePostgresMissingDashboardNotificationsDismissedAtColumnNoise(
      "column dashboard_notifications.dismissed_at does not exist",
      "insert into public.dashboard_notifications (dismissed_at) values ($1)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDashboardNotificationsDismissedAtColumnNoise(
      "column dashboard_notifications.dismissed_at does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."dashboard_notifications" SET "dismissed_at" = $1 WHERE "id" = $2 RETURNING * )',
    ),
    false,
  );
  // Both markers are required.
  assert.equal(
    isForeignSupabasePostgresMissingDashboardNotificationsDismissedAtColumnNoise(
      "column dashboard_notifications.dismissed_at does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDashboardNotificationsDismissedAtColumnNoise(
      "",
      "select dismissed_at from public.dashboard_notifications",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise drops the PostgREST CTE wrapper lookup projecting the non-existent closed_at column", () => {
  // The captured incident shape (Control Tower `supabase-logs:7dc04785e9561d24`): a stale
  // Supabase Studio / direct-REST client reads `loop_alerts?select=...closed_at...`,
  // PostgREST wraps it as a `WITH pgrst_source AS ( SELECT ... FROM "public"."loop_alerts"
  // ... )` CTE, and Postgres rejects with `column loop_alerts.closed_at does not exist`.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.closed_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_alerts"."id", "public"."loop_alerts"."closed_at" FROM "public"."loop_alerts" LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column public.loop_alerts.closed_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_alerts"."closed_at" FROM "public"."loop_alerts" LIMIT 1 )',
    ),
    true,
  );
  // Already-lowercased variant (Postgres normalizes to lowercase in the log) still drops.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.closed_at does not exist",
      'with pgrst_source as ( select "public"."loop_alerts"."closed_at" from "public"."loop_alerts" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "ERROR: column loop_alerts.closed_at does not exist",
      'WITH pgrst_source AS ( SELECT "closed_at" FROM "public"."loop_alerts" )',
    ),
    true,
  );
  // The bare SELECT form (not a PostgREST wrapper) also drops — same foreign surface,
  // different client / shape.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.closed_at does not exist",
      "select * from public.loop_alerts where closed_at is null",
    ),
    true,
  );
  // The unqualified-FROM (no `public.`) variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.closed_at does not exist",
      "select id, closed_at from loop_alerts order by closed_at desc limit 10",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise KEEPS a PostgREST CTE INSERT/UPDATE/DELETE on loop_alerts (a real code-bug write still pages)", () => {
  // A PostgREST write wrapped in the same `WITH pgrst_source AS (...)` envelope is a real
  // code-bug shape (someone trying to write a bogus column), not the ad hoc read this
  // drop targets — the CTE branch requires the wrapped op to be a SELECT.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.closed_at does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."loop_alerts"("id","closed_at") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.closed_at does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."loop_alerts" SET "closed_at" = $1 WHERE "id" = $2 RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.closed_at does not exist",
      'WITH pgrst_source AS ( DELETE FROM "public"."loop_alerts" WHERE "closed_at" < $1 RETURNING * )',
    ),
    false,
  );
  // A bare INSERT / UPDATE on `loop_alerts` naming `closed_at` is likewise a real code
  // write trying to persist a bogus column — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.closed_at does not exist",
      "insert into public.loop_alerts (closed_at) values ($1)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.closed_at does not exist",
      "update public.loop_alerts set closed_at = now() where id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise drops the PostgREST CTE wrapper lookup projecting the non-existent message column", () => {
  // The captured incident shape (Control Tower `supabase-logs:7be91db5b111b4fd`): a stale
  // Supabase Studio / direct-REST client reads `loop_alerts?select=...message...` (or
  // `?message=ilike.*`), PostgREST wraps it as a `WITH pgrst_source AS ( SELECT ... FROM
  // "public"."loop_alerts" ... )` CTE, and Postgres rejects with
  // `column loop_alerts.message does not exist` — `message` is not a `loop_alerts` column.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.message does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_alerts"."id", "public"."loop_alerts"."message" FROM "public"."loop_alerts" LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column public.loop_alerts.message does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_alerts"."message" FROM "public"."loop_alerts" LIMIT 1 )',
    ),
    true,
  );
  // The bare SELECT form (not a PostgREST wrapper) also drops — same foreign surface.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.message does not exist",
      "select id, message from loop_alerts where message ilike '%x%' limit 10",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise KEEPS a PostgREST CTE INSERT/UPDATE on loop_alerts naming message (a real code-bug write still pages)", () => {
  // A PostgREST write wrapped in the same `WITH pgrst_source AS (...)` envelope is a real
  // code-bug shape (someone trying to write a bogus `message` column), not the ad hoc read
  // this drop targets — the CTE branch requires the wrapped op to be a SELECT.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.message does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."loop_alerts"("id","message") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.message does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."loop_alerts" SET "message" = $1 WHERE "id" = $2 RETURNING * )',
    ),
    false,
  );
  // A bare INSERT naming `message` is likewise a real code write, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.message does not exist",
      "insert into public.loop_alerts (message) values ($1)",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise drops the PostgREST CTE wrapper lookup projecting the non-existent fingerprint column", () => {
  // The captured incident shape (Control Tower `supabase-logs:0ebf66ac2f9a8f98`): a stale
  // Supabase Studio / direct-REST client reads `loop_alerts?select=...signature,fingerprint...`
  // (the error signature lives on `signature`, not `fingerprint`), PostgREST wraps it as a
  // `WITH pgrst_source AS ( SELECT ... FROM "public"."loop_alerts" ... )` CTE, and Postgres
  // rejects with `column loop_alerts.fingerprint does not exist` — `fingerprint` is not a
  // `loop_alerts` column.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.fingerprint does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_alerts"."signature", "public"."loop_alerts"."fingerprint" FROM "public"."loop_alerts" LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column public.loop_alerts.fingerprint does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_alerts"."fingerprint" FROM "public"."loop_alerts" LIMIT 1 )',
    ),
    true,
  );
  // The bare SELECT form (not a PostgREST wrapper), projecting `signature` OR `fingerprint`,
  // also drops — same foreign surface.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.fingerprint does not exist",
      "select id, signature, fingerprint from loop_alerts where fingerprint = 'x' limit 10",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise KEEPS a PostgREST CTE INSERT/UPDATE on loop_alerts naming fingerprint (a real code-bug write still pages)", () => {
  // A PostgREST write wrapped in the same `WITH pgrst_source AS (...)` envelope is a real
  // code-bug shape (someone trying to write a bogus `fingerprint` column), not the ad hoc
  // read this drop targets — the CTE branch requires the wrapped op to be a SELECT.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.fingerprint does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."loop_alerts"("id","fingerprint") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.fingerprint does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."loop_alerts" SET "fingerprint" = $1 WHERE "id" = $2 RETURNING * )',
    ),
    false,
  );
  // A bare INSERT naming `fingerprint` is likewise a real code write, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.fingerprint does not exist",
      "insert into public.loop_alerts (fingerprint) values ($1)",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise KEEPS a FATAL / constraint error on the fingerprint shape and a fingerprint column-missing on a DIFFERENT relation (real errors still page)", () => {
  // A FATAL / PANIC / constraint violation on the same loop_alerts read shape is a
  // different message class and is NOT the ad hoc missing-column read — it still pages.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      'duplicate key value violates unique constraint "loop_alerts_pkey"',
      "select id, signature, fingerprint from loop_alerts limit 1",
    ),
    false,
  );
  // A real column-missing on another table that DOES carry (or could carry) a
  // `fingerprint` column (e.g. `error_events.fingerprint`) is a genuine regression we want
  // to see — the pin names `loop_alerts.fingerprint` only.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column error_events.fingerprint does not exist",
      "select * from public.error_events where fingerprint = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise KEEPS the closed_at column-missing message on a DIFFERENT relation (a real product-schema regression still pages)", () => {
  // A real column-missing on another table that DOES carry a `closed_at` column
  // (e.g. `tickets.closed_at`) is a genuine regression we want to see — the pin names
  // `loop_alerts.closed_at` only.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column tickets.closed_at does not exist",
      "select * from public.tickets where closed_at is null",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column public.tickets.closed_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."tickets"."closed_at" FROM "public"."tickets" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise KEEPS a DIFFERENT missing column on loop_alerts (e.g. resolved_at — a real column rename still pages)", () => {
  // A real loop_alerts column (e.g. `resolved_at`) going missing is a schema regression
  // we DO want to see — the pin covers `closed_at` only, not any column name.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.resolved_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_alerts"."resolved_at" FROM "public"."loop_alerts" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.resolved_at does not exist",
      "select * from public.loop_alerts where resolved_at is null",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise KEEPS a FATAL / PANIC / constraint violation on loop_alerts (a different Postgres error still pages)", () => {
  // Different message class — the pin is exact, only the closed_at column-missing shape
  // is dropped.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "database is shutting down",
      'WITH pgrst_source AS ( SELECT "closed_at" FROM "public"."loop_alerts" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      'permission denied for relation "public.loop_alerts"',
      "select * from public.loop_alerts where closed_at is null",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise returns false on empty / nullish input", () => {
  assert.equal(isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(null, null), false);
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(undefined, undefined),
    false,
  );
  assert.equal(isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise("", ""), false);
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.closed_at does not exist",
      "",
    ),
    false,
  );
});

// ── error_signature branch of the same filter ──
// Companion incident on the same `loop_alerts` direct-REST shape (Control Tower
// signature `supabase-logs:2f7afeedcba03d28`): a stale PostgREST client reads
// `loop_alerts?select=...error_signature...`, PostgREST wraps it in the same
// `WITH pgrst_source AS (...)` CTE, and Postgres rejects with
// `column loop_alerts.error_signature does not exist` (the name belongs to
// `error_events`, not `loop_alerts`). Same drop class — bare SELECT or PostgREST CTE
// SELECT only, pinned by the exact column-missing message.

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise drops the PostgREST CTE wrapper lookup projecting the non-existent error_signature column", () => {
  // The captured incident shape (`supabase-logs:2f7afeedcba03d28`): a stale direct-REST
  // client reads `loop_alerts?select=...error_signature...`.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.error_signature does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_alerts"."id", "public"."loop_alerts"."error_signature" FROM "public"."loop_alerts" LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column public.loop_alerts.error_signature does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_alerts"."error_signature" FROM "public"."loop_alerts" LIMIT 1 )',
    ),
    true,
  );
  // Already-lowercased variant (Postgres normalizes to lowercase in the log) still drops.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.error_signature does not exist",
      'with pgrst_source as ( select "public"."loop_alerts"."error_signature" from "public"."loop_alerts" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "ERROR: column loop_alerts.error_signature does not exist",
      'WITH pgrst_source AS ( SELECT "error_signature" FROM "public"."loop_alerts" )',
    ),
    true,
  );
  // The bare SELECT form (not a PostgREST wrapper) also drops — same foreign surface,
  // different client / shape.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.error_signature does not exist",
      "select * from public.loop_alerts where error_signature is null",
    ),
    true,
  );
  // The unqualified-FROM (no `public.`) variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.error_signature does not exist",
      "select id, error_signature from loop_alerts order by error_signature desc limit 10",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise KEEPS a non-SELECT statement shape on the error_signature message (a real code-bug write still pages)", () => {
  // A PostgREST write wrapped in the same `WITH pgrst_source AS (...)` envelope is a real
  // code-bug shape (someone trying to write a bogus column), not the ad hoc read this
  // drop targets — the CTE branch requires the wrapped op to be a SELECT.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.error_signature does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."loop_alerts"("id","error_signature") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.error_signature does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."loop_alerts" SET "error_signature" = $1 WHERE "id" = $2 RETURNING * )',
    ),
    false,
  );
  // A bare INSERT / UPDATE / DELETE on `loop_alerts` naming `error_signature` is likewise
  // a real code write trying to persist a bogus column — a bug we WANT to see.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.error_signature does not exist",
      "insert into public.loop_alerts (error_signature) values ($1)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.error_signature does not exist",
      "update public.loop_alerts set error_signature = $1 where id = $2",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise KEEPS the error_signature column-missing message on a DIFFERENT relation (a real product-schema regression still pages)", () => {
  // `error_signature` is a real `error_events` column — a column-missing on it there is a
  // genuine regression we want to see. The pin names `loop_alerts.error_signature` only.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column error_events.error_signature does not exist",
      "select * from public.error_events where error_signature is null",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column public.error_events.error_signature does not exist",
      'WITH pgrst_source AS ( SELECT "public"."error_events"."error_signature" FROM "public"."error_events" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise KEEPS an unrelated missing column on loop_alerts (e.g. workspace_id — a real column rename still pages)", () => {
  // Any `loop_alerts` column outside the pinned {closed_at, error_signature, loop_key}
  // set is a real regression we DO want to see — the pin is deliberately narrow.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.workspace_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_alerts"."workspace_id" FROM "public"."loop_alerts" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.status does not exist",
      "select * from public.loop_alerts where status = 'open'",
    ),
    false,
  );
});


// ── loop_key branch of the same filter ──
// Companion incident on the same `loop_alerts` direct-REST shape (Control Tower
// signature `supabase-logs:1676b561414d21b9`): a stale PostgREST client reads
// `loop_alerts?select=...loop_key...`, PostgREST wraps it in the same
// `WITH pgrst_source AS (...)` CTE, and Postgres rejects with
// `column loop_alerts.loop_key does not exist` (the name belongs to `loop_heartbeats`,
// not `loop_alerts`). Same drop class — bare SELECT or PostgREST CTE SELECT only, pinned
// by the exact column-missing message.

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise drops the PostgREST CTE wrapper lookup projecting the non-existent loop_key column", () => {
  // The captured incident shape (`supabase-logs:1676b561414d21b9`): a stale direct-REST
  // client reads `loop_alerts?select=...loop_key...`.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.loop_key does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_alerts"."id", "public"."loop_alerts"."loop_key" FROM "public"."loop_alerts" LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column public.loop_alerts.loop_key does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_alerts"."loop_key" FROM "public"."loop_alerts" LIMIT 1 )',
    ),
    true,
  );
  // Already-lowercased variant (Postgres normalizes to lowercase in the log) still drops.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.loop_key does not exist",
      'with pgrst_source as ( select "public"."loop_alerts"."loop_key" from "public"."loop_alerts" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "ERROR: column loop_alerts.loop_key does not exist",
      'WITH pgrst_source AS ( SELECT "loop_key" FROM "public"."loop_alerts" )',
    ),
    true,
  );
  // The bare SELECT form (not a PostgREST wrapper) also drops — same foreign surface,
  // different client / shape.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.loop_key does not exist",
      "select * from public.loop_alerts where loop_key = 'x'",
    ),
    true,
  );
  // The unqualified-FROM (no `public.`) variant is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.loop_key does not exist",
      "select id, loop_key from loop_alerts order by loop_key desc limit 10",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise KEEPS a non-SELECT statement shape on the loop_key message (a real code-bug write still pages)", () => {
  // A PostgREST write wrapped in the same `WITH pgrst_source AS (...)` envelope is a real
  // code-bug shape (someone trying to write a bogus column), not the ad hoc read this
  // drop targets — the CTE branch requires the wrapped op to be a SELECT.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.loop_key does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."loop_alerts"("id","loop_key") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.loop_key does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."loop_alerts" SET "loop_key" = $1 WHERE "id" = $2 RETURNING * )',
    ),
    false,
  );
  // A bare INSERT / UPDATE / DELETE on `loop_alerts` naming `loop_key` is likewise a real
  // code write trying to persist a bogus column — a bug we WANT to see.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.loop_key does not exist",
      "insert into public.loop_alerts (loop_key) values ($1)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_alerts.loop_key does not exist",
      "update public.loop_alerts set loop_key = $1 where id = $2",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise KEEPS the loop_key column-missing message on a DIFFERENT relation (a real product-schema regression still pages)", () => {
  // `loop_key` is a real `loop_heartbeats` column — a column-missing on it there is a
  // genuine regression we want to see. The pin names `loop_alerts.loop_key` only.
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column loop_heartbeats.loop_key does not exist",
      "select * from public.loop_heartbeats where loop_key = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopAlertsDirectRestColumnNoise(
      "column public.loop_heartbeats.loop_key does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_heartbeats"."loop_key" FROM "public"."loop_heartbeats" )',
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

test("isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise drops the PostgREST direct-REST CTE-wrapped SELECT shape", () => {
  // Verbatim payload observed on Control Tower signature `supabase-logs:41dd87c2e483a884`
  // (5 sightings 2026-09-26 → 2026-09-27) — PostgREST wraps the direct-REST row read in
  // a `WITH pgrst_source AS ( SELECT ... FROM "public"."error_events" ... )` CTE with
  // double-quoted schema-qualified identifiers. Same foreign-owned read, different
  // rendering; the widened classifier drops it.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen does not exist",
      'WITH pgrst_source AS ( SELECT "public"."error_events"."id", "public"."error_events"."first_seen", "public"."error_events"."last_seen" FROM "public"."error_events" WHERE "public"."error_events"."id" = $1 LIMIT $2 OFFSET $3 )',
    ),
    true,
  );
  // The `public.`-qualified message variant + CTE-wrapped query is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column public.error_events.first_seen does not exist",
      'with pgrst_source as ( select "public"."error_events"."first_seen" from "public"."error_events" limit 1 )',
    ),
    true,
  );
  // Unqualified quoted table name inside the CTE (`FROM "error_events"`) — the sibling
  // widening covers both `"public"."error_events"` and bare `"error_events"`.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen does not exist",
      'WITH pgrst_source AS ( SELECT "first_seen" FROM "error_events" WHERE id = $1 )',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise KEEPS a non-SELECT op inside the PostgREST CTE wrapper (a real code-write still pages)", () => {
  // A PostgREST INSERT / UPDATE / DELETE wrapped in the same `WITH pgrst_source AS (...)`
  // envelope names a `first_seen` column but is a real code-write we WANT to see, not the
  // ad hoc read this drop targets. The CTE regex requires the wrapped op to be a SELECT.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."error_events"("id","first_seen") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."error_events" SET "first_seen" = $1 WHERE "id" = $2 RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen does not exist",
      'WITH pgrst_source AS ( DELETE FROM "public"."error_events" WHERE "first_seen" < $1 RETURNING * )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise KEEPS a JOIN across error_events + another table (a real product query still pages)", () => {
  // A JOIN whose FROM primary is a DIFFERENT table (with error_events joined in) is a
  // real product-shaped query we WANT to see — the bare-SELECT regex requires the FROM
  // clause to name error_events directly, and the CTE regex likewise anchors on the
  // wrapper's FROM clause naming error_events.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen does not exist",
      "select e.first_seen from public.orders o join public.error_events e on e.order_id = o.id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(
      "column error_events.first_seen does not exist",
      'WITH pgrst_source AS ( SELECT "public"."error_events"."first_seen" FROM "public"."orders" JOIN "public"."error_events" ON "public"."error_events"."order_id" = "public"."orders"."id" )',
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise ──
// Supabase Studio's Table Editor click on `public.appstle_api_calls` whose generated
// PostgREST CTE wrapper names non-existent columns (`method`, `status_code`). Our table
// has `request_method` + `response_status`, not `method` / `status_code` — Control Tower
// signature `supabase-logs:b6686000909442f4`. Drop AT CAPTURE only when BOTH the exact
// column-missing message AND the SELECT-lookup shape on `appstle_api_calls` are present;
// a different-table column-missing, a different column on the same table, or a
// non-SELECT shape still pages.

test("isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise drops both column-missing messages paired with the PostgREST CTE wrapper", () => {
  // `method` column-missing + the Studio-emitted PostgREST CTE wrapper form.
  assert.equal(
    isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise(
      "column appstle_api_calls.method does not exist",
      'WITH pgrst_source AS ( SELECT "public"."appstle_api_calls"."id", "public"."appstle_api_calls"."method" FROM "public"."appstle_api_calls" LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // `status_code` column-missing + the Studio-emitted PostgREST CTE wrapper form.
  assert.equal(
    isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise(
      "column appstle_api_calls.status_code does not exist",
      'WITH pgrst_source AS ( SELECT "public"."appstle_api_calls"."id", "public"."appstle_api_calls"."status_code" FROM "public"."appstle_api_calls" LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // The `public.`-qualified message variant is the same class for both columns.
  assert.equal(
    isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise(
      "column public.appstle_api_calls.method does not exist",
      'with pgrst_source as ( select "public"."appstle_api_calls"."method" from "public"."appstle_api_calls" limit 1 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise(
      "column public.appstle_api_calls.status_code does not exist",
      'with pgrst_source as ( select "public"."appstle_api_calls"."status_code" from "public"."appstle_api_calls" limit 1 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise(
      "ERROR: column appstle_api_calls.method does not exist",
      'WITH pgrst_source AS ( SELECT "method" FROM "public"."appstle_api_calls" )',
    ),
    true,
  );
  // The bare SELECT shape (no PostgREST wrapper) drops too — the predicate accepts both.
  assert.equal(
    isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise(
      "column appstle_api_calls.method does not exist",
      "select method from public.appstle_api_calls",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise KEEPS the same column-missing message when the FROM is a different table (a real schema regression on another table still pages)", () => {
  // Hypothetical: another table that could carry `method` (e.g. a `http_logs.method`)
  // — a column-missing error on that table is real repair work, not Studio noise on
  // appstle_api_calls.
  assert.equal(
    isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise(
      "column http_logs.method does not exist",
      "select method from public.http_logs",
    ),
    false,
  );
  // Message pin is exact — `appstle_api_calls.method` on the message, but the FROM in
  // the query is a different table. The message does not match the FROM-table shape;
  // predicate must bail (either the message check or the SELECT-shape check — here the
  // message doesn't name the FROM table so the pin fails).
  assert.equal(
    isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise(
      "column other_table.status_code does not exist",
      'WITH pgrst_source AS ( SELECT "status_code" FROM "public"."other_table" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise KEEPS a DIFFERENT column-missing on appstle_api_calls (a real column rename / schema regression still pages)", () => {
  // The predicate is pinned to `method` + `status_code` only. A column-missing error
  // on any other column of `appstle_api_calls` (including a hypothetical bogus one like
  // `success` had it been renamed) is a real schema regression that must still page.
  assert.equal(
    isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise(
      "column appstle_api_calls.success does not exist",
      'WITH pgrst_source AS ( SELECT "success" FROM "public"."appstle_api_calls" )',
    ),
    false,
  );
  // Same for the real `request_method` column (which does exist today) — if a bad
  // migration ever drops it, the resulting ERROR is NOT what this filter targets.
  assert.equal(
    isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise(
      "column appstle_api_calls.request_method does not exist",
      'WITH pgrst_source AS ( SELECT "request_method" FROM "public"."appstle_api_calls" )',
    ),
    false,
  );
  // And for `response_status` (the real column paired with the `status_code` typo).
  assert.equal(
    isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise(
      "column appstle_api_calls.response_status does not exist",
      'WITH pgrst_source AS ( SELECT "response_status" FROM "public"."appstle_api_calls" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise KEEPS a non-SELECT statement shape on the same table (a real code-bug writing appstle_api_calls still pages)", () => {
  // An INSERT / UPDATE / DELETE naming the missing column indicates real code trying to
  // write the table — a bug we WANT to see, not the Studio-click read we drop.
  assert.equal(
    isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise(
      "column appstle_api_calls.method does not exist",
      "insert into public.appstle_api_calls (id, method) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise(
      "column appstle_api_calls.status_code does not exist",
      "update public.appstle_api_calls set status_code = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise(
      "column appstle_api_calls.method does not exist",
      "delete from public.appstle_api_calls where method = $1",
    ),
    false,
  );
  // A PostgREST INSERT / UPDATE inside the same `WITH pgrst_source AS (...)` envelope
  // is a real code-write and must stay captured/paged — the CTE branch requires the
  // wrapped op to be a SELECT.
  assert.equal(
    isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise(
      "column appstle_api_calls.method does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."appstle_api_calls"("id","method") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
});

// ── isForeignSupabasePostgresJsonbLikeOnAppstleContractSnapshotsRawAdhocNoise ──
// A Supabase Studio Table Editor quick-filter typed against the jsonb `raw` column on
// `public.appstle_contract_snapshots` (or an external PostgREST probe doing the same)
// emits `WHERE "raw" LIKE $1`, which Postgres rejects with
// `operator does not exist: jsonb ~~ unknown` — there is no `jsonb ~~ text` operator
// pairing. Control Tower signature `supabase-logs:d5790e1e94b4b510`. Drop AT CAPTURE
// only when BOTH the exact operator-missing message AND the SELECT-shape on
// `appstle_contract_snapshots` naming `raw like` are present; a jsonb-LIKE error on any
// OTHER table, a DIFFERENT operator mismatch on this table, or a non-SELECT shape still
// pages.

test("isForeignSupabasePostgresJsonbLikeOnAppstleContractSnapshotsRawAdhocNoise drops the operator-missing message paired with the PostgREST CTE wrapper AND the bare SELECT shape", () => {
  // The Studio-emitted PostgREST CTE wrapper form (double-quoted identifiers), raw LIKE.
  assert.equal(
    isForeignSupabasePostgresJsonbLikeOnAppstleContractSnapshotsRawAdhocNoise(
      "operator does not exist: jsonb ~~ unknown",
      'WITH pgrst_source AS ( SELECT "public"."appstle_contract_snapshots".* FROM "public"."appstle_contract_snapshots" WHERE "public"."appstle_contract_snapshots"."raw" like $1 LIMIT $2 OFFSET $3 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresJsonbLikeOnAppstleContractSnapshotsRawAdhocNoise(
      "ERROR: operator does not exist: jsonb ~~ unknown",
      'WITH pgrst_source AS ( SELECT * FROM "public"."appstle_contract_snapshots" WHERE "raw" like $1 )',
    ),
    true,
  );
  // The bare SELECT shape (no PostgREST wrapper) drops too — the predicate accepts both.
  assert.equal(
    isForeignSupabasePostgresJsonbLikeOnAppstleContractSnapshotsRawAdhocNoise(
      "operator does not exist: jsonb ~~ unknown",
      "select * from public.appstle_contract_snapshots where raw like '%foo%'",
    ),
    true,
  );
  // Unqualified `appstle_contract_snapshots` (no `public.`) + bare SELECT is still the
  // same ad hoc shape.
  assert.equal(
    isForeignSupabasePostgresJsonbLikeOnAppstleContractSnapshotsRawAdhocNoise(
      "operator does not exist: jsonb ~~ unknown",
      "select id, raw from appstle_contract_snapshots where raw like $1",
    ),
    true,
  );
});

test("isForeignSupabasePostgresJsonbLikeOnAppstleContractSnapshotsRawAdhocNoise KEEPS the same operator-missing message when the FROM is a different table (a real jsonb-LIKE code bug elsewhere still pages)", () => {
  // Same jsonb ~~ unknown message, but the query LIKEs a jsonb column on another table —
  // that's a real code-bug shape in our own code, not Studio noise on
  // appstle_contract_snapshots.
  assert.equal(
    isForeignSupabasePostgresJsonbLikeOnAppstleContractSnapshotsRawAdhocNoise(
      "operator does not exist: jsonb ~~ unknown",
      "select * from public.orders where payment_details like '%foo%'",
    ),
    false,
  );
  // PostgREST CTE wrapper form, but FROM is a different table — must still page.
  assert.equal(
    isForeignSupabasePostgresJsonbLikeOnAppstleContractSnapshotsRawAdhocNoise(
      "operator does not exist: jsonb ~~ unknown",
      'WITH pgrst_source AS ( SELECT * FROM "public"."orders" WHERE "payment_details" like $1 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresJsonbLikeOnAppstleContractSnapshotsRawAdhocNoise KEEPS a DIFFERENT operator-missing error on the same table (a real code-bug with a different operator mismatch still pages)", () => {
  // A different operator mismatch (e.g. jsonb @> unknown, jsonb = text) on
  // `appstle_contract_snapshots` is a real code bug we WANT to see.
  assert.equal(
    isForeignSupabasePostgresJsonbLikeOnAppstleContractSnapshotsRawAdhocNoise(
      "operator does not exist: jsonb @> unknown",
      "select * from public.appstle_contract_snapshots where raw @> $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresJsonbLikeOnAppstleContractSnapshotsRawAdhocNoise(
      "operator does not exist: jsonb = text",
      "select * from public.appstle_contract_snapshots where raw = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresJsonbLikeOnAppstleContractSnapshotsRawAdhocNoise KEEPS a non-SELECT statement shape on the same table (a real code-bug writing appstle_contract_snapshots still pages)", () => {
  // An INSERT / UPDATE / DELETE naming raw LIKE indicates real code trying to mutate the
  // table — a bug we WANT to see, not the Studio-click read we drop.
  assert.equal(
    isForeignSupabasePostgresJsonbLikeOnAppstleContractSnapshotsRawAdhocNoise(
      "operator does not exist: jsonb ~~ unknown",
      "update public.appstle_contract_snapshots set raw = $1 where raw like $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresJsonbLikeOnAppstleContractSnapshotsRawAdhocNoise(
      "operator does not exist: jsonb ~~ unknown",
      "delete from public.appstle_contract_snapshots where raw like $1",
    ),
    false,
  );
  // A PostgREST INSERT inside the same `WITH pgrst_source AS (...)` envelope is a real
  // code-write and must stay captured/paged — the CTE branch requires the wrapped op to
  // be a SELECT.
  assert.equal(
    isForeignSupabasePostgresJsonbLikeOnAppstleContractSnapshotsRawAdhocNoise(
      "operator does not exist: jsonb ~~ unknown",
      'WITH pgrst_source AS ( INSERT INTO "public"."appstle_contract_snapshots"("id","raw") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
});

// ── isForeignSupabasePostgresUuidLikeOnSubscriptionsIdAdhocNoise ──
// A Supabase Studio Table Editor quick-filter / direct-REST probe typed against the uuid
// `subscriptions.id` column emits `WHERE "id" LIKE $1`, which Postgres rejects with
// `operator does not exist: uuid ~~ unknown` — there is no `uuid ~~ text` operator pairing.
// Control Tower signature `supabase-logs:a3e4adaac3bc5983`. Drop AT CAPTURE only when BOTH the
// exact operator-missing message AND the SELECT-shape on `subscriptions` naming `id like` are
// present; a uuid-LIKE error on any OTHER table, a DIFFERENT operator mismatch on this table,
// or a non-SELECT shape still pages.

test("isForeignSupabasePostgresUuidLikeOnSubscriptionsIdAdhocNoise drops the operator-missing message paired with the PostgREST CTE wrapper AND the bare SELECT shape", () => {
  // The Studio-emitted PostgREST CTE wrapper form (double-quoted identifiers), id LIKE.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnSubscriptionsIdAdhocNoise(
      "operator does not exist: uuid ~~ unknown",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions".* FROM "public"."subscriptions" WHERE "public"."subscriptions"."id" like $1 LIMIT $2 OFFSET $3 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnSubscriptionsIdAdhocNoise(
      "ERROR: operator does not exist: uuid ~~ unknown",
      'WITH pgrst_source AS ( SELECT * FROM "public"."subscriptions" WHERE "id" like $1 )',
    ),
    true,
  );
  // The bare SELECT shape (no PostgREST wrapper) drops too — the predicate accepts both.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnSubscriptionsIdAdhocNoise(
      "operator does not exist: uuid ~~ unknown",
      "select * from public.subscriptions where id like '%abc%'",
    ),
    true,
  );
  // Unqualified `subscriptions` (no `public.`) + bare SELECT is still the same ad hoc shape.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnSubscriptionsIdAdhocNoise(
      "operator does not exist: uuid ~~ unknown",
      "select id, items from subscriptions where id like $1",
    ),
    true,
  );
});

test("isForeignSupabasePostgresUuidLikeOnSubscriptionsIdAdhocNoise KEEPS the same operator-missing message when the FROM is a different table (a real uuid-LIKE code bug elsewhere still pages)", () => {
  // Same uuid ~~ unknown message, but the query LIKEs a uuid column on another table — that's
  // a real code-bug shape, not Studio noise on subscriptions.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnSubscriptionsIdAdhocNoise(
      "operator does not exist: uuid ~~ unknown",
      "select * from public.orders where id like '%abc%'",
    ),
    false,
  );
  // PostgREST CTE wrapper form, but FROM is a different table — must still page.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnSubscriptionsIdAdhocNoise(
      "operator does not exist: uuid ~~ unknown",
      'WITH pgrst_source AS ( SELECT * FROM "public"."orders" WHERE "id" like $1 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresUuidLikeOnSubscriptionsIdAdhocNoise KEEPS a DIFFERENT operator-missing error on subscriptions (a real code-bug with a different operator mismatch still pages)", () => {
  // A different operator mismatch on `subscriptions` is a real code bug we WANT to see.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnSubscriptionsIdAdhocNoise(
      "operator does not exist: uuid = text",
      "select * from public.subscriptions where id like $1",
    ),
    false,
  );
  // The uuid ILIKE (~~*) operator-missing message is a different shape — not this drop.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnSubscriptionsIdAdhocNoise(
      "operator does not exist: uuid ~~* unknown",
      "select * from public.subscriptions where id like $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresUuidLikeOnSubscriptionsIdAdhocNoise KEEPS a non-SELECT statement shape on subscriptions (a real code-bug writing subscriptions still pages)", () => {
  // An UPDATE / DELETE naming id LIKE indicates real code trying to mutate the table — a bug
  // we WANT to see, not the Studio-click read we drop.
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnSubscriptionsIdAdhocNoise(
      "operator does not exist: uuid ~~ unknown",
      "update public.subscriptions set status = $1 where id like $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresUuidLikeOnSubscriptionsIdAdhocNoise(
      "operator does not exist: uuid ~~ unknown",
      "delete from public.subscriptions where id like $1",
    ),
    false,
  );
});

// ── isForeignSupabasePostgresJsonbIlikeOnErrorEventsSampleAdhocNoise ──
// A Supabase Studio Table Editor quick-filter (or an external PostgREST probe) typed as a
// case-insensitive free-text search over the jsonb `sample` column on `public.error_events`
// emits `WHERE "sample" ILIKE $1`, which Postgres rejects with
// `operator does not exist: jsonb ~~* unknown` — there is no `jsonb ~~* text` (ILIKE) operator
// pairing. Control Tower signature `supabase-logs:51710834d2a73960`. Drop AT CAPTURE only when
// BOTH the exact operator-missing message AND the SELECT-shape on `error_events` naming
// `sample ilike` are present; a jsonb-ILIKE error on any OTHER table, a DIFFERENT operator
// mismatch on this table, or a non-SELECT shape still pages.

test("isForeignSupabasePostgresJsonbIlikeOnErrorEventsSampleAdhocNoise drops the operator-missing message paired with the PostgREST CTE wrapper AND the bare SELECT shape", () => {
  // The Studio-emitted PostgREST CTE wrapper form (double-quoted identifiers), sample ILIKE.
  assert.equal(
    isForeignSupabasePostgresJsonbIlikeOnErrorEventsSampleAdhocNoise(
      "operator does not exist: jsonb ~~* unknown",
      'WITH pgrst_source AS ( SELECT "public"."error_events".* FROM "public"."error_events" WHERE "public"."error_events"."sample" ilike $1 LIMIT $2 OFFSET $3 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresJsonbIlikeOnErrorEventsSampleAdhocNoise(
      "ERROR: operator does not exist: jsonb ~~* unknown",
      'WITH pgrst_source AS ( SELECT * FROM "public"."error_events" WHERE "sample" ilike $1 )',
    ),
    true,
  );
  // The bare SELECT shape (no PostgREST wrapper) drops too — the predicate accepts both.
  assert.equal(
    isForeignSupabasePostgresJsonbIlikeOnErrorEventsSampleAdhocNoise(
      "operator does not exist: jsonb ~~* unknown",
      "select * from public.error_events where sample ilike '%foo%'",
    ),
    true,
  );
  // Unqualified `error_events` (no `public.`) + bare SELECT is still the same ad hoc shape.
  assert.equal(
    isForeignSupabasePostgresJsonbIlikeOnErrorEventsSampleAdhocNoise(
      "operator does not exist: jsonb ~~* unknown",
      "select id, sample from error_events where sample ilike $1",
    ),
    true,
  );
});

test("isForeignSupabasePostgresJsonbIlikeOnErrorEventsSampleAdhocNoise KEEPS the same operator-missing message when the FROM is a different table (a real jsonb-ILIKE code bug elsewhere still pages)", () => {
  // Same jsonb ~~* unknown message, but the query ILIKEs a jsonb column on another table —
  // that's a real code-bug shape in our own code, not Studio noise on error_events.
  assert.equal(
    isForeignSupabasePostgresJsonbIlikeOnErrorEventsSampleAdhocNoise(
      "operator does not exist: jsonb ~~* unknown",
      "select * from public.orders where sample ilike '%foo%'",
    ),
    false,
  );
  // PostgREST CTE wrapper form, but FROM is a different table — must still page.
  assert.equal(
    isForeignSupabasePostgresJsonbIlikeOnErrorEventsSampleAdhocNoise(
      "operator does not exist: jsonb ~~* unknown",
      'WITH pgrst_source AS ( SELECT * FROM "public"."orders" WHERE "sample" ilike $1 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresJsonbIlikeOnErrorEventsSampleAdhocNoise KEEPS a DIFFERENT operator-missing error on the same table (a real code-bug with a different operator mismatch still pages)", () => {
  // The jsonb ~~ unknown (LIKE, not ILIKE) mismatch and other operators on error_events are
  // real code bugs we WANT to see — the pin is the exact ~~* (ILIKE) operator.
  assert.equal(
    isForeignSupabasePostgresJsonbIlikeOnErrorEventsSampleAdhocNoise(
      "operator does not exist: jsonb ~~ unknown",
      "select * from public.error_events where sample ilike $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresJsonbIlikeOnErrorEventsSampleAdhocNoise(
      "operator does not exist: jsonb @> unknown",
      "select * from public.error_events where sample @> $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresJsonbIlikeOnErrorEventsSampleAdhocNoise KEEPS a non-SELECT statement shape on the same table (a real code-bug writing error_events still pages)", () => {
  // An INSERT / UPDATE / DELETE naming sample ILIKE indicates real code trying to mutate the
  // table — a bug we WANT to see, not the Studio-click read we drop.
  assert.equal(
    isForeignSupabasePostgresJsonbIlikeOnErrorEventsSampleAdhocNoise(
      "operator does not exist: jsonb ~~* unknown",
      "update public.error_events set sample = $1 where sample ilike $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresJsonbIlikeOnErrorEventsSampleAdhocNoise(
      "operator does not exist: jsonb ~~* unknown",
      "delete from public.error_events where sample ilike $1",
    ),
    false,
  );
  // A PostgREST INSERT inside the same `WITH pgrst_source AS (...)` envelope is a real
  // code-write and must stay captured/paged — the CTE branch requires the wrapped op to be a
  // SELECT.
  assert.equal(
    isForeignSupabasePostgresJsonbIlikeOnErrorEventsSampleAdhocNoise(
      "operator does not exist: jsonb ~~* unknown",
      'WITH pgrst_source AS ( INSERT INTO "public"."error_events"("id","sample") VALUES ($1,$2) RETURNING * )',
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


// ── isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise ──
// The ad hoc `select ... <column> ... from public.customer_events` lookup by an external
// tool / stale integration / Supabase SQL Editor session. `customer_events` is a real
// product table with a stable known column set; a raw SELECT naming a column we don't own
// (`metadata`, `contract_id`, …) only comes from an external caller, so the column-missing
// ERROR is repair work for a query we don't own. Column-agnostic — supersedes the earlier
// per-column metadata drop so each new external typo doesn't produce its own leaked
// signature. Drop AT CAPTURE only when BOTH the column-missing message shape AND the
// SELECT-lookup shape (bare or PostgREST CTE wrapper) are present; a column-missing error
// on the same column name on another table, or via a non-SELECT statement (real code-bug),
// still pages.

test("isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise drops the ad hoc SELECT lookup on the exact column-missing shape", () => {
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column customer_events.metadata does not exist",
      "select metadata from public.customer_events",
    ),
    true,
  );
  // The `public.` qualified variant of the message is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column public.customer_events.metadata does not exist",
      "select event_type, created_at, metadata from public.customer_events",
    ),
    true,
  );
  // Bare / unqualified `from customer_events` (no `public.` prefix) is the same shape.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column customer_events.metadata does not exist",
      "select id, metadata from customer_events",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column customer_events.metadata does not exist",
      "select metadata from public.customer_events where created_at > now() - interval '1 hour' order by created_at desc limit 100",
    ),
    true,
  );
  // Case-insensitive on the query (Postgres normalizes to lowercase in the log, but a hand
  // -typed uppercase SELECT should still drop).
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column customer_events.metadata does not exist",
      "SELECT event_type, created_at, metadata FROM public.customer_events",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "ERROR: column customer_events.metadata does not exist",
      "select metadata from public.customer_events",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "  column customer_events.metadata does not exist  ",
      "   select metadata from public.customer_events   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise drops the PostgREST CTE wrapper form (same external callers)", () => {
  // PostgREST wraps SELECTs in `WITH pgrst_source AS ( SELECT ... FROM "public"."<t>" ... )`
  // with double-quoted identifiers — the same ad hoc read, different wire shape.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column customer_events.metadata does not exist",
      'with pgrst_source as ( select "customer_events"."event_type", "customer_events"."created_at", "customer_events"."metadata" from "public"."customer_events" ) select * from pgrst_source',
    ),
    true,
  );
  // With the `ERROR: ` prefix on the message as well.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "ERROR: column public.customer_events.metadata does not exist",
      'WITH pgrst_source AS ( SELECT "customer_events"."metadata" FROM "public"."customer_events" LIMIT 1 ) SELECT * FROM pgrst_source',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise drops the ad hoc SELECT lookup for ANY column name (contract_id and other unmentioned names subsumed by the generalization)", () => {
  // Control Tower signature `supabase-logs:ff46bdb1cc519cb9` — the paged `contract_id`
  // signature that drove this generalization. The real contract id lives inside the
  // `properties` JSONB; no ShopCX code filters customer_events on a bare `contract_id`.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column customer_events.contract_id does not exist",
      "select contract_id from public.customer_events where contract_id = $1",
    ),
    true,
  );
  // Same signature in the PostgREST CTE wrapper form.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "ERROR: column public.customer_events.contract_id does not exist",
      'WITH pgrst_source AS ( SELECT "customer_events"."contract_id" FROM "public"."customer_events" LIMIT 1 ) SELECT * FROM pgrst_source',
    ),
    true,
  );
  // Any other unmentioned column name — the point of the generalization is that every
  // new external typo collapses into one capture-time drop.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column customer_events.customer_name does not exist",
      "select customer_name from public.customer_events",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column customer_events.subscription_id does not exist",
      "select subscription_id from customer_events",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise KEEPS a non-SELECT statement shape on contract_id / any column (a real code-bug writing a customer_events column still pages)", () => {
  // Parity with the error_events generic sibling: an INSERT / UPDATE / DELETE against
  // customer_events naming the column indicates real code trying to WRITE it — a bug we
  // WANT to see, not the ad hoc read this drop targets.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column customer_events.contract_id does not exist",
      "insert into public.customer_events (id, contract_id) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column customer_events.contract_id does not exist",
      "update public.customer_events set contract_id = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column customer_events.contract_id does not exist",
      "delete from public.customer_events where contract_id is null",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise KEEPS a column-missing error on OTHER tables (a real code bug on another table still pages)", () => {
  // The sibling `error_events.<column>` is handled by its own classifier — this one is
  // scoped to customer_events only.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      "select metadata from public.error_events",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column orders.metadata does not exist",
      "select metadata from public.orders",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise KEEPS a non-SELECT statement shape on metadata (a real code-bug writing customer_events.metadata still pages)", () => {
  // An INSERT / UPDATE / DELETE against customer_events with a `metadata` field indicates
  // real code trying to WRITE the column — a bug we WANT to see.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column customer_events.metadata does not exist",
      "insert into public.customer_events (id, metadata) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column customer_events.metadata does not exist",
      "update public.customer_events set metadata = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column customer_events.metadata does not exist",
      "delete from public.customer_events where metadata is null",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise KEEPS a non-column-missing message shape on this table (FATAL / PANIC / other Postgres error still pages)", () => {
  // A relation-missing / permission-denied / FATAL / PANIC error on the same table name
  // is NOT the ad hoc missing-column lookup we drop; the pin is exact.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      'relation "public.customer_events" does not exist',
      "select metadata from public.customer_events",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      'permission denied for relation "public.customer_events"',
      "select metadata from public.customer_events",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "FATAL: sorry, too many clients already",
      "select metadata from public.customer_events",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(null, null), false);
  assert.equal(isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(undefined, undefined), false);
  assert.equal(isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise("", ""), false);
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column customer_events.metadata does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomerEventsColumnAdhocNoise(
      "column customer_events.metadata does not exist",
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

test("isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"error_events\" ...)` CTE wrapper form (Control Tower supabase-logs:2c008698336c43a2)", () => {
  // The captured PostgREST direct-REST shape: identical foreign-owned lookup but wrapped
  // in the pgrst_source CTE with double-quoted `"public"."error_events"` identifiers. The
  // prior bare-SELECT regex missed this because the statement starts with `with` and the
  // FROM clause carries the quoted schema.table shape.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.message does not exist",
      'WITH pgrst_source AS ( SELECT "public"."error_events"."id", "public"."error_events"."message" FROM "public"."error_events" WHERE "public"."error_events"."workspace_id" = $1 ORDER BY "public"."error_events"."first_seen_at" DESC LIMIT $2 )',
    ),
    true,
  );
  // Same wrapper on other unquoted-identifier columns — the pin is on the `error_events`
  // table + column-missing shape, not the specific column name.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      'WITH pgrst_source AS ( SELECT "public"."error_events"."metadata" FROM "public"."error_events" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column public.error_events.first_seen_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."error_events"."id", "public"."error_events"."first_seen_at" FROM "public"."error_events" WHERE "public"."error_events"."workspace_id" = $1)',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "ERROR: column error_events.message does not exist",
      'WITH pgrst_source AS (SELECT "public"."error_events"."message" FROM "public"."error_events")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise KEEPS a PostgREST CTE wrapper whose wrapped op is a WRITE (a real code-bug writing an error_events column still pages)", () => {
  // A PostgREST INSERT/UPDATE wraps as the SAME `WITH pgrst_source AS (...)` outer shell
  // but its wrapped op is INSERT/UPDATE/DELETE — a real caller trying to WRITE one of
  // these bogus columns is a code bug we WANT paged, not the ad hoc read this filter drops.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."error_events"("id", "metadata") VALUES ($1, $2) RETURNING "public"."error_events"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.first_seen_at does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."error_events" SET "first_seen_at" = now() WHERE "public"."error_events"."id" = $1 )',
    ),
    false,
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

test("isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise drops the quoted PostgREST direct-REST shape (Supabase-logs 3c4fe003f1a71cdf)", () => {
  // The sampled `occurrences` PostgREST query: identifiers double-quoted, all-lowercase in
  // the log after Supabase's normalization. This is the shape that was still paging Platform
  // when the plain unquoted regex missed it.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.occurrences does not exist",
      'select "occurrences" from "public"."error_events"',
    ),
    true,
  );
  // With a hand-typed uppercase SELECT (Supabase lowercases the log line, but a caller
  // pasting SQL into a REST client would still normalize the same way in-code).
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.occurrences does not exist",
      'SELECT "occurrences" FROM "public"."error_events"',
    ),
    true,
  );
  // Quoted table without the `public.` schema qualifier — PostgREST emits both depending on
  // the caller's search_path / API version.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.occurrences does not exist",
      'select "occurrences" from "error_events"',
    ),
    true,
  );
  // PostgREST's `with pgrst_source as (…) select …` CTE wrapping — the standard shape it
  // emits for `GET /rest/v1/error_events?select=<col>` when the column projection is pushed
  // into the CTE. The failing column reference is inside the CTE body.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.occurrences does not exist",
      'with pgrst_source as (select "public"."error_events"."occurrences" from "public"."error_events") select "occurrences" from "pgrst_source"',
    ),
    true,
  );
  // Same CTE shape with a trailing WHERE / LIMIT / ORDER BY inside the CTE body.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column public.error_events.occurrences does not exist",
      'with pgrst_source as (select "occurrences" from "public"."error_events" where "first_seen_at" > now() - interval \'1 hour\' order by "first_seen_at" desc limit 100) select * from "pgrst_source"',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise drops the PostgREST direct-REST CTE-wrapped SELECT shape", () => {
  // Verbatim payload observed on Control Tower signature `supabase-logs:41dd87c2e483a884`
  // (5 sightings 2026-09-26 → 2026-09-27) — PostgREST wraps the direct-REST row read in
  // a `WITH pgrst_source AS ( SELECT ... FROM "public"."error_events" ... )` CTE with
  // double-quoted schema-qualified identifiers. Same foreign-owned read, different
  // rendering; the widened classifier drops it.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.first_seen does not exist",
      'WITH pgrst_source AS ( SELECT "public"."error_events"."id", "public"."error_events"."first_seen", "public"."error_events"."last_seen" FROM "public"."error_events" WHERE "public"."error_events"."id" = $1 LIMIT $2 OFFSET $3 )',
    ),
    true,
  );
  // Any unquoted column name in the message still classifies via the generic pin — the
  // classifier does not care which column the caller mistyped, only that the shape is
  // the ad hoc PostgREST read on error_events.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.foo_bar does not exist",
      'with pgrst_source as ( select "public"."error_events"."foo_bar" from "public"."error_events" limit 1 )',
    ),
    true,
  );
  // Unqualified quoted table name inside the CTE (`FROM "error_events"`) — the sibling
  // widening covers both `"public"."error_events"` and bare `"error_events"`.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      'WITH pgrst_source AS ( SELECT "metadata" FROM "error_events" WHERE id = $1 )',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise KEEPS a modifying CTE whose outer statement is a write (a real code-bug still pages)", () => {
  // WITH … DELETE / INSERT / UPDATE on error_events is a modifying-CTE write — a code path
  // actually mutating error_events with a bogus column is a bug we WANT to see; the drop is
  // scoped to read-only outer statements (bare SELECT or WITH … ) SELECT).
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      'with recent as (select id from public.error_events where first_seen_at > now() - interval \'1 hour\') delete from public.error_events where metadata is null',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      'with new_events as (values (1, $1), (2, $2)) insert into public.error_events (id, metadata) select * from new_events',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise KEEPS a non-SELECT op inside the PostgREST CTE wrapper (a real code-write still pages)", () => {
  // A PostgREST INSERT / UPDATE / DELETE wrapped in the same `WITH pgrst_source AS (...)`
  // envelope on error_events with a bogus column is a real code-write we WANT to see,
  // not the ad hoc read this drop targets. The CTE regex requires the wrapped op to be
  // a SELECT.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."error_events"("id","metadata") VALUES ($1,$2) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.first_seen does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."error_events" SET "first_seen" = $1 WHERE "id" = $2 RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      'WITH pgrst_source AS ( DELETE FROM "public"."error_events" WHERE "metadata" IS NULL RETURNING * )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise KEEPS a JOIN across error_events + another table (a real product query still pages)", () => {
  // A JOIN whose FROM primary is a DIFFERENT table (with error_events joined in) is a
  // real product-shaped query we WANT to see — the bare-SELECT regex requires the FROM
  // clause to name error_events directly, and the CTE regex likewise anchors on the
  // wrapper's FROM clause naming error_events.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      "select e.metadata from public.orders o join public.error_events e on e.order_id = o.id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      'WITH pgrst_source AS ( SELECT "public"."error_events"."metadata" FROM "public"."orders" JOIN "public"."error_events" ON "public"."error_events"."order_id" = "public"."orders"."id" )',
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise ──
// The ad hoc free-text search over `error_events` a foreign SQL editor / stale tool emits:
// `select * from error_events where coalesce(label,'')||coalesce(message,'') ilike '%…%'`.
// `label` / `message` are made-up columns no ShopCX code owns, so Postgres reports the
// UNQUALIFIED `column "label"/"message" does not exist` shape — which the relation-qualified
// sibling drop never matched. Drop AT CAPTURE only when BOTH the exact unqualified column-
// missing message AND the bare-SELECT coalesce-search shape are present; a relation-qualified
// bug, a different table, or a non-SELECT write still pages (Control Tower signature
// `supabase-logs:0e3379f172768a91`).

test("isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise drops the ad hoc coalesce free-text search", () => {
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise(
      'column "label" does not exist',
      "select * from error_events where coalesce(label,'')||coalesce(message,'') ilike '%foo%'",
    ),
    true,
  );
  // The `message`-column variant is the same signature.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise(
      'column "message" does not exist',
      "select * from error_events where coalesce(label,'')||coalesce(message,'') ilike '%bar%'",
    ),
    true,
  );
  // The `public.`-qualified FROM and Postgres's `ERROR: ` prefix are both tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise(
      'ERROR: column "label" does not exist',
      "select * from public.error_events where coalesce(label,'') ilike '%x%'",
    ),
    true,
  );
  // Uppercase hand-typed query still drops (lowercased before the marker check).
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise(
      'column "label" does not exist',
      "SELECT * FROM error_events WHERE COALESCE(label,'')||COALESCE(message,'') ILIKE '%y%'",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise KEEPS a relation-qualified column-missing message (real bug still pages)", () => {
  // The relation-qualified shape is the sibling drop's domain, not this one.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise(
      "column error_events.label does not exist",
      "select * from error_events where coalesce(label,'')||coalesce(message,'') ilike '%foo%'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise KEEPS a different table / a non-coalesce SELECT / a non-SELECT write", () => {
  // Different table — the FROM pin is error_events only.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise(
      'column "label" does not exist',
      "select * from tickets where coalesce(label,'')||coalesce(message,'') ilike '%foo%'",
    ),
    false,
  );
  // A SELECT on error_events WITHOUT the coalesce-search marker is not this signature.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise(
      'column "label" does not exist',
      "select label from error_events where id = 1",
    ),
    false,
  );
  // A non-SELECT write to the guessed column is a real code bug and still pages.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise(
      'column "label" does not exist',
      "update error_events set coalesce(label,'') = 'x'",
    ),
    false,
  );
  // A different column name (not label/message) is not this signature.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise(
      'column "foo" does not exist',
      "select * from error_events where coalesce(label,'')||coalesce(message,'') ilike '%foo%'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise returns false on empty / nullish input", () => {
  assert.equal(isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise(null, null), false);
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise(undefined, undefined),
    false,
  );
  assert.equal(isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise("", ""), false);
  // Message matches but query is empty — both markers are required.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsCoalesceSearchNoise('column "label" does not exist', ""),
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

test("isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"spec_phases\" ...)` CTE wrapper form (Control Tower supabase-logs:e3fbf16374cf56af)", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."spec_phases"` identifiers. The plain
  // bare-SELECT regex misses this because the statement starts with `with` and the FROM
  // clause carries the quoted schema.table shape — this is the exact leak the sibling
  // spec `error-feed-drop-spec-phases-workspace-slug-cte-postgrest-noise` was built to
  // close.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.workspace_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."spec_phases"."id", "public"."spec_phases"."workspace_id" FROM "public"."spec_phases" WHERE "public"."spec_phases"."workspace_id" = $1 ORDER BY "public"."spec_phases"."position" ASC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column public.spec_phases.workspace_id does not exist",
      'WITH pgrst_source AS (SELECT "public"."spec_phases"."workspace_id" FROM "public"."spec_phases")',
    ),
    true,
  );
  // The same CTE wrapper form for the `spec_slug` twin — same foreign-owned lookup, other
  // off-schema column.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.spec_slug does not exist",
      'WITH pgrst_source AS ( SELECT "public"."spec_phases"."id", "public"."spec_phases"."spec_slug" FROM "public"."spec_phases" WHERE "public"."spec_phases"."spec_slug" = $1 LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column public.spec_phases.spec_slug does not exist",
      'WITH pgrst_source AS (SELECT "public"."spec_phases"."spec_slug" FROM "public"."spec_phases")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "ERROR: column spec_phases.workspace_id does not exist",
      'WITH pgrst_source AS (SELECT "public"."spec_phases"."workspace_id" FROM "public"."spec_phases")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise ALSO drops the `name` / `phase_order` sibling columns from the same foreign caller (Control Tower supabase-logs:0f78fbfd0bd78a01)", () => {
  // Same foreign-owned read, two more off-schema columns — the live `spec_phases` shape
  // uses `title` + `position`, so an ad hoc PostgREST SELECT asking for `name` or
  // `phase_order` is the same class as the existing workspace_id/spec_slug drop and
  // should be filtered at capture rather than opened as a Control Tower error.
  //
  // Plain SELECT shape — unqualified + public.-qualified for each of the two new columns.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.name does not exist",
      "select id, name, status, phase_order from public.spec_phases where spec_slug = 'foo'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column public.spec_phases.name does not exist",
      "select name from public.spec_phases limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.phase_order does not exist",
      "select id, name, status, phase_order from public.spec_phases where spec_slug = 'foo'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column public.spec_phases.phase_order does not exist",
      "select phase_order from public.spec_phases limit 10",
    ),
    true,
  );
  // ERROR: prefix on the message is stripped as usual.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "ERROR: column spec_phases.name does not exist",
      "select name from public.spec_phases where id = 'x'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "ERROR:  column spec_phases.phase_order does not exist",
      "select phase_order from public.spec_phases where id = 'x'",
    ),
    true,
  );
  // The exact `pgrst_source` CTE wire shape captured in the Control Tower signature —
  // double-quoted identifiers, SELECTs id/name/status/phase_order, filters by spec_slug.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.name does not exist",
      'WITH pgrst_source AS ( SELECT "public"."spec_phases"."id", "public"."spec_phases"."name", "public"."spec_phases"."status", "public"."spec_phases"."phase_order" FROM "public"."spec_phases" WHERE "public"."spec_phases"."spec_slug" = $1 ORDER BY "public"."spec_phases"."phase_order" ASC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column public.spec_phases.name does not exist",
      'WITH pgrst_source AS (SELECT "public"."spec_phases"."name" FROM "public"."spec_phases")',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.phase_order does not exist",
      'WITH pgrst_source AS ( SELECT "public"."spec_phases"."id", "public"."spec_phases"."name", "public"."spec_phases"."status", "public"."spec_phases"."phase_order" FROM "public"."spec_phases" WHERE "public"."spec_phases"."spec_slug" = $1 ORDER BY "public"."spec_phases"."phase_order" ASC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column public.spec_phases.phase_order does not exist",
      'WITH pgrst_source AS (SELECT "public"."spec_phases"."phase_order" FROM "public"."spec_phases")',
    ),
    true,
  );
  // Negative — the shape guard is still load-bearing: a real code-write with the same
  // bogus column (`name` / `phase_order`) must stay captured so a ShopCX bug still pages.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.name does not exist",
      "insert into public.spec_phases (name, status) values ('foo', 'planned')",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.phase_order does not exist",
      "update public.spec_phases set phase_order = 2 where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.name does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."spec_phases"("name") VALUES ($1) RETURNING "public"."spec_phases"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.phase_order does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."spec_phases" SET "phase_order" = $1 WHERE "public"."spec_phases"."id" = $2 )',
    ),
    false,
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
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too — a
  // real code-write inside the `WITH pgrst_source AS (...)` wrapper is still a bug we
  // WANT to see, not the ad hoc read the CTE branch drops.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.workspace_id does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."spec_phases"("id", "workspace_id") VALUES ($1, $2) RETURNING "public"."spec_phases"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.workspace_id does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."spec_phases" SET "workspace_id" = $1 WHERE "public"."spec_phases"."id" = $2 )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(
      "column spec_phases.spec_slug does not exist",
      'WITH pgrst_source AS ( DELETE FROM "public"."spec_phases" WHERE "spec_slug" = $1 RETURNING * )',
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

// ── isForeignSupabasePostgresMissingOrderRefundsCustomerIdAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/order_refunds?select=...customer_id...` against our `public.order_refunds`
// table. The table exists but has no `customer_id` column — every ShopCX refund lookup
// joins through `order_id` / `workspace_id`. Foreign-owned surface, no lever from us —
// drop AT CAPTURE only when BOTH the exact column-missing message AND the bare SELECT /
// PostgREST-CTE shape on `order_refunds` are present. A column-missing on any other
// table, a different column on `order_refunds`, or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingOrderRefundsCustomerIdAdhocNoise drops the bare-SELECT and PostgREST CTE forms on the exact order_refunds.customer_id column-missing shape", () => {
  // Bare SELECT — unqualified and public.-qualified message variants.
  assert.equal(
    isForeignSupabasePostgresMissingOrderRefundsCustomerIdAdhocNoise(
      "column order_refunds.customer_id does not exist",
      "select id, customer_id from public.order_refunds where id = '00000000-0000-0000-0000-000000000000'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrderRefundsCustomerIdAdhocNoise(
      "column public.order_refunds.customer_id does not exist",
      "select id, customer_id from order_refunds limit 1",
    ),
    true,
  );
  // Leading `ERROR: ` prefix is stripped.
  assert.equal(
    isForeignSupabasePostgresMissingOrderRefundsCustomerIdAdhocNoise(
      "ERROR:  column order_refunds.customer_id does not exist",
      "select customer_id from public.order_refunds",
    ),
    true,
  );
  // PostgREST direct-REST CTE wrapper form.
  assert.equal(
    isForeignSupabasePostgresMissingOrderRefundsCustomerIdAdhocNoise(
      "column order_refunds.customer_id does not exist",
      'with pgrst_source as (select "order_refunds".* from "public"."order_refunds" where "order_refunds"."customer_id" = $1) select * from pgrst_source',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingOrderRefundsCustomerIdAdhocNoise KEEPS other tables, other columns, and non-SELECT statements (real regressions still page)", () => {
  // Different table.
  assert.equal(
    isForeignSupabasePostgresMissingOrderRefundsCustomerIdAdhocNoise(
      "column orders.customer_id does not exist",
      "select id, customer_id from public.orders",
    ),
    false,
  );
  // Different column on order_refunds.
  assert.equal(
    isForeignSupabasePostgresMissingOrderRefundsCustomerIdAdhocNoise(
      "column order_refunds.bogus does not exist",
      "select id, bogus from public.order_refunds",
    ),
    false,
  );
  // Non-SELECT statement on order_refunds (real code-write / schema regression).
  assert.equal(
    isForeignSupabasePostgresMissingOrderRefundsCustomerIdAdhocNoise(
      "column order_refunds.customer_id does not exist",
      "insert into public.order_refunds (customer_id) values ($1)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrderRefundsCustomerIdAdhocNoise(
      "column order_refunds.customer_id does not exist",
      "update public.order_refunds set customer_id = $1 where id = $2",
    ),
    false,
  );
  // Nullish / empty input returns false.
  assert.equal(isForeignSupabasePostgresMissingOrderRefundsCustomerIdAdhocNoise(null, null), false);
  assert.equal(
    isForeignSupabasePostgresMissingOrderRefundsCustomerIdAdhocNoise(
      "column order_refunds.customer_id does not exist",
      null,
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrderRefundsCustomerIdAdhocNoise("", ""),
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

// ── isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise ──
// Same foreign caller family as the created_at sibling, but for the `from_status` column.
// Postgres reports the FIRST unresolved column, so when the ad hoc read is evaluated
// `from_status` first the created_at pin never fires — this dedicated pin closes that gap.
// The `spec_status_history` table has no `from_status` column (its status fields are
// `old_status` / `new_status`). Drop AT CAPTURE only when BOTH the exact column-missing
// message on `spec_status_history.from_status` AND the bare SELECT-lookup shape on
// `spec_status_history` are present. Any other column / table / non-SELECT still pages.

test("isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise drops the ad hoc SELECT lookup on the exact spec_status_history.from_status column-missing shape", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(
      "column spec_status_history.from_status does not exist",
      "select id, from_status from public.spec_status_history order by at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(
      "column public.spec_status_history.from_status does not exist",
      "select id, from_status from public.spec_status_history order by at desc limit 100",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(
      "column spec_status_history.from_status does not exist",
      "select from_status from spec_status_history limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(
      "column spec_status_history.from_status does not exist",
      "select spec_slug, from_status from public.spec_status_history where field = 'status' order by at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(
      "column spec_status_history.from_status does not exist",
      "SELECT ID, FROM_STATUS FROM PUBLIC.SPEC_STATUS_HISTORY",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(
      "ERROR: column spec_status_history.from_status does not exist",
      "select from_status from public.spec_status_history",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(
      "  column spec_status_history.from_status does not exist  ",
      "   select from_status from public.spec_status_history   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise KEEPS a column-missing error on any OTHER table (different table still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(
      "column orders.from_status does not exist",
      "select from_status from public.orders where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(
      "column tickets.from_status does not exist",
      "select from_status from public.tickets where id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise KEEPS a DIFFERENT column-missing on spec_status_history (the real old_status / new_status renamed still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(
      "column spec_status_history.old_status does not exist",
      "select old_status from public.spec_status_history where spec_slug = 'x'",
    ),
    false,
  );
  // The created_at sibling's column must NOT be swallowed by the from_status pin.
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(
      "column spec_status_history.created_at does not exist",
      "select created_at from public.spec_status_history where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing spec_status_history.from_status still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(
      "column spec_status_history.from_status does not exist",
      "insert into public.spec_status_history (id, from_status) values ($1, 'planned')",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(
      "column spec_status_history.from_status does not exist",
      "update public.spec_status_history set from_status = 'planned' where id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(
      "column spec_status_history.from_status does not exist",
      "delete from public.spec_status_history where from_status is null",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise("", ""),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(
      "column spec_status_history.from_status does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecStatusHistoryFromStatusAdhocNoise(
      "column spec_status_history.from_status does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/subscription_cycle_charges?select=...created_at...` against our
// `public.subscription_cycle_charges` ledger. The table exists but has no `created_at`
// column — its timestamps are `claimed_at` / `resolved_at`. Foreign-owned surface, no
// lever from us (Control Tower signature `supabase-logs:dc5495e4064edd50`) — drop AT
// CAPTURE only when BOTH the exact column-missing message on
// `subscription_cycle_charges.created_at` AND the bare SELECT-lookup shape on
// `subscription_cycle_charges` are present. A column-missing on any other table, a
// different column on `subscription_cycle_charges`, or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise drops the ad hoc SELECT lookup on the exact subscription_cycle_charges.created_at column-missing shape", () => {
  // The real captured sample — unqualified and public.-qualified message variants.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column subscription_cycle_charges.created_at does not exist",
      "select id, created_at from public.subscription_cycle_charges order by created_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column public.subscription_cycle_charges.created_at does not exist",
      "select id, created_at from public.subscription_cycle_charges order by created_at desc limit 100",
    ),
    true,
  );
  // Unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column subscription_cycle_charges.created_at does not exist",
      "select created_at from subscription_cycle_charges limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column subscription_cycle_charges.created_at does not exist",
      "select cycle_key, created_at from public.subscription_cycle_charges where status = 'failed' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column subscription_cycle_charges.created_at does not exist",
      "SELECT ID, CREATED_AT FROM PUBLIC.SUBSCRIPTION_CYCLE_CHARGES",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "ERROR: column subscription_cycle_charges.created_at does not exist",
      "select created_at from public.subscription_cycle_charges",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise drops the PostgREST direct-REST WITH pgrst_source wrapper shape (signature dc5495e4064edd50)", () => {
  // The real recurring query shape for signature `supabase-logs:dc5495e4064edd50` —
  // PostgREST wraps the direct-REST read in a `WITH pgrst_source AS ( SELECT ... )` CTE with
  // double-quoted identifiers. The current bare-SELECT regex could not match it; the widened
  // filter must.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column subscription_cycle_charges.created_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."subscription_cycle_charges".* FROM "public"."subscription_cycle_charges" ORDER BY "public"."subscription_cycle_charges"."created_at" DESC LIMIT 100 ) SELECT * FROM "pgrst_source"',
    ),
    true,
  );
  // Unqualified double-quoted table name inside the wrapper is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column public.subscription_cycle_charges.created_at does not exist",
      'with pgrst_source as ( select "subscription_cycle_charges".* from "subscription_cycle_charges" order by created_at desc limit 10 )',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise KEEPS a PostgREST INSERT/UPDATE wrapper writing created_at (a real code-bug still pages)", () => {
  // A PostgREST write (INSERT/UPDATE) wrapped in the same CTE still targets a bogus column —
  // that is a code bug we DO want to surface, so the pgrst_source branch must gate on SELECT.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column subscription_cycle_charges.created_at does not exist",
      'with pgrst_source as ( insert into "public"."subscription_cycle_charges" ("created_at") values (now()) returning * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column subscription_cycle_charges.created_at does not exist",
      'with pgrst_source as ( update "public"."subscription_cycle_charges" set "created_at" = now() returning * )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise KEEPS a column-missing error on any OTHER table (a different table's created_at still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column orders.created_at does not exist",
      "select created_at from public.orders where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column spec_status_history.created_at does not exist",
      "select created_at from public.spec_status_history limit 10",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise KEEPS a DIFFERENT column-missing on subscription_cycle_charges (a real column regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column subscription_cycle_charges.claimed_at does not exist",
      "select claimed_at from public.subscription_cycle_charges where cycle_key = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column subscription_cycle_charges.cycle_key does not exist",
      "select cycle_key from public.subscription_cycle_charges where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing subscription_cycle_charges.created_at still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column subscription_cycle_charges.created_at does not exist",
      "insert into public.subscription_cycle_charges (created_at) values (now())",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column subscription_cycle_charges.created_at does not exist",
      "update public.subscription_cycle_charges set created_at = now() where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column subscription_cycle_charges.created_at does not exist",
      "delete from public.subscription_cycle_charges where created_at < now()",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise("", ""),
    false,
  );
  // Exact message but empty / null query — cannot confirm the shape, stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column subscription_cycle_charges.created_at does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionCycleChargesCreatedAtAdhocNoise(
      "column subscription_cycle_charges.created_at does not exist",
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

test("isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise also drops the sibling specs.fold_status direct-REST shape (supabase-logs:7eab1943f640108d)", () => {
  // fold_status — there is no `fold_status` column on `public.specs`; lifecycle state is
  // represented by `status` (with a `folded` value) + a `deferred boolean` flag. A stale
  // PostgREST client that still reads `fold_status` is the foreign-owned class we drop.
  // Captured PostgREST CTE shape (the direct-REST read wraps the SELECT in pgrst_source
  // with double-quoted identifiers).
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.fold_status does not exist",
      'WITH pgrst_source AS ( SELECT "public"."specs"."id", "public"."specs"."slug", "public"."specs"."fold_status" FROM "public"."specs" WHERE "public"."specs"."workspace_id" = $1 ORDER BY "public"."specs"."updated_at" DESC LIMIT $2 OFFSET $3 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column public.specs.fold_status does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."id", "public"."specs"."fold_status" FROM "public"."specs")',
    ),
    true,
  );
  // Bare SELECT variant (unqualified and public.-qualified FROM).
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.fold_status does not exist",
      "select id, slug, fold_status from public.specs order by updated_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.fold_status does not exist",
      "select fold_status from specs limit 10",
    ),
    true,
  );
  // ERROR: prefix is stripped before the equality check — the same noise with a prefix
  // still drops.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "ERROR: column specs.fold_status does not exist",
      "select fold_status from public.specs",
    ),
    true,
  );
  // Negative write-shape — a real caller writing `fold_status` on `public.specs` is a code
  // bug we WANT paged (same guard as the sibling archived_at/folded_at write assertions),
  // so a PostgREST CTE wrapping an INSERT/UPDATE stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.fold_status does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."specs"("id", "fold_status") VALUES ($1, $2) RETURNING "public"."specs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.fold_status does not exist",
      "update public.specs set fold_status = 'folded' where id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise also drops the sibling specs.verified_at direct-REST shape (supabase-logs:436a137c58fe6ac0)", () => {
  // verified_at — there is no `verified_at` column on `public.specs`; review/build state
  // is captured by `vale_review_passed_at` + the phase rows, not a generic `verified_at`
  // timestamp. A stale PostgREST client that still reads `verified_at` is the
  // foreign-owned class we drop. Captured PostgREST CTE shape (the direct-REST read
  // wraps the SELECT in pgrst_source with double-quoted identifiers).
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.verified_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."specs"."id", "public"."specs"."slug", "public"."specs"."verified_at" FROM "public"."specs" WHERE "public"."specs"."workspace_id" = $1 ORDER BY "public"."specs"."verified_at" DESC LIMIT $2 OFFSET $3 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column public.specs.verified_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."id", "public"."specs"."verified_at" FROM "public"."specs")',
    ),
    true,
  );
  // Bare SELECT variant (unqualified and public.-qualified FROM).
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.verified_at does not exist",
      "select id, slug, verified_at from public.specs order by verified_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.verified_at does not exist",
      "select verified_at from specs limit 10",
    ),
    true,
  );
  // ERROR: prefix is stripped before the equality check — the same noise with a prefix
  // still drops.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "ERROR: column specs.verified_at does not exist",
      "select verified_at from public.specs",
    ),
    true,
  );
  // Negative write-shape — a real caller writing `verified_at` on `public.specs` is a
  // code bug we WANT paged (same guard as the sibling archived_at/folded_at/fold_status
  // write assertions), so a PostgREST CTE wrapping an INSERT/UPDATE stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.verified_at does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."specs"("id", "verified_at") VALUES ($1, now()) RETURNING "public"."specs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.verified_at does not exist",
      "update public.specs set verified_at = now() where id = $1",
    ),
    false,
  );
  // Negative — a column-missing error on `specs.verified_at` attached to a JOIN across
  // other tables is not the bare SELECT-lookup shape we drop (same guard as the sibling
  // tests), so it stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.verified_at does not exist",
      "delete from public.specs where verified_at < now() - interval '90 days'",
    ),
    false,
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
  // A table that DOES carry a `verified_at` column (e.g. a verified-identity table) —
  // a real schema regression there must still page; the pin is `specs.verified_at` only.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column customers.verified_at does not exist",
      "select verified_at from public.customers where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise KEEPS a DIFFERENT column-missing on specs (a real column rename still pages)", () => {
  // Any real specs column (`status`, `deferred`, `owner`, `parent`, `slug`, `title`,
  // `vale_review_passed_at`) going missing is a schema regression we DO want to see —
  // the pin covers the five obsolete lifecycle names only.
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
  // `vale_review_passed_at` IS the real review-state column on `specs`; a missing one
  // there is a genuine schema regression that must still page.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.vale_review_passed_at does not exist",
      "select vale_review_passed_at from public.specs where id = 'x'",
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

test("isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"specs\" ...)` CTE wrapper form (Control Tower supabase-logs:db473602f67dc156)", () => {
  // The captured PostgREST direct-REST shape: identical foreign-owned lookup but wrapped
  // in the pgrst_source CTE with double-quoted `"public"."specs"` identifiers. The prior
  // bare-SELECT regex missed this because the statement starts with `with` and the FROM
  // clause carries the quoted schema.table shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.archived_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."specs"."id", "public"."specs"."slug", "public"."specs"."archived_at" FROM "public"."specs" WHERE "public"."specs"."workspace_id" = $1 ORDER BY "public"."specs"."archived_at" DESC LIMIT $2 OFFSET $3 )',
    ),
    true,
  );
  // Same wrapper on the sibling `folded_at` and `deferred_at` shapes.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.folded_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."specs"."id", "public"."specs"."folded_at" FROM "public"."specs" ORDER BY "public"."specs"."folded_at" DESC LIMIT $1 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column public.specs.deferred_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."id", "public"."specs"."deferred_at" FROM "public"."specs" WHERE "public"."specs"."workspace_id" = $1)',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "ERROR: column specs.archived_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."archived_at" FROM "public"."specs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise KEEPS a PostgREST CTE wrapper whose wrapped op is a WRITE (a real code-bug writing specs.archived_at still pages)", () => {
  // A PostgREST INSERT/UPDATE wraps as the SAME `WITH pgrst_source AS (...)` outer shell
  // (per db-health test fixture: `WITH pgrst_source AS (INSERT INTO "public"."account_usage_snapshots"...)`),
  // but its wrapped op is INSERT/UPDATE/DELETE — a real caller trying to write one of these
  // bogus timestamp columns is a code bug we WANT paged, not the ad hoc read this filter drops.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.archived_at does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."specs"("id", "archived_at") VALUES ($1, now()) RETURNING "public"."specs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column specs.folded_at does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."specs" SET "folded_at" = now() WHERE "public"."specs"."id" = $1 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise KEEPS a PostgREST CTE wrapper on a DIFFERENT table (a real schema regression on tickets.archived_at still pages)", () => {
  // Same wrapper shape but the wrapped SELECT reads a different table — the pin is
  // `specs.<archived_at|folded_at|deferred_at>` only; tickets.archived_at is a real column
  // and a column-missing there is a genuine schema regression.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(
      "column tickets.archived_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."tickets"."id", "public"."tickets"."archived_at" FROM "public"."tickets" WHERE "public"."tickets"."workspace_id" = $1 )',
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

// ── isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/specs?select=...is_active...` (or `?is_active=eq.true`) against our
// `public.specs` table. The table exists but carries no `is_active` boolean — spec
// activity is derived from `spec_phases` rollup + `status` overrides, and the sibling
// `journey_definitions.is_active` is the column the caller likely meant. Foreign-owned
// surface, no lever from us — drop AT CAPTURE only when BOTH the exact column-missing
// message on `specs.is_active` AND the bare SELECT-lookup shape on `specs` are present.
// A column-missing on any other table, a different column on `specs`, or a non-SELECT
// statement still pages.

test("isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise drops the ad hoc SELECT lookup on the exact specs.is_active column-missing shape", () => {
  // The captured PostgREST direct-REST shape — unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "column specs.is_active does not exist",
      "select id, is_active from public.specs where is_active = true",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "column public.specs.is_active does not exist",
      "select id, is_active from public.specs where is_active = true",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "column specs.is_active does not exist",
      "select is_active from specs limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "column specs.is_active does not exist",
      "select slug, is_active from public.specs where workspace_id = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "column specs.is_active does not exist",
      "SELECT ID, IS_ACTIVE FROM PUBLIC.SPECS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "ERROR: column specs.is_active does not exist",
      "select is_active from public.specs",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "  column specs.is_active does not exist  ",
      "   select is_active from public.specs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise KEEPS a column-missing error on any OTHER table (the journey_definitions.is_active the caller likely meant still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "column journey_definitions.is_active does not exist",
      "select is_active from public.journey_definitions where slug = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "column playbooks.is_active does not exist",
      "select is_active from public.playbooks where id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise KEEPS a DIFFERENT column-missing on specs (a real schema regression still pages)", () => {
  // The real `status` / `slug` / `workspace_id` columns going missing is exactly the
  // kind of regression we DO want paged.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "column specs.status does not exist",
      "select status from public.specs where workspace_id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "column specs.slug does not exist",
      "select slug from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise KEEPS a JOIN whose FROM is NOT specs (a real product join still pages)", () => {
  // A JOIN whose first FROM is a different table won't match the SELECT-lookup regex,
  // and it's a real code shape we want to see rather than an ad hoc direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "column specs.is_active does not exist",
      "select s.slug, s.is_active from public.workspaces w join public.specs s on s.workspace_id = w.id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing specs.is_active still pages)", () => {
  // INSERT / UPDATE / DELETE against specs referencing a bogus `is_active` column is
  // real code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "column specs.is_active does not exist",
      "insert into public.specs (slug, workspace_id, is_active) values ($1, $2, true)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "column specs.is_active does not exist",
      "update public.specs set is_active = true where id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "column specs.is_active does not exist",
      "delete from public.specs where is_active = false",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on specs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "database is shutting down",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      'duplicate key value violates unique constraint "specs_workspace_id_slug_key"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "canceling statement due to statement timeout",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      'permission denied for relation "public.specs"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      'relation "public.specs" does not exist',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "column specs.is_active does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(
      "column specs.is_active does not exist",
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

// ── isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/spec_phases?select=...shipped_at...` against our `public.spec_phases` table.
// The table exists but carries no `shipped_at` timestamp column — a phase's shipped
// state is recorded via `status = 'shipped'` plus the `build_sha` + `build_pr_url`
// provenance pair. Foreign-owned surface, no lever from us — drop AT CAPTURE only when
// BOTH the exact column-missing message on `spec_phases.shipped_at` AND a SELECT-lookup
// shape on `spec_phases` (bare OR PostgREST CTE wrapper) are present. A column-missing
// on any other table, a different column on `spec_phases`, a JOIN through `specs`, or a
// non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise drops the ad hoc SELECT lookup on the exact spec_phases.shipped_at column-missing shape", () => {
  // The captured production sample: unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column spec_phases.shipped_at does not exist",
      "select id, shipped_at from public.spec_phases order by shipped_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column public.spec_phases.shipped_at does not exist",
      "select id, shipped_at from public.spec_phases order by shipped_at desc limit 100",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column spec_phases.shipped_at does not exist",
      "select shipped_at from spec_phases limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column spec_phases.shipped_at does not exist",
      "select spec_id, shipped_at from public.spec_phases where spec_id = 'x' order by shipped_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column spec_phases.shipped_at does not exist",
      "SELECT ID, SHIPPED_AT FROM PUBLIC.SPEC_PHASES",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "ERROR: column spec_phases.shipped_at does not exist",
      "select shipped_at from public.spec_phases",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "  column spec_phases.shipped_at does not exist  ",
      "   select shipped_at from public.spec_phases   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"spec_phases\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."spec_phases"` identifiers. The plain
  // bare-SELECT regex misses this because the statement starts with `with` and the FROM
  // clause carries the quoted schema.table shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column spec_phases.shipped_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."spec_phases"."id", "public"."spec_phases"."shipped_at" FROM "public"."spec_phases" WHERE "public"."spec_phases"."spec_id" = $1 ORDER BY "public"."spec_phases"."shipped_at" DESC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column public.spec_phases.shipped_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."spec_phases"."shipped_at" FROM "public"."spec_phases")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "ERROR: column spec_phases.shipped_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."spec_phases"."shipped_at" FROM "public"."spec_phases")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a shipped_at column still pages)", () => {
  // `orders.amplifier_shipped_at` is a real column — if a caller regressed a lookup
  // there the message wouldn't match, but any *other* table with a real `shipped_at`
  // column would be a genuine schema regression we want to see.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column orders.shipped_at does not exist",
      "select shipped_at from public.orders where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column shipments.shipped_at does not exist",
      "select shipped_at from public.shipments where id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise KEEPS a DIFFERENT column-missing on spec_phases (a real column rename still pages)", () => {
  // Real spec_phases columns — if any of these regress we absolutely want the page.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column spec_phases.status does not exist",
      "select status from public.spec_phases where spec_id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column spec_phases.position does not exist",
      "select position from public.spec_phases where spec_id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column spec_phases.build_sha does not exist",
      "select build_sha from public.spec_phases where spec_id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column spec_phases.build_pr_url does not exist",
      "select build_pr_url from public.spec_phases where spec_id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise KEEPS a JOIN across other tables (a real code shape joining specs still pages)", () => {
  // The regex is anchored on `from (public.)?spec_phases` as the first FROM target; a
  // JOIN whose first FROM is `specs` won't match — which is the outcome we want,
  // because a caller that joins the two and asks for a real column shape is product
  // code, not the ad hoc direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column spec_phases.shipped_at does not exist",
      "select s.slug, p.shipped_at from public.specs s join public.spec_phases p on p.spec_id = s.id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing spec_phases.shipped_at still pages)", () => {
  // INSERT / UPDATE / DELETE against spec_phases referencing a bogus column is real
  // code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column spec_phases.shipped_at does not exist",
      "insert into public.spec_phases (spec_id, shipped_at) values ($1, now())",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column spec_phases.shipped_at does not exist",
      "update public.spec_phases set shipped_at = now() where id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column spec_phases.shipped_at does not exist",
      "delete from public.spec_phases where shipped_at < now() - interval '30 days'",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column spec_phases.shipped_at does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."spec_phases"("id", "shipped_at") VALUES ($1, now()) RETURNING "public"."spec_phases"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column spec_phases.shipped_at does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."spec_phases" SET "shipped_at" = now() WHERE "public"."spec_phases"."id" = $1 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise KEEPS a PostgREST CTE wrapper on a DIFFERENT table (a real schema regression on orders.shipped_at still pages)", () => {
  // Same wrapper shape but the wrapped SELECT reads a different table — the pin is
  // `spec_phases.shipped_at` only; any other table's shipped_at is a genuine schema
  // regression we want to see.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column orders.shipped_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."orders"."id", "public"."orders"."shipped_at" FROM "public"."orders" WHERE "public"."orders"."workspace_id" = $1 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on spec_phases (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "database is shutting down",
      "select id from public.spec_phases where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      'duplicate key value violates unique constraint "spec_phases_spec_position"',
      "select id from public.spec_phases where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "canceling statement due to statement timeout",
      "select id from public.spec_phases where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      'permission denied for relation "public.spec_phases"',
      "select id from public.spec_phases where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      'relation "public.spec_phases" does not exist',
      "select id from public.spec_phases where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column spec_phases.shipped_at does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(
      "column spec_phases.shipped_at does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/specs?select=...body_md...` or `?body_md=ilike.*x*` against our
// `public.specs` table. The table exists but carries no `body_md` column — phase body
// text lives on `spec_phases.body`, per phase. Foreign-owned surface, no lever from us
// — drop AT CAPTURE only when BOTH the exact column-missing message on `specs.body_md`
// AND a SELECT-lookup shape on `specs` (bare OR PostgREST CTE wrapper) are present. A
// column-missing on any other table, a different column on `specs`, a JOIN through
// `spec_phases`, or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise drops the ad hoc SELECT lookup on the exact specs.body_md column-missing shape", () => {
  // The captured production sample: unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column specs.body_md does not exist",
      "select id, body_md from public.specs where body_md ilike '%x%' limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column public.specs.body_md does not exist",
      "select id, body_md from public.specs where body_md ilike '%x%' limit 100",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column specs.body_md does not exist",
      "select body_md from specs limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column specs.body_md does not exist",
      "select slug, body_md from public.specs where slug = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column specs.body_md does not exist",
      "SELECT ID, BODY_MD FROM PUBLIC.SPECS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "ERROR: column specs.body_md does not exist",
      "select body_md from public.specs",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "  column specs.body_md does not exist  ",
      "   select body_md from public.specs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"specs\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in
  // the pgrst_source CTE with double-quoted `"public"."specs"` identifiers. The plain
  // bare-SELECT regex misses this because the statement starts with `with` and the
  // FROM clause carries the quoted schema.table shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column specs.body_md does not exist",
      'WITH pgrst_source AS ( SELECT "public"."specs"."id", "public"."specs"."body_md" FROM "public"."specs" WHERE "public"."specs"."body_md" ILIKE $1 LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column public.specs.body_md does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."body_md" FROM "public"."specs")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "ERROR: column specs.body_md does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."body_md" FROM "public"."specs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a body_md column still pages)", () => {
  // If any other table had a real `body_md` column and regressed, we absolutely want
  // to see it — the pin is `specs.body_md` only.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column posts.body_md does not exist",
      "select body_md from public.posts where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column articles.body_md does not exist",
      "select body_md from public.articles where id = $1",
    ),
    false,
  );
  // Sibling `spec_phases.body_md` (also non-existent) is a DIFFERENT foreign-caller
  // shape on a DIFFERENT table — the pin here is `specs` only, so this stays paged
  // rather than silently swallowed by the specs classifier.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column spec_phases.body_md does not exist",
      "select body_md from public.spec_phases where spec_id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise KEEPS a DIFFERENT column-missing on specs (a real column rename still pages)", () => {
  // Real `specs` columns — if any of these regress we absolutely want the page.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column specs.status does not exist",
      "select status from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column specs.slug does not exist",
      "select slug from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column specs.workspace_id does not exist",
      "select workspace_id from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise KEEPS a JOIN across other tables (a real code shape joining spec_phases still pages)", () => {
  // The regex is anchored on `from (public.)?specs` as the first FROM target; a JOIN
  // whose first FROM is `spec_phases` won't match — which is the outcome we want,
  // because a caller that joins the two and asks for a real column shape is product
  // code, not the ad hoc direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column specs.body_md does not exist",
      "select p.body, s.body_md from public.spec_phases p join public.specs s on s.id = p.spec_id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing specs.body_md still pages)", () => {
  // INSERT / UPDATE / DELETE against specs referencing a bogus column is real code
  // trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column specs.body_md does not exist",
      "insert into public.specs (slug, body_md) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column specs.body_md does not exist",
      "update public.specs set body_md = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column specs.body_md does not exist",
      "delete from public.specs where body_md is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column specs.body_md does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."specs"("slug", "body_md") VALUES ($1, $2) RETURNING "public"."specs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column specs.body_md does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."specs" SET "body_md" = $1 WHERE "public"."specs"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise KEEPS a PostgREST CTE wrapper on a DIFFERENT table (a real schema regression on posts.body_md still pages)", () => {
  // Same wrapper shape but the wrapped SELECT reads a different table — the pin is
  // `specs.body_md` only; any other table's body_md is a genuine schema regression
  // we want to see.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column posts.body_md does not exist",
      'WITH pgrst_source AS ( SELECT "public"."posts"."id", "public"."posts"."body_md" FROM "public"."posts" WHERE "public"."posts"."workspace_id" = $1 )',
    ),
    false,
  );
  // Sibling table `spec_phases` — the anchor `\bspecs\b` won't match `spec_phases`,
  // so this stays paged rather than being swallowed by the specs classifier.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column spec_phases.body_md does not exist",
      'WITH pgrst_source AS ( SELECT "public"."spec_phases"."id", "public"."spec_phases"."body_md" FROM "public"."spec_phases" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on specs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "database is shutting down",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      'duplicate key value violates unique constraint "specs_workspace_slug"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "canceling statement due to statement timeout",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      'permission denied for relation "public.specs"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      'relation "public.specs" does not exist',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column specs.body_md does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(
      "column specs.body_md does not exist",
      null,
    ),
    false,
  );
});


// ── isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/specs?select=slug,status,flags,...` against our `public.specs` table. The
// table exists but has NEVER had a `flags` column — the live signals a spec carries
// (needs_human, in_review, etc.) moved to typed columns and the `spec_card_state`
// rollup, and the first-party SDK does NOT select `specs.flags`. Foreign-owned
// surface, no lever from us — drop AT CAPTURE only when BOTH the exact column-missing
// message on `specs.flags` AND a SELECT-lookup shape on `specs` (bare OR PostgREST CTE
// wrapper) are present. A column-missing on any other table, a different column on
// `specs`, a JOIN through `spec_phases`, or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise drops the ad hoc SELECT lookup on the exact specs.flags column-missing shape", () => {
  // The captured production sample: unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column specs.flags does not exist",
      "select slug, status, flags from public.specs where slug = 'x' limit 1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column public.specs.flags does not exist",
      "select slug, status, flags from public.specs where slug = 'x' limit 1",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column specs.flags does not exist",
      "select flags from specs limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column specs.flags does not exist",
      "select slug, flags from public.specs where slug = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column specs.flags does not exist",
      "SELECT SLUG, FLAGS FROM PUBLIC.SPECS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "ERROR: column specs.flags does not exist",
      "select flags from public.specs",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "  column specs.flags does not exist  ",
      "   select flags from public.specs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"specs\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in
  // the pgrst_source CTE with double-quoted `"public"."specs"` identifiers. The plain
  // bare-SELECT regex misses this because the statement starts with `with` and the
  // FROM clause carries the quoted schema.table shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column specs.flags does not exist",
      'WITH pgrst_source AS ( SELECT "public"."specs"."slug", "public"."specs"."flags" FROM "public"."specs" WHERE "public"."specs"."slug" = $1 LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column public.specs.flags does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."flags" FROM "public"."specs")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "ERROR: column specs.flags does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."flags" FROM "public"."specs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a flags column still pages)", () => {
  // If any other table had a real `flags` column and regressed, we absolutely want to
  // see it — the pin is `specs.flags` only.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column tickets.flags does not exist",
      "select flags from public.tickets where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column customers.flags does not exist",
      "select flags from public.customers where id = $1",
    ),
    false,
  );
  // Sibling `spec_phases.flags` (also non-existent) is a DIFFERENT foreign-caller
  // shape on a DIFFERENT table — the pin here is `specs` only, so this stays paged
  // rather than silently swallowed by the specs classifier.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column spec_phases.flags does not exist",
      "select flags from public.spec_phases where spec_id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise KEEPS a DIFFERENT column-missing on specs (a real column rename still pages)", () => {
  // Real `specs` columns — if any of these regress we absolutely want the page.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column specs.status does not exist",
      "select status from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column specs.slug does not exist",
      "select slug from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column specs.workspace_id does not exist",
      "select workspace_id from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise KEEPS a JOIN across other tables (a real code shape joining spec_phases still pages)", () => {
  // The regex is anchored on `from (public.)?specs` as the first FROM target; a JOIN
  // whose first FROM is `spec_phases` won't match — which is the outcome we want,
  // because a caller that joins the two and asks for a real column shape is product
  // code, not the ad hoc direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column specs.flags does not exist",
      "select p.body, s.flags from public.spec_phases p join public.specs s on s.id = p.spec_id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing specs.flags still pages)", () => {
  // INSERT / UPDATE / DELETE against specs referencing a bogus column is real code
  // trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column specs.flags does not exist",
      "insert into public.specs (slug, flags) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column specs.flags does not exist",
      "update public.specs set flags = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column specs.flags does not exist",
      "delete from public.specs where flags is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column specs.flags does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."specs"("slug", "flags") VALUES ($1, $2) RETURNING "public"."specs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column specs.flags does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."specs" SET "flags" = $1 WHERE "public"."specs"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise KEEPS a PostgREST CTE wrapper on a DIFFERENT table (a real schema regression on tickets.flags still pages)", () => {
  // Same wrapper shape but the wrapped SELECT reads a different table — the pin is
  // `specs.flags` only; any other table's flags is a genuine schema regression we
  // want to see.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column tickets.flags does not exist",
      'WITH pgrst_source AS ( SELECT "public"."tickets"."id", "public"."tickets"."flags" FROM "public"."tickets" WHERE "public"."tickets"."workspace_id" = $1 )',
    ),
    false,
  );
  // Sibling table `spec_phases` — the anchor `\bspecs\b` won't match `spec_phases`,
  // so this stays paged rather than being swallowed by the specs classifier.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column spec_phases.flags does not exist",
      'WITH pgrst_source AS ( SELECT "public"."spec_phases"."id", "public"."spec_phases"."flags" FROM "public"."spec_phases" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on specs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "database is shutting down",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      'duplicate key value violates unique constraint "specs_workspace_slug"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "canceling statement due to statement timeout",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      'permission denied for relation "public.specs"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      'relation "public.specs" does not exist',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column specs.flags does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsFlagsAdhocNoise(
      "column specs.flags does not exist",
      null,
    ),
    false,
  );
});


// ── isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads `public.specs` with a phantom
// `owner_function` scalar column. The table exists but has NEVER had an `owner_function`
// column — the real owning function slug lives on `specs.owner text`, and the
// first-party SDK does NOT select `specs.owner_function`. Foreign-owned surface, no
// lever from us — drop AT CAPTURE only when BOTH the exact column-missing message on
// `specs.owner_function` AND a SELECT-lookup shape on `specs` (bare OR PostgREST CTE
// wrapper) are present. A column-missing on any other table, a different column on
// `specs`, a JOIN through `spec_phases`, or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise drops the ad hoc SELECT lookup on the exact specs.owner_function column-missing shape", () => {
  // The captured production sample: unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column specs.owner_function does not exist",
      "select slug, status, owner_function from public.specs where slug = 'x' limit 1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column public.specs.owner_function does not exist",
      "select slug, status, owner_function from public.specs where slug = 'x' limit 1",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column specs.owner_function does not exist",
      "select owner_function from specs limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column specs.owner_function does not exist",
      "select slug, owner_function from public.specs where slug = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column specs.owner_function does not exist",
      "SELECT SLUG, OWNER_FUNCTION FROM PUBLIC.SPECS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "ERROR: column specs.owner_function does not exist",
      "select owner_function from public.specs",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "  column specs.owner_function does not exist  ",
      "   select owner_function from public.specs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"specs\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in
  // the pgrst_source CTE with double-quoted `"public"."specs"` identifiers. The plain
  // bare-SELECT regex misses this because the statement starts with `with` and the
  // FROM clause carries the quoted schema.table shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column specs.owner_function does not exist",
      'WITH pgrst_source AS ( SELECT "public"."specs"."slug", "public"."specs"."owner_function" FROM "public"."specs" WHERE "public"."specs"."slug" = $1 LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column public.specs.owner_function does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."owner_function" FROM "public"."specs")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "ERROR: column specs.owner_function does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."owner_function" FROM "public"."specs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have an owner_function column still pages)", () => {
  // If any other table had a real `owner_function` column and regressed, we absolutely
  // want to see it — the pin is `specs.owner_function` only.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column tickets.owner_function does not exist",
      "select owner_function from public.tickets where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column agent_jobs.owner_function does not exist",
      "select owner_function from public.agent_jobs where id = $1",
    ),
    false,
  );
  // Sibling `spec_phases.owner_function` (also non-existent) is a DIFFERENT foreign-
  // caller shape on a DIFFERENT table — the pin here is `specs` only, so this stays
  // paged rather than silently swallowed by the specs classifier.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column spec_phases.owner_function does not exist",
      "select owner_function from public.spec_phases where spec_id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise KEEPS a DIFFERENT column-missing on specs (a real column rename still pages)", () => {
  // Real `specs` columns — if any of these regress we absolutely want the page.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column specs.owner does not exist",
      "select owner from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column specs.status does not exist",
      "select status from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column specs.slug does not exist",
      "select slug from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column specs.workspace_id does not exist",
      "select workspace_id from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise KEEPS a JOIN across other tables (a real code shape joining spec_phases still pages)", () => {
  // The regex is anchored on `from (public.)?specs` as the first FROM target; a JOIN
  // whose first FROM is `spec_phases` won't match — which is the outcome we want,
  // because a caller that joins the two and asks for a real column shape is product
  // code, not the ad hoc direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column specs.owner_function does not exist",
      "select p.body, s.owner_function from public.spec_phases p join public.specs s on s.id = p.spec_id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing specs.owner_function still pages)", () => {
  // INSERT / UPDATE / DELETE against specs referencing a bogus column is real code
  // trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column specs.owner_function does not exist",
      "insert into public.specs (slug, owner_function) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column specs.owner_function does not exist",
      "update public.specs set owner_function = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column specs.owner_function does not exist",
      "delete from public.specs where owner_function is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column specs.owner_function does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."specs"("slug", "owner_function") VALUES ($1, $2) RETURNING "public"."specs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column specs.owner_function does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."specs" SET "owner_function" = $1 WHERE "public"."specs"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise KEEPS a PostgREST CTE wrapper on a DIFFERENT table (a real schema regression on tickets.owner_function still pages)", () => {
  // Same wrapper shape but the wrapped SELECT reads a different table — the pin is
  // `specs.owner_function` only; any other table's owner_function is a genuine schema
  // regression we want to see.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column tickets.owner_function does not exist",
      'WITH pgrst_source AS ( SELECT "public"."tickets"."id", "public"."tickets"."owner_function" FROM "public"."tickets" WHERE "public"."tickets"."workspace_id" = $1 )',
    ),
    false,
  );
  // Sibling table `spec_phases` — the anchor `\bspecs\b` won't match `spec_phases`,
  // so this stays paged rather than being swallowed by the specs classifier.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column spec_phases.owner_function does not exist",
      'WITH pgrst_source AS ( SELECT "public"."spec_phases"."id", "public"."spec_phases"."owner_function" FROM "public"."spec_phases" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on specs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "database is shutting down",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      'duplicate key value violates unique constraint "specs_workspace_slug"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "canceling statement due to statement timeout",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      'permission denied for relation "public.specs"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      'relation "public.specs" does not exist',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column specs.owner_function does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsOwnerFunctionAdhocNoise(
      "column specs.owner_function does not exist",
      null,
    ),
    false,
  );
});


// ── isForeignSupabasePostgresMissingSpecsTargetAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads `public.specs` with a phantom
// `target` scalar column. The table exists but has NEVER had a `target` column — a
// spec's parent (owning function mandate or goal milestone) is encoded on
// `specs.parent_kind` + `specs.parent_slug`, and the first-party SDK does NOT select
// `specs.target`. Foreign-owned surface, no lever from us — drop AT CAPTURE only when
// BOTH the exact column-missing message on `specs.target` AND a SELECT-lookup shape on
// `specs` (bare OR PostgREST CTE wrapper) are present. A column-missing on any other
// table, a different column on `specs`, a JOIN through `spec_phases`, or a non-SELECT
// statement still pages. Mirrors the OwnerFunction sibling block above.

test("isForeignSupabasePostgresMissingSpecsTargetAdhocNoise drops the ad hoc SELECT lookup on the exact specs.target column-missing shape", () => {
  // The captured production sample: unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "column specs.target does not exist",
      "select slug, status, target from public.specs where slug = 'x' limit 1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "column public.specs.target does not exist",
      "select slug, status, target from public.specs where slug = 'x' limit 1",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "column specs.target does not exist",
      "select target from specs limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "column specs.target does not exist",
      "select slug, target from public.specs where slug = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "column specs.target does not exist",
      "SELECT SLUG, TARGET FROM PUBLIC.SPECS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "ERROR: column specs.target does not exist",
      "select target from public.specs",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "  column specs.target does not exist  ",
      "   select target from public.specs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsTargetAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"specs\" ...)` CTE wrapper form", () => {
  // The exact PostgREST direct-REST wire shape behind Control Tower signature
  // `supabase-logs:1244667ec7881f07`: the foreign-owned lookup wrapped in the
  // `pgrst_source` CTE with double-quoted `"public"."specs"` identifiers. The plain
  // bare-SELECT regex misses this because the statement starts with `with` and the
  // FROM clause carries the quoted schema.table shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "column specs.target does not exist",
      'WITH pgrst_source AS ( SELECT "public"."specs"."slug", "public"."specs"."target" FROM "public"."specs" WHERE "public"."specs"."slug" = $1 LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "column public.specs.target does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."target" FROM "public"."specs")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "ERROR: column specs.target does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."target" FROM "public"."specs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsTargetAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a target column still pages)", () => {
  // If any other table had a real `target` column and regressed, we absolutely want to
  // see it — the pin is `specs.target` only.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "column agent_jobs.target does not exist",
      "select target from public.agent_jobs where id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "column goal_milestones.target does not exist",
      "select target from public.goal_milestones where id = 'x'",
    ),
    false,
  );
  // Sibling `spec_phases.target` (also non-existent) is a DIFFERENT foreign-caller
  // shape on a DIFFERENT table — the pin here is `specs` only, so this stays paged
  // rather than silently swallowed by the specs classifier.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "column spec_phases.target does not exist",
      "select target from public.spec_phases where spec_id = 'x'",
    ),
    false,
  );
  // PostgREST CTE wrapper on a different table — same wrapper shape, different FROM.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "column agent_jobs.target does not exist",
      'WITH pgrst_source AS ( SELECT "public"."agent_jobs"."id", "public"."agent_jobs"."target" FROM "public"."agent_jobs" WHERE "public"."agent_jobs"."workspace_id" = $1 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsTargetAdhocNoise KEEPS a DIFFERENT column-missing on specs (a real column rename still pages)", () => {
  // Real `specs` columns — if any of these regress we absolutely want the page.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "column specs.owner does not exist",
      "select owner from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "column specs.status does not exist",
      "select status from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "column specs.slug does not exist",
      "select slug from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "column specs.parent_kind does not exist",
      "select parent_kind from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsTargetAdhocNoise(
      "column specs.parent_slug does not exist",
      "select parent_slug from public.specs where id = 'x'",
    ),
    false,
  );
});


// ── isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads `public.specs` with phantom
// `problem` / `proposed_change` scalar columns. The table exists but by design carries
// NO such columns — that prose lives inline in each `spec_phases.body` row. Foreign-
// owned surface, no lever from us — drop AT CAPTURE only when BOTH the exact column-
// missing message on ONE of `specs.problem` / `specs.proposed_change` AND a SELECT-
// lookup shape on `specs` (bare OR PostgREST CTE wrapper) are present. A column-missing
// on any other table, a different column on `specs`, a JOIN through `spec_phases`, or a
// non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise drops the ad hoc SELECT lookup on the exact specs.problem / specs.proposed_change column-missing shape", () => {
  // The captured production samples: both column variants, unqualified and public.-
  // qualified message shapes.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.problem does not exist",
      "select slug, title, problem from public.specs where slug = 'x' limit 1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column public.specs.problem does not exist",
      "select slug, title, problem from public.specs where slug = 'x' limit 1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.proposed_change does not exist",
      "select slug, title, proposed_change from public.specs where slug = 'x' limit 1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column public.specs.proposed_change does not exist",
      "select slug, title, proposed_change from public.specs where slug = 'x' limit 1",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.problem does not exist",
      "select problem from specs limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.proposed_change does not exist",
      "select slug, proposed_change from public.specs where slug = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.problem does not exist",
      "SELECT SLUG, PROBLEM FROM PUBLIC.SPECS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "ERROR: column specs.problem does not exist",
      "select problem from public.specs",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "  column specs.proposed_change does not exist  ",
      "   select proposed_change from public.specs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"specs\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in
  // the pgrst_source CTE with double-quoted `"public"."specs"` identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.problem does not exist",
      'WITH pgrst_source AS ( SELECT "public"."specs"."slug", "public"."specs"."problem" FROM "public"."specs" WHERE "public"."specs"."slug" = $1 LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column public.specs.proposed_change does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."proposed_change" FROM "public"."specs")',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "ERROR: column specs.problem does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."problem" FROM "public"."specs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a problem / proposed_change column still pages)", () => {
  // If any other table ever carried a real `problem` or `proposed_change` column and
  // regressed, we absolutely want to see it — the pin is `specs.problem` /
  // `specs.proposed_change` only.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column tickets.problem does not exist",
      "select problem from public.tickets where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column pending_folds.proposed_change does not exist",
      "select proposed_change from public.pending_folds where id = $1",
    ),
    false,
  );
  // Sibling `spec_phases` (the real home of problem/proposed_change prose on `body`)
  // is a DIFFERENT table — the pin here is `specs` only, so this stays paged rather
  // than silently swallowed by the specs classifier.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column spec_phases.problem does not exist",
      "select problem from public.spec_phases where spec_id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column spec_phases.proposed_change does not exist",
      "select proposed_change from public.spec_phases where spec_id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise KEEPS a DIFFERENT column-missing on specs (a real column rename still pages)", () => {
  // Real `specs` columns — if any of these regress we absolutely want the page.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.status does not exist",
      "select status from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.slug does not exist",
      "select slug from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.workspace_id does not exist",
      "select workspace_id from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise KEEPS a JOIN across other tables (a real code shape joining spec_phases still pages)", () => {
  // The regex is anchored on `from (public.)?specs` as the first FROM target; a JOIN
  // whose first FROM is `spec_phases` won't match — which is the outcome we want,
  // because a caller that joins the two is product code, not the ad hoc direct-REST
  // read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.problem does not exist",
      "select p.body, s.problem from public.spec_phases p join public.specs s on s.id = p.spec_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.proposed_change does not exist",
      "select p.body, s.proposed_change from public.spec_phases p join public.specs s on s.id = p.spec_id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing specs.problem / specs.proposed_change still pages)", () => {
  // INSERT / UPDATE / DELETE against specs referencing a bogus column is real code
  // trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.problem does not exist",
      "insert into public.specs (slug, problem) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.proposed_change does not exist",
      "update public.specs set proposed_change = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.problem does not exist",
      "delete from public.specs where problem is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.problem does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."specs"("slug", "problem") VALUES ($1, $2) RETURNING "public"."specs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.proposed_change does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."specs" SET "proposed_change" = $1 WHERE "public"."specs"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on specs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "database is shutting down",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      'duplicate key value violates unique constraint "specs_workspace_slug"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "canceling statement due to statement timeout",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      'permission denied for relation "public.specs"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      'relation "public.specs" does not exist',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.problem does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsProblemProposedChangeAdhocNoise(
      "column specs.proposed_change does not exist",
      null,
    ),
    false,
  );
});


// ── isForeignSupabasePostgresMissingSpecsIntentAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads `public.specs` with a phantom
// `intent` scalar column. The table exists but by design carries NO such column — that
// prose lives in `specs.why` + `specs.what` on each row. Foreign-owned surface, no lever
// from us — drop AT CAPTURE only when BOTH the exact column-missing message on
// `specs.intent` AND a SELECT-lookup shape on `specs` (bare OR PostgREST CTE wrapper)
// are present. A column-missing on any other table, a different column on `specs`, a
// JOIN through `spec_phases`, or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingSpecsIntentAdhocNoise drops the ad hoc SELECT lookup on the exact specs.intent column-missing shape", () => {
  // The captured production sample: unqualified and public.-qualified message shapes.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.intent does not exist",
      "select slug, title, intent from public.specs where slug = 'x' limit 1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column public.specs.intent does not exist",
      "select slug, title, intent from public.specs where slug = 'x' limit 1",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.intent does not exist",
      "select intent from specs limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.intent does not exist",
      "select slug, intent from public.specs where slug = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.intent does not exist",
      "SELECT SLUG, INTENT FROM PUBLIC.SPECS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "ERROR: column specs.intent does not exist",
      "select intent from public.specs",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "  column specs.intent does not exist  ",
      "   select intent from public.specs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsIntentAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"specs\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in
  // the pgrst_source CTE with double-quoted `"public"."specs"` identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.intent does not exist",
      'WITH pgrst_source AS ( SELECT "public"."specs"."slug", "public"."specs"."intent" FROM "public"."specs" WHERE "public"."specs"."slug" = $1 LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column public.specs.intent does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."intent" FROM "public"."specs")',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "ERROR: column specs.intent does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."intent" FROM "public"."specs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsIntentAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have an intent column still pages)", () => {
  // If any other table ever carries a real `intent` column and regresses, we absolutely
  // want to see it — the pin is `specs.intent` only.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column tickets.intent does not exist",
      "select intent from public.tickets where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column ticket_analyses.intent does not exist",
      "select intent from public.ticket_analyses where id = $1",
    ),
    false,
  );
  // Sibling `spec_phases` is a DIFFERENT table — the pin here is `specs` only, so this
  // stays paged rather than silently swallowed by the specs classifier.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column spec_phases.intent does not exist",
      "select intent from public.spec_phases where spec_id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsIntentAdhocNoise KEEPS a DIFFERENT column-missing on specs (a real column rename still pages)", () => {
  // Real `specs` columns — if any of these regress we absolutely want the page.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.status does not exist",
      "select status from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.slug does not exist",
      "select slug from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.workspace_id does not exist",
      "select workspace_id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.why does not exist",
      "select why from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.what does not exist",
      "select what from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsIntentAdhocNoise KEEPS a JOIN across other tables (a real code shape joining spec_phases still pages)", () => {
  // The regex is anchored on `from (public.)?specs` as the first FROM target; a JOIN
  // whose first FROM is `spec_phases` won't match — which is the outcome we want,
  // because a caller that joins the two is product code, not the ad hoc direct-REST
  // read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.intent does not exist",
      "select p.body, s.intent from public.spec_phases p join public.specs s on s.id = p.spec_id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsIntentAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing specs.intent still pages)", () => {
  // INSERT / UPDATE / DELETE against specs referencing a bogus column is real code
  // trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.intent does not exist",
      "insert into public.specs (slug, intent) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.intent does not exist",
      "update public.specs set intent = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.intent does not exist",
      "delete from public.specs where intent is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.intent does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."specs"("slug", "intent") VALUES ($1, $2) RETURNING "public"."specs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.intent does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."specs" SET "intent" = $1 WHERE "public"."specs"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsIntentAdhocNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on specs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "database is shutting down",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      'duplicate key value violates unique constraint "specs_workspace_slug"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "canceling statement due to statement timeout",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      'permission denied for relation "public.specs"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      'relation "public.specs" does not exist',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsIntentAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.intent does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsIntentAdhocNoise(
      "column specs.intent does not exist",
      null,
    ),
    false,
  );
});


// ── isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/agent_jobs?select=slug,spec_slug,...` against our `public.agent_jobs` table.
// The table exists but has NEVER had a `slug` column — the durable subject field is
// `spec_slug`. Foreign-owned surface, no lever from us — drop AT CAPTURE only when ALL
// THREE of the exact column-missing message on `agent_jobs.slug`, a SELECT-lookup shape
// on `agent_jobs` (bare OR PostgREST CTE wrapper), AND a `spec_slug` mention in the same
// query are present. A column-missing on any other table, a different column on
// `agent_jobs`, a JOIN through `approval_decisions`, a bare `select slug from agent_jobs`
// without `spec_slug`, or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise drops the ad hoc SELECT lookup on the exact agent_jobs.slug column-missing shape", () => {
  // The captured production sample: unqualified and public.-qualified variants, the
  // caller always asks for BOTH slug and the real spec_slug column.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.slug does not exist",
      "select slug, spec_slug from public.agent_jobs order by created_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column public.agent_jobs.slug does not exist",
      "select slug, spec_slug from public.agent_jobs order by created_at desc limit 100",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.slug does not exist",
      "select slug, spec_slug from agent_jobs limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.slug does not exist",
      "select id, slug, spec_slug from public.agent_jobs where workspace_id = $1 order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.slug does not exist",
      "SELECT SLUG, SPEC_SLUG FROM PUBLIC.AGENT_JOBS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "ERROR: column agent_jobs.slug does not exist",
      "select slug, spec_slug from public.agent_jobs",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "  column agent_jobs.slug does not exist  ",
      "   select slug, spec_slug from public.agent_jobs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"agent_jobs\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."agent_jobs"` identifiers. The plain
  // bare-SELECT regex misses this because the statement starts with `with` and the FROM
  // clause carries the quoted schema.table shape.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.slug does not exist",
      'WITH pgrst_source AS ( SELECT "public"."agent_jobs"."id", "public"."agent_jobs"."slug", "public"."agent_jobs"."spec_slug" FROM "public"."agent_jobs" WHERE "public"."agent_jobs"."workspace_id" = $1 ORDER BY "public"."agent_jobs"."created_at" DESC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column public.agent_jobs.slug does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."slug", "public"."agent_jobs"."spec_slug" FROM "public"."agent_jobs")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "ERROR: column agent_jobs.slug does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."slug", "public"."agent_jobs"."spec_slug" FROM "public"."agent_jobs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a slug column still pages)", () => {
  // `specs.slug` and `policies.slug` are real columns — a schema regression there would
  // be a genuine bug we want to see.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column specs.slug does not exist",
      "select slug, spec_slug from public.specs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column policies.slug does not exist",
      "select slug, spec_slug from public.policies where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise KEEPS a DIFFERENT column-missing on agent_jobs (a real column rename still pages)", () => {
  // Real agent_jobs columns — if any of these regress we absolutely want the page.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.status does not exist",
      "select status, spec_slug from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.kind does not exist",
      "select kind, spec_slug from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.spec_slug does not exist",
      "select spec_slug from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.workspace_id does not exist",
      "select workspace_id, spec_slug from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.payload does not exist",
      "select payload, spec_slug from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "select branch_name, spec_slug from public.agent_jobs",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise KEEPS a bare `select slug from agent_jobs` without spec_slug (hypothetical real code after a schema regression still pages)", () => {
  // The drop is scoped to the confused-column pairing (`slug` + `spec_slug`); a bare
  // read that only asks for `slug` could hypothetically be real product code after a
  // schema regression, so it stays paged.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.slug does not exist",
      "select slug from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.slug does not exist",
      "select id, slug from agent_jobs limit 10",
    ),
    false,
  );
  // CTE wrapper without spec_slug in the wrapped select is also kept.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.slug does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."slug" FROM "public"."agent_jobs")',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise KEEPS a JOIN across other tables (a real code shape joining approval_decisions still pages)", () => {
  // The regex is anchored on `from (public.)?agent_jobs` as the first FROM target; a
  // JOIN whose first FROM is `approval_decisions` won't match — which is the outcome
  // we want, because a caller that joins the two and asks for a real column shape is
  // product code, not the ad hoc direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.slug does not exist",
      "select a.slug, j.spec_slug from public.approval_decisions a join public.agent_jobs j on j.id = a.agent_job_id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise KEEPS a non-SELECT statement shape (a real code-bug writing agent_jobs.slug still pages)", () => {
  // INSERT / UPDATE / DELETE against agent_jobs referencing a bogus column is real
  // code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.slug does not exist",
      "insert into public.agent_jobs (slug, spec_slug) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.slug does not exist",
      "update public.agent_jobs set slug = $1 where spec_slug = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.slug does not exist",
      "delete from public.agent_jobs where slug = $1 and spec_slug = $2",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.slug does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."agent_jobs"("slug", "spec_slug") VALUES ($1, $2) RETURNING "public"."agent_jobs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.slug does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."agent_jobs" SET "slug" = $1 WHERE "public"."agent_jobs"."spec_slug" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise KEEPS a PostgREST CTE wrapper on a DIFFERENT table (a real schema regression on specs.slug still pages)", () => {
  // Same wrapper shape but the wrapped SELECT reads a different table — the pin is
  // `agent_jobs.slug` only; any other table's slug is a genuine schema regression.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column specs.slug does not exist",
      'WITH pgrst_source AS ( SELECT "public"."specs"."slug", "public"."specs"."spec_slug" FROM "public"."specs" WHERE "public"."specs"."workspace_id" = $1 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on agent_jobs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "database is shutting down",
      "select slug, spec_slug from public.agent_jobs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      'duplicate key value violates unique constraint "agent_jobs_pkey"',
      "select slug, spec_slug from public.agent_jobs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "canceling statement due to statement timeout",
      "select slug, spec_slug from public.agent_jobs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      'permission denied for relation "public.agent_jobs"',
      "select slug, spec_slug from public.agent_jobs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      'relation "public.agent_jobs" does not exist',
      "select slug, spec_slug from public.agent_jobs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.slug does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(
      "column agent_jobs.slug does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/agent_jobs?select=title,spec_slug,...` against our `public.agent_jobs` table.
// The table exists but has NEVER had a `title` column — the human-readable label every
// ShopCX surface renders comes from the joined `specs.title` through the agent_jobs SDK,
// never a column on the row itself. Foreign-owned surface, no lever from us — drop AT
// CAPTURE only when ALL THREE of the exact column-missing message on `agent_jobs.title`,
// a SELECT-lookup shape on `agent_jobs` (bare OR PostgREST CTE wrapper), AND a
// `spec_slug` mention in the same query are present. A column-missing on any other
// table, a different column on `agent_jobs`, a JOIN through `approval_decisions`, a bare
// `select title from agent_jobs` without `spec_slug`, or a non-SELECT statement still
// pages.

test("isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise drops the ad hoc SELECT lookup on the exact agent_jobs.title column-missing shape", () => {
  // The captured production sample: unqualified and public.-qualified variants, the
  // caller always asks for BOTH title and the real spec_slug column.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.title does not exist",
      "select title, spec_slug from public.agent_jobs order by created_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column public.agent_jobs.title does not exist",
      "select title, spec_slug from public.agent_jobs order by created_at desc limit 100",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.title does not exist",
      "select title, spec_slug from agent_jobs limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.title does not exist",
      "select id, title, spec_slug from public.agent_jobs where workspace_id = $1 order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.title does not exist",
      "SELECT TITLE, SPEC_SLUG FROM PUBLIC.AGENT_JOBS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "ERROR: column agent_jobs.title does not exist",
      "select title, spec_slug from public.agent_jobs",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "  column agent_jobs.title does not exist  ",
      "   select title, spec_slug from public.agent_jobs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"agent_jobs\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."agent_jobs"` identifiers. The plain
  // bare-SELECT regex misses this because the statement starts with `with` and the FROM
  // clause carries the quoted schema.table shape.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.title does not exist",
      'WITH pgrst_source AS ( SELECT "public"."agent_jobs"."id", "public"."agent_jobs"."title", "public"."agent_jobs"."spec_slug" FROM "public"."agent_jobs" WHERE "public"."agent_jobs"."workspace_id" = $1 ORDER BY "public"."agent_jobs"."created_at" DESC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column public.agent_jobs.title does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."title", "public"."agent_jobs"."spec_slug" FROM "public"."agent_jobs")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "ERROR: column agent_jobs.title does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."title", "public"."agent_jobs"."spec_slug" FROM "public"."agent_jobs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a title column still pages)", () => {
  // `specs.title` and `playbooks.title` are real columns — a schema regression there
  // would be a genuine bug we want to see.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column specs.title does not exist",
      "select title, spec_slug from public.specs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column playbooks.title does not exist",
      "select title, spec_slug from public.playbooks where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise KEEPS a DIFFERENT column-missing on agent_jobs (a real column rename still pages)", () => {
  // Real agent_jobs columns — if any of these regress we absolutely want the page.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.status does not exist",
      "select status, spec_slug from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.kind does not exist",
      "select kind, spec_slug from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.spec_slug does not exist",
      "select spec_slug from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.workspace_id does not exist",
      "select workspace_id, spec_slug from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.payload does not exist",
      "select payload, spec_slug from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "select branch_name, spec_slug from public.agent_jobs",
    ),
    false,
  );
  // The sibling slug confusion must still page under THIS predicate — this filter is
  // scoped to `title` only; the slug sibling has its own predicate.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.slug does not exist",
      "select slug, spec_slug from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise KEEPS a bare `select title from agent_jobs` without spec_slug (hypothetical real code after a schema regression still pages)", () => {
  // The drop is scoped to the confused-column pairing (`title` + `spec_slug`); a bare
  // read that only asks for `title` could hypothetically be real product code after a
  // schema regression, so it stays paged.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.title does not exist",
      "select title from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.title does not exist",
      "select id, title from agent_jobs limit 10",
    ),
    false,
  );
  // CTE wrapper without spec_slug in the wrapped select is also kept.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.title does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."title" FROM "public"."agent_jobs")',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise KEEPS a JOIN across other tables (a real code shape joining approval_decisions still pages)", () => {
  // The regex is anchored on `from (public.)?agent_jobs` as the first FROM target; a
  // JOIN whose first FROM is `approval_decisions` won't match — which is the outcome
  // we want, because a caller that joins the two and asks for a real column shape is
  // product code, not the ad hoc direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.title does not exist",
      "select a.title, j.spec_slug from public.approval_decisions a join public.agent_jobs j on j.id = a.agent_job_id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise KEEPS a non-SELECT statement shape (a real code-bug writing agent_jobs.title still pages)", () => {
  // INSERT / UPDATE / DELETE against agent_jobs referencing a bogus column is real
  // code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.title does not exist",
      "insert into public.agent_jobs (title, spec_slug) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.title does not exist",
      "update public.agent_jobs set title = $1 where spec_slug = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.title does not exist",
      "delete from public.agent_jobs where title = $1 and spec_slug = $2",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.title does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."agent_jobs"("title", "spec_slug") VALUES ($1, $2) RETURNING "public"."agent_jobs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.title does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."agent_jobs" SET "title" = $1 WHERE "public"."agent_jobs"."spec_slug" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise KEEPS a PostgREST CTE wrapper on a DIFFERENT table (a real schema regression on specs.title still pages)", () => {
  // Same wrapper shape but the wrapped SELECT reads a different table — the pin is
  // `agent_jobs.title` only; any other table's title is a genuine schema regression.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column specs.title does not exist",
      'WITH pgrst_source AS ( SELECT "public"."specs"."title", "public"."specs"."spec_slug" FROM "public"."specs" WHERE "public"."specs"."workspace_id" = $1 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on agent_jobs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "database is shutting down",
      "select title, spec_slug from public.agent_jobs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      'duplicate key value violates unique constraint "agent_jobs_pkey"',
      "select title, spec_slug from public.agent_jobs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "canceling statement due to statement timeout",
      "select title, spec_slug from public.agent_jobs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      'permission denied for relation "public.agent_jobs"',
      "select title, spec_slug from public.agent_jobs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      'relation "public.agent_jobs" does not exist',
      "select title, spec_slug from public.agent_jobs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.title does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(
      "column agent_jobs.title does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/agent_jobs?select=id,status,created_at,kind,payload&kind=eq.*` against our
// `public.agent_jobs` table. The table exists but has NEVER had a `payload` column — the
// row carries `instructions`, `pending_actions`, and `metadata`, and every ShopCX reader
// goes through the agent_jobs SDK which never selects `payload`. Foreign-owned surface,
// no lever from us — drop AT CAPTURE only when ALL THREE of the exact column-missing
// message on `agent_jobs.payload`, a SELECT-lookup shape on `agent_jobs` (bare OR
// PostgREST CTE wrapper), AND a `kind` mention in the same query are present. A
// column-missing on any other table, a different column on `agent_jobs`, a JOIN through
// `approval_decisions`, a bare `select payload from agent_jobs` without `kind`, or a
// non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise drops the ad hoc SELECT lookup on the exact agent_jobs.payload column-missing shape (bare)", () => {
  // The captured production sample: unqualified and public.-qualified variants, the
  // caller always asks for BOTH payload and the real kind column.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      "select id, status, created_at, kind, payload from public.agent_jobs where kind = $1 order by created_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column public.agent_jobs.payload does not exist",
      "select id, status, created_at, kind, payload from public.agent_jobs where kind = $1",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      "select kind, payload from agent_jobs limit 10",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      "SELECT KIND, PAYLOAD FROM PUBLIC.AGENT_JOBS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "ERROR: column agent_jobs.payload does not exist",
      "select kind, payload from public.agent_jobs",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "  column agent_jobs.payload does not exist  ",
      "   select kind, payload from public.agent_jobs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"agent_jobs\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."agent_jobs"` identifiers. The plain
  // bare-SELECT regex misses this because the statement starts with `with` and the FROM
  // clause carries the quoted schema.table shape.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      'WITH pgrst_source AS ( SELECT "public"."agent_jobs"."id", "public"."agent_jobs"."status", "public"."agent_jobs"."created_at", "public"."agent_jobs"."kind", "public"."agent_jobs"."payload" FROM "public"."agent_jobs" WHERE "public"."agent_jobs"."kind" = $1 ORDER BY "public"."agent_jobs"."created_at" DESC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column public.agent_jobs.payload does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."kind", "public"."agent_jobs"."payload" FROM "public"."agent_jobs")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "ERROR: column agent_jobs.payload does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."kind", "public"."agent_jobs"."payload" FROM "public"."agent_jobs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise KEEPS a non-SELECT statement shape (a real code-bug writing agent_jobs.payload still pages)", () => {
  // INSERT / UPDATE / DELETE against agent_jobs referencing a bogus column is real code
  // trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      "insert into public.agent_jobs (kind, payload) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      "update public.agent_jobs set payload = $1 where kind = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      "delete from public.agent_jobs where payload = $1 and kind = $2",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."agent_jobs"("kind", "payload") VALUES ($1, $2) RETURNING "public"."agent_jobs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."agent_jobs" SET "payload" = $1 WHERE "public"."agent_jobs"."kind" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise KEEPS a DIFFERENT column-missing on agent_jobs (a real column rename still pages)", () => {
  // Real agent_jobs columns and sibling-covered confusions — if any of these regress we
  // absolutely want the page.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.title does not exist",
      "select title, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.slug does not exist",
      "select slug, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "select branch_name, kind from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.status does not exist",
      "select status, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise KEEPS a column-missing error on any OTHER table (a real schema regression on a different table still pages)", () => {
  // `specs.payload` / `playbooks.payload` as a schema regression on a different table
  // would be a genuine bug we want to see — even if the SELECT list happens to carry
  // the `payload` column alongside `kind`.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column specs.payload does not exist",
      "select kind, payload from public.specs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column playbooks.payload does not exist",
      "select kind, payload from public.playbooks where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise KEEPS a bare SELECT on agent_jobs.payload without the `kind` co-mention (hypothetical real code after a schema regression still pages)", () => {
  // The drop is scoped to the confused-column pairing (`payload` + `kind`); a bare
  // read that only asks for `payload` could hypothetically be real product code after a
  // schema regression, so it stays paged.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      "select payload from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      "select id, payload from agent_jobs limit 10",
    ),
    false,
  );
  // CTE wrapper without `kind` in the wrapped select is also kept.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."payload" FROM "public"."agent_jobs")',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsPayloadDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise ──
// Sibling of the `agent_jobs.payload` drop above — a foreign / stale PostgREST
// direct-REST client reads
// `/rest/v1/agent_jobs?select=id,status,created_at,kind,result&kind=eq.*` against our
// `public.agent_jobs` table. The table exists but has NEVER had a `result` column —
// the row carries `instructions`, `pending_actions`, and `metadata`, and every ShopCX
// reader goes through the agent_jobs SDK which never selects `result`. Foreign-owned
// surface, no lever from us — drop AT CAPTURE only when ALL THREE of the exact
// column-missing message on `agent_jobs.result`, a SELECT-lookup shape on `agent_jobs`
// (bare OR PostgREST CTE wrapper), AND a `kind` mention in the same query are present.
// A column-missing on any other table, a different column on `agent_jobs`, a JOIN
// through `approval_decisions`, a bare `select result from agent_jobs` without `kind`,
// or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise drops the ad hoc SELECT lookup on the exact agent_jobs.result column-missing shape (bare)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      "select id, status, created_at, kind, result from public.agent_jobs where kind = $1 order by created_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column public.agent_jobs.result does not exist",
      "select id, status, created_at, kind, result from public.agent_jobs where kind = $1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      "select kind, result from agent_jobs limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      "SELECT KIND, RESULT FROM PUBLIC.AGENT_JOBS",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "ERROR: column agent_jobs.result does not exist",
      "select kind, result from public.agent_jobs",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "  column agent_jobs.result does not exist  ",
      "   select kind, result from public.agent_jobs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"agent_jobs\" ...)` CTE wrapper form", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      'WITH pgrst_source AS ( SELECT "public"."agent_jobs"."id", "public"."agent_jobs"."status", "public"."agent_jobs"."created_at", "public"."agent_jobs"."kind", "public"."agent_jobs"."result" FROM "public"."agent_jobs" WHERE "public"."agent_jobs"."kind" = $1 ORDER BY "public"."agent_jobs"."created_at" DESC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column public.agent_jobs.result does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."kind", "public"."agent_jobs"."result" FROM "public"."agent_jobs")',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "ERROR: column agent_jobs.result does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."kind", "public"."agent_jobs"."result" FROM "public"."agent_jobs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise KEEPS a non-SELECT statement shape (a real code-bug writing agent_jobs.result still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      "insert into public.agent_jobs (kind, result) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      "update public.agent_jobs set result = $1 where kind = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      "delete from public.agent_jobs where result = $1 and kind = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."agent_jobs"("kind", "result") VALUES ($1, $2) RETURNING "public"."agent_jobs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."agent_jobs" SET "result" = $1 WHERE "public"."agent_jobs"."kind" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise KEEPS a DIFFERENT column-missing on agent_jobs (a real column rename still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.title does not exist",
      "select title, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      "select payload, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.slug does not exist",
      "select slug, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "select branch_name, kind from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.status does not exist",
      "select status, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise KEEPS a column-missing error on any OTHER table (a real schema regression on a different table still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column specs.result does not exist",
      "select kind, result from public.specs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column playbooks.result does not exist",
      "select kind, result from public.playbooks where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise KEEPS a bare SELECT on agent_jobs.result without the `kind` co-mention (hypothetical real code after a schema regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      "select result from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      "select id, result from agent_jobs limit 10",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."result" FROM "public"."agent_jobs")',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise("", ""),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsResultDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise ──
// Sibling of the `agent_jobs.result` drop above — a foreign / stale PostgREST
// direct-REST client confuses the short name `config_dir` with the real
// `claude_session_config_dir` column on our `public.agent_jobs` table. The table exists
// but has NEVER had a `config_dir` column — the row carries `claude_session_config_dir`
// (see `supabase/migrations/20260622210000_agent_jobs_session_config_dir.sql`), and
// every ShopCX reader goes through the agent_jobs SDK which never selects
// `config_dir`. Foreign-owned surface, no lever from us — drop AT CAPTURE only when
// ALL THREE of the exact column-missing message on `agent_jobs.config_dir`, a
// SELECT-lookup shape on `agent_jobs` (bare OR PostgREST CTE wrapper), AND a
// `claude_session_config_dir` mention in the same query are present. A column-missing
// on any other table (e.g. `agent_job_costs.config_dir`), a different column on
// `agent_jobs`, a JOIN through `approval_decisions` / `agent_job_costs`, a bare
// `select config_dir from agent_jobs` without `claude_session_config_dir`, or a
// non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise drops the ad hoc SELECT lookup on the exact agent_jobs.config_dir column-missing shape (bare)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.config_dir does not exist",
      "select id, status, created_at, kind, config_dir, claude_session_config_dir from public.agent_jobs where kind = $1 order by created_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column public.agent_jobs.config_dir does not exist",
      "select config_dir, claude_session_config_dir from public.agent_jobs where kind = $1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.config_dir does not exist",
      "select config_dir, claude_session_config_dir from agent_jobs limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.config_dir does not exist",
      "SELECT CONFIG_DIR, CLAUDE_SESSION_CONFIG_DIR FROM PUBLIC.AGENT_JOBS",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "ERROR: column agent_jobs.config_dir does not exist",
      "select config_dir, claude_session_config_dir from public.agent_jobs",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "  column agent_jobs.config_dir does not exist  ",
      "   select config_dir, claude_session_config_dir from public.agent_jobs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"agent_jobs\" ...)` CTE wrapper form", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.config_dir does not exist",
      'WITH pgrst_source AS ( SELECT "public"."agent_jobs"."id", "public"."agent_jobs"."status", "public"."agent_jobs"."created_at", "public"."agent_jobs"."kind", "public"."agent_jobs"."config_dir", "public"."agent_jobs"."claude_session_config_dir" FROM "public"."agent_jobs" WHERE "public"."agent_jobs"."kind" = $1 ORDER BY "public"."agent_jobs"."created_at" DESC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column public.agent_jobs.config_dir does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."config_dir", "public"."agent_jobs"."claude_session_config_dir" FROM "public"."agent_jobs")',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "ERROR: column agent_jobs.config_dir does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."config_dir", "public"."agent_jobs"."claude_session_config_dir" FROM "public"."agent_jobs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise KEEPS a non-SELECT statement shape (a real code-bug writing agent_jobs.config_dir still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.config_dir does not exist",
      "insert into public.agent_jobs (kind, config_dir, claude_session_config_dir) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.config_dir does not exist",
      "update public.agent_jobs set config_dir = $1 where claude_session_config_dir = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.config_dir does not exist",
      "delete from public.agent_jobs where config_dir = $1 and claude_session_config_dir = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.config_dir does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."agent_jobs"("kind", "config_dir", "claude_session_config_dir") VALUES ($1, $2, $3) RETURNING "public"."agent_jobs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.config_dir does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."agent_jobs" SET "config_dir" = $1 WHERE "public"."agent_jobs"."claude_session_config_dir" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise KEEPS a DIFFERENT column-missing on agent_jobs (a real column rename still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.title does not exist",
      "select title, claude_session_config_dir from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.kind does not exist",
      "select kind, claude_session_config_dir from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.spec_slug does not exist",
      "select spec_slug, claude_session_config_dir from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.workspace_id does not exist",
      "select workspace_id, claude_session_config_dir from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.status does not exist",
      "select status, claude_session_config_dir from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.claude_session_id does not exist",
      "select claude_session_id, claude_session_config_dir from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.claude_session_config_dir does not exist",
      "select claude_session_config_dir from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise KEEPS a column-missing error on any OTHER table (a real schema regression on a different table still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_job_costs.config_dir does not exist",
      "select config_dir, claude_session_config_dir from public.agent_job_costs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column specs.config_dir does not exist",
      "select config_dir, claude_session_config_dir from public.specs where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise KEEPS a bare SELECT on agent_jobs.config_dir without the `claude_session_config_dir` co-mention (hypothetical real code after a schema regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.config_dir does not exist",
      "select config_dir from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.config_dir does not exist",
      "select id, config_dir from agent_jobs limit 10",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.config_dir does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."config_dir" FROM "public"."agent_jobs")',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise KEEPS a JOIN across other tables (a real code shape joining approval_decisions / agent_job_costs still pages)", () => {
  // The regex is anchored on `from (public.)?agent_jobs` as the first FROM target; a
  // JOIN whose first FROM is `approval_decisions` / `agent_job_costs` won't match —
  // which is the outcome we want, because a caller that joins the two and asks for a
  // real column shape is product code, not the ad hoc direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.config_dir does not exist",
      "select a.config_dir, j.claude_session_config_dir from public.approval_decisions a join public.agent_jobs j on j.id = a.agent_job_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.config_dir does not exist",
      "select c.config_dir, j.claude_session_config_dir from public.agent_job_costs c join public.agent_jobs j on j.id = c.job_id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on agent_jobs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "FATAL: database system is shutting down",
      "select config_dir, claude_session_config_dir from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "permission denied for table agent_jobs",
      "select config_dir, claude_session_config_dir from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "relation \"agent_jobs\" does not exist",
      "select config_dir, claude_session_config_dir from public.agent_jobs",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise("", ""),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.config_dir does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsConfigDirDirectRestLookupNoise(
      "column agent_jobs.config_dir does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise ──
// Sibling of the `agent_jobs.result` / `agent_jobs.payload` drops above — a foreign /
// stale PostgREST direct-REST client confuses the GitHub-world `merge_sha` with a
// column on our `public.agent_jobs` table. The table exists but has NEVER had a
// `merge_sha` column — merge-SHA ship provenance lives on `spec_phases.merge_sha` (see
// `supabase/migrations/20260726120001_spec_phases_build_sha.sql`), and every ShopCX
// reader goes through the agent_jobs SDK which never selects `merge_sha`. Foreign-
// owned surface, no lever from us — drop AT CAPTURE only when ALL THREE of the exact
// column-missing message on `agent_jobs.merge_sha`, a SELECT-lookup shape on
// `agent_jobs` (bare OR PostgREST CTE wrapper), AND a `kind` mention in the same query
// are present. A column-missing on any other table (e.g. `spec_phases.merge_sha` after
// a real regression), a different column on `agent_jobs`, a JOIN through
// `approval_decisions` / `agent_job_costs` / `spec_phases`, a bare
// `select merge_sha from agent_jobs` without `kind`, or a non-SELECT statement still
// pages.

test("isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise drops the ad hoc SELECT lookup on the exact agent_jobs.merge_sha column-missing shape (bare)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      "select id, status, created_at, kind, merge_sha from public.agent_jobs where kind = $1 order by created_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column public.agent_jobs.merge_sha does not exist",
      "select merge_sha, kind from public.agent_jobs where kind = $1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      "select merge_sha, kind from agent_jobs limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      "SELECT MERGE_SHA, KIND FROM PUBLIC.AGENT_JOBS",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "ERROR: column agent_jobs.merge_sha does not exist",
      "select merge_sha, kind from public.agent_jobs",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "  column agent_jobs.merge_sha does not exist  ",
      "   select merge_sha, kind from public.agent_jobs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"agent_jobs\" ...)` CTE wrapper form", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      'WITH pgrst_source AS ( SELECT "public"."agent_jobs"."id", "public"."agent_jobs"."status", "public"."agent_jobs"."created_at", "public"."agent_jobs"."kind", "public"."agent_jobs"."merge_sha" FROM "public"."agent_jobs" WHERE "public"."agent_jobs"."kind" = $1 ORDER BY "public"."agent_jobs"."created_at" DESC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column public.agent_jobs.merge_sha does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."merge_sha", "public"."agent_jobs"."kind" FROM "public"."agent_jobs")',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "ERROR: column agent_jobs.merge_sha does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."merge_sha", "public"."agent_jobs"."kind" FROM "public"."agent_jobs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise KEEPS a non-SELECT statement shape (a real code-bug writing agent_jobs.merge_sha still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      "insert into public.agent_jobs (kind, merge_sha) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      "update public.agent_jobs set merge_sha = $1 where kind = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      "delete from public.agent_jobs where merge_sha = $1 and kind = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."agent_jobs"("kind", "merge_sha") VALUES ($1, $2) RETURNING "public"."agent_jobs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."agent_jobs" SET "merge_sha" = $1 WHERE "public"."agent_jobs"."kind" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise KEEPS a DIFFERENT column-missing on agent_jobs (a real column rename still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      "select payload, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      "select result, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.title does not exist",
      "select title, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.spec_slug does not exist",
      "select spec_slug, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.workspace_id does not exist",
      "select workspace_id, kind from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.status does not exist",
      "select status, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.kind does not exist",
      "select kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise KEEPS a column-missing error on any OTHER table (a real schema regression on a different table still pages — spec_phases.merge_sha is a real column)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column spec_phases.merge_sha does not exist",
      "select merge_sha, kind from public.spec_phases where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column deploy_watches.merge_sha does not exist",
      "select merge_sha, kind from public.deploy_watches where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column specs.merge_sha does not exist",
      "select merge_sha, kind from public.specs where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise KEEPS a bare SELECT on agent_jobs.merge_sha without the `kind` co-mention (hypothetical real code after a schema regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      "select merge_sha from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      "select id, merge_sha from agent_jobs limit 10",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."merge_sha" FROM "public"."agent_jobs")',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise KEEPS a JOIN across other tables (a real code shape joining approval_decisions / agent_job_costs / spec_phases still pages)", () => {
  // The regex is anchored on `from (public.)?agent_jobs` as the first FROM target; a
  // JOIN whose first FROM is `approval_decisions` / `agent_job_costs` / `spec_phases`
  // won't match — which is the outcome we want, because a caller that joins the two
  // and asks for a real column shape is product code, not the ad hoc direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      "select a.merge_sha, j.kind from public.approval_decisions a join public.agent_jobs j on j.id = a.agent_job_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      "select c.merge_sha, j.kind from public.agent_job_costs c join public.agent_jobs j on j.id = c.job_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      "select p.merge_sha, j.kind from public.spec_phases p join public.agent_jobs j on j.spec_slug = p.spec_slug",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on agent_jobs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "FATAL: database system is shutting down",
      "select merge_sha, kind from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "permission denied for table agent_jobs",
      "select merge_sha, kind from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "relation \"agent_jobs\" does not exist",
      "select merge_sha, kind from public.agent_jobs",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise("", ""),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsMergeShaDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise ──
// Sibling of the `agent_jobs.merge_sha` / `agent_jobs.result` / `agent_jobs.payload`
// drops above — a foreign / stale PostgREST direct-REST client confuses a GitHub-world
// `branch_name` with a column on our `public.agent_jobs` table. The table exists but has
// NEVER had a `branch_name` column — build-branch provenance lives on the
// `claude/build-<slug>` branch name derived from the spec slug + the merge SHA stamped
// on `spec_phases.merge_sha`, and every ShopCX reader goes through the agent_jobs SDK
// which never selects `branch_name`. Foreign-owned surface, no lever from us — drop AT
// CAPTURE only when ALL THREE of the exact column-missing message on
// `agent_jobs.branch_name`, a SELECT-lookup shape on `agent_jobs` (bare OR PostgREST
// CTE wrapper), AND a `kind` mention in the same query are present. A column-missing on
// any other table, a different column on `agent_jobs`, a JOIN through
// `approval_decisions` / `agent_job_costs` / `spec_phases`, a bare `select branch_name
// from agent_jobs` without `kind`, or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise drops the ad hoc SELECT lookup on the exact agent_jobs.branch_name column-missing shape (bare)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "select id, status, created_at, kind, branch_name from public.agent_jobs where kind = $1 order by created_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column public.agent_jobs.branch_name does not exist",
      "select branch_name, kind from public.agent_jobs where kind = $1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "select branch_name, kind from agent_jobs limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "SELECT BRANCH_NAME, KIND FROM PUBLIC.AGENT_JOBS",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "ERROR: column agent_jobs.branch_name does not exist",
      "select branch_name, kind from public.agent_jobs",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "  column agent_jobs.branch_name does not exist  ",
      "   select branch_name, kind from public.agent_jobs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"agent_jobs\" ...)` CTE wrapper form", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      'WITH pgrst_source AS ( SELECT "public"."agent_jobs"."id", "public"."agent_jobs"."status", "public"."agent_jobs"."created_at", "public"."agent_jobs"."kind", "public"."agent_jobs"."branch_name" FROM "public"."agent_jobs" WHERE "public"."agent_jobs"."kind" = $1 ORDER BY "public"."agent_jobs"."created_at" DESC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column public.agent_jobs.branch_name does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."branch_name", "public"."agent_jobs"."kind" FROM "public"."agent_jobs")',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "ERROR: column agent_jobs.branch_name does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."branch_name", "public"."agent_jobs"."kind" FROM "public"."agent_jobs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise KEEPS a non-SELECT statement shape (a real code-bug writing agent_jobs.branch_name still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "insert into public.agent_jobs (kind, branch_name) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "update public.agent_jobs set branch_name = $1 where kind = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "delete from public.agent_jobs where branch_name = $1 and kind = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."agent_jobs"("kind", "branch_name") VALUES ($1, $2) RETURNING "public"."agent_jobs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."agent_jobs" SET "branch_name" = $1 WHERE "public"."agent_jobs"."kind" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise KEEPS a DIFFERENT column-missing on agent_jobs (a real column rename still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      "select payload, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      "select result, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      "select merge_sha, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.spec_slug does not exist",
      "select spec_slug, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.workspace_id does not exist",
      "select workspace_id, kind from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.status does not exist",
      "select status, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.kind does not exist",
      "select kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise KEEPS a column-missing error on any OTHER table (a real schema regression on a different table that owns branch_name still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column deploy_watches.branch_name does not exist",
      "select branch_name, kind from public.deploy_watches where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column spec_phases.branch_name does not exist",
      "select branch_name, kind from public.spec_phases where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column specs.branch_name does not exist",
      "select branch_name, kind from public.specs where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise KEEPS a bare SELECT on agent_jobs.branch_name without the `kind` co-mention (hypothetical real code after a schema regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "select branch_name from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "select id, branch_name from agent_jobs limit 10",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."branch_name" FROM "public"."agent_jobs")',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise KEEPS a JOIN across other tables (a real code shape joining approval_decisions / agent_job_costs / spec_phases still pages)", () => {
  // The regex is anchored on `from (public.)?agent_jobs` as the first FROM target; a
  // JOIN whose first FROM is `approval_decisions` / `agent_job_costs` / `spec_phases`
  // won't match — which is the outcome we want, because a caller that joins the two
  // and asks for a real column shape is product code, not the ad hoc direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "select a.branch_name, j.kind from public.approval_decisions a join public.agent_jobs j on j.id = a.agent_job_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "select c.branch_name, j.kind from public.agent_job_costs c join public.agent_jobs j on j.id = c.job_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "select p.branch_name, j.kind from public.spec_phases p join public.agent_jobs j on j.spec_slug = p.spec_slug",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on agent_jobs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "FATAL: database system is shutting down",
      "select branch_name, kind from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "permission denied for table agent_jobs",
      "select branch_name, kind from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "relation \"agent_jobs\" does not exist",
      "select branch_name, kind from public.agent_jobs",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise("", ""),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchNameDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise ──
// Sibling of the `agent_jobs.branch_name` / `agent_jobs.merge_sha` drops above — a
// foreign / stale PostgREST direct-REST client confuses the bare `branch` name with a
// column on our `public.agent_jobs` table. The table exists but has NEVER had a `branch`
// column — build-branch provenance lives on `agent_jobs.spec_branch` (and the derived
// `claude/build-<slug>` branch name computed from the spec slug), and every ShopCX
// reader goes through the agent_jobs SDK which never selects a bare `branch`. Foreign-
// owned surface, no lever from us — drop AT CAPTURE only when ALL THREE of the exact
// column-missing message on `agent_jobs.branch`, a SELECT-lookup shape on `agent_jobs`
// (bare OR PostgREST CTE wrapper), AND a `kind` mention in the same query are present.
// A column-missing on any other table, a different column on `agent_jobs`, a JOIN
// through `approval_decisions` / `agent_job_costs` / `spec_phases`, a bare `select
// branch from agent_jobs` without `kind`, or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise drops the ad hoc SELECT lookup on the exact agent_jobs.branch column-missing shape (bare)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      "select id, status, created_at, kind, branch from public.agent_jobs where kind = $1 order by created_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column public.agent_jobs.branch does not exist",
      "select branch, kind from public.agent_jobs where kind = $1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      "select branch, kind from agent_jobs limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      "SELECT BRANCH, KIND FROM PUBLIC.AGENT_JOBS",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "ERROR: column agent_jobs.branch does not exist",
      "select branch, kind from public.agent_jobs",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "  column agent_jobs.branch does not exist  ",
      "   select branch, kind from public.agent_jobs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"agent_jobs\" ...)` CTE wrapper form (observed supabase-logs:d22f536dec7344d5 sample)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      'WITH pgrst_source AS ( SELECT "public"."agent_jobs"."id", "public"."agent_jobs"."status", "public"."agent_jobs"."created_at", "public"."agent_jobs"."kind", "public"."agent_jobs"."branch" FROM "public"."agent_jobs" WHERE "public"."agent_jobs"."kind" = $1 ORDER BY "public"."agent_jobs"."created_at" DESC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column public.agent_jobs.branch does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."branch", "public"."agent_jobs"."kind" FROM "public"."agent_jobs")',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "ERROR: column agent_jobs.branch does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."branch", "public"."agent_jobs"."kind" FROM "public"."agent_jobs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise KEEPS a non-SELECT statement shape (a real code-bug writing agent_jobs.branch still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      "insert into public.agent_jobs (kind, branch) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      "update public.agent_jobs set branch = $1 where kind = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      "delete from public.agent_jobs where branch = $1 and kind = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."agent_jobs"("kind", "branch") VALUES ($1, $2) RETURNING "public"."agent_jobs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."agent_jobs" SET "branch" = $1 WHERE "public"."agent_jobs"."kind" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise KEEPS a DIFFERENT column-missing on agent_jobs (a real column rename or sibling drop still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      "select payload, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      "select result, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      "select merge_sha, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "select branch_name, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.spec_branch does not exist",
      "select spec_branch, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.spec_slug does not exist",
      "select spec_slug, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.workspace_id does not exist",
      "select workspace_id, kind from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.status does not exist",
      "select status, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise KEEPS a column-missing error on any OTHER table (a real schema regression on a different table that owns branch still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column deploy_watches.branch does not exist",
      "select branch, kind from public.deploy_watches where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column spec_phases.branch does not exist",
      "select branch, kind from public.spec_phases where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column specs.branch does not exist",
      "select branch, kind from public.specs where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise KEEPS a bare SELECT on agent_jobs.branch without the `kind` co-mention (hypothetical real code after a schema regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      "select branch from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      "select id, branch from agent_jobs limit 10",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."branch" FROM "public"."agent_jobs")',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise KEEPS a JOIN across other tables (a real code shape joining approval_decisions / agent_job_costs / spec_phases still pages)", () => {
  // The regex is anchored on `from (public.)?agent_jobs` as the first FROM target; a
  // JOIN whose first FROM is `approval_decisions` / `agent_job_costs` / `spec_phases`
  // won't match — which is the outcome we want, because a caller that joins the two and
  // asks for a real column shape is product code, not the ad hoc direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      "select a.branch, j.kind from public.approval_decisions a join public.agent_jobs j on j.id = a.agent_job_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      "select c.branch, j.kind from public.agent_job_costs c join public.agent_jobs j on j.id = c.job_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      "select p.branch, j.kind from public.spec_phases p join public.agent_jobs j on j.spec_slug = p.spec_slug",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on agent_jobs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "FATAL: database system is shutting down",
      "select branch, kind from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "permission denied for table agent_jobs",
      "select branch, kind from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "relation \"agent_jobs\" does not exist",
      "select branch, kind from public.agent_jobs",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise("", ""),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsBranchDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise ──
// Sibling of the `agent_jobs.branch` / `agent_jobs.branch_name` / `agent_jobs.merge_sha`
// drops above — a foreign / stale PostgREST direct-REST client confuses the bare
// `target` name with a column on our `public.agent_jobs` table. The table exists but
// has NEVER had a `target` column — the "agent_jobs target" phrasing in some docs
// describes the row itself conceptually (the row IS the target), and every ShopCX
// reader goes through the agent_jobs SDK which never selects a bare `target`. Foreign-
// owned surface, no lever from us — drop AT CAPTURE only when ALL THREE of the exact
// column-missing message on `agent_jobs.target`, a SELECT-lookup shape on `agent_jobs`
// (bare OR PostgREST CTE wrapper), AND a `kind` mention in the same query are present.
// A column-missing on any other table, a different column on `agent_jobs`, a JOIN
// through `approval_decisions` / `agent_job_costs` / `spec_phases`, a bare `select
// target from agent_jobs` without `kind`, or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise drops the ad hoc SELECT lookup on the exact agent_jobs.target column-missing shape (bare)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      "select id, status, created_at, kind, target from public.agent_jobs where kind = $1 order by created_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column public.agent_jobs.target does not exist",
      "select target, kind from public.agent_jobs where kind = $1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      "select target, kind from agent_jobs limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      "SELECT TARGET, KIND FROM PUBLIC.AGENT_JOBS",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "ERROR: column agent_jobs.target does not exist",
      "select target, kind from public.agent_jobs",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "  column agent_jobs.target does not exist  ",
      "   select target, kind from public.agent_jobs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"agent_jobs\" ...)` CTE wrapper form (observed supabase-logs:9f1e15d094ad4200 sample)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      'WITH pgrst_source AS ( SELECT "public"."agent_jobs"."id", "public"."agent_jobs"."status", "public"."agent_jobs"."created_at", "public"."agent_jobs"."kind", "public"."agent_jobs"."target" FROM "public"."agent_jobs" WHERE "public"."agent_jobs"."kind" = $1 ORDER BY "public"."agent_jobs"."created_at" DESC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column public.agent_jobs.target does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."target", "public"."agent_jobs"."kind" FROM "public"."agent_jobs")',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "ERROR: column agent_jobs.target does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."target", "public"."agent_jobs"."kind" FROM "public"."agent_jobs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise KEEPS a non-SELECT statement shape (a real code-bug writing agent_jobs.target still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      "insert into public.agent_jobs (kind, target) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      "update public.agent_jobs set target = $1 where kind = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      "delete from public.agent_jobs where target = $1 and kind = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."agent_jobs"("kind", "target") VALUES ($1, $2) RETURNING "public"."agent_jobs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."agent_jobs" SET "target" = $1 WHERE "public"."agent_jobs"."kind" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise KEEPS a DIFFERENT column-missing on agent_jobs (a real column rename or sibling drop still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      "select payload, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      "select result, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      "select merge_sha, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      "select branch, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.branch_name does not exist",
      "select branch_name, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.spec_branch does not exist",
      "select spec_branch, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.spec_slug does not exist",
      "select spec_slug, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.workspace_id does not exist",
      "select workspace_id, kind from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.status does not exist",
      "select status, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise KEEPS a column-missing error on any OTHER table (a real schema regression on a different table that owns target still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column deploy_watches.target does not exist",
      "select target, kind from public.deploy_watches where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column mario_thresholds.target does not exist",
      "select target, kind from public.mario_thresholds where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column specs.target does not exist",
      "select target, kind from public.specs where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise KEEPS a bare SELECT on agent_jobs.target without the `kind` co-mention (hypothetical real code after a schema regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      "select target from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      "select id, target from agent_jobs limit 10",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."target" FROM "public"."agent_jobs")',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise KEEPS a JOIN across other tables (a real code shape joining approval_decisions / agent_job_costs / spec_phases still pages)", () => {
  // The regex is anchored on `from (public.)?agent_jobs` as the first FROM target; a
  // JOIN whose first FROM is `approval_decisions` / `agent_job_costs` / `spec_phases`
  // won't match — which is the outcome we want, because a caller that joins the two and
  // asks for a real column shape is product code, not the ad hoc direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      "select a.target, j.kind from public.approval_decisions a join public.agent_jobs j on j.id = a.agent_job_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      "select c.target, j.kind from public.agent_job_costs c join public.agent_jobs j on j.id = c.job_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      "select p.target, j.kind from public.spec_phases p join public.agent_jobs j on j.spec_slug = p.spec_slug",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on agent_jobs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "FATAL: database system is shutting down",
      "select target, kind from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "permission denied for table agent_jobs",
      "select target, kind from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "relation \"agent_jobs\" does not exist",
      "select target, kind from public.agent_jobs",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise("", ""),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTargetDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise ──
// Sibling of the `agent_jobs.target` / `agent_jobs.branch` / `agent_jobs.branch_name` /
// `agent_jobs.merge_sha` drops above — a foreign / stale PostgREST direct-REST client
// reads our `public.agent_jobs` rows as if they were a GitHub-world build-run,
// projecting bogus CI-style `started_at` / `completed_at` run-timestamp columns
// alongside the real `kind` AND a legacy obsolete sibling marker (`branch` or
// `merge_sha`). The `agent_jobs` table exists but has NEVER had `started_at` /
// `completed_at` columns — run timing lives on `created_at` + `updated_at`, and every
// ShopCX reader goes through the agent_jobs SDK which never selects those names.
// Foreign-owned surface, no lever from us — drop AT CAPTURE only when ALL FOUR of
// the exact column-missing message on `agent_jobs.started_at` or
// `agent_jobs.completed_at`, a SELECT-lookup shape on `agent_jobs` (bare OR
// PostgREST CTE wrapper), a `kind` co-mention, AND a legacy sibling projection
// (`branch` or `merge_sha`) are present. A column-missing on any other table, a
// different column on `agent_jobs`, a JOIN through `approval_decisions` /
// `agent_job_costs` / `spec_phases`, a SELECT without the legacy sibling marker, or
// a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise drops the ad hoc SELECT lookup on the exact agent_jobs.started_at column-missing shape (bare, with the legacy branch+kind projection)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      "select id, status, created_at, kind, branch, started_at from public.agent_jobs where kind = $1 order by created_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column public.agent_jobs.started_at does not exist",
      "select started_at, kind, merge_sha from public.agent_jobs where kind = $1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      "select started_at, kind, branch from agent_jobs limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      "SELECT STARTED_AT, KIND, MERGE_SHA FROM PUBLIC.AGENT_JOBS",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "ERROR: column agent_jobs.started_at does not exist",
      "select started_at, kind, branch from public.agent_jobs",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "  column agent_jobs.started_at does not exist  ",
      "   select started_at, kind, merge_sha from public.agent_jobs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise ALSO drops the exact agent_jobs.completed_at column-missing shape (same gating, different confused column)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.completed_at does not exist",
      "select id, status, created_at, kind, branch, completed_at from public.agent_jobs where kind = $1 order by created_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column public.agent_jobs.completed_at does not exist",
      "select completed_at, kind, merge_sha from public.agent_jobs where kind = $1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "ERROR: column agent_jobs.completed_at does not exist",
      "select completed_at, kind, branch from public.agent_jobs",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"agent_jobs\" ...)` CTE wrapper form (observed supabase-logs:06728c8285287a40 sample)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."agent_jobs"."id", "public"."agent_jobs"."status", "public"."agent_jobs"."created_at", "public"."agent_jobs"."kind", "public"."agent_jobs"."branch", "public"."agent_jobs"."merge_sha", "public"."agent_jobs"."started_at", "public"."agent_jobs"."completed_at" FROM "public"."agent_jobs" WHERE "public"."agent_jobs"."kind" = $1 ORDER BY "public"."agent_jobs"."created_at" DESC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column public.agent_jobs.started_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."started_at", "public"."agent_jobs"."kind", "public"."agent_jobs"."branch" FROM "public"."agent_jobs")',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.completed_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."completed_at", "public"."agent_jobs"."kind", "public"."agent_jobs"."merge_sha" FROM "public"."agent_jobs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise ALSO drops the account_id projection variant of the foreign browse-rows read (observed supabase-logs:06728c8285287a40 account_id sample)", () => {
  // The real-world signature: the same foreign browse-rows PostgREST CTE read, but the
  // legacy sibling projection is `account_id` (not branch/merge_sha) alongside
  // `updated_at` — still a column `agent_jobs` has never owned. Widening the
  // sibling-projection guard to recognize account_id drops this variant at capture.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."agent_jobs"."id", "public"."agent_jobs"."kind", "public"."agent_jobs"."status", "public"."agent_jobs"."created_at", "public"."agent_jobs"."started_at", "public"."agent_jobs"."updated_at", "public"."agent_jobs"."account_id" FROM "public"."agent_jobs" WHERE "public"."agent_jobs"."kind" = $1 ORDER BY "public"."agent_jobs"."created_at" DESC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      "select id, kind, status, created_at, started_at, updated_at, account_id from public.agent_jobs where kind = $1 order by created_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.completed_at does not exist",
      "select completed_at, kind, account_id from agent_jobs limit 10",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise KEEPS a non-SELECT INSERT/UPDATE writing agent_jobs.started_at even with the account_id sibling (a real code-write bug still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      "insert into public.agent_jobs (kind, account_id, started_at) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      "update public.agent_jobs set started_at = $1 where kind = $2 and account_id = $3",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise KEEPS a non-SELECT statement shape (a real code-bug writing agent_jobs.started_at still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      "insert into public.agent_jobs (kind, branch, started_at) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      "update public.agent_jobs set started_at = $1 where kind = $2 and branch = $3",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.completed_at does not exist",
      "delete from public.agent_jobs where completed_at < $1 and kind = $2 and branch = $3",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."agent_jobs"("kind", "branch", "started_at") VALUES ($1, $2, $3) RETURNING "public"."agent_jobs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."agent_jobs" SET "started_at" = $1 WHERE "public"."agent_jobs"."kind" = $2 AND "public"."agent_jobs"."branch" = $3 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise KEEPS a DIFFERENT column-missing on agent_jobs (a real column rename or sibling drop still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.payload does not exist",
      "select payload, kind, branch from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.result does not exist",
      "select result, kind, branch from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.merge_sha does not exist",
      "select merge_sha, kind, branch from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.branch does not exist",
      "select branch, kind, merge_sha from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.target does not exist",
      "select target, kind, branch from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.created_at does not exist",
      "select created_at, kind, branch from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.updated_at does not exist",
      "select updated_at, kind, branch from public.agent_jobs",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise KEEPS a column-missing error on any OTHER table (a real schema regression on a different table that owns started_at / completed_at still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column deploy_watches.started_at does not exist",
      "select started_at, kind, branch from public.deploy_watches where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column spec_phases.completed_at does not exist",
      "select completed_at, kind, merge_sha from public.spec_phases where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_job_costs.started_at does not exist",
      "select started_at, kind, branch from public.agent_job_costs where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise KEEPS a SELECT on agent_jobs.started_at / completed_at without the `kind` co-mention (hypothetical real code after a schema regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      "select started_at, branch from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.completed_at does not exist",
      "select id, completed_at, merge_sha from agent_jobs limit 10",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."started_at", "public"."agent_jobs"."branch" FROM "public"."agent_jobs")',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise KEEPS a SELECT on agent_jobs.started_at / completed_at that lacks a legacy sibling projection marker (branch or merge_sha) — the drop is scoped to the specific legacy-projection fingerprint", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      "select started_at, kind from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.completed_at does not exist",
      "select id, kind, completed_at, status from public.agent_jobs limit 10",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."started_at", "public"."agent_jobs"."kind" FROM "public"."agent_jobs")',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise KEEPS a JOIN across other tables (a real code shape joining approval_decisions / agent_job_costs / spec_phases still pages)", () => {
  // The regex is anchored on `from (public.)?agent_jobs` as the first FROM target; a
  // JOIN whose first FROM is `approval_decisions` / `agent_job_costs` / `spec_phases`
  // won't match — which is the outcome we want, because a caller that joins the two and
  // asks for a real column shape is product code, not the ad hoc direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      "select a.started_at, j.kind, j.branch from public.approval_decisions a join public.agent_jobs j on j.id = a.agent_job_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.completed_at does not exist",
      "select c.completed_at, j.kind, j.merge_sha from public.agent_job_costs c join public.agent_jobs j on j.id = c.job_id",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      "select p.started_at, j.kind, j.branch from public.spec_phases p join public.agent_jobs j on j.spec_slug = p.spec_slug",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on agent_jobs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "FATAL: database system is shutting down",
      "select started_at, kind, branch from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "permission denied for table agent_jobs",
      "select completed_at, kind, merge_sha from public.agent_jobs",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "relation \"agent_jobs\" does not exist",
      "select started_at, kind, branch from public.agent_jobs",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise("", ""),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsRunTimestampDirectRestLookupNoise(
      "column agent_jobs.started_at does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/agent_jobs?select=...terminal_reason,log_tail...` against our
// `public.agent_jobs` table. The table exists but has NEVER had a `terminal_reason`
// column — the string only appears parsed out of `log_tail` JSON via regex.
// Foreign-owned surface, no lever from us — drop AT CAPTURE only when ALL THREE of the
// exact column-missing message on `agent_jobs.terminal_reason`, a SELECT-lookup shape
// on `agent_jobs` (bare OR PostgREST CTE wrapper), AND a `log_tail` mention in the
// same query are present. A column-missing on any other table, a different column on
// `agent_jobs`, a JOIN through `approval_decisions`, a bare
// `select terminal_reason from agent_jobs` without `log_tail`, or a non-SELECT
// statement still pages.

test("isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise drops the ad hoc SELECT lookup on the exact agent_jobs.terminal_reason column-missing shape", () => {
  // The captured production sample: unqualified and public.-qualified variants, the
  // caller always asks for BOTH terminal_reason and the real log_tail column.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(
      "column agent_jobs.terminal_reason does not exist",
      "select id, kind, terminal_reason, log_tail from public.agent_jobs where id like 'x%' and kind = 'build-spec' order by created_at desc limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(
      "column public.agent_jobs.terminal_reason does not exist",
      "select id, kind, terminal_reason, log_tail from public.agent_jobs where id like 'x%' and kind = 'build-spec' order by created_at desc limit 100",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(
      "column agent_jobs.terminal_reason does not exist",
      "select terminal_reason, log_tail from agent_jobs limit 10",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(
      "column agent_jobs.terminal_reason does not exist",
      "SELECT TERMINAL_REASON, LOG_TAIL FROM PUBLIC.AGENT_JOBS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(
      "ERROR: column agent_jobs.terminal_reason does not exist",
      "select terminal_reason, log_tail from public.agent_jobs",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"agent_jobs\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."agent_jobs"` identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(
      "column agent_jobs.terminal_reason does not exist",
      'WITH pgrst_source AS ( SELECT "public"."agent_jobs"."id", "public"."agent_jobs"."terminal_reason", "public"."agent_jobs"."log_tail" FROM "public"."agent_jobs" WHERE "public"."agent_jobs"."kind" = $1 ORDER BY "public"."agent_jobs"."created_at" DESC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(
      "column public.agent_jobs.terminal_reason does not exist",
      'WITH pgrst_source AS (SELECT "public"."agent_jobs"."terminal_reason", "public"."agent_jobs"."log_tail" FROM "public"."agent_jobs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise KEEPS a DIFFERENT column-missing on agent_jobs (a real column rename still pages)", () => {
  // Real agent_jobs columns — if any of these regress we absolutely want the page.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(
      "column agent_jobs.foo does not exist",
      "select foo, log_tail from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(
      "column agent_jobs.status does not exist",
      "select status, log_tail from public.agent_jobs",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise KEEPS a column-missing error on any OTHER table (the pin is agent_jobs only)", () => {
  // `specs.terminal_reason` is a different-table miss — a hypothetical regression on
  // another table that owns the column stays paged.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(
      "column specs.terminal_reason does not exist",
      "select terminal_reason, log_tail from public.specs where workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise KEEPS a bare SELECT without the log_tail co-mention (hypothetical real code after a schema regression still pages)", () => {
  // The drop is scoped to the confused-column pairing (`terminal_reason` + `log_tail`);
  // a bare read that only asks for `terminal_reason` could hypothetically be real
  // product code after a schema regression, so it stays paged.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(
      "column agent_jobs.terminal_reason does not exist",
      "select terminal_reason from public.agent_jobs where workspace_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(
      "column agent_jobs.terminal_reason does not exist",
      "select id, terminal_reason from agent_jobs limit 10",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing agent_jobs.terminal_reason still pages)", () => {
  // INSERT / UPDATE / DELETE against agent_jobs referencing a bogus column is real
  // code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(
      "column agent_jobs.terminal_reason does not exist",
      "insert into public.agent_jobs (terminal_reason, log_tail) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(
      "column agent_jobs.terminal_reason does not exist",
      "update public.agent_jobs set terminal_reason = $1 where log_tail is not null",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(
      "column agent_jobs.terminal_reason does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingAgentJobsTerminalReasonAdhocNoise(
      "column agent_jobs.terminal_reason does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/workspaces?select=id,name,slug` against our `public.workspaces` table. The
// table exists but by design carries NO `slug` column — the workspace slug shape lives
// on `workspaces.help_slug` (the public mini-site slug). Foreign-owned surface, no
// lever from us — drop AT CAPTURE only when BOTH the exact column-missing message on
// `workspaces.slug` AND a SELECT-lookup shape on `workspaces` (bare OR PostgREST CTE
// wrapper) are present. A column-missing on any other table, a different column on
// `workspaces` (including the real `help_slug`), or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise drops the captured supabase-logs:b64f0e4a2576752f message+query pair (the ad hoc SELECT lookup on the exact workspaces.slug column-missing shape)", () => {
  // The captured production sample: unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column workspaces.slug does not exist",
      "select id, name, slug from public.workspaces",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column public.workspaces.slug does not exist",
      "select id, name, slug from public.workspaces",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column workspaces.slug does not exist",
      "select slug from workspaces limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column workspaces.slug does not exist",
      "select id, name, slug from public.workspaces where slug = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column workspaces.slug does not exist",
      "SELECT ID, NAME, SLUG FROM PUBLIC.WORKSPACES",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "ERROR: column workspaces.slug does not exist",
      "select slug from public.workspaces",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "  column workspaces.slug does not exist  ",
      "   select slug from public.workspaces   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"workspaces\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in
  // the pgrst_source CTE with double-quoted `"public"."workspaces"` identifiers. The
  // plain bare-SELECT regex misses this because the statement starts with `with` and
  // the FROM clause carries the quoted schema.table shape.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column workspaces.slug does not exist",
      'WITH pgrst_source AS ( SELECT "public"."workspaces"."id", "public"."workspaces"."name", "public"."workspaces"."slug" FROM "public"."workspaces" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column public.workspaces.slug does not exist",
      'WITH pgrst_source AS (SELECT "public"."workspaces"."slug" FROM "public"."workspaces")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "ERROR: column workspaces.slug does not exist",
      'WITH pgrst_source AS (SELECT "public"."workspaces"."slug" FROM "public"."workspaces")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise KEEPS a column-missing on `workspaces.help_slug` (a DIFFERENT column on the same table — the real column rename still pages)", () => {
  // `workspaces.help_slug` IS a real column (the public mini-site slug); if it ever
  // regresses we absolutely want the page. The pin is `workspaces.slug` only.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column workspaces.help_slug does not exist",
      "select id, name, help_slug from public.workspaces",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column public.workspaces.help_slug does not exist",
      "select help_slug from public.workspaces",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a slug column still pages)", () => {
  // If any other table's `slug` column regressed, we absolutely want the page — the
  // pin is `workspaces.slug` only.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column specs.slug does not exist",
      "select slug from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column goals.slug does not exist",
      "select slug from public.goals where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise KEEPS a non-SELECT statement shape on workspaces (an INSERT/UPDATE/DELETE on workspaces with the same message is a real code-bug and still pages)", () => {
  // INSERT / UPDATE / DELETE against workspaces referencing a bogus `slug` column is
  // real code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column workspaces.slug does not exist",
      "insert into public.workspaces (id, name, slug) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column workspaces.slug does not exist",
      "update public.workspaces set slug = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column workspaces.slug does not exist",
      "delete from public.workspaces where slug is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column workspaces.slug does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."workspaces"("name", "slug") VALUES ($1, $2) RETURNING "public"."workspaces"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column workspaces.slug does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."workspaces" SET "slug" = $1 WHERE "public"."workspaces"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column workspaces.slug does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(
      "column workspaces.slug does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/director_activity?select=id,kind,created_at` against our
// `public.director_activity` table. The table exists but by design carries NO `kind`
// column — no ShopCX reader selects it. Foreign-owned surface, no lever from us — drop
// AT CAPTURE only when BOTH the exact column-missing message on `director_activity.kind`
// AND a SELECT-lookup shape on `director_activity` (bare OR PostgREST CTE wrapper) are
// present. A column-missing on any other table, a different column on
// `director_activity`, or a non-SELECT statement still pages. Control Tower signature
// `supabase-logs:1f0ce6d7290bc2ee`.

test("isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise drops the foreign direct-REST SELECT lookup on the exact director_activity.kind column-missing shape", () => {
  // The captured production sample: unqualified and public.-qualified message variants.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(
      "column director_activity.kind does not exist",
      "select id, kind, created_at from public.director_activity",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(
      "column public.director_activity.kind does not exist",
      "select id, kind, created_at from public.director_activity",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(
      "column director_activity.kind does not exist",
      "select kind from director_activity limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(
      "column director_activity.kind does not exist",
      "select id, kind from public.director_activity where kind = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(
      "column director_activity.kind does not exist",
      "SELECT ID, KIND FROM PUBLIC.DIRECTOR_ACTIVITY",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(
      "ERROR: column director_activity.kind does not exist",
      "select kind from public.director_activity",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(
      "  column director_activity.kind does not exist  ",
      "   select kind from public.director_activity   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"director_activity\" ...)` CTE wrapper form", () => {
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(
      "column director_activity.kind does not exist",
      'WITH pgrst_source AS ( SELECT "public"."director_activity"."id", "public"."director_activity"."kind", "public"."director_activity"."created_at" FROM "public"."director_activity" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(
      "column public.director_activity.kind does not exist",
      'WITH pgrst_source AS (SELECT "public"."director_activity"."kind" FROM "public"."director_activity")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(
      "ERROR: column director_activity.kind does not exist",
      'WITH pgrst_source AS (SELECT "public"."director_activity"."kind" FROM "public"."director_activity")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a kind column still pages)", () => {
  // `agent_jobs.kind` is a real column — if it ever regressed we absolutely want the
  // page. The pin is `director_activity.kind` only.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(
      "column agent_jobs.kind does not exist",
      "select kind from public.agent_jobs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise KEEPS a DIFFERENT column on director_activity (a real rename regression still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(
      "column director_activity.decision does not exist",
      "select id, decision from public.director_activity",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise KEEPS a non-SELECT statement shape on director_activity (an INSERT/UPDATE/DELETE with the same message is a real code-bug and still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(
      "column director_activity.kind does not exist",
      "insert into public.director_activity (id, kind) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(
      "column director_activity.kind does not exist",
      "update public.director_activity set kind = $1 where id = $2",
    ),
    false,
  );
  // The PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(
      "column director_activity.kind does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."director_activity"("kind") VALUES ($1) RETURNING "public"."director_activity"."id" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise(
      "column director_activity.kind does not exist",
      "",
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/product_variants?select=...price...` against our `public.product_variants`
// table. The table exists but by design carries NO bare `price` column — pricing lives
// on `product_variants.price_cents` (with a sibling `compare_at_price_cents`). Foreign-
// owned surface, no lever from us — drop AT CAPTURE only when BOTH the exact column-
// missing message on `product_variants.price` AND a SELECT-lookup shape on
// `product_variants` (bare OR PostgREST CTE wrapper) are present. A column-missing on
// any other table, a different column on `product_variants` (including the real
// `price_cents`), or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise drops the captured supabase-logs:b977e23b8fc0fea9 message+query pair (the ad hoc SELECT lookup on the exact product_variants.price column-missing shape)", () => {
  // The captured production sample: unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column product_variants.price does not exist",
      "select id, sku, price from public.product_variants",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column public.product_variants.price does not exist",
      "select id, sku, price from public.product_variants",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column product_variants.price does not exist",
      "select price from product_variants limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column product_variants.price does not exist",
      "select id, sku, price from public.product_variants where price > 0 order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column product_variants.price does not exist",
      "SELECT ID, SKU, PRICE FROM PUBLIC.PRODUCT_VARIANTS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "ERROR: column product_variants.price does not exist",
      "select price from public.product_variants",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "  column product_variants.price does not exist  ",
      "   select price from public.product_variants   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"product_variants\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in
  // the pgrst_source CTE with double-quoted `"public"."product_variants"` identifiers.
  // The plain bare-SELECT regex misses this because the statement starts with `with`
  // and the FROM clause carries the quoted schema.table shape.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column product_variants.price does not exist",
      'WITH pgrst_source AS ( SELECT "public"."product_variants"."id", "public"."product_variants"."sku", "public"."product_variants"."price" FROM "public"."product_variants" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column public.product_variants.price does not exist",
      'WITH pgrst_source AS (SELECT "public"."product_variants"."price" FROM "public"."product_variants")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "ERROR: column product_variants.price does not exist",
      'WITH pgrst_source AS (SELECT "public"."product_variants"."price" FROM "public"."product_variants")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise KEEPS a column-missing on `product_variants.price_cents` (a DIFFERENT column on the same table — the real column rename still pages)", () => {
  // `product_variants.price_cents` IS a real column (the actual pricing shape); if it
  // ever regresses we absolutely want the page. The pin is `product_variants.price`
  // only.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column product_variants.price_cents does not exist",
      "select id, sku, price_cents from public.product_variants",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column public.product_variants.price_cents does not exist",
      "select price_cents from public.product_variants",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a price column still pages)", () => {
  // If any other table's `price` column regressed, we absolutely want the page — the
  // pin is `product_variants.price` only.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column products.price does not exist",
      "select price from public.products where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column line_items.price does not exist",
      "select price from public.line_items where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise KEEPS a non-SELECT statement shape on product_variants (an INSERT/UPDATE/DELETE on product_variants with the same message is a real code-bug and still pages)", () => {
  // INSERT / UPDATE / DELETE against product_variants referencing a bogus `price`
  // column is real code trying to write the table — a bug we WANT to see, not the ad
  // hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column product_variants.price does not exist",
      "insert into public.product_variants (id, sku, price) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column product_variants.price does not exist",
      "update public.product_variants set price = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column product_variants.price does not exist",
      "delete from public.product_variants where price is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column product_variants.price does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."product_variants"("sku", "price") VALUES ($1, $2) RETURNING "public"."product_variants"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column product_variants.price does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."product_variants" SET "price" = $1 WHERE "public"."product_variants"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column product_variants.price does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductVariantsPriceAdhocNoise(
      "column product_variants.price does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/meta_ad_accounts?select=...name...` against our `public.meta_ad_accounts`
// table. The table exists but has NO bare `name` column — the human-readable account
// label lives on `meta_account_name`. Foreign-owned surface, no lever from us — drop
// AT CAPTURE only when BOTH the exact column-missing message on `meta_ad_accounts.name`
// AND a SELECT-lookup shape on `meta_ad_accounts` (bare OR PostgREST CTE wrapper) are
// present. A column-missing on any other table, a different column on
// `meta_ad_accounts` (including the real `meta_account_name`), or a non-SELECT
// statement still pages.

test("isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise drops the ad hoc SELECT lookup on the exact meta_ad_accounts.name column-missing shape", () => {
  // The captured production sample: unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column meta_ad_accounts.name does not exist",
      "select id, meta_account_id, name from public.meta_ad_accounts",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column public.meta_ad_accounts.name does not exist",
      "select name from public.meta_ad_accounts",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column meta_ad_accounts.name does not exist",
      "select name from meta_ad_accounts limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column meta_ad_accounts.name does not exist",
      "select id, name from public.meta_ad_accounts where is_active = true order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column meta_ad_accounts.name does not exist",
      "SELECT ID, NAME FROM PUBLIC.META_AD_ACCOUNTS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "ERROR: column meta_ad_accounts.name does not exist",
      "select name from public.meta_ad_accounts",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "  column meta_ad_accounts.name does not exist  ",
      "   select name from public.meta_ad_accounts   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"meta_ad_accounts\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in
  // the pgrst_source CTE with double-quoted `"public"."meta_ad_accounts"` identifiers.
  // The plain bare-SELECT regex misses this because the statement starts with `with`
  // and the FROM clause carries the quoted schema.table shape.
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column meta_ad_accounts.name does not exist",
      'WITH pgrst_source AS ( SELECT "public"."meta_ad_accounts"."id", "public"."meta_ad_accounts"."name" FROM "public"."meta_ad_accounts" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column public.meta_ad_accounts.name does not exist",
      'WITH pgrst_source AS (SELECT "public"."meta_ad_accounts"."name" FROM "public"."meta_ad_accounts")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "ERROR: column meta_ad_accounts.name does not exist",
      'WITH pgrst_source AS (SELECT "public"."meta_ad_accounts"."name" FROM "public"."meta_ad_accounts")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise KEEPS a column-missing on `meta_ad_accounts.meta_account_name` (the real column — a rename regression on the actual column still pages)", () => {
  // `meta_ad_accounts.meta_account_name` IS a real column; if it ever regresses we
  // absolutely want the page. The pin is `meta_ad_accounts.name` only.
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column meta_ad_accounts.meta_account_name does not exist",
      "select id, meta_account_name from public.meta_ad_accounts",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column public.meta_ad_accounts.meta_account_name does not exist",
      "select meta_account_name from public.meta_ad_accounts",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a `name` column still pages)", () => {
  // If any other table's `name` column regressed, we absolutely want the page — the
  // pin is `meta_ad_accounts.name` only.
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column products.name does not exist",
      "select name from public.products where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column workspaces.name does not exist",
      "select name from public.workspaces where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise KEEPS a non-SELECT statement shape on meta_ad_accounts (an INSERT/UPDATE/DELETE on meta_ad_accounts with the same message is a real code-bug and still pages)", () => {
  // INSERT / UPDATE / DELETE against meta_ad_accounts referencing a bogus `name` column
  // is real code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column meta_ad_accounts.name does not exist",
      "insert into public.meta_ad_accounts (id, meta_account_id, name) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column meta_ad_accounts.name does not exist",
      "update public.meta_ad_accounts set name = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column meta_ad_accounts.name does not exist",
      "delete from public.meta_ad_accounts where name is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column meta_ad_accounts.name does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."meta_ad_accounts"("meta_account_id", "name") VALUES ($1, $2) RETURNING "public"."meta_ad_accounts"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column meta_ad_accounts.name does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."meta_ad_accounts" SET "name" = $1 WHERE "public"."meta_ad_accounts"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column meta_ad_accounts.name does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(
      "column meta_ad_accounts.name does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/orders?select=...subtotal_cents...` against our `public.orders` table. The
// table exists but has NO top-level `subtotal_cents` column — the pre-tax/pre-shipping
// line-total breakdown lives nested inside `orders.payment_details` JSONB, and the
// look-alike `cart_drafts.subtotal_cents` IS a real column on a different table.
// Foreign-owned surface, no lever from us — drop AT CAPTURE only when BOTH the exact
// column-missing message on `orders.subtotal_cents` AND a SELECT-lookup shape on
// `orders` (bare OR PostgREST CTE wrapper) are present. A column-missing on any other
// table (including `cart_drafts.subtotal_cents` — the real column), a different column
// on `orders`, or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise drops the captured supabase-logs:bf3104f9e4d646ce message+query pair (ad hoc SELECT on orders.subtotal_cents)", () => {
  // Unqualified and public.-qualified message variants over the bare-SELECT shape.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column orders.subtotal_cents does not exist",
      "select id, subtotal_cents from public.orders",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column public.orders.subtotal_cents does not exist",
      "select subtotal_cents from public.orders",
    ),
    true,
  );
  // Unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column orders.subtotal_cents does not exist",
      "select subtotal_cents from orders limit 10",
    ),
    true,
  );
  // Trailing WHERE / ORDER BY / LIMIT still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column orders.subtotal_cents does not exist",
      "select id, subtotal_cents from public.orders where workspace_id = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column orders.subtotal_cents does not exist",
      "SELECT ID, SUBTOTAL_CENTS FROM PUBLIC.ORDERS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "ERROR: column orders.subtotal_cents does not exist",
      "select subtotal_cents from public.orders",
    ),
    true,
  );
  // Leading / trailing whitespace on message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "  column orders.subtotal_cents does not exist  ",
      "   select subtotal_cents from public.orders   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"orders\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."orders"` identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column orders.subtotal_cents does not exist",
      'WITH pgrst_source AS ( SELECT "public"."orders"."id", "public"."orders"."subtotal_cents" FROM "public"."orders" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column public.orders.subtotal_cents does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."subtotal_cents" FROM "public"."orders")',
    ),
    true,
  );
  // ERROR: prefix stripped as usual.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "ERROR: column orders.subtotal_cents does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."subtotal_cents" FROM "public"."orders")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise KEEPS a column-missing on a DIFFERENT column of orders (a real product-schema regression on another orders column still pages)", () => {
  // If any other `orders` column regressed we absolutely want the page — the pin is
  // `orders.subtotal_cents` only.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column orders.total_cents does not exist",
      "select total_cents from public.orders",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column public.orders.payment_details does not exist",
      "select payment_details from public.orders",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise KEEPS a subtotal_cents miss on a DIFFERENT table (the real cart_drafts.subtotal_cents column — a regression on the actual column still pages)", () => {
  // `cart_drafts.subtotal_cents` IS a real column on a different table. If that ever
  // regresses we WANT the page — the pin is `orders.subtotal_cents` only.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column cart_drafts.subtotal_cents does not exist",
      "select subtotal_cents from public.cart_drafts",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column public.cart_drafts.subtotal_cents does not exist",
      "select subtotal_cents from public.cart_drafts",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise KEEPS a non-SELECT statement shape on orders (an INSERT/UPDATE/DELETE with the same message is a real code-bug and still pages)", () => {
  // INSERT / UPDATE / DELETE against orders referencing a bogus `subtotal_cents` column
  // is real code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column orders.subtotal_cents does not exist",
      "insert into public.orders (id, workspace_id, subtotal_cents) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column orders.subtotal_cents does not exist",
      "update public.orders set subtotal_cents = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column orders.subtotal_cents does not exist",
      "delete from public.orders where subtotal_cents is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column orders.subtotal_cents does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."orders"("workspace_id", "subtotal_cents") VALUES ($1, $2) RETURNING "public"."orders"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column orders.subtotal_cents does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."orders" SET "subtotal_cents" = $1 WHERE "public"."orders"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column orders.subtotal_cents does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersSubtotalCentsColumnAdhocNoise(
      "column orders.subtotal_cents does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/transactions?select=...source_name...` against our `public.transactions`
// table. The table exists but has NO `source_name` column — `source_name` lives on
// `public.orders` (the Shopify order-source label), never on `transactions`, and no
// in-tree reader selects it off `transactions`. Foreign-owned surface, no lever from us —
// drop AT CAPTURE only when BOTH the exact column-missing message on
// `transactions.source_name` AND a SELECT-lookup shape on `transactions` (bare OR
// PostgREST CTE wrapper) are present. A column-missing on any other table (including the
// real `orders.source_name`), a different column on `transactions`, or a non-SELECT
// statement still pages.

test("isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise drops the captured supabase-logs:536f2f8f383676b7 message+query pair (ad hoc SELECT on transactions.source_name)", () => {
  // Unqualified and public.-qualified message variants over the bare-SELECT shape.
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column transactions.source_name does not exist",
      "select id, source_name from public.transactions",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column public.transactions.source_name does not exist",
      "select source_name from public.transactions",
    ),
    true,
  );
  // Unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column transactions.source_name does not exist",
      "select source_name from transactions limit 10",
    ),
    true,
  );
  // Trailing WHERE / ORDER BY / LIMIT still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column transactions.source_name does not exist",
      "select id, source_name from public.transactions where workspace_id = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column transactions.source_name does not exist",
      "SELECT ID, SOURCE_NAME FROM PUBLIC.TRANSACTIONS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "ERROR: column transactions.source_name does not exist",
      "select source_name from public.transactions",
    ),
    true,
  );
  // Leading / trailing whitespace on message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "  column transactions.source_name does not exist  ",
      "   select source_name from public.transactions   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"transactions\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."transactions"` identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column transactions.source_name does not exist",
      'WITH pgrst_source AS ( SELECT "public"."transactions"."id", "public"."transactions"."source_name" FROM "public"."transactions" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column public.transactions.source_name does not exist",
      'WITH pgrst_source AS (SELECT "public"."transactions"."source_name" FROM "public"."transactions")',
    ),
    true,
  );
  // ERROR: prefix stripped as usual.
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "ERROR: column transactions.source_name does not exist",
      'WITH pgrst_source AS (SELECT "public"."transactions"."source_name" FROM "public"."transactions")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise KEEPS a column-missing on a DIFFERENT column of transactions (a real product-schema regression on another transactions column still pages)", () => {
  // If any other `transactions` column regressed we absolutely want the page — the pin is
  // `transactions.source_name` only.
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column transactions.amount_cents does not exist",
      "select amount_cents from public.transactions",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column public.transactions.status does not exist",
      "select status from public.transactions",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise KEEPS a source_name miss on a DIFFERENT table (the real orders.source_name column — a regression on the actual column still pages)", () => {
  // `orders.source_name` IS the real column on a different table. If that ever regresses
  // we WANT the page — the pin is `transactions.source_name` only.
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column orders.source_name does not exist",
      "select source_name from public.orders",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column public.orders.source_name does not exist",
      "select source_name from public.orders",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise KEEPS a non-SELECT statement shape on transactions (an INSERT/UPDATE/DELETE with the same message is a real code-bug and still pages)", () => {
  // INSERT / UPDATE / DELETE against transactions referencing a bogus `source_name` column
  // is real code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column transactions.source_name does not exist",
      "insert into public.transactions (id, workspace_id, source_name) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column transactions.source_name does not exist",
      "update public.transactions set source_name = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column transactions.source_name does not exist",
      "delete from public.transactions where source_name is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column transactions.source_name does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."transactions"("workspace_id", "source_name") VALUES ($1, $2) RETURNING "public"."transactions"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column transactions.source_name does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."transactions" SET "source_name" = $1 WHERE "public"."transactions"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column transactions.source_name does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTransactionsSourceNameColumnAdhocNoise(
      "column transactions.source_name does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise ──
// A foreign / stale client expecting Shopify's REST orders shape reads
// `/rest/v1/orders?select=...total_price...` (or `subtotal_price`) against our
// `public.orders` table. The table exists but has NO top-level `total_price` /
// `subtotal_price` columns — the money breakdown lives in `orders.total_cents` and
// the pre-tax/pre-shipping subtotal nests inside `orders.payment_details` JSONB.
// Foreign-owned surface, no lever from us — drop AT CAPTURE only when BOTH the exact
// column-missing message on `orders.total_price` / `orders.subtotal_price` AND a
// SELECT-lookup shape on `orders` (bare OR PostgREST CTE wrapper) are present. A
// column-missing on any other table, a different column on `orders`, or a non-SELECT
// statement still pages.

test("isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise drops the captured supabase-logs:6da26669da941b7b message+query pair (ad hoc SELECT on orders.total_price / orders.subtotal_price)", () => {
  // Unqualified and public.-qualified message variants over the bare-SELECT shape —
  // both `total_price` and its `subtotal_price` twin.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column orders.total_price does not exist",
      "select id, total_price from public.orders",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column public.orders.total_price does not exist",
      "select total_price from public.orders",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column orders.subtotal_price does not exist",
      "select id, subtotal_price from public.orders",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column public.orders.subtotal_price does not exist",
      "select subtotal_price from public.orders",
    ),
    true,
  );
  // Unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column orders.total_price does not exist",
      "select total_price from orders limit 10",
    ),
    true,
  );
  // Trailing WHERE / ORDER BY / LIMIT still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column orders.total_price does not exist",
      "select id, total_price from public.orders where workspace_id = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column orders.total_price does not exist",
      "SELECT ID, TOTAL_PRICE FROM PUBLIC.ORDERS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "ERROR: column orders.total_price does not exist",
      "select total_price from public.orders",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "ERROR: column orders.subtotal_price does not exist",
      "select subtotal_price from public.orders",
    ),
    true,
  );
  // Leading / trailing whitespace on message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "  column orders.total_price does not exist  ",
      "   select total_price from public.orders   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"orders\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."orders"` identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column orders.total_price does not exist",
      'WITH pgrst_source AS ( SELECT "public"."orders"."id", "public"."orders"."total_price" FROM "public"."orders" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column public.orders.total_price does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."total_price" FROM "public"."orders")',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column orders.subtotal_price does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."subtotal_price" FROM "public"."orders")',
    ),
    true,
  );
  // ERROR: prefix stripped as usual.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "ERROR: column orders.subtotal_price does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."subtotal_price" FROM "public"."orders")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise KEEPS a column-missing on a DIFFERENT column of orders (a real product-schema regression on another orders column still pages)", () => {
  // If any other `orders` column regressed we absolutely want the page — the pin is
  // `orders.total_price` / `orders.subtotal_price` only.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column orders.total_cents does not exist",
      "select total_cents from public.orders",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column public.orders.payment_details does not exist",
      "select payment_details from public.orders",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise KEEPS a total_price / subtotal_price miss on a DIFFERENT table (a regression on another table's price column still pages)", () => {
  // If a different table ever defines (and then regresses) a `total_price` /
  // `subtotal_price` column we WANT the page — the pin is `orders` only.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column cart_drafts.total_price does not exist",
      "select total_price from public.cart_drafts",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column public.cart_drafts.subtotal_price does not exist",
      "select subtotal_price from public.cart_drafts",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise KEEPS a non-SELECT statement shape on orders (an INSERT/UPDATE/DELETE with the same message is a real code-bug and still pages)", () => {
  // INSERT / UPDATE / DELETE against orders referencing a bogus `total_price` /
  // `subtotal_price` column is real code trying to write the table — a bug we WANT to
  // see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column orders.total_price does not exist",
      "insert into public.orders (id, workspace_id, total_price) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column orders.subtotal_price does not exist",
      "update public.orders set subtotal_price = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column orders.total_price does not exist",
      "delete from public.orders where total_price is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column orders.total_price does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."orders"("workspace_id", "total_price") VALUES ($1, $2) RETURNING "public"."orders"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column orders.subtotal_price does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."orders" SET "subtotal_price" = $1 WHERE "public"."orders"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise KEEPS a FATAL / PANIC / constraint-violation (different message shape — a real DB problem still pages)", () => {
  // FATAL / PANIC / unique-violation / foreign-key-violation on orders are real DB
  // problems — pin is the exact column-missing message only.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "FATAL: database is shutting down",
      "select total_price from public.orders",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      'duplicate key value violates unique constraint "orders_pkey"',
      "select total_price from public.orders",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column orders.total_price does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyPriceColumnsAdhocNoise(
      "column orders.subtotal_price does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/orders?select=...shipping_name...` against our `public.orders` table. The
// table exists but has NO top-level `shipping_name` column — the ship-to recipient
// name lives nested inside `orders.shipping_address` JSONB, and the same captured
// query also names a non-existent `orders.raw` column. Foreign-owned surface, no
// lever from us — drop AT CAPTURE only when BOTH the exact column-missing message on
// `orders.shipping_name` AND a SELECT-lookup shape on `orders` (bare OR PostgREST CTE
// wrapper) are present. A column-missing on any other `orders` column (including the
// real `shipping_address`), on `shipping_name` from any other table, or via a
// non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise drops the captured supabase-logs:8bfb641dae95b170 message+query pair (ad hoc SELECT on orders.shipping_name)", () => {
  // Unqualified and public.-qualified message variants over the bare-SELECT shape.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column orders.shipping_name does not exist",
      "select id, shipping_name from public.orders",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column public.orders.shipping_name does not exist",
      "select shipping_name from public.orders",
    ),
    true,
  );
  // Unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column orders.shipping_name does not exist",
      "select shipping_name from orders limit 10",
    ),
    true,
  );
  // Trailing WHERE / ORDER BY / LIMIT still the ad hoc lookup shape — matches the
  // workspace+customer scoped list the signature was captured against.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column orders.shipping_name does not exist",
      "select id, shipping_name from public.orders where workspace_id = 'x' and customer_id = 'y' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column orders.shipping_name does not exist",
      "SELECT ID, SHIPPING_NAME FROM PUBLIC.ORDERS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "ERROR: column orders.shipping_name does not exist",
      "select shipping_name from public.orders",
    ),
    true,
  );
  // Leading / trailing whitespace on message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "  column orders.shipping_name does not exist  ",
      "   select shipping_name from public.orders   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"orders\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."orders"` identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column orders.shipping_name does not exist",
      'WITH pgrst_source AS ( SELECT "public"."orders"."id", "public"."orders"."shipping_name" FROM "public"."orders" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column public.orders.shipping_name does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."shipping_name" FROM "public"."orders")',
    ),
    true,
  );
  // ERROR: prefix stripped as usual.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "ERROR: column orders.shipping_name does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."shipping_name" FROM "public"."orders")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise KEEPS a column-missing on a DIFFERENT column of orders (a real product-schema regression on another orders column still pages)", () => {
  // `shipping_address` IS the live JSONB column that carries the recipient name. If it
  // ever regressed we absolutely want the page — the pin is `orders.shipping_name` only.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column orders.shipping_address does not exist",
      "select shipping_address from public.orders",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column public.orders.total_cents does not exist",
      "select total_cents from public.orders",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise KEEPS a shipping_name miss on a DIFFERENT table (a regression on another table's shipping_name column still pages)", () => {
  // If some other table ever carried a real `shipping_name` column and it regressed we
  // WANT the page — the pin is `orders.shipping_name` only.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column fraud_evaluations.shipping_name does not exist",
      "select shipping_name from public.fraud_evaluations",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column public.cart_drafts.shipping_name does not exist",
      "select shipping_name from public.cart_drafts",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise KEEPS a non-SELECT statement shape on orders (an INSERT/UPDATE/DELETE with the same message is a real code-bug and still pages)", () => {
  // INSERT / UPDATE / DELETE against orders referencing a bogus `shipping_name` column
  // is real code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column orders.shipping_name does not exist",
      "insert into public.orders (id, workspace_id, shipping_name) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column orders.shipping_name does not exist",
      "update public.orders set shipping_name = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column orders.shipping_name does not exist",
      "delete from public.orders where shipping_name is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column orders.shipping_name does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."orders"("workspace_id", "shipping_name") VALUES ($1, $2) RETURNING "public"."orders"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column orders.shipping_name does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."orders" SET "shipping_name" = $1 WHERE "public"."orders"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column orders.shipping_name does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShippingNameColumnAdhocNoise(
      "column orders.shipping_name does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/orders?select=...shopify_order_name...` against our `public.orders` table.
// The table exists but has NO `shopify_order_name` column — customer-visible order
// names live in `orders.order_number`, and the `shopify_order_name` name belongs to the
// sibling `one_time_charges` table. Foreign-owned surface, no lever from us — drop AT
// CAPTURE only when BOTH the exact column-missing message on `orders.shopify_order_name`
// AND a SELECT-lookup shape on `orders` (bare OR PostgREST CTE wrapper) are present. A
// column-missing on a live `orders` column, on `shopify_order_name` from any other
// table (including the real `one_time_charges.shopify_order_name`), or via a non-SELECT
// statement still pages.

test("isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise drops the captured supabase-logs:29330036d8d9e5fe message+query pair (ad hoc SELECT on orders.shopify_order_name)", () => {
  // Unqualified and public.-qualified message variants over the bare-SELECT shape.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column orders.shopify_order_name does not exist",
      "select id, shopify_order_name from public.orders",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column public.orders.shopify_order_name does not exist",
      "select shopify_order_name from public.orders",
    ),
    true,
  );
  // Unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column orders.shopify_order_name does not exist",
      "select shopify_order_name from orders limit 10",
    ),
    true,
  );
  // Trailing WHERE / ORDER BY / LIMIT still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column orders.shopify_order_name does not exist",
      "select id, shopify_order_name from public.orders where workspace_id = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column orders.shopify_order_name does not exist",
      "SELECT ID, SHOPIFY_ORDER_NAME FROM PUBLIC.ORDERS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "ERROR: column orders.shopify_order_name does not exist",
      "select shopify_order_name from public.orders",
    ),
    true,
  );
  // Leading / trailing whitespace on message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "  column orders.shopify_order_name does not exist  ",
      "   select shopify_order_name from public.orders   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"orders\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."orders"` identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column orders.shopify_order_name does not exist",
      'WITH pgrst_source AS ( SELECT "public"."orders"."id", "public"."orders"."shopify_order_name" FROM "public"."orders" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column public.orders.shopify_order_name does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."shopify_order_name" FROM "public"."orders")',
    ),
    true,
  );
  // ERROR: prefix stripped as usual.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "ERROR: column orders.shopify_order_name does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."shopify_order_name" FROM "public"."orders")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise KEEPS a column-missing on a DIFFERENT column of orders (a real product-schema regression on another orders column still pages)", () => {
  // If any other `orders` column regressed we absolutely want the page — the pin is
  // `orders.shopify_order_name` only.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column orders.order_number does not exist",
      "select order_number from public.orders",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column public.orders.total_cents does not exist",
      "select total_cents from public.orders",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise KEEPS a shopify_order_name miss on a DIFFERENT table (the real one_time_charges.shopify_order_name regression still pages)", () => {
  // The live `one_time_charges.shopify_order_name` column: if IT regresses we WANT the
  // page — the pin is `orders` only.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column one_time_charges.shopify_order_name does not exist",
      "select shopify_order_name from public.one_time_charges",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column public.one_time_charges.shopify_order_name does not exist",
      "select shopify_order_name from public.one_time_charges",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise KEEPS a non-SELECT statement shape on orders (an INSERT/UPDATE/DELETE with the same message is a real code-bug and still pages)", () => {
  // INSERT / UPDATE / DELETE against orders referencing a bogus `shopify_order_name`
  // column is real code trying to write the table — a bug we WANT to see, not the ad
  // hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column orders.shopify_order_name does not exist",
      "insert into public.orders (id, workspace_id, shopify_order_name) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column orders.shopify_order_name does not exist",
      "update public.orders set shopify_order_name = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column orders.shopify_order_name does not exist",
      "delete from public.orders where shopify_order_name is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column orders.shopify_order_name does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."orders"("workspace_id", "shopify_order_name") VALUES ($1, $2) RETURNING "public"."orders"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column orders.shopify_order_name does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."orders" SET "shopify_order_name" = $1 WHERE "public"."orders"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise KEEPS a FATAL / PANIC / constraint-violation (different message shape — a real DB problem still pages)", () => {
  // FATAL / PANIC / unique-violation / foreign-key-violation on orders are real DB
  // problems — pin is the exact column-missing message only.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "FATAL: database is shutting down",
      "select shopify_order_name from public.orders",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      'duplicate key value violates unique constraint "orders_pkey"',
      "select shopify_order_name from public.orders",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column orders.shopify_order_name does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersShopifyOrderNameAdhocNoise(
      "column orders.shopify_order_name does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/orders?select=...easypost_tracker_id...` against our `public.orders` table.
// The table exists but has NO `easypost_tracker_id` / `easypost_tracking_code` /
// `easypost_carrier` columns — EasyPost tracker state lives on the sibling `shipments`
// / `fulfillments` tables (and the real EasyPost tracker-id lives on
// `shipments.easypost_tracker_id`, not on `orders`). Foreign-owned surface, no lever
// from us — drop AT CAPTURE only when BOTH the exact column-missing message on one of
// the three `orders` columns AND a SELECT-lookup shape on `orders` (bare OR PostgREST
// CTE wrapper) are present. A column-missing on a live `orders` column, on
// `easypost_tracker_id` / `easypost_tracking_code` / `easypost_carrier` from any other
// table (including the real `shipments.easypost_tracker_id`), or via a non-SELECT
// statement still pages.

test("isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise drops the captured supabase-logs:80528fce22470ee0 message+query pair (ad hoc SELECT on orders.easypost_tracker_id)", () => {
  // Unqualified and public.-qualified message variants over the bare-SELECT shape.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column orders.easypost_tracker_id does not exist",
      "select id, easypost_tracker_id from public.orders",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column public.orders.easypost_tracker_id does not exist",
      "select easypost_tracker_id from public.orders",
    ),
    true,
  );
  // The `easypost_tracking_code` twin.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column orders.easypost_tracking_code does not exist",
      "select id, easypost_tracking_code from public.orders",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column public.orders.easypost_tracking_code does not exist",
      "select easypost_tracking_code from public.orders",
    ),
    true,
  );
  // The `easypost_carrier` twin.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column orders.easypost_carrier does not exist",
      "select id, easypost_carrier from public.orders",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column public.orders.easypost_carrier does not exist",
      "select easypost_carrier from public.orders",
    ),
    true,
  );
  // Unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column orders.easypost_tracker_id does not exist",
      "select easypost_tracker_id from orders limit 10",
    ),
    true,
  );
  // Trailing WHERE / ORDER BY / LIMIT still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column orders.easypost_tracker_id does not exist",
      "select id, easypost_tracker_id from public.orders where workspace_id = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column orders.easypost_tracker_id does not exist",
      "SELECT ID, EASYPOST_TRACKER_ID FROM PUBLIC.ORDERS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "ERROR: column orders.easypost_tracker_id does not exist",
      "select easypost_tracker_id from public.orders",
    ),
    true,
  );
  // Leading / trailing whitespace on message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "  column orders.easypost_tracker_id does not exist  ",
      "   select easypost_tracker_id from public.orders   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"orders\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."orders"` identifiers — for each of
  // the three pinned columns.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column orders.easypost_tracker_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."orders"."id", "public"."orders"."easypost_tracker_id" FROM "public"."orders" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column public.orders.easypost_tracking_code does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."easypost_tracking_code" FROM "public"."orders")',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column orders.easypost_carrier does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."easypost_carrier" FROM "public"."orders")',
    ),
    true,
  );
  // ERROR: prefix stripped as usual.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "ERROR: column orders.easypost_tracker_id does not exist",
      'WITH pgrst_source AS (SELECT "public"."orders"."easypost_tracker_id" FROM "public"."orders")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise KEEPS a column-missing on a DIFFERENT column of orders (a real product-schema regression on another orders column still pages)", () => {
  // If any other `orders` column regressed we absolutely want the page — the pin is
  // the three EasyPost columns only.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column orders.order_number does not exist",
      "select order_number from public.orders",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column public.orders.total_cents does not exist",
      "select total_cents from public.orders",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise KEEPS an easypost_tracker_id miss on a DIFFERENT table (the real shipments.easypost_tracker_id regression still pages)", () => {
  // The live `shipments.easypost_tracker_id` column: if IT regresses we WANT the page —
  // the pin is `orders` only.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column shipments.easypost_tracker_id does not exist",
      "select easypost_tracker_id from public.shipments",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column public.shipments.easypost_tracker_id does not exist",
      "select easypost_tracker_id from public.shipments",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column fulfillments.easypost_tracking_code does not exist",
      "select easypost_tracking_code from public.fulfillments",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise KEEPS a non-SELECT statement shape on orders (an INSERT/UPDATE/DELETE with the same message is a real code-bug and still pages)", () => {
  // INSERT / UPDATE / DELETE against orders referencing a bogus `easypost_tracker_id`
  // column is real code trying to write the table — a bug we WANT to see, not the ad
  // hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column orders.easypost_tracker_id does not exist",
      "insert into public.orders (id, workspace_id, easypost_tracker_id) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column orders.easypost_tracker_id does not exist",
      "update public.orders set easypost_tracker_id = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column orders.easypost_tracker_id does not exist",
      "delete from public.orders where easypost_tracker_id is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column orders.easypost_tracker_id does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."orders"("workspace_id", "easypost_tracker_id") VALUES ($1, $2) RETURNING "public"."orders"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column orders.easypost_tracker_id does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."orders" SET "easypost_tracker_id" = $1 WHERE "public"."orders"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise KEEPS a FATAL / PANIC / constraint-violation (different message shape — a real DB problem still pages)", () => {
  // FATAL / PANIC / unique-violation / foreign-key-violation on orders are real DB
  // problems — pin is the exact column-missing message only.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "FATAL: database is shutting down",
      "select easypost_tracker_id from public.orders",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      'duplicate key value violates unique constraint "orders_pkey"',
      "select easypost_tracker_id from public.orders",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column orders.easypost_tracker_id does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingOrdersEasypostTrackerAdhocNoise(
      "column orders.easypost_tracker_id does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingSubscriptionsPausedAtColumnAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/subscriptions?select=...paused_at...` against our `public.subscriptions`
// table. The table exists but has NO `paused_at` column — the live pause-related column
// is `pause_resume_at`; `paused_at` names appear on sibling tables (dunning,
// crisis_management). Foreign-owned surface, no lever from us — drop AT CAPTURE only
// when BOTH the exact column-missing message on `subscriptions.paused_at` AND a
// SELECT-lookup shape on `subscriptions` (bare OR PostgREST CTE wrapper) are present. A
// column-missing on a live `subscriptions` column (`pause_resume_at`), on `paused_at`
// from any other table, or via a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingSubscriptionsPausedAtColumnAdhocNoise drops the captured supabase-logs:735cc43853c89338 message+query pair (PostgREST CTE SELECT on subscriptions.paused_at)", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `subscriptions.paused_at` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsPausedAtColumnAdhocNoise(
      "column subscriptions.paused_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions"."id", "public"."subscriptions"."paused_at" FROM "public"."subscriptions" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsPausedAtColumnAdhocNoise(
      "column public.subscriptions.paused_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."subscriptions"."paused_at" FROM "public"."subscriptions")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsPausedAtColumnAdhocNoise(
      "column subscriptions.paused_at does not exist",
      "select id, paused_at from public.subscriptions",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsPausedAtColumnAdhocNoise(
      "column subscriptions.paused_at does not exist",
      "select paused_at from subscriptions limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsPausedAtColumnAdhocNoise(
      "ERROR: column subscriptions.paused_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."subscriptions"."paused_at" FROM "public"."subscriptions")',
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsPausedAtColumnAdhocNoise(
      "column subscriptions.paused_at does not exist",
      "SELECT ID, PAUSED_AT FROM PUBLIC.SUBSCRIPTIONS",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionsPausedAtColumnAdhocNoise KEEPS a column-missing on a live subscriptions column (pause_resume_at — a real schema regression still pages)", () => {
  // `pause_resume_at` IS the live pause-related column on `subscriptions`. If that ever
  // regresses we WANT the page — the pin is `subscriptions.paused_at` only.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsPausedAtColumnAdhocNoise(
      "column subscriptions.pause_resume_at does not exist",
      "select pause_resume_at from public.subscriptions",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsPausedAtColumnAdhocNoise(
      "column public.subscriptions.pause_resume_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions"."pause_resume_at" FROM "public"."subscriptions" )',
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingSubscriptionsDeliveryAddressColumnAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/subscriptions?select=...delivery_address...` against our
// `public.subscriptions` table. The table exists but has NO `delivery_address` column —
// the live delivery/shipping columns are `shipping_address` (JSONB) and
// `delivery_price_cents` (int8). Foreign-owned surface, no lever from us — drop AT
// CAPTURE only when BOTH the exact column-missing message on
// `subscriptions.delivery_address` AND a SELECT-lookup shape on `subscriptions` (bare OR
// PostgREST CTE wrapper) are present. A column-missing on a live `subscriptions` column
// (`shipping_address`), on `delivery_address` from any other table, or via a non-SELECT
// statement still pages. Control Tower signature `supabase-logs:926eb562770a4248`.

test("isForeignSupabasePostgresMissingSubscriptionsDeliveryAddressColumnAdhocNoise drops the captured 9a759241 sample message+query pair (PostgREST CTE SELECT on subscriptions.delivery_address)", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `subscriptions.delivery_address` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsDeliveryAddressColumnAdhocNoise(
      "column subscriptions.delivery_address does not exist",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions"."id", "public"."subscriptions"."delivery_address" FROM "public"."subscriptions" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsDeliveryAddressColumnAdhocNoise(
      "column public.subscriptions.delivery_address does not exist",
      'WITH pgrst_source AS (SELECT "public"."subscriptions"."delivery_address" FROM "public"."subscriptions")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsDeliveryAddressColumnAdhocNoise(
      "column subscriptions.delivery_address does not exist",
      "select id, delivery_address from public.subscriptions",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsDeliveryAddressColumnAdhocNoise(
      "column subscriptions.delivery_address does not exist",
      "select delivery_address from subscriptions limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsDeliveryAddressColumnAdhocNoise(
      "ERROR: column subscriptions.delivery_address does not exist",
      'WITH pgrst_source AS (SELECT "public"."subscriptions"."delivery_address" FROM "public"."subscriptions")',
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsDeliveryAddressColumnAdhocNoise(
      "column subscriptions.delivery_address does not exist",
      "SELECT ID, DELIVERY_ADDRESS FROM PUBLIC.SUBSCRIPTIONS",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSubscriptionsDeliveryAddressColumnAdhocNoise KEEPS other columns / tables / non-SELECT shapes (real regressions still page)", () => {
  // A DIFFERENT subscriptions column — `shipping_address` IS live; if it regresses we
  // WANT the page. The pin is `delivery_address` only.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsDeliveryAddressColumnAdhocNoise(
      "column subscriptions.shipping_address does not exist",
      "select shipping_address from public.subscriptions",
    ),
    false,
  );
  // `delivery_address` on ANOTHER table (orders) — not our pinned signature, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsDeliveryAddressColumnAdhocNoise(
      "column orders.delivery_address does not exist",
      "select delivery_address from public.orders",
    ),
    false,
  );
  // A NON-SELECT statement on subscriptions — real code-bug shape, still pages.
  assert.equal(
    isForeignSupabasePostgresMissingSubscriptionsDeliveryAddressColumnAdhocNoise(
      "column subscriptions.delivery_address does not exist",
      "update public.subscriptions set delivery_address = '{}' where id = 1",
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingCustomersAddressColumnAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/customers?select=...address...` against our `public.customers` table.
// The table exists but has NO bare `address` column — the live address-related
// columns are `default_address` (JSONB) and `addresses` (JSONB array). Foreign-owned
// surface, no lever from us — drop AT CAPTURE only when BOTH the exact column-missing
// message on `customers.address` AND a SELECT-lookup shape on `customers` (bare OR
// PostgREST CTE wrapper) are present. A column-missing on a live `customers` column
// (`default_address`, `addresses`, `shipping_address`), on `address` from any other
// table, or via a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingCustomersAddressColumnAdhocNoise drops the captured supabase-logs:b40ebaa6f87c26c6 message+query pair (PostgREST CTE SELECT on customers.address)", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `customers.address` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingCustomersAddressColumnAdhocNoise(
      "column customers.address does not exist",
      'WITH pgrst_source AS ( SELECT "public"."customers"."id", "public"."customers"."address" FROM "public"."customers" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomersAddressColumnAdhocNoise(
      "column public.customers.address does not exist",
      'WITH pgrst_source AS (SELECT "public"."customers"."address" FROM "public"."customers")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingCustomersAddressColumnAdhocNoise(
      "column customers.address does not exist",
      "select id, address from public.customers",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomersAddressColumnAdhocNoise(
      "column customers.address does not exist",
      "select address from customers limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingCustomersAddressColumnAdhocNoise(
      "ERROR: column customers.address does not exist",
      'WITH pgrst_source AS (SELECT "public"."customers"."address" FROM "public"."customers")',
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingCustomersAddressColumnAdhocNoise(
      "column customers.address does not exist",
      "SELECT ID, ADDRESS FROM PUBLIC.CUSTOMERS",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingCustomersAddressColumnAdhocNoise KEEPS a column-missing on a live customers column (default_address / shipping_address — a real schema regression still pages)", () => {
  // `default_address` and `addresses` ARE live columns on `customers`. If either ever
  // regresses we WANT the page — the pin is `customers.address` only.
  assert.equal(
    isForeignSupabasePostgresMissingCustomersAddressColumnAdhocNoise(
      "column customers.default_address does not exist",
      "select default_address from public.customers",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingCustomersAddressColumnAdhocNoise(
      "column public.customers.shipping_address does not exist",
      'WITH pgrst_source AS ( SELECT "public"."customers"."shipping_address" FROM "public"."customers" )',
    ),
    false,
  );
  // A column-missing on `address` from a DIFFERENT table (e.g. a real `orders.address`
  // regression) must still page — the pin is `customers.address` only.
  assert.equal(
    isForeignSupabasePostgresMissingCustomersAddressColumnAdhocNoise(
      "column orders.address does not exist",
      "select address from public.orders",
    ),
    false,
  );
  // A non-SELECT statement against `customers` (real code-bug shape) must still page.
  assert.equal(
    isForeignSupabasePostgresMissingCustomersAddressColumnAdhocNoise(
      "column customers.address does not exist",
      "update public.customers set address = $1 where id = $2",
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingJourneySessionsExpiresAtColumnAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/journey_sessions?select=...expires_at...` (or a Supabase Studio browse)
// against our `public.journey_sessions` table. The table exists but has NO `expires_at`
// column — the live expiry column is `token_expires_at`. Foreign-owned surface, no
// lever from us — drop AT CAPTURE only when BOTH the exact column-missing message on
// `journey_sessions.expires_at` AND a SELECT-lookup shape on `journey_sessions` (bare OR
// PostgREST CTE wrapper) are present. A column-missing on a live `journey_sessions`
// column (`token_expires_at`), on `expires_at` from any other table, or via a non-SELECT
// statement still pages.

test("isForeignSupabasePostgresMissingJourneySessionsExpiresAtColumnAdhocNoise drops the captured supabase-logs:cce14c08f17e48b3 message+query pair (PostgREST CTE SELECT on journey_sessions.expires_at)", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-missing
  // message on `journey_sessions.expires_at` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsExpiresAtColumnAdhocNoise(
      "column journey_sessions.expires_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."journey_sessions"."id", "public"."journey_sessions"."expires_at" FROM "public"."journey_sessions" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsExpiresAtColumnAdhocNoise(
      "column public.journey_sessions.expires_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."journey_sessions"."expires_at" FROM "public"."journey_sessions")',
    ),
    true,
  );
  // The bare-SELECT shape — unqualified and public.-qualified FROM — is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsExpiresAtColumnAdhocNoise(
      "column journey_sessions.expires_at does not exist",
      "select id, expires_at from public.journey_sessions",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsExpiresAtColumnAdhocNoise(
      "column journey_sessions.expires_at does not exist",
      "select expires_at from journey_sessions limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsExpiresAtColumnAdhocNoise(
      "ERROR: column journey_sessions.expires_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."journey_sessions"."expires_at" FROM "public"."journey_sessions")',
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsExpiresAtColumnAdhocNoise(
      "column journey_sessions.expires_at does not exist",
      "SELECT ID, EXPIRES_AT FROM PUBLIC.JOURNEY_SESSIONS",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingJourneySessionsExpiresAtColumnAdhocNoise KEEPS a column-missing on a live journey_sessions column (token_expires_at — a real schema regression still pages)", () => {
  // `token_expires_at` IS the live expiry column on `journey_sessions`. If it ever
  // regresses we WANT the page — the pin is `journey_sessions.expires_at` only.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsExpiresAtColumnAdhocNoise(
      "column journey_sessions.token_expires_at does not exist",
      "select token_expires_at from public.journey_sessions",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsExpiresAtColumnAdhocNoise(
      "column public.journey_sessions.token_expires_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."journey_sessions"."token_expires_at" FROM "public"."journey_sessions" )',
    ),
    false,
  );
  // A column-missing on `expires_at` from a DIFFERENT table must still page — the pin is
  // `journey_sessions.expires_at` only.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsExpiresAtColumnAdhocNoise(
      "column sessions.expires_at does not exist",
      "select expires_at from public.sessions",
    ),
    false,
  );
  // A non-SELECT statement against `journey_sessions` (real code-bug shape) must still page.
  assert.equal(
    isForeignSupabasePostgresMissingJourneySessionsExpiresAtColumnAdhocNoise(
      "column journey_sessions.expires_at does not exist",
      "update public.journey_sessions set expires_at = $1 where id = $2",
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/products?select=...ingredients...` (or `supplement_facts`, or `benefits`)
// against our `public.products` table. The table exists but has NEVER carried any of
// those three intelligence columns — they live on sibling tables
// (`product_ingredients`, `product_benefit_selections`, etc.). Foreign-owned surface,
// no lever from us — drop AT CAPTURE only when BOTH the exact column-missing message
// on one of the three off-schema columns AND a SELECT-lookup shape on `products`
// (bare OR PostgREST CTE wrapper) are present. A column-missing on any other table,
// a different column on `products`, or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise drops the captured supabase-logs:a7533814f2487659 message+query pair (the ad hoc PostgREST-CTE lookup on products.ingredients / supplement_facts / benefits)", () => {
  // The captured production sample: PostgREST-wrapped SELECT + the exact column-
  // missing message on `products.ingredients` (unqualified + public.-qualified).
  assert.equal(
    isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise(
      "column products.ingredients does not exist",
      'WITH pgrst_source AS ( SELECT "public"."products"."id", "public"."products"."ingredients" FROM "public"."products" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise(
      "column public.products.ingredients does not exist",
      'WITH pgrst_source AS ( SELECT "public"."products"."ingredients" FROM "public"."products" )',
    ),
    true,
  );
  // The other two pinned columns (`supplement_facts`, `benefits`) match the same way.
  assert.equal(
    isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise(
      "column products.supplement_facts does not exist",
      "select id, supplement_facts from public.products",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise(
      "column products.benefits does not exist",
      "select id, benefits from products limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the regex check.
  assert.equal(
    isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise(
      "ERROR: column products.ingredients does not exist",
      "select ingredients from public.products",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise(
      "column products.ingredients does not exist",
      "SELECT INGREDIENTS FROM PUBLIC.PRODUCTS",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise KEEPS a column-missing on `products.title` (a DIFFERENT, real column on the same table — a real schema regression still pages)", () => {
  // `products.title` IS a real column; if it ever regressed we absolutely want the
  // page. The pin covers the three intelligence-column names only.
  assert.equal(
    isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise(
      "column products.title does not exist",
      "select id, title from public.products",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise(
      "column public.products.handle does not exist",
      "select id, handle from public.products",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise KEEPS a column-missing error on any OTHER table (a sibling table that DOES carry these columns still pages)", () => {
  // If `product_ingredients.ingredients` regressed we absolutely want the page —
  // the pin is `products.` only, never a sibling intelligence table.
  assert.equal(
    isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise(
      "column product_ingredients.ingredients does not exist",
      "select ingredients from public.product_ingredients where product_id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise(
      "column product_benefit_selections.benefits does not exist",
      "select benefits from public.product_benefit_selections",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise KEEPS a non-SELECT statement shape on products (an INSERT/UPDATE/DELETE on products with the same message is a real code-bug and still pages)", () => {
  // INSERT / UPDATE / DELETE against products referencing a bogus intelligence
  // column is real code trying to write the table — a bug we WANT to see.
  assert.equal(
    isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise(
      "column products.ingredients does not exist",
      "insert into public.products (id, ingredients) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise(
      "column products.supplement_facts does not exist",
      "update public.products set supplement_facts = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise(
      "column products.benefits does not exist",
      "delete from public.products where benefits is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise(
      "column products.ingredients does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."products"("ingredients") VALUES ($1) RETURNING "public"."products"."id" )',
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/playbooks?select=slug,title,is_active&slug=in.(...)` against our
// `public.playbooks` table. The table exists but by design carries NO `title` column —
// the human-facing label is `name`, and every ShopCX caller (ticket-analyzer,
// action-executor, workflow-executor, sol-direction-apply) selects `name`. Foreign-owned
// surface, no lever from us — drop AT CAPTURE only when BOTH the exact column-missing
// message on `playbooks.title` AND a SELECT-lookup shape on `playbooks` (bare OR
// PostgREST CTE wrapper) are present. A column-missing on any other table, a different
// column on `playbooks` (including the real `name` / `slug` columns), or a non-SELECT
// statement still pages.

test("isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise drops the captured supabase-logs:89f4636e0ac3cc84 message+query pair (the ad hoc SELECT lookup on the exact playbooks.title column-missing shape)", () => {
  // The captured production sample: unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column playbooks.title does not exist",
      "select slug, title, is_active from public.playbooks where slug in ('a','b')",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column public.playbooks.title does not exist",
      "select slug, title, is_active from public.playbooks where slug in ('a','b')",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column playbooks.title does not exist",
      "select title from playbooks limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column playbooks.title does not exist",
      "select slug, title, is_active from public.playbooks where slug = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column playbooks.title does not exist",
      "SELECT SLUG, TITLE, IS_ACTIVE FROM PUBLIC.PLAYBOOKS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "ERROR: column playbooks.title does not exist",
      "select title from public.playbooks",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "  column playbooks.title does not exist  ",
      "   select title from public.playbooks   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"playbooks\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in
  // the pgrst_source CTE with double-quoted `"public"."playbooks"` identifiers. The
  // plain bare-SELECT regex misses this because the statement starts with `with` and
  // the FROM clause carries the quoted schema.table shape.
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column playbooks.title does not exist",
      'WITH pgrst_source AS ( SELECT "public"."playbooks"."slug", "public"."playbooks"."title", "public"."playbooks"."is_active" FROM "public"."playbooks" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column public.playbooks.title does not exist",
      'WITH pgrst_source AS (SELECT "public"."playbooks"."title" FROM "public"."playbooks")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "ERROR: column playbooks.title does not exist",
      'WITH pgrst_source AS (SELECT "public"."playbooks"."title" FROM "public"."playbooks")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise KEEPS a column-missing on a DIFFERENT playbooks column (`name` / `slug` — real column rename regressions still page)", () => {
  // `playbooks.name` IS the real human-facing label column and `playbooks.slug` IS the
  // real slug column; if either regressed we absolutely want the page. The pin is
  // `playbooks.title` only.
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column playbooks.name does not exist",
      "select slug, name, is_active from public.playbooks",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column public.playbooks.name does not exist",
      "select name from public.playbooks",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column playbooks.slug does not exist",
      "select slug from public.playbooks",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a title column still pages)", () => {
  // If any other table's `title` column regressed, we absolutely want the page — the
  // pin is `playbooks.title` only.
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column specs.title does not exist",
      "select title from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column goals.title does not exist",
      "select title from public.goals where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise KEEPS a non-SELECT statement shape on playbooks (an INSERT/UPDATE/DELETE on playbooks with the same message is a real code-bug and still pages)", () => {
  // INSERT / UPDATE / DELETE against playbooks referencing a bogus `title` column is
  // real code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column playbooks.title does not exist",
      "insert into public.playbooks (slug, title, is_active) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column playbooks.title does not exist",
      "update public.playbooks set title = $1 where slug = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column playbooks.title does not exist",
      "delete from public.playbooks where title is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column playbooks.title does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."playbooks"("slug", "title") VALUES ($1, $2) RETURNING "public"."playbooks"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column playbooks.title does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."playbooks" SET "title" = $1 WHERE "public"."playbooks"."slug" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column playbooks.title does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(
      "column playbooks.title does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/product_ingredients?select=...&order=sort_order.asc` against our
// `public.product_ingredients` table. The table exists but by design carries NO
// `sort_order` column — the actual ordering column is `display_order`. Foreign-owned
// surface, no lever from us — drop AT CAPTURE only when BOTH the exact column-missing
// message on `product_ingredients.sort_order` AND a SELECT-lookup shape on
// `product_ingredients` (bare OR PostgREST CTE wrapper) are present. A column-missing on
// any other table, a different column on `product_ingredients` (including the real
// `display_order` column), or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise drops the captured supabase-logs:b9012d5b8913efc6 message+query pair (positive drop — bare SELECT shape with the exact message)", () => {
  // The captured production sample: unqualified and public.-qualified message variants
  // over the bare SELECT-lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise(
      "column product_ingredients.sort_order does not exist",
      "select id, name, sort_order from public.product_ingredients where product_id = $1 order by sort_order asc",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise(
      "column public.product_ingredients.sort_order does not exist",
      "select sort_order from public.product_ingredients",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise(
      "column product_ingredients.sort_order does not exist",
      "select sort_order from product_ingredients limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise(
      "ERROR: column product_ingredients.sort_order does not exist",
      "select sort_order from public.product_ingredients",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"product_ingredients\" ...)` CTE wrapper form (positive drop — CTE wrapper shape)", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."product_ingredients"` identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise(
      "column product_ingredients.sort_order does not exist",
      'WITH pgrst_source AS ( SELECT "public"."product_ingredients"."id", "public"."product_ingredients"."name", "public"."product_ingredients"."sort_order" FROM "public"."product_ingredients" ORDER BY "public"."product_ingredients"."sort_order" ASC )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise(
      "column public.product_ingredients.sort_order does not exist",
      'WITH pgrst_source AS (SELECT "public"."product_ingredients"."sort_order" FROM "public"."product_ingredients")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise KEEPS a column-missing on `product_ingredients.display_order` (the REAL ordering column — a rename regression still pages)", () => {
  // `product_ingredients.display_order` IS the real ordering column (see
  // `supabase/migrations/20260420000001_product_intelligence_engine.sql` — the index is
  // `idx_product_ingredients_product ON public.product_ingredients(product_id, display_order)`).
  // If it regressed we absolutely want the page. The pin is `sort_order` only.
  assert.equal(
    isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise(
      "column product_ingredients.display_order does not exist",
      "select id, name, display_order from public.product_ingredients order by display_order asc",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise KEEPS a non-SELECT statement shape on product_ingredients (an INSERT with the same message is a real code-bug and still pages)", () => {
  // An INSERT/UPDATE/DELETE against product_ingredients referencing a bogus `sort_order`
  // column is real code trying to write the table — a bug we WANT to see, not the ad
  // hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise(
      "column product_ingredients.sort_order does not exist",
      "insert into public.product_ingredients (product_id, name, sort_order) values ($1, $2, $3)",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise KEEPS the same message on a JOIN with another table (a real code path joining product_ingredients still pages)", () => {
  // The pin is the bare SELECT-lookup on product_ingredients or its PostgREST CTE
  // wrapper — a JOIN across other tables is a real code path we own and want to see.
  assert.equal(
    isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise(
      "column product_ingredients.sort_order does not exist",
      "select pi.sort_order, p.title from public.product_ingredients pi join public.products p on p.id = pi.product_id where p.id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise KEEPS a column-missing on a DIFFERENT table (`products.sort_order` — pin is product_ingredients only)", () => {
  // A column-missing error for any OTHER table's `sort_order` (even one that we might
  // add sort_order to later) still pages — the pin is `product_ingredients.` only.
  assert.equal(
    isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise(
      "column products.sort_order does not exist",
      "select id, sort_order from public.products",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise(
      "column product_ingredients.sort_order does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise(
      "column product_ingredients.sort_order does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/daily_meta_ad_spend?select=...&date=eq.YYYY-MM-DD` against our
// `public.daily_meta_ad_spend` table. The table exists but by design carries NO `date`
// column — the actual per-day column is `snapshot_date` (see the meta-ads-integration
// migration, index `idx_meta_spend_date ON daily_meta_ad_spend(workspace_id,
// snapshot_date DESC)`), and every ShopCX caller (ad-spend-governor, acquisition-roas,
// profit-estimate, meta/performance, analytics/roas route) selects `snapshot_date`.
// Foreign-owned surface, no lever from us — drop AT CAPTURE only when BOTH the exact
// column-missing message on `daily_meta_ad_spend.date` AND a SELECT-lookup shape on
// `daily_meta_ad_spend` (bare OR PostgREST CTE wrapper) are present. A column-missing
// on any other table, a different column on `daily_meta_ad_spend` (including the real
// `snapshot_date` column), or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise drops the captured message+query pair (positive drop — bare SELECT shape with the exact message)", () => {
  // The captured production sample: unqualified and public.-qualified message variants
  // over the bare SELECT-lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "column daily_meta_ad_spend.date does not exist",
      "select date, spend_cents from public.daily_meta_ad_spend where workspace_id = $1 and date = $2",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "column public.daily_meta_ad_spend.date does not exist",
      "select date from public.daily_meta_ad_spend",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "column daily_meta_ad_spend.date does not exist",
      "select date from daily_meta_ad_spend limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "ERROR: column daily_meta_ad_spend.date does not exist",
      "select date from public.daily_meta_ad_spend",
    ),
    true,
  );
  // Case-insensitive on the query; trailing WHERE / ORDER BY / LIMIT stays the ad hoc shape.
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "column daily_meta_ad_spend.date does not exist",
      "SELECT DATE, SPEND_CENTS FROM PUBLIC.DAILY_META_AD_SPEND ORDER BY DATE DESC LIMIT 50",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "  column daily_meta_ad_spend.date does not exist  ",
      "   select date from public.daily_meta_ad_spend   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"daily_meta_ad_spend\" ...)` CTE wrapper form (positive drop — CTE wrapper shape)", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."daily_meta_ad_spend"` identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "column daily_meta_ad_spend.date does not exist",
      'WITH pgrst_source AS ( SELECT "public"."daily_meta_ad_spend"."date", "public"."daily_meta_ad_spend"."spend_cents" FROM "public"."daily_meta_ad_spend" ORDER BY "public"."daily_meta_ad_spend"."date" DESC )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "column public.daily_meta_ad_spend.date does not exist",
      'WITH pgrst_source AS (SELECT "public"."daily_meta_ad_spend"."date" FROM "public"."daily_meta_ad_spend")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "ERROR: column daily_meta_ad_spend.date does not exist",
      'WITH pgrst_source AS (SELECT "public"."daily_meta_ad_spend"."date" FROM "public"."daily_meta_ad_spend")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise KEEPS a column-missing on `daily_meta_ad_spend.snapshot_date` (the REAL per-day column — a rename regression still pages)", () => {
  // `daily_meta_ad_spend.snapshot_date` IS the real per-day column (the index is
  // `idx_meta_spend_date ON daily_meta_ad_spend(workspace_id, snapshot_date DESC)`). If
  // it regressed we absolutely want the page. The pin is `date` only.
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "column daily_meta_ad_spend.snapshot_date does not exist",
      "select snapshot_date, spend_cents from public.daily_meta_ad_spend order by snapshot_date desc",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "column public.daily_meta_ad_spend.snapshot_date does not exist",
      "select snapshot_date from public.daily_meta_ad_spend",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise KEEPS a column-missing on a DIFFERENT table (`orders.date` — pin is daily_meta_ad_spend only)", () => {
  // A column-missing error for any OTHER table's `date` column still pages — the pin is
  // `daily_meta_ad_spend.` only.
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "column orders.date does not exist",
      "select id, date from public.orders",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "column daily_google_ad_spend.date does not exist",
      "select date from public.daily_google_ad_spend",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise KEEPS a non-SELECT statement shape on daily_meta_ad_spend (an INSERT / UPDATE / DELETE with the same message is a real code-bug and still pages)", () => {
  // An INSERT/UPDATE/DELETE against daily_meta_ad_spend referencing a bogus `date`
  // column is real code trying to write the table — a bug we WANT to see, not the ad
  // hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "column daily_meta_ad_spend.date does not exist",
      "insert into public.daily_meta_ad_spend (workspace_id, date, spend_cents) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "column daily_meta_ad_spend.date does not exist",
      "update public.daily_meta_ad_spend set date = $1 where workspace_id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "column daily_meta_ad_spend.date does not exist",
      "delete from public.daily_meta_ad_spend where date < $1",
    ),
    false,
  );
  // The PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "column daily_meta_ad_spend.date does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."daily_meta_ad_spend"("workspace_id", "date", "spend_cents") VALUES ($1, $2, $3) RETURNING "public"."daily_meta_ad_spend"."id" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise KEEPS the same message on a JOIN with another table (a real code path joining daily_meta_ad_spend still pages)", () => {
  // The pin is the bare SELECT-lookup on daily_meta_ad_spend or its PostgREST CTE
  // wrapper — a JOIN across other tables is a real code path we own and want to see.
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "column daily_meta_ad_spend.date does not exist",
      "select d.date, w.slug from public.daily_meta_ad_spend d join public.workspaces w on w.id = d.workspace_id where w.slug = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "column daily_meta_ad_spend.date does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(
      "column daily_meta_ad_spend.date does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise ──
// A foreign / stale PostgREST direct-REST client / hand-typed URL reads
// `/rest/v1/qb_amazon_sales_snapshots?select=gross_revenue_cents,units,updated_at&...` against
// our `public.qb_amazon_sales_snapshots` table. The table exists (qb-close Amazon
// sales-receipt / COGS source, migration 20261213120001_qb_close_source_tables.sql) but by
// design carries NO `gross_revenue_cents` column — the real per-ASIN/per-day money columns
// are `revenue` (numeric(14,2)) plus `recurring_revenue` / `sns_checkout_revenue` /
// `one_time_revenue`, and every ShopCX caller (`src/lib/qb-close/sync-amazon-sales.ts`,
// `src/lib/qb-close/month-end.ts`) selects on `units_shipped` / `revenue`.
// `gross_revenue_cents` lives on the unrelated `daily_amazon_product_snapshots` /
// `daily_amazon_order_snapshots` family. Foreign-owned surface, no lever from us — drop AT
// CAPTURE only when BOTH the exact column-missing message on
// `qb_amazon_sales_snapshots.gross_revenue_cents` AND a SELECT-lookup shape on
// `qb_amazon_sales_snapshots` (bare OR PostgREST CTE wrapper) are present. A column-missing
// on any other table, a different column on `qb_amazon_sales_snapshots`, or a non-SELECT
// statement still pages.

test("isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise drops the exact failing sample (positive drop — bare SELECT shape with the exact message)", () => {
  // The captured production sample: a bare SELECT-lookup on the table for the missing
  // column, in both unqualified and public.-qualified message variants.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise(
      "column qb_amazon_sales_snapshots.gross_revenue_cents does not exist",
      "select gross_revenue_cents, units, updated_at from public.qb_amazon_sales_snapshots where workspace_id = $1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise(
      "column public.qb_amazon_sales_snapshots.gross_revenue_cents does not exist",
      "select gross_revenue_cents from public.qb_amazon_sales_snapshots",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise(
      "column qb_amazon_sales_snapshots.gross_revenue_cents does not exist",
      "select gross_revenue_cents from qb_amazon_sales_snapshots limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise(
      "ERROR: column qb_amazon_sales_snapshots.gross_revenue_cents does not exist",
      "select gross_revenue_cents from public.qb_amazon_sales_snapshots",
    ),
    true,
  );
  // The PostgREST CTE wrapper form (direct-REST wire shape) is dropped too.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise(
      "column qb_amazon_sales_snapshots.gross_revenue_cents does not exist",
      'WITH pgrst_source AS ( SELECT "public"."qb_amazon_sales_snapshots"."gross_revenue_cents", "public"."qb_amazon_sales_snapshots"."units", "public"."qb_amazon_sales_snapshots"."updated_at" FROM "public"."qb_amazon_sales_snapshots" )',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise KEEPS a column-missing on qb_amazon_sales_snapshots for a DIFFERENT column (e.g. `revenue` regression — the real money column)", () => {
  // `revenue` (numeric) IS the real per-ASIN/per-day money column. If it regressed we
  // absolutely want the page. The pin is `gross_revenue_cents` only.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise(
      "column qb_amazon_sales_snapshots.revenue does not exist",
      "select revenue, units_shipped from public.qb_amazon_sales_snapshots",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise(
      "column qb_amazon_sales_snapshots.units_shipped does not exist",
      "select units_shipped from public.qb_amazon_sales_snapshots",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise KEEPS a non-SELECT statement shape on qb_amazon_sales_snapshots (an INSERT with the same message is a real code-bug and still pages)", () => {
  // An INSERT/UPDATE/DELETE against qb_amazon_sales_snapshots referencing a bogus
  // `gross_revenue_cents` column is real code trying to write the table — a bug we WANT
  // to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise(
      "column qb_amazon_sales_snapshots.gross_revenue_cents does not exist",
      "insert into public.qb_amazon_sales_snapshots (workspace_id, asin, sale_date, gross_revenue_cents) values ($1, $2, $3, $4)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise(
      "column qb_amazon_sales_snapshots.gross_revenue_cents does not exist",
      "update public.qb_amazon_sales_snapshots set gross_revenue_cents = $1 where workspace_id = $2",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise(
      "column qb_amazon_sales_snapshots.gross_revenue_cents does not exist",
      "",
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise ──
// A foreign / stale PostgREST direct-REST client / hand-typed URL reads
// `/rest/v1/qb_amazon_sales_snapshots?select=sku,...` against our
// `public.qb_amazon_sales_snapshots` table. The table exists (qb-close Amazon
// sales-receipt / COGS source, migration 20261213120001_qb_close_source_tables.sql) but
// by design carries NO `sku` column — the real merchant-SKU column is `seller_sku`
// (plus `asin` for the Amazon identifier), and every ShopCX caller
// (`src/lib/qb-close/sync-amazon-sales.ts`, `src/lib/qb-close/month-end.ts`) selects on
// `seller_sku` / `asin`. Foreign-owned surface, no lever from us — drop AT CAPTURE only
// when BOTH the exact column-missing message on `qb_amazon_sales_snapshots.sku` AND a
// SELECT-lookup shape on `qb_amazon_sales_snapshots` (bare OR PostgREST CTE wrapper)
// are present. A column-missing on any other table, a different column on
// `qb_amazon_sales_snapshots` (including the real `seller_sku` / `asin` columns), a
// non-SELECT statement, or a JOIN still pages.

test("isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise drops the exact failing sample (positive drop — bare SELECT shape with the exact message)", () => {
  // The captured production sample: a bare SELECT-lookup on the table for the missing
  // column, in both unqualified and public.-qualified message variants.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column qb_amazon_sales_snapshots.sku does not exist",
      "select sku, units, updated_at from public.qb_amazon_sales_snapshots where workspace_id = $1",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column public.qb_amazon_sales_snapshots.sku does not exist",
      "select sku from public.qb_amazon_sales_snapshots",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column qb_amazon_sales_snapshots.sku does not exist",
      "select sku from qb_amazon_sales_snapshots limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "ERROR: column qb_amazon_sales_snapshots.sku does not exist",
      "select sku from public.qb_amazon_sales_snapshots",
    ),
    true,
  );
  // Case-insensitive on the query; trailing WHERE / ORDER BY / LIMIT stays the ad hoc shape.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column qb_amazon_sales_snapshots.sku does not exist",
      "SELECT SKU, UNITS FROM PUBLIC.QB_AMAZON_SALES_SNAPSHOTS ORDER BY UPDATED_AT DESC LIMIT 50",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "  column qb_amazon_sales_snapshots.sku does not exist  ",
      "   select sku from public.qb_amazon_sales_snapshots   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"qb_amazon_sales_snapshots\" ...)` CTE wrapper form (positive drop — CTE wrapper shape)", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."qb_amazon_sales_snapshots"` identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column qb_amazon_sales_snapshots.sku does not exist",
      'WITH pgrst_source AS ( SELECT "public"."qb_amazon_sales_snapshots"."sku", "public"."qb_amazon_sales_snapshots"."units", "public"."qb_amazon_sales_snapshots"."updated_at" FROM "public"."qb_amazon_sales_snapshots" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column public.qb_amazon_sales_snapshots.sku does not exist",
      'WITH pgrst_source AS (SELECT "public"."qb_amazon_sales_snapshots"."sku" FROM "public"."qb_amazon_sales_snapshots")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "ERROR: column qb_amazon_sales_snapshots.sku does not exist",
      'WITH pgrst_source AS (SELECT "public"."qb_amazon_sales_snapshots"."sku" FROM "public"."qb_amazon_sales_snapshots")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise KEEPS a column-missing on `qb_amazon_sales_snapshots.seller_sku` / `asin` / `revenue` (the REAL columns — a rename regression still pages)", () => {
  // `seller_sku` IS the real merchant-SKU column, `asin` IS the Amazon identifier,
  // `revenue` IS the real per-ASIN/per-day money column. If any regressed we absolutely
  // want the page. The pin is `sku` only.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column qb_amazon_sales_snapshots.seller_sku does not exist",
      "select seller_sku, revenue from public.qb_amazon_sales_snapshots",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column qb_amazon_sales_snapshots.asin does not exist",
      "select asin from public.qb_amazon_sales_snapshots",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column public.qb_amazon_sales_snapshots.revenue does not exist",
      "select revenue from public.qb_amazon_sales_snapshots",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise KEEPS a column-missing on a DIFFERENT table (`products.sku` — pin is qb_amazon_sales_snapshots only)", () => {
  // A column-missing error for any OTHER table's `sku` column still pages — the pin is
  // `qb_amazon_sales_snapshots.` only.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column products.sku does not exist",
      "select id, sku from public.products",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column product_variants.sku does not exist",
      "select sku from public.product_variants",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise KEEPS a non-SELECT statement shape on qb_amazon_sales_snapshots (an INSERT / UPDATE / DELETE with the same message is a real code-bug and still pages)", () => {
  // An INSERT/UPDATE/DELETE against qb_amazon_sales_snapshots referencing a bogus `sku`
  // column is real code trying to write the table — a bug we WANT to see, not the ad
  // hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column qb_amazon_sales_snapshots.sku does not exist",
      "insert into public.qb_amazon_sales_snapshots (workspace_id, asin, sale_date, sku) values ($1, $2, $3, $4)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column qb_amazon_sales_snapshots.sku does not exist",
      "update public.qb_amazon_sales_snapshots set sku = $1 where workspace_id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column qb_amazon_sales_snapshots.sku does not exist",
      "delete from public.qb_amazon_sales_snapshots where sku = $1",
    ),
    false,
  );
  // The PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column qb_amazon_sales_snapshots.sku does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."qb_amazon_sales_snapshots"("workspace_id", "asin", "sku") VALUES ($1, $2, $3) RETURNING "public"."qb_amazon_sales_snapshots"."id" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise KEEPS the same message on a JOIN with another table (a real code path joining qb_amazon_sales_snapshots still pages)", () => {
  // The pin is the bare SELECT-lookup on qb_amazon_sales_snapshots or its PostgREST CTE
  // wrapper — a JOIN across other tables is a real code path we own and want to see.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column qb_amazon_sales_snapshots.sku does not exist",
      "select s.sku, p.title from public.qb_amazon_sales_snapshots s join public.products p on p.id = s.product_id where s.workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column qb_amazon_sales_snapshots.sku does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingQbAmazonSalesSkuAdhocNoise(
      "column qb_amazon_sales_snapshots.sku does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/loyalty_members?select=lifetime_points&...` against our `public.loyalty_members`
// table. The table exists but by design carries NO `lifetime_points` column — the real
// running-total column is `total_earned` (with `points_balance` for the current spendable
// balance), and every ShopCX caller (`src/app/api/loyalty/**`, `src/lib/action-executor.ts`)
// reads those two. Foreign-owned surface, no lever from us — drop AT CAPTURE only when
// BOTH the exact column-missing message on `loyalty_members.lifetime_points` AND a
// SELECT-lookup shape on `loyalty_members` (bare OR PostgREST CTE wrapper) are present. A
// column-missing on any other table, a different column on `loyalty_members` (including
// the real `total_earned` / `points_balance` columns), or a non-SELECT statement still
// pages.

test("isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise drops the captured message+query pair (positive drop — bare SELECT shape with the exact message)", () => {
  // The captured production sample: unqualified and public.-qualified message variants
  // over the bare SELECT-lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "column loyalty_members.lifetime_points does not exist",
      "select lifetime_points from public.loyalty_members where workspace_id = $1 and customer_id = $2",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "column public.loyalty_members.lifetime_points does not exist",
      "select lifetime_points from public.loyalty_members",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "column loyalty_members.lifetime_points does not exist",
      "select lifetime_points from loyalty_members limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "ERROR: column loyalty_members.lifetime_points does not exist",
      "select lifetime_points from public.loyalty_members",
    ),
    true,
  );
  // Case-insensitive on the query; trailing WHERE / ORDER BY / LIMIT stays the ad hoc shape.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "column loyalty_members.lifetime_points does not exist",
      "SELECT LIFETIME_POINTS, POINTS_BALANCE FROM PUBLIC.LOYALTY_MEMBERS ORDER BY LIFETIME_POINTS DESC LIMIT 50",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "  column loyalty_members.lifetime_points does not exist  ",
      "   select lifetime_points from public.loyalty_members   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"loyalty_members\" ...)` CTE wrapper form (positive drop — CTE wrapper shape)", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."loyalty_members"` identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "column loyalty_members.lifetime_points does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loyalty_members"."lifetime_points", "public"."loyalty_members"."customer_id" FROM "public"."loyalty_members" ORDER BY "public"."loyalty_members"."lifetime_points" DESC )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "column public.loyalty_members.lifetime_points does not exist",
      'WITH pgrst_source AS (SELECT "public"."loyalty_members"."lifetime_points" FROM "public"."loyalty_members")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "ERROR: column loyalty_members.lifetime_points does not exist",
      'WITH pgrst_source AS (SELECT "public"."loyalty_members"."lifetime_points" FROM "public"."loyalty_members")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise KEEPS a column-missing on `loyalty_members.total_earned` / `loyalty_members.points_balance` (the REAL loyalty columns — a rename regression still pages)", () => {
  // `total_earned` IS the real running-total column and `points_balance` IS the real
  // current-balance column on `loyalty_members`. If either regressed we absolutely want
  // the page. The pin is `lifetime_points` only.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "column loyalty_members.total_earned does not exist",
      "select total_earned, points_balance from public.loyalty_members",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "column public.loyalty_members.points_balance does not exist",
      "select points_balance from public.loyalty_members",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise KEEPS a column-missing on a DIFFERENT table (`customers.lifetime_points` — pin is loyalty_members only)", () => {
  // A column-missing error for any OTHER table's `lifetime_points` column still pages —
  // the pin is `loyalty_members.` only.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "column customers.lifetime_points does not exist",
      "select id, lifetime_points from public.customers",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "column loyalty_transactions.lifetime_points does not exist",
      "select lifetime_points from public.loyalty_transactions",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise KEEPS a non-SELECT statement shape on loyalty_members (an INSERT / UPDATE / DELETE with the same message is a real code-bug and still pages)", () => {
  // An INSERT/UPDATE/DELETE against loyalty_members referencing a bogus `lifetime_points`
  // column is real code trying to write the table — a bug we WANT to see, not the ad hoc
  // read.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "column loyalty_members.lifetime_points does not exist",
      "insert into public.loyalty_members (workspace_id, customer_id, lifetime_points) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "column loyalty_members.lifetime_points does not exist",
      "update public.loyalty_members set lifetime_points = $1 where customer_id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "column loyalty_members.lifetime_points does not exist",
      "delete from public.loyalty_members where lifetime_points < $1",
    ),
    false,
  );
  // The PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "column loyalty_members.lifetime_points does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."loyalty_members"("workspace_id", "customer_id", "lifetime_points") VALUES ($1, $2, $3) RETURNING "public"."loyalty_members"."id" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise KEEPS the same message on a JOIN with another table (a real code path joining loyalty_members still pages)", () => {
  // The pin is the bare SELECT-lookup on loyalty_members or its PostgREST CTE wrapper —
  // a JOIN across other tables is a real code path we own and want to see.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "column loyalty_members.lifetime_points does not exist",
      "select m.lifetime_points, c.email from public.loyalty_members m join public.customers c on c.id = m.customer_id where c.workspace_id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "column loyalty_members.lifetime_points does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(
      "column loyalty_members.lifetime_points does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/tickets?select=...&assigned_agent=eq.<name>` against our `public.tickets`
// table. The table exists but by design carries NO `assigned_agent` column — the actual
// assignee column is `assigned_to_member_id` (a UUID FK to `workspace_members`).
// Foreign-owned surface, no lever from us — drop AT CAPTURE only when BOTH the exact
// column-missing message on `tickets.assigned_agent` AND a SELECT-lookup shape on
// `tickets` (bare OR PostgREST CTE wrapper) are present. A column-missing on any other
// table, a different column on `tickets` (including the real `assigned_to_member_id`
// column), or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise drops the captured message+query pair (positive drop — bare SELECT shape with the exact message)", () => {
  // The captured production sample: unqualified and public.-qualified message variants
  // over the bare SELECT-lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "column tickets.assigned_agent does not exist",
      "select id, assigned_agent from public.tickets where workspace_id = $1 and assigned_agent = $2",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "column public.tickets.assigned_agent does not exist",
      "select assigned_agent from public.tickets",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "column tickets.assigned_agent does not exist",
      "select assigned_agent from tickets limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "ERROR: column tickets.assigned_agent does not exist",
      "select assigned_agent from public.tickets",
    ),
    true,
  );
  // Case-insensitive on the query; trailing WHERE / ORDER BY / LIMIT stays the ad hoc shape.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "column tickets.assigned_agent does not exist",
      "SELECT ID, ASSIGNED_AGENT FROM PUBLIC.TICKETS ORDER BY CREATED_AT DESC LIMIT 50",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "  column tickets.assigned_agent does not exist  ",
      "   select assigned_agent from public.tickets   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"tickets\" ...)` CTE wrapper form (positive drop — CTE wrapper shape)", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."tickets"` identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "column tickets.assigned_agent does not exist",
      'WITH pgrst_source AS ( SELECT "public"."tickets"."id", "public"."tickets"."assigned_agent" FROM "public"."tickets" ORDER BY "public"."tickets"."created_at" DESC )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "column public.tickets.assigned_agent does not exist",
      'WITH pgrst_source AS (SELECT "public"."tickets"."assigned_agent" FROM "public"."tickets")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "ERROR: column tickets.assigned_agent does not exist",
      'WITH pgrst_source AS (SELECT "public"."tickets"."assigned_agent" FROM "public"."tickets")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise KEEPS a column-missing on `tickets.assigned_to_member_id` (the REAL assignee column — a rename regression still pages)", () => {
  // `tickets.assigned_to_member_id` IS the real assignee column (UUID FK to
  // workspace_members). If it regressed we absolutely want the page. The pin is
  // `assigned_agent` only.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "column tickets.assigned_to_member_id does not exist",
      "select assigned_to_member_id from public.tickets order by created_at desc",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "column public.tickets.assigned_to_member_id does not exist",
      "select assigned_to_member_id from public.tickets",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise KEEPS a column-missing on a DIFFERENT table (`orders.assigned_agent` — pin is tickets only)", () => {
  // A column-missing error for any OTHER table's `assigned_agent` column still pages —
  // the pin is `tickets.` only.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "column orders.assigned_agent does not exist",
      "select id, assigned_agent from public.orders",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "column ticket_messages.assigned_agent does not exist",
      "select assigned_agent from public.ticket_messages",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise KEEPS a non-SELECT statement shape on tickets (an INSERT / UPDATE / DELETE with the same message is a real code-bug and still pages)", () => {
  // An INSERT/UPDATE/DELETE against tickets referencing a bogus `assigned_agent`
  // column is real code trying to write the table — a bug we WANT to see, not the ad
  // hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "column tickets.assigned_agent does not exist",
      "insert into public.tickets (workspace_id, assigned_agent) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "column tickets.assigned_agent does not exist",
      "update public.tickets set assigned_agent = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "column tickets.assigned_agent does not exist",
      "delete from public.tickets where assigned_agent = $1",
    ),
    false,
  );
  // The PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "column tickets.assigned_agent does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."tickets"("workspace_id", "assigned_agent") VALUES ($1, $2) RETURNING "public"."tickets"."id" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise KEEPS the same message on a JOIN with another table (a real code path joining tickets still pages)", () => {
  // The pin is the bare SELECT-lookup on tickets or its PostgREST CTE wrapper — a JOIN
  // across other tables is a real code path we own and want to see.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "column tickets.assigned_agent does not exist",
      "select t.id, t.assigned_agent, w.slug from public.tickets t join public.workspaces w on w.id = t.workspace_id where w.slug = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "column tickets.assigned_agent does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(
      "column tickets.assigned_agent does not exist",
      null,
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/tickets?select=...&playbook_id=eq.<id>` against our `public.tickets` table.
// The table exists but by design carries NO `playbook_id` column — the real column is
// `active_playbook_id`. Foreign-owned surface, no lever from us — drop AT CAPTURE only
// when BOTH the exact column-missing message on `tickets.playbook_id` AND a SELECT-lookup
// shape on `tickets` (bare OR PostgREST CTE wrapper) are present. A column-missing on any
// other table, a different column on `tickets` (including the real `active_playbook_id`),
// a non-SELECT statement, or a JOIN still pages.

test("isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise drops the captured message+query pair (positive drop — bare SELECT shape with the exact message)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "column tickets.playbook_id does not exist",
      "select id, playbook_id from public.tickets where workspace_id = $1 and playbook_id = $2",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "column public.tickets.playbook_id does not exist",
      "select playbook_id from public.tickets",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "column tickets.playbook_id does not exist",
      "select playbook_id from tickets limit 10",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "ERROR: column tickets.playbook_id does not exist",
      "select playbook_id from public.tickets",
    ),
    true,
  );
  // Case-insensitive on the query; trailing WHERE / ORDER BY / LIMIT stays the ad hoc shape.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "column tickets.playbook_id does not exist",
      "SELECT ID, PLAYBOOK_ID FROM PUBLIC.TICKETS ORDER BY CREATED_AT DESC LIMIT 50",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "  column tickets.playbook_id does not exist  ",
      "   select playbook_id from public.tickets   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"tickets\" ...)` CTE wrapper form (positive drop — CTE wrapper shape)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "column tickets.playbook_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."tickets"."id", "public"."tickets"."playbook_id" FROM "public"."tickets" ORDER BY "public"."tickets"."created_at" DESC )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "column public.tickets.playbook_id does not exist",
      'WITH pgrst_source AS (SELECT "public"."tickets"."playbook_id" FROM "public"."tickets")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise KEEPS a column-missing on `tickets.active_playbook_id` (the REAL column — a rename regression still pages)", () => {
  // `tickets.active_playbook_id` IS the real column. If it regressed we want the page.
  // The pin is the abbreviated `playbook_id` only.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "column tickets.active_playbook_id does not exist",
      "select active_playbook_id from public.tickets order by created_at desc",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "column public.tickets.active_playbook_id does not exist",
      "select active_playbook_id from public.tickets",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise KEEPS a column-missing on a DIFFERENT table (`playbooks.playbook_id` — pin is tickets only)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "column playbooks.playbook_id does not exist",
      "select id, playbook_id from public.playbooks",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise KEEPS a non-SELECT statement shape on tickets (INSERT / UPDATE / DELETE is a real code-bug and still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "column tickets.playbook_id does not exist",
      "insert into public.tickets (workspace_id, playbook_id) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "column tickets.playbook_id does not exist",
      "update public.tickets set playbook_id = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "column tickets.playbook_id does not exist",
      "delete from public.tickets where playbook_id = $1",
    ),
    false,
  );
  // The PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "column tickets.playbook_id does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."tickets"("workspace_id", "playbook_id") VALUES ($1, $2) RETURNING "public"."tickets"."id" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise KEEPS the same message on a JOIN with another table (a real code path joining tickets still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "column tickets.playbook_id does not exist",
      "select t.id, t.playbook_id, w.slug from public.tickets t join public.workspaces w on w.id = t.workspace_id where w.slug = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row stays captured.
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "column tickets.playbook_id does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketsPlaybookIdDirectRestColumnNoise(
      "column tickets.playbook_id does not exist",
      null,
    ),
    false,
  );
});

// ── isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation ──
// The DB-level `dashboard_notifications_dedupe_key_open_uniq` partial UNIQUE index
// (migration 20261211120000) is INTENTIONALLY the last-resort backstop for the escalation
// mint path in platform-director.ts — a concurrent second insert for the same open
// dedupe_key rejects at 23505 and the app catch bumps the winning card. Drop AT CAPTURE
// only when BOTH the exact unique-violation message on THIS constraint AND the
// INSERT-INTO-dashboard_notifications shape are present. A 23505 on any other constraint,
// or a 23505 on this constraint via a non-INSERT shape, still pages.

test("isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation drops the captured supabase-logs:bbd5f21ef9289c31 message+query pair (the expected 23505 on our own INSERT INTO dashboard_notifications)", () => {
  // The captured production sample: Postgres's canonical 23505 shape (with the ERROR:
  // prefix stripped) + the INSERT INTO "public"."dashboard_notifications" the mint path
  // in platform-director.ts's `escalateDiagnosisToCeo` emits.
  assert.equal(
    isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation(
      'duplicate key value violates unique constraint "dashboard_notifications_dedupe_key_open_uniq"',
      'insert into "public"."dashboard_notifications" ("workspace_id", "type", "metadata") values ($1, $2, $3)',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation(
      'ERROR: duplicate key value violates unique constraint "dashboard_notifications_dedupe_key_open_uniq"',
      'insert into "public"."dashboard_notifications" ("workspace_id", "type", "metadata") values ($1, $2, $3)',
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation(
      'duplicate key value violates unique constraint "dashboard_notifications_dedupe_key_open_uniq"',
      'INSERT INTO "public"."dashboard_notifications" ("workspace_id", "type") VALUES ($1, $2)',
    ),
    true,
  );
  // Leading / trailing whitespace on both is tolerated.
  assert.equal(
    isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation(
      '  duplicate key value violates unique constraint "dashboard_notifications_dedupe_key_open_uniq"  ',
      '   insert into "public"."dashboard_notifications" ("workspace_id") values ($1)   ',
    ),
    true,
  );
});

test("isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation KEEPS a 23505 on any OTHER unique constraint (a real product-schema regression still pages)", () => {
  // The pin is `dashboard_notifications_dedupe_key_open_uniq` only — any other unique
  // index that regresses is a bug we absolutely want to see.
  assert.equal(
    isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation(
      'duplicate key value violates unique constraint "dashboard_notifications_pkey"',
      'insert into "public"."dashboard_notifications" ("id", "workspace_id") values ($1, $2)',
    ),
    false,
  );
  assert.equal(
    isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation(
      'duplicate key value violates unique constraint "specs_slug_workspace_uniq"',
      'insert into "public"."specs" ("slug", "workspace_id") values ($1, $2)',
    ),
    false,
  );
  assert.equal(
    isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation(
      'duplicate key value violates unique constraint "workspaces_slug_uniq"',
      'insert into "public"."workspaces" ("slug") values ($1)',
    ),
    false,
  );
});

test("isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation KEEPS a 23505 on this constraint via a non-INSERT shape (COPY replay / pg_dump load / UPDATE ... on conflict still pages)", () => {
  // The pin is the INSERT INTO "public"."dashboard_notifications" mint shape — a
  // different statement that trips the same partial index is a different caller class
  // and stays captured.
  assert.equal(
    isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation(
      'duplicate key value violates unique constraint "dashboard_notifications_dedupe_key_open_uniq"',
      'copy public.dashboard_notifications from stdin',
    ),
    false,
  );
  assert.equal(
    isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation(
      'duplicate key value violates unique constraint "dashboard_notifications_dedupe_key_open_uniq"',
      'update "public"."dashboard_notifications" set "dismissed" = false where "id" = $1',
    ),
    false,
  );
  // A bare SELECT (an operator running an EXPLAIN or similar) is not the mint path either.
  assert.equal(
    isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation(
      'duplicate key value violates unique constraint "dashboard_notifications_dedupe_key_open_uniq"',
      'select 1 from "public"."dashboard_notifications" where dismissed = false',
    ),
    false,
  );
});

test("isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation returns false on empty / nullish input", () => {
  assert.equal(isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation(null, null), false);
  assert.equal(isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation(undefined, undefined), false);
  assert.equal(isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation("", ""), false);
  // Empty query — even with the exact message we cannot confirm the mint shape, so the
  // row stays captured.
  assert.equal(
    isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation(
      'duplicate key value violates unique constraint "dashboard_notifications_dedupe_key_open_uniq"',
      "",
    ),
    false,
  );
  assert.equal(
    isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation(
      'duplicate key value violates unique constraint "dashboard_notifications_dedupe_key_open_uniq"',
      null,
    ),
    false,
  );
});

// ── isExpectedBillingForecastsPendingUniqViolation ──
// The DB-level `idx_billing_forecasts_pending` partial UNIQUE index is INTENTIONALLY the
// last-resort backstop for the `createForecast` path in billing-forecast.ts — a concurrent
// second insert for the same (workspace, contract) pending pair rejects at 23505 and the
// app catch converges on the winning row. Drop AT CAPTURE only when BOTH the exact
// unique-violation message on THIS constraint AND the INSERT-INTO-billing_forecasts shape
// are present. A 23505 on any other constraint, or a 23505 on this constraint via a
// non-INSERT shape, still pages.

test("isExpectedBillingForecastsPendingUniqViolation drops the expected 23505 on our own INSERT INTO billing_forecasts", () => {
  // The captured production sample: Postgres's canonical 23505 shape (with the ERROR:
  // prefix stripped) + the INSERT INTO "public"."billing_forecasts" the createForecast
  // path in billing-forecast.ts emits.
  assert.equal(
    isExpectedBillingForecastsPendingUniqViolation(
      'duplicate key value violates unique constraint "idx_billing_forecasts_pending"',
      'insert into "public"."billing_forecasts" ("workspace_id", "shopify_contract_id", "status") values ($1, $2, $3)',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isExpectedBillingForecastsPendingUniqViolation(
      'ERROR: duplicate key value violates unique constraint "idx_billing_forecasts_pending"',
      'insert into "public"."billing_forecasts" ("workspace_id", "shopify_contract_id") values ($1, $2)',
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isExpectedBillingForecastsPendingUniqViolation(
      'duplicate key value violates unique constraint "idx_billing_forecasts_pending"',
      'INSERT INTO "public"."billing_forecasts" ("workspace_id", "shopify_contract_id") VALUES ($1, $2)',
    ),
    true,
  );
  // Leading / trailing whitespace on both is tolerated.
  assert.equal(
    isExpectedBillingForecastsPendingUniqViolation(
      '  duplicate key value violates unique constraint "idx_billing_forecasts_pending"  ',
      '   insert into "public"."billing_forecasts" ("workspace_id") values ($1)   ',
    ),
    true,
  );
});

test("isExpectedBillingForecastsPendingUniqViolation KEEPS a 23505 on any OTHER unique constraint (a real product-schema regression still pages)", () => {
  // The pin is `idx_billing_forecasts_pending` only — any other unique index that
  // regresses is a bug we absolutely want to see.
  assert.equal(
    isExpectedBillingForecastsPendingUniqViolation(
      'duplicate key value violates unique constraint "billing_forecasts_pkey"',
      'insert into "public"."billing_forecasts" ("id", "workspace_id") values ($1, $2)',
    ),
    false,
  );
  assert.equal(
    isExpectedBillingForecastsPendingUniqViolation(
      'duplicate key value violates unique constraint "dashboard_notifications_dedupe_key_open_uniq"',
      'insert into "public"."dashboard_notifications" ("workspace_id", "type") values ($1, $2)',
    ),
    false,
  );
  assert.equal(
    isExpectedBillingForecastsPendingUniqViolation(
      'duplicate key value violates unique constraint "specs_slug_workspace_uniq"',
      'insert into "public"."specs" ("slug", "workspace_id") values ($1, $2)',
    ),
    false,
  );
});

test("isExpectedBillingForecastsPendingUniqViolation KEEPS a 23505 on this constraint via a non-INSERT shape (COPY replay / pg_dump load / UPDATE ... on conflict still pages)", () => {
  // The pin is the INSERT INTO "public"."billing_forecasts" mint shape — a different
  // statement that trips the same partial index is a different caller class and stays
  // captured.
  assert.equal(
    isExpectedBillingForecastsPendingUniqViolation(
      'duplicate key value violates unique constraint "idx_billing_forecasts_pending"',
      'copy public.billing_forecasts from stdin',
    ),
    false,
  );
  assert.equal(
    isExpectedBillingForecastsPendingUniqViolation(
      'duplicate key value violates unique constraint "idx_billing_forecasts_pending"',
      'update "public"."billing_forecasts" set "status" = $1 where "id" = $2',
    ),
    false,
  );
  // A bare SELECT (an operator running an EXPLAIN or similar) is not the mint path either.
  assert.equal(
    isExpectedBillingForecastsPendingUniqViolation(
      'duplicate key value violates unique constraint "idx_billing_forecasts_pending"',
      'select 1 from "public"."billing_forecasts" where status = \'pending\'',
    ),
    false,
  );
});

test("isExpectedBillingForecastsPendingUniqViolation returns false on empty / nullish input", () => {
  assert.equal(isExpectedBillingForecastsPendingUniqViolation(null, null), false);
  assert.equal(isExpectedBillingForecastsPendingUniqViolation(undefined, undefined), false);
  assert.equal(isExpectedBillingForecastsPendingUniqViolation("", ""), false);
  // Empty query — even with the exact message we cannot confirm the mint shape, so the
  // row stays captured.
  assert.equal(
    isExpectedBillingForecastsPendingUniqViolation(
      'duplicate key value violates unique constraint "idx_billing_forecasts_pending"',
      "",
    ),
    false,
  );
  assert.equal(
    isExpectedBillingForecastsPendingUniqViolation(
      'duplicate key value violates unique constraint "idx_billing_forecasts_pending"',
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

// ── isForeignSupabasePostgresMissingTicketMessagesSenderTypeAdhocNoise ──
// Ad hoc `select ... sender_type ... from public.ticket_messages` lookup by an external
// tool (Supabase Studio table editor, foreign SQL client, third-party integration) — or
// the PostgREST CTE wrapper the same client emits. Our `ticket_messages` table has never
// carried a `sender_type` column, so the column-missing ERROR is repair work for a query
// we don't own (Control Tower signature `supabase-logs:68e241545842ebf7`). Narrowly
// gated: a column-missing on a live `ticket_messages` column, or on `sender_type` for
// any other table, still surfaces / pages on first sighting.

test("isForeignSupabasePostgresMissingTicketMessagesSenderTypeAdhocNoise drops the exact sample from signature supabase-logs:68e241545842ebf7", () => {
  // The captured sample: bare SELECT-lookup shape on public.ticket_messages naming a
  // column that has never existed in our schema.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesSenderTypeAdhocNoise(
      "column ticket_messages.sender_type does not exist",
      "select id, sender_type, sender_name, internal from public.ticket_messages",
    ),
    true,
  );
  // PostgREST CTE wrapper form — same foreign-owned read via the REST endpoint.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesSenderTypeAdhocNoise(
      "column ticket_messages.sender_type does not exist",
      'with pgrst_source as ( select "id", "sender_type" from "public"."ticket_messages" limit 100 ) select * from pgrst_source',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix + `public.` qualifier on the column name are tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesSenderTypeAdhocNoise(
      "ERROR: column public.ticket_messages.sender_type does not exist",
      "select sender_type from public.ticket_messages",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingTicketMessagesSenderTypeAdhocNoise KEEPS a column-missing error for a DIFFERENT column on ticket_messages (a real product-schema regression still pages)", () => {
  // A missing `body` / `author_type` / `created_at` on ticket_messages IS a real live-
  // column regression we want to page on — the pin is exact to `sender_type`.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesSenderTypeAdhocNoise(
      "column ticket_messages.body does not exist",
      "select body from public.ticket_messages",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesSenderTypeAdhocNoise(
      "column ticket_messages.author_type does not exist",
      "select author_type from public.ticket_messages",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingTicketMessagesSenderTypeAdhocNoise KEEPS a sender_type miss on a DIFFERENT table (a real code bug on another table still pages)", () => {
  // `sender_type` missing on any OTHER table is a real code bug we want to see, not the
  // foreign ticket_messages lookup we drop.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesSenderTypeAdhocNoise(
      "column tickets.sender_type does not exist",
      "select sender_type from public.tickets",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesSenderTypeAdhocNoise(
      "column sms_messages.sender_type does not exist",
      "select id, sender_type from public.sms_messages",
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise ──
// Ad hoc `select ... role ... from public.ticket_messages` lookup by an external tool
// reading our messages table as if it were an OpenAI-style chat table
// (role/message_type/content) — or the PostgREST CTE wrapper the same client emits. Our
// `ticket_messages` table has never carried a `role` column (every ShopCX conversation read
// uses `direction`, `author_type`, `body`, `body_clean`), so the column-missing ERROR is
// repair work for a query we don't own (Control Tower signature
// `supabase-logs:e147a164a6dcdca4`). Narrowly gated: a column-missing on a live
// `ticket_messages` column, or on `role` for any other table (workspace_members / tickets),
// still surfaces / pages on first sighting.

test("isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise drops the exact sample from signature supabase-logs:e147a164a6dcdca4", () => {
  // The captured sample: bare SELECT-lookup shape on public.ticket_messages naming a
  // column that has never existed in our schema.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise(
      "column ticket_messages.role does not exist",
      "select id, role, content, message_type from public.ticket_messages",
    ),
    true,
  );
  // PostgREST CTE wrapper form — same foreign-owned read via the REST endpoint.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise(
      "column ticket_messages.role does not exist",
      'with pgrst_source as ( select "id", "role" from "public"."ticket_messages" limit 100 ) select * from pgrst_source',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix + `public.` qualifier on the column name are tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise(
      "ERROR: column public.ticket_messages.role does not exist",
      "select role from public.ticket_messages",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise KEEPS a column-missing error for a DIFFERENT column on ticket_messages (a real product-schema regression still pages)", () => {
  // A missing `body` / `author_type` / `direction` on ticket_messages IS a real live-
  // column regression we want to page on — the pin is exact to `role`.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise(
      "column ticket_messages.body does not exist",
      "select body from public.ticket_messages",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise(
      "column ticket_messages.author_type does not exist",
      "select author_type from public.ticket_messages",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise KEEPS a role miss on a DIFFERENT table (a real code bug on another table still pages)", () => {
  // `role` missing on any OTHER table is a real code bug we want to see, not the
  // foreign ticket_messages lookup we drop. `workspace_members.role` is a real live
  // column elsewhere; a column-missing error on it (or on `tickets.role`) is genuine.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise(
      "column workspace_members.role does not exist",
      "select role from public.workspace_members",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise(
      "column tickets.role does not exist",
      "select id, role from public.tickets",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise KEEPS the message on a non-SELECT statement shape (INSERT/UPDATE/DELETE — real code-bug shape)", () => {
  // A ShopCX code-path bug that writes to `ticket_messages` and names a nonexistent
  // `role` column is the shape we DO want to page on — the pin is the SELECT-lookup
  // shape only.
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise(
      "column ticket_messages.role does not exist",
      "insert into public.ticket_messages (id, role, body) values (gen_random_uuid(), 'user', 'hi')",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise(
      "column ticket_messages.role does not exist",
      "update public.ticket_messages set role = 'assistant' where id = '00000000-0000-0000-0000-000000000000'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise(
      "column ticket_messages.role does not exist",
      "delete from public.ticket_messages where role = 'system'",
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingTicketAnalysesIntentsColumnAdhocNoise ──
// Ad hoc `select ... intents ... from public.ticket_analyses` lookup by an external tool /
// stale integration — or the PostgREST CTE wrapper the same client emits. Our
// `ticket_analyses` table carries `issues`, not `intents`; no ShopCX code path / migration /
// view / function / trigger references an `intents` column, so the column-missing ERROR is
// repair work for a query we don't own (Control Tower signature
// `supabase-logs:7f83f37774a85b5b`). Narrowly gated: a column-missing on a live
// `ticket_analyses` column, `intents` on any other table, or a non-SELECT statement, still
// surfaces / pages on first sighting.

test("isForeignSupabasePostgresMissingTicketAnalysesIntentsColumnAdhocNoise drops the exact sample from signature supabase-logs:7f83f37774a85b5b", () => {
  // The captured sample: bare SELECT-lookup shape on public.ticket_analyses naming a
  // column that has never existed in our schema (our table has `issues`, not `intents`).
  assert.equal(
    isForeignSupabasePostgresMissingTicketAnalysesIntentsColumnAdhocNoise(
      "column ticket_analyses.intents does not exist",
      "select id, intents, score from public.ticket_analyses",
    ),
    true,
  );
  // PostgREST CTE wrapper form — same foreign-owned read via the REST endpoint.
  assert.equal(
    isForeignSupabasePostgresMissingTicketAnalysesIntentsColumnAdhocNoise(
      "column ticket_analyses.intents does not exist",
      'with pgrst_source as ( select "id", "intents" from "public"."ticket_analyses" limit 100 ) select * from pgrst_source',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix + `public.` qualifier on the column name are tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingTicketAnalysesIntentsColumnAdhocNoise(
      "ERROR: column public.ticket_analyses.intents does not exist",
      "select intents from public.ticket_analyses",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingTicketAnalysesIntentsColumnAdhocNoise KEEPS a column-missing error for a DIFFERENT column on ticket_analyses (a real product-schema regression still pages)", () => {
  // A missing `issues` / `score` on ticket_analyses IS a real live-column regression we
  // want to page on — the pin is exact to `intents`.
  assert.equal(
    isForeignSupabasePostgresMissingTicketAnalysesIntentsColumnAdhocNoise(
      "column ticket_analyses.issues does not exist",
      "select issues from public.ticket_analyses",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingTicketAnalysesIntentsColumnAdhocNoise KEEPS an intents miss on a DIFFERENT table (a real code bug on another table still pages)", () => {
  // `intents` missing on any OTHER table is a real code bug we want to see, not the
  // foreign ticket_analyses lookup we drop.
  assert.equal(
    isForeignSupabasePostgresMissingTicketAnalysesIntentsColumnAdhocNoise(
      "column ticket_directions.intents does not exist",
      "select intents from public.ticket_directions",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingTicketAnalysesIntentsColumnAdhocNoise KEEPS the message on a non-SELECT statement shape (INSERT/UPDATE/DELETE — real code-bug shape)", () => {
  // A ShopCX code-path bug that writes to `ticket_analyses` and names a nonexistent
  // `intents` column is the shape we DO want to page on — the pin is the SELECT-lookup
  // shape only.
  assert.equal(
    isForeignSupabasePostgresMissingTicketAnalysesIntentsColumnAdhocNoise(
      "column ticket_analyses.intents does not exist",
      "insert into public.ticket_analyses (id, intents) values (gen_random_uuid(), '{}')",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingTicketAnalysesIntentsColumnAdhocNoise(
      "column ticket_analyses.intents does not exist",
      "update public.ticket_analyses set intents = '{}' where id = '00000000-0000-0000-0000-000000000000'",
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/specs?select=slug,status,merged_at,...` against our `public.specs` table.
// The table exists but carries no `merged_at` column — merge provenance lives on
// `specs.merged_pr` + `specs.last_merge_sha` per [[../tables/specs]]. Foreign-owned
// surface, no lever from us — drop AT CAPTURE only when BOTH the exact column-missing
// message on `specs.merged_at` AND a SELECT-lookup shape on `specs` (bare OR PostgREST
// CTE wrapper) are present. A column-missing on any other table, a different column on
// `specs`, a JOIN through `spec_phases`, or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise drops the ad hoc SELECT lookup on the exact specs.merged_at column-missing shape", () => {
  // The captured production sample: unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column specs.merged_at does not exist",
      "select slug, status, merged_at from public.specs where slug = 'x'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column public.specs.merged_at does not exist",
      "select slug, status, merged_at from public.specs where slug = 'x'",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column specs.merged_at does not exist",
      "select merged_at from specs limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column specs.merged_at does not exist",
      "select slug, merged_at from public.specs where slug = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column specs.merged_at does not exist",
      "SELECT ID, MERGED_AT FROM PUBLIC.SPECS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "ERROR: column specs.merged_at does not exist",
      "select merged_at from public.specs",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "  column specs.merged_at does not exist  ",
      "   select merged_at from public.specs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"specs\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape captured for signature
  // `supabase-logs:a093e7c15c154c25`: identical foreign-owned lookup wrapped in the
  // pgrst_source CTE with double-quoted `"public"."specs"` identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column specs.merged_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."specs"."id", "public"."specs"."merged_at" FROM "public"."specs" WHERE "public"."specs"."slug" = $1 LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column public.specs.merged_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."merged_at" FROM "public"."specs")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "ERROR: column specs.merged_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."merged_at" FROM "public"."specs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a merged_at column still pages)", () => {
  // If any other table had a real `merged_at` column and regressed, we absolutely want
  // to see it — the pin is `specs.merged_at` only.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column pull_requests.merged_at does not exist",
      "select merged_at from public.pull_requests where id = 'x'",
    ),
    false,
  );
  // Sibling `spec_phases.merged_at` is a DIFFERENT foreign-caller shape on a DIFFERENT
  // table — the pin here is `specs` only, so this stays paged.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column spec_phases.merged_at does not exist",
      "select merged_at from public.spec_phases where spec_id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise KEEPS a DIFFERENT column-missing on specs (a real column rename still pages)", () => {
  // Real `specs` columns — if any of these regress we absolutely want the page.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column specs.status does not exist",
      "select status from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column specs.slug does not exist",
      "select slug from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise KEEPS a JOIN across other tables (a real code shape joining spec_phases still pages)", () => {
  // The regex is anchored on `from (public.)?specs` as the first FROM target; a JOIN
  // whose first FROM is `spec_phases` won't match — product code, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column specs.merged_at does not exist",
      "select p.body, s.merged_at from public.spec_phases p join public.specs s on s.id = p.spec_id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing specs.merged_at still pages)", () => {
  // INSERT / UPDATE / DELETE against specs referencing a bogus column is real code
  // trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column specs.merged_at does not exist",
      "insert into public.specs (slug, merged_at) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column specs.merged_at does not exist",
      "update public.specs set merged_at = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column specs.merged_at does not exist",
      "delete from public.specs where merged_at is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column specs.merged_at does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."specs"("slug", "merged_at") VALUES ($1, $2) RETURNING "public"."specs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column specs.merged_at does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."specs" SET "merged_at" = $1 WHERE "public"."specs"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise KEEPS a PostgREST CTE wrapper on a DIFFERENT table (a real schema regression on pull_requests.merged_at still pages)", () => {
  // Same wrapper shape but the wrapped SELECT reads a different table — the pin is
  // `specs.merged_at` only; any other table's merged_at is a genuine regression.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column pull_requests.merged_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."pull_requests"."id", "public"."pull_requests"."merged_at" FROM "public"."pull_requests" WHERE "public"."pull_requests"."workspace_id" = $1 )',
    ),
    false,
  );
  // Sibling table `spec_phases` — the anchor `\bspecs\b` won't match `spec_phases`.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column spec_phases.merged_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."spec_phases"."id", "public"."spec_phases"."merged_at" FROM "public"."spec_phases" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on specs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "database is shutting down",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      'duplicate key value violates unique constraint "specs_workspace_slug"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise returns false on empty / nullish inputs", () => {
  assert.equal(isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(null, null), false);
  assert.equal(isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(undefined, undefined), false);
  assert.equal(isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise("", ""), false);
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "column specs.merged_at does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsMergedAtAdhocNoise(
      "",
      "select merged_at from public.specs",
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/specs?select=slug,status,review_status,...` against our `public.specs`
// table. The table exists but carries no `review_status` column — review state lives
// on the Vale / Ada review fields per [[../tables/specs]]. Foreign-owned surface, no
// lever from us — drop AT CAPTURE only when BOTH the exact column-missing message on
// `specs.review_status` AND a SELECT-lookup shape on `specs` (bare OR PostgREST CTE
// wrapper) are present. A column-missing on any other table, a different column on
// `specs`, a JOIN through `spec_phases`, or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise drops the ad hoc SELECT lookup on the exact specs.review_status column-missing shape", () => {
  // The captured production sample: unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column specs.review_status does not exist",
      "select slug, status, review_status from public.specs where slug = 'x'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column public.specs.review_status does not exist",
      "select slug, status, review_status from public.specs where slug = 'x'",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column specs.review_status does not exist",
      "select review_status from specs limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column specs.review_status does not exist",
      "select slug, review_status from public.specs where slug = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column specs.review_status does not exist",
      "SELECT ID, REVIEW_STATUS FROM PUBLIC.SPECS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "ERROR: column specs.review_status does not exist",
      "select review_status from public.specs",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "  column specs.review_status does not exist  ",
      "   select review_status from public.specs   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"specs\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape: identical foreign-owned lookup wrapped in
  // the pgrst_source CTE with double-quoted `"public"."specs"` identifiers. The plain
  // bare-SELECT regex misses this because the statement starts with `with` and the
  // FROM clause carries the quoted schema.table shape.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column specs.review_status does not exist",
      'WITH pgrst_source AS ( SELECT "public"."specs"."id", "public"."specs"."review_status" FROM "public"."specs" WHERE "public"."specs"."slug" = $1 LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column public.specs.review_status does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."review_status" FROM "public"."specs")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "ERROR: column specs.review_status does not exist",
      'WITH pgrst_source AS (SELECT "public"."specs"."review_status" FROM "public"."specs")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a review_status column still pages)", () => {
  // If any other table had a real `review_status` column and regressed, we absolutely
  // want to see it — the pin is `specs.review_status` only.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column proposals.review_status does not exist",
      "select review_status from public.proposals where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column pull_requests.review_status does not exist",
      "select review_status from public.pull_requests where id = $1",
    ),
    false,
  );
  // Sibling `spec_phases.review_status` (also non-existent) is a DIFFERENT foreign-
  // caller shape on a DIFFERENT table — the pin here is `specs` only, so this stays
  // paged rather than silently swallowed by the specs classifier.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column spec_phases.review_status does not exist",
      "select review_status from public.spec_phases where spec_id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise KEEPS a DIFFERENT column-missing on specs (a real column rename still pages)", () => {
  // Real `specs` columns — if any of these regress we absolutely want the page.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column specs.status does not exist",
      "select status from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column specs.slug does not exist",
      "select slug from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column specs.workspace_id does not exist",
      "select workspace_id from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise KEEPS a JOIN across other tables (a real code shape joining spec_phases still pages)", () => {
  // The regex is anchored on `from (public.)?specs` as the first FROM target; a JOIN
  // whose first FROM is `spec_phases` won't match — which is the outcome we want,
  // because a caller that joins the two and asks for a real column shape is product
  // code, not the ad hoc direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column specs.review_status does not exist",
      "select p.body, s.review_status from public.spec_phases p join public.specs s on s.id = p.spec_id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing specs.review_status still pages)", () => {
  // INSERT / UPDATE / DELETE against specs referencing a bogus column is real code
  // trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column specs.review_status does not exist",
      "insert into public.specs (slug, review_status) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column specs.review_status does not exist",
      "update public.specs set review_status = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column specs.review_status does not exist",
      "delete from public.specs where review_status is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column specs.review_status does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."specs"("slug", "review_status") VALUES ($1, $2) RETURNING "public"."specs"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column specs.review_status does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."specs" SET "review_status" = $1 WHERE "public"."specs"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise KEEPS a PostgREST CTE wrapper on a DIFFERENT table (a real schema regression on proposals.review_status still pages)", () => {
  // Same wrapper shape but the wrapped SELECT reads a different table — the pin is
  // `specs.review_status` only; any other table's review_status is a genuine schema
  // regression we want to see.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column proposals.review_status does not exist",
      'WITH pgrst_source AS ( SELECT "public"."proposals"."id", "public"."proposals"."review_status" FROM "public"."proposals" WHERE "public"."proposals"."workspace_id" = $1 )',
    ),
    false,
  );
  // Sibling table `spec_phases` — the anchor `\bspecs\b` won't match `spec_phases`,
  // so this stays paged rather than being swallowed by the specs classifier.
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column spec_phases.review_status does not exist",
      'WITH pgrst_source AS ( SELECT "public"."spec_phases"."id", "public"."spec_phases"."review_status" FROM "public"."spec_phases" )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on specs (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "database is shutting down",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      'duplicate key value violates unique constraint "specs_workspace_slug"',
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "canceling statement due to statement timeout",
      "select id from public.specs where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise returns false on empty / nullish inputs", () => {
  assert.equal(isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(null, null), false);
  assert.equal(isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(undefined, undefined), false);
  assert.equal(isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise("", ""), false);
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "column specs.review_status does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingSpecsReviewStatusAdhocNoise(
      "",
      "select review_status from public.specs",
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/daily_amazon_order_snapshots?select=...units...` against our
// `public.daily_amazon_order_snapshots` table. The table exists but carries no `units`
// column — the aggregate reports `order_count` + `gross_revenue_cents` + `net_revenue_cents`
// per day + order bucket, and per-product unit counts live on the sibling
// `daily_amazon_product_snapshots` table (see
// `supabase/migrations/20260621130100_daily_amazon_product_snapshots.sql`). Foreign-owned
// surface, no lever from us — drop AT CAPTURE only when BOTH the exact column-missing
// message on `daily_amazon_order_snapshots.units` AND a SELECT-lookup shape on
// `daily_amazon_order_snapshots` (bare OR PostgREST CTE wrapper) are present. A
// column-missing on any other table, the sibling `daily_amazon_product_snapshots.units`,
// a different column on `daily_amazon_order_snapshots`, a JOIN whose first FROM is
// another table, or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise drops the ad hoc SELECT lookup on the exact daily_amazon_order_snapshots.units column-missing shape", () => {
  // The captured production sample: unqualified and public.-qualified message variants.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column daily_amazon_order_snapshots.units does not exist",
      "select snapshot_date, order_bucket, units from public.daily_amazon_order_snapshots where workspace_id = 'x'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column public.daily_amazon_order_snapshots.units does not exist",
      "select snapshot_date, order_bucket, units from public.daily_amazon_order_snapshots where workspace_id = 'x'",
    ),
    true,
  );
  // Unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column daily_amazon_order_snapshots.units does not exist",
      "select units from daily_amazon_order_snapshots limit 10",
    ),
    true,
  );
  // Trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column daily_amazon_order_snapshots.units does not exist",
      "select snapshot_date, units from public.daily_amazon_order_snapshots where workspace_id = 'x' order by snapshot_date desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column daily_amazon_order_snapshots.units does not exist",
      "SELECT SNAPSHOT_DATE, UNITS FROM PUBLIC.DAILY_AMAZON_ORDER_SNAPSHOTS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "ERROR: column daily_amazon_order_snapshots.units does not exist",
      "select units from public.daily_amazon_order_snapshots",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "  column daily_amazon_order_snapshots.units does not exist  ",
      "   select units from public.daily_amazon_order_snapshots   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"daily_amazon_order_snapshots\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape — the real production sample is this
  // CTE-wrapped SELECT with double-quoted identifiers. The plain bare-SELECT regex
  // misses this because the statement starts with `with` and the FROM clause carries
  // the quoted `"public"."daily_amazon_order_snapshots"` shape.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column daily_amazon_order_snapshots.units does not exist",
      'WITH pgrst_source AS ( SELECT "public"."daily_amazon_order_snapshots"."snapshot_date", "public"."daily_amazon_order_snapshots"."units" FROM "public"."daily_amazon_order_snapshots" WHERE "public"."daily_amazon_order_snapshots"."workspace_id" = $1 LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column public.daily_amazon_order_snapshots.units does not exist",
      'WITH pgrst_source AS (SELECT "public"."daily_amazon_order_snapshots"."units" FROM "public"."daily_amazon_order_snapshots")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "ERROR: column daily_amazon_order_snapshots.units does not exist",
      'WITH pgrst_source AS (SELECT "public"."daily_amazon_order_snapshots"."units" FROM "public"."daily_amazon_order_snapshots")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a units column still pages)", () => {
  // If any other table had a real `units` column and regressed, we absolutely want to
  // see it — the pin is `daily_amazon_order_snapshots.units` only.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column order_items.units does not exist",
      "select units from public.order_items where order_id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column shipments.units does not exist",
      "select units from public.shipments where id = $1",
    ),
    false,
  );
  // Sibling `daily_amazon_product_snapshots` — the per-product aggregate that DOES
  // carry unit data. A column-missing on the sibling is a DIFFERENT shape on a
  // DIFFERENT table and stays paged rather than being swallowed by this classifier.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column daily_amazon_product_snapshots.units does not exist",
      "select units from public.daily_amazon_product_snapshots where workspace_id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise KEEPS a DIFFERENT column-missing on daily_amazon_order_snapshots (a real column rename still pages)", () => {
  // Real `daily_amazon_order_snapshots` columns — if any of these regress we
  // absolutely want the page.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column daily_amazon_order_snapshots.order_count does not exist",
      "select order_count from public.daily_amazon_order_snapshots where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column daily_amazon_order_snapshots.gross_revenue_cents does not exist",
      "select gross_revenue_cents from public.daily_amazon_order_snapshots where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column daily_amazon_order_snapshots.snapshot_date does not exist",
      "select snapshot_date from public.daily_amazon_order_snapshots where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise KEEPS a JOIN across other tables (a real code shape joining the sibling table still pages)", () => {
  // The regex is anchored on `from (public.)?daily_amazon_order_snapshots` as the
  // first FROM target; a JOIN whose first FROM is a different table won't match —
  // which is the outcome we want, because a caller that joins and asks for a real
  // column shape is product code, not the ad hoc direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column daily_amazon_order_snapshots.units does not exist",
      "select p.units, s.gross_revenue_cents from public.daily_amazon_product_snapshots p join public.daily_amazon_order_snapshots s on s.snapshot_date = p.snapshot_date",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing daily_amazon_order_snapshots.units still pages)", () => {
  // INSERT / UPDATE / DELETE against the table referencing a bogus column is real
  // code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column daily_amazon_order_snapshots.units does not exist",
      "insert into public.daily_amazon_order_snapshots (snapshot_date, units) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column daily_amazon_order_snapshots.units does not exist",
      "update public.daily_amazon_order_snapshots set units = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column daily_amazon_order_snapshots.units does not exist",
      "delete from public.daily_amazon_order_snapshots where units is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column daily_amazon_order_snapshots.units does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."daily_amazon_order_snapshots"("snapshot_date", "units") VALUES ($1, $2) RETURNING "public"."daily_amazon_order_snapshots"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column daily_amazon_order_snapshots.units does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."daily_amazon_order_snapshots" SET "units" = $1 WHERE "public"."daily_amazon_order_snapshots"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise KEEPS a PostgREST CTE wrapper on a DIFFERENT table (a real schema regression on daily_amazon_product_snapshots.units still pages)", () => {
  // Same wrapper shape but the wrapped SELECT reads a different table — the pin is
  // `daily_amazon_order_snapshots.units` only; the sibling table carries real unit
  // data, and a regression there is one we want to see.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column daily_amazon_product_snapshots.units does not exist",
      'WITH pgrst_source AS ( SELECT "public"."daily_amazon_product_snapshots"."id", "public"."daily_amazon_product_snapshots"."units" FROM "public"."daily_amazon_product_snapshots" WHERE "public"."daily_amazon_product_snapshots"."workspace_id" = $1 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on daily_amazon_order_snapshots (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "database is shutting down",
      "select id from public.daily_amazon_order_snapshots where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      'duplicate key value violates unique constraint "daily_amazon_order_snapshots_amazon_connection_id_snapshot_"',
      "insert into public.daily_amazon_order_snapshots (amazon_connection_id, snapshot_date, order_bucket) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "canceling statement due to statement timeout",
      "select id from public.daily_amazon_order_snapshots where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise returns false on empty / nullish inputs", () => {
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise("", ""),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "column daily_amazon_order_snapshots.units does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsUnitsAdhocNoise(
      "",
      "select units from public.daily_amazon_order_snapshots",
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/daily_amazon_order_snapshots?select=...&date=eq.YYYY-MM-DD` against our
// `public.daily_amazon_order_snapshots` table. The table exists but by design carries
// NO `date` column — the per-day column is `snapshot_date`. Drop AT CAPTURE only when
// BOTH the exact column-missing message on `daily_amazon_order_snapshots.date` AND a
// SELECT-lookup shape on `daily_amazon_order_snapshots` are present.

test("isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise drops the ad hoc SELECT lookup on the exact daily_amazon_order_snapshots.date column-missing shape", () => {
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise(
      "column daily_amazon_order_snapshots.date does not exist",
      "select snapshot_date, order_bucket, order_count from public.daily_amazon_order_snapshots where date = '2026-10-04'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise(
      "column public.daily_amazon_order_snapshots.date does not exist",
      "select snapshot_date, order_bucket, order_count from public.daily_amazon_order_snapshots where date = '2026-10-04'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise(
      "column daily_amazon_order_snapshots.date does not exist",
      "select date from daily_amazon_order_snapshots limit 10",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise(
      "column daily_amazon_order_snapshots.date does not exist",
      "SELECT DATE, ORDER_COUNT FROM PUBLIC.DAILY_AMAZON_ORDER_SNAPSHOTS",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise(
      "ERROR: column daily_amazon_order_snapshots.date does not exist",
      "select date from public.daily_amazon_order_snapshots",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise drops the PostgREST CTE wrapper form", () => {
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise(
      "column daily_amazon_order_snapshots.date does not exist",
      'WITH pgrst_source AS ( SELECT "public"."daily_amazon_order_snapshots"."date", "public"."daily_amazon_order_snapshots"."order_count" FROM "public"."daily_amazon_order_snapshots" WHERE "public"."daily_amazon_order_snapshots"."date" = $1 LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise(
      "column public.daily_amazon_order_snapshots.date does not exist",
      'WITH pgrst_source AS (SELECT "public"."daily_amazon_order_snapshots"."date" FROM "public"."daily_amazon_order_snapshots")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise keeps other tables and different columns", () => {
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise(
      "column holidays.date does not exist",
      "select date from public.holidays where country = 'US'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise(
      "column daily_amazon_product_snapshots.date does not exist",
      "select date from public.daily_amazon_product_snapshots where workspace_id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise(
      "column daily_amazon_order_snapshots.snapshot_date does not exist",
      "select snapshot_date from public.daily_amazon_order_snapshots where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise(
      "column daily_amazon_order_snapshots.order_count does not exist",
      "select order_count from public.daily_amazon_order_snapshots where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise keeps joins, writes, and empty inputs", () => {
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise(
      "column daily_amazon_order_snapshots.date does not exist",
      "select p.date, s.gross_revenue_cents from public.daily_amazon_product_snapshots p join public.daily_amazon_order_snapshots s on s.snapshot_date = p.snapshot_date",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise(
      "column daily_amazon_order_snapshots.date does not exist",
      "insert into public.daily_amazon_order_snapshots (date, order_bucket) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise(
      "column daily_amazon_order_snapshots.date does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."daily_amazon_order_snapshots"("date", "order_bucket") VALUES ($1, $2) RETURNING "public"."daily_amazon_order_snapshots"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonOrderSnapshotsDateAdhocNoise(
      "column daily_amazon_order_snapshots.date does not exist",
      "",
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/daily_amazon_product_snapshots?select=date,...` against our
// `public.daily_amazon_product_snapshots` table. The table exists but its date column is
// `snapshot_date`, not `date` — every ShopCX reader selects the real column. Foreign-
// owned surface, no lever from us — drop AT CAPTURE only when BOTH the exact column-
// missing message on `daily_amazon_product_snapshots.date` AND a SELECT-lookup shape on
// `daily_amazon_product_snapshots` (bare OR PostgREST CTE wrapper) are present. A
// column-missing on any other table, the sibling `daily_amazon_order_snapshots.date`, a
// different column on `daily_amazon_product_snapshots` (e.g. the real `snapshot_date`
// column), a JOIN whose first FROM is another table, or a non-SELECT statement still
// pages.

test("isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise drops the ad hoc SELECT lookup on the exact daily_amazon_product_snapshots.date column-missing shape", () => {
  // The captured production sample: unqualified and public.-qualified message variants.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_product_snapshots.date does not exist",
      "select date, asin, units from public.daily_amazon_product_snapshots where workspace_id = 'x'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column public.daily_amazon_product_snapshots.date does not exist",
      "select date, asin, units from public.daily_amazon_product_snapshots where workspace_id = 'x'",
    ),
    true,
  );
  // Unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_product_snapshots.date does not exist",
      "select date from daily_amazon_product_snapshots limit 10",
    ),
    true,
  );
  // Trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_product_snapshots.date does not exist",
      "select date, units from public.daily_amazon_product_snapshots where workspace_id = 'x' order by date desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_product_snapshots.date does not exist",
      "SELECT DATE, UNITS FROM PUBLIC.DAILY_AMAZON_PRODUCT_SNAPSHOTS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "ERROR: column daily_amazon_product_snapshots.date does not exist",
      "select date from public.daily_amazon_product_snapshots",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "  column daily_amazon_product_snapshots.date does not exist  ",
      "   select date from public.daily_amazon_product_snapshots   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"daily_amazon_product_snapshots\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape — the real production sample is this
  // CTE-wrapped SELECT with double-quoted identifiers. The plain bare-SELECT regex
  // misses this because the statement starts with `with` and the FROM clause carries
  // the quoted `"public"."daily_amazon_product_snapshots"` shape.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_product_snapshots.date does not exist",
      'WITH pgrst_source AS ( SELECT "public"."daily_amazon_product_snapshots"."date", "public"."daily_amazon_product_snapshots"."units" FROM "public"."daily_amazon_product_snapshots" WHERE "public"."daily_amazon_product_snapshots"."workspace_id" = $1 LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column public.daily_amazon_product_snapshots.date does not exist",
      'WITH pgrst_source AS (SELECT "public"."daily_amazon_product_snapshots"."date" FROM "public"."daily_amazon_product_snapshots")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "ERROR: column daily_amazon_product_snapshots.date does not exist",
      'WITH pgrst_source AS (SELECT "public"."daily_amazon_product_snapshots"."date" FROM "public"."daily_amazon_product_snapshots")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a date column still pages)", () => {
  // If any other table had a real `date` column and regressed, we absolutely want to
  // see it — the pin is `daily_amazon_product_snapshots.date` only.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_meta_ad_spend.date does not exist",
      "select date from public.daily_meta_ad_spend where workspace_id = 'x'",
    ),
    false,
  );
  // Sibling `daily_amazon_order_snapshots` — a column-missing on the sibling (same
  // domain, different table) is a DIFFERENT shape and stays paged rather than being
  // swallowed by this classifier.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_order_snapshots.date does not exist",
      "select date from public.daily_amazon_order_snapshots where workspace_id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise KEEPS a DIFFERENT column-missing on daily_amazon_product_snapshots (a real column rename still pages)", () => {
  // Real `daily_amazon_product_snapshots` columns — if any of these regress we
  // absolutely want the page. In particular the migrated date column is `snapshot_date`;
  // a regression on it (not `date`) stays paged.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_product_snapshots.snapshot_date does not exist",
      "select snapshot_date from public.daily_amazon_product_snapshots where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_product_snapshots.asin does not exist",
      "select asin from public.daily_amazon_product_snapshots where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_product_snapshots.gross_revenue_cents does not exist",
      "select gross_revenue_cents from public.daily_amazon_product_snapshots where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_product_snapshots.units does not exist",
      "select units from public.daily_amazon_product_snapshots where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise KEEPS a JOIN across other tables (a real code shape joining the sibling table still pages)", () => {
  // The regex is anchored on `from (public.)?daily_amazon_product_snapshots` as the
  // first FROM target; a JOIN whose first FROM is a different table won't match —
  // which is the outcome we want, because a caller that joins and asks for a real
  // column shape is product code, not the ad hoc direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_product_snapshots.date does not exist",
      "select o.date, p.units from public.daily_amazon_order_snapshots o join public.daily_amazon_product_snapshots p on p.snapshot_date = o.snapshot_date",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing daily_amazon_product_snapshots.date still pages)", () => {
  // INSERT / UPDATE / DELETE against the table referencing a bogus column is real
  // code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_product_snapshots.date does not exist",
      "insert into public.daily_amazon_product_snapshots (date, units) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_product_snapshots.date does not exist",
      "update public.daily_amazon_product_snapshots set date = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_product_snapshots.date does not exist",
      "delete from public.daily_amazon_product_snapshots where date is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_product_snapshots.date does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."daily_amazon_product_snapshots"("date", "units") VALUES ($1, $2) RETURNING "public"."daily_amazon_product_snapshots"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_product_snapshots.date does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."daily_amazon_product_snapshots" SET "date" = $1 WHERE "public"."daily_amazon_product_snapshots"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise KEEPS a PostgREST CTE wrapper on a DIFFERENT table (a real schema regression on daily_amazon_order_snapshots.date still pages)", () => {
  // Same wrapper shape but the wrapped SELECT reads a different table — the pin is
  // `daily_amazon_product_snapshots.date` only; a regression on the sibling aggregate
  // is one we want to see.
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_order_snapshots.date does not exist",
      'WITH pgrst_source AS ( SELECT "public"."daily_amazon_order_snapshots"."id", "public"."daily_amazon_order_snapshots"."date" FROM "public"."daily_amazon_order_snapshots" WHERE "public"."daily_amazon_order_snapshots"."workspace_id" = $1 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on daily_amazon_product_snapshots (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "database is shutting down",
      "select id from public.daily_amazon_product_snapshots where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      'duplicate key value violates unique constraint "daily_amazon_product_snapshots_uniq"',
      "insert into public.daily_amazon_product_snapshots (amazon_connection_id, snapshot_date, asin, order_bucket) values ($1, $2, $3, $4)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "canceling statement due to statement timeout",
      "select id from public.daily_amazon_product_snapshots where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise returns false on empty / nullish inputs", () => {
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise("", ""),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "column daily_amazon_product_snapshots.date does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingDailyAmazonProductSnapshotsDateAdhocNoise(
      "",
      "select date from public.daily_amazon_product_snapshots",
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/pending_folds?select=fold_job_id,...` against our `public.pending_folds`
// table. The table exists but its fold-job reference column is `job_id`, not
// `fold_job_id` — every ShopCX reader selects the real column. Foreign-owned surface,
// no lever from us — drop AT CAPTURE only when BOTH the exact column-missing message
// on `pending_folds.fold_job_id` AND a SELECT-lookup shape on `pending_folds` (bare OR
// PostgREST CTE wrapper) are present. A column-missing on any other table, a different
// column on `pending_folds` (e.g. the real `job_id` column), a JOIN whose first FROM
// is another table, or a non-SELECT statement still pages.

test("isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise drops the ad hoc SELECT lookup on the exact pending_folds.fold_job_id column-missing shape", () => {
  // The captured production sample: unqualified and public.-qualified message variants.
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column pending_folds.fold_job_id does not exist",
      "select fold_job_id, spec_slug, status from public.pending_folds where workspace_id = 'x'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column public.pending_folds.fold_job_id does not exist",
      "select fold_job_id, spec_slug, status from public.pending_folds where workspace_id = 'x'",
    ),
    true,
  );
  // Unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column pending_folds.fold_job_id does not exist",
      "select fold_job_id from pending_folds limit 10",
    ),
    true,
  );
  // Trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column pending_folds.fold_job_id does not exist",
      "select fold_job_id, status from public.pending_folds where workspace_id = 'x' order by created_at desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column pending_folds.fold_job_id does not exist",
      "SELECT FOLD_JOB_ID, STATUS FROM PUBLIC.PENDING_FOLDS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "ERROR: column pending_folds.fold_job_id does not exist",
      "select fold_job_id from public.pending_folds",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "  column pending_folds.fold_job_id does not exist  ",
      "   select fold_job_id from public.pending_folds   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise ALSO drops the PostgREST `WITH pgrst_source AS (SELECT ... FROM \"public\".\"pending_folds\" ...)` CTE wrapper form", () => {
  // The PostgREST direct-REST wire shape — the real production sample is this
  // CTE-wrapped SELECT with double-quoted identifiers. The plain bare-SELECT regex
  // misses this because the statement starts with `with` and the FROM clause carries
  // the quoted `"public"."pending_folds"` shape.
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column pending_folds.fold_job_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."pending_folds"."fold_job_id", "public"."pending_folds"."status" FROM "public"."pending_folds" WHERE "public"."pending_folds"."workspace_id" = $1 LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column public.pending_folds.fold_job_id does not exist",
      'WITH pgrst_source AS (SELECT "public"."pending_folds"."fold_job_id" FROM "public"."pending_folds")',
    ),
    true,
  );
  // The ERROR: prefix on the message is stripped as usual before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "ERROR: column pending_folds.fold_job_id does not exist",
      'WITH pgrst_source AS (SELECT "public"."pending_folds"."fold_job_id" FROM "public"."pending_folds")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a fold_job_id column still pages)", () => {
  // If any other table had a real `fold_job_id` column and regressed, we absolutely
  // want to see it — the pin is `pending_folds.fold_job_id` only.
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column fold_jobs.fold_job_id does not exist",
      "select fold_job_id from public.fold_jobs where workspace_id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column agent_jobs.fold_job_id does not exist",
      "select fold_job_id from public.agent_jobs where workspace_id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise KEEPS a DIFFERENT column-missing on pending_folds (a real column rename still pages)", () => {
  // Real `pending_folds` columns — if any of these regress we absolutely want the
  // page. In particular the real fold-job column is `job_id`; a regression on it
  // (not `fold_job_id`) stays paged.
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column pending_folds.job_id does not exist",
      "select job_id from public.pending_folds where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column pending_folds.spec_slug does not exist",
      "select spec_slug from public.pending_folds where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column pending_folds.status does not exist",
      "select status from public.pending_folds where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column pending_folds.requested_by does not exist",
      "select requested_by from public.pending_folds where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise KEEPS a JOIN across other tables (a real code shape joining pending_folds still pages)", () => {
  // The regex is anchored on `from (public.)?pending_folds` as the first FROM target;
  // a JOIN whose first FROM is a different table won't match — which is the outcome
  // we want, because a caller that joins and asks for a real column shape is product
  // code, not the ad hoc direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column pending_folds.fold_job_id does not exist",
      "select j.id, p.fold_job_id from public.agent_jobs j join public.pending_folds p on p.job_id = j.id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise KEEPS a non-SELECT statement shape (a real code-bug writing pending_folds.fold_job_id still pages)", () => {
  // INSERT / UPDATE / DELETE against the table referencing a bogus column is real
  // code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column pending_folds.fold_job_id does not exist",
      "insert into public.pending_folds (workspace_id, spec_slug, fold_job_id) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column pending_folds.fold_job_id does not exist",
      "update public.pending_folds set fold_job_id = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column pending_folds.fold_job_id does not exist",
      "delete from public.pending_folds where fold_job_id is null",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column pending_folds.fold_job_id does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."pending_folds"("workspace_id", "fold_job_id") VALUES ($1, $2) RETURNING "public"."pending_folds"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column pending_folds.fold_job_id does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."pending_folds" SET "fold_job_id" = $1 WHERE "public"."pending_folds"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise KEEPS a PostgREST CTE wrapper on a DIFFERENT table (a real schema regression on another table still pages)", () => {
  // Same wrapper shape but the wrapped SELECT reads a different table — the pin is
  // `pending_folds.fold_job_id` only; a regression on an adjacent table is one we
  // want to see.
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column agent_jobs.fold_job_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."agent_jobs"."id", "public"."agent_jobs"."fold_job_id" FROM "public"."agent_jobs" WHERE "public"."agent_jobs"."workspace_id" = $1 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on pending_folds (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "database is shutting down",
      "select id from public.pending_folds where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      'duplicate key value violates unique constraint "pending_folds_workspace_id_spec_slug_key"',
      "insert into public.pending_folds (workspace_id, spec_slug, status) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "canceling statement due to statement timeout",
      "select id from public.pending_folds where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise returns false on empty / nullish inputs", () => {
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise("", ""),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "column pending_folds.fold_job_id does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingPendingFoldsFoldJobIdAdhocNoise(
      "",
      "select fold_job_id from public.pending_folds",
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise ──
// Specs: error-feed-drop-loop-heartbeats-beat-at-direct-rest-noise,
// error-feed-drop-loop-heartbeats-loop-key-direct-rest-noise.
// Control Tower signatures: supabase-logs:1b4a323180ec8365, supabase-logs:2dde5e6c56fb408c.
// Drops the SELECT lookup shape for `loop_heartbeats.beat_at`, `loop_heartbeats.loop`,
// or `loop_heartbeats.loop_key` — legacy / off-schema column names that stale foreign
// direct-REST callers ask for. The real columns are `loop_id` and `ran_at` (`loop_key`
// is a stale synonym for `loop_id`); any other column, any non-SELECT statement shape,
// any JOIN, any different table, any FATAL/PANIC/constraint failure still pages.

test("isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise drops the captured supabase-logs:1b4a323180ec8365 PostgREST CTE sample on loop_heartbeats.beat_at", () => {
  // The production PostgREST CTE sample — a stale foreign direct-REST client asks for
  // legacy `beat_at` / `loop` column names that the migrated heartbeat table never
  // carried. PostgREST wraps the SELECT in `WITH pgrst_source AS ( ... )` with
  // double-quoted identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.beat_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_heartbeats"."loop", "public"."loop_heartbeats"."beat_at" FROM "public"."loop_heartbeats" WHERE "public"."loop_heartbeats"."loop" = $1 ORDER BY "public"."loop_heartbeats"."beat_at" DESC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column public.loop_heartbeats.beat_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."loop_heartbeats"."beat_at" FROM "public"."loop_heartbeats")',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "ERROR: column loop_heartbeats.beat_at does not exist",
      'WITH pgrst_source AS (SELECT "public"."loop_heartbeats"."beat_at" FROM "public"."loop_heartbeats")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise ALSO drops the PostgREST CTE sample on loop_heartbeats.loop", () => {
  // Same drop class covers the sibling `loop` legacy name — the real column is
  // `loop_id`, so a direct-REST client that reads `select loop,beat_at,...` hits the
  // column-missing error on `loop` first depending on the select-order rendering.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.loop does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_heartbeats"."loop", "public"."loop_heartbeats"."beat_at" FROM "public"."loop_heartbeats" )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column public.loop_heartbeats.loop does not exist",
      'WITH pgrst_source AS (SELECT "public"."loop_heartbeats"."loop" FROM "public"."loop_heartbeats")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise ALSO drops the PostgREST CTE sample on loop_heartbeats.loop_key (supabase-logs:2dde5e6c56fb408c)", () => {
  // The captured production CTE query shape — a stale foreign direct-REST client
  // reads `select=loop_key,ran_at,...` against the heartbeat table. `loop_key` has
  // never shipped as a column; the real identifier is `loop_id`. PostgREST wraps the
  // SELECT in `WITH pgrst_source AS ( ... )` with double-quoted identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.loop_key does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_heartbeats"."loop_key", "public"."loop_heartbeats"."ran_at" FROM "public"."loop_heartbeats" WHERE "public"."loop_heartbeats"."loop_key" = $1 ORDER BY "public"."loop_heartbeats"."ran_at" DESC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column public.loop_heartbeats.loop_key does not exist",
      'WITH pgrst_source AS (SELECT "public"."loop_heartbeats"."loop_key" FROM "public"."loop_heartbeats")',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "ERROR: column loop_heartbeats.loop_key does not exist",
      'WITH pgrst_source AS (SELECT "public"."loop_heartbeats"."loop_key" FROM "public"."loop_heartbeats")',
    ),
    true,
  );
  // Bare SELECT lookup variant — same ad hoc read without the PostgREST CTE wrapper.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.loop_key does not exist",
      "select loop_key, ran_at from public.loop_heartbeats where loop_key = 'triage-escalations-cron'",
    ),
    true,
  );
  // Unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.loop_key does not exist",
      "select loop_key from loop_heartbeats limit 10",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise KEEPS a non-SELECT statement shape on loop_heartbeats for loop_key (a real code-bug writing loop_key still pages)", () => {
  // Negative non-SELECT cases on `loop_key` — INSERT / UPDATE / DELETE against the
  // table referencing the stale `loop_key` column is real code trying to write the
  // table, a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.loop_key does not exist",
      "insert into public.loop_heartbeats (loop_key, ran_at, ok) values ($1, now(), true)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.loop_key does not exist",
      "update public.loop_heartbeats set loop_key = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.loop_key does not exist",
      "delete from public.loop_heartbeats where loop_key = $1",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE on loop_key stays
  // paged too — that would be a real code-write bug on our side.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.loop_key does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."loop_heartbeats"("loop_key", "ran_at") VALUES ($1, now()) RETURNING "public"."loop_heartbeats"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.loop_key does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."loop_heartbeats" SET "loop_key" = $1 WHERE "public"."loop_heartbeats"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise drops the bare SELECT lookup variant on either legacy column", () => {
  // The non-PostgREST bare-SELECT shape — same ad hoc read without the CTE wrapper.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.beat_at does not exist",
      "select loop, beat_at from public.loop_heartbeats where loop = 'triage-escalations-cron'",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.loop does not exist",
      "select loop, beat_at from public.loop_heartbeats",
    ),
    true,
  );
  // Unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.beat_at does not exist",
      "select beat_at from loop_heartbeats limit 10",
    ),
    true,
  );
  // Case-insensitive on the query, with trailing WHERE / ORDER BY / LIMIT.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.beat_at does not exist",
      "SELECT LOOP, BEAT_AT FROM PUBLIC.LOOP_HEARTBEATS ORDER BY BEAT_AT DESC LIMIT 50",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "  column loop_heartbeats.beat_at does not exist  ",
      "   select beat_at from public.loop_heartbeats   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise KEEPS a non-SELECT statement shape on loop_heartbeats (a real code-bug writing beat_at / loop still pages)", () => {
  // INSERT / UPDATE / DELETE against the table referencing a bogus legacy column is
  // real code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.beat_at does not exist",
      "insert into public.loop_heartbeats (loop, beat_at, ok) values ($1, now(), true)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.loop does not exist",
      "update public.loop_heartbeats set loop = $1 where id = $2",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.beat_at does not exist",
      "delete from public.loop_heartbeats where beat_at < now() - interval '30 days'",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.beat_at does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."loop_heartbeats"("loop", "beat_at") VALUES ($1, now()) RETURNING "public"."loop_heartbeats"."id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.loop does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."loop_heartbeats" SET "loop" = $1 WHERE "public"."loop_heartbeats"."id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise KEEPS a JOIN across other tables (a real code shape joining loop_heartbeats still pages)", () => {
  // The regex is anchored on `from (public.)?loop_heartbeats` as the first FROM target;
  // a JOIN whose first FROM is a different table won't match — which is the outcome
  // we want, because a caller that joins is product code, not the ad hoc direct-REST
  // read.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.beat_at does not exist",
      "select a.id, h.beat_at from public.loop_alerts a join public.loop_heartbeats h on h.loop_id = a.loop_id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise KEEPS a DIFFERENT column-missing on loop_heartbeats (a real column rename regression still pages)", () => {
  // Real `loop_heartbeats` columns — if any of these regress we absolutely want the
  // page. In particular `loop_id` and `ran_at` are the real columns the drop targets'
  // legacy names (`loop` / `beat_at`) stand in for; a regression on them stays paged.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.loop_id does not exist",
      "select loop_id from public.loop_heartbeats where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.ran_at does not exist",
      "select ran_at from public.loop_heartbeats where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.kind does not exist",
      "select kind from public.loop_heartbeats where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.ok does not exist",
      "select ok from public.loop_heartbeats where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.produced does not exist",
      "select produced from public.loop_heartbeats where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise KEEPS a column-missing error on any OTHER table (a different table with a beat_at / loop column still pages)", () => {
  // If any other table had a real `beat_at` or `loop` column and regressed, we
  // absolutely want to see it — the pin is `loop_heartbeats.` only.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column cron_runs.beat_at does not exist",
      "select beat_at from public.cron_runs where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_alerts.loop does not exist",
      "select loop from public.loop_alerts where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise KEEPS a PostgREST CTE wrapper on a DIFFERENT table (a real schema regression on another table still pages)", () => {
  // Same wrapper shape but the wrapped SELECT reads a different table — the pin is
  // `loop_heartbeats` only; a regression on an adjacent table is one we want to see.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_alerts.beat_at does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_alerts"."id", "public"."loop_alerts"."beat_at" FROM "public"."loop_alerts" WHERE "public"."loop_alerts"."workspace_id" = $1 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on loop_heartbeats (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "database is shutting down",
      "select id from public.loop_heartbeats where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      'duplicate key value violates unique constraint "loop_heartbeats_feed_minute_uidx"',
      "insert into public.loop_heartbeats (loop_id, kind, ran_at) values ($1, $2, now())",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "canceling statement due to statement timeout",
      "select id from public.loop_heartbeats where loop_id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise returns false on empty / nullish inputs", () => {
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise("", ""),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.beat_at does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "",
      "select beat_at from public.loop_heartbeats",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise ALSO drops the payload / status direct-REST sample (supabase-logs:dbb86fe54d00aac0)", () => {
  // The captured production CTE query shape — a stale foreign direct-REST client reads
  // `select=payload,status,...` against the heartbeat table. Neither `payload` nor
  // `status` has ever shipped as a column; real per-run state is `kind` / `ok` /
  // `produced` / `detail`. PostgREST wraps the SELECT in `WITH pgrst_source AS ( ... )`.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.payload does not exist",
      'WITH pgrst_source AS ( SELECT "public"."loop_heartbeats"."payload", "public"."loop_heartbeats"."status" FROM "public"."loop_heartbeats" WHERE "public"."loop_heartbeats"."loop_id" = $1 ORDER BY "public"."loop_heartbeats"."ran_at" DESC LIMIT $2 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column public.loop_heartbeats.payload does not exist",
      'WITH pgrst_source AS (SELECT "public"."loop_heartbeats"."payload" FROM "public"."loop_heartbeats")',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.status does not exist",
      'WITH pgrst_source AS (SELECT "public"."loop_heartbeats"."status" FROM "public"."loop_heartbeats")',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column public.loop_heartbeats.status does not exist",
      'WITH pgrst_source AS (SELECT "public"."loop_heartbeats"."status" FROM "public"."loop_heartbeats")',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "ERROR: column loop_heartbeats.payload does not exist",
      'WITH pgrst_source AS (SELECT "public"."loop_heartbeats"."payload" FROM "public"."loop_heartbeats")',
    ),
    true,
  );
  // Bare SELECT lookup variant — same ad hoc read without the PostgREST CTE wrapper.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.payload does not exist",
      "select payload, status from public.loop_heartbeats where loop_id = 'triage-escalations-cron'",
    ),
    true,
  );
  // Unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.status does not exist",
      "select status from loop_heartbeats limit 10",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise KEEPS a non-SELECT / real-column message on payload / status (a real code-write still pages)", () => {
  // Negative: an INSERT / UPDATE referencing the off-schema payload / status column is
  // real code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.payload does not exist",
      "insert into public.loop_heartbeats (loop_id, payload, ran_at) values ($1, $2, now())",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.status does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."loop_heartbeats" SET "status" = $1 WHERE "public"."loop_heartbeats"."id" = $2 )',
    ),
    false,
  );
  // Negative: a real-column message (a genuine column regression on a shipped column)
  // on the same SELECT shape still pages — the pin covers the off-schema names only.
  assert.equal(
    isForeignSupabasePostgresMissingLoopHeartbeatsBeatAtDirectRestNoise(
      "column loop_heartbeats.detail does not exist",
      "select detail from public.loop_heartbeats where loop_id = 'x'",
    ),
    false,
  );
});

// ── isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise ──
// Spec: error-feed-drop-workspace-members-customer-id-direct-rest-no.
// Control Tower signature: supabase-logs:a19c9bdd091bdaa8.
// Drops the SELECT lookup shape for `workspace_members.customer_id` or
// `workspace_members.external_customer_id` — columns the membership table has NEVER
// carried (members link workspace↔user, not workspace↔customer). Any other column, any
// non-SELECT statement shape, any JOIN, any different table, any FATAL/PANIC/
// constraint failure still pages.

test("isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise drops the captured supabase-logs:a19c9bdd091bdaa8 PostgREST CTE sample on workspace_members.customer_id", () => {
  // The production PostgREST CTE sample — a stale foreign direct-REST client asks for
  // `customer_id` as if the membership row carried a customer FK. PostgREST wraps the
  // SELECT in `WITH pgrst_source AS ( ... )` with double-quoted identifiers.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column workspace_members.customer_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."workspace_members"."workspace_id", "public"."workspace_members"."user_id" FROM "public"."workspace_members" WHERE "public"."workspace_members"."customer_id" = $1 LIMIT $2 OFFSET $3 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column public.workspace_members.customer_id does not exist",
      'WITH pgrst_source AS (SELECT "public"."workspace_members"."customer_id" FROM "public"."workspace_members")',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "ERROR: column workspace_members.customer_id does not exist",
      'WITH pgrst_source AS (SELECT "public"."workspace_members"."customer_id" FROM "public"."workspace_members")',
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise ALSO drops the external_customer_id sibling miss", () => {
  // The sibling off-schema column name — same drop class, same foreign caller shape.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column workspace_members.external_customer_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."workspace_members"."external_customer_id" FROM "public"."workspace_members" WHERE "public"."workspace_members"."external_customer_id" = $1 LIMIT $2 OFFSET $3 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column public.workspace_members.external_customer_id does not exist",
      'WITH pgrst_source AS (SELECT "public"."workspace_members"."external_customer_id" FROM "public"."workspace_members")',
    ),
    true,
  );
  // Bare SELECT lookup variant — same ad hoc read without the PostgREST CTE wrapper.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column workspace_members.external_customer_id does not exist",
      "select external_customer_id from public.workspace_members where external_customer_id = 'cx_123'",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise drops the bare SELECT lookup variant", () => {
  // The non-PostgREST bare-SELECT shape — same ad hoc read without the CTE wrapper.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column workspace_members.customer_id does not exist",
      "select customer_id, user_id from public.workspace_members where customer_id = 'cx_123'",
    ),
    true,
  );
  // Unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column workspace_members.customer_id does not exist",
      "select customer_id from workspace_members limit 10",
    ),
    true,
  );
  // Case-insensitive on the query, with trailing WHERE / ORDER BY / LIMIT.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column workspace_members.customer_id does not exist",
      "SELECT CUSTOMER_ID, USER_ID FROM PUBLIC.WORKSPACE_MEMBERS ORDER BY CUSTOMER_ID DESC LIMIT 50",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "  column workspace_members.customer_id does not exist  ",
      "   select customer_id from public.workspace_members   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise KEEPS a non-SELECT statement shape (a real code-bug writing customer_id still pages)", () => {
  // INSERT / UPDATE / DELETE against the table referencing a bogus column is real code
  // trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column workspace_members.customer_id does not exist",
      "insert into public.workspace_members (workspace_id, user_id, customer_id) values ($1, $2, $3)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column workspace_members.customer_id does not exist",
      "update public.workspace_members set customer_id = $1 where workspace_id = $2 and user_id = $3",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column workspace_members.external_customer_id does not exist",
      "delete from public.workspace_members where external_customer_id = $1",
    ),
    false,
  );
  // Sibling: the PostgREST CTE wrapper whose wrapped op is a WRITE stays paged too.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column workspace_members.customer_id does not exist",
      'WITH pgrst_source AS ( INSERT INTO "public"."workspace_members"("workspace_id", "user_id", "customer_id") VALUES ($1, $2, $3) RETURNING "public"."workspace_members"."workspace_id" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column workspace_members.external_customer_id does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."workspace_members" SET "external_customer_id" = $1 WHERE "public"."workspace_members"."user_id" = $2 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise KEEPS a column-missing on a DIFFERENT workspace_members column (a real column rename regression still pages)", () => {
  // Real `workspace_members` columns — if any of these regress we absolutely want the
  // page. The pin is `customer_id` / `external_customer_id` only.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column workspace_members.workspace_id does not exist",
      "select workspace_id from public.workspace_members where user_id = 'u1'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column workspace_members.user_id does not exist",
      "select user_id from public.workspace_members where workspace_id = 'w1'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column workspace_members.role does not exist",
      "select role from public.workspace_members where user_id = 'u1'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column workspace_members.display_name does not exist",
      "select display_name from public.workspace_members where user_id = 'u1'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise KEEPS a column-missing error on any OTHER table (a different table with a customer_id column still pages)", () => {
  // Many ShopCX tables genuinely carry a `customer_id` FK (tickets, subscriptions,
  // orders, customer_events). If any of them regress we absolutely want to see it — the
  // pin is `workspace_members.` only.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column tickets.customer_id does not exist",
      "select customer_id from public.tickets where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column subscriptions.customer_id does not exist",
      "select customer_id from public.subscriptions where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column customers.external_customer_id does not exist",
      "select external_customer_id from public.customers where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise KEEPS a JOIN whose first FROM is another table (a real code shape joining workspace_members still pages)", () => {
  // The regex is anchored on `from (public.)?workspace_members` as the first FROM
  // target; a JOIN whose first FROM is a different table won't match — which is the
  // outcome we want, because a caller that joins is product code, not the ad hoc
  // direct-REST read.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column workspace_members.customer_id does not exist",
      "select w.id, m.customer_id from public.workspaces w join public.workspace_members m on m.workspace_id = w.id",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise KEEPS a PostgREST CTE wrapper on a DIFFERENT table (a real schema regression on another table still pages)", () => {
  // Same wrapper shape but the wrapped SELECT reads a different table — the pin is
  // `workspace_members` only; a regression on an adjacent table is one we want to see.
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column tickets.customer_id does not exist",
      'WITH pgrst_source AS ( SELECT "public"."tickets"."id", "public"."tickets"."customer_id" FROM "public"."tickets" WHERE "public"."tickets"."workspace_id" = $1 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on workspace_members (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "database is shutting down",
      "select workspace_id from public.workspace_members where user_id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      'duplicate key value violates unique constraint "workspace_members_pkey"',
      "insert into public.workspace_members (workspace_id, user_id) values ($1, $2)",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "canceling statement due to statement timeout",
      "select workspace_id from public.workspace_members where user_id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise returns false on empty / nullish inputs", () => {
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise("", ""),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "column workspace_members.customer_id does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingWorkspaceMembersCustomerIdDirectRestNoise(
      "",
      "select customer_id from public.workspace_members",
    ),
    false,
  );
});

// ── isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise ──
// A foreign / stale PostgREST direct-REST client reads
// `/rest/v1/subscriptions?select=...paused_until...` against our `public.subscriptions`
// table. The table exists but its canonical pause timestamp is `pause_resume_at`, not
// `paused_until`. Foreign-owned surface, no lever from us — drop AT CAPTURE only when
// BOTH the exact column-missing message on `subscriptions.paused_until` AND the bare
// SELECT-lookup shape on `subscriptions` are present. A column-missing on any other
// table, a different column on `subscriptions`, or a non-SELECT statement still pages.

test("isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise drops the ad hoc SELECT lookup on the exact subscriptions.paused_until column-missing shape", () => {
  // The captured PostgREST direct-REST shape — unqualified and public.-qualified variants.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "column subscriptions.paused_until does not exist",
      "select id, paused_until from public.subscriptions where status = 'paused' limit 100",
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "column public.subscriptions.paused_until does not exist",
      "select id, paused_until from public.subscriptions where status = 'paused' limit 100",
    ),
    true,
  );
  // The unqualified FROM (no `public.`) is the same class.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "column subscriptions.paused_until does not exist",
      "select paused_until from subscriptions limit 10",
    ),
    true,
  );
  // A trailing WHERE / ORDER BY / LIMIT is still the ad hoc lookup shape.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "column subscriptions.paused_until does not exist",
      "select id, paused_until from public.subscriptions where paused_until < now() order by paused_until desc limit 50",
    ),
    true,
  );
  // Case-insensitive on the query.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "column subscriptions.paused_until does not exist",
      "SELECT ID, PAUSED_UNTIL FROM PUBLIC.SUBSCRIPTIONS",
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "ERROR: column subscriptions.paused_until does not exist",
      "select paused_until from public.subscriptions",
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "  column subscriptions.paused_until does not exist  ",
      "   select paused_until from public.subscriptions   ",
    ),
    true,
  );
});

test("isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise KEEPS a column-missing error on any OTHER table (a table that DOES have a paused_until column still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "column journeys.paused_until does not exist",
      "select paused_until from public.journeys where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "column campaigns.paused_until does not exist",
      "select paused_until from public.campaigns where id = $1",
    ),
    false,
  );
});

test("isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise KEEPS a DIFFERENT column-missing on subscriptions (the real `pause_resume_at` column renamed still pages)", () => {
  // The real pause timestamp column is `pause_resume_at`. If someone breaks that, we want to see it.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "column subscriptions.pause_resume_at does not exist",
      "select pause_resume_at from public.subscriptions where status = 'paused'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "column subscriptions.next_billing_date does not exist",
      "select next_billing_date from public.subscriptions where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise KEEPS a non-SELECT statement shape (a real code-bug writing subscriptions.paused_until still pages)", () => {
  // INSERT / UPDATE / DELETE against subscriptions referencing a bogus column is real
  // code trying to write the table — a bug we WANT to see, not the ad hoc read.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "column subscriptions.paused_until does not exist",
      "insert into public.subscriptions (id, paused_until) values ($1, now())",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "column subscriptions.paused_until does not exist",
      "update public.subscriptions set paused_until = now() where id = $1",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "column subscriptions.paused_until does not exist",
      "delete from public.subscriptions where paused_until < now() - interval '90 days'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise KEEPS a FATAL / PANIC / constraint / other Postgres ERROR on subscriptions (different message class still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "database is shutting down",
      "select id from public.subscriptions where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      'duplicate key value violates unique constraint "subscriptions_pkey"',
      "select id from public.subscriptions where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "canceling statement due to statement timeout",
      "select id from public.subscriptions where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      'permission denied for relation "public.subscriptions"',
      "select id from public.subscriptions where id = 'x'",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      'relation "public.subscriptions" does not exist',
      "select id from public.subscriptions where id = 'x'",
    ),
    false,
  );
});

test("isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "column subscriptions.paused_until does not exist",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "column subscriptions.paused_until does not exist",
      null,
    ),
    false,
  );
});

test("isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise drops the PostgREST pgrst_source CTE read, keeps a PostgREST write", () => {
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "column subscriptions.paused_until does not exist",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions"."id", "public"."subscriptions"."paused_until" FROM "public"."subscriptions" WHERE "public"."subscriptions"."id" = $1 LIMIT $2 OFFSET $3 )',
    ),
    true,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsPausedUntilLookupNoise(
      "column subscriptions.paused_until does not exist",
      'WITH pgrst_source AS ( UPDATE "public"."subscriptions" SET "paused_until" = $1 WHERE "id" = $2 RETURNING * )',
    ),
    false,
  );
});

// ── isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise ──
// A foreign / stale PostgREST direct-REST client calls
// `/rest/v1/subscriptions?items=cs.<value>` with a non-JSON value, which Postgres reports
// as `invalid input syntax for type json` under the PostgREST
// `WITH pgrst_source AS ( SELECT ... FROM "public"."subscriptions" ... WHERE ... "items" @> ... )`
// CTE wrapper. ShopCX code never issues a direct `items @>` containment filter — the only
// JSONB @>-on-items path is the `public.list_subscriptions` RPC. Foreign-owned surface, no
// lever from us — drop AT CAPTURE only when BOTH the exact invalid-JSON message AND the
// PostgREST SELECT-CTE wrapper carrying both `"items"` and `@>` are present. A different
// column, a different JSONB operator, a non-SELECT wrapper, or any other table still pages.

test("isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise drops the exact captured items @> invalid-JSON shape", () => {
  // The captured PostgREST direct-REST shape from Control Tower signature
  // supabase-logs:dbe2c7bfb3216740 — a `items=cs.<value>` containment filter whose
  // value failed JSON parse.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions".* FROM "public"."subscriptions" WHERE "public"."subscriptions"."items" @> \'["x"]\' LIMIT $1 OFFSET $2 )',
    ),
    true,
  );
  // Postgres's `ERROR: ` prefix is stripped before the equality check.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "ERROR: invalid input syntax for type json",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions".* FROM "public"."subscriptions" WHERE "public"."subscriptions"."items" @> \'["x"]\' )',
    ),
    true,
  );
  // Leading / trailing whitespace on the message and query is tolerated.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "  invalid input syntax for type json  ",
      '   WITH pgrst_source AS ( SELECT "public"."subscriptions".* FROM "public"."subscriptions" WHERE "public"."subscriptions"."items" @> \'[]\' )   ',
    ),
    true,
  );
  // Case-insensitive on the query — PostgREST sometimes echoes uppercase keywords.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'WITH PGRST_SOURCE AS ( SELECT "public"."subscriptions".* FROM "public"."subscriptions" WHERE "public"."subscriptions"."items" @> $1 )',
    ),
    true,
  );
});

test("isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise KEEPS the same invalid-JSON message against any OTHER wrapped FROM relation (a real code bug on another table still pages)", () => {
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'WITH pgrst_source AS ( SELECT "public"."orders".* FROM "public"."orders" WHERE "public"."orders"."items" @> \'["x"]\' )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'WITH pgrst_source AS ( SELECT "public"."carts".* FROM "public"."carts" WHERE "public"."carts"."items" @> \'[]\' )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise KEEPS the same invalid-JSON message against public.subscriptions with no items / no @> pair (a different column or operator still pages)", () => {
  // Same table, different column — a real JSON parse bug on a different jsonb column.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions".* FROM "public"."subscriptions" WHERE "public"."subscriptions"."metadata" @> \'["x"]\' )',
    ),
    false,
  );
  // Same table, items column, but a DIFFERENT JSONB operator (`?` key-exists, not @>).
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions".* FROM "public"."subscriptions" WHERE "public"."subscriptions"."items" ? \'sku\' )',
    ),
    false,
  );
  // Same table, items column, but the `?|` any-key operator.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions".* FROM "public"."subscriptions" WHERE "public"."subscriptions"."items" ?| array[\'a\',\'b\'] )',
    ),
    false,
  );
  // Same table, items column, but the `->` / `->>` JSON path extract.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions"."items" -> 0 FROM "public"."subscriptions" )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions"."items" ->> 0 FROM "public"."subscriptions" )',
    ),
    false,
  );
  // Same table, items column, but a plain `=` / `LIKE` on a text-ish compare.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions".* FROM "public"."subscriptions" WHERE "public"."subscriptions"."items" = $1 )',
    ),
    false,
  );
  // Any plain SELECT on subscriptions without items/@>.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions"."id" FROM "public"."subscriptions" WHERE "public"."subscriptions"."status" = $1 )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise KEEPS a non-SELECT PostgREST wrapper on subscriptions (a real code-bug INSERT / UPDATE on items still pages)", () => {
  // INSERT / UPDATE / DELETE wrapped in a PostgREST pgrst_source CTE on subscriptions
  // referencing items @> is real code attempting to write — a bug we DO want to see.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'WITH pgrst_source AS ( INSERT INTO "public"."subscriptions" ("items") VALUES ($1) RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'WITH pgrst_source AS ( UPDATE "public"."subscriptions" SET "items" = $1 WHERE "public"."subscriptions"."items" @> \'[]\' RETURNING * )',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      'WITH pgrst_source AS ( DELETE FROM "public"."subscriptions" WHERE "public"."subscriptions"."items" @> \'[]\' RETURNING * )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise KEEPS a different Postgres ERROR class (FATAL / PANIC / constraint / permission / relation-missing on subscriptions still pages)", () => {
  const q =
    'WITH pgrst_source AS ( SELECT "public"."subscriptions".* FROM "public"."subscriptions" WHERE "public"."subscriptions"."items" @> \'[]\' )';
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "database is shutting down",
      q,
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      'duplicate key value violates unique constraint "subscriptions_pkey"',
      q,
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "canceling statement due to statement timeout",
      q,
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      'permission denied for relation "public.subscriptions"',
      q,
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      'relation "public.subscriptions" does not exist',
      q,
    ),
    false,
  );
  // A near-miss message that mentions json but isn't the canonical shape.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type jsonb",
      q,
    ),
    false,
  );
});

test("isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise returns false on empty / nullish input", () => {
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(null, null),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(undefined, undefined),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise("", ""),
    false,
  );
  // Empty query — even with the exact message we cannot confirm the shape, so the row
  // stays captured.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      "",
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "invalid input syntax for type json",
      null,
    ),
    false,
  );
  // Empty message — the shape alone isn't enough.
  assert.equal(
    isForeignSupabasePostgresSubscriptionsItemsContainmentInvalidJsonAdhocNoise(
      "",
      'WITH pgrst_source AS ( SELECT "public"."subscriptions".* FROM "public"."subscriptions" WHERE "public"."subscriptions"."items" @> \'[]\' )',
    ),
    false,
  );
});

test("isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise KEEPS a PostgREST write CTE even when its outer statement is a SELECT", () => {
  // PostgREST renders writes as `with pgrst_source as (<write> returning …) select … from pgrst_source`;
  // the outer SELECT must not make a real DELETE/UPDATE on error_events look like an ad hoc read.
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.metadata does not exist",
      'with pgrst_source as (delete from "public"."error_events" where "metadata" is null returning *) select count(*) from "pgrst_source"',
    ),
    false,
  );
  assert.equal(
    isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(
      "column error_events.first_seen does not exist",
      'with pgrst_source as (update "public"."error_events" set "first_seen" = $1 from "public"."error_events" e2 returning *) select * from "pgrst_source"',
    ),
    false,
  );
});
