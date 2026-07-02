/**
 * Fleet cost metering — per-job token usage for the box agent fleet (the `claude -p`
 * lanes: build / plan / fold / spec-chat / repair / regression / triage / spec-test /
 * migration-fix / …). These run on the Max subscription with NO ANTHROPIC_API_KEY, so
 * they write nothing to ai_token_usage ([[ai-usage]]) and there is no per-token dollar
 * bill. The honest proxy this records is TOKEN usage (the `claude -p` result event
 * reports it) plus the MAX ACCOUNT / config-dir that burned the 5-hour usage window.
 *
 * Two surfaces:
 *  - recordAgentJobCost(): best-effort write of one agent_job_costs row. NEVER throws
 *    into the caller — a metering failure must never block / fail / slow a build
 *    (mirrors control-tower emitLoopHeartbeat).
 *  - rollupFleetCost(): read-only aggregation over agent_job_costs + ai_token_usage,
 *    per spec_slug / kind / owner_function / day. The spend governor + the platform
 *    scorecard read this; it NEVER throttles or kills a lane.
 *
 * Honesty invariant: `$` (usageCostCents) is attached ONLY to genuinely API-billed
 * rows. Max-lane rows carry token + usage-window and are explicitly labeled a
 * subscription proxy — never a fabricated dollar figure.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { usageCostCents } from "@/lib/ai-usage";

export interface ClaudeRunUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface RecordAgentJobCostParams {
  jobId: string;
  workspaceId?: string | null;
  specSlug?: string | null;
  kind?: string | null;
  ownerFunction?: string | null;
  usage: ClaudeRunUsage | null | undefined;
  model?: string | null;
  /** Phase 2 — the Max account label that ran this turn (accountLabel). */
  account?: string | null;
  /** Phase 2 — the CLAUDE_CONFIG_DIR that ran this turn. */
  configDir?: string | null;
  /**
   * Only true for genuinely API-billed runs (the runtime AI surfaces that DO carry an
   * ANTHROPIC_API_KEY). Box Max lanes leave this false → no `$`, ever. When true AND a
   * model is known, usageCostCents is attached. Defaults false.
   */
  apiBilled?: boolean;
  /**
   * chained-phase-session-resume Phase 2 — true when this turn started as a RESUME of a prior
   * `claude -p` session (the job carried a `claude_session_id` at claim time), false when it
   * started FRESH. A resumed turn should show `cache_read_tokens` materially exceeding
   * `input_tokens` (the prior transcript served from cache ~0.1x); this flag makes the
   * comparison a WHERE-clause instead of an inferred ratio.
   */
  resumedSession?: boolean;
}

/**
 * Best-effort insert of one per-turn cost row. Returns true on write, false on any
 * failure (logged, swallowed). A job that resumes / spans turns produces multiple rows
 * keyed to the same job_id that aggregate in the rollup.
 */
export async function recordAgentJobCost(p: RecordAgentJobCostParams): Promise<boolean> {
  const u = p.usage;
  // Nothing metered (no result/usage event parsed) → skip silently. Not an error.
  if (!u || (!u.input_tokens && !u.output_tokens && !u.cache_creation_input_tokens && !u.cache_read_input_tokens)) {
    return false;
  }
  try {
    const row = {
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cache_creation_tokens: u.cache_creation_input_tokens || 0,
      cache_read_tokens: u.cache_read_input_tokens || 0,
    };
    // $ ONLY for API-billed rows with a known model. Max-lane rows stay NULL — a
    // subscription has no per-token bill, so we never fabricate a dollar figure.
    const usage_cost_cents = p.apiBilled && p.model ? usageCostCents(p.model, row) : null;
    const admin = createAdminClient();
    await admin.from("agent_job_costs").insert({
      job_id: p.jobId,
      workspace_id: p.workspaceId || null,
      spec_slug: p.specSlug || null,
      kind: p.kind || null,
      owner_function: p.ownerFunction || null,
      ...row,
      model: p.model || null,
      account: p.account || null,
      config_dir: p.configDir || null,
      usage_cost_cents,
      resumed_session: !!p.resumedSession,
    });
    return true;
  } catch (err) {
    console.error("[fleet-cost] recordAgentJobCost failed (swallowed — metering is best-effort):", err);
    return false;
  }
}

export interface FleetCostRollupOpts {
  /** Limit to one workspace (omit = all). */
  workspaceId?: string | null;
  /** Window: rows with created_at >= now() - sinceDays. Default 7. */
  sinceDays?: number;
  /** Also fold in the API-keyed runtime AI rows from ai_token_usage. Default true. */
  includeRuntimeAi?: boolean;
}

export interface FleetCostBucket {
  key: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  /** Cents — only ever non-null where a real API bill exists (API-keyed rows). */
  usd_cents: number | null;
  /** True when every contributing row is a Max-subscription lane (no per-token bill). */
  subscription_only: boolean;
}

export interface FleetCostRollup {
  windowDays: number;
  bySpec: FleetCostBucket[];
  byKind: FleetCostBucket[];
  byFunction: FleetCostBucket[];
  byDay: FleetCostBucket[];
  totals: FleetCostBucket;
  /** Raw counts so a caller can reconcile the rollup against the source rows. */
  rowCounts: { fleet: number; runtimeAi: number };
}

interface NormalRow {
  bucketSpec: string;
  bucketKind: string;
  bucketFunction: string;
  day: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  usd_cents: number | null; // null = subscription proxy (no $ bill)
}

function emptyBucket(key: string): FleetCostBucket {
  return {
    key,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
    usd_cents: null,
    subscription_only: true,
  };
}

function fold(map: Map<string, FleetCostBucket>, key: string, r: NormalRow): void {
  const b = map.get(key) || emptyBucket(key);
  b.input_tokens += r.input_tokens;
  b.output_tokens += r.output_tokens;
  b.cache_creation_tokens += r.cache_creation_tokens;
  b.cache_read_tokens += r.cache_read_tokens;
  b.total_tokens = b.input_tokens + b.output_tokens + b.cache_creation_tokens + b.cache_read_tokens;
  if (r.usd_cents != null) {
    b.usd_cents = (b.usd_cents || 0) + r.usd_cents;
    b.subscription_only = false; // at least one genuinely API-billed row contributed
  }
  map.set(key, b);
}

function sortDesc(map: Map<string, FleetCostBucket>): FleetCostBucket[] {
  return [...map.values()].sort((a, b) => b.total_tokens - a.total_tokens);
}

/**
 * Read-only spend rollup over the window. Aggregates the box fleet (agent_job_costs)
 * and, by default, the API-keyed runtime AI (ai_token_usage) so a function's TOTAL AI
 * spend (fleet + runtime) is one query. `$` rides only on the API-keyed rows; Max-lane
 * buckets stay `usd_cents: null` / `subscription_only: true`. Read-only — never mutates.
 */
export async function rollupFleetCost(opts: FleetCostRollupOpts = {}): Promise<FleetCostRollup> {
  const windowDays = opts.sinceDays ?? 7;
  const includeRuntimeAi = opts.includeRuntimeAi !== false;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const admin = createAdminClient();

  const rows: NormalRow[] = [];
  let fleetCount = 0;
  let runtimeCount = 0;

  // Box fleet — token proxy, no $ (Max lanes), unless a row carries a real usage_cost_cents.
  {
    let q = admin
      .from("agent_job_costs")
      .select("spec_slug, kind, owner_function, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, usage_cost_cents, created_at")
      .gte("created_at", since);
    if (opts.workspaceId) q = q.eq("workspace_id", opts.workspaceId);
    const { data, error } = await q;
    if (error) throw error;
    for (const r of data || []) {
      fleetCount++;
      rows.push({
        bucketSpec: (r as { spec_slug: string | null }).spec_slug || "(unknown)",
        bucketKind: (r as { kind: string | null }).kind || "(unknown)",
        bucketFunction: (r as { owner_function: string | null }).owner_function || "(unattributed)",
        day: String((r as { created_at: string }).created_at).slice(0, 10),
        input_tokens: (r as { input_tokens: number }).input_tokens || 0,
        output_tokens: (r as { output_tokens: number }).output_tokens || 0,
        cache_creation_tokens: (r as { cache_creation_tokens: number }).cache_creation_tokens || 0,
        cache_read_tokens: (r as { cache_read_tokens: number }).cache_read_tokens || 0,
        usd_cents: (r as { usage_cost_cents: number | null }).usage_cost_cents ?? null,
      });
    }
  }

  // Runtime AI — genuinely API-billed; attach $ via usageCostCents. Bucketed under the
  // 'runtime-ai' kind + its purpose, with no owner_function (a different attribution axis).
  if (includeRuntimeAi) {
    let q = admin
      .from("ai_token_usage")
      .select("model, purpose, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, created_at")
      .gte("created_at", since);
    if (opts.workspaceId) q = q.eq("workspace_id", opts.workspaceId);
    const { data, error } = await q;
    if (error) throw error;
    for (const r of data || []) {
      runtimeCount++;
      const tok = {
        input_tokens: (r as { input_tokens: number }).input_tokens || 0,
        output_tokens: (r as { output_tokens: number }).output_tokens || 0,
        cache_creation_tokens: (r as { cache_creation_tokens: number }).cache_creation_tokens || 0,
        cache_read_tokens: (r as { cache_read_tokens: number }).cache_read_tokens || 0,
      };
      rows.push({
        bucketSpec: `runtime:${(r as { purpose: string | null }).purpose || "ai"}`,
        bucketKind: "runtime-ai",
        bucketFunction: "(runtime-ai)",
        day: String((r as { created_at: string }).created_at).slice(0, 10),
        ...tok,
        usd_cents: usageCostCents((r as { model: string }).model, tok),
      });
    }
  }

  const bySpec = new Map<string, FleetCostBucket>();
  const byKind = new Map<string, FleetCostBucket>();
  const byFunction = new Map<string, FleetCostBucket>();
  const byDay = new Map<string, FleetCostBucket>();
  const totalMap = new Map<string, FleetCostBucket>();
  for (const r of rows) {
    fold(bySpec, r.bucketSpec, r);
    fold(byKind, r.bucketKind, r);
    fold(byFunction, r.bucketFunction, r);
    fold(byDay, r.day, r);
    fold(totalMap, "total", r);
  }
  const totals = totalMap.get("total") || emptyBucket("total");

  return {
    windowDays,
    bySpec: sortDesc(bySpec),
    byKind: sortDesc(byKind),
    byFunction: sortDesc(byFunction),
    byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
    totals,
    rowCounts: { fleet: fleetCount, runtimeAi: runtimeCount },
  };
}
