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
 * ticket routes to needs_human so a person re-drafts via the Improve tab.
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
}

export type SolReplyBaitAssessment =
  | { ok: true }
  | {
      ok: false;
      kind: "out_of_policy_promise" | "multiple_remedies_offered";
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
 */
const MULTIPLE_REMEDY_PATTERNS: RegExp[] = [
  /\b(?:two|2)\s+(?:returns?|refunds?|prepaid labels?|store credits?|exchanges?|replacements?)\b/i,
  /\bboth\s+(?:returns?|refunds?|orders?)\s+(?:can be|will be|are eligible|are returnable|are refundable)/i,
  /\ba\s+return\s+for\s+each\s+order\b/i,
  /\bone\s+for\s+each\s+of\s+(?:the\s+)?(?:two|both)\s+(?:orders?|renewals?)\b/i,
];

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
    if (m) {
      return {
        ok: false,
        kind: "multiple_remedies_offered",
        reason:
          "reply stacks multiple remedies in one turn (the returns policy caps at one MBG return per customer for life — any offer of two returns/refunds/labels is a bait)",
        matched_phrase: m[0],
      };
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
