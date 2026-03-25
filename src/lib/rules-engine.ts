import { createAdminClient } from "@/lib/supabase/admin";
import { executeActions } from "@/lib/rules-actions";

// ── Types ──

export interface RuleCondition {
  field: string;       // dot-notation: "customer.retention_score", "ticket.subject", etc.
  op: string;          // equals, not_equals, contains, greater_than, etc.
  value: unknown;
}

export interface ConditionGroup {
  operator: "AND" | "OR";
  conditions: RuleCondition[];
}

export interface RuleConditions {
  operator: "AND" | "OR";
  groups: ConditionGroup[];
}

export interface RuleAction {
  type: string;
  params: Record<string, unknown>;
}

export interface Rule {
  id: string;
  workspace_id: string;
  name: string;
  enabled: boolean;
  trigger_events: string[];
  conditions: RuleConditions;
  actions: RuleAction[];
  priority: number;
  stop_processing: boolean;
}

export interface RuleContext {
  ticket?: Record<string, unknown>;
  customer?: Record<string, unknown>;
  message?: Record<string, unknown>;
  order?: Record<string, unknown>;
  subscription?: Record<string, unknown>;
}

// ── Main entry point ──

export async function evaluateRules(
  workspaceId: string,
  eventType: string,
  context: RuleContext,
): Promise<void> {
  const admin = createAdminClient();

  // Load enabled rules that match this event type
  const { data: rules } = await admin
    .from("rules")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    .contains("trigger_events", [eventType])
    .order("priority", { ascending: false });

  if (!rules || rules.length === 0) return;

  for (const rule of rules as Rule[]) {
    try {
      const match = evaluateConditions(rule.conditions, context);
      if (match) {
        await executeActions(workspaceId, rule.actions, context);
        if (rule.stop_processing) break;
      }
    } catch (err) {
      console.error(`Rule "${rule.name}" (${rule.id}) error:`, err);
      // Don't let a broken rule block other rules or the event handler
    }
  }
}

// ── Condition evaluation ──

function evaluateConditions(conditions: RuleConditions, context: RuleContext): boolean {
  const { operator, groups } = conditions;

  // No groups = always match (unconditional rule)
  if (!groups || groups.length === 0) return true;

  const results = groups.map((group) => evaluateGroup(group, context));

  if (operator === "AND") return results.every(Boolean);
  return results.some(Boolean); // OR
}

function evaluateGroup(group: ConditionGroup, context: RuleContext): boolean {
  const { operator, conditions } = group;

  if (!conditions || conditions.length === 0) return true;

  const results = conditions.map((c) => evaluateCondition(c, context));

  if (operator === "AND") return results.every(Boolean);
  return results.some(Boolean); // OR
}

function evaluateCondition(condition: RuleCondition, context: RuleContext): boolean {
  const { field, op, value } = condition;
  const actual = resolveField(field, context);

  switch (op) {
    case "equals":
      return String(actual).toLowerCase() === String(value).toLowerCase();
    case "not_equals":
      return String(actual).toLowerCase() !== String(value).toLowerCase();
    case "contains":
      return String(actual).toLowerCase().includes(String(value).toLowerCase());
    case "not_contains":
      return !String(actual).toLowerCase().includes(String(value).toLowerCase());
    case "starts_with":
      return String(actual).toLowerCase().startsWith(String(value).toLowerCase());
    case "greater_than":
      return Number(actual) > Number(value);
    case "less_than":
      return Number(actual) < Number(value);
    case "greater_or_equal":
      return Number(actual) >= Number(value);
    case "less_or_equal":
      return Number(actual) <= Number(value);
    case "is_empty":
      return actual == null || actual === "" || (Array.isArray(actual) && actual.length === 0);
    case "is_not_empty":
      return actual != null && actual !== "" && !(Array.isArray(actual) && actual.length === 0);
    case "in":
      if (Array.isArray(value)) return value.map(v => String(v).toLowerCase()).includes(String(actual).toLowerCase());
      return String(value).toLowerCase().split(",").map(s => s.trim()).includes(String(actual).toLowerCase());
    case "not_in":
      if (Array.isArray(value)) return !value.map(v => String(v).toLowerCase()).includes(String(actual).toLowerCase());
      return !String(value).toLowerCase().split(",").map(s => s.trim()).includes(String(actual).toLowerCase());
    case "array_contains":
      if (Array.isArray(actual)) return actual.map(v => String(v).toLowerCase()).includes(String(value).toLowerCase());
      return false;
    default:
      console.warn(`Unknown rule operator: ${op}`);
      return false;
  }
}

// Resolve "customer.retention_score" → context.customer.retention_score
function resolveField(field: string, context: RuleContext): unknown {
  const parts = field.split(".");
  let current: unknown = context;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
