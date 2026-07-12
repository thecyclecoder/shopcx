/**
 * Autonomous execution adapters — Storefront Iteration Engine Phase 6a.
 *
 * The EXECUTOR half of the engine: it takes the `status='decided'` rows the
 * decision engine wrote to `iteration_actions` (Phase 4a decided → Phase 5 cron
 * persisted) and applies them to Meta — manage EXISTING live objects only:
 *
 *   pause / unpause   → Graph status flip on the adset/campaign
 *   scale_up / scale_down → Graph budget update (same field the object already uses)
 *   replenish_creative → deferred (needs creative selection; see ENABLED set)
 *
 * Bounded entirely by the active policy + ledger that produced the decided rows:
 * the decision engine already enforced policy, cooldown, the per-account
 * budget-delta ceiling, and the noise floors, and persisted guardrail hits as
 * `status='escalated'` (NEVER touched here). This layer only executes rows that
 * are already `decided`. It NEVER sets ACTIVE on a draft/new object and NEVER
 * creates a new live spend line — those are draft-only (Phase 6b).
 *
 * Idempotency: only `status='decided'` rows are executed; a successful apply flips
 * the row to `executed` (with `external_result` + `executed_at`), a failure to
 * `failed`. A cron re-run on the same day therefore never double-applies — the
 * row is no longer `decided`. Ship one action type at a time: `ENABLED_ADAPTERS`
 * is the explicit allow-list (each verified before the next is enabled).
 *
 * Self-correction: a scaled-up object that drops below the ROAS floor gets a
 * `scale_down` decided on the next run (graduated failure in the decision engine);
 * executing it here reverts the spend — the engine self-corrects in production.
 *
 * See docs/brain/specs/storefront-iteration-engine.md (Phase 6a).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getMetaUserToken, updateObjectStatus, updateObjectBudget } from "@/lib/meta-ads";
import type { AutonomousActionType } from "@/lib/meta/decision-engine";
import { isEffectivelyEnabled } from "@/lib/control-tower/legacy-switch-compat";

/**
 * The action types whose autonomous adapter is enabled. Spec mandate: "ship
 * execution adapters one action type at a time, each verified before the next is
 * enabled." `replenish_creative` is intentionally NOT enabled yet (it needs
 * proven-vs-new creative selection — Phase 6b's generative path); its decided
 * rows are left untouched (`status='decided'`) until its adapter ships.
 */
export const ENABLED_ADAPTERS: ReadonlySet<AutonomousActionType> = new Set<AutonomousActionType>([
  "pause",
  "unpause",
  "scale_up",
  "scale_down",
]);

/**
 * migrate-ad-hoc-kill-switches-to-resolver Phase 1 — union check that wraps the legacy
 * `ENABLED_ADAPTERS` set with a resolver read. An action_type is enabled ONLY IF (a) it is in
 * the ad-hoc `ENABLED_ADAPTERS` set AND (b) the `media-buyer` cascade is ON. Any growth /
 * media-buyer / department-scope kill_switches row flips the answer to disabled — the ad-hoc set
 * and the cascade both authorize.
 */
export async function isMetaExecutionAdapterEnabled(
  action_type: AutonomousActionType,
): Promise<boolean> {
  const legacyFn = async (): Promise<boolean | undefined> => ENABLED_ADAPTERS.has(action_type);
  return isEffectivelyEnabled("media-buyer", legacyFn);
}

export interface ExecutionParams {
  workspaceId: string;
  adAccountId: string; // our DB uuid for meta_ad_accounts
}

interface DecidedAction {
  id: string;
  level: "adset" | "campaign";
  object_id: string;
  action_type: AutonomousActionType;
  after_budget_cents: number | null;
}

export interface ExecutionResult {
  executed: number;
  failed: number;
  skipped: number; // decided rows whose adapter is not enabled yet
  byType: Partial<Record<AutonomousActionType, { executed: number; failed: number; skipped: number }>>;
}

/**
 * Execute the decided autonomous actions for one account as-of `snapshotDate`.
 * Reads `iteration_actions` (status='decided'), applies each via the Graph, and
 * writes the result back onto the row. Returns per-type counts. No-op (returns
 * zeroes) when there's no Meta token or no decided rows.
 */
export async function executeAutonomousActions(
  p: ExecutionParams,
  snapshotDate: string,
): Promise<ExecutionResult> {
  const admin = createAdminClient();
  const result: ExecutionResult = { executed: 0, failed: 0, skipped: 0, byType: {} };

  const { data: rows } = await admin
    .from("iteration_actions")
    .select("id, level, object_id, action_type, after_budget_cents")
    .eq("workspace_id", p.workspaceId)
    .eq("meta_ad_account_id", p.adAccountId)
    .eq("snapshot_date", snapshotDate)
    .eq("status", "decided");
  const decided = (rows || []) as DecidedAction[];
  if (!decided.length) return result;

  const token = await getMetaUserToken(p.workspaceId);
  if (!token) return result; // no token → leave rows decided for a later run (no failure noise)

  // Resolve which budget field each scale target uses (daily vs lifetime) so a
  // budget update writes back to the SAME field Meta already reads from.
  const budgetField = await loadBudgetFields(p.adAccountId, decided);

  const bump = (t: AutonomousActionType, k: "executed" | "failed" | "skipped") => {
    const e = (result.byType[t] ??= { executed: 0, failed: 0, skipped: 0 });
    e[k] += 1;
    result[k] += 1;
  };

  for (const a of decided) {
    if (!(await isMetaExecutionAdapterEnabled(a.action_type))) {
      bump(a.action_type, "skipped"); // adapter not shipped yet OR resolver cascade OFF — leave row 'decided'
      continue;
    }
    try {
      const external_result = await applyAction(token, a, budgetField.get(a.object_id) ?? "daily");
      await admin
        .from("iteration_actions")
        .update({
          status: "executed",
          external_result,
          executed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", a.id)
        .eq("status", "decided"); // guard: only flip if still decided (re-run safety)
      bump(a.action_type, "executed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await admin
        .from("iteration_actions")
        .update({
          status: "failed",
          external_result: { error: message.slice(0, 500) },
          updated_at: new Date().toISOString(),
        })
        .eq("id", a.id)
        .eq("status", "decided");
      bump(a.action_type, "failed");
    }
  }

  return result;
}

/** Apply one decided action to Meta. Returns the Graph response for `external_result`. */
async function applyAction(
  token: string,
  a: DecidedAction,
  field: "daily" | "lifetime",
): Promise<Record<string, unknown>> {
  switch (a.action_type) {
    case "pause": {
      const res = await updateObjectStatus(token, a.object_id, "PAUSED");
      return { meta_object_id: a.object_id, applied_status: "PAUSED", graph_response: res };
    }
    case "unpause": {
      const res = await updateObjectStatus(token, a.object_id, "ACTIVE");
      return { meta_object_id: a.object_id, applied_status: "ACTIVE", graph_response: res };
    }
    case "scale_up":
    case "scale_down": {
      if (a.after_budget_cents == null) {
        // CBO/ABO crossover: no resolvable budget object — flag rather than guess.
        throw new Error("no_budget_to_set (after_budget_cents null — CBO/ABO crossover)");
      }
      const res = await updateObjectBudget(token, a.object_id, {
        dailyBudgetCents: field === "daily" ? a.after_budget_cents : null,
        lifetimeBudgetCents: field === "lifetime" ? a.after_budget_cents : null,
      });
      return {
        meta_object_id: a.object_id,
        applied_budget_cents: a.after_budget_cents,
        budget_field: field,
        graph_response: res,
      };
    }
    default:
      throw new Error(`adapter_not_implemented:${a.action_type}`);
  }
}

/** object_id → which budget field it uses ('daily' unless only lifetime is set). */
async function loadBudgetFields(
  adAccountId: string,
  actions: DecidedAction[],
): Promise<Map<string, "daily" | "lifetime">> {
  const admin = createAdminClient();
  const out = new Map<string, "daily" | "lifetime">();
  const adsetIds = actions.filter((a) => a.level === "adset").map((a) => a.object_id);
  const campIds = actions.filter((a) => a.level === "campaign").map((a) => a.object_id);

  if (adsetIds.length) {
    const { data } = await admin
      .from("meta_adsets")
      .select("meta_adset_id, daily_budget_cents, lifetime_budget_cents")
      .eq("meta_ad_account_id", adAccountId)
      .in("meta_adset_id", adsetIds);
    for (const r of (data || []) as { meta_adset_id: string; daily_budget_cents: number | null; lifetime_budget_cents: number | null }[]) {
      out.set(r.meta_adset_id, r.daily_budget_cents == null && r.lifetime_budget_cents != null ? "lifetime" : "daily");
    }
  }
  if (campIds.length) {
    const { data } = await admin
      .from("meta_campaigns")
      .select("meta_campaign_id, daily_budget_cents, lifetime_budget_cents")
      .eq("meta_ad_account_id", adAccountId)
      .in("meta_campaign_id", campIds);
    for (const r of (data || []) as { meta_campaign_id: string; daily_budget_cents: number | null; lifetime_budget_cents: number | null }[]) {
      out.set(r.meta_campaign_id, r.daily_budget_cents == null && r.lifetime_budget_cents != null ? "lifetime" : "daily");
    }
  }
  return out;
}
