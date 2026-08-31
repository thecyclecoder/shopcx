/**
 * playbook-repeat-guard — Pure predicate for "is this playbook about to send a customer-facing
 * question substantially identical to the last one it sent on the same ticket?" Extracted from
 * src/lib/inngest/unified-ticket-handler.ts so a unit test can pin every equivalence rule and
 * the handler stays a thin DB read + a single call to this helper + an escalation branch.
 *
 * Why this exists (docs/brain/specs/playbook-drift-classifier-sees-the-pending-question.md
 * § Phase 2, ticket 8e2c87d6 — Suzanne Ross, 2026-08-24): the Replacement Order playbook asked
 * "did you not receive your order at all?", her reply was misclassified NEW_TOPIC (Phase 1
 * closes that gap), and the playbook re-ran the SAME question on the very next turn — and,
 * in a second incident, re-asked her to confirm the same address. A playbook that asks the
 * same thing twice has not gathered information, it has lost state. Asking a third time is
 * never the right move: the customer pays for it in round trips, and — in the Suzanne case —
 * the orchestrator eventually fabricated a reassurance that the package was "currently in
 * transit" on a shipment whose last carrier scan was 11 days old. The customer-facing
 * consequence of a lost playbook must never be a third identical question.
 *
 * How the handler uses it: before sending `pbResult.response`, look up the most recent
 * outbound external `author_type='ai'` [[ticket_messages]] row on the ticket (the last thing
 * the playbook said), pass both bodies through `detectRepeatQuestion`, and — on `repeat:true`
 * — DO NOT send. Instead route through the same `raiseHoldingMessageEscalation` closure the
 * `escalate_api_failure` branch uses, with a sysNote naming the repeated question so the
 * defect is visible in the thread rather than silently absorbed by the customer.
 *
 * Kept pure (no DB, no imports from the runtime handler) — the handler passes strings and a
 * unit test exercises every equivalence rule (see playbook-repeat-guard.test.ts).
 */

/** Inputs the handler hands the predicate. */
export interface PlaybookRepeatInputs {
  /** The playbook's next response text, pre-send (plain text from `wrapResponse`). */
  pending: string;
  /** Body of the most recent outbound external AI ticket_messages row on this ticket (HTML). Null
   *  when this is the first playbook message on the ticket, in which case nothing can repeat. */
  lastOutbound: string | null;
}

/** Return shape: `repeat:false` when the guard passes; `repeat:true` carries a short plain-
 *  English note the caller uses for the sysNote + escalation_reason. */
export type PlaybookRepeatVerdict =
  | { repeat: false }
  | { repeat: true; note: string };

/**
 * Minimum normalized-token count on BOTH sides before Jaccard can trip. Below this the two
 * texts are too small for the token-set similarity to be reliable; the guard falls back to
 * exact / substring equivalence only. Prevents a two-word ack ("thanks anyway") from being
 * flagged as a repeat of another two-word ack that happens to share a token.
 */
const MIN_TOKENS_FOR_JACCARD = 5;

/**
 * Jaccard threshold. 0.80 catches the Suzanne case (the second ask carries the identical
 * question sentence with only intro/sign-off boilerplate differing) while still leaving
 * headroom for a genuinely different question that happens to share ~half its vocabulary
 * with the prior one (e.g. "what's your order number?" vs "what's your subscription number?").
 */
const JACCARD_THRESHOLD = 0.80;

/**
 * Very short messages need EXACT-normalized equality to flag as a repeat — the token-set
 * math is too noisy on <= 4 tokens. A 3-word ack that happens to repeat the prior 3-word
 * ack is still a lost-state signal; longer messages get the fuzzier Jaccard route.
 */
const SHORT_MESSAGE_TOKEN_CEILING = 4;

/**
 * Strip HTML tags, common entities, personality-driven greeting/sign-off boilerplate, and
 * whitespace/case. The stored `ticket_messages.body` is HTML (from `toHtml(msg)` in the
 * send path); `pbResult.response` is plain text pre-HTML. Both must normalize to the same
 * shape for equivalence to hold.
 */
export function normalizeForRepeatCheck(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")             // strip HTML tags
    .replace(/&nbsp;/gi, " ")             // common entities the send path can inject
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&[a-z0-9#]+;/gi, " ")       // any remaining entity
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract normalized word tokens (>= 3 chars, letters/digits only). Used for the Jaccard
 * similarity route. The 3-char floor drops articles / conjunctions ("a", "an", "of", "to")
 * without over-filtering domain words like "sub" or "eta".
 */
function tokenize(normalized: string): string[] {
  return normalized
    .split(/[^a-z0-9']+/)
    .filter((tok) => tok.length >= 3);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const tok of a) if (b.has(tok)) intersect++;
  return intersect / (a.size + b.size - intersect);
}

/**
 * Truncate a normalized string for the sysNote / escalation_reason payload so a repeated
 * multi-paragraph question doesn't overflow into the Slack payload. First 140 chars of the
 * normalized pending text — enough for the human reviewer to recognize what was repeated.
 */
function excerptForNote(normalized: string): string {
  if (normalized.length <= 140) return normalized;
  return normalized.slice(0, 137).trimEnd() + "…";
}

/**
 * Predicate. Returns `repeat:true` when the pending playbook response is substantially
 * identical to the last outbound AI message on the same ticket. Guards:
 *   1. No `lastOutbound` → nothing can repeat.
 *   2. Empty normalized `pending` → nothing meaningful to check.
 *   3. Normalized exact match OR one contains the other after normalize → repeat.
 *   4. Both sides have enough tokens AND Jaccard >= threshold → repeat.
 * Otherwise → repeat:false.
 */
export function detectRepeatQuestion(inputs: PlaybookRepeatInputs): PlaybookRepeatVerdict {
  const { pending, lastOutbound } = inputs;
  if (!lastOutbound) return { repeat: false };

  const p = normalizeForRepeatCheck(pending);
  const l = normalizeForRepeatCheck(lastOutbound);
  if (!p || !l) return { repeat: false };

  // Exact match after normalization — the strongest possible repeat signal.
  if (p === l) {
    return {
      repeat: true,
      note: `the playbook was about to send a message it already sent verbatim on this ticket ("${excerptForNote(p)}")`,
    };
  }

  // One fully contains the other after normalization — the boilerplate-differs case where
  // the second ask drops the greeting intro but keeps the identical question sentence.
  if (l.includes(p) || p.includes(l)) {
    return {
      repeat: true,
      note: `the playbook was about to re-send content it already sent on this ticket ("${excerptForNote(p)}")`,
    };
  }

  const pTokens = new Set(tokenize(p));
  const lTokens = new Set(tokenize(l));

  // Short-message safety: don't Jaccard-flag two very short messages that happen to share
  // a couple tokens; only exact / substring equivalence can trip them.
  if (pTokens.size <= SHORT_MESSAGE_TOKEN_CEILING || lTokens.size <= SHORT_MESSAGE_TOKEN_CEILING) {
    return { repeat: false };
  }

  if (pTokens.size < MIN_TOKENS_FOR_JACCARD || lTokens.size < MIN_TOKENS_FOR_JACCARD) {
    return { repeat: false };
  }

  const score = jaccard(pTokens, lTokens);
  if (score >= JACCARD_THRESHOLD) {
    return {
      repeat: true,
      note: `the playbook was about to re-ask a question substantially identical to the last one it sent on this ticket (similarity ${(score * 100).toFixed(0)}%, "${excerptForNote(p)}")`,
    };
  }

  return { repeat: false };
}
