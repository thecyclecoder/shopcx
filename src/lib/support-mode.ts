import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Per-workspace support mode (see docs/brain/libraries/support-mode.md).
 *
 * 'cpg'      — the default CPG shopper pipeline (bucket classifier, journeys/playbooks,
 *              fraud gate, order auto-link, Sol first-touch, Appstle/Shopify actions).
 *              Superfoods and every existing workspace stay on this and are untouched.
 * 'software' — merchant (software) support: the ticket handler goes straight to the Sonnet
 *              orchestrator and the action executor refuses every CPG action.
 */
export type SupportMode = "cpg" | "software";

export function isSoftwareMode(m: SupportMode): boolean {
  return m === "software";
}

/**
 * Should the unified ticket handler run the CPG pipeline steps (bucket classifier, early-pattern
 * journey/playbook/workflow match, active playbook, fraud gate, order auto-link, Sol first-touch,
 * Sol direction-apply, intent→playbook router)? Only in 'cpg' mode. In 'software' mode the handler
 * skips straight to the Sonnet orchestrator. Pure predicate so the handler branch is unit-testable.
 */
export function shouldRunCpgSteps(mode: SupportMode): boolean {
  return mode === "cpg";
}

/** CPG action types the executor dispatches to Appstle/Shopify/order/subscription/journey code. */
const CPG_ACTION_TYPES: ReadonlySet<string> = new Set([
  "direct_action",
  "journey",
  "playbook",
  "workflow",
]);

/**
 * May the action executor dispatch `actionType` in `mode`? In 'cpg' every action is allowed. In
 * 'software' the CPG action types (direct_action | journey | playbook | workflow) are refused — the
 * handler escalates instead. ai_response / kb_response / escalate (and the software-mode toolset
 * actions, which are not in CPG_ACTION_TYPES) are always allowed. Pure predicate so the executor's
 * hard guard is unit-testable.
 */
export function isActionAllowedInMode(mode: SupportMode, actionType: string): boolean {
  if (mode === "cpg") return true;
  return !CPG_ACTION_TYPES.has(actionType);
}

// Short in-memory cache: support_mode changes rarely, and any read failure must degrade to
// 'cpg' so a transient DB error can never flip Superfoods into the software path.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { mode: SupportMode; at: number }>();

// Monotonic clock only — Date.now() is unavailable in some harness contexts and we only need
// relative TTL comparisons, which performance.now() gives us.
function nowMs(): number {
  return performance.now();
}

export async function getSupportMode(workspaceId: string): Promise<SupportMode> {
  if (!workspaceId) return "cpg";

  const hit = cache.get(workspaceId);
  if (hit && nowMs() - hit.at < CACHE_TTL_MS) return hit.mode;

  let mode: SupportMode = "cpg";
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("workspaces")
      .select("support_mode")
      .eq("id", workspaceId)
      .maybeSingle();

    // Any error or null reads as 'cpg' — a failure never changes Superfoods behavior.
    if (!error && data?.support_mode === "software") {
      mode = "software";
    }
  } catch {
    mode = "cpg";
  }

  cache.set(workspaceId, { mode, at: nowMs() });
  return mode;
}
