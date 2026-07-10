/**
 * Decision engine — Storefront Iteration Engine Phase 4.
 *
 * Turns the Phase 3 scorecards + the active policy into TWO distinct outputs:
 *
 *  4a — Autonomous policy actions (deterministic, bounded by active policy):
 *       pause · unpause · scale_up (≤ step cap) · scale_down · replenish_creative,
 *       at the adset/campaign grain. NO external (Meta) writes here — Phase 6a
 *       executes; this layer only DECIDES and stamps the authorizing policy
 *       version + triggering scorecard row. With NO active policy the engine
 *       takes ZERO autonomous actions (the core safety invariant).
 *
 *  4b — Approval-gated recommendations (new live spend lines): an Opus layer
 *       reasoning as three personas (direct-response marketer, offer designer,
 *       media buyer) over the scorecards + product intelligence, persisted to
 *       `iteration_recommendations` as `status='pending'` for Dylan to flip live.
 *
 * Supervisable, not silent: every action/recommendation carries its rationale
 * (the trigger + the policy rule invoked). Hitting a guardrail (budget floor,
 * per-account daily delta ceiling, never-pause list) ESCALATES (flagged for the
 * Growth Director / human) rather than executing.
 *
 * The engine reads METRICS only from `iteration_scorecards_daily` (Phase 3),
 * never the raw session/insight tables. It reads policy/ledger from the Phase 4c
 * tables read-only (defensive: if those tables don't exist yet, policy resolves
 * to null → zero autonomous actions, and the ledger resolves to empty). Budget
 * structure (`daily_budget_cents`) is read from `meta_adsets`/`meta_campaigns`
 * so deltas can be expressed in cents.
 *
 * See docs/brain/specs/storefront-iteration-engine.md (Phase 4).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { OPUS_MODEL } from "@/lib/ai-models";

// ── Types ───────────────────────────────────────────────────────────────────

export type ScorecardLevel = "ad" | "adset" | "campaign" | "variant" | "angle";

/** The subset of `iteration_scorecards_daily` the engine acts on. */
export interface ScorecardRow {
  id: string;
  level: ScorecardLevel;
  object_id: string;
  label: string | null;
  effective_status: string | null;
  parent_campaign_id: string | null;
  snapshot_date: string;
  window_days: number;
  spend_cents: number;
  revenue_cents: number;
  roas: number;
  roas_prev: number;
  spend_prev_cents: number;
  ctr_declining: boolean;
  frequency_rising: boolean;
  fatigue_score: number;
  creatives_live: number;
  days_live: number;
  cvr: number;
  sessions: number;
  atc_rate: number;
  angle_id: string | null;
  lead_benefit_anchor: string | null;
  benefit_name: string | null;
}

/**
 * The active policy version (Phase 4c `iteration_policies` row). Typed contract
 * the engine consumes read-only — the Growth Director (or human) authors versions.
 * Thresholds are the spec's editable control surface.
 */
export interface IterationPolicy {
  id: string;                  // policy version row id — stamped onto every action
  version: number;
  roas_floor: number;                              // ROAS below which an object underperforms
  scale_up_roas_trigger: number;                   // ROAS at/above which to scale up
  scale_up_step_pct: number;                       // per-step budget increase (e.g. 0.20)
  scale_up_cap_pct: number;                        // max single-step increase (cumulative cap proxy in v1)
  scale_down_step_pct: number;                     // budget reduction on underperformance
  pause_min_spend_cents: number;                   // min window spend before pause is eligible
  pause_window_days: number;                       // window the pause trigger evaluates (legibility)
  unpause_sales_after_pause: number;               // sales since pause to consider unpausing
  unpause_lookback_days: number;                   // how far back to look for the pause + sales
  min_creatives_per_adset: number;                 // replenish trigger
  per_object_cooldown_hours: number;               // min hours between actions on one object
  per_account_daily_budget_delta_ceiling_cents: number; // run-wide budget-change ceiling
  min_budget_floor_cents: number | null;           // guardrail: never scale an object below this
  never_pause_object_ids: string[];                // guardrail: never fully pause these
  /** Safety branch (media-buyer-shadow-mode Phase 1) — `shadow` (read-only: plan only, no
   *  iteration_actions / ad_publish_jobs writes) or `armed` (pre-shadow behavior). Fresh
   *  policies default to `shadow`; the flip to `armed` is a separate, audited surface. */
  mode: "shadow" | "armed";
  /** Media-buyer "trust Meta's reported signal" (CEO 2026-07-10). When true, the runtime detects
   *  winners/losers on Meta's REPORTED CPA (meta_insights_daily via iteration_scorecards_daily) and the
   *  sensor-trust gate trusts Meta (freshness, not internal-resolve coverage). See
   *  [[../../media-buyer/agent]]. */
  trust_meta_reported_signal: boolean;
  /** Crown a winner only at Meta-reported CPA (spend/purchases) ≤ this (cents); null = ROAS-floor path. */
  crown_max_cpa_cents: number | null;
  /** ...AND ≥ this much Meta spend (cents) — the verdict floor (e.g. 45000 = $450). */
  crown_min_spend_cents: number | null;
  /** Trim a loser early once it has ≥ this spend (cents), judged on the LEADING signals below. */
  early_trim_min_spend_cents: number | null;
  /** Early trim if cost-per-ATC (spend ÷ add_to_cart) > this (cents) — the primary leading signal. */
  trim_max_cost_per_atc_cents: number | null;
  /** ...or if CPM (spend per 1000 impressions) > this (cents) — Meta disfavoring the ad. */
  trim_max_cpm_cents: number | null;
}

export type AutonomousActionType =
  | "pause"
  | "unpause"
  | "scale_up"
  | "scale_down"
  | "replenish_creative";

export interface ComputedAction {
  level: "adset" | "campaign";
  object_id: string;
  label: string | null;
  action_type: AutonomousActionType;
  rationale: string;                 // surfaced reasoning: trigger + policy rule invoked
  policy_version_id: string;         // authorizing policy version (iteration_policies.id)
  triggering_scorecard_id: string;   // the iteration_scorecards_daily row this cites
  before: { budget_cents: number | null; status: string | null };
  after: { budget_cents: number | null; status: string | null };
  /** Present only on escalations — the guardrail that fired; do NOT execute, flag instead. */
  guardrail?: string;
}

export type RecommendationType =
  | "new_static_adset"
  | "new_video_adset"
  | "new_campaign"
  | "test_benefit_angle"
  | "new_lander_variant"
  | "offer_test";

export type Persona = "direct_response_marketer" | "offer_designer" | "media_buyer";

export interface ComputedRecommendation {
  action_type: RecommendationType;
  persona: Persona;
  title: string;
  rationale: string;
  source_metrics: Record<string, unknown>;
  expected_impact: string;
  confidence: number; // 0..1
  target_object_level: "account" | "campaign" | "adset" | "angle" | "variant" | null;
  target_object_id: string | null;
  params: Record<string, unknown>;
  source_scorecard_ids: string[];
  dedup_key: string;
}

export interface DecisionEngineParams {
  workspaceId: string;
  adAccountId: string; // our DB uuid for meta_ad_accounts
}

export interface DecisionEngineResult {
  snapshotDate: string;
  policy_active: boolean;
  policy_version_id: string | null;
  autonomous: {
    actions: ComputedAction[];
    escalations: ComputedAction[];
    counts: Record<AutonomousActionType, number>;
  };
  recommendations: {
    generated: number;
    persisted: number;
    byType: Partial<Record<RecommendationType, number>>;
    byPersona: Partial<Record<Persona, number>>;
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

const dayStr = (d: Date) => d.toISOString().slice(0, 10);
const isActive = (status: string | null) => status === "ACTIVE";
const isPaused = (status: string | null) => status === "PAUSED";
const pct = (n: number) => `${Math.round(n * 100)}%`;
const dollars = (cents: number | null) => (cents == null ? "n/a" : `$${(cents / 100).toFixed(2)}`);

// Page past PostgREST's 1000-row cap (mirrors scorecards.ts / attribution.ts).
async function fetchAllRows<T>(
  makeQuery: () => { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }> },
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1);
    if (error) break;
    const rows = data || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// ── Policy + ledger loaders (Phase 4c tables; read-only, degrade safely) ────────

/**
 * The active policy version, or null when none is active (or the Phase 4c
 * `iteration_policies` table doesn't exist yet). Null → ZERO autonomous actions,
 * exactly the spec's "no active policy → engine takes no action" invariant.
 * Global in v1 (campaign-scoped overrides reserved on the table for later).
 */
export async function loadActivePolicy(
  workspaceId: string,
  _adAccountId: string,
): Promise<IterationPolicy | null> {
  const admin = createAdminClient();
  try {
    const { data, error } = await admin
      .from("iteration_policies")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("status", "active")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const p = data as Record<string, unknown>;
    return {
      id: p.id as string,
      version: Number(p.version ?? 0),
      roas_floor: Number(p.roas_floor ?? 0),
      scale_up_roas_trigger: Number(p.scale_up_roas_trigger ?? 0),
      scale_up_step_pct: Number(p.scale_up_step_pct ?? 0),
      scale_up_cap_pct: Number(p.scale_up_cap_pct ?? 0),
      scale_down_step_pct: Number(p.scale_down_step_pct ?? 0),
      pause_min_spend_cents: Number(p.pause_min_spend_cents ?? 0),
      pause_window_days: Number(p.pause_window_days ?? 0),
      unpause_sales_after_pause: Number(p.unpause_sales_after_pause ?? 0),
      unpause_lookback_days: Number(p.unpause_lookback_days ?? 0),
      min_creatives_per_adset: Number(p.min_creatives_per_adset ?? 0),
      per_object_cooldown_hours: Number(p.per_object_cooldown_hours ?? 0),
      per_account_daily_budget_delta_ceiling_cents: Number(p.per_account_daily_budget_delta_ceiling_cents ?? 0),
      min_budget_floor_cents: p.min_budget_floor_cents == null ? null : Number(p.min_budget_floor_cents),
      never_pause_object_ids: Array.isArray(p.never_pause_object_ids) ? (p.never_pause_object_ids as string[]) : [],
      // Safety branch (media-buyer-shadow-mode Phase 1). Absent column ⇒ shadow — a workspace
      // reading the engine before the migration lands still gets the CEO's safe default.
      mode: p.mode === "armed" ? "armed" : "shadow",
      // Trust-Meta signal (CEO 2026-07-10). Absent column ⇒ false — pre-migration workspaces keep the
      // internal-resolve ROAS behavior; only a policy that opts in trusts Meta's reported CPA.
      trust_meta_reported_signal: p.trust_meta_reported_signal === true,
      crown_max_cpa_cents: p.crown_max_cpa_cents == null ? null : Number(p.crown_max_cpa_cents),
      crown_min_spend_cents: p.crown_min_spend_cents == null ? null : Number(p.crown_min_spend_cents),
      early_trim_min_spend_cents: p.early_trim_min_spend_cents == null ? null : Number(p.early_trim_min_spend_cents),
      trim_max_cost_per_atc_cents: p.trim_max_cost_per_atc_cents == null ? null : Number(p.trim_max_cost_per_atc_cents),
      trim_max_cpm_cents: p.trim_max_cpm_cents == null ? null : Number(p.trim_max_cpm_cents),
    };
  } catch {
    return null;
  }
}

/** Recent actions on this account (Phase 4c `iteration_actions`) — for cooldown +
 * graduated-failure (was-recently-scaled, last-pause). Empty when the table is absent. */
interface RecentAction {
  object_id: string;
  action_type: string;
  created_at: string;
}
export async function loadRecentActions(
  workspaceId: string,
  adAccountId: string,
  sinceIso: string,
): Promise<RecentAction[]> {
  const admin = createAdminClient();
  try {
    const { data, error } = await admin
      .from("iteration_actions")
      .select("object_id, action_type, created_at")
      .eq("workspace_id", workspaceId)
      .eq("meta_ad_account_id", adAccountId)
      .gte("created_at", sinceIso);
    if (error || !data) return [];
    return data as RecentAction[];
  } catch {
    return [];
  }
}

// ── 4a — Autonomous policy actions (pure, deterministic) ─────────────────────

export interface AutonomousInputs {
  rows: ScorecardRow[];                 // adset/campaign scorecard rows for the snapshot
  policy: IterationPolicy;
  budgets: Map<string, number | null>;  // object_id → daily_budget_cents (null under CBO/ABO crossover)
  recentActions: RecentAction[];
  nowMs: number;
}

/**
 * Deterministic, policy-driven decisions at the adset/campaign grain. Pure: no
 * DB, no Meta. Returns executable `actions` and `escalations` (guardrail hits that
 * must be flagged, not executed). Graduated failure: a recently-scaled object that
 * drops below floor scales DOWN first; pause only after a second consecutive bad
 * window (both current and prior window below floor) with enough spend.
 */
export function computeAutonomousActions(input: AutonomousInputs): {
  actions: ComputedAction[];
  escalations: ComputedAction[];
} {
  const { rows, policy, budgets, recentActions, nowMs } = input;
  const actions: ComputedAction[] = [];
  const escalations: ComputedAction[] = [];

  // cooldown / graduated-failure lookups keyed by object
  const lastActionAt = new Map<string, number>();
  const recentlyScaledUp = new Set<string>();
  const lastPauseAt = new Map<string, number>();
  for (const a of recentActions) {
    const t = new Date(a.created_at).getTime();
    const prev = lastActionAt.get(a.object_id);
    if (prev == null || t > prev) lastActionAt.set(a.object_id, t);
    if (a.action_type === "scale_up") recentlyScaledUp.add(a.object_id);
    if (a.action_type === "pause") {
      const p = lastPauseAt.get(a.object_id);
      if (p == null || t > p) lastPauseAt.set(a.object_id, t);
    }
  }
  const cooldownMs = policy.per_object_cooldown_hours * 3600_000;
  const inCooldown = (objectId: string) => {
    const last = lastActionAt.get(objectId);
    return last != null && nowMs - last < cooldownMs;
  };
  const neverPause = new Set(policy.never_pause_object_ids);

  // Per-account daily budget-delta ceiling — accumulated across scale actions.
  let cumulativeDelta = 0;
  const ceiling = policy.per_account_daily_budget_delta_ceiling_cents;

  const push = (a: ComputedAction) => {
    if (a.guardrail) escalations.push(a);
    else actions.push(a);
  };

  // Apply a budget-change action with floor + ceiling guardrails.
  const emitBudgetChange = (
    row: ScorecardRow,
    type: "scale_up" | "scale_down",
    targetCents: number | null,
    baseRationale: string,
  ) => {
    const before = budgets.get(row.object_id) ?? null;
    const after = targetCents;
    const delta = before != null && after != null ? Math.abs(after - before) : 0;

    // Budget floor guardrail (scale_down only).
    if (
      type === "scale_down" &&
      policy.min_budget_floor_cents != null &&
      before != null &&
      before <= policy.min_budget_floor_cents
    ) {
      push({
        level: row.level as "adset" | "campaign",
        object_id: row.object_id,
        label: row.label,
        action_type: type,
        rationale: `${baseRationale} — at/below budget floor ${dollars(policy.min_budget_floor_cents)}; escalating instead of cutting further.`,
        policy_version_id: policy.id,
        triggering_scorecard_id: row.id,
        before: { budget_cents: before, status: row.effective_status },
        after: { budget_cents: before, status: row.effective_status },
        guardrail: "min_budget_floor",
      });
      return;
    }

    // Per-account daily budget-delta ceiling guardrail.
    if (ceiling > 0 && delta > 0 && cumulativeDelta + delta > ceiling) {
      push({
        level: row.level as "adset" | "campaign",
        object_id: row.object_id,
        label: row.label,
        action_type: type,
        rationale: `${baseRationale} — would breach the per-account daily budget-delta ceiling ${dollars(ceiling)}; escalating for manual review.`,
        policy_version_id: policy.id,
        triggering_scorecard_id: row.id,
        before: { budget_cents: before, status: row.effective_status },
        after: { budget_cents: after, status: row.effective_status },
        guardrail: "per_account_daily_budget_delta_ceiling",
      });
      return;
    }

    cumulativeDelta += delta;
    push({
      level: row.level as "adset" | "campaign",
      object_id: row.object_id,
      label: row.label,
      action_type: type,
      rationale: baseRationale,
      policy_version_id: policy.id,
      triggering_scorecard_id: row.id,
      before: { budget_cents: before, status: row.effective_status },
      after: { budget_cents: after, status: row.effective_status },
    });
  };

  for (const row of rows) {
    if (row.level !== "adset" && row.level !== "campaign") continue;
    if (inCooldown(row.object_id)) continue; // hard stop

    const budget = budgets.get(row.object_id) ?? null;
    const roasLine = `ROAS ${row.roas.toFixed(2)} vs floor ${policy.roas_floor.toFixed(2)}`;

    // ── PAUSED → unpause? (needs the ledger; inert without Phase 4c data) ───────
    if (isPaused(row.effective_status)) {
      const pausedAt = lastPauseAt.get(row.object_id);
      const lookbackMs = policy.unpause_lookback_days * 86400_000;
      const salesAfterPause = row.revenue_cents; // window revenue stands in for "sales since pause"
      if (
        pausedAt != null &&
        nowMs - pausedAt <= lookbackMs &&
        salesAfterPause >= policy.unpause_sales_after_pause
      ) {
        push({
          level: row.level as "adset" | "campaign",
          object_id: row.object_id,
          label: row.label,
          action_type: "unpause",
          rationale: `Unpause: paused within ${policy.unpause_lookback_days}d but logged ${dollars(salesAfterPause)} in sales since — demand recovered.`,
          policy_version_id: policy.id,
          triggering_scorecard_id: row.id,
          before: { budget_cents: budget, status: row.effective_status },
          after: { budget_cents: budget, status: "ACTIVE" },
        });
      }
      continue; // don't apply scale/pause logic to a paused object
    }

    if (!isActive(row.effective_status)) continue; // only manage live objects

    // ── Replenish a thin adset with creative ────────────────────────────────────
    if (
      row.level === "adset" &&
      policy.min_creatives_per_adset > 0 &&
      row.creatives_live < policy.min_creatives_per_adset
    ) {
      push({
        level: "adset",
        object_id: row.object_id,
        label: row.label,
        action_type: "replenish_creative",
        rationale: `Replenish: ${row.creatives_live} live creative(s) < min ${policy.min_creatives_per_adset}. Proven/reused creative may go live; brand-new uploads as a PAUSED draft (Phase 6a).`,
        policy_version_id: policy.id,
        triggering_scorecard_id: row.id,
        before: { budget_cents: budget, status: row.effective_status },
        after: { budget_cents: budget, status: row.effective_status },
      });
      // replenish is independent of the budget decision below — keep evaluating
    }

    // ── Underperformance: graduated scale-down → pause ──────────────────────────
    if (row.roas < policy.roas_floor) {
      const hadPriorSpend = row.spend_prev_cents > 0;
      const secondConsecutiveBad = hadPriorSpend && row.roas_prev < policy.roas_floor;
      const enoughSpend = row.spend_cents >= policy.pause_min_spend_cents;

      if (recentlyScaledUp.has(row.object_id)) {
        // Graduated: a scaled object dropping below floor reverts the step FIRST.
        const target = budget != null ? Math.round(budget * (1 - policy.scale_down_step_pct)) : null;
        emitBudgetChange(
          row,
          "scale_down",
          target,
          `Scale-down: recently scaled up but ${roasLine}; reverting the +${pct(policy.scale_up_step_pct)} step (${pct(policy.scale_down_step_pct)} cut) before any pause.`,
        );
      } else if (secondConsecutiveBad && enoughSpend) {
        // Pause only after a SECOND consecutive bad window, with enough signal.
        if (neverPause.has(row.object_id)) {
          push({
            level: row.level as "adset" | "campaign",
            object_id: row.object_id,
            label: row.label,
            action_type: "pause",
            rationale: `Pause withheld: ${roasLine} for 2 consecutive windows, but object is on the never-pause list. Escalating to the Growth Director.`,
            policy_version_id: policy.id,
            triggering_scorecard_id: row.id,
            before: { budget_cents: budget, status: row.effective_status },
            after: { budget_cents: budget, status: row.effective_status },
            guardrail: "never_pause_list",
          });
        } else {
          push({
            level: row.level as "adset" | "campaign",
            object_id: row.object_id,
            label: row.label,
            action_type: "pause",
            rationale: `Pause: ${roasLine} for 2 consecutive windows with ${dollars(row.spend_cents)} spend (≥ min ${dollars(policy.pause_min_spend_cents)}).`,
            policy_version_id: policy.id,
            triggering_scorecard_id: row.id,
            before: { budget_cents: budget, status: row.effective_status },
            after: { budget_cents: budget, status: "PAUSED" },
          });
        }
      } else if (enoughSpend) {
        // First bad window (or no prior data): scale down, don't pause yet.
        const target = budget != null ? Math.round(budget * (1 - policy.scale_down_step_pct)) : null;
        emitBudgetChange(
          row,
          "scale_down",
          target,
          `Scale-down: ${roasLine} (first bad window); cutting ${pct(policy.scale_down_step_pct)} before considering a pause.`,
        );
      }
      // (insufficient spend → skip; not enough signal to act)
      continue;
    }

    // ── Overperformance: scale up (≤ step cap), unless fatigued ──────────────────
    if (row.roas >= policy.scale_up_roas_trigger) {
      const fatigued = row.fatigue_score >= 0.5 || row.ctr_declining;
      if (fatigued) continue; // don't pour budget into a fatiguing object
      const stepPct = Math.min(policy.scale_up_step_pct, policy.scale_up_cap_pct);
      const target = budget != null ? Math.round(budget * (1 + stepPct)) : null;
      emitBudgetChange(
        row,
        "scale_up",
        target,
        `Scale-up: ${roasLine} ≥ trigger ${policy.scale_up_roas_trigger.toFixed(2)}, not fatigued (fatigue ${row.fatigue_score.toFixed(2)}); +${pct(stepPct)} (capped at ${pct(policy.scale_up_cap_pct)}).`,
      );
    }
  }

  return { actions, escalations };
}

// ── 4b — Approval-gated recommendations (Opus, three personas) ──────────────

interface ProductIntel {
  leadBenefits: { benefit_name: string; customer_phrases: string[] }[];
  activeAngles: { angle_id: string; lead_benefit_anchor: string | null; hook_slug: string | null; times_used: number }[];
}

async function loadProductIntel(workspaceId: string): Promise<ProductIntel> {
  const admin = createAdminClient();
  const [{ data: benefits }, { data: angles }] = await Promise.all([
    admin
      .from("product_benefit_selections")
      .select("benefit_name, customer_phrases")
      .eq("workspace_id", workspaceId)
      .eq("role", "lead")
      .eq("science_confirmed", true),
    admin
      .from("product_ad_angles")
      .select("id, lead_benefit_anchor, hook_slug, times_used")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true),
  ]);
  return {
    leadBenefits: (benefits || [])
      .map((b) => ({
        benefit_name: (b.benefit_name as string | null) || "",
        customer_phrases: Array.isArray(b.customer_phrases) ? (b.customer_phrases as string[]).slice(0, 4) : [],
      }))
      .filter((b) => b.benefit_name),
    activeAngles: (angles || []).map((a) => ({
      angle_id: a.id as string,
      lead_benefit_anchor: (a.lead_benefit_anchor as string | null) ?? null,
      hook_slug: (a.hook_slug as string | null) ?? null,
      times_used: Number(a.times_used ?? 0),
    })),
  };
}

/** Compact, leak-free scorecard context for the LLM (top movers per level). */
function buildScorecardContext(rows: ScorecardRow[]) {
  const byLevel = (lvl: ScorecardLevel) => rows.filter((r) => r.level === lvl);
  const slim = (r: ScorecardRow) => ({
    scorecard_id: r.id,
    object_id: r.object_id,
    label: r.label,
    status: r.effective_status,
    spend: +(r.spend_cents / 100).toFixed(2),
    revenue: +(r.revenue_cents / 100).toFixed(2),
    roas: +r.roas.toFixed(2),
    cvr: +r.cvr.toFixed(4),
    sessions: r.sessions,
    atc_rate: +r.atc_rate.toFixed(4),
    fatigue: +r.fatigue_score.toFixed(2),
    days_live: r.days_live,
    benefit: r.benefit_name ?? r.lead_benefit_anchor ?? null,
    angle_id: r.angle_id,
  });
  const topBy = (lvl: ScorecardLevel, n = 8) =>
    byLevel(lvl)
      .slice()
      .sort((a, b) => b.spend_cents - a.spend_cents)
      .slice(0, n)
      .map(slim);
  return {
    campaigns: topBy("campaign"),
    adsets: topBy("adset", 12),
    variants: topBy("variant"),
    angles: topBy("angle"),
  };
}

const RECOMMENDATION_TYPES: RecommendationType[] = [
  "new_static_adset",
  "new_video_adset",
  "new_campaign",
  "test_benefit_angle",
  "new_lander_variant",
  "offer_test",
];
const PERSONAS: Persona[] = ["direct_response_marketer", "offer_designer", "media_buyer"];

function dedupKeyFor(r: { action_type: string; target_object_id: string | null; params: Record<string, unknown> }): string {
  const sig = Object.keys(r.params)
    .sort()
    .map((k) => `${k}=${JSON.stringify(r.params[k])}`)
    .join("&")
    .slice(0, 200);
  return `${r.action_type}:${r.target_object_id ?? "new"}:${sig}`;
}

/**
 * Generate approval-gated recommendations by reasoning over the scorecards +
 * product intelligence as three personas. NO side effects (read + LLM only).
 * Returns [] on any failure (mirrors the repo's degrade-gracefully convention).
 */
export async function generateRecommendations(
  p: DecisionEngineParams,
  rows: ScorecardRow[],
): Promise<ComputedRecommendation[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];
  if (!rows.length) return [];

  const intel = await loadProductIntel(p.workspaceId);
  const context = buildScorecardContext(rows);
  const validScorecardIds = new Set(rows.map((r) => r.id));

  const prompt = `You are an ad-iteration committee reasoning over real Meta performance + storefront attribution for a DTC superfoods brand. Three personas independently propose NEW live spend lines to test. Each recommendation will be created PAUSED/draft for a human to approve — never goes live automatically.

PERSONAS (attribute each recommendation to exactly one):
- direct_response_marketer: hooks, creative angles, fatigue rotation, winning-creative scaling into new adsets.
- offer_designer: pricing/bundle/guarantee offers worth testing (offer_test).
- media_buyer: account structure — new campaigns/adsets, budget reallocation toward proven angles/variants.

ALLOWED action_type values: ${RECOMMENDATION_TYPES.join(", ")}.

SCORECARDS (trailing-window rollups; money in dollars; cite the scorecard_id(s) you used):
${JSON.stringify(context)}

PRODUCT INTELLIGENCE (science-confirmed lead benefits + active ad angles):
${JSON.stringify(intel)}

Rules:
- Ground every recommendation in specific scorecard numbers (a winning angle to scale, a fatiguing creative to replace, an untested benefit, a weak lander variant).
- test_benefit_angle must reference a real lead benefit and ideally an angle_id.
- new_lander_variant should name a target campaign and an angle.
- Be concrete and bounded: 4-8 high-conviction recommendations total across the three personas. No fluff.

Return ONLY a JSON array (no prose, no markdown fences). Each item:
{"action_type": one of the allowed values,
 "persona": one of [direct_response_marketer, offer_designer, media_buyer],
 "title": short label,
 "rationale": 1-2 sentences citing the numbers,
 "expected_impact": predicted effect,
 "confidence": 0..1,
 "target_object_level": one of [account, campaign, adset, angle, variant] or null,
 "target_object_id": the meta object id / angle uuid / variant slug, or null for net-new,
 "params": object with the fields the executor needs (e.g. {"angle_id":"...","benefit":"...","variant":"advertorial","budget_cents":2000}),
 "source_scorecard_ids": [scorecard_id, ...]}`;

  let text: string;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Opus — strongest reasoning over scorecards × product intelligence × personas.
        model: OPUS_MODEL,
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    text = ((data.content?.[0] as { text?: string })?.text ?? "").trim();
  } catch {
    return [];
  }

  // Parse the JSON array defensively (tolerate stray fences/prose around it).
  let parsed: unknown;
  try {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start < 0 || end <= start) return [];
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ComputedRecommendation[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const action_type = r.action_type as RecommendationType;
    if (!RECOMMENDATION_TYPES.includes(action_type)) continue;
    const persona = (PERSONAS.includes(r.persona as Persona) ? r.persona : "media_buyer") as Persona;
    const params = (r.params && typeof r.params === "object" ? r.params : {}) as Record<string, unknown>;
    const target_object_id = (r.target_object_id as string | null) ?? null;
    const source_scorecard_ids = Array.isArray(r.source_scorecard_ids)
      ? (r.source_scorecard_ids as unknown[]).map(String).filter((id) => validScorecardIds.has(id))
      : [];
    const confidence = Math.max(0, Math.min(1, Number(r.confidence ?? 0.5)));
    out.push({
      action_type,
      persona,
      title: String(r.title ?? action_type).slice(0, 200),
      rationale: String(r.rationale ?? "").slice(0, 2000),
      source_metrics: { cited_scorecard_ids: source_scorecard_ids },
      expected_impact: String(r.expected_impact ?? "").slice(0, 1000),
      confidence,
      target_object_level: (r.target_object_level as ComputedRecommendation["target_object_level"]) ?? null,
      target_object_id,
      params,
      source_scorecard_ids,
      dedup_key: dedupKeyFor({ action_type, target_object_id, params }),
    });
  }
  return out;
}

/** Idempotent persist into `iteration_recommendations` (status='pending'). */
export async function persistRecommendations(
  p: DecisionEngineParams,
  snapshotDate: string,
  recs: ComputedRecommendation[],
): Promise<number> {
  if (!recs.length) return 0;
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const records = recs.map((r) => ({
    workspace_id: p.workspaceId,
    meta_ad_account_id: p.adAccountId,
    snapshot_date: snapshotDate,
    action_type: r.action_type,
    status: "pending",
    persona: r.persona,
    title: r.title,
    rationale: r.rationale,
    source_metrics: r.source_metrics,
    expected_impact: r.expected_impact,
    confidence: r.confidence,
    target_object_level: r.target_object_level,
    target_object_id: r.target_object_id,
    params: r.params,
    source_scorecard_ids: r.source_scorecard_ids,
    dedup_key: r.dedup_key,
    updated_at: now,
  }));
  let persisted = 0;
  for (let i = 0; i < records.length; i += 200) {
    const chunk = records.slice(i, i + 200);
    const { error } = await admin
      .from("iteration_recommendations")
      .upsert(chunk, {
        onConflict: "workspace_id,meta_ad_account_id,snapshot_date,action_type,dedup_key",
        ignoreDuplicates: false,
      });
    if (!error) persisted += chunk.length;
  }
  return persisted;
}

/**
 * Append/update the autonomous decisions into the Phase 4c `iteration_actions`
 * ledger — the engine's audit/idempotency/reversal substrate. Decided actions
 * land `status='decided'` (Phase 6a flips them to `executed`/`failed`);
 * escalations (guardrail hits) land `status='escalated'` with the `guardrail`
 * that fired — flagged for the Growth Director, never executed.
 *
 * Idempotent: upsert on `(workspace_id, meta_ad_account_id, object_id,
 * action_type, snapshot_date)`, so a cron re-run on the same day re-upserts
 * rather than double-acting. The engine only ever appends/updates this table —
 * it never writes `iteration_policies`. NO Meta side effects (Phase 6a executes).
 *
 * NOT called by `runDecisionEngine` (Phase 4 has zero side effects); the Phase 5
 * cron persists decisions after the engine returns them.
 */
export async function persistActions(
  p: DecisionEngineParams,
  snapshotDate: string,
  actions: ComputedAction[],
  escalations: ComputedAction[] = [],
): Promise<number> {
  const all = [
    ...actions.map((a) => ({ a, status: "decided" as const })),
    ...escalations.map((a) => ({ a, status: "escalated" as const })),
  ];
  if (!all.length) return 0;
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const records = all.map(({ a, status }) => ({
    workspace_id: p.workspaceId,
    meta_ad_account_id: p.adAccountId,
    snapshot_date: snapshotDate,
    level: a.level,
    object_id: a.object_id,
    label: a.label,
    action_type: a.action_type,
    rationale: a.rationale,
    policy_version_id: a.policy_version_id,
    triggering_scorecard_id: a.triggering_scorecard_id,
    before_budget_cents: a.before.budget_cents,
    before_status: a.before.status,
    after_budget_cents: a.after.budget_cents,
    after_status: a.after.status,
    status,
    guardrail: a.guardrail ?? null,
    updated_at: now,
  }));
  let persisted = 0;
  for (let i = 0; i < records.length; i += 200) {
    const chunk = records.slice(i, i + 200);
    const { error } = await admin
      .from("iteration_actions")
      .upsert(chunk, {
        onConflict: "workspace_id,meta_ad_account_id,object_id,action_type,snapshot_date",
        ignoreDuplicates: false,
      });
    if (!error) persisted += chunk.length;
  }
  return persisted;
}

// ── Orchestration ─────────────────────────────────────────────────────────────

const ZERO_COUNTS = (): Record<AutonomousActionType, number> => ({
  pause: 0,
  unpause: 0,
  scale_up: 0,
  scale_down: 0,
  replenish_creative: 0,
});

/**
 * Run the decision engine for one account as-of `snapshotDate`:
 *  1. read the latest scorecards (Phase 3 — metrics source of truth),
 *  2. read the active policy (4c, read-only) — null ⇒ zero autonomous actions,
 *  3. compute 4a autonomous actions (no Meta writes — Phase 6a executes),
 *  4. generate + persist 4b recommendations (drafts, status='pending').
 *
 * 4a actions are returned + logged; persistence to `iteration_actions` + Meta
 * execution land in Phase 4c/5/6 (the table doesn't exist in Phase 4). No external
 * (Meta) side effects occur here.
 */
export async function runDecisionEngine(
  p: DecisionEngineParams,
  opts?: {
    snapshotDate?: string;
    /**
     * Phase 5 noise floors. When set, objects below the threshold are skipped for
     * BOTH 4a autonomous actions and 4b recommendations — not enough signal to act
     * on. `minSpendCents` gates ad/adset/campaign rows (trailing-window spend);
     * `minSessions` gates variant rows (trailing-window sessions). Undefined ⇒ no
     * filter (preserves the Phase 4 behavior).
     */
    minSpendCents?: number;
    minSessions?: number;
  },
): Promise<DecisionEngineResult> {
  const admin = createAdminClient();

  // Resolve the snapshot date: caller's, else the latest scorecard day for this account.
  let snapshotDate = opts?.snapshotDate;
  if (!snapshotDate) {
    const { data } = await admin
      .from("iteration_scorecards_daily")
      .select("snapshot_date")
      .eq("meta_ad_account_id", p.adAccountId)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    snapshotDate = (data?.snapshot_date as string | undefined) ?? dayStr(new Date());
  }

  const allRows = await fetchAllRows<ScorecardRow>(() =>
    admin
      .from("iteration_scorecards_daily")
      .select(
        "id, level, object_id, label, effective_status, parent_campaign_id, snapshot_date, window_days, spend_cents, revenue_cents, roas, roas_prev, spend_prev_cents, ctr_declining, frequency_rising, fatigue_score, creatives_live, days_live, cvr, sessions, atc_rate, angle_id, lead_benefit_anchor, benefit_name",
      )
      .eq("meta_ad_account_id", p.adAccountId)
      .eq("snapshot_date", snapshotDate)
      .order("object_id", { ascending: true }),
  );

  // ── Phase 5 noise floors — skip objects below the min spend / min sessions
  // thresholds for BOTH autonomous actions and recommendations. Undefined ⇒ keep.
  const { minSpendCents, minSessions } = opts ?? {};
  const passesThreshold = (r: ScorecardRow) => {
    if (
      minSpendCents != null &&
      (r.level === "ad" || r.level === "adset" || r.level === "campaign") &&
      r.spend_cents < minSpendCents
    ) {
      return false;
    }
    if (minSessions != null && r.level === "variant" && r.sessions < minSessions) return false;
    return true;
  };
  const actionableRows = allRows.filter(passesThreshold);

  // ── 4a — autonomous actions (only when a policy is active) ────────────────────
  const policy = await loadActivePolicy(p.workspaceId, p.adAccountId);
  let actions: ComputedAction[] = [];
  let escalations: ComputedAction[] = [];
  const counts = ZERO_COUNTS();

  if (policy) {
    const adsetCampaignRows = actionableRows.filter((r) => r.level === "adset" || r.level === "campaign");
    const budgets = await loadBudgets(p.adAccountId, adsetCampaignRows);
    const lookbackDays = Math.max(policy.unpause_lookback_days, Math.ceil(policy.per_object_cooldown_hours / 24), 7);
    const recentActions = await loadRecentActions(
      p.workspaceId,
      p.adAccountId,
      new Date(Date.now() - lookbackDays * 86400_000).toISOString(),
    );
    const res = computeAutonomousActions({
      rows: adsetCampaignRows,
      policy,
      budgets,
      recentActions,
      nowMs: Date.now(),
    });
    actions = res.actions;
    escalations = res.escalations;
    for (const a of actions) counts[a.action_type] += 1;
  }

  // ── 4b — recommendations (always; zero external side effects) ─────────────────
  const recs = await generateRecommendations(p, actionableRows);
  const persisted = await persistRecommendations(p, snapshotDate, recs);
  const byType: Partial<Record<RecommendationType, number>> = {};
  const byPersona: Partial<Record<Persona, number>> = {};
  for (const r of recs) {
    byType[r.action_type] = (byType[r.action_type] ?? 0) + 1;
    byPersona[r.persona] = (byPersona[r.persona] ?? 0) + 1;
  }

  return {
    snapshotDate,
    policy_active: !!policy,
    policy_version_id: policy?.id ?? null,
    autonomous: { actions, escalations, counts },
    recommendations: { generated: recs.length, persisted, byType, byPersona },
  };
}

/** Load adset/campaign budgets (prefer daily; fall back to lifetime) from structure. */
async function loadBudgets(
  adAccountId: string,
  rows: ScorecardRow[],
): Promise<Map<string, number | null>> {
  const admin = createAdminClient();
  const out = new Map<string, number | null>();
  const adsetIds = rows.filter((r) => r.level === "adset").map((r) => r.object_id);
  const campIds = rows.filter((r) => r.level === "campaign").map((r) => r.object_id);

  if (adsetIds.length) {
    const { data } = await admin
      .from("meta_adsets")
      .select("meta_adset_id, daily_budget_cents, lifetime_budget_cents")
      .eq("meta_ad_account_id", adAccountId)
      .in("meta_adset_id", adsetIds);
    for (const r of (data || []) as { meta_adset_id: string; daily_budget_cents: number | null; lifetime_budget_cents: number | null }[]) {
      out.set(r.meta_adset_id, r.daily_budget_cents ?? r.lifetime_budget_cents ?? null);
    }
  }
  if (campIds.length) {
    const { data } = await admin
      .from("meta_campaigns")
      .select("meta_campaign_id, daily_budget_cents, lifetime_budget_cents")
      .eq("meta_ad_account_id", adAccountId)
      .in("meta_campaign_id", campIds);
    for (const r of (data || []) as { meta_campaign_id: string; daily_budget_cents: number | null; lifetime_budget_cents: number | null }[]) {
      out.set(r.meta_campaign_id, r.daily_budget_cents ?? r.lifetime_budget_cents ?? null);
    }
  }
  return out;
}
