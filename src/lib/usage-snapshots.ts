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
    for (const window of ["5h", "weekly"] as const) {
      const sinceIso = window === "5h" ? fiveHrStart : weeklyStart;
      let sums: TokenSums;
      try {
        sums = await sumAccountCosts(admin, opts.workspaceId, account, sinceIso);
      } catch (err) {
        console.error(`[usage-snapshots] sum failed for ${account} ${window} — skipping:`, err);
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
              window,
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
            { onConflict: "workspace_id,source,account,window" },
          );
        if (error) throw error;
        upserted++;
      } catch (err) {
        console.error(`[usage-snapshots] upsert failed for ${account} ${window} — skipping:`, err);
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
      window: p.window,
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
      .eq("window", window);
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
