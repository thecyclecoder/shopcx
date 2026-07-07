/**
 * Selective-clarify gate — Phase 2 of
 * docs/brain/specs/confidence-gated-problem-lockin-and-selective-clarify.md.
 *
 * Purpose: intercept the ~6% of Sonnet decisions that are BOTH low-confidence AND
 * irreversible (partial_refund / cancel / bill_now / subscriptionOrderNow) with a
 * targeted confirmation-turn — instead of blanket-clarifying every ambiguous ticket
 * (~38% turns for ~0 benefit, the regime the parent goal rejects).
 *
 * Wired at the top of executeSonnetDecision's `direct_action` branch in
 * src/lib/action-executor.ts. On a hit: send the confirmation reply, skip the
 * mutating action, stamp ticket_resolution_events.verified_outcome='clarified'.
 *
 * Pure helpers only — no DB, no network. `loadIrreversibleSet(admin, workspaceId)`
 * lets a workspace override the DEFAULT_IRREVERSIBLE_SET via a `policies` row with
 * slug='irreversible_actions' (`rules: [{action: "type"}, ...]`).
 */

import type { createAdminClient } from "@/lib/supabase/admin";

// Below this confidence AND acting on an irreversible action → clarify.
// Aligned with the problem-lockin default (0.7) so the two thresholds move together.
export const DEFAULT_CLARIFY_CONFIDENCE_THRESHOLD = 0.7;

// Actions whose blast radius is real money / a broken subscription / a lost
// billing cycle — hard to unwind cleanly. Reversible actions (apply_coupon,
// send_ai_response, macro, ...) are NOT gated: we accept the confidence risk
// because a wrong reversible action is a cheap undo, not a customer harm.
export const DEFAULT_IRREVERSIBLE_SET: ReadonlySet<string> = new Set([
  "partial_refund",
  "cancel",
  "bill_now",
  "subscriptionOrderNow",
]);

// Minimal shape the gate reads. Callers pass richer objects (SonnetDecision.actions
// carries dozens of action-specific fields) — TS structural typing accepts any
// superset. We only need `type` + `amount_cents`.
export interface ClarifyAction {
  type?: string | null;
  amount_cents?: number;
}

export interface ShouldClarifyInput {
  confidence?: number | null;
  actions?: ReadonlyArray<ClarifyAction>;
}

export interface ShouldClarifyOpts {
  irreversibleSet?: ReadonlySet<string>;
  clarifyBelow?: number;
}

/**
 * True iff the decision is LOW-confidence AND at least one action is irreversible.
 *
 * Explicit non-triggers (per the spec's Phase-2 verification):
 *   - null/absent confidence → false (a straggler decision without a self-reported
 *     confidence must not blanket-clarify; that's the 38% regime the goal rejects).
 *   - reversible-only batch → false (apply_coupon at low confidence still fires).
 *   - high confidence, even on an irreversible action → false (we trust the model).
 */
export function shouldClarify(input: ShouldClarifyInput, opts: ShouldClarifyOpts = {}): boolean {
  const irreversible = opts.irreversibleSet ?? DEFAULT_IRREVERSIBLE_SET;
  const clarifyBelow = typeof opts.clarifyBelow === "number" ? opts.clarifyBelow : DEFAULT_CLARIFY_CONFIDENCE_THRESHOLD;

  const conf = typeof input.confidence === "number" && Number.isFinite(input.confidence)
    ? input.confidence
    : null;
  if (conf == null) return false;
  if (conf >= clarifyBelow) return false;

  for (const a of input.actions ?? []) {
    if (a && typeof a.type === "string" && irreversible.has(a.type)) return true;
  }
  return false;
}

/**
 * Build the scoped confirmation message. The spec's example is
 * "Just to confirm before I refund $X, is that right?" — we keep it short,
 * name the concrete action + amount when we have one, and stay plain-text
 * (CLAUDE.md: "AI responses are plain text, no markdown").
 */
export function buildClarificationMessage(
  actions: ReadonlyArray<ClarifyAction>,
): string {
  const first = (actions || []).find(a => a && typeof a.type === "string" && DEFAULT_IRREVERSIBLE_SET.has(a.type as string));
  const type = first?.type as string | undefined;
  if (type === "partial_refund") {
    const cents = typeof first?.amount_cents === "number" ? first.amount_cents : null;
    if (cents != null && cents > 0) {
      const dollars = (cents / 100).toFixed(2);
      return `Just to confirm before I refund $${dollars}, is that right?`;
    }
    return `Just to confirm before I issue the refund, is that right?`;
  }
  if (type === "cancel") {
    return `Just to confirm before I cancel your subscription, is that right?`;
  }
  if (type === "bill_now" || type === "subscriptionOrderNow") {
    return `Just to confirm before I bill your next order now, is that right?`;
  }
  // Fallback — no irreversible action in the batch (this path shouldn't be reached
  // if callers guard on shouldClarify first, but we keep it safe).
  return `Just to confirm before I make that change, is that right?`;
}

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Load the workspace's irreversible-action override from the `policies` table
 * (slug='irreversible_actions'). Schema of the `rules` JSONB:
 *   [{action: "partial_refund"}, {action: "cancel"}, ...]
 * Absent row → the DEFAULT_IRREVERSIBLE_SET. Malformed rows → same fallback,
 * so a broken policy edit can never disable the gate.
 */
export async function loadIrreversibleSet(admin: Admin, workspaceId: string): Promise<ReadonlySet<string>> {
  try {
    const { data: policy } = await admin
      .from("policies")
      .select("rules")
      .eq("workspace_id", workspaceId)
      .eq("slug", "irreversible_actions")
      .eq("is_active", true)
      .is("superseded_by", null)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const rules = policy?.rules;
    if (!Array.isArray(rules) || rules.length === 0) return DEFAULT_IRREVERSIBLE_SET;
    const set = new Set<string>();
    for (const r of rules) {
      if (r && typeof r === "object" && typeof (r as { action?: unknown }).action === "string") {
        set.add((r as { action: string }).action);
      }
    }
    if (set.size === 0) return DEFAULT_IRREVERSIBLE_SET;
    return set;
  } catch {
    return DEFAULT_IRREVERSIBLE_SET;
  }
}
