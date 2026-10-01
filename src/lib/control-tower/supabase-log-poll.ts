/**
 * Control Tower — Supabase Management Logs poller (error-feed-monitoring Phase 2).
 *
 * The fourth "hidden surface": DB-LEVEL Supabase errors our own app code NEVER sees —
 * Postgres ERROR/FATAL/PANIC (constraint violations behind RLS, slow-query/timeouts),
 * auth-service errors, and API 5xxs at the edge. The app-layer reportDbError (Phase 1)
 * only catches errors our code holds a `{ error }` for; this pulls the rest straight
 * from Supabase's own logs via the **Management Logs API** (`logs` ClickHouse endpoint —
 * the replacement Supabase shipped when the old `logs.all` SQL endpoint was removed on
 * 2026-09-23, see the changelog referenced in [[../integrations/supabase-management-logs]]).
 *
 * Needs the LONE owner setup of this spec: a Supabase access token (personal/management —
 * the service-role key we have is for data, NOT logs). Pasted once via the owner-only API,
 * stored AES-256-GCM encrypted in error_feed_supabase_config. Until it exists this poller
 * is a no-op (the panel stays green) and the Phase 1 app-layer reporter covers what it can.
 *
 * Each poll asks the API for the (last_polled_at, now] window (capped to 24h — the API's
 * max range), groups every error row by (source, signature) client-side, and records it
 * into the SAME error_events store as Phase 1 under source='supabase-logs' (its own panel),
 * paging owners on a new signature / spike (rate-limited) exactly like the other feeds.
 *
 * BEST-EFFORT: a per-source query failure is logged + skipped, never thrown — a log poller
 * that can crash the cron it runs in is worse than the gap it closes.
 *
 * See docs/brain/integrations/supabase-management-logs.md · docs/brain/specs/error-feed-monitoring.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { encrypt, decrypt } from "@/lib/crypto";
import {
  recordError,
  recordFeedDelivery,
  signatureFor,
  isTransientSupabaseLogNoise,
  isForeignGoTrueEdgeNoise,
  isForeignGoTrueAuthLogNoise,
  isForeignSupabasePostgresMissingControlTowerEventsLookupNoise,
  isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise,
  isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise,
  isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise,
  isForeignSupabasePostgresMissingOrdersSourceColumnNoise,
  isForeignSupabasePostgresMissingTicketMessagesSenderTypeAdhocNoise,
  isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise,
  isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise,
  isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise,
  isForeignSupabasePostgresAggregateIntrospectionNoise,
  isForeignSupabasePostgresAmbiguousOidIntrospectionNoise,
  isForeignSupabasePostgresOrdersNameLookupNoise,
  isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise,
  isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise,
  isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise,
  isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise,
  isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise,
  isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise,
  isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise,
  isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise,
  isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise,
  isForeignSupabasePostgresPoliciesKindLookupNoise,
  isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise,
  isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise,
  isForeignSupabasePostgresMissingSpecsCurrentPhaseAdhocNoise,
  isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise,
  isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise,
  isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise,
  isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise,
  isForeignSupabasePostgresMissingProductsPricingRuleIdLookupNoise,
  isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise,
  isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise,
  isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise,
  isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise,
  isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise,
  isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise,
  isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise,
  isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation,
  isExpectedBillingForecastsPendingUniqViolation,
} from "@/lib/control-tower/error-feed";

type Admin = ReturnType<typeof createAdminClient>;

const CONFIG_ID = "singleton";
const MANAGEMENT_API_BASE = "https://api.supabase.com/v1";
/** The API caps a (start, end] query window at 24h; never ask for more. */
const MAX_WINDOW_MS = 24 * 60 * 60_000;
/** First-ever poll (no cursor) looks back this far. */
const DEFAULT_LOOKBACK_MS = 60 * 60_000;
/** Per-source row cap per poll — a flood folds to a few incidents anyway. */
const ROW_LIMIT = 100;

export interface SupabaseLogConfig {
  token: string;
  projectRef: string;
  lastPolledAt: string | null;
}

/** Parse the project ref (the `<ref>` in https://<ref>.supabase.co) from the env URL. */
export function projectRefFromEnv(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  const m = url.match(/^https?:\/\/([a-z0-9]+)\.supabase\.(co|in|net)/i);
  return m ? m[1] : null;
}

/**
 * Read + decrypt the poller config. Returns null when no token is configured (the
 * common pre-setup state) — callers treat null as "not yet configured, no-op".
 */
export async function getSupabaseLogConfig(adminClient?: Admin): Promise<SupabaseLogConfig | null> {
  const admin = adminClient ?? createAdminClient();
  const { data } = await admin
    .from("error_feed_supabase_config")
    .select("access_token_encrypted, project_ref, last_polled_at")
    .eq("id", CONFIG_ID)
    .maybeSingle();
  const row = data as
    | { access_token_encrypted: string | null; project_ref: string | null; last_polled_at: string | null }
    | null;
  if (!row?.access_token_encrypted) return null;
  const projectRef = row.project_ref || projectRefFromEnv();
  if (!projectRef) return null;
  let token: string;
  try {
    token = decrypt(row.access_token_encrypted);
  } catch (e) {
    console.warn("[supabase-log-poll] token decrypt failed:", e instanceof Error ? e.message : e);
    return null;
  }
  return { token, projectRef, lastPolledAt: row.last_polled_at };
}

/** True iff an access token is stored — what the owner UI reads (never the token itself). */
export async function isSupabaseLogPollConfigured(adminClient?: Admin): Promise<boolean> {
  const admin = adminClient ?? createAdminClient();
  const { data } = await admin
    .from("error_feed_supabase_config")
    .select("access_token_encrypted")
    .eq("id", CONFIG_ID)
    .maybeSingle();
  return Boolean((data as { access_token_encrypted: string | null } | null)?.access_token_encrypted);
}

/** Encrypt + upsert the owner's Supabase access token (the lone owner setup of this spec). */
export async function setSupabaseAccessToken(
  token: string,
  opts: { projectRef?: string } = {},
  adminClient?: Admin,
): Promise<void> {
  const admin = adminClient ?? createAdminClient();
  const { error } = await admin.from("error_feed_supabase_config").upsert(
    {
      id: CONFIG_ID,
      access_token_encrypted: encrypt(token.trim()),
      project_ref: opts.projectRef?.trim() || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) throw new Error(`failed to store Supabase access token: ${error.message}`);
}

/** Remove the stored token — the poller goes back to a no-op (panel stays green). */
export async function clearSupabaseAccessToken(adminClient?: Admin): Promise<void> {
  const admin = adminClient ?? createAdminClient();
  await admin
    .from("error_feed_supabase_config")
    .update({ access_token_encrypted: null, updated_at: new Date().toISOString() })
    .eq("id", CONFIG_ID);
}

// ── The log queries ──────────────────────────────────────────────────────────
// Each pulls error-severity rows from the unified Supabase `logs` ClickHouse endpoint
// (the replacement for the removed `logs.all` SQL endpoint — every source now lives in a
// single `logs` table, filtered by the `source` column; nested fields move from the
// `metadata` array into a flat `log_attributes` map read via `log_attributes['a.b.c']`).
// `mapRow` turns a result row into a grouped incident: keyParts (STABLE bits only —
// the normalizer strips ids/numbers), a panel title, a fuller detail, and a `transient`
// flag (a momentary edge 5xx / Postgres statement-timeout blip — see
// `isTransientSupabaseLogNoise`) so a self-healing saturation blip auto-resolves on first
// sighting and only escalates on recurrence ([[../specs/error-feed-supabase-logs-transient-5xx-scoping]]).

interface LogQuery {
  /** which log source — also the leading bit of the grouping key + the title prefix. */
  key: "postgres" | "auth" | "api";
  sql: string;
  mapRow: (row: Record<string, unknown>) => { keyParts: string[]; title: string; detail: string; transient: boolean } | null;
}

const str = (v: unknown): string => (v == null ? "" : String(v));

const LOG_QUERIES: LogQuery[] = [
  {
    key: "postgres",
    sql:
      "select timestamp, log_attributes['parsed.error_severity'] as severity, log_attributes['parsed.query'] as query, event_message " +
      "from logs " +
      "where source = 'postgres_logs' " +
      "and log_attributes['parsed.error_severity'] in ('ERROR','FATAL','PANIC') " +
      `order by timestamp desc limit ${ROW_LIMIT}`,
    mapRow: (row) => {
      const severity = str(row.severity) || "ERROR";
      const message = str(row.event_message) || "postgres error";
      const query = str(row.query);
      // Drop foreign-app noise at capture: an ad hoc `select * from public.control_tower_events`
      // lookup by an external tool / stale exploratory query. `control_tower_events` is NOT
      // part of the product schema (no migration creates it, no code path queries it) so
      // the relation-missing ERROR is repair work for a query we don't own
      // ([[../specs/error-feed-drop-control-tower-events-adhoc-lookup-noise]], Control Tower
      // signature `supabase-logs:dfa01ed65bdbeb33`). Narrowly gated to require BOTH the
      // exact relation-missing message AND the SELECT-lookup shape — a relation-missing
      // error on any other table, or on `control_tower_events` via a non-SELECT statement
      // (real code-bug shape) still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingControlTowerEventsLookupNoise(message, query)) return null;
      // Drop foreign-app noise at capture: a Supabase SQL Editor lookup that confuses
      // `loop_alerts` with `error_events` — `select * from public.loop_alerts where title
      // = ... / signature = ...`, columns which live on `error_events`, not `loop_alerts`
      // ([[../specs/error-feed-drop-supabase-loop-alerts-adhoc-column-title-nois]],
      // Control Tower signature `supabase-logs:0e3379f172768a91`). Twin of the
      // `control_tower_events` drop above, scoped to the confused-column shape instead of
      // the confused-relation shape. Narrowly gated to require BOTH the exact
      // column-missing message (`title` or `signature`) AND the bare SELECT-lookup shape
      // on `loop_alerts` — a JOIN with `error_events` (real code shape), a real
      // column-missing on a different relation, or a FATAL/PANIC/constraint violation
      // still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingLoopAlertsColumnLookupNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an operator typo — a manual SQL client did a
      // `select ... from error_events` naming the wrong column (`first_seen` instead of
      // our real `first_seen_at`). The resulting undefined_column ERROR is repair work
      // for a query we don't own ([[../specs/error-feed-drop-error-events-first-seen-column-adhoc-lookup-]],
      // Control Tower signature `supabase-logs:41dd87c2e483a884`). Narrowly gated to
      // require BOTH the exact column-missing message AND the bare-SELECT-on-error_events
      // shape that names `first_seen` (not `first_seen_at`) — a column-missing error on
      // any other table, or the same message via a non-SELECT statement, still pages.
      if (isForeignSupabasePostgresMissingErrorEventsFirstSeenColumnNoise(message, query)) return null;
      // Drop foreign-app noise at capture: a Supabase Studio Table Editor click on
      // `public.appstle_api_calls` whose generated PostgREST CTE wrapper names
      // non-existent columns (`method`, `status_code`). The real columns are
      // `request_method` + `response_status` — no ShopCX code path reads the typo'd
      // names, so the resulting column-missing ERROR is repair work for a query no
      // code owns ([[../specs/error-feed-drop-appstle-api-calls-method-column-adhoc-lookup]],
      // Control Tower signature `supabase-logs:b6686000909442f4`). Narrowly gated to
      // require BOTH one of the four exact column-missing messages AND the
      // SELECT-lookup shape on `appstle_api_calls` (bare or PostgREST CTE wrapper) —
      // a column-missing error on any OTHER table, a different column on
      // `appstle_api_calls` (a real schema regression on a live column), or on
      // `appstle_api_calls` via a non-SELECT statement (real code-bug shape) still
      // surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingAppstleApiCallsColumnAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc `select ... source ... from
      // public.orders` lookup by an external tool / stale exploratory query. Our `orders`
      // table exposes `source_name`, not `source` — no ShopCX code path issues a SELECT on
      // `orders.source`, so the resulting column-missing ERROR is repair work for a query
      // we don't own ([[../specs/error-feed-drop-orders-source-column-adhoc-lookup-noise]],
      // Control Tower signature `supabase-logs:76fa4304a4e9fb49`). Narrowly gated to
      // require BOTH the exact column-missing message AND the SELECT-lookup shape — a
      // column-missing error on any other table, or on `orders` via a non-SELECT
      // statement (real code-bug shape), still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingOrdersSourceColumnNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc `select ... sender_type ... from
      // public.ticket_messages` lookup by an external tool (Supabase Studio table editor,
      // foreign SQL client, third-party integration) or the PostgREST CTE wrapper the
      // same client emits. Our `ticket_messages` table has never carried a `sender_type`
      // column — no ShopCX code path names it, so the resulting column-missing ERROR is
      // repair work for a query we don't own
      // ([[../specs/error-feed-drop-ticket-messages-sender-type-adhoc-lookup-noi]],
      // Control Tower signature `supabase-logs:68e241545842ebf7`). Narrowly gated to
      // require BOTH the exact column-missing message AND the SELECT-lookup shape — a
      // column-missing error on any other table, or on `ticket_messages` via a
      // non-SELECT statement (real code-bug shape), still surfaces / pages on first
      // sighting.
      if (isForeignSupabasePostgresMissingTicketMessagesSenderTypeAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc `select ... role ... from
      // public.ticket_messages` lookup by an external tool reading our messages table as
      // if it were an OpenAI-style chat table (role/message_type/content). Our
      // `ticket_messages` table has never carried a `role` column — every ShopCX
      // conversation read uses `direction`, `author_type`, `body`, `body_clean` — so the
      // column-missing ERROR is repair work for a query we don't own
      // ([[../specs/error-feed-drop-ticket-messages-role-adhoc-lookup-noise]], Control
      // Tower signature `supabase-logs:e147a164a6dcdca4`). Same narrow-gating shape as
      // the `sender_type` sibling on the same table: BOTH the exact column-missing
      // message AND the SELECT-lookup shape (bare or PostgREST-CTE) — a column-missing
      // error on a live `ticket_messages` column (body / author_type), on `role` for
      // another table (workspace_members / tickets), or via a non-SELECT statement (real
      // code-bug shape) still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingTicketMessagesRoleAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc `select ... metadata ... from
      // public.error_events` lookup by an external tool / stale exploratory query. The
      // `error_events` table exists but no ShopCX code path / migration / view / function
      // / trigger references an `error_events.metadata` column, so the column-missing
      // ERROR is repair work for a query we don't own
      // ([[../specs/error-feed-drop-error-events-metadata-adhoc-lookup-noise]], Control
      // Tower signature `supabase-logs:932dc308d8acafab`). Narrowly gated to require BOTH
      // the exact column-missing message AND the SELECT-lookup shape — a column-missing
      // error for any other column on error_events, or for `metadata` on any other table,
      // or on error_events via a non-SELECT statement (real code-bug shape) still surfaces
      // / pages on first sighting.
      if (isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc `select ... <column> ... from
      // public.error_events` lookup by an external tool / stale exploratory query. The
      // `error_events` table exists and its live column set is stable and known; a raw
      // SELECT that names a column we don't own only comes from an external caller, so
      // the column-missing ERROR is repair work for a query we don't own
      // ([[../specs/error-feed-drop-error-events-missing-column-adhoc-lookup-generic]] —
      // one generic classifier subsumes the per-column drops for `metadata` and
      // `first_seen_at`). Narrowly gated to require BOTH a column-missing message pinned to
      // `error_events.<any-unquoted-identifier>` AND the SELECT-lookup shape — a column-
      // missing error on any OTHER table, or on `error_events` via a non-SELECT statement
      // (real code-bug shape) still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: Postgres reporting the built-in aggregate
      // `array_agg` classification when a catalog/introspection query resolves it as a
      // regular function ([[../specs/error-feed-drop-supabase-array-agg-aggregate-introspection-n]],
      // Control Tower signature `supabase-logs:0562e7c36626723c`). Foreign-owned surface,
      // no lever from us; the built-in behaves correctly. Narrowly gated to the EXACT
      // trimmed phrase so a Postgres FATAL/PANIC, a constraint violation, or any other
      // non-timeout ERROR still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresAggregateIntrospectionNoise(message)) return null;
      // Drop foreign-app noise at capture: Postgres reporting `column reference "oid" is
      // ambiguous` on a catalog-introspection query joining two `pg_catalog` tables without
      // qualifying the `oid` reference ([[../specs/error-feed-drop-supabase-postgres-ambiguous-oid-introspectio]],
      // Control Tower signature `supabase-logs:6961407f61ea9a08`). None of our own SQL emits
      // this message — every ShopCX `oid` reference is qualified — so the row is from an
      // external / manual catalog probe we hold no lever on. Narrowly gated to the exact
      // trimmed phrase (`ERROR: ` prefix stripped, matching the sibling missing-relation
      // drop) so a FATAL/PANIC, a different ambiguous-column ERROR, or any other Postgres
      // ERROR still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresAmbiguousOidIntrospectionNoise(message)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.orders.name`. The `orders` table exists but has no `name` column
      // (grep confirms every ShopCX caller uses `first_name` / `last_name` / the internal
      // UUID `id`); the column-missing ERROR only reaches this feed when a foreign app /
      // deprecated integration / stale SQL Editor session queries `/rest/v1/orders?select=
      // ...name...`. There is no lever from ShopCX to make that query resolve — paging
      // Platform on it (Control Tower signature `supabase-logs:b7ce7a75d6250b29`,
      // [[../specs/error-feed-drop-orders-name-direct-rest-lookup-noise]]) is repair work
      // for a query we don't own. Narrowly gated to require BOTH the exact column-missing
      // message AND the bare-SELECT-on-orders shape — a column-missing error on any other
      // table, a different column on `orders`, or on `orders` via a non-SELECT statement
      // (real code-bug shape) still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresOrdersNameLookupNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.spec_phases.workspace_id` (or the `spec_slug` twin). The
      // `spec_phases` table exists as a real product table but by design carries no
      // `workspace_id` and no `spec_slug` column — both live on the parent `public.specs`
      // row (`workspace_id` / `slug`), and every ShopCX reader either joins through
      // `specs` or goes through the server-side RPCs. The column-missing ERROR only
      // reaches this feed when a foreign app / stale SQL Editor session / deprecated
      // integration queries `/rest/v1/spec_phases?select=...workspace_id...`. There is
      // no lever from ShopCX to make that query resolve — paging Platform on it
      // (Control Tower signature `supabase-logs:4371de33cf8e1d68`,
      // [[../specs/error-feed-drop-spec-phases-workspace-slug-adhoc-lookup-nois]]) is
      // repair work for a query we don't own. Narrowly gated to require BOTH the exact
      // column-missing message on one of the two off-schema columns AND the bare-SELECT-
      // on-spec_phases shape — a column-missing error on any other table, a different
      // column on `spec_phases` (a real schema regression), or on `spec_phases` via a
      // non-SELECT statement (real code-bug shape) still surfaces / pages on first
      // sighting.
      if (isForeignSupabasePostgresMissingSpecPhasesWorkspaceSlugLookupNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.smart_patterns.content`. The `smart_patterns` table exists but
      // has no `content` column (grep confirms no ShopCX caller queries `.content`; its
      // text lives in `phrases` / `embedding_text` / `description` / `name`); the
      // column-missing ERROR only reaches this feed when a foreign app / stale SQL
      // Editor session queries `/rest/v1/smart_patterns?select=...content...`. There is
      // no lever from ShopCX to make that query resolve — paging Platform on it (Control
      // Tower signature `supabase-logs:37878d0dd98ab4e3`,
      // [[../specs/error-feed-drop-smart-patterns-content-adhoc-search-noise]]) is repair
      // work for a query we don't own. Narrowly gated to require BOTH the exact column-
      // missing message AND the bare-SELECT-on-smart_patterns shape — a column-missing
      // error on any other table, a different column on `smart_patterns`, or on
      // `smart_patterns` via a non-SELECT statement (real code-bug shape) still surfaces
      // / pages on first sighting.
      // grep-anchor (spec check pattern is regex; unescaped parens are groups):
      // isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoisemessage, query
      if (isForeignSupabasePostgresMissingSmartPatternsContentAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.spec_status_history.created_at`. The `spec_status_history` audit
      // table exists but its timestamp column is `at`, not `created_at` — every ShopCX
      // caller uses `at`. The column-missing ERROR only reaches this feed when a foreign
      // app / deprecated integration / stale SQL Editor session queries
      // `/rest/v1/spec_status_history?select=...created_at...`. There is no lever from
      // ShopCX to make that query resolve — paging Platform on it (Control Tower
      // signature `supabase-logs:8c74545e2bb338bf`,
      // [[../specs/error-feed-drop-spec-status-history-created-at-adhoc-lookup-]]) is
      // repair work for a query we don't own. Narrowly gated to require BOTH the exact
      // column-missing message AND the bare-SELECT-on-spec_status_history shape — a
      // column-missing error on any other table, a different column on
      // `spec_status_history`, or on it via a non-SELECT statement (real code-bug shape)
      // still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingSpecStatusHistoryCreatedAtAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / hand-typed SQL Editor lookup
      // against `public.approval_decisions` that references the non-existent
      // `agent_jobs.branch_name` column and dangles at the end, which Postgres reports as
      // `syntax error at end of input`. Narrowly gated to require the exact message, the
      // bare SELECT-on-approval_decisions shape, and the `agent_jobs.branch_name` marker.
      if (isForeignSupabasePostgresApprovalDecisionAdhocSyntaxNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.specs.<archived_at|folded_at|deferred_at>`. The `specs` card table
      // exists but records lifecycle state via `status text` (with a `folded` value) plus
      // a `deferred boolean` flag — none of these three timestamp columns exist and no
      // ShopCX caller reads them. The column-missing ERROR only reaches this feed when a
      // foreign app / deprecated integration / stale SQL Editor session queries
      // `/rest/v1/specs?select=...archived_at...` (or `folded_at`, or `deferred_at`).
      // There is no lever from ShopCX to make that query resolve — paging Platform on it
      // (Control Tower signature `supabase-logs:fbf1fe604803f481`,
      // [[../specs/error-feed-drop-specs-archive-timestamp-adhoc-lookup-noise]]) is
      // repair work for a query we don't own. Narrowly gated to require BOTH the exact
      // column-missing message (on one of the three obsolete names) AND the bare-SELECT-
      // on-specs shape — a column-missing error on any other table, a different column on
      // `specs`, or on it via a non-SELECT statement (real code-bug shape) still surfaces
      // / pages on first sighting.
      if (isForeignSupabasePostgresMissingSpecsArchiveTimestampAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.spec_phases.idx`. The `spec_phases` table exists but its
      // ordering column is `position`, not `idx` — every ShopCX caller orders phases by
      // `position` (see `spec_phases_spec_position` unique index + the
      // `get_spec_with_phases` / `list_specs_with_phases` RPCs). The column-missing
      // ERROR only reaches this feed when a foreign app / stale SQL Editor session
      // queries `/rest/v1/spec_phases?select=...idx...` or `?order=idx.asc`. There is no
      // lever from ShopCX to make that query resolve — paging Platform on it (Control
      // Tower signature `supabase-logs:1dcc664aba4a5239`,
      // [[../specs/error-feed-drop-spec-phases-idx-adhoc-lookup-noise]]) is repair work
      // for a query we don't own. Narrowly gated to require BOTH the exact column-
      // missing message AND the bare-SELECT-on-spec_phases shape — a column-missing
      // error on any other table, a different column on `spec_phases`, or on
      // `spec_phases` via a non-SELECT statement (real code-bug shape) still surfaces /
      // pages on first sighting.
      if (isForeignSupabasePostgresMissingSpecPhasesIdxAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: a stale approval-history SELECT that
      // LEFT-JOINs `public.approval_decisions` to `public.agent_jobs` and asks for legacy
      // `aj.payload` / `aj.branch_name` columns that do not exist on the current schema.
      // Both tables exist, but every ShopCX approval-history reader queries real columns —
      // the row only reaches this feed when a foreign app / stale SQL Editor session runs
      // the deprecated join shape. There is no lever from ShopCX to make that query
      // resolve — the fix is to update the caller, not add fake columns to agent_jobs
      // (Control Tower signature `supabase-logs:0197dad10ff4a69c`,
      // [[../specs/error-feed-drop-agent-jobs-legacy-approval-join-noise]]). Narrowly
      // gated to require BOTH the exact column-missing message on
      // `agent_jobs.payload` / `agent_jobs.branch_name` AND a SELECT that joins
      // `approval_decisions` with `agent_jobs` — a bare SELECT on `agent_jobs` alone (real
      // product code), a different column on `agent_jobs`, a column-missing on any other
      // table, or a non-SELECT statement (INSERT/UPDATE/DELETE — real write bug) still
      // surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingAgentJobsLegacyApprovalJoinNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.specs.is_active`. The `specs` table exists but carries no
      // `is_active` boolean — spec activity is derived from the `spec_phases` rollup +
      // `status` overrides, and the sibling `journey_definitions.is_active` is the
      // column an external client typically confuses this with. The column-missing
      // ERROR only reaches this feed when a foreign app / stale SQL Editor session /
      // deprecated integration queries `/rest/v1/specs?select=...is_active...` or
      // `?is_active=eq.true`. There is no lever from ShopCX to make that query resolve
      // — paging Platform on it ([[../specs/error-feed-drop-specs-is-active-direct-rest-noise]])
      // is repair work for a query we don't own. Narrowly gated to require BOTH the
      // exact column-missing message AND the bare-SELECT-on-specs shape — a
      // column-missing error on any other table, a different column on `specs`, or on
      // `specs` via a non-SELECT statement (real code-bug shape) still surfaces /
      // pages on first sighting.
      if (isForeignSupabasePostgresMissingSpecsIsActiveAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.specs.archived`. The `specs` table exists but has no `archived`
      // column — the terminal lifecycle state is `folded` on `specs.status` (M4 fold),
      // not a boolean archive flag. Every ShopCX caller reads / writes via the
      // `specs-table` SDK; no code path selects `.archived` from `public.specs`. The
      // column-missing ERROR only reaches this feed when a foreign app / stale SQL
      // Editor session queries `/rest/v1/specs?select=...archived...` or
      // `?archived=eq.false`. There is no lever from ShopCX to make that query resolve —
      // paging Platform on it
      // ([[../specs/error-feed-scope-foreign-specs-archived-column-noise]]) is repair
      // work for a query we don't own. Narrowly gated to require BOTH the exact column-
      // missing message AND the bare-SELECT-on-specs shape — a column-missing error on
      // any other table, a different column on `specs`, or on `specs` via a non-SELECT
      // statement (real code-bug shape) still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingSpecsArchivedAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.policies.kind`. The `policies` table exists but has no `kind`
      // column by design — it is keyed by `slug`, and every ShopCX caller goes through
      // the policies SDK (`src/lib/policies.ts`) which reads real columns. The column-
      // missing ERROR only reaches this feed when a foreign app / stale SQL Editor
      // session queries `/rest/v1/policies?select=...kind...`. There is no lever from
      // ShopCX to make that query resolve — paging Platform on it
      // ([[../specs/error-feed-drop-policies-kind-direct-rest-lookup-noise]]) is repair
      // work for a query we don't own. Narrowly gated to require BOTH the exact column-
      // missing message AND the bare-SELECT-on-policies shape — a column-missing error
      // on any other table, a different column on `policies`, or on `policies` via a
      // non-SELECT statement (real code-bug shape) still surfaces / pages on first
      // sighting.
      if (isForeignSupabasePostgresPoliciesKindLookupNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.spec_phases.shipped_at`. The `spec_phases` table exists but has
      // NO `shipped_at` timestamp column — a phase's shipped state is recorded via
      // `status = 'shipped'` plus the `build_sha` + `build_pr_url` provenance pair
      // (phase-pr-provenance). The column-missing ERROR only reaches this feed when a
      // foreign app / stale SQL Editor session / deprecated integration queries
      // `/rest/v1/spec_phases?select=...shipped_at...` or `?order=shipped_at.desc`.
      // There is no lever from ShopCX to make that query resolve — paging Platform on
      // it (Control Tower signature `supabase-logs:85c223f859afc86a`,
      // [[../specs/error-feed-drop-spec-phases-shipped-at-direct-rest-noise]]) is
      // repair work for a query we don't own. Narrowly gated to require BOTH the exact
      // column-missing message AND a SELECT-on-spec_phases shape (bare OR PostgREST CTE
      // wrapper) — a column-missing error on any other table, a different column on
      // `spec_phases`, a JOIN through `specs`, or on `spec_phases` via a non-SELECT
      // statement (real code-bug shape) still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingSpecPhasesShippedAtAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.specs.body_md`. The `specs` table exists but has NO `body_md`
      // column — phase body text lives on `spec_phases.body`, per phase. The column-
      // missing ERROR only reaches this feed when a foreign app / stale SQL Editor
      // session / deprecated integration queries
      // `/rest/v1/specs?select=...body_md...` or `?body_md=ilike.*x*`. There is no
      // lever from ShopCX to make that query resolve — paging Platform on it (Control
      // Tower signature `supabase-logs:2fbb132337ba7975`,
      // [[../specs/error-feed-drop-specs-body-md-direct-rest-noise]]) is repair work
      // for a query we don't own. Narrowly gated to require BOTH the exact column-
      // missing message AND a SELECT-on-specs shape (bare OR PostgREST CTE wrapper) —
      // a column-missing error on any other table, a different column on `specs`, a
      // JOIN through `spec_phases`, or on `specs` via a non-SELECT statement (real
      // code-bug shape) still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingSpecsBodyMdAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.specs.current_phase`. The `specs` table exists but has NO
      // `current_phase` column — the current phase is DERIVED from the `spec_phases`
      // rollup (the first nonterminal phase row per spec). The column-missing ERROR only
      // reaches this feed when a foreign app / stale SQL Editor session / deprecated
      // integration queries
      // `/rest/v1/specs?select=slug,title,status,current_phase&slug=eq.<X>` (observed
      // both as a bare SELECT and as the PostgREST-wrapped
      // `WITH pgrst_source AS ( SELECT ... FROM "public"."specs" ... )` CTE form). There
      // is no lever from ShopCX to make that query resolve — paging Platform on it
      // (Control Tower signature `supabase-logs:ead8d1f074f2467e`,
      // [[../specs/error-feed-drop-specs-current-phase-direct-rest-noise]]) is repair
      // work for a query we don't own. Narrowly gated to require BOTH the exact column-
      // missing message AND a SELECT-on-specs shape (bare OR PostgREST CTE wrapper) —
      // a column-missing error on any other table, a different column on `specs`, a
      // JOIN through `spec_phases`, or on `specs` via a non-SELECT statement (real
      // code-bug shape) still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingSpecsCurrentPhaseAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.agent_jobs` that asks for BOTH `slug` and the real `spec_slug`
      // column. The `agent_jobs` table exists but has NEVER had a `slug` column — the
      // durable subject field is `spec_slug`, and every ShopCX caller goes through the
      // agent_jobs SDK / RPCs. The column-missing ERROR only reaches this feed when a
      // foreign app / stale SQL Editor session queries
      // `/rest/v1/agent_jobs?select=slug,spec_slug,...` (a client confusing `slug` with
      // the real `spec_slug`). There is no lever from ShopCX to make that query resolve
      // — paging Platform on it (Control Tower signature
      // `supabase-logs:67f11eea914ea082`,
      // [[../specs/error-feed-drop-agent-jobs-slug-direct-rest-lookup-noise]]) is repair
      // work for a query we don't own. Narrowly gated to require ALL THREE of the exact
      // column-missing message, a SELECT-on-agent_jobs shape (bare OR PostgREST CTE
      // wrapper), AND a `spec_slug` mention in the same query — a column-missing on any
      // other table, a different column on `agent_jobs`, a JOIN through
      // `approval_decisions`, a bare `select slug from agent_jobs` without `spec_slug`,
      // or on `agent_jobs` via a non-SELECT statement (real code-bug shape) still
      // surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingAgentJobsSlugLookupNoise(message, query)) return null;
      // Drop foreign-app noise at capture: the sibling `agent_jobs.title` confusion. The
      // `agent_jobs` table has NEVER had a `title` column — the human-readable label
      // every ShopCX surface renders comes from the joined `specs.title` through the
      // agent_jobs SDK, never a column on the row itself. The column-missing ERROR only
      // reaches this feed when a foreign app / stale SQL Editor session queries
      // `/rest/v1/agent_jobs?select=title,spec_slug,...` (a client confusing
      // `agent_jobs.title` with the joined `specs.title`). There is no lever from
      // ShopCX to make that query resolve — paging Platform on it (Control Tower
      // signature `supabase-logs:2944e13680f85d53`,
      // [[../specs/error-feed-drop-agent-jobs-title-direct-rest-lookup-noise]]) is
      // repair work for a query we don't own. Narrowly gated to require ALL THREE of
      // the exact column-missing message, a SELECT-on-agent_jobs shape (bare OR
      // PostgREST CTE wrapper), AND a `spec_slug` mention in the same query — a
      // column-missing on any other table, a different column on `agent_jobs`, a JOIN
      // through `approval_decisions`, a bare `select title from agent_jobs` without
      // `spec_slug`, or on `agent_jobs` via a non-SELECT statement (real code-bug
      // shape) still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingAgentJobsTitleLookupNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.workspaces.slug`. The `workspaces` table exists but has NO
      // `slug` column — the workspace slug shape lives on `workspaces.help_slug` (the
      // public mini-site slug). The column-missing ERROR only reaches this feed when a
      // foreign app / stale SQL Editor session / deprecated integration queries
      // `/rest/v1/workspaces?select=id,name,slug`. There is no lever from ShopCX to
      // make that query resolve — paging Platform on it (Control Tower signature
      // `supabase-logs:b64f0e4a2576752f`,
      // [[../specs/error-feed-drop-workspaces-slug-direct-rest-noise]]) is repair work
      // for a query we don't own. Narrowly gated to require BOTH the exact column-
      // missing message AND a SELECT-on-workspaces shape (bare OR PostgREST CTE
      // wrapper) — a column-missing error on any other table, a different column on
      // `workspaces`, or on `workspaces` via a non-SELECT statement (real code-bug
      // shape) still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingWorkspacesSlugAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.meta_ad_accounts.name`. The `meta_ad_accounts` table exists but
      // has NO bare `name` column — the human-readable account label lives on
      // `meta_account_name`, and every ShopCX reader goes through the meta-ads SDK /
      // joined queries which never select a bare `name` off the row. The column-missing
      // ERROR only reaches this feed when a foreign app / stale Supabase Studio session /
      // deprecated integration queries `/rest/v1/meta_ad_accounts?select=...name...`.
      // There is no lever from ShopCX to make that query resolve — paging Platform on it
      // (Control Tower signature `supabase-logs:692476583471d273`,
      // [[../specs/error-feed-drop-meta-ad-accounts-name-direct-rest-lookup-noi]]) is
      // repair work for a query we don't own. Narrowly gated to require BOTH the exact
      // column-missing message AND a SELECT-on-meta_ad_accounts shape (bare OR PostgREST
      // CTE wrapper) — a column-missing error on any other table, a different column on
      // `meta_ad_accounts`, or on `meta_ad_accounts` via a non-SELECT statement (real
      // code-bug shape) still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingMetaAdAccountsNameLookupNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.products` naming one of three columns that have NEVER lived on
      // the products table — `ingredients`, `supplement_facts`, `benefits`. Product
      // intelligence lives on sibling tables (`product_ingredients`,
      // `product_benefit_selections`, etc.) and every ShopCX reader goes through the
      // products SDK / joined queries. The column-missing ERROR only reaches this feed
      // when a foreign app / stale SQL Editor session / deprecated integration queries
      // `/rest/v1/products?select=...ingredients...`. There is no lever from ShopCX to
      // make that query resolve — paging Platform on it (Control Tower signature
      // `supabase-logs:a7533814f2487659`,
      // [[../specs/error-feed-drop-products-intelligence-columns-adhoc-lookup-n]]) is
      // repair work for a query we don't own. Narrowly gated to require BOTH the exact
      // column-missing message (on one of the three off-schema intelligence columns)
      // AND a SELECT-on-products shape (bare OR PostgREST CTE wrapper) — a
      // column-missing error on any other table, a different column on `products`, or
      // on `products` via a non-SELECT statement (real code-bug shape) still surfaces
      // / pages on first sighting.
      if (isForeignSupabasePostgresMissingProductsIntelligenceColumnsAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.products.pricing_rule_id`. The `products` table has NEVER
      // carried a `pricing_rule_id` column — the product-to-pricing-rule assignment
      // lives on the `product_pricing_rule` join table, and every ShopCX reader goes
      // through that join. The column-missing ERROR only reaches this feed when a
      // foreign app / stale SQL Editor session / deprecated integration queries
      // `/rest/v1/products?select=id,title,pricing_rule_id&id=eq.<x>`. There is no
      // lever from ShopCX to make that query resolve — paging Platform on it (Control
      // Tower signature `supabase-logs:78422c77f222cb38`,
      // [[../specs/error-feed-drop-products-pricing-rule-id-direct-rest-noise]]) is
      // repair work for a query we don't own. Narrowly gated to require BOTH the exact
      // column-missing message AND a SELECT-on-products shape (bare OR PostgREST CTE
      // wrapper) — a column-missing error on any other table, a different column on
      // `products`, or on `products` via a non-SELECT statement (real code-bug shape)
      // still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingProductsPricingRuleIdLookupNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.playbooks.title`. The `playbooks` table exists but has NO
      // `title` column — the human-facing label is `name`, and every ShopCX reader /
      // writer (`src/lib/ticket-analyzer.ts`, `src/lib/action-executor.ts`,
      // `src/lib/workflow-executor.ts`, `src/lib/sol-direction-apply.ts`) selects
      // `name`. The column-missing ERROR only reaches this feed when a foreign app /
      // stale SQL Editor session / deprecated integration queries
      // `/rest/v1/playbooks?select=slug,title,is_active&slug=in.(...)`. There is no
      // lever from ShopCX to make that query resolve — paging Platform on it (Control
      // Tower signature `supabase-logs:89f4636e0ac3cc84`,
      // [[../specs/error-feed-drop-playbooks-title-direct-rest-noise]]) is repair work
      // for a query we don't own. Narrowly gated to require BOTH the exact column-
      // missing message AND a SELECT-on-playbooks shape (bare OR PostgREST CTE
      // wrapper) — a column-missing error on any other table, a different column on
      // `playbooks`, or on `playbooks` via a non-SELECT statement (real code-bug
      // shape) still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingPlaybooksTitleAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.product_ingredients.sort_order`. The `product_ingredients`
      // table exists but has NO `sort_order` column — the actual ordering column is
      // `display_order`. The column-missing ERROR only reaches this feed when a foreign
      // app / stale SQL Editor session / deprecated integration queries
      // `/rest/v1/product_ingredients?select=...&order=sort_order.asc`. There is no
      // lever from ShopCX to make that query resolve — paging Platform on it (Control
      // Tower signature `supabase-logs:b9012d5b8913efc6`,
      // [[../specs/error-feed-drop-product-ingredients-sort-order-direct-rest-noise]])
      // is repair work for a query we don't own. Narrowly gated to require BOTH the
      // exact column-missing message AND a SELECT-on-product_ingredients shape (bare OR
      // PostgREST CTE wrapper) — a column-missing error on any other table, a different
      // column on `product_ingredients` (e.g. `display_order` regression), or on
      // `product_ingredients` via a non-SELECT statement (real code-bug shape) still
      // surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingProductIngredientsSortOrderAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.daily_meta_ad_spend.date`. The `daily_meta_ad_spend` table
      // exists but has NO `date` column — the actual per-day column is `snapshot_date`
      // (see `supabase/migrations/20260422270000_meta_ads_integration.sql` — the index
      // is `idx_meta_spend_date ON daily_meta_ad_spend(workspace_id, snapshot_date DESC)`).
      // The column-missing ERROR only reaches this feed when a foreign app / stale SQL
      // Editor session / deprecated integration queries
      // `/rest/v1/daily_meta_ad_spend?select=...&date=eq.YYYY-MM-DD` — a natural mistake
      // because many rollup tables use a plain `date` column but ours uses
      // `snapshot_date`. There is no lever from ShopCX to make that query resolve —
      // paging Platform on it
      // ([[../specs/error-feed-classify-foreign-daily-meta-ad-spend-date-adhoc-noise]])
      // is repair work for a query we don't own. Narrowly gated to require BOTH the
      // exact column-missing message AND a SELECT-on-daily_meta_ad_spend shape (bare OR
      // PostgREST CTE wrapper) — a column-missing error on any other table, a different
      // column on `daily_meta_ad_spend` (e.g. `snapshot_date` regression), or on
      // `daily_meta_ad_spend` via a non-SELECT statement (real code-bug shape) still
      // surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingDailyMetaAdSpendDateAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.qb_amazon_sales_snapshots.gross_revenue_cents`. The
      // `qb_amazon_sales_snapshots` table exists (see
      // `supabase/migrations/20261213120001_qb_close_source_tables.sql` — the qb-close
      // Amazon sales-receipt / COGS source, [[../tables/qb_amazon_sales_snapshots]]) but
      // has NO `gross_revenue_cents` column — the real per-ASIN/per-day money columns
      // are `revenue` (numeric(14,2)) plus `recurring_revenue` / `sns_checkout_revenue` /
      // `one_time_revenue`, and every ShopCX caller (`src/lib/qb-close/sync-amazon-sales.ts`,
      // `src/lib/qb-close/month-end.ts`) selects on `units_shipped` / `revenue`. The
      // `gross_revenue_cents` column lives on the unrelated
      // `daily_amazon_product_snapshots` / `daily_amazon_order_snapshots` family. The
      // column-missing ERROR only reaches this feed when a foreign app / stale SQL Editor
      // session / deprecated integration / hand-typed URL queries
      // `/rest/v1/qb_amazon_sales_snapshots?select=gross_revenue_cents,units,updated_at&...` —
      // a natural mistake because the sibling `daily_amazon_*_snapshots` tables DO expose
      // `gross_revenue_cents`. There is no lever from ShopCX to make that query resolve —
      // paging Platform on it
      // ([[../specs/error-feed-drop-qb-amazon-sales-gross-revenue-cents-adhoc-lookup]]) is
      // repair work for a query we don't own. Narrowly gated to require BOTH the exact
      // column-missing message AND a SELECT-on-qb_amazon_sales_snapshots shape (bare OR
      // PostgREST CTE wrapper) — a column-missing error on any other table, a different
      // column on `qb_amazon_sales_snapshots` (e.g. `revenue` / `units_shipped`
      // regression), or on `qb_amazon_sales_snapshots` via a non-SELECT statement (real
      // code-bug shape) still surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingQbAmazonSalesGrossRevenueCentsAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.loyalty_members.lifetime_points`. The `loyalty_members` table
      // exists but has NO `lifetime_points` column — the live running-total column is
      // `total_earned` (with `points_balance` for the current spendable balance), see
      // [[../tables/loyalty_members]] and every ShopCX caller under
      // `src/app/api/loyalty/**` + `src/lib/action-executor.ts`. The column-missing
      // ERROR only reaches this feed when a foreign app / stale PostgREST client /
      // deprecated integration queries
      // `/rest/v1/loyalty_members?select=lifetime_points&...` — a natural mistake
      // because many loyalty schemas call the running total `lifetime_points` but ours
      // uses `total_earned`. There is no lever from ShopCX to make that query resolve —
      // paging Platform on it
      // ([[../specs/error-feed-drop-loyalty-members-lifetime-points-adhoc-noise]]) is
      // repair work for a query we don't own. Narrowly gated to require BOTH the exact
      // column-missing message AND a SELECT-on-loyalty_members shape (bare OR PostgREST
      // CTE wrapper) — a column-missing error on any other table, a different column on
      // `loyalty_members` (e.g. `total_earned` / `points_balance` regression), or on
      // `loyalty_members` via a non-SELECT statement (real code-bug shape) still
      // surfaces / pages on first sighting.
      if (isForeignSupabasePostgresMissingLoyaltyMembersLifetimePointsAdhocNoise(message, query)) return null;
      // Drop foreign-app noise at capture: an ad hoc / stale PostgREST direct-REST read
      // against `public.tickets.assigned_agent`. The `tickets` table exists but has NO
      // `assigned_agent` column — the actual assignee column is
      // `assigned_to_member_id` (a UUID FK to `workspace_members`). The column-missing
      // ERROR only reaches this feed when a foreign app / stale SQL Editor session /
      // deprecated integration queries
      // `/rest/v1/tickets?select=...&assigned_agent=eq.<name>` — a natural mistake
      // because many ticketing tables expose a plain `assigned_agent` string column but
      // ours uses a UUID FK. There is no lever from ShopCX to make that query resolve —
      // paging Platform on it is repair work for a query we don't own. Narrowly gated
      // to require BOTH the exact column-missing message AND a SELECT-on-tickets shape
      // (bare OR PostgREST CTE wrapper) — a column-missing error on any other table, a
      // different column on `tickets` (e.g. `assigned_to_member_id` regression), or on
      // `tickets` via a non-SELECT statement (real code-bug shape) still surfaces /
      // pages on first sighting.
      if (isForeignSupabasePostgresMissingTicketsAssignedAgentColumnAdhocNoise(message, query)) return null;
      // Drop expected-by-design noise at capture: Postgres reporting the 23505
      // unique-violation raised by our own `dashboard_notifications_dedupe_key_open_uniq`
      // partial index on an INSERT INTO `public.dashboard_notifications`. That index
      // (migration 20261211120000) is the DB-level one-open-card-per-`dedupe_key`
      // backstop for the escalation mint path in platform-director.ts's
      // `escalateDiagnosisToCeo` — a concurrent second insert for the same open
      // dedupe_key is INTENTIONALLY rejected at 23505 and the app catch bumps the
      // winning card ([[../specs/error-feed-drop-dashboard-notifications-dedupe-key-open-uniq]],
      // Control Tower signature `supabase-logs:bbd5f21ef9289c31`). Paging Platform on it
      // trains owners to ignore the feed. Narrowly gated to require BOTH the exact
      // unique-violation message on THIS constraint AND the INSERT-INTO-dashboard_notifications
      // shape — a 23505 on any other constraint (real schema regression), or a 23505 on
      // this constraint via a non-INSERT shape (COPY replay, pg_dump load, an UPDATE...
      // on conflict) still surfaces / pages on first sighting.
      if (isExpectedDashboardNotificationsDedupeKeyOpenUniqViolation(message, query)) return null;
      // Drop expected-by-design noise at capture: Postgres reporting the 23505
      // unique-violation raised by our own `idx_billing_forecasts_pending` partial index on
      // an INSERT INTO `public.billing_forecasts`. That index is the DB-level
      // one-pending-forecast-per-contract backstop for the `createForecast` path in
      // [[../billing-forecast]] — a concurrent second insert for the same
      // (workspace, contract) pending pair is INTENTIONALLY rejected at 23505 and the app
      // catch converges on the winning row. Paging Platform on it trains owners to ignore
      // the feed. Narrowly gated to require BOTH the exact unique-violation message on THIS
      // constraint AND the INSERT-INTO-billing_forecasts shape — a 23505 on any other
      // constraint (real schema regression), or a 23505 on this constraint via a non-INSERT
      // shape (COPY replay, pg_dump load, an UPDATE... on conflict) still surfaces / pages
      // on first sighting.
      if (isExpectedBillingForecastsPendingUniqViolation(message, query)) return null;
      return {
        keyParts: ["postgres", severity, message],
        title: `postgres ${severity}: ${message}`,
        detail: message,
        transient: isTransientSupabaseLogNoise("postgres", { severity, message }),
      };
    },
  },
  {
    key: "auth",
    sql:
      "select timestamp, log_attributes['level'] as severity, log_attributes['msg'] as msg, event_message " +
      "from logs " +
      "where source = 'auth_logs' " +
      "and log_attributes['level'] in ('error','fatal') " +
      `order by timestamp desc limit ${ROW_LIMIT}`,
    mapRow: (row) => {
      // Drop foreign-app noise at capture: Supabase's own GoTrue `/user` 504 on the
      // auth_logs surface ([[../specs/error-feed-drop-supabase-gotrue-504-auth-log-noise]]).
      // Same choice as the edge_logs twin below — foreign-owned surface, no lever from us;
      // the transient class still recurred inside the recur window and escalated. Narrow to
      // (msg 504-prefix + `"path":"/user"` + `"method":"GET"`) so a real GoTrue outage on
      // other paths (/token, /admin), a non-504 error, or a real auth-signature bug on
      // /user is still captured normally.
      if (isForeignGoTrueAuthLogNoise(str(row.msg), str(row.event_message))) return null;
      const severity = str(row.severity) || "error";
      const message = str(row.msg) || str(row.event_message) || "auth error";
      // Drop foreign-app noise at capture: Supabase's own GoTrue `/user` handler timing
      // out on its Postgres backend ([[../specs/error-feed-drop-supabase-gotrue-auth-log-context-deadline-us]]).
      // Foreign-owned surface, no lever from our side; the transient-recur window still
      // escalated the chronic saturation (Control Tower `supabase-logs:9f39fe11dd105b2a`,
      // 39 occurrences across 6 days). Narrowly gated to the exact
      // `Unhandled server error: context deadline exceeded` phrase so any actionable
      // GoTrue class (invalid JWT, rate limit, dial failure on other paths) still
      // surfaces. Mirrors the `api` mapRow's `isForeignGoTrueEdgeNoise` drop above.
      if (isForeignGoTrueAuthLogNoise(message)) return null;
      return {
        keyParts: ["auth", severity, message],
        title: `auth ${severity}: ${message}`,
        detail: message,
        // Auth errors mostly page on first sighting; the helper narrowly scopes GoTrue's
        // `context canceled` / `context deadline exceeded` (browser-abort noise) into the
        // transient class so ordinary page navigations don't mint incidents.
        // Pass event_message through so the auth branch can also inspect the inner `error`
        // field for browser-abort markers on the /authorize (PKCE flow-state) shape whose
        // top-level msg is only `500: Error creating flow state` — the real cause lives in
        // event_message JSON ([[../specs/error-feed-scope-supabase-authorize-flow-state-context-cance]],
        // Control Tower signature `supabase-logs:a30ffe4489dd6ffb`).
        transient: isTransientSupabaseLogNoise("auth", { message, eventMessage: str(row.event_message) }),
      };
    },
  },
  {
    key: "api",
    sql:
      "select timestamp, log_attributes['response.status_code'] as status_code, log_attributes['request.method'] as method, log_attributes['request.path'] as path, event_message " +
      "from logs " +
      "where source = 'edge_logs' " +
      // log_attributes is Map(String,String) in ClickHouse — coerce for numeric compare;
      // toInt32OrNull yields NULL on a missing/non-numeric value (NULL >= 500 is falsy).
      "and toInt32OrNull(log_attributes['response.status_code']) >= 500 " +
      `order by timestamp desc limit ${ROW_LIMIT}`,
    mapRow: (row) => {
      const status = str(row.status_code) || "5xx";
      const method = str(row.method) || "GET";
      const path = str(row.path) || "/";
      // Drop foreign-app noise at capture: Supabase's own GoTrue `/auth/v1/user` 504
      // ([[../specs/error-feed-drop-supabase-gotrue-504-edge-noise]]). Foreign-owned surface,
      // no lever from our side; the transient-recur window still escalated the chronic
      // saturation. Narrow to that exact shape so a real GoTrue outage on other paths /
      // a non-504 5xx still surfaces.
      if (isForeignGoTrueEdgeNoise(path, row.status_code)) return null;
      return {
        keyParts: ["api", status, method, path],
        title: `api ${status} ${method} ${path}`,
        detail: `${method} ${path} → ${status}${row.event_message ? ` · ${str(row.event_message)}` : ""}`,
        transient: isTransientSupabaseLogNoise("api", { statusCode: row.status_code }),
      };
    },
  },
];

/** GET one ClickHouse SQL query over the window. Returns the result rows (empty on any failure). */
async function fetchLogRows(
  config: SupabaseLogConfig,
  sql: string,
  startIso: string,
  endIso: string,
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams({
    sql,
    iso_timestamp_start: startIso,
    iso_timestamp_end: endIso,
  });
  const url = `${MANAGEMENT_API_BASE}/projects/${config.projectRef}/analytics/endpoints/logs?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`logs ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { result?: Record<string, unknown>[] };
  return Array.isArray(json.result) ? json.result : [];
}

export interface PollResult {
  /** "no-token" (not configured), "ok", or "error". */
  status: "no-token" | "ok" | "error";
  /** distinct grouped incidents recorded this poll. */
  incidents: number;
  /** raw error rows seen across all sources this poll. */
  rows: number;
  /** per-source error notes (a query that failed), if any. */
  errors: string[];
}

/**
 * Poll the Supabase Management Logs API for DB-level errors and record them into the
 * Control Tower error feed (source='supabase-logs'). Advances the poll cursor on success.
 * Best-effort: per-source query failures are collected, not thrown.
 */
export async function pollSupabaseLogs(adminClient?: Admin): Promise<PollResult> {
  const admin = adminClient ?? createAdminClient();
  const config = await getSupabaseLogConfig(admin);
  if (!config) return { status: "no-token", incidents: 0, rows: 0, errors: [] };

  const now = Date.now();
  const sinceMs = config.lastPolledAt ? new Date(config.lastPolledAt).getTime() : now - DEFAULT_LOOKBACK_MS;
  // Cap the window to the API's 24h max (and never go backwards / negative).
  const startMs = Math.max(sinceMs, now - MAX_WINDOW_MS);
  const startIso = new Date(Math.min(startMs, now)).toISOString();
  const endIso = new Date(now).toISOString();

  const errors: string[] = [];
  let totalRows = 0;
  // Group every error row across all sources by (source, signature) BEFORE recording,
  // so a burst of the same error is one recordError call with an occurrences count.
  const groups = new Map<string, { keyParts: string[]; title: string; detail: string; sample: Record<string, unknown>; count: number; transient: boolean }>();

  for (const q of LOG_QUERIES) {
    let rows: Record<string, unknown>[];
    try {
      rows = await fetchLogRows(config, q.sql, startIso, endIso);
    } catch (e) {
      errors.push(`${q.key}: ${errText(e)}`);
      continue;
    }
    totalRows += rows.length;
    for (const row of rows) {
      const mapped = q.mapRow(row);
      if (!mapped) continue;
      const sig = signatureFor("supabase-logs", mapped.keyParts);
      const existing = groups.get(sig);
      if (existing) {
        existing.count += 1;
      } else {
        groups.set(sig, { keyParts: mapped.keyParts, title: mapped.title, detail: mapped.detail, sample: { source_kind: q.key, ...row }, count: 1, transient: mapped.transient });
      }
    }
  }

  let incidents = 0;
  for (const g of groups.values()) {
    await recordError(
      {
        source: "supabase-logs",
        keyParts: g.keyParts,
        title: g.title,
        detail: g.detail,
        sample: g.sample,
        occurrences: g.count,
        // A momentary edge 5xx / Postgres statement-timeout blip auto-resolves on first
        // sighting + escalates only on recurrence; a chronic 5xx still surfaces.
        transient: g.transient,
      },
      admin,
    );
    incidents += 1;
  }

  // Advance the cursor only if at least one source query succeeded — a total failure
  // (e.g. an invalid/expired token) keeps the window so a later poll re-covers it.
  const allFailed = errors.length === LOG_QUERIES.length;
  if (!allFailed) {
    await admin
      .from("error_feed_supabase_config")
      .update({ last_polled_at: endIso, updated_at: endIso })
      .eq("id", CONFIG_ID);
    // Liveness: a successful poll (even one that found zero errors) proves the feed is
    // wired + live, so the panel can show green "connected" not a misleading "0 errors".
    await recordFeedDelivery("supabase-logs", admin);
  }

  return { status: allFailed ? "error" : "ok", incidents, rows: totalRows, errors };
}
