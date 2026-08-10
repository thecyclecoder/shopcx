/**
 * completed-effect-backing — populates the backed-effect set the claim-guard
 * ([[claim-guard]] `unbackedEffectClaim`) reads on the plain-reply paths
 * (`ai_response` / `kb_response`) so a truthful restatement of an effect that
 * ALREADY COMPLETED does not read as an unbacked promise.
 *
 * Spec: docs/brain/specs/claim-guard-backs-completed-effects-on-post-journey-followups.md.
 *
 * Two evidence sources, both authoritative + read-only:
 *
 *  1. A completed journey on THIS ticket — [[../tables/journey_sessions]] row with
 *     `status='completed'` for `ticket_id`. The journey's `journey_type` maps to a
 *     claim-guard action family (e.g. `cancellation` → `cancel`, `pause` → `pause`).
 *  2. The target subscription already sitting in the claimed end state — the customer's
 *     [[../tables/subscriptions]] row with `status='cancelled'` backs a cancel claim;
 *     `status='paused'` backs a pause claim.
 *
 * Fail-safe: any lookup error or ambiguity → EMPTY set (falls through to today's
 * blocking behavior). Blocking a true statement costs an escalation; sending a
 * false one costs a customer's trust — the failure mode must stay on the blocking
 * side. See the spec's Phase 1 Why.
 *
 * Pure DB reads + a small deterministic mapping table — no model call. Mirrors the
 * sibling guard style ([[sol-cta-reference-guard]] `hasLaunchedJourneyThisTurn`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Map a `journey_definitions.journey_type` to the claim-guard action families it
 * legitimately backs when the journey COMPLETES. Types not listed (e.g. `custom`,
 * `account_linking`, `discount_signup`, `win_back`) don't correspond to a
 * completed-effect claim shape the guard trips on today; adding a new mapping is
 * safe only when a new EFFECT_PATTERN family lands in claim-guard.ts.
 *
 * Deliberately conservative: a family listed here is the SAME string the
 * `EFFECT_PATTERNS[i].families` array uses in claim-guard.ts, so the backed set
 * plugs straight into `unbackedEffectClaim`.
 */
const JOURNEY_TYPE_TO_FAMILIES: Record<string, string[]> = {
  cancellation: ["cancel"],
  pause: ["pause", "pause_timed", "crisis_pause"],
  product_swap: ["swap_variant"],
  return_request: ["create_return"],
  address_change: ["update_shipping_address"],
};

/**
 * Map a `subscriptions.status` end state to the claim-guard families that end state
 * legitimately backs. A cancelled sub backs "your subscription has been cancelled";
 * a paused sub backs "I've paused your subscription".
 *
 * Only durable, DB-visible end states qualify — "active" or "pending" back nothing.
 */
const SUB_STATUS_TO_FAMILIES: Record<string, string[]> = {
  cancelled: ["cancel"],
  paused: ["pause", "pause_timed", "crisis_pause"],
};

export interface BackedEffectContext {
  admin: SupabaseClient;
  workspace_id: string;
  ticket_id: string;
  customer_id: string;
}

/**
 * Build the set of action families that back an effect ALREADY COMPLETED for this
 * ticket + customer. Pass the result as the `backed` arg to `unbackedEffectClaim`.
 *
 * Read-only, deterministic, fail-safe: any probe error → empty set (block as
 * today). Never throws.
 *
 * Both queries re-assert `workspace_id` alongside `ticket_id` / `customer_id` so a
 * foreign-workspace row cannot back a claim on this ticket (same enumeration-scope
 * narrowing the sibling `hasLaunchedJourneyThisTurn` uses).
 */
export async function backedEffectsForCompletedEffects(
  ctx: BackedEffectContext,
): Promise<Set<string>> {
  const backed = new Set<string>();
  await Promise.all([
    addBackedFromCompletedJourneys(ctx, backed),
    addBackedFromSubscriptionEndState(ctx, backed),
  ]);
  return backed;
}

async function addBackedFromCompletedJourneys(
  ctx: BackedEffectContext,
  backed: Set<string>,
): Promise<void> {
  try {
    const { data } = await ctx.admin
      .from("journey_sessions")
      .select("journey_id, journey_definitions!inner(journey_type, workspace_id)")
      .eq("workspace_id", ctx.workspace_id)
      .eq("ticket_id", ctx.ticket_id)
      .eq("status", "completed");
    for (const row of data ?? []) {
      const def = (row as { journey_definitions?: { journey_type?: string } | Array<{ journey_type?: string }> }).journey_definitions;
      const defRow = Array.isArray(def) ? def[0] : def;
      const jt = defRow?.journey_type;
      if (!jt) continue;
      for (const fam of JOURNEY_TYPE_TO_FAMILIES[jt] ?? []) backed.add(fam);
    }
  } catch {
    // Fail-safe: swallow — an empty contribution keeps today's blocking behavior.
  }
}

async function addBackedFromSubscriptionEndState(
  ctx: BackedEffectContext,
  backed: Set<string>,
): Promise<void> {
  try {
    const { data } = await ctx.admin
      .from("subscriptions")
      .select("status")
      .eq("workspace_id", ctx.workspace_id)
      .eq("customer_id", ctx.customer_id);
    for (const row of data ?? []) {
      const st = (row as { status?: string }).status;
      if (!st) continue;
      for (const fam of SUB_STATUS_TO_FAMILIES[st] ?? []) backed.add(fam);
    }
  } catch {
    // Fail-safe — same reason as above.
  }
}
