/**
 * Phase 2 of [[../../docs/brain/specs/sol-reviews-policies-and-never-bais-an-out-of-policy-outcome-full-research-session]]
 *
 * Machine gate the worker runs on Sol's DRAFT reply before the customer-facing send
 * (scripts/builder-worker.ts runTicketHandleJob, just before deliverTicketMessage). Phase 1
 * loaded the workspace's active policies into Sol's session and required her context_summary
 * to state the policy verdict (in-policy / bounded-exception / out-of-policy). Phase 2 adds
 * the hard rule on the DRAFT reply itself: if Sol declared the ask out-of-policy but her
 * first_reply still promises the disallowed remedy — or the reply stacks multiple returns /
 * refunds in one turn — the send is BLOCKED. The Direction stays durable (Sol's reasoning is
 * preserved for grader/coach visibility) but the customer never sees the baited turn — the
 * ticket escalates to June (the CS final call), who re-drafts a compliant reply.
 *
 * Derived-from-ticket 87ce35a1: Sol offered a customer TWO coffee-subscription returns after
 * her own reasoning acknowledged renewals aren't returnable. Both signals fire on that reply:
 * (1) `two returns` matches MULTIPLE_REMEDY_PATTERNS unconditionally, and (2) the "renewals
 * not eligible" verdict + a return promise matches OUT_OF_POLICY_MARKERS + PROMISE_PATTERNS.
 *
 * Pure-function + zero dependencies so builder-worker can import it without pulling a whole
 * SDK chain, and so the test can seed inputs directly.
 */

export interface SolReplyBaitContext {
  /**
   * Sol's Direction.context_summary — must include her policy verdict per the Phase-1
   * prompt (in-policy / bounded-exception / out-of-policy). Empty string is treated as
   * an unstated verdict, so the out-of-policy signal doesn't fire.
   */
  contextSummary: string;
  /** Sol's Direction.plan — reserved for future signals; currently unused. */
  plan?: Record<string, unknown> | null;
  /** The DRAFT reply Sol wants to send to the customer. */
  firstReply: string;
  /**
   * ⭐ Whether the customer has actually been IDENTIFIED — resolved to a real account with order
   * history. Pass `false` when the inbound address matched nothing (or matched only a stub row the
   * ticket itself minted). Defaults to `true` so every existing caller keeps its behaviour.
   *
   * WHY THIS EXISTS. The two original signals both assume we KNOW something: one needs a declared
   * out-of-policy verdict, the other needs a stacked-remedy shape. Neither fires on a promise made
   * under total IGNORANCE — and that is the more dangerous case, because eligibility is unknown
   * rather than known-bad. Ticket 879dd36b (2026-08-12): "cancelling your deliveries and processing
   * your refund are both things we can absolutely take care of", written to someone we could not
   * find. A refund there might have been a renewal (categorically denied), outside the 30-day MBG
   * window, not their first order (MBG is first-order-only), or their one lifetime return already
   * spent. We had no idea — which is exactly why it must not be promised.
   */
  customerIdentified?: boolean;
}

export type SolReplyBaitAssessment =
  | { ok: true }
  | {
      ok: false;
      kind: "out_of_policy_promise" | "multiple_remedies_offered" | "unverified_remedy_promise";
      reason: string;
      matched_phrase: string;
    };

/**
 * Phrases that mark Sol's own verdict as "out-of-policy". The Phase-1 prompt REQUIRES her
 * context_summary to explicitly state one of in-policy / bounded-exception / out-of-policy,
 * so this matches on the marker set the prompt gives her. Deliberately conservative — a
 * fuzzy phrasing (no marker) is treated as in-policy and the guard doesn't fire, so
 * in-policy replies pass through untouched. A false negative here just means the reply
 * ships (same as pre-Phase-2 behavior); a false positive would suppress a legitimate reply,
 * so the bar for a marker match is a phrase that unambiguously says "denied by policy".
 */
const OUT_OF_POLICY_MARKERS: RegExp[] = [
  /\bout[- ]of[- ]policy\b/i,
  /\bpolicy disallows?\b/i,
  /\bnot\s+eligible\b/i,
  /\bisn['’]?t\s+eligible\b/i,
  /\bcategorically denied\b/i,
  /\bcannot honor\b/i,
  /\bcan(?:['’]|no)?t be refunded\b/i,
  /\bMBG (?:does\s?not|doesn['’]?t) apply\b/i,
  /\bagainst (?:the |our )?policy\b/i,
  /\brenewals\s+not\s+eligible\b/i,
  /\brenewals\s+aren['’]?t\s+returnable\b/i,
];

/**
 * Reply phrases that PROMISE a remedy — Sol tells the customer she is doing / will do
 * something concrete for them. Intentionally narrow: an in-context REFERENCE to policy
 * ("subscription renewals aren't eligible for return, but you can pause…") does not
 * match, so an in-policy explanation with the correct alternative still ships. The bait
 * pattern is a first-person action verb + a remedy noun ("I'll issue a refund", "we'll
 * send a prepaid label", "here is your prepaid label").
 */
const PROMISE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern:
      /\bI['’]?(?:ll|\s?will|\s?ve|['’]ve|\s?m going to|\s?am going to) (?:issue|initiate|process|set up|start|generate|create|send|arrange|refund|comp|waive|expedite) (?:you )?(?:a|the|your|two|both)? ?(?:refunds?|returns?|prepaid labels?|store credits?|exchanges?|replacements?|expedited (?:shipping|delivery)?|coupons?)/i,
    label: "first-person promised remedy",
  },
  {
    pattern:
      /\byou['’]?(?:ll|\s?will) (?:see|get|receive|have|find) (?:a|your)? ?(?:refund|store credit|prepaid label|replacement)/i,
    label: "you-will-see promised remedy",
  },
  {
    pattern:
      /\b(?:here|attached|below) (?:is|are) (?:your|the|two|both) (?:prepaid labels?|return labels?|refunds?|store credits?)/i,
    label: "here-is-your remedy",
  },
  {
    pattern:
      /\bwe['’]?(?:ll|\s?will) (?:issue|initiate|process|set up|start|generate|create|send|arrange|refund|comp|waive|expedite) (?:you )?(?:a|the|your|two|both)? ?(?:refunds?|returns?|prepaid labels?|store credits?|exchanges?|replacements?|expedited (?:shipping|delivery)?)/i,
    label: "we-will promised remedy",
  },
  // ⭐ CAPABILITY ASSERTION (ticket 879dd36b, 2026-08-12). The four patterns above all catch a
  // COMMITMENT ("I'll issue…", "you'll receive…", "here is your…"). The live failure used a
  // capability claim instead — "cancelling your deliveries and processing your refund are both
  // things we can absolutely take care of" — which promises just as hard to a customer while
  // matching none of them. Reassurance about what we CAN do is a promise; the customer reads no
  // difference. Requires a remedy noun nearby so ordinary helpfulness ("we can take a look at
  // that", "that's something we can check") is untouched.
  {
    pattern:
      /\b(?:we|that|this|those|these|it)(?:['’]s| is| are)?\s+(?:both\s+)?(?:things?\s+)?(?:we\s+)?can\s+(?:absolutely\s+|definitely\s+|certainly\s+|easily\s+)?(?:take care of|handle|do|sort out|arrange|process)\b[^.!?]{0,80}?(?:refunds?|returns?|prepaid labels?|store credits?|exchanges?|replacements?)/i,
    label: "capability-assertion remedy promise",
  },
  {
    // The same shape with the remedy stated FIRST — "cancelling your deliveries and processing
    // your refund are both things we can absolutely take care of".
    pattern:
      /(?:refunds?|returns?|cancell?ing|prepaid labels?|store credits?|exchanges?|replacements?)[^.!?]{0,100}?\b(?:are|is)\s+(?:both\s+)?(?:things?|something)\s+we\s+can\s+(?:absolutely\s+|definitely\s+|certainly\s+|easily\s+)?(?:take care of|handle|do|sort out|arrange|process)\b/i,
    label: "capability-assertion remedy promise (remedy-first)",
  },
  {
    pattern:
      /\b(?:happy|glad|able)\s+to\s+(?:issue|process|arrange|send|set up)\s+(?:you\s+)?(?:a|the|your)?\s?(?:refunds?|returns?|prepaid labels?|store credits?|replacements?)/i,
    label: "happy-to remedy promise",
  },
  {
    pattern:
      /\b(?:let|allow) me (?:to )?(?:issue|process|initiate|set up|start|generate|arrange) (?:a|the|your)? ?(?:refund|return|prepaid label|store credit|exchange|replacement)/i,
    label: "let-me promised remedy",
  },
];

/**
 * Structural absurdity signals that fire regardless of Sol's declared verdict. The
 * returns policy caps at ONE MBG return per customer for life; a reply that stacks TWO
 * returns or refunds in one turn is a bait in itself. The 87ce35a1 coffee-return ticket
 * matched this even before the out-of-policy check — Sol offered two returns unprompted.
 *
 * ⭐ The FIRST pattern (`TWO_REFUNDS_COUNT_PATTERN`) is exempted when the reply is
 * describing refunds ALREADY posted to the ledger for ONE order (a split partial +
 * completion) — see `isDescribingCompletedSplitRefund` below. The other three patterns
 * are inherently multi-order or forward-looking and never qualify for the exemption.
 */
const TWO_REFUNDS_COUNT_PATTERN =
  /\b(?:two|2)\s+(?:returns?|refunds?|prepaid labels?|store credits?|exchanges?|replacements?)\b/i;
const MULTIPLE_REMEDY_PATTERNS: RegExp[] = [
  TWO_REFUNDS_COUNT_PATTERN,
  /\bboth\s+(?:returns?|refunds?|orders?)\s+(?:can be|will be|are eligible|are returnable|are refundable)/i,
  /\ba\s+return\s+for\s+each\s+order\b/i,
  /\bone\s+for\s+each\s+of\s+(?:the\s+)?(?:two|both)\s+(?:orders?|renewals?)\b/i,
];

/**
 * Past-tense refund verbs that mark a reply as DESCRIBING refunds already posted to the
 * ledger (rather than OFFERING new ones). Deliberately narrow — the verb must clearly
 * refer to a completed action; "will be refunded" / "I'll refund" don't match here.
 */
const COMPLETED_REFUND_MARKERS: RegExp[] = [
  /\bwas\s+refunded\b/i,
  /\bwere\s+refunded\b/i,
  /\bhas\s+been\s+refunded\b/i,
  /\bhave\s+been\s+refunded\b/i,
  /\bhad\s+been\s+refunded\b/i,
  /\balready\s+refunded\b/i,
  /\bfully\s+refunded\b/i,
  /\brefunded\s+in\s+(?:two|full)\b/i,
  /\bwas\s+(?:issued|posted|processed)\b/i,
  /\bwere\s+(?:issued|posted|processed)\b/i,
  /\bhas\s+been\s+(?:issued|posted|processed)\b/i,
  /\bhave\s+been\s+(?:issued|posted|processed)\b/i,
  /\balready\s+(?:issued|posted|processed)\b/i,
  /\bwe['’]?ve\s+refunded\b/i,
  /\bI['’]?ve\s+refunded\b/i,
  /\ba\s+partial\s+(?:refund\s+)?(?:plus|and)\s+(?:the\s+)?(?:completion|remainder)\b/i,
  /\bpartial\s+and\s+(?:the\s+)?completion\b/i,
  /\bsplit\s+(?:refund|into\s+two\s+(?:parts?|refunds?|postings?))\b/i,
  /\bposted\s+in\s+two\s+(?:parts?|postings?)\b/i,
  /\btwo\s+postings?\b/i,
];

/**
 * Signals the reply is talking about MORE than one order — if any of these fire, the
 * split-refund exemption is inapplicable regardless of tense (a split refund for a
 * single order can't span two orders).
 */
const MULTI_ORDER_MARKERS: RegExp[] = [
  /\b(?:each|both)\s+orders?\b/i,
  /\btwo\s+orders?\b/i,
  /\bthe\s+other\s+order\b/i,
  /\ba\s+second\s+order\b/i,
  /\ba\s+different\s+order\b/i,
];

/**
 * Forward-looking refund verbs — if any of these fire, the reply is OFFERING a remedy
 * (not just describing one), so the exemption never applies.
 */
const FUTURE_REFUND_VERBS: RegExp[] = [
  /\bI['’]?(?:ll|\s?will)\s+(?:issue|process|refund|initiate|set\s?up|start|generate|arrange|send)\b/i,
  /\bwe['’]?(?:ll|\s?will)\s+(?:issue|process|refund|initiate|set\s?up|start|generate|arrange|send)\b/i,
  /\bwill\s+be\s+(?:refunded|issued|processed|initiated|generated|sent)\b/i,
  /\bhappy\s+to\s+(?:issue|process|refund|initiate|set\s?up|generate|arrange|send)\b/i,
  /\blet\s+me\s+(?:issue|process|refund|initiate|set\s?up|generate|arrange|send)\b/i,
  /\bgoing\s+to\s+(?:issue|process|refund|initiate|set\s?up|generate|arrange|send)\b/i,
];

/**
 * Detects an arithmetic reconciliation: two dollar amounts + a third that equals their
 * sum, within a cent for float rounding. The ticket f2d898c9 canonical example:
 * "the $5.01 plus the $49.33 is the complete $54.34". Any triple of `$X, $Y, $Z` where
 * X + Y ≈ Z counts — the reconciliation shape is unmistakable in a refund reply.
 */
function containsSumReconciliation(reply: string): boolean {
  const amountRe = /\$\s?(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g;
  const amounts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = amountRe.exec(reply)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isFinite(n)) amounts.push(n);
  }
  if (amounts.length < 3) return false;
  for (let i = 0; i < amounts.length; i++) {
    for (let j = i + 1; j < amounts.length; j++) {
      for (let k = 0; k < amounts.length; k++) {
        if (k === i || k === j) continue;
        if (Math.abs(amounts[i] + amounts[j] - amounts[k]) < 0.02) return true;
      }
    }
  }
  return false;
}

/**
 * ⭐ Exemption for the "two refunds"-count match (ticket f2d898c9, mary arditi SC134282):
 * a fully-refunded order was posted as a $5.01 partial + $49.33 completion totaling
 * $54.34. When Sol drafted the correct explanation ("the $5.01 plus the $49.33 is the
 * complete $54.34"), MULTIPLE_REMEDY_PATTERNS[0] matched "two refunds" and false-blocked
 * the ledger-explanation as a bait. This detector recognises the DESCRIBING-not-OFFERING
 * shape so the count match doesn't fire on it.
 *
 * Conservative by construction — three exclusions must ALL hold before the exemption
 * applies:
 *   1. NO multi-order marker (a split refund lives on one order)
 *   2. NO forward-looking refund verb ("I'll issue", "we'll process", "happy to refund")
 *   3. AT LEAST ONE completed-refund marker OR an arithmetic sum reconciliation
 * A future-tense two-refund offer that happens to sum-reconcile ("I'll issue two
 * refunds — $5 and $10 totaling $15") is still blocked because #2 fails; a two-order
 * offer that sneaks in past-tense wording is still blocked because #1 fails.
 */
function isDescribingCompletedSplitRefund(reply: string): boolean {
  if (MULTI_ORDER_MARKERS.some((r) => r.test(reply))) return false;
  if (FUTURE_REFUND_VERBS.some((r) => r.test(reply))) return false;
  return (
    COMPLETED_REFUND_MARKERS.some((r) => r.test(reply)) ||
    containsSumReconciliation(reply)
  );
}

/**
 * The core assessor. Returns `{ ok: true }` when the reply is safe to send, or an
 * `{ ok: false, kind, reason, matched_phrase }` verdict when the send must be blocked.
 * Structural absurdity is checked first (fires regardless of verdict); the self-declared
 * mismatch check follows.
 */
export function assessSolReplyBaitRisk(ctx: SolReplyBaitContext): SolReplyBaitAssessment {
  const reply = (ctx.firstReply || "").trim();
  if (!reply) return { ok: true };

  for (const p of MULTIPLE_REMEDY_PATTERNS) {
    const m = reply.match(p);
    if (!m) continue;
    // Ticket f2d898c9 exemption: the "two refunds"-count match is skipped when the reply is
    // reconciling a split refund already posted to the ledger for ONE order (past-tense verbs
    // and/or an arithmetic sum, no multi-order marker, no forward-looking promise). The other
    // three patterns in MULTIPLE_REMEDY_PATTERNS are inherently multi-order or forward-looking
    // and never qualify.
    if (p === TWO_REFUNDS_COUNT_PATTERN && isDescribingCompletedSplitRefund(reply)) continue;
    return {
      ok: false,
      kind: "multiple_remedies_offered",
      reason:
        "reply stacks multiple remedies in one turn (the returns policy caps at one MBG return per customer for life — any offer of two returns/refunds/labels is a bait)",
      matched_phrase: m[0],
    };
  }

  // ⭐ PROMISE UNDER IGNORANCE. Fires regardless of verdict, like the structural check above: if we
  // have not identified the customer we cannot have established eligibility for ANY remedy, so
  // naming one is a promise we may have to break. Acknowledging and asking to identify them is
  // always available and is never blocked — only the promise is.
  if (ctx.customerIdentified === false) {
    for (const { pattern, label } of PROMISE_PATTERNS) {
      const m = reply.match(pattern);
      if (m) {
        return {
          ok: false,
          kind: "unverified_remedy_promise",
          reason: `the customer is NOT identified (no account resolved), so eligibility for a remedy cannot have been established — yet the reply promises one (${label}). Acknowledge and identify them first; a refund may be a renewal (categorically denied), outside the MBG window, not their first order, or their one lifetime return already used`,
          matched_phrase: m[0],
        };
      }
    }
  }

  const summary = (ctx.contextSummary || "").trim();
  const outOfPolicy = OUT_OF_POLICY_MARKERS.some((r) => r.test(summary));
  if (!outOfPolicy) return { ok: true };

  for (const { pattern, label } of PROMISE_PATTERNS) {
    const m = reply.match(pattern);
    if (m) {
      return {
        ok: false,
        kind: "out_of_policy_promise",
        reason: `Sol's context_summary declared the ask out-of-policy, but the reply promises a remedy (${label}) — the customer must not be baited toward the disallowed outcome`,
        matched_phrase: m[0],
      };
    }
  }
  return { ok: true };
}
