# libraries/error-feed

**Error source classifiers and noise filters for Control Tower — determines which errors page an owner vs. silently drop.**

**File:** `src/lib/control-tower/error-feed.ts`

## Purpose

The error feed ingests errors from [[../inngest/supabase-log-poll]], [[../inngest/control-tower-monitor]], and other sources. Before recording an error_event, each source applies a series of narrowly-gated classifiers that either **drop** the error (return `null`, do not record) or **mark it transient** (record for visibility but auto-resolve on first sighting unless it recurs). The classifiers prevent noise (foreign-app errors, intentional constraint violations, momentary gateway saturation) from paging owners.

## Classifier families

### Transient-noise flags

Mark an error as collateral of a brief, self-healing incident (momentary gateway saturation, brief connection loss). A first sighting is recorded for **visibility only**, with **no page**; escalates to a real open+page only if the same signature recurs within `TRANSIENT_RECUR_WINDOW_MS` (1h).

**Functions:**
- `isTransientInngestTransportError` — Inngest connection timeouts / unavailable (self-heals when service recovers).
- `isTransientInngestStepRetryThrow` — Inngest step retry logic throwing a transient cause (not a durable code bug).
- `isTransientSupabaseLogNoise` — Postgres `statement timeout` / connection saturation, edge API 5xx (momentary DB / gateway saturation).
- `isTransientShopifyWebhookHmacFailure` — Shopify webhook HMAC validation failing transient (clock skew, stale cert).
- `isTransientAppstleFrequencyUpstreamTimeout` — Appstle frequency check timing out (Appstle service overload, not our code).
- `isTransientClientNetworkAbort` — Client network abort (browser closed, WiFi dropped).

**Contrast:** A Postgres `FATAL`/`PANIC`, non-timeout ERROR (constraint / data bug), auth error, or non-5xx HTTP status is NEVER transient — pages on first sighting.

### Foreign-noise drops

Errors from external systems querying our schema wrong (stale REST clients, external integrations, direct REST lookups against columns that don't exist). These return `null` — drop, do not record an error_event.

**Families:**

- **Supabase Postgres missing-column noise** — external clients or stale direct-REST queries against phantom columns. Each is narrowly gated: `isForeignSupabasePostgres...ColumnAdhocNoise(message, query)` matches a **specific trimmed message** (e.g., `column returns.refund_type does not exist`) AND a **SELECT-only query** on that table (bare `SELECT ... FROM public.returns` OR the PostgREST `WITH pgrst_source AS (SELECT ... FROM "public"."returns" ...)` CTE wrapper), never a write/DDL/JOIN/different table. Each has a unit test covering true/false cases.

  Examples: `isForeignSupabasePostgresMissingAppstleContractSnapshotsUpdatedAtAdhocNoise` (the phantom `appstle_contract_snapshots.updated_at` column — the ledger's real temporal columns are `fetched_at` / `created_at`; a foreign sort/select on `updated_at` pages no one), `isForeignSupabasePostgresMissingCouponsDiscountTypeColumnNoise` (the phantom `coupons.discount_type` column — external clients probing a generic coupon schema; narrowly gated to SELECT-only queries, preserving pages on real code-path writes to coupons), `isForeignSupabasePostgresMissingCrisisEventsProductTitleColumnNoise` (the phantom `crisis_events.product_title` and `crisis_events.variant_title` columns — external/stale REST clients reading crisis_events with off-schema column names; narrowly gated to bare SELECT or PostgREST CTE wrapper queries, preserving pages on real code-path writes to crisis_events), `isForeignSupabasePostgresMissingCustomersAddressColumnAdhocNoise` (the `customers.address` column Appstle or external clients guess at), `isForeignSupabasePostgresMissingDirectorActivityDecisionDirectRestLookupNoise` (the phantom `director_activity.decision` column — external tools stale REST lookups against a column that never existed in our schema, narrowly gated to SELECT-only queries to preserve paging on real code-path writes), `isForeignSupabasePostgresMissingDirectorActivityKindDirectRestLookupNoise` (the phantom `director_activity.kind` column — foreign direct-REST lookups emit both table-qualified (`column director_activity.kind does not exist`) and unqualified forms (`column "kind" does not exist`); the classifier gates both on SELECT-only queries to `director_activity`, preserving pages on real code-path writes to that column), `isForeignSupabasePostgresMissingOrdersCancelledAtColumnAdhocNoise` (the phantom `orders.cancelled_at` column — our orders table has no cancel timestamp (that lives on `subscriptions`), but foreign Shopify-shaped queries probe for it; narrowly gated to SELECT-only queries, preserving pages on real code-path writes to orders), `isForeignSupabasePostgresMissingReturnsRefundTypeColumnAdhocNoise` (the phantom `returns.refund_type` column external REST clients query), `isForeignSupabasePostgresMissingReturnsResolutionColumnAdhocNoise` (the phantom `returns.resolution` column external REST clients query — mirrors the refund_type sibling), `isForeignSupabasePostgresMissingTicketDirectionsCreatedAtAdhocNoise` (the phantom `ticket_directions.created_at` column — a foreign PostgREST read of an incorrect column that was never created; narrowly gated to SELECT-only queries, preserving pages on real code-path writes to ticket_directions), `isForeignSupabasePostgresMissingTicketMessagesChannelAdhocNoise` (the phantom `ticket_messages.channel` column that lives on `tickets` instead — external ad-hoc tools querying ticket_messages for a missing column, narrowly gated to SELECT-only queries, preserving pages on real code-path writes to ticket_messages), `isForeignSupabasePostgresMissingTicketMessagesIsInternalAdhocNoise` (the phantom `ticket_messages.is_internal` column — our real internal-vs-customer visibility column is `visibility`; external ad-hoc tools and stale integrations probe for a non-existent `is_internal` boolean, narrowly gated to SELECT-only queries on `ticket_messages`, preserving pages on real code-path writes), `isForeignSupabasePostgresMissingTicketsLastCustomerMessageAtColumnNoise` (the phantom `tickets.last_customer_message_at` column — foreign/stale direct-REST clients SELECT this non-existent column from `public.tickets`, narrowly gated to bare SELECT-from-tickets or PostgREST CTE wrapper queries, preserving pages on real code-path writes to tickets).

- **Supabase Postgres type-syntax noise on uuid columns** — direct-REST or Studio quick-filter probes passing malformed UUIDs to uuid primary-key columns. Each is narrowly gated to the equality form and a specific error message. Examples: `isForeignSupabasePostgresInvalidUuidSyntaxOnTicketsIdAdhocNoise` (a hand-typed or truncated UUID pasted into Studio/REST quick-filter, rejected by Postgres with `invalid input syntax for type uuid` on `tickets.id` equality read — no ShopCX code binds a malformed UUID to tickets.id), `isForeignSupabasePostgresUuidLikeOnTicketsIdAdhocNoise` (the LIKE operator form of the same probe, rejected with `operator does not exist: uuid ~~ unknown`).

- **Supabase Postgres constraint / type noise** — expected-by-design constraint violations or type coercions from retries. Examples: `isExpectedBillingForecastsPendingUniqViolation` (23505 on `billing_forecasts_pending_uniq`; intentional idempotency-race pattern where the second concurrent insert is rejected), `isExpectedSubscriptionCycleChargesCycleUniqViolation` (same pattern for subscription billing).

- **Foreign gateway noise** — errors from payment processors, third-party APIs, when our code has no repair leverage. Examples: `isForeignBraintreeVaultProcessorDecline` (card processor decline on Braintree vault operations), `isForeignEasyPostReturnsSweepRateLimit` (EasyPost rate-limit on the returns label sweep).

- **Foreign auth/edge noise** — Supabase GoTrue and Edge Function errors we cannot fix. Examples: `isForeignGoTrueEdgeNoise` (SSL handshake, HTML body on Edge), `isForeignGoTrueAuthLogNoise` (auth service connection timeout, localhost dial timeout).

### Bare / middleware-log filters

Filters for logs that are NOT errors but are tagged as such (log lines emitted by middleware). These return `null` and never create an error_event.

**Functions:**
- `isBareLifecycle` — `@vercel/sdk` logging a successful request / response that looks like an error.
- `isBareInngestStepErrorMiddlewareLog` — Inngest middleware logging a step error (not a durable failure).
- `isInngestStepWrappedNonErrorLog` — Inngest middleware wrapping a non-Error in a failed step (not a real error).
- `isInngestTerminalFailureMirrorLog` — Inngest logging a terminal failure that was already recorded (duplicate).
- `isAbortedStreamNoise` — Vercel streaming error (client disconnected, not our failure).

## Signature generation

**`signatureFor(source, keyParts): string`** — generates a stable signature from a source + key parts (e.g., error message + query hash), used to group identical incidents and detect spikes.

## Tests

All classifiers are unit-tested in `src/lib/control-tower/error-feed.test.ts`. Each foreign-noise helper has test cases for:
- The exact signature it should match (true case).
- False cases: a different column name, a different table, a write/DDL statement, etc.

## Called by

- [[../inngest/supabase-log-poll]] (`postgres` LogQuery `mapRow` pre-check before grouping).
- [[../inngest/control-tower-monitor]] (other source channels: Inngest, Vercel, client errors).
- [[../libraries/control-tower]] (via `recordError` path).

## Related

[[../tables/error_events]] (recorded incidents) · [[../operational-rules]] (supervisable autonomy — noise must be dropped before it creates a signature) · [[../integrations/supabase-management-logs]]

---

[[../README]] · [[../inngest/supabase-log-poll]] · [[../tables/error_events]]
