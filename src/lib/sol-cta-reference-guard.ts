/**
 * sol-cta-reference-guard — Phase 3 of
 * docs/brain/specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta.md.
 *
 * Extends the deterministic unbacked-claim guard family ([[claim-guard]] `unbackedEffectClaim`,
 * [[sol-outcome-claim-guard]] `assessOutcomeClaims`). Phase 3 covers a specific broken-promise
 * shape neither of the earlier guards catch: an outbound reply that REFERENCES a call-to-action
 * ("click the button below", "use the link", "click here", "here is your link", "tap the button")
 * while no journey/CTA was actually LAUNCHED for the ticket in this turn. That "click below" is
 * a phantom-CTA lie — the classic freeform-reply-with-no-mechanism failure the parent spec
 * targets. Block the send, mark the job `needs_attention` via `escalateTicket` with the
 * `blocked_unbacked_claim:cta_tail` reason (the same shape [[../inngest/triage-escalations]]
 * already routes for `blocked_unbacked_claim:*`), and force the operator to either LAUNCH the
 * journey (Phase 2's [[sol-direction-apply]] `applySolDirection`) or reword the reply.
 *
 * Design mirrors the sibling guards:
 *   - `detectCtaReference` is PURE — regex over the message, no DB or model call. Testable in
 *     `sol-cta-reference-guard.test.ts` with plain literals.
 *   - `hasLaunchedJourneyThisTurn` queries [[../tables/journey_sessions]] for a row on this
 *     ticket at-or-after `turn_started_at` (the `launchJourneyForTicket` effector always inserts
 *     one before the CTA reaches the customer). Fail-open on a DB probe error — a transient
 *     read failure must NOT strand a legit reply.
 *   - `assertCtaBackedByLaunch` is the wire-in composed from both. Callers (the ai_response /
 *     kb_response path in [[action-executor]], the Phase-2 direction-apply playbook step in
 *     [[../inngest/unified-ticket-handler]]) invoke this BEFORE the send fires and skip the
 *     delivery when `ok=false`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** One matched CTA phrase — echoed into the escalation reason and the sysNote so operators see
 * exactly which sentence tripped the guard. `pattern_name` is a stable label for tests + analytics. */
export interface CtaReferenceHit {
  matched_phrase: string;
  pattern_name: string;
}

/**
 * CTA-reference regexes. Coverage is intentionally conservative — a phrase must EITHER name a
 * clickable surface ("button", "link", "form"), the imperative-follow verb ("click", "tap",
 * "follow", "use"), OR a "below" / "here is your <surface>" locator. A message that doesn't
 * reference any of those doesn't trip the guard (verification bullet 3 — no false-positive on
 * incidental phrases).
 */
const CTA_REFERENCE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "click_the_button_below", re: /\bclick\s+(?:the\s+|this\s+)?(?:button|link)\s+below\b/i },
  { name: "click_below", re: /\bclick\s+below\b/i },
  { name: "click_the_link", re: /\bclick\s+(?:the\s+|this\s+|on\s+the\s+)?link\b/i },
  { name: "click_here", re: /\bclick\s+here\b/i },
  { name: "tap_the_button", re: /\btap\s+(?:the\s+|this\s+)?(?:button|link|below)\b/i },
  { name: "use_the_link", re: /\buse\s+(?:the\s+|this\s+|below\s+|my\s+|our\s+)?(?:link|button|form)\b/i },
  { name: "use_link_below", re: /\buse\s+(?:the\s+)?(?:link|button|form)\s+below\b/i },
  { name: "button_below", re: /\bbutton\s+below\b/i },
  { name: "link_below", re: /\blink\s+below\b/i },
  { name: "follow_the_link", re: /\bfollow\s+(?:the\s+|this\s+)?link\b/i },
  { name: "here_is_the_link", re: /\bhere\s+(?:is|are)\s+(?:your|a|the)\s+(?:link|button|form)\b/i },
  {
    // "you can manage/cancel/pause via the button below/link/form"
    name: "manage_via_button",
    re: /\b(?:manage|cancel|pause|resume|reactivate|update|change)\s+(?:it|your\s+\w+\s*)?(?:via|through|using|with)\s+(?:the\s+)?(?:button|link|form)\b/i,
  },
];

/**
 * Pure detector. Returns the first matched pattern or null. Deterministic — no I/O.
 */
export function detectCtaReference(message: string | null | undefined): CtaReferenceHit | null {
  if (!message) return null;
  for (const p of CTA_REFERENCE_PATTERNS) {
    const m = message.match(p.re);
    if (m) return { matched_phrase: m[0], pattern_name: p.name };
  }
  return null;
}

export interface HasLaunchedContext {
  admin: SupabaseClient;
  workspace_id: string;
  ticket_id: string;
  turn_started_at: string;
}

/**
 * Returns true if [[../tables/journey_sessions]] has a row for this workspace + ticket created at
 * or after `turn_started_at` — the marker `launchJourneyForTicket` writes before the CTA reaches
 * the customer. Fail-open on a DB probe error (learning #6 — the guard is a defensive add, a
 * transient read failure must NOT strand a legit reply).
 *
 * Re-asserts BOTH `workspace_id` AND `ticket_id` in the query so a foreign-workspace session
 * cannot back a claim on this ticket (learning #7 — narrow the enumeration to the correct scope).
 */
export async function hasLaunchedJourneyThisTurn(ctx: HasLaunchedContext): Promise<boolean> {
  try {
    const { data } = await ctx.admin
      .from("journey_sessions")
      .select("id")
      .eq("workspace_id", ctx.workspace_id)
      .eq("ticket_id", ctx.ticket_id)
      .gte("created_at", ctx.turn_started_at)
      .limit(1);
    return (data?.length ?? 0) > 0;
  } catch {
    // Fail-open — a transient DB error must never over-block a legitimate reply.
    return true;
  }
}

export type CtaGuardAssessment =
  | { ok: true }
  | { ok: false; hit: CtaReferenceHit; reason: string };

/**
 * Top-level wire-in. If the message references a CTA phrase, verify that a journey was launched
 * for this ticket at-or-after `turn_started_at`. Returns `{ ok: false, hit, reason }` when the
 * reference is unbacked so the caller can:
 *   1. sysNote the exact matched phrase (operator debugging surface).
 *   2. `escalateTicket(ctx, 'blocked_unbacked_claim:cta_tail')` — routes the job to
 *      `needs_attention` via the existing [[../inngest/triage-escalations]] `blocked_unbacked_claim:*`
 *      selection rule.
 *   3. Skip the outbound send entirely — the reply never reaches the customer.
 *
 * Reason string is prefixed `blocked_unbacked_claim:cta_tail` so a downstream test can pin the
 * exact escalation-code shape (verification bullet 1).
 */
export async function assertCtaBackedByLaunch(input: {
  admin: SupabaseClient;
  workspace_id: string;
  ticket_id: string;
  message: string | null | undefined;
  turn_started_at: string;
}): Promise<CtaGuardAssessment> {
  const hit = detectCtaReference(input.message);
  if (!hit) return { ok: true };
  const launched = await hasLaunchedJourneyThisTurn({
    admin: input.admin,
    workspace_id: input.workspace_id,
    ticket_id: input.ticket_id,
    turn_started_at: input.turn_started_at,
  });
  if (launched) return { ok: true };
  return {
    ok: false,
    hit,
    reason: `blocked_unbacked_claim:cta_tail message references a CTA ("${hit.matched_phrase}") but no journey was launched this turn`,
  };
}
