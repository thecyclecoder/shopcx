/**
 * claude-health — the Claude-down circuit-breaker (agent-outage-resilience spec, Phase 2).
 *
 * Phase 1 made the customer-facing Claude calls retry across an outage (no silent swallow). Phase 2
 * adds the breaker that lets the REST of the system stop hammering a dead API: two health signals,
 * one persisted singleton (`claude_health`), readable from BOTH runtimes.
 *
 *   (a) EXTERNAL TRUTH — a 1-min Inngest cron polls status.claude.com/api/v2/components.json and reads
 *       the per-component status of "Claude API (api.anthropic.com)" + "Claude Code". A MAJOR outage
 *       (or maintenance) on either ⇒ external-down; a `partial_outage` does NOT trip it — partial is
 *       "degraded but usable", so we run and let the retry layer absorb the 529s (CEO decision
 *       2026-07-07). (Verified 2026-06-23: this endpoint reported the June live outage as `major_outage`
 *       on both components.) A poll we can't COMPLETE (Statuspage unreachable) does
 *       NOT trip the breaker — "we can't reach the status page" ≠ "Claude is down".
 *   (b) LOCAL SIGNAL — N consecutive retryable failures (429/5xx/529/timeout) from our OWN calls. The
 *       immediate signal: it trips before the status page catches up. It auto-expires (LOCAL_SIGNAL_TTL)
 *       — once fresh failures stop arriving the local trip clears on its own, so we never need a
 *       hot-path success-reset write (the steady-state cost is zero).
 *
 * Breaker is DOWN (tripped) when EITHER signal is down. Consumers:
 *   - recordError ([[control-tower/error-feed]]) — suppresses the repair fan-out + tags the error
 *     outage-correlated while tripped (outage-window 5xx are symptoms, not bugs).
 *   - the build box (scripts/builder-worker.ts) — parks autonomous agent jobs `blocked_on_dependency`
 *     while tripped, drains them on recovery (the box analog of `blocked_on_usage`).
 *   - the Control Tower "is Claude up?" tile — shows the breaker + live component status.
 *
 * See docs/brain/specs/agent-outage-resilience.md · docs/brain/tables/claude_health.md ·
 * docs/brain/libraries/anthropic-retry.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The Statuspage.io component-status vocabulary (plus `unknown` for "we haven't / couldn't read it"). */
export type ClaudeComponentStatus =
  | "operational"
  | "degraded_performance"
  | "partial_outage"
  | "major_outage"
  | "under_maintenance"
  | "unknown";

/** The unauthenticated Statuspage components feed (agent-outage-resilience spec). */
export const CLAUDE_STATUS_COMPONENTS_URL = "https://status.claude.com/api/v2/components.json";

/** The two components we gate on, matched case-insensitively by name substring. */
const API_COMPONENT_MATCH = "claude api"; // "Claude API (api.anthropic.com)"
const CODE_COMPONENT_MATCH = "claude code"; // "Claude Code"

/** A component status that means the dependency is DOWN (vs operational / degraded / partial).
 *  Only a MAJOR outage (or maintenance) fully freezes the autonomous box. A `partial_outage` means
 *  "degraded but usable" — a large share of requests still succeed — so we let jobs RUN and lean on
 *  the anthropic-retry layer to absorb the intermittent 529s, rather than parking the whole pipeline.
 *  (CEO decision 2026-07-07: a live `partial_outage` on api+code stalled the entire Sol build + 6 PRs
 *  for an hour while the box's own `claude` CLI was answering fine. Partial = retry, not freeze.) */
function isOutageStatus(s: ClaudeComponentStatus): boolean {
  return s === "major_outage" || s === "under_maintenance";
}

/** N consecutive retryable failures from our own calls trips the LOCAL signal. */
export const LOCAL_FAILURE_THRESHOLD = 5;
/** A local trip auto-expires if no fresh failure lands within this window (no success-reset needed). */
export const LOCAL_SIGNAL_TTL_MS = 5 * 60_000;
/** Statuspage poll timeout — a slow status page must never wedge the cron. */
const POLL_TIMEOUT_MS = 8_000;

export interface ClaudeHealth {
  apiStatus: ClaudeComponentStatus;
  codeStatus: ClaudeComponentStatus;
  externalDown: boolean;
  /** the local signal evaluated live against LOCAL_SIGNAL_TTL (so an expired trip reads as clear). */
  localDown: boolean;
  /** breaker tripped — Claude treated as DOWN (externalDown || localDown). */
  down: boolean;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastPolledAt: string | null;
  pollOk: boolean | null;
  trippedAt: string | null;
  recoveredAt: string | null;
  detail: string | null;
  updatedAt: string | null;
}

/** A healthy default used when the row is missing / a read fails — fail OPEN to "Claude is up" so a
 *  breaker-read hiccup never wrongly parks the whole system. */
const DEFAULT_HEALTH: ClaudeHealth = {
  apiStatus: "unknown",
  codeStatus: "unknown",
  externalDown: false,
  localDown: false,
  down: false,
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastPolledAt: null,
  pollOk: null,
  trippedAt: null,
  recoveredAt: null,
  detail: null,
  updatedAt: null,
};

interface HealthRow {
  api_status: string;
  code_status: string;
  external_down: boolean;
  last_polled_at: string | null;
  poll_ok: boolean | null;
  consecutive_failures: number;
  last_failure_at: string | null;
  breaker_open: boolean;
  tripped_at: string | null;
  recovered_at: string | null;
  detail: string | null;
  updated_at: string | null;
}

function asComponentStatus(s: string | null | undefined): ClaudeComponentStatus {
  switch (s) {
    case "operational":
    case "degraded_performance":
    case "partial_outage":
    case "major_outage":
    case "under_maintenance":
      return s;
    default:
      return "unknown";
  }
}

/** Is the local signal currently down — threshold reached AND the last failure is still fresh? */
function localDownFrom(consecutiveFailures: number, lastFailureAt: string | null, now: number): boolean {
  if (consecutiveFailures < LOCAL_FAILURE_THRESHOLD || !lastFailureAt) return false;
  return now - new Date(lastFailureAt).getTime() <= LOCAL_SIGNAL_TTL_MS;
}

/** Project a raw row into the live ClaudeHealth view (recomputing the local-signal TTL + the breaker). */
function projectHealth(row: HealthRow, now: number): ClaudeHealth {
  const apiStatus = asComponentStatus(row.api_status);
  const codeStatus = asComponentStatus(row.code_status);
  const externalDown = isOutageStatus(apiStatus) || isOutageStatus(codeStatus);
  const localDown = localDownFrom(row.consecutive_failures ?? 0, row.last_failure_at, now);
  return {
    apiStatus,
    codeStatus,
    externalDown,
    localDown,
    down: externalDown || localDown,
    consecutiveFailures: row.consecutive_failures ?? 0,
    lastFailureAt: row.last_failure_at,
    lastPolledAt: row.last_polled_at,
    pollOk: row.poll_ok,
    trippedAt: row.tripped_at,
    recoveredAt: row.recovered_at,
    detail: row.detail,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLS =
  "api_status, code_status, external_down, last_polled_at, poll_ok, consecutive_failures, last_failure_at, breaker_open, tripped_at, recovered_at, detail, updated_at";

/** READ-ONLY: the live breaker snapshot. Best-effort — returns the healthy default on any error. */
export async function getClaudeHealth(adminClient?: Admin): Promise<ClaudeHealth> {
  try {
    const admin = adminClient ?? createAdminClient();
    const { data } = await admin.from("claude_health").select(SELECT_COLS).eq("id", "singleton").maybeSingle();
    if (!data) return DEFAULT_HEALTH;
    return projectHealth(data as unknown as HealthRow, Date.now());
  } catch {
    return DEFAULT_HEALTH;
  }
}

/** Convenience: is the breaker tripped (Claude treated as down)? Best-effort, defaults to false. */
export async function isClaudeBreakerTripped(adminClient?: Admin): Promise<boolean> {
  return (await getClaudeHealth(adminClient)).down;
}

/**
 * Persist a patch onto the singleton, recomputing the derived breaker + stamping the transition. All
 * writers (the poll cron, recordClaudeFailure) go through here so `breaker_open` + tripped/recovered
 * stamps stay consistent. Best-effort — never throws.
 */
async function persistAndRecompute(
  admin: Admin,
  patch: Partial<HealthRow>,
  detail: string | null,
): Promise<void> {
  const now = Date.now();
  const { data } = await admin.from("claude_health").select(SELECT_COLS).eq("id", "singleton").maybeSingle();
  const cur = (data as unknown as HealthRow | null) ?? {
    api_status: "unknown",
    code_status: "unknown",
    external_down: false,
    last_polled_at: null,
    poll_ok: null,
    consecutive_failures: 0,
    last_failure_at: null,
    breaker_open: false,
    tripped_at: null,
    recovered_at: null,
    detail: null,
    updated_at: null,
  };
  const next: HealthRow = { ...cur, ...patch };

  const apiStatus = asComponentStatus(next.api_status);
  const codeStatus = asComponentStatus(next.code_status);
  const externalDown = isOutageStatus(apiStatus) || isOutageStatus(codeStatus);
  const localDown = localDownFrom(next.consecutive_failures ?? 0, next.last_failure_at, now);
  const down = externalDown || localDown;
  const wasOpen = cur.breaker_open;

  const nowIso = new Date(now).toISOString();
  await admin
    .from("claude_health")
    .update({
      ...patch,
      external_down: externalDown,
      breaker_open: down,
      detail: detail ?? next.detail ?? null,
      ...(down && !wasOpen ? { tripped_at: nowIso } : {}),
      ...(!down && wasOpen ? { recovered_at: nowIso } : {}),
      updated_at: nowIso,
    })
    .eq("id", "singleton");
}

/**
 * Record one retryable Claude failure (429/5xx/529/timeout) from our OWN calls — the local signal.
 * Increments the consecutive counter + stamps last_failure_at, then recomputes the breaker (so the
 * Nth consecutive failure trips it). Best-effort — never throws (a breaker write must never break the
 * call path it rides). `where` is a short label for the persisted detail.
 */
export async function recordClaudeFailure(adminClient: Admin | undefined, where = "claude call"): Promise<void> {
  try {
    const admin = adminClient ?? createAdminClient();
    const { data } = await admin.from("claude_health").select("consecutive_failures").eq("id", "singleton").maybeSingle();
    const prev = (data as { consecutive_failures?: number } | null)?.consecutive_failures ?? 0;
    const nextCount = prev + 1;
    await persistAndRecompute(
      admin,
      { consecutive_failures: nextCount, last_failure_at: new Date().toISOString() },
      `${nextCount} consecutive retryable Claude failure(s) — latest: ${where}`,
    );
  } catch (e) {
    console.warn("[claude-health] recordClaudeFailure failed:", e instanceof Error ? e.message : e);
  }
}

/** Patterns in a free-text error/log that look like a retryable Claude dependency failure (so the box
 *  can feed its own `claude -p` 529s/overloads into the local signal). */
const RETRYABLE_CLAUDE_TEXT =
  /\b529\b|overloaded|rate.?limit|\b429\b|\b5\d\d\b|timed? ?out|timeout|econnreset|etimedout|socket hang up|fetch failed|api error/i;

/** Record a local failure only if the supplied text looks like a retryable Claude dependency failure;
 *  otherwise a no-op. Lets a generic catch site (the box worker) feed the local signal without
 *  classifying the error itself. Returns whether it counted as a Claude failure. */
export async function noteClaudeFailureFromText(
  adminClient: Admin | undefined,
  text: string | null | undefined,
  where = "claude session",
): Promise<boolean> {
  if (!text || !RETRYABLE_CLAUDE_TEXT.test(text)) return false;
  await recordClaudeFailure(adminClient, where);
  return true;
}

export interface ClaudeStatusPoll {
  apiStatus: ClaudeComponentStatus;
  codeStatus: ClaudeComponentStatus;
  /** could we COMPLETE the poll (reach + parse Statuspage)? false ⇒ statuses are 'unknown', breaker untouched. */
  ok: boolean;
}

/**
 * Poll status.claude.com for the two components. Never throws — a failed poll returns ok:false with
 * unknown statuses (so the caller leaves the external signal untouched: unreachable ≠ down).
 */
export async function pollClaudeStatus(): Promise<ClaudeStatusPoll> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
  try {
    const res = await fetch(CLAUDE_STATUS_COMPONENTS_URL, {
      signal: controller.signal,
      headers: { "user-agent": "shopcx-control-tower/claude-health" },
    });
    if (!res.ok) return { apiStatus: "unknown", codeStatus: "unknown", ok: false };
    const body = (await res.json()) as { components?: Array<{ name?: string; status?: string }> };
    const components = Array.isArray(body.components) ? body.components : [];
    const find = (match: string): ClaudeComponentStatus => {
      const c = components.find((x) => (x.name ?? "").toLowerCase().includes(match));
      return c ? asComponentStatus(c.status) : "unknown";
    };
    return { apiStatus: find(API_COMPONENT_MATCH), codeStatus: find(CODE_COMPONENT_MATCH), ok: true };
  } catch {
    return { apiStatus: "unknown", codeStatus: "unknown", ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll Statuspage + persist the external signal onto the breaker (recomputing the combined state). On
 * a poll we couldn't complete, we record `poll_ok:false` but leave the component statuses untouched
 * (don't manufacture a down). When the API reads `operational` and the local signal is stale, we also
 * housekeep the local counter back to 0. Returns the resulting live snapshot.
 */
export async function refreshClaudeHealthFromStatus(adminClient?: Admin): Promise<ClaudeHealth> {
  const admin = adminClient ?? createAdminClient();
  const poll = await pollClaudeStatus();
  const nowIso = new Date().toISOString();
  if (!poll.ok) {
    await persistAndRecompute(admin, { last_polled_at: nowIso, poll_ok: false }, "Statuspage unreachable — external signal unchanged");
    return getClaudeHealth(admin);
  }

  const patch: Partial<HealthRow> = {
    api_status: poll.apiStatus,
    code_status: poll.codeStatus,
    last_polled_at: nowIso,
    poll_ok: true,
  };
  // Housekeeping: clear a stale local counter once Statuspage confirms the API is operational.
  const externalDown = isOutageStatus(poll.apiStatus) || isOutageStatus(poll.codeStatus);
  if (!externalDown && poll.apiStatus === "operational") {
    const { data } = await admin.from("claude_health").select("consecutive_failures, last_failure_at").eq("id", "singleton").maybeSingle();
    const row = data as { consecutive_failures?: number; last_failure_at?: string | null } | null;
    if (row && (row.consecutive_failures ?? 0) > 0 && !localDownFrom(row.consecutive_failures ?? 0, row.last_failure_at ?? null, Date.now())) {
      patch.consecutive_failures = 0;
    }
  }
  const detail =
    externalDown
      ? `Claude outage — API: ${poll.apiStatus}, Code: ${poll.codeStatus}`
      : `Claude operational — API: ${poll.apiStatus}, Code: ${poll.codeStatus}`;
  await persistAndRecompute(admin, patch, detail);
  return getClaudeHealth(admin);
}
