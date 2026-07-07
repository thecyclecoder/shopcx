/**
 * Control Tower — Supabase Management Logs poller (error-feed-monitoring Phase 2).
 *
 * The fourth "hidden surface": DB-LEVEL Supabase errors our own app code NEVER sees —
 * Postgres ERROR/FATAL/PANIC (constraint violations behind RLS, slow-query/timeouts),
 * auth-service errors, and API 5xxs at the edge. The app-layer reportDbError (Phase 1)
 * only catches errors our code holds a `{ error }` for; this pulls the rest straight
 * from Supabase's own logs via the **Management Logs API** (`logs.all` SQL endpoint).
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
import { encrypt, decrypt } from "@/lib/crypto";
import {
  recordError,
  recordFeedDelivery,
  signatureFor,
  isTransientSupabaseLogNoise,
  isForeignGoTrueEdgeNoise,
  isForeignGoTrueAuthLogNoise,
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
// Each pulls error-severity rows from one Supabase log source via the logs.all SQL
// endpoint, following the documented `cross join unnest(metadata)` nesting pattern.
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
      "select t.timestamp as timestamp, metadata.parsed.error_severity as severity, t.event_message as event_message " +
      "from postgres_logs as t cross join unnest(t.metadata) as metadata " +
      "where metadata.parsed.error_severity in ('ERROR','FATAL','PANIC') " +
      `order by t.timestamp desc limit ${ROW_LIMIT}`,
    mapRow: (row) => {
      const severity = str(row.severity) || "ERROR";
      const message = str(row.event_message) || "postgres error";
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
      "select t.timestamp as timestamp, metadata.level as severity, metadata.msg as msg, t.event_message as event_message " +
      "from auth_logs as t cross join unnest(t.metadata) as metadata " +
      "where metadata.level in ('error','fatal') " +
      `order by t.timestamp desc limit ${ROW_LIMIT}`,
    mapRow: (row) => {
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
        transient: isTransientSupabaseLogNoise("auth", { message }),
      };
    },
  },
  {
    key: "api",
    sql:
      "select t.timestamp as timestamp, response.status_code as status_code, request.method as method, request.path as path, t.event_message as event_message " +
      "from edge_logs as t " +
      "cross join unnest(t.metadata) as metadata " +
      "cross join unnest(metadata.response) as response " +
      "cross join unnest(metadata.request) as request " +
      "where response.status_code >= 500 " +
      `order by t.timestamp desc limit ${ROW_LIMIT}`,
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

/** GET one logs.all SQL query over the window. Returns the result rows (empty on any failure). */
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
  const url = `${MANAGEMENT_API_BASE}/projects/${config.projectRef}/analytics/endpoints/logs.all?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`logs.all ${res.status}: ${body.slice(0, 200)}`);
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
      errors.push(`${q.key}: ${e instanceof Error ? e.message : String(e)}`);
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
