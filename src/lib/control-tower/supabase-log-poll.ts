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
  isForeignSupabasePostgresMissingErrorEventsMetadataAdhocNoise,
  isForeignSupabasePostgresMissingErrorEventsColumnAdhocNoise,
  isForeignSupabasePostgresAggregateIntrospectionNoise,
  isForeignSupabasePostgresAmbiguousOidIntrospectionNoise,
  isForeignSupabasePostgresOrdersNameLookupNoise,
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
