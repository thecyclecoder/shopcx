/**
 * cs-director-playbook-tier-eligibility — the read-only evaluator June's cs-director-call runner
 * consults BEFORE emitting `escalate_founder` on an out-of-policy refund/return.
 *
 * Implements docs/brain/specs/cs-director-treats-tier-eligible-out-of-policy-refund-as-playbook-
 * offer-not-escalation.md Phase 1. Motivating case: ticket 87ce35a1 — LTV $1,569, 19 orders, no
 * disqualifier — was escalated to the founder as an out-of-policy refund even though the Refund
 * playbook's Tier-1/Tier-2 exceptions are designed for exactly that high-LTV/tenured customer. If
 * the customer clears a tier and hits no disqualifier, the correct verdict is `approve_remedy`
 * routing back into the playbook's `offer_exception` step — the sanctioned save — NOT
 * `escalate_founder`.
 *
 * Design shape follows the `north star (supervisable autonomy)` [[../../docs/brain/operational-rules]]:
 * this module NEVER mutates — it reads the playbook rows + customer stats + disqualifier signals and
 * emits a structured eligibility snapshot. The runner bakes the snapshot into June's brief; the
 * skill's prompt tells June to consult it before escalating. Thresholds + disqualifier types are
 * pulled from the `playbook` / `playbook_exceptions` rows verbatim — NEVER hardcoded (spec § Phase
 * 1: "Pull the tier thresholds + disqualifiers from the playbook/playbook_exceptions rows (do not
 * hardcode)").
 *
 * The pure evaluator (`evaluatePlaybookTiers` + `customerMatchesConditions`) is unit-tested against
 * a fixture mirroring ticket 87ce35a1 in
 * [[./cs-director-playbook-tier-eligibility.test]]; the DB loader (`loadPlaybookTierEligibility`)
 * is best-effort — a query failure returns `[]` so June's brief still renders without the tier
 * section rather than dropping the whole call.
 */

import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface CustomerTierStats {
  ltv_cents: number;
  total_orders: number;
  retention_score: number;
}

export interface DisqualifierState {
  previous_exception: boolean;
  has_chargeback: boolean;
  has_chargeback_on_order: boolean;
}

export interface PlaybookExceptionRow {
  id: string;
  playbook_id: string;
  tier: number;
  name: string;
  conditions: Record<string, unknown>;
  resolution_type: string;
  instructions: string | null;
}

export interface PlaybookRow {
  id: string;
  name: string;
  trigger_intents: string[] | null;
  is_active: boolean;
  exception_disqualifiers: Array<{ type: string; source?: string; blocks?: string }> | null;
}

export interface TierEvaluation {
  playbook_id: string;
  playbook_name: string;
  tier: number;
  exception_name: string;
  resolution_type: string;
  criteria_str: string;
  customer_matches: boolean;
  matches_why: string;
}

export interface PlaybookTierEligibility {
  playbook_id: string;
  playbook_name: string;
  trigger_intents: string[];
  matched_tiers: TierEvaluation[];
  unmatched_tiers: TierEvaluation[];
  disqualifiers_active: string[];
  eligible_for_offer: boolean;
}

/**
 * PURE evaluator — does the customer clear the condition tree the playbook exception carries?
 * Mirrors `playbook-executor.ts` § evaluateCustomerConditions (top-level OR + per-key `>=` / `<=`)
 * so June's brief describes the SAME predicate the playbook executor enforces at runtime — never
 * a paraphrase that could drift.
 */
export function customerMatchesConditions(
  conditions: Record<string, unknown> | null | undefined,
  stats: CustomerTierStats,
): { matches: boolean; why: string } {
  if (!conditions || Object.keys(conditions).length === 0) {
    return { matches: true, why: "(no thresholds)" };
  }
  if (Array.isArray(conditions.or)) {
    const results = (conditions.or as Record<string, unknown>[]).map((c) => customerMatchesConditions(c, stats));
    const first = results.find((r) => r.matches);
    if (first) return { matches: true, why: first.why };
    return { matches: false, why: results.map((r) => r.why).join(" OR ") };
  }
  const parts: string[] = [];
  let matches = true;
  for (const [key, rule] of Object.entries(conditions)) {
    if (key === "or") continue;
    const r = rule as Record<string, unknown>;
    if (key === "ltv_cents") {
      const gte = r[">="] != null ? Number(r[">="]) : null;
      const lte = r["<="] != null ? Number(r["<="]) : null;
      if (gte != null) {
        const ok = stats.ltv_cents >= gte;
        parts.push(`LTV $${(stats.ltv_cents / 100).toFixed(2)} ${ok ? "≥" : "<"} $${(gte / 100).toFixed(2)}`);
        if (!ok) matches = false;
      }
      if (lte != null) {
        const ok = stats.ltv_cents <= lte;
        parts.push(`LTV $${(stats.ltv_cents / 100).toFixed(2)} ${ok ? "≤" : ">"} $${(lte / 100).toFixed(2)}`);
        if (!ok) matches = false;
      }
    } else if (key === "total_orders") {
      const gte = r[">="] != null ? Number(r[">="]) : null;
      const lte = r["<="] != null ? Number(r["<="]) : null;
      if (gte != null) {
        const ok = stats.total_orders >= gte;
        parts.push(`${stats.total_orders} orders ${ok ? "≥" : "<"} ${gte}`);
        if (!ok) matches = false;
      }
      if (lte != null) {
        const ok = stats.total_orders <= lte;
        parts.push(`${stats.total_orders} orders ${ok ? "≤" : ">"} ${lte}`);
        if (!ok) matches = false;
      }
    } else if (key === "retention_score") {
      const gte = r[">="] != null ? Number(r[">="]) : null;
      if (gte != null) {
        const ok = stats.retention_score >= gte;
        parts.push(`retention ${stats.retention_score} ${ok ? "≥" : "<"} ${gte}`);
        if (!ok) matches = false;
      }
    }
  }
  return { matches, why: parts.join(" AND ") || "(no thresholds)" };
}

/** PURE — describe a condition tree in the brief as `LTV ≥ $300 OR orders ≥ 3`. */
export function describeConditions(conditions: Record<string, unknown> | null | undefined): string {
  if (!conditions || Object.keys(conditions).length === 0) return "(no thresholds)";
  if (Array.isArray(conditions.or)) {
    return (conditions.or as Record<string, unknown>[]).map(describeConditions).join(" OR ");
  }
  const parts: string[] = [];
  for (const [key, rule] of Object.entries(conditions)) {
    if (key === "or") continue;
    const r = rule as Record<string, unknown>;
    if (key === "ltv_cents") {
      if (r[">="] != null) parts.push(`LTV ≥ $${(Number(r[">="]) / 100).toFixed(2)}`);
      if (r["<="] != null) parts.push(`LTV ≤ $${(Number(r["<="]) / 100).toFixed(2)}`);
    } else if (key === "total_orders") {
      if (r[">="] != null) parts.push(`orders ≥ ${r[">="]}`);
      if (r["<="] != null) parts.push(`orders ≤ ${r["<="]}`);
    } else if (key === "retention_score" && r[">="] != null) {
      parts.push(`retention ≥ ${r[">="]}`);
    } else {
      parts.push(`${key}=${JSON.stringify(r)}`);
    }
  }
  return parts.length ? parts.join(" AND ") : "(no thresholds)";
}

/**
 * PURE — given ONE playbook row + its (tier > 0, auto_grant=false) exception rows + the customer's
 * stats + disqualifier state, return a per-playbook eligibility snapshot. `eligible_for_offer` is
 * TRUE only when the customer clears ≥1 tier AND no disqualifier the playbook declares is active.
 */
export function evaluatePlaybookTiers(
  playbook: PlaybookRow,
  exceptions: PlaybookExceptionRow[],
  stats: CustomerTierStats,
  disqualifiers: DisqualifierState,
): PlaybookTierEligibility {
  const matched: TierEvaluation[] = [];
  const unmatched: TierEvaluation[] = [];
  const tierExceptions = exceptions
    .filter((e) => e.tier > 0)
    .sort((a, b) => a.tier - b.tier);
  for (const ex of tierExceptions) {
    const { matches, why } = customerMatchesConditions(ex.conditions ?? {}, stats);
    const criteria_str = describeConditions(ex.conditions ?? {});
    const row: TierEvaluation = {
      playbook_id: playbook.id,
      playbook_name: playbook.name,
      tier: ex.tier,
      exception_name: ex.name,
      resolution_type: ex.resolution_type,
      criteria_str,
      customer_matches: matches,
      matches_why: why,
    };
    (matches ? matched : unmatched).push(row);
  }
  const disqReasons: string[] = [];
  for (const d of playbook.exception_disqualifiers ?? []) {
    if (d.type === "previous_exception" && disqualifiers.previous_exception) {
      disqReasons.push("previous_exception (prior playbook return on record)");
    } else if (d.type === "has_chargeback" && disqualifiers.has_chargeback) {
      disqReasons.push("has_chargeback (customer has filed a chargeback)");
    } else if (d.type === "has_chargeback_on_order" && disqualifiers.has_chargeback_on_order) {
      disqReasons.push("has_chargeback_on_order (chargeback on one of the customer's orders)");
    }
  }
  return {
    playbook_id: playbook.id,
    playbook_name: playbook.name,
    trigger_intents: playbook.trigger_intents ?? [],
    matched_tiers: matched,
    unmatched_tiers: unmatched,
    disqualifiers_active: disqReasons,
    eligible_for_offer: matched.length > 0 && disqReasons.length === 0,
  };
}

/** DB-touching best-effort loader — reads playbooks + exceptions + customer stats + disqualifier
 *  signals for the workspace/customer and evaluates each active playbook. Returns [] on failure or
 *  when there's no customer_id (a ticket without a linked customer can't have tier eligibility). */
export async function loadPlaybookTierEligibility(
  admin: Admin,
  workspaceId: string,
  customerId: string | null,
): Promise<{ evaluations: PlaybookTierEligibility[]; stats: CustomerTierStats | null }> {
  if (!customerId) return { evaluations: [], stats: null };
  try {
    const [playbooksRes, stats, disqualifiers] = await Promise.all([
      admin
        .from("playbooks")
        .select("id, name, trigger_intents, is_active, exception_disqualifiers")
        .eq("workspace_id", workspaceId)
        .eq("is_active", true),
      loadCustomerTierStats(admin, customerId),
      loadDisqualifierState(admin, workspaceId, customerId),
    ]);
    const playbooks = (playbooksRes.data as PlaybookRow[] | null) ?? [];
    if (!playbooks.length) return { evaluations: [], stats };
    const playbookIds = playbooks.map((p) => p.id);
    const { data: exceptions } = await admin
      .from("playbook_exceptions")
      .select("id, playbook_id, tier, name, conditions, resolution_type, instructions, auto_grant")
      .eq("workspace_id", workspaceId)
      .in("playbook_id", playbookIds)
      .eq("auto_grant", false);
    const byPlaybook = new Map<string, PlaybookExceptionRow[]>();
    for (const e of (exceptions ?? []) as PlaybookExceptionRow[]) {
      const arr = byPlaybook.get(e.playbook_id) ?? [];
      arr.push(e);
      byPlaybook.set(e.playbook_id, arr);
    }
    const evaluations = playbooks.map((pb) =>
      evaluatePlaybookTiers(pb, byPlaybook.get(pb.id) ?? [], stats, disqualifiers),
    );
    return { evaluations, stats };
  } catch {
    return { evaluations: [], stats: null };
  }
}

/**
 * PURE — render the eligibility snapshot as the brief section June sees. Followed by the
 * `RULE` line the skill's prompt cites as the tier-ladder-before-escalation policy.
 */
export function formatPlaybookTierBrief(
  evaluations: PlaybookTierEligibility[],
  stats: CustomerTierStats | null,
): string {
  const lines: string[] = [];
  lines.push("");
  if (!stats) {
    lines.push("PLAYBOOK EXCEPTION-TIER ELIGIBILITY: no linked customer — tier evaluation skipped.");
    return lines.join("\n");
  }
  lines.push(
    `PLAYBOOK EXCEPTION-TIER ELIGIBILITY (LTV $${(stats.ltv_cents / 100).toFixed(2)} · ${stats.total_orders} orders · retention ${stats.retention_score}):`,
  );
  if (evaluations.length === 0) {
    lines.push("  (no active playbooks with tier exceptions loaded for this workspace)");
  } else {
    for (const p of evaluations) {
      const intents = p.trigger_intents.length ? ` [intents: ${p.trigger_intents.join(", ")}]` : "";
      lines.push(
        `  playbook "${p.playbook_name}"${intents} — eligible_for_offer=${p.eligible_for_offer}`,
      );
      for (const t of p.matched_tiers) {
        lines.push(
          `    ✅ Tier ${t.tier} "${t.exception_name}" → ${t.resolution_type} — ${t.criteria_str} · ${t.matches_why}`,
        );
      }
      for (const t of p.unmatched_tiers) {
        lines.push(
          `    ✗ Tier ${t.tier} "${t.exception_name}" → ${t.resolution_type} — ${t.criteria_str} · ${t.matches_why}`,
        );
      }
      if (p.disqualifiers_active.length) {
        lines.push(`    ⛔ disqualifiers active: ${p.disqualifiers_active.join("; ")}`);
      } else {
        lines.push(`    ✔ no disqualifiers active`);
      }
    }
  }
  lines.push("");
  lines.push(
    "RULE (docs/brain/specs/cs-director-treats-tier-eligible-out-of-policy-refund-as-playbook-offer-not-escalation): an out-of-policy refund/return from a customer with eligible_for_offer=true on the matching playbook is a Tier-1/Tier-2 SAVE — approve_remedy routing back into the playbook's offer_exception step, NOT escalate_founder. escalate_founder is reserved for: clears NO tier, a disqualifier applies, or a genuine policy/authority gap the playbook can't resolve.",
  );
  return lines.join("\n");
}

async function loadCustomerTierStats(admin: Admin, customerId: string): Promise<CustomerTierStats> {
  const { getCustomerStats } = await import("@/lib/customer-stats");
  const stats = await getCustomerStats(customerId);
  const { data: c } = await admin
    .from("customers")
    .select("retention_score")
    .eq("id", customerId)
    .maybeSingle();
  return {
    ltv_cents: stats.ltv_cents,
    total_orders: stats.total_orders,
    retention_score: c?.retention_score ?? 0,
  };
}

async function loadDisqualifierState(
  admin: Admin,
  workspaceId: string,
  customerId: string,
): Promise<DisqualifierState> {
  const linkedIds = [customerId];
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (link?.group_id) {
    const { data: grp } = await admin
      .from("customer_links")
      .select("customer_id")
      .eq("group_id", link.group_id);
    for (const g of grp || []) {
      if (!linkedIds.includes(g.customer_id)) linkedIds.push(g.customer_id);
    }
  }
  const [returnsRes, chargebackRes] = await Promise.all([
    admin
      .from("returns")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .in("customer_id", linkedIds)
      .eq("source", "playbook")
      .not("status", "eq", "cancelled"),
    admin
      .from("chargeback_events")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .in("customer_id", linkedIds),
  ]);
  const chargebackCount = chargebackRes.count ?? 0;
  return {
    previous_exception: (returnsRes.count ?? 0) > 0,
    has_chargeback: chargebackCount > 0,
    // Conservative: any chargeback the customer has filed is by definition on one of their orders,
    // so `has_chargeback_on_order` mirrors `has_chargeback` at the brief-level. The per-order gate
    // (identified_order-specific) still runs at execution time in playbook-executor.ts.
    has_chargeback_on_order: chargebackCount > 0,
  };
}
