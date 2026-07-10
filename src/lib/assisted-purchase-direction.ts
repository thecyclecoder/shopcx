/**
 * assisted-purchase-direction — Phase 3 of
 * [[../../docs/brain/specs/checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol]].
 *
 * The BLUEPRINT for Sol's assisted-purchase Direction when a ticket is CHECKOUT-STUCK.
 * A pure library — no DB, no network — that:
 *
 *   1. Names the four-stage recipe the multi-turn flow follows:
 *      payment_journey → confirm_items → one_time_vs_ss → playbook_handoff.
 *   2. Exports the anchor slugs the writer/validator + skill both reference — the ACTIVE
 *      [[../tables/journey_definitions]] slug (`add-payment-method`, our Braintree
 *      minisite — card never touches us and Shop Pay is bypassed) plus the two
 *      Phase-4 handoff playbook slugs (`assisted-order-purchase` for one-time,
 *      `assisted-subscription-purchase` for Subscribe & Save).
 *   3. Provides a pure builder that returns the FIRST-TURN Direction shape Sol authors —
 *      `chosen_path='journey'`, `plan.journey_slug='add-payment-method'`, a warm
 *      honest lead-in ("I can just place this for you — no need to fight that
 *      screen."), and guardrails that encode the never-claim-placed honor invariant
 *      + the handoff slugs the later stages will consume.
 *   4. Provides a pure invariant guard the box worker runs on Sol's DRAFT reply
 *      before the customer-facing send — mirrors the shape of [[sol-move-dead-end-guard]]
 *      and [[sol-policy-bait-guard]]. A reply that claims the order is placed
 *      before the FINAL verifying step (playbook_handoff after the placement
 *      handler returns `ok:true`) is BLOCKED — the customer never sees a false
 *      "it's placed" and the ticket escalates to June.
 *
 * Deliberately independent of the Direction path validator ([[ticket-directions]]
 * `validatePlanForPath`): the writer already gates `chosen_path='journey'` on the
 * slug's `is_active` + workspace scope, so this library layers only the
 * blueprint-specific invariants on top.
 */

// ── stages of the multi-turn assisted-purchase flow ──────────────────────────

/**
 * The four stages Sol walks a CHECKOUT-STUCK ticket through, in order. Each stage is
 * driven by its own Direction turn (a re-session between stages, since the customer
 * has to act — enter their card, name their items, choose one-time vs S&S — before Sol
 * knows the next input).
 *
 *   - `payment_journey`     — Turn 1. Launch the ACTIVE `add-payment-method` journey
 *                             on our Braintree minisite. Warm lead-in reply.
 *   - `confirm_items`       — Turn 2, after the `payment_method_added` signal fires.
 *                             Sol asks WHICH items the customer wants placed.
 *   - `one_time_vs_ss`      — Turn 3. Sol asks one-time (higher price) vs
 *                             discounted Subscribe & Save.
 *   - `playbook_handoff`    — Turn 4. Sol hands off to the right playbook
 *                             (`assisted-order-purchase` for one-time,
 *                             `assisted-subscription-purchase` for S&S), whose
 *                             executor runs the Braintree charge + order create /
 *                             internal subscription create and VERIFIES it. Only
 *                             AFTER the playbook step returns `ok:true` may the
 *                             customer be told the order is placed.
 */
export const ASSISTED_PURCHASE_STAGES = [
  "payment_journey",
  "confirm_items",
  "one_time_vs_ss",
  "playbook_handoff",
] as const;

export type AssistedPurchaseStage = (typeof ASSISTED_PURCHASE_STAGES)[number];

/** The ONLY stage at which Sol's reply may claim the order is placed. */
export const ASSISTED_PURCHASE_FINAL_STAGE: AssistedPurchaseStage = "playbook_handoff";

/**
 * The ACTIVE `journey_definitions` slug for the Braintree add-payment-method minisite.
 * Turn-1 Direction pins this via `chosen_path='journey'` + `plan.journey_slug=<this>`.
 * The [[ticket-directions]] writer confirms the slug resolves to an is_active row for
 * the ticket's workspace before the row lands (typed rejection surfaces the slug
 * verbatim in the box-session log if the workspace hasn't enabled the journey).
 */
export const ASSISTED_PURCHASE_JOURNEY_SLUG = "add-payment-method" as const;

/**
 * The two Phase-4 handoff playbook slugs, keyed by the customer's selection at
 * stage `one_time_vs_ss`. Phase 4 re-activates both playbooks (currently
 * `is_active=false`); this library names the target slugs so Sol's Turn 4 Direction
 * (`chosen_path='playbook'`, `plan.playbook_slug=<one of these>`) is grounded in the
 * blueprint, not a freeform guess.
 */
export const ASSISTED_PURCHASE_PLAYBOOK_SLUGS = {
  oneTime: "assisted-order-purchase",
  subscribeAndSave: "assisted-subscription-purchase",
} as const;

/**
 * The playbook slugs that must ONLY dispatch via Sol's session-chosen selection
 * (M4 of [[../specs/sol-session-chosen-playbook-selection-retire-brittle-triggers]]),
 * NEVER via the old brittle signal matcher (`matchPlaybook` /
 * `matchPlaybookScored` in [[playbook-executor]]). Phase 4 of
 * [[../specs/checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol]].
 *
 * The two assisted-purchase playbooks were originally seeded with broad
 * `trigger_intents` (`buy`, `reorder`, `create_order`, `subscribe`, …) that
 * over-fired on any purchase-adjacent language — a customer asking "when can I
 * reorder?" would inadvertently start the create-order playbook without Sol
 * choosing it. The signal matcher applies this Set as an exclusion filter so the
 * two playbooks are only reachable via `chosen_path='playbook'` + a matching
 * `plan.playbook_slug` on the live Direction, exactly the M4 model the rest of
 * the CS mechanisms shipped for.
 *
 * Kept as an exported `Set` so grep-based verification (`grep
 * ASSISTED_PURCHASE_SESSION_CHOSEN_ONLY_SLUGS src/`) surfaces every caller
 * consulting the exclusion — the acceptance token per learning #3.
 */
export const ASSISTED_PURCHASE_SESSION_CHOSEN_ONLY_SLUGS: ReadonlySet<string> = new Set([
  ASSISTED_PURCHASE_PLAYBOOK_SLUGS.oneTime,
  ASSISTED_PURCHASE_PLAYBOOK_SLUGS.subscribeAndSave,
]);

/**
 * Pure predicate the signal matcher consults BEFORE returning a match. Returns
 * `true` for the assisted-purchase slugs (which must ONLY dispatch via Sol's
 * session-chosen selection); `false` for every other slug. Case-sensitive by
 * design — the slug column is a stable normalized identifier per
 * [[../tables/playbooks]].
 */
export function isSessionChosenOnlyPlaybook(slug: string | null | undefined): boolean {
  if (!slug) return false;
  return ASSISTED_PURCHASE_SESSION_CHOSEN_ONLY_SLUGS.has(slug);
}

// ── Turn-1 Direction blueprint ───────────────────────────────────────────────

/**
 * The warm honest lead-in Sol uses on Turn 1 when handing the customer the
 * add-payment-method journey CTA. Verbatim per the spec ("I can just place this
 * for you — no need to fight that screen."). Kept as an exported constant so the
 * skill + tests + brain page all reference the SAME string — a future rewrite that
 * changes the tone won't drift out of sync.
 */
export const ASSISTED_PURCHASE_LEAD_IN =
  "I can just place this for you — no need to fight that screen. Tap below to enter your card securely and I'll take it from there.";

export interface AssistedPurchaseBlueprintInput {
  /** Sol's distilled one-line customer intent (fills the Direction's `intent`). */
  intent?: string;
  /** Sol's merged-context prose summary (fills the Direction's `context_summary`). */
  contextSummary?: string;
  /** Optional override of the warm lead-in — defaults to ASSISTED_PURCHASE_LEAD_IN. */
  leadIn?: string;
}

/**
 * The four fields Sol writes on Turn 1 for a CHECKOUT-STUCK ticket, as a plain
 * JSON blob mirroring the writeDirection input shape. Callers (the ticket-handle
 * skill's blueprint reference + the box worker's future auto-authoring path) can
 * pass this straight to [[ticket-directions]] `writeDirection` — the writer's
 * per-path validator will confirm `add-payment-method` is is_active + workspace-
 * scoped before the row lands.
 */
export interface AssistedPurchaseFirstTurnDirection {
  intent: string;
  context_summary: string;
  chosen_path: "journey";
  plan: {
    journey_slug: typeof ASSISTED_PURCHASE_JOURNEY_SLUG;
    /**
     * The recipe — the ordered stage list Sol will walk THIS ticket through across
     * future re-sessions. Stored on the Direction so the box worker's downstream
     * checks (and future analytics) can see the whole intended flow, not just the
     * one turn this row represents.
     */
    assisted_purchase_stages: readonly AssistedPurchaseStage[];
    /**
     * The playbook slugs Turn 4 will pick between. Pinned on Turn 1 so a
     * downstream re-session doesn't drift the target slugs.
     */
    handoff_playbook_slugs: {
      one_time: typeof ASSISTED_PURCHASE_PLAYBOOK_SLUGS.oneTime;
      subscribe_and_save: typeof ASSISTED_PURCHASE_PLAYBOOK_SLUGS.subscribeAndSave;
    };
  };
  guardrails: {
    /**
     * The execute-then-confirm honor invariant — Sol never tells the customer the
     * order is placed until the Turn-4 playbook step returns `ok:true`. The
     * `assertSolAssistedPurchaseReplyNeverClaimsPlaced` guard enforces this
     * against Sol's DRAFT reply on every turn.
     */
    never_promise_placed_until_verified: true;
    /** Terminal escalation conditions the cheap-execution loop respects. */
    escalate_if: readonly string[];
  };
  first_reply: string;
}

export function buildAssistedPurchaseFirstTurnDirection(
  input: AssistedPurchaseBlueprintInput = {},
): AssistedPurchaseFirstTurnDirection {
  return {
    intent:
      input.intent ??
      "customer stuck at checkout — concierge the purchase on our Braintree minisite",
    context_summary:
      input.contextSummary ??
      "Checkout-stuck: the customer can't complete on the Shopify Shop Pay checkout (OTP not arriving / stuck at payment screen / cannot check out). Route around it via the add-payment-method journey (Braintree minisite, card never touches us). Multi-turn flow: payment_journey → confirm_items → one_time_vs_ss → playbook_handoff.",
    chosen_path: "journey",
    plan: {
      journey_slug: ASSISTED_PURCHASE_JOURNEY_SLUG,
      assisted_purchase_stages: ASSISTED_PURCHASE_STAGES,
      handoff_playbook_slugs: {
        one_time: ASSISTED_PURCHASE_PLAYBOOK_SLUGS.oneTime,
        subscribe_and_save: ASSISTED_PURCHASE_PLAYBOOK_SLUGS.subscribeAndSave,
      },
    },
    guardrails: {
      never_promise_placed_until_verified: true,
      escalate_if: [
        "customer_asks_for_manager",
        "any_mention_of_lawyer",
        "third_pivot_of_ask",
        "playbook_charge_failed_twice",
      ],
    },
    first_reply: input.leadIn ?? ASSISTED_PURCHASE_LEAD_IN,
  };
}

// ── Never-claim-placed invariant guard ───────────────────────────────────────

export interface SolAssistedPurchaseReplyContext {
  /**
   * The stage of the assisted-purchase flow Sol's CURRENT turn is authoring.
   * Only `playbook_handoff` (Turn 4, after the placement handler returns `ok:true`)
   * may carry a reply that claims the order is placed. Any earlier stage → BLOCK.
   */
  stage: AssistedPurchaseStage;
  /** Sol's DRAFT customer-facing reply for this turn. */
  firstReply: string;
  /**
   * TRUE only when the CURRENT turn's placement handler enqueue returned
   * `ok:true` in this same session (the execute-then-confirm evidence). Even on
   * the final stage, a reply that claims placed WITHOUT this proof is BLOCKED —
   * the execute-then-confirm honor invariant fails if the poll result isn't in.
   */
  placementVerified?: boolean;
}

export type SolAssistedPurchaseReplyAssessment =
  | { ok: true }
  | {
      ok: false;
      kind:
        | "claims_placed_before_final_stage"
        | "claims_placed_without_verification";
      reason: string;
      matched_phrase: string;
    };

/**
 * Patterns that claim the order is PLACED / CHARGED / SHIPPED — the phrasings a
 * customer reads as "your order went through". Intentionally narrow (a
 * first-person confirmation, not a description of what will happen) — matches
 * "I've placed your order", "your order is placed", "we've charged your card and
 * placed the order", "your order is on its way", "the order is confirmed", etc.
 * A future-tense promise ("I'll place your order once you enter your card") does
 * NOT match — it doesn't claim the placement has already happened.
 */
const CLAIMS_PLACED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: /\bi['’]?ve?\s+placed\s+(?:your|the)\s+order\b/i,
    label: "I've placed your order",
  },
  {
    pattern: /\byour\s+order\s+(?:is|has\s+been)\s+placed\b/i,
    label: "your order is placed",
  },
  {
    pattern: /\bthe\s+order\s+(?:is|has\s+been)\s+(?:placed|confirmed|processed|completed)\b/i,
    label: "the order is placed",
  },
  {
    pattern: /\bwe['’]?ve?\s+(?:placed|charged|processed)\s+(?:your|the)\s+order\b/i,
    label: "we've placed / charged / processed your order",
  },
  {
    pattern: /\byour\s+order\s+is\s+on\s+its\s+way\b/i,
    label: "your order is on its way",
  },
  {
    pattern: /\bcharged\s+your\s+card\s+and\s+(?:placed|shipped|created)\b/i,
    label: "charged your card and placed / shipped / created the order",
  },
  {
    pattern: /\bpayment\s+(?:went\s+through|was\s+processed|is\s+complete)\b/i,
    label: "payment went through / was processed",
  },
];

/**
 * Pure invariant check on Sol's DRAFT reply. The box worker calls this right before
 * the customer-facing send fires (same shape as [[sol-move-dead-end-guard]] and
 * [[sol-policy-bait-guard]]). Returns `{ok:true}` when the reply is safe;
 * `{ok:false, kind, reason, matched_phrase}` when the reply claims the order is
 * placed before the flow has actually placed and verified it. The worker treats
 * an `ok:false` result exactly like a bait-guard block — the Direction stays
 * durable, the reply is NOT delivered, and the ticket escalates to June.
 */
export function assertSolAssistedPurchaseReplyNeverClaimsPlaced(
  ctx: SolAssistedPurchaseReplyContext,
): SolAssistedPurchaseReplyAssessment {
  const reply = ctx.firstReply ?? "";
  let matched: { pattern: RegExp; label: string } | null = null;
  for (const p of CLAIMS_PLACED_PATTERNS) {
    if (p.pattern.test(reply)) {
      matched = p;
      break;
    }
  }
  if (!matched) return { ok: true };

  // On an EARLIER stage, any placement claim is a hard block — Sol can't know the
  // order is placed when the placement handler hasn't even been dispatched yet.
  if (ctx.stage !== ASSISTED_PURCHASE_FINAL_STAGE) {
    return {
      ok: false,
      kind: "claims_placed_before_final_stage",
      reason: `stage='${ctx.stage}' but the reply claims the order is placed — the execute-then-confirm honor invariant blocks any placement claim before stage='${ASSISTED_PURCHASE_FINAL_STAGE}'.`,
      matched_phrase: matched.label,
    };
  }
  // On the FINAL stage, a placement claim is only valid when the placement was
  // actually enqueued + verified in this session (poll returned `ok:true`).
  if (!ctx.placementVerified) {
    return {
      ok: false,
      kind: "claims_placed_without_verification",
      reason: `stage='${ASSISTED_PURCHASE_FINAL_STAGE}' but placementVerified=false — Sol may only claim placed after the placement handler poll returns ok:true.`,
      matched_phrase: matched.label,
    };
  }
  return { ok: true };
}
