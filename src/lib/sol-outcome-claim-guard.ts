/**
 * sol-outcome-claim-guard — Phase 3 of docs/brain/specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified.md.
 *
 * The **message-is-last** send guard. Extends [[sol-policy-bait-guard]] with a stronger check:
 * a customer-facing message may CLAIM a required outcome (e.g. "I added a second bag to your
 * next order", "I applied a $15 credit", "here is your prepaid return label") only if the
 * ticket's ticket_required_outcomes row for that outcome is status='verified'. A message that
 * asserts an unverified claim is BLOCKED (never reaches the customer) and the turn's
 * ticket_resolution_events row is stamped verified_outcome='unbacked' — the M1 inline-verify
 * bounce the brain used to mark "none yet".
 *
 * Design mirrors sol-policy-bait-guard.ts:
 *   - `assessOutcomeClaims` is PURE — regex over the message text + the stored outcome list, no
 *     DB or model call. Testable via node:test with fake outcomes.
 *   - `assertClaimsBackedByOutcomes` is the wire-in — loads outcomes via
 *     [[ticket-required-outcomes]] `listRequiredOutcomes`, calls the predicate, stamps the ledger
 *     'unbacked' on block. Callers at every send site (Sol box reply, executeSonnetDecision,
 *     playbook/journey, Improve tab) invoke this before the send fires.
 *
 * Derived-from-ticket 0a9e4d7f (Judy) — Sol's reply claimed "I've added a second bag + applied
 * a $15 credit" while neither action had actually run. The pattern set is seeded with the four
 * Judy-adjacent kinds (add_bag_to_next_order, apply_coupon, partial_refund, create_replacement)
 * plus the common lifecycle actions (cancel, pause, resume, create_return).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  listRequiredOutcomes,
  type TicketRequiredOutcome,
  type RequiredOutcomeStatus,
} from "./ticket-required-outcomes";

/**
 * Per-kind CLAIM PATTERNS the guard scans the message for. A pattern match means the message is
 * ASSERTING that specific kind of outcome. Coverage is intentionally conservative — the seed set
 * targets Judy's exact failure mode plus the common lifecycle actions. A kind absent from this
 * map is skipped (fail open) so a novel action type can't over-block a legitimate reply.
 *
 * Patterns match:
 *   - past-tense completion claims ("I've added a second bag", "applied a $15 credit")
 *   - future-tense promise claims ("I'll add a second bag", "we'll issue a refund") — a promise
 *     is still an assertion of the outcome, so Judy's "no problem, I'll add that right now"
 *     variant is blocked exactly like the past-tense variant.
 *   - "your next order will include a bag" / "your subscription is cancelled" — third-person
 *     assertions about the customer's state.
 *
 * Patterns do NOT match:
 *   - a QUESTION about the outcome ("would you like me to add a bag?") — no assertion.
 *   - a bare VERB ("I can add a bag if you want") — offer, not a claim.
 *   - a REFERENCE to policy ("subscription renewals aren't eligible for return") — same design
 *     as sol-policy-bait-guard's promise-vs-reference distinction.
 */
export const CLAIM_KIND_PATTERNS: Record<string, RegExp[]> = {
  add_bag_to_next_order: [
    // past-tense completion: "added a second bag", "I've added a second bag of chocolate", "we've added an extra bag to your next order"
    /\b(?:I['’]?ve|we['’]?ve|I have|we have|just|)\s*added\s+(?:a |an |the |your |in |another )*(?:second |2nd |third |3rd |extra |another |additional )?bag\b/i,
    // future-tense promise: "I'll add a second bag", "we're going to add a bag", "we'll add another bag to your next order"
    /\b(?:I['’]?ll|we['’]?ll|I['’]?m going to|we['’]?re going to|will)\s+add\s+(?:a |an |the |your |in |another )*(?:second |2nd |third |3rd |extra |another |additional )?bag\b/i,
    // third-person assertion: "your next order will include a bag", "your upcoming order has a second bag"
    /\byour (?:next |upcoming )order (?:will |now |already )?(?:includes?|has|contains|comes with)\s+(?:a |an |the |your |another )?(?:second |2nd |third |extra |another |additional )?bag/i,
  ],
  apply_coupon: [
    // past: "applied a $15 credit", "credited $15 to your next order", "added a 15% discount"
    /\b(?:applied|added|credited|issued)\s+(?:you |your )?(?:a |an |the |your )?[$€£]?\d+(?:\.\d+)?\s*%?\s*(?:credit|discount|off|coupon|to your (?:next |upcoming )?(?:order|subscription|account))/i,
    // "gave you a $15 credit"
    /\b(?:gave you|given you|comp['’]?ed you)\s+(?:a |an |the )?[$€£]?\d+(?:\.\d+)?\s*(?:credit|discount|off|coupon)/i,
    // future promise: "I'll apply a $15 credit"
    /\b(?:I['’]?ll|we['’]?ll|I['’]?m going to|we['’]?re going to)\s+(?:apply|add|credit|issue)\s+(?:you )?(?:a |an |the |your )?[$€£]?\d+(?:\.\d+)?\s*(?:credit|discount|off|coupon)/i,
  ],
  partial_refund: [
    // past: "issued a $25 refund", "refunded $25", "processed your refund"
    /\b(?:issued|processed|initiated|refunded)\s+(?:you )?(?:a |an |the |your )?[$€£]?\d+(?:\.\d+)?\s*(?:refund|back|to your card)/i,
    /\b(?:refund of|refunded)\s+[$€£]?\d/i,
    // "your refund has been issued"
    /\byour refund (?:is|has been|was) (?:issued|processed|initiated|complete)/i,
    // future: "I'll issue a $25 refund"
    /\b(?:I['’]?ll|we['’]?ll|I['’]?m going to|we['’]?re going to)\s+(?:issue|process|initiate|refund)\s+(?:you )?(?:a |an |the |your )?[$€£]?\d+(?:\.\d+)?\s*(?:refund|back)/i,
  ],
  create_replacement: [
    // past: "created a replacement", "set up a replacement", "arranged a replacement"
    /\b(?:I['’]?ve|we['’]?ve|I have|we have|just|)\s*(?:created|set up|arranged|initiated|shipped)\s+(?:you )?(?:a |the |your )?replacement/i,
    // "your replacement is on the way / has shipped"
    /\byour replacement (?:is (?:on the way|shipping|being (?:shipped|processed))|has (?:been )?(?:shipped|created|processed))/i,
    // future: "I'll send a replacement", "we'll ship a replacement"
    /\b(?:I['’]?ll|we['’]?ll|I['’]?m going to|we['’]?re going to)\s+(?:send|ship|create|set up|arrange)\s+(?:you )?(?:a |an |the |your )?replacement/i,
  ],
  create_return: [
    // "here is your prepaid label" / "attached is your return label" / "here is your prepaid return label"
    /\b(?:here|attached|below)\s+(?:is|are)\s+(?:your |the )?(?:prepaid |return |shipping )*labels?\b/i,
    // past: "created a return", "set up a return"
    /\b(?:I['’]?ve|we['’]?ve|I have|we have|just|)\s*(?:created|set up|arranged|initiated)\s+(?:you )?(?:a |the |your )?return\b/i,
    // future: "I'll create a return"
    /\b(?:I['’]?ll|we['’]?ll|I['’]?m going to|we['’]?re going to)\s+(?:create|set up|arrange|start)\s+(?:you )?(?:a |the |your )?return\b/i,
  ],
  cancel: [
    // past: "I've cancelled your subscription", "your subscription has been cancelled"
    /\b(?:I['’]?ve|we['’]?ve|I have|we have|just|)\s*cancell?ed\s+(?:your |the )?(?:subscription|next|upcoming)/i,
    /\byour subscription (?:is |has been |was )cancell?ed/i,
    // future
    /\b(?:I['’]?ll|we['’]?ll|I['’]?m going to|we['’]?re going to)\s+cancel\s+(?:your |the )?(?:subscription|next|upcoming)/i,
  ],
  pause: [
    /\b(?:I['’]?ve|we['’]?ve|I have|we have|just|)\s*paused?\s+(?:your |the )?subscription\b/i,
    /\byour subscription (?:is |has been |was )paused\b/i,
    /\b(?:I['’]?ll|we['’]?ll|I['’]?m going to|we['’]?re going to)\s+pause\s+(?:your |the )?subscription/i,
  ],
  resume: [
    /\b(?:I['’]?ve|we['’]?ve|I have|we have|just|)\s*(?:resumed|reactivated)\s+(?:your |the )?subscription\b/i,
    /\byour subscription (?:is |has been |was )(?:resumed|reactivated|active again)\b/i,
    /\b(?:I['’]?ll|we['’]?ll|I['’]?m going to|we['’]?re going to)\s+(?:resume|reactivate)\s+(?:your |the )?subscription/i,
  ],
};

/** One CLAIM the guard blocked — the reply asserted this, the backing row wasn't verified. */
export interface BlockedClaim {
  outcome_id: string;
  kind: string;
  description: string;
  /** The status the outcome row was in when the guard fired — pending / done / failed. */
  current_status: RequiredOutcomeStatus;
  /** The exact phrase in the message that matched — echoed into the escalation reason. */
  matched_phrase: string;
}

/** Verdict shape mirrors sol-policy-bait-guard.SolReplyBaitAssessment so callers can compose. */
export type OutcomeClaimAssessment =
  | { ok: true }
  | { ok: false; blocked_claims: BlockedClaim[]; reason: string };

/** Input to the pure predicate — the message + the outcomes list (pre-loaded by the caller). */
export interface OutcomeClaimContext {
  message: string;
  outcomes: TicketRequiredOutcome[];
}

/**
 * Pure predicate. For each outcome row whose status is NOT 'verified', check the message for a
 * kind-specific claim pattern. If any match, the reply is BLOCKED — the matched phrase and the
 * row's identity are surfaced so the caller can log the exact reason and rewrite (or hold for
 * needs_human).
 *
 * Fail-open on unknown kinds — a kind absent from CLAIM_KIND_PATTERNS produces no patterns to
 * scan, so we can't detect a claim on it. That is the intentional trade: false negatives (a
 * novel action type slips through) are recoverable via the Phase-4 completion gate; false
 * positives (a legit reply on a novel kind is blocked) would strand tickets in needs_human on
 * every new action introduction.
 */
export function assessOutcomeClaims(ctx: OutcomeClaimContext): OutcomeClaimAssessment {
  const message = (ctx.message || "").trim();
  if (!message) return { ok: true };

  const blocked: BlockedClaim[] = [];
  for (const outcome of ctx.outcomes) {
    if (outcome.status === "verified") continue;
    const patterns = CLAIM_KIND_PATTERNS[outcome.kind];
    if (!patterns || patterns.length === 0) continue;
    for (const p of patterns) {
      const m = message.match(p);
      if (m) {
        blocked.push({
          outcome_id: outcome.id,
          kind: outcome.kind,
          description: outcome.description,
          current_status: outcome.status,
          matched_phrase: m[0],
        });
        break;
      }
    }
  }

  if (blocked.length === 0) return { ok: true };
  const reasonParts = blocked.map(
    (b) => `"${b.description}" (status=${b.current_status}, matched "${b.matched_phrase.slice(0, 80)}")`,
  );
  return {
    ok: false,
    blocked_claims: blocked,
    reason: `message asserts ${blocked.length} unverified outcome(s): ${reasonParts.join("; ")}`,
  };
}

/**
 * Stamp `ticket_resolution_events.verified_outcome='unbacked'` on a specific turn row. Idempotent
 * compare-and-set on `verified_at IS NULL` + workspace_id (learning #5 — re-assert the read-time
 * predicate in the write; a racing verify-write can't overwrite this stamp and vice-versa).
 * Never throws — the ledger stamp is a diagnostic, not a critical path (same invariant as
 * action-executor's stampers).
 */
export async function stampUnbackedOnLedger(
  admin: SupabaseClient,
  input: { workspace_id: string; resolution_event_id: string },
): Promise<void> {
  try {
    await admin
      .from("ticket_resolution_events")
      .update({
        verified_at: new Date().toISOString(),
        verified_outcome: "unbacked",
      })
      .eq("id", input.resolution_event_id)
      .eq("workspace_id", input.workspace_id)
      .is("verified_at", null);
  } catch {
    // Never fail the guard because the ledger stamp failed.
  }
}

/**
 * The top-level wire-in. Load the ticket's required outcomes, call the pure predicate, and — on
 * block — stamp the current turn's ledger row `unbacked` when the caller has one. Callers
 * (builder-worker's Sol box reply site, executeSonnetDecision's stampedSend, playbook/journey
 * dispatchers, Improve tab manual sends) invoke this AFTER assessSolReplyBaitRisk passes and
 * BEFORE the customer-facing delivery fires.
 *
 * The `resolution_event_id` is OPTIONAL — the Sol box reply site (builder-worker) doesn't have a
 * ticket_resolution_events row it owns for the turn yet, so it calls without one and only relies
 * on the block behavior. Every other caller does have the id and passes it, so the 'unbacked'
 * stamp lands where the write-ahead ledger is being read.
 */
export async function assertClaimsBackedByOutcomes(input: {
  admin: SupabaseClient;
  workspace_id: string;
  ticket_id: string;
  message: string;
  resolution_event_id?: string;
}): Promise<OutcomeClaimAssessment> {
  const outcomes = await listRequiredOutcomes(input.admin, input.ticket_id, {
    workspace_id: input.workspace_id,
  });
  const assessment = assessOutcomeClaims({ message: input.message, outcomes });
  if (assessment.ok) return assessment;
  if (input.resolution_event_id) {
    await stampUnbackedOnLedger(input.admin, {
      workspace_id: input.workspace_id,
      resolution_event_id: input.resolution_event_id,
    });
  }
  return assessment;
}
