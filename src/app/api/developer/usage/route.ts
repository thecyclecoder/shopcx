/**
 * GET /api/developer/usage — the fleet-usage cockpit composition (Phase 3 of
 * docs/brain/specs/fleet-usage-cockpit.md).
 *
 * Owner-gated (same cookie-session auth as /api/developer/pulse — a non-owner
 * gets 403). Composes three panels:
 *
 *  (A) accounts[] — SUM(source='box' + source='mac') of account_usage_snapshots
 *      per (account, window_kind), with the discovered-limit read overlaid:
 *      Claude/Max → burn / discoverLimit(account, window) once ≥1 wall is
 *      sampled, else 'learning…' (never a fabricated %); Codex → the reported
 *      limit_pct from its own /status. Two-currency honesty: this panel
 *      renders TOKENS + rate-limit proximity + capped/reset countdown —
 *      NEVER a $ figure. See src/lib/fleet-cost.ts's invariant.
 *
 *  (B) departments[] — rollupFleetCost() per owner_function, joined against
 *      fleet_budgets ceilings + the fleet-spend-governor breach rule
 *      (tokens > ceiling || $ > ceiling — matches runFleetSpendGovernor).
 *
 *  (C) api[] — the API-billed slice from ai_token_usage over the same window:
 *      real $, by model, by purpose, plus the cached-vs-uncached input split.
 *      Small-scoped rollup — the fuller /api/workspaces/[id]/analytics/ai
 *      surface stays authoritative for the drilldowns.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { rollupFleetCost } from "@/lib/fleet-cost";
import { listFleetBudgets } from "@/lib/fleet-spend-governor";
import { usageCostCents } from "@/lib/ai-usage";
import {
  buildUsageCockpit,
  discoverLimit,
  MAX_ACCOUNT_LABELS,
  CODEX_ACCOUNT_LABEL,
  type AccountUsageSnapshotRow,
  type ApiModelBucket,
  type ApiPurposeBucket,
  type CockpitApiPanel,
  type DepartmentBudgetInput,
  type WallCounts,
} from "@/lib/usage-snapshots";

const DEFAULT_WINDOW_DAYS = 7;
const AI_TOKEN_USAGE_PAGE = 1000;

/** Read the API-billed slice of ai_token_usage into the cockpit's api panel.
 * Small-scoped — model/purpose buckets + cache split. Full drilldown remains
 * /api/workspaces/[id]/analytics/ai. */
async function buildApiPanel(admin: ReturnType<typeof createAdminClient>, workspaceId: string, windowDays: number): Promise<CockpitApiPanel> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  type UsageRow = {
    model: string;
    purpose: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_creation_tokens: number | null;
    cache_read_tokens: number | null;
  };
  const rows: UsageRow[] = [];
  for (let from = 0; ; from += AI_TOKEN_USAGE_PAGE) {
    const { data } = await admin
      .from("ai_token_usage")
      .select("model, purpose, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens")
      .eq("workspace_id", workspaceId)
      .gte("created_at", since)
      .range(from, from + AI_TOKEN_USAGE_PAGE - 1);
    if (!data || data.length === 0) break;
    rows.push(...(data as UsageRow[]));
    if (data.length < AI_TOKEN_USAGE_PAGE) break;
  }

  const byModel = new Map<string, ApiModelBucket>();
  const byPurpose = new Map<string, ApiPurposeBucket>();
  let raw_input_tokens = 0, cache_creation_tokens = 0, cache_read_tokens = 0, output_tokens = 0;
  let total_cost_cents = 0, total_tokens = 0;
  for (const r of rows) {
    const tok = {
      input_tokens: r.input_tokens || 0,
      output_tokens: r.output_tokens || 0,
      cache_creation_tokens: r.cache_creation_tokens || 0,
      cache_read_tokens: r.cache_read_tokens || 0,
    };
    const cost = usageCostCents(r.model, tok);
    const total = tok.input_tokens + tok.output_tokens + tok.cache_creation_tokens + tok.cache_read_tokens;
    total_cost_cents += cost;
    total_tokens += total;
    raw_input_tokens += tok.input_tokens;
    cache_creation_tokens += tok.cache_creation_tokens;
    cache_read_tokens += tok.cache_read_tokens;
    output_tokens += tok.output_tokens;

    const model = r.model;
    const m = byModel.get(model) || { model, ...tok, total_tokens: 0, usd_cents: 0, calls: 0 };
    m.input_tokens += tok.input_tokens; m.output_tokens += tok.output_tokens;
    m.cache_creation_tokens += tok.cache_creation_tokens; m.cache_read_tokens += tok.cache_read_tokens;
    m.total_tokens += total; m.usd_cents += cost; m.calls += 1;
    byModel.set(model, m);

    const purpose = (r.purpose || "other").split(":")[0];
    const p = byPurpose.get(purpose) || { purpose, ...tok, total_tokens: 0, usd_cents: 0, calls: 0 };
    p.input_tokens += tok.input_tokens; p.output_tokens += tok.output_tokens;
    p.cache_creation_tokens += tok.cache_creation_tokens; p.cache_read_tokens += tok.cache_read_tokens;
    p.total_tokens += total; p.usd_cents += cost; p.calls += 1;
    byPurpose.set(purpose, p);
  }

  const inputSide = raw_input_tokens + cache_creation_tokens + cache_read_tokens;
  const read_ratio_pct = inputSide ? Math.round((cache_read_tokens / inputSide) * 100) : 0;

  return {
    window_days: windowDays,
    total_cost_cents: Math.round(total_cost_cents * 100) / 100,
    total_tokens,
    cache: { raw_input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, read_ratio_pct },
    by_model: [...byModel.values()].sort((a, b) => b.usd_cents - a.usd_cents),
    by_purpose: [...byPurpose.values()].sort((a, b) => b.usd_cents - a.usd_cents),
  };
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || member.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can view fleet usage" }, { status: 403 });
  }

  const url = new URL(request.url);
  const windowDays = Math.min(30, Math.max(1, parseInt(url.searchParams.get("days") || String(DEFAULT_WINDOW_DAYS), 10) || DEFAULT_WINDOW_DAYS));

  // (A) accounts[] — snapshot rows (box + mac) for THIS workspace.
  const { data: snapshotRows } = await admin
    .from("account_usage_snapshots")
    .select("source, runtime, account, window_kind, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, capped, capped_until, window_reset_at, limit_pct, captured_at")
    .eq("workspace_id", workspaceId);
  const snapshots: AccountUsageSnapshotRow[] = (snapshotRows ?? []) as AccountUsageSnapshotRow[];

  // discoverLimit() per (account, window_kind) — every known lane + Codex,
  // plus any surprise account label a mac reporter surfaced.
  const accountsToDiscover = new Set<string>([...MAX_ACCOUNT_LABELS, CODEX_ACCOUNT_LABEL, ...snapshots.map((s) => s.account)]);
  const wallLimits: Record<string, WallCounts> = {};
  await Promise.all(
    [...accountsToDiscover].map(async (account) => {
      const [fiveH, weekly] = await Promise.all([
        discoverLimit(account, "5h"),
        discoverLimit(account, "weekly"),
      ]);
      wallLimits[account] = { fiveH, weekly };
    }),
  );

  // (B) departments[] — fleet-cost rollup per owner_function + budgets.
  const rollup = await rollupFleetCost({ workspaceId, sinceDays: windowDays });
  const budgetsRaw = await listFleetBudgets(workspaceId);
  // Reduce to workspace-preferred (workspace override beats global default) per fn key.
  const budgetByFn = new Map<string, DepartmentBudgetInput>();
  for (const b of budgetsRaw) {
    if (!b.ownerFunction) continue;
    const cur = budgetByFn.get(b.ownerFunction);
    if (!cur || (b.workspaceId && !budgetByFn.has(b.ownerFunction))) {
      budgetByFn.set(b.ownerFunction, {
        ownerFunction: b.ownerFunction,
        windowDays: b.windowDays,
        tokenCeiling: b.tokenCeiling,
        usdCeilingCents: b.usdCeilingCents,
      });
    }
  }
  const budgets: DepartmentBudgetInput[] = [...budgetByFn.values()];

  // (C) API panel — small-scoped ai_token_usage rollup over the same window.
  const api = await buildApiPanel(admin, workspaceId, windowDays);

  const cockpit = buildUsageCockpit({
    snapshots,
    wallLimits,
    functionBuckets: rollup.byFunction,
    budgets,
    api,
    now: Date.now(),
  });

  return NextResponse.json(cockpit);
}
