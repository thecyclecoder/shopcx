/**
 * Per-account usage snapshots + wall-event discovery. Phase 1 of
 * docs/brain/specs/fleet-usage-cockpit.md — the write layer the box worker
 * standing pass calls to keep [[account_usage_snapshots]] fresh, plus the
 * hidden-limit discoverer that reads [[usage_wall_events]].
 *
 * Two currencies (fleet-cost invariant): the Max/Codex accounts carry TOKENS
 * + rate-limit proximity, NEVER a fabricated $ (there is no per-token bill on
 * a subscription). The API panel (Phase 3) is the only place `$` appears.
 *
 * Discover-the-limit for Claude/Max: the box already detects walls (sets
 * AccountState.cappedUntil / markCodexCapped the instant it sees the 429/wall
 * text). At that moment we record the window's token burn as a
 * usage_wall_events row via recordWallEvent, and discoverLimit returns the
 * running MAX of tokens_at_wall over that account+window (you hit the wall AT
 * the limit — MAX observed is the best lower-bound estimate of the true
 * hidden Max limit; it tightens as more walls are sampled). Codex's real
 * limit comes from its `/status` %, so discoverLimit is Claude-only and
 * returns null for Codex.
 */
import { createAdminClient } from "@/lib/supabase/admin";

/** The Max account labels the box round-robins across. Must match the
 * live agent_job_costs.account values written by builder-worker.ts. */
export const MAX_ACCOUNT_LABELS = ["Round Robin 1", "Round Robin 2", "Round Robin 3", "Round Robin 4"] as const;
export const CODEX_ACCOUNT_LABEL = "codex" as const;

/** The rolling window the account_usage_snapshots table classifies rows by. */
export type UsageWindow = "5h" | "weekly";

/** The two agent runtimes we meter. */
export type UsageRuntime = "claude" | "codex";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** The live cap state the box passes into rollupBoxAccountUsage — one entry
 * per Max account + one for Codex. Shape mirrors the worker's in-memory
 * AccountState / codexState (surfaced on worker_heartbeats.accounts). */
export interface AccountLiveState {
  /** 'Round Robin 1'..'Round Robin 4' or 'codex'. */
  account: string;
  runtime: UsageRuntime;
  /** true when this account is currently capped. */
  capped: boolean;
  /** epoch-ms until which the cap runs, or null. */
  cappedUntil: number | null;
}

export interface RollupBoxAccountUsageOpts {
  workspaceId: string;
  /** Live cap state for the current tick (from the worker's accountsSnapshot
   * mirrored on worker_heartbeats.accounts). Any account NOT present here
   * still gets a row rolled up — it's just marked healthy. */
  liveStates: AccountLiveState[];
  /** now() override for testing. */
  now?: number;
}

interface TokenSums {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}

function emptySums(): TokenSums {
  return { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 };
}

/** SUM agent_job_costs token columns for the given account, since `sinceIso`. */
async function sumAccountCosts(
  admin: ReturnType<typeof createAdminClient>,
  workspaceIdOrNull: string | null,
  account: string,
  sinceIso: string,
): Promise<TokenSums> {
  // NOTE: agent_job_costs is written by the box and can carry
  // workspace_id=null (a build lane without an authenticated workspace).
  // For the fleet-usage cockpit we roll ALL fleet rows into the owner's
  // workspace snapshot — the workspaceId param scopes the SNAPSHOT row, not
  // the SOURCE query — so we do NOT filter by workspace_id here.
  void workspaceIdOrNull;
  let q = admin
    .from("agent_job_costs")
    .select("input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens")
    .eq("account", account)
    .gte("created_at", sinceIso);
  const { data, error } = await q;
  if (error) throw error;
  const sums = emptySums();
  for (const r of data || []) {
    sums.input_tokens += (r as { input_tokens: number }).input_tokens || 0;
    sums.output_tokens += (r as { output_tokens: number }).output_tokens || 0;
    sums.cache_creation_tokens += (r as { cache_creation_tokens: number }).cache_creation_tokens || 0;
    sums.cache_read_tokens += (r as { cache_read_tokens: number }).cache_read_tokens || 0;
  }
  return sums;
}

/** All account labels a rollup should touch: the 4 Max lanes + Codex,
 * UNIONed with any live-state entries the caller passed in (defense in depth
 * against a relabel). */
function accountsToRoll(liveStates: AccountLiveState[]): { account: string; runtime: UsageRuntime }[] {
  const seen = new Map<string, { account: string; runtime: UsageRuntime }>();
  for (const label of MAX_ACCOUNT_LABELS) seen.set(label, { account: label, runtime: "claude" });
  seen.set(CODEX_ACCOUNT_LABEL, { account: CODEX_ACCOUNT_LABEL, runtime: "codex" });
  for (const s of liveStates) if (!seen.has(s.account)) seen.set(s.account, { account: s.account, runtime: s.runtime });
  return [...seen.values()];
}

export interface RollupBoxAccountUsageResult {
  /** How many source='box' rows the rollup upserted this tick (2 per
   * account: one '5h' + one 'weekly'). */
  upserted: number;
}

/**
 * Roll up per-account 5h + weekly token burn from agent_job_costs and UPSERT
 * one source='box' snapshot row per (account, window). ALWAYS writes exactly
 * one '5h' and one 'weekly' row per Max account ('Round Robin 1'..'4') +
 * Codex — a healthy account with zero burn still gets a zeroed row so the
 * cockpit can render it as "healthy, 0 tokens". Never throws (metering is
 * best-effort — mirrors recordAgentJobCost).
 */
export async function rollupBoxAccountUsage(opts: RollupBoxAccountUsageOpts): Promise<RollupBoxAccountUsageResult> {
  const now = opts.now ?? Date.now();
  const fiveHrStart = new Date(now - FIVE_HOURS_MS).toISOString();
  const weeklyStart = new Date(now - SEVEN_DAYS_MS).toISOString();
  const capturedAt = new Date(now).toISOString();
  const admin = createAdminClient();
  const liveByAccount = new Map(opts.liveStates.map((s) => [s.account, s]));

  let upserted = 0;
  for (const { account, runtime } of accountsToRoll(opts.liveStates)) {
    const live = liveByAccount.get(account);
    const capped = !!live?.capped;
    const cappedUntilIso = live?.cappedUntil ? new Date(live.cappedUntil).toISOString() : null;
    for (const windowKind of ["5h", "weekly"] as const) {
      const sinceIso = windowKind === "5h" ? fiveHrStart : weeklyStart;
      let sums: TokenSums;
      try {
        sums = await sumAccountCosts(admin, opts.workspaceId, account, sinceIso);
      } catch (err) {
        console.error(`[usage-snapshots] sum failed for ${account} ${windowKind} — skipping:`, err);
        continue;
      }
      try {
        const { error } = await admin
          .from("account_usage_snapshots")
          .upsert(
            {
              workspace_id: opts.workspaceId,
              source: "box",
              runtime,
              account,
              // window is a SQL reserved-ish keyword — the DB column is window_kind.
              window_kind: windowKind,
              window_start: sinceIso,
              window_reset_at: cappedUntilIso,
              input_tokens: sums.input_tokens,
              output_tokens: sums.output_tokens,
              cache_creation_tokens: sums.cache_creation_tokens,
              cache_read_tokens: sums.cache_read_tokens,
              capped,
              capped_until: cappedUntilIso,
              limit_pct: null,
              captured_at: capturedAt,
              updated_at: capturedAt,
            },
            { onConflict: "workspace_id,source,account,window_kind" },
          );
        if (error) throw error;
        upserted++;
      } catch (err) {
        console.error(`[usage-snapshots] upsert failed for ${account} ${windowKind} — skipping:`, err);
      }
    }
  }
  return { upserted };
}

/** The four token columns summed for a (account, window) slice — helper for
 * recordWallEvent so the caller doesn't repeat the SUM. */
export async function currentWindowBurn(
  workspaceId: string,
  account: string,
  window: UsageWindow,
  nowMs: number = Date.now(),
): Promise<number> {
  void workspaceId; // agent_job_costs is not per-workspace scoped (see sumAccountCosts).
  const admin = createAdminClient();
  const since = new Date(nowMs - (window === "5h" ? FIVE_HOURS_MS : SEVEN_DAYS_MS)).toISOString();
  try {
    const sums = await sumAccountCosts(admin, null, account, since);
    return sums.input_tokens + sums.output_tokens + sums.cache_creation_tokens + sums.cache_read_tokens;
  } catch (err) {
    console.error(`[usage-snapshots] currentWindowBurn failed for ${account} ${window}:`, err);
    return 0;
  }
}

export interface RecordWallEventParams {
  workspaceId: string;
  account: string;
  runtime: UsageRuntime;
  window: UsageWindow;
  tokensAtWall: number;
  wallText?: string | null;
  wallResetAt?: string | null; // ISO
}

/**
 * Record ONE detected wall event. Called from builder-worker's cap-detection
 * paths (where markAccountCapped / markCodexCapped fires). Never throws —
 * metering + discovery is best-effort.
 */
export async function recordWallEvent(p: RecordWallEventParams): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("usage_wall_events").insert({
      workspace_id: p.workspaceId,
      account: p.account,
      runtime: p.runtime,
      // window is a SQL reserved-ish keyword — the DB column is window_kind.
      window_kind: p.window,
      tokens_at_wall: Math.max(0, Math.round(p.tokensAtWall || 0)),
      wall_text: p.wallText ?? null,
      wall_reset_at: p.wallResetAt ?? null,
    });
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("[usage-snapshots] recordWallEvent failed (swallowed):", err);
    return false;
  }
}

export interface DiscoveredLimit {
  /** MAX(tokens_at_wall) over usage_wall_events for this account+window.
   * The lower-bound estimate of the hidden Max limit — tightens toward the
   * true ceiling as more walls are sampled. Null when no walls sampled yet
   * OR when the runtime is Codex (Codex's real % lives in /status). */
  limit: number | null;
  /** How many walls contributed to the max — the confidence signal
   * (0 = "learning…", higher = tighter estimate). */
  wallCount: number;
}

/** A minimal admin surface for testing — the subset of createAdminClient()
 * this module reads. Prod passes a real admin via createAdminClient(). */
export interface UsageSnapshotsAdmin {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string | number) => {
        eq: (col: string, val: string | number) => Promise<{
          data: Array<Record<string, unknown>> | null;
          error: Error | null;
        }>;
      };
    };
  };
}

/**
 * The running MAX of tokens_at_wall across all sampled walls for this
 * account+window (Claude/Max only). Codex ⇒ { limit: null, wallCount: <count> }
 * (its real limit comes from /status, not wall discovery). Never throws —
 * a DB failure returns { limit: null, wallCount: 0 } so the cockpit
 * gracefully degrades to "learning…". Accepts an optional admin override so
 * unit tests can inject a fake DB without stubbing createAdminClient.
 */
export async function discoverLimit(
  account: string,
  window: UsageWindow,
  adminOverride?: UsageSnapshotsAdmin,
): Promise<DiscoveredLimit> {
  try {
    const admin = adminOverride ?? (createAdminClient() as unknown as UsageSnapshotsAdmin);
    const { data, error } = await admin
      .from("usage_wall_events")
      .select("tokens_at_wall, runtime")
      .eq("account", account)
      // window is a SQL reserved-ish keyword — the DB column is window_kind.
      .eq("window_kind", window);
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) return { limit: null, wallCount: 0 };
    // If ANY sampled row for this account is Codex, discoverLimit is null
    // (Codex's real limit is its /status %). We still return the wall COUNT
    // so the cockpit can show "N walls sampled — using /status %".
    const isCodex = rows.some((r) => (r as { runtime: string }).runtime === "codex");
    if (isCodex) return { limit: null, wallCount: rows.length };
    let max = 0;
    for (const r of rows) {
      const t = Number((r as { tokens_at_wall: number | string }).tokens_at_wall) || 0;
      if (t > max) max = t;
    }
    return { limit: max || null, wallCount: rows.length };
  } catch (err) {
    console.error(`[usage-snapshots] discoverLimit failed for ${account} ${window}:`, err);
    return { limit: null, wallCount: 0 };
  }
}

// ── Phase 2 — Mac reporter ingest ─────────────────────────────────────────────
// The shape POST /api/developer/usage/report accepts. The Mac reporter's
// scripts/usage-report.ts maps `ccusage blocks --json` (Claude + Codex) into
// this + POSTs with an owner bearer token. Same unique key as Phase 1 so a
// re-report REPLACES the prior mac slice.

export interface MacSnapshotInput {
  account: string;
  runtime: UsageRuntime;
  /** '5h' or 'weekly' — the JS-side name; UPSERT maps this to the DB column
   * window_kind (`window` is a SQL reserved-ish keyword). */
  window: UsageWindow;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  window_start?: string | null;
  window_reset_at?: string | null;
  capped?: boolean;
  capped_until?: string | null;
  /** Codex only — the reported /status %. Claude leaves this null. */
  limit_pct?: number | null;
  captured_at?: string | null;
}

export interface MacReportPayload {
  workspace_id: string;
  snapshots: MacSnapshotInput[];
}

export type MacReportValidation =
  | { ok: true; payload: MacReportPayload }
  | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function toNonNegInt(v: unknown): number | null {
  if (!isFiniteNumber(v)) return null;
  if (v < 0) return null;
  return Math.round(v);
}
function normISO(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (!isString(v) || !v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

/**
 * Validate the Mac reporter's payload. Pure — accepts an unknown parsed JSON
 * value and returns a discriminated result. The route uses this to translate
 * a malformed / missing-field body into a 400 (never a 500).
 *
 * Contract:
 *  - workspace_id: UUID (matches the row's RLS scope)
 *  - snapshots: non-empty array; each entry MUST carry account, runtime,
 *    window, and the four token counters (non-negative integers). All other
 *    fields are optional / null-coerced.
 */
export function validateMacReportPayload(input: unknown): MacReportValidation {
  if (!input || typeof input !== "object") return { ok: false, error: "body must be a JSON object" };
  const body = input as Record<string, unknown>;

  const workspaceId = body.workspace_id;
  if (!isString(workspaceId) || !UUID_RE.test(workspaceId)) {
    return { ok: false, error: "workspace_id must be a UUID string" };
  }

  const raw = body.snapshots;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "snapshots must be a non-empty array" };
  }

  const snapshots: MacSnapshotInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i];
    if (!s || typeof s !== "object") return { ok: false, error: `snapshots[${i}] must be an object` };
    const r = s as Record<string, unknown>;

    if (!isString(r.account) || !r.account) return { ok: false, error: `snapshots[${i}].account is required` };
    if (r.runtime !== "claude" && r.runtime !== "codex") return { ok: false, error: `snapshots[${i}].runtime must be 'claude' or 'codex'` };
    if (r.window !== "5h" && r.window !== "weekly") return { ok: false, error: `snapshots[${i}].window must be '5h' or 'weekly'` };

    const input_tokens = toNonNegInt(r.input_tokens);
    const output_tokens = toNonNegInt(r.output_tokens);
    const cache_creation_tokens = toNonNegInt(r.cache_creation_tokens);
    const cache_read_tokens = toNonNegInt(r.cache_read_tokens);
    if (input_tokens === null || output_tokens === null || cache_creation_tokens === null || cache_read_tokens === null) {
      return { ok: false, error: `snapshots[${i}] token counters must be non-negative integers (input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens)` };
    }

    const window_start = normISO(r.window_start);
    const window_reset_at = normISO(r.window_reset_at);
    const capped_until = normISO(r.capped_until);
    const captured_at = normISO(r.captured_at);
    const capped = isBoolean(r.capped) ? r.capped : false;
    const limit_pct = isFiniteNumber(r.limit_pct) ? Math.max(0, Math.min(100, r.limit_pct)) : null;

    snapshots.push({
      account: r.account,
      runtime: r.runtime,
      window: r.window,
      input_tokens,
      output_tokens,
      cache_creation_tokens,
      cache_read_tokens,
      window_start,
      window_reset_at,
      capped,
      capped_until,
      limit_pct,
      captured_at,
    });
  }

  return { ok: true, payload: { workspace_id: workspaceId, snapshots } };
}

/**
 * UPSERT the Mac reporter's snapshots into account_usage_snapshots with
 * source='mac'. Same unique key as the box writer (workspace_id, source,
 * account, window_kind) — a re-report REPLACES the prior mac slice.
 * Returns the number of rows upserted.
 */
export async function upsertMacSnapshots(
  admin: ReturnType<typeof createAdminClient>,
  payload: MacReportPayload,
): Promise<number> {
  const now = new Date().toISOString();
  const rows = payload.snapshots.map((s) => ({
    workspace_id: payload.workspace_id,
    source: "mac" as const,
    runtime: s.runtime,
    account: s.account,
    // JS-side field is `window`; the DB column is `window_kind` (WINDOW is a SQL keyword).
    window_kind: s.window,
    window_start: s.window_start ?? null,
    window_reset_at: s.window_reset_at ?? null,
    input_tokens: s.input_tokens,
    output_tokens: s.output_tokens,
    cache_creation_tokens: s.cache_creation_tokens,
    cache_read_tokens: s.cache_read_tokens,
    capped: !!s.capped,
    capped_until: s.capped_until ?? null,
    limit_pct: s.limit_pct ?? null,
    captured_at: s.captured_at ?? now,
    updated_at: now,
  }));
  const { error } = await admin
    .from("account_usage_snapshots")
    .upsert(rows, { onConflict: "workspace_id,source,account,window_kind" });
  if (error) throw error;
  return rows.length;
}

// ── ccusage → payload mapper (pure) ──────────────────────────────────────────
// The Mac reporter calls `ccusage blocks --json` twice (once for ~/.claude,
// once for ~/.codex/sessions) and passes the parsed output to this mapper.
// Pure so a fixture harness proves the mapping without needing live ccusage.

export interface CcusageBlockLike {
  /** Rolling 5h block start (ISO). */
  startTime?: string;
  /** Block end / reset (ISO). */
  endTime?: string;
  /** Actual last activity (ISO). */
  actualEndTime?: string;
  /** True while the block is the currently-burning 5h window. */
  isActive?: boolean;
  /** Gap markers ccusage inserts between clusters — skip. */
  isGap?: boolean;
  /** Per-block token totals. ccusage's field names have drifted between
   * versions; accept both camelCase and snake_case, both nested + flat. */
  tokenCounts?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** ccusage projection block — future spend, not a real burn — skip. */
  projection?: unknown;
}

export interface CcusageOutputLike {
  blocks?: CcusageBlockLike[];
}

function extractTokens(b: CcusageBlockLike): { input: number; output: number; cacheCreate: number; cacheRead: number } {
  const t = b.tokenCounts || {};
  return {
    input: Math.max(0, Math.round(t.inputTokens ?? b.inputTokens ?? 0)),
    output: Math.max(0, Math.round(t.outputTokens ?? b.outputTokens ?? 0)),
    cacheCreate: Math.max(0, Math.round(t.cacheCreationInputTokens ?? b.cacheCreationInputTokens ?? 0)),
    cacheRead: Math.max(0, Math.round(t.cacheReadInputTokens ?? b.cacheReadInputTokens ?? 0)),
  };
}

export interface CcusageMapOpts {
  /** The account label to attribute the rollup to. Claude → 'Round Robin 1'..
   * (or a caller-chosen Mac lane); Codex → 'codex'. */
  account: string;
  runtime: UsageRuntime;
  /** now() override for testing. */
  now?: number;
}

/**
 * Map a `ccusage blocks --json` output to two Mac snapshot payloads:
 *   • '5h'     = the currently ACTIVE block (or the most recent non-projection block if none active)
 *   • 'weekly' = the trailing 7-day sum across all real (non-projection, non-gap) blocks
 *
 * Never throws — a missing / empty ccusage output yields zeroed snapshots so
 * the reporter still emits the two-per-account contract Phase 1's rollup
 * asserts. Pure — no filesystem, no network.
 */
export function mapCcusageToSnapshots(
  ccusage: CcusageOutputLike | null | undefined,
  opts: CcusageMapOpts,
): [MacSnapshotInput, MacSnapshotInput] {
  const now = opts.now ?? Date.parse("2026-01-01T00:00:00.000Z");
  const nowIso = new Date(now).toISOString();
  const weeklyStartMs = now - SEVEN_DAYS_MS;
  const rawBlocks = Array.isArray(ccusage?.blocks) ? ccusage!.blocks! : [];
  const real = rawBlocks.filter((b) => b && !b.isGap && !b.projection);

  // 5h — the currently active block; else the most recent real block.
  const active = real.find((b) => !!b.isActive) ?? real[real.length - 1];
  const activeTok = active ? extractTokens(active) : { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  const activeStart = active?.startTime ?? new Date(now - FIVE_HOURS_MS).toISOString();
  const activeEnd = active?.endTime ?? null;
  const fiveH: MacSnapshotInput = {
    account: opts.account,
    runtime: opts.runtime,
    window: "5h",
    input_tokens: activeTok.input,
    output_tokens: activeTok.output,
    cache_creation_tokens: activeTok.cacheCreate,
    cache_read_tokens: activeTok.cacheRead,
    window_start: activeStart,
    window_reset_at: activeEnd,
    capped: false,
    capped_until: null,
    limit_pct: null,
    captured_at: nowIso,
  };

  // Weekly — sum all real blocks whose end (or start, if end missing) is
  // within the trailing 7 days. Robust to ccusage's mix of shapes.
  let wI = 0, wO = 0, wCC = 0, wCR = 0;
  for (const b of real) {
    const endT = b.endTime ? Date.parse(b.endTime) : b.startTime ? Date.parse(b.startTime) : NaN;
    if (Number.isNaN(endT) || endT < weeklyStartMs) continue;
    const t = extractTokens(b);
    wI += t.input;
    wO += t.output;
    wCC += t.cacheCreate;
    wCR += t.cacheRead;
  }
  const weekly: MacSnapshotInput = {
    account: opts.account,
    runtime: opts.runtime,
    window: "weekly",
    input_tokens: wI,
    output_tokens: wO,
    cache_creation_tokens: wCC,
    cache_read_tokens: wCR,
    window_start: new Date(weeklyStartMs).toISOString(),
    window_reset_at: null,
    capped: false,
    capped_until: null,
    limit_pct: null,
    captured_at: nowIso,
  };

  return [fiveH, weekly];
}

/**
 * Codex-turn overlay for the meterAgentJob → recordAgentJobCost params — a
 * pure mapping, unit-testable without importing the 18k-line builder-worker.
 * Returns the (account, configDir, apiBilled) trio to override when the run
 * came off Codex (model prefixed "codex/"); returns null for a Claude run so
 * the caller uses its Round-Robin-derived defaults.
 *
 * Contract (fleet-usage-cockpit Phase 1): the Codex turn.completed path
 * records with account='codex' + apiBilled=false — no per-token bill on a
 * ChatGPT plan, so Codex carries token burn like a Max lane.
 */
export interface CodexCostOverride {
  account: "codex";
  configDir: null;
  apiBilled: false;
}
export function codexCostOverride(model: string | null | undefined): CodexCostOverride | null {
  const isCodex = !!model && model.startsWith("codex/");
  return isCodex ? { account: "codex", configDir: null, apiBilled: false } : null;
}
