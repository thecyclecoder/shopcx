/**
 * Shared types for the Research & Heal system.
 * See RESEARCH-AND-HEAL.md for the design rationale.
 */

export type FindingSeverity = "info" | "low" | "medium" | "high";
export type GapSeverity = "low" | "medium" | "high";

export interface Finding {
  /** Recipe-specific finding type, e.g. "coupon_applied_correctly". */
  type: string;
  /** Human-readable subject — typically the entity in question (a coupon code, a contract id). */
  subject: string;
  /** Structured evidence the recipe collected. Renders on the analyzer page. */
  evidence: Record<string, unknown>;
  severity: FindingSeverity;
}

export interface ProposedHeal {
  /** Must match a key in directActionHandlers (src/lib/action-executor.ts). */
  action_type: string;
  /** Params passed straight through to the direct action. */
  params: Record<string, unknown>;
  /** Mustache-style template, filled at heal time. Placeholders the recipe can reference: */
  /*   {{coupon_code}} {{contract_id}} {{variant_title}} {{amount}} {{next_date}}     */
  customer_message_template: string;
  /** Persona for the follow-up message — Suzie (AI) is default. */
  customer_message_persona: "suzie" | "julie";
}

export interface Gap {
  /**
   * Stable id within this recipe's run for a given problem instance.
   * Same gap on the same ticket should produce the same gap_id across re-runs.
   * Format: "<gap_type>:<subject>", e.g. "missing_coupon:33484669101"
   */
  gap_id: string;
  description: string;
  severity: GapSeverity;
  proposed_heal?: ProposedHeal;
}

export interface ResearchResult {
  findings: Finding[];
  gaps: Gap[];
}

export interface ResearchRecipe {
  /** Stable snake_case verb_object identifier. */
  slug: string;
  /** Bump when run() logic changes — old runs aren't trusted as current. */
  version: number;
  /** Short description shown on the analyzer page and in admin docs. */
  description: string;
  /** Actual probe logic. Should be deterministic given (ticketId, args). */
  run: (ticketId: string, args?: Record<string, unknown>) => Promise<ResearchResult>;
}

export interface ResearchRunRecord {
  id: string;
  workspace_id: string;
  ticket_id: string;
  recipe_slug: string;
  recipe_version: number;
  ran_at: string;
  findings: Finding[];
  gaps: Gap[];
  triggered_by: "ai_analysis" | "manual" | "heal_reverify";
  source_analysis_id: string | null;
}
