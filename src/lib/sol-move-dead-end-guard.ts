/**
 * Phase 3 of
 * [[../../docs/brain/specs/sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend]]
 *
 * Machine gate the worker runs on Sol's DRAFT reply just after the policy-bait guard, before
 * the customer-facing send (scripts/builder-worker.ts runTicketHandleJob). Enforces the
 * spec's Phase-3 invariants:
 *
 *   1. A move signal ('I moved', 'new address', 'changed address', 'cancel, I moved', etc.)
 *      with an ACTIVE subscription NEVER produces a cancel-only / no-redirect terminal
 *      reply. The customer must be offered the address-update save first
 *      (Phase 1 wedge — `launch_journey_slug='shipping-address'`), never dead-ended into
 *      cancel or an "already shipped, can't redirect" terminal.
 *   2. A customer who insists on cancel AFTER the move-save offer is handed the SELF-SERVICE
 *      Cancel Subscription journey — Sol never cancels for them and never terminates with
 *      "we'll cancel it now" or "your subscription is cancelled". The honest cancel path is
 *      `plan.launch_journey_slug='cancel-subscription'` + a reply that hands over the link.
 *   3. An already-shipped order is acknowledged truthfully — but the acknowledgment MUST
 *      pair with an alternative (address update on future shipments, a $0 replacement to
 *      the new address, the self-service cancel link). A bare "already shipped, can't
 *      redirect" that terminates the interaction is the exact dead-end this guard blocks.
 *
 * Same shape as [[sol-policy-bait-guard]] — a pure function with no filesystem / network
 * dependencies so the worker imports it cheaply and the tests seed inputs directly. Returns
 * `{ok:true}` when the reply is safe, `{ok:false,kind,reason,matched_phrase}` otherwise;
 * the worker treats `{ok:false}` the same way it treats a bait-guard block (Direction
 * durable, reply not delivered, ticket escalates to June — the CS final call).
 */

export interface SolMoveDeadEndContext {
  /** Sol's Direction.intent — one-line customer-intent distillation from the first-touch. */
  intent: string;
  /** Sol's Direction.context_summary — merged customer + subscription + order context. */
  contextSummary: string;
  /**
   * Sol's Direction.plan — reserved for future signals plus the current escape-hatch check
   * (`launch_journey_slug: 'cancel-subscription'` on the explicit-cancel-after-offer path
   * proves the reply is handing the self-service journey, not cancelling for the customer).
   */
  plan?: Record<string, unknown> | null;
  /** The DRAFT reply Sol wants to send to the customer. */
  firstReply: string;
  /**
   * Whether this customer has at least one ACTIVE subscription. When false, the "never
   * dead-end a move as cancel" invariant does not apply — a customer with no active sub
   * legitimately gets an acknowledgment reply and there is nothing to cancel.
   */
  hasActiveSubscription: boolean;
}

export type SolMoveDeadEndAssessment =
  | { ok: true }
  | {
      ok: false;
      kind:
        | "move_dead_ended_as_cancel"
        | "move_terminal_no_redirect_without_alternative"
        | "cancel_after_offer_without_self_service_handoff";
      reason: string;
      matched_phrase: string;
    };

/**
 * Signals in Sol's `intent` or `context_summary` that mark this ticket as a MOVE. Any match
 * arms the dead-end / no-redirect / self-service-cancel checks below. Deliberately broad on
 * the customer-language side (matches the same signals Phase 1's skill teaches Sol to
 * recognize) — a false negative here just means the guard doesn't fire (behavior falls back
 * to the pre-Phase-3 send path), so the bar is intentionally low.
 */
const MOVE_SIGNAL_MARKERS: RegExp[] = [
  /\bI['’]?ve?\s+moved\b/i,
  /\bwe['’]?ve?\s+moved\b/i,
  /\bcustomer\s+(?:has\s+)?moved\b/i,
  /\bjust\s+moved\b/i,
  /\brecently\s+moved\b/i,
  /\brelocat(?:ed|ing)\b/i,
  /\bnew\s+address\b/i,
  /\bchang(?:ed|ing|e)\s+(?:my\s+|the\s+|our\s+)?(?:shipping\s+)?address\b/i,
  /\baddress\s+change\b/i,
  /\bmoving\s+to\b/i,
  /\bmove\b\s*[,-]\s*(?:new\s+)?address/i,
];

/**
 * Reply phrases that terminate a move signal with a cancel-only or no-redirect dead-end.
 * The 87ce35a1 sibling for MOVES: "already shipped, can't redirect — we'll have to cancel"
 * with no alternative offered. Intentionally narrow — matches a first-person termination
 * ("we'll cancel", "your only option is to cancel") or a bare "can't redirect, sorry".
 */
const DEAD_END_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern:
      /\b(?:we['’]?(?:ll|\s?will|\s?ve|['’]ve))\s+(?:need\s+to\s+)?cancel\s+(?:your|the)\s+subscription\b/i,
    label: "we'll cancel your subscription",
  },
  {
    pattern:
      /\byour\s+only\s+option\s+is\s+to\s+cancel\b/i,
    label: "your only option is to cancel",
  },
  {
    pattern:
      /\b(?:i['’]?ll|i\s+will|i['’]?ve)\s+(?:go(?:ne)?\s+ahead\s+and\s+)?cancel(?:led|ing)?\s+(?:your|the)\s+subscription\b/i,
    label: "I'll/I've cancelled your subscription",
  },
  {
    pattern:
      /\byour\s+subscription\s+(?:has\s+been|is)\s+cancel(?:led|ed)\b/i,
    label: "your subscription is cancelled",
  },
  {
    pattern:
      /\balready\s+shipped[^.!?]*(?:can(?:'|’)?t|cannot|unable\s+to)\s+redirect\b/i,
    label: "already shipped, can't redirect",
  },
  {
    pattern:
      /\bcan(?:'|’)?t\s+redirect\s+(?:that\s+|this\s+|the\s+)?(?:order|shipment|package)\b/i,
    label: "can't redirect that order/shipment",
  },
  {
    pattern:
      /\bnothing\s+(?:we|i)\s+can\s+do\s+(?:about\s+that|now)\b/i,
    label: "nothing we/I can do",
  },
];

/**
 * Escape-hatch phrases that turn an acknowledgement into a save-path continuation instead
 * of a dead-end. A reply that acknowledges the shipped order truthfully AND names an
 * alternative — update the address on future shipments, send a $0 replacement to the new
 * place, hand the self-service cancel journey — is NOT a dead-end and the guard passes.
 * Broad and forgiving on the alternative side — a reply that gestures at ANY save-path
 * continuation passes.
 */
const ESCAPE_HATCH_PATTERNS: RegExp[] = [
  /\b(?:update|updat(?:e|ing))\s+(?:your\s+|the\s+)?(?:shipping\s+)?address\b/i,
  /\bconfirm\s+(?:your\s+|the\s+)?(?:new\s+)?address\b/i,
  /\b(?:new|updated)\s+address\s+(?:on|for)\s+(?:file|the\s+subscription|your\s+subscription|future|next|upcoming)\b/i,
  /\bfuture\s+(?:shipments?|orders?|renewals?)\b/i,
  /\bnext\s+(?:shipment|order|renewal|box)\b/i,
  /\breplacement\b/i,
  /\bship\s+(?:you\s+)?another\b/i,
  /\bsend\s+(?:you\s+)?(?:a\s+|another\s+)?(?:free\s+)?replacement\b/i,
  /\bself[- ]service\s+cancel\b/i,
  /\bcancel\s+(?:link|journey|form|page|yourself|it\s+yourself|from\s+your\s+account|from\s+the\s+portal)\b/i,
  /\btap\s+(?:below|the\s+link|here)\b/i,
  /\bhere['’]?s\s+(?:the|a)\s+(?:link|cancel|form)\b/i,
];

function anyMoveSignal(intent: string, summary: string): { match: string | null } {
  for (const marker of MOVE_SIGNAL_MARKERS) {
    const m = intent.match(marker) ?? summary.match(marker);
    if (m) return { match: m[0] };
  }
  return { match: null };
}

/**
 * The core assessor. Returns `{ok:true}` when the reply is safe to send; `{ok:false,…}` when
 * the send must be blocked. Three signals map to distinct kinds:
 *   - `move_dead_ended_as_cancel` — Sol has an active-sub move ticket and her reply
 *     terminates in a cancel or an "already shipped, can't redirect" without any escape hatch.
 *   - `move_terminal_no_redirect_without_alternative` — variant of the above where the
 *     dead-end phrase is a bare "can't redirect / nothing we can do" (the shipment ack
 *     without an alternative). Split for clearer downstream diagnostics.
 *   - `cancel_after_offer_without_self_service_handoff` — an explicit-cancel path (Sol's
 *     Direction has `plan.launch_journey_slug='cancel-subscription'` OR the reply talks
 *     about cancelling), but the reply's first-person verbs suggest Sol is cancelling FOR
 *     the customer instead of handing the self-service journey link.
 */
export function assessSolMoveDeadEndRisk(
  ctx: SolMoveDeadEndContext,
): SolMoveDeadEndAssessment {
  const reply = (ctx.firstReply || "").trim();
  if (!reply) return { ok: true };
  const intent = (ctx.intent || "").trim();
  const summary = (ctx.contextSummary || "").trim();
  const moveHit = anyMoveSignal(intent, summary);
  const plan = ctx.plan ?? {};
  const journeySlug =
    typeof (plan as { launch_journey_slug?: unknown }).launch_journey_slug === "string"
      ? String((plan as { launch_journey_slug?: string }).launch_journey_slug)
      : "";

  // ── 1) Explicit cancel-after-offer path check ──
  // If Sol's Direction hands the self-service cancel journey, the reply MUST NOT contain a
  // first-person "we/I cancelled it" — the entire point of the self-service handoff is the
  // customer cancels themselves. A first-person cancel verb next to that Direction slug is
  // Sol cancelling FOR the customer, which the spec explicitly forbids ("Sol hands the
  // self-service Cancel Subscription journey (never cancels for them)").
  if (journeySlug === "cancel-subscription") {
    for (const { pattern, label } of DEAD_END_PATTERNS) {
      if (
        label === "I'll/I've cancelled your subscription" ||
        label === "your subscription is cancelled" ||
        label === "we'll cancel your subscription"
      ) {
        const m = reply.match(pattern);
        if (m) {
          return {
            ok: false,
            kind: "cancel_after_offer_without_self_service_handoff",
            reason:
              "Direction hands the self-service Cancel Subscription journey, but the reply first-person-cancels the subscription — the self-service journey means the customer cancels themselves, not Sol on their behalf",
            matched_phrase: m[0],
          };
        }
      }
    }
    // Cancel-subscription slug + no first-person cancel = the explicit-cancel-after-offer
    // path is being handed correctly. Skip the move-dead-end check below — the customer
    // asked for cancel, we're handing them the journey; that's the honest path.
    return { ok: true };
  }

  // ── 2) Move dead-end check — only when a MOVE signal is present AND active sub exists ──
  if (!moveHit.match) return { ok: true };
  if (!ctx.hasActiveSubscription) return { ok: true };

  const hasEscapeHatch = ESCAPE_HATCH_PATTERNS.some((r) => r.test(reply));

  for (const { pattern, label } of DEAD_END_PATTERNS) {
    const m = reply.match(pattern);
    if (!m) continue;
    if (hasEscapeHatch) continue;
    const isNoRedirect =
      label === "already shipped, can't redirect" ||
      label === "can't redirect that order/shipment" ||
      label === "nothing we/I can do";
    return {
      ok: false,
      kind: isNoRedirect
        ? "move_terminal_no_redirect_without_alternative"
        : "move_dead_ended_as_cancel",
      reason: isNoRedirect
        ? `Sol acknowledged a move + shipped order but the reply terminates with "${label}" — the move must always be offered an alternative (address update on future shipments, a replacement to the new address, or the self-service cancel journey), never a terminal no-redirect`
        : `Sol declared a move signal + active subscription but the reply terminates in a cancel (${label}) — a move is a save opportunity, never a cancel dead-end when an active subscription exists`,
      matched_phrase: m[0],
    };
  }

  return { ok: true };
}
