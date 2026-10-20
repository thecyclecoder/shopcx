/**
 * Deterministic automated-sender pre-filter for the outreach short-circuit.
 *
 * Phase 2 of docs/brain/specs/outreach-tickets-deterministically-close-no-sol-dispatch-no-ai-cost.md.
 * Fires BEFORE the classify-bucket Haiku step in the unified-ticket-handler so an inbound from a
 * known automated / no-reply sender (App Store receipts, TestFlight notifications, mailer daemons,
 * GitHub notifications, …) is closed + tagged `outreach` without paying for the classifier turn.
 *
 * Design intent (from the spec): CONSERVATIVE. False-positive-averse. A genuine customer email
 * from a normal address must never trip this filter — humans still route through the Haiku
 * classifier + Phase 1's deterministic close for the harder cases (brand-collab / UGC pitch).
 *
 * Pure module, no side effects. All predicates take primitives and return boolean, which keeps
 * them unit-testable under `node --test` without an Inngest/Supabase harness.
 */

/**
 * Local-part patterns that mark the sender as automated. Matched with `.test()` so any occurrence
 * inside the local part counts (spec calls out `testflight_no_reply@email.apple.com` — the
 * `no_reply` substring must trip the filter even though it's not a prefix).
 */
const NO_REPLY_LOCAL_RE = /(no[-_]?reply|donotreply|do[-_]not[-_]reply)/i;

/**
 * Standalone automated-mailer local parts (must match the FULL local part — `postmaster@x.com`
 * counts, `postmaster.eu@x.com` does not, so a real human whose handle happens to contain
 * "bounce" isn't tripped).
 */
const AUTOMATED_MAILER_LOCAL_RE = /^(mailer[-_]daemon|postmaster|bounces?)$/i;

/**
 * Known automated-notification domains. Match either the exact domain or any subdomain
 * (`d === domain || domain.endsWith("." + d)`) so both `email.apple.com` and
 * `push.email.apple.com` count. Kept intentionally narrow — a domain here means EVERY inbound
 * from it will be closed without reply, so only add senders that are 100% automated.
 */
const AUTOMATED_DOMAINS: readonly string[] = [
  "email.apple.com",           // App Store receipts, TestFlight notifications, iCloud alerts
  "bounces.google.com",         // GSuite bounces
  "noreply.github.com",         // GitHub notification emails
  "notify.trustpilot.com",      // Trustpilot review requests
];

/**
 * Body-content markers that only appear in automated messages. Every phrase here would be
 * surprising to see in a genuine customer email, so tripping the pre-filter on any one of them
 * is safe. Kept short + specific per the spec's false-positive-averse mandate.
 */
const AUTOMATED_BODY_MARKERS: readonly RegExp[] = [
  /please do not reply to this (email|message)/i,
  /this (mailbox|inbox|email address) is not monitored/i,
  /this is an automated (email|message|notification|response)/i,
  /you are receiving this (email|message) because you (are subscribed|have subscribed|subscribed|opted in)/i,
];

/**
 * Deterministic: does the from-address look like an automated sender that should never trigger
 * a customer-service handling session? Conservative — the spec calls for false-positive-averse
 * detection so a real customer email from a normal address never trips.
 *
 * @param fromAddress — inbound email's From field, or the customer's registered email (which
 *   equals the From address on inbound-email tickets since the customer row is created from
 *   the sender). Null / empty / malformed returns false.
 */
export function isAutomatedSender(fromAddress: string | null | undefined): boolean {
  if (!fromAddress) return false;
  const addr = fromAddress.toLowerCase().trim();
  const at = addr.lastIndexOf("@");
  if (at <= 0 || at === addr.length - 1) return false;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  if (NO_REPLY_LOCAL_RE.test(local)) return true;
  if (AUTOMATED_MAILER_LOCAL_RE.test(local)) return true;
  if (AUTOMATED_DOMAINS.some(d => domain === d || domain.endsWith("." + d))) return true;
  return false;
}

/**
 * Deterministic: does the inbound body carry an unambiguous automated-notification marker?
 * Complements `isAutomatedSender` — either signal is sufficient per the spec. Kept narrow to
 * avoid tripping on a real customer who happens to quote automated boilerplate.
 *
 * @param body — inbound message body (raw or cleaned). Null / empty returns false.
 */
export function bodyHasAutomatedMarker(body: string | null | undefined): boolean {
  if (!body) return false;
  return AUTOMATED_BODY_MARKERS.some(re => re.test(body));
}

/**
 * Combined predicate: is this inbound message a deterministically-detectable automated
 * notification? Called by the unified-ticket-handler pre-filter BEFORE the classify-bucket
 * Haiku step so a true return path costs zero AI dollars.
 */
export function isAutomatedInbound(
  fromAddress: string | null | undefined,
  body: string | null | undefined,
): boolean {
  return isAutomatedSender(fromAddress) || bodyHasAutomatedMarker(body);
}

/**
 * Out-of-office / auto-reply body markers. These are the vacation-bounce + "automatic reply"
 * class the active 'Auto-replies/OOO bounces — close, don't respond' policy rule recognizes.
 * A genuine customer never opens a message with "I am currently out of office" — so matching
 * one is a safe signal that the inbound carries no actionable ask.
 */
const AUTO_REPLY_BODY_MARKERS: readonly RegExp[] = [
  /\b(?:out of (?:the )?office|away from (?:my|the) (?:desk|office|email|inbox))\b/i,
  /\bautomatic reply\b/i,
  /\bauto[-\s]?reply\b/i,
  /\bon (?:vacation|holiday|annual leave|parental leave|maternity leave)\b/i,
  /\bi(?:'| a)m currently (?:out|away|unavailable|on leave)\b/i,
  /\bi will be (?:out of (?:the )?office|away|unavailable)\b/i,
];

/**
 * Vendor-notification / legal-policy blast markers — the GemX class from ticket
 * f3977ec6 ("We've updated our Terms of Service and Privacy Policy"). These are written in a
 * vendor's broadcast voice, never a customer's: a notification ABOUT the sender's own terms /
 * privacy / cookie policy, not a request from our customer. The 'change' cue
 * (/\b(?:change|modify|update|edit)\b/) matches the word "updated" inside such a blast and
 * would otherwise be mis-read as an unsatisfied change request, re-sessioning Sol forever. Kept
 * vendor-voiced + policy-scoped so a real customer asking us to "update my address" never trips.
 */
const VENDOR_NOTIFICATION_BODY_MARKERS: readonly RegExp[] = [
  /\bwe(?:'ve| have) (?:recently )?(?:updated|made changes to|revised|changed)\b[\s\S]{0,60}\b(?:terms|privacy|policy|policies|cookie)\b/i,
  /\b(?:update|updates|changes?|revisions?) to our\b[\s\S]{0,20}\b(?:terms|privacy policy|terms of service|terms (?:&|and) conditions|policies)\b/i,
  /\bour (?:updated|new|revised) (?:terms of service|privacy policy|terms (?:&|and) conditions|cookie policy)\b/i,
  /\b(?:changes|updates) to (?:our|the) (?:terms of service|privacy policy|terms (?:&|and) conditions)\b/i,
];

/**
 * Chargeback-mitigation / dispute-vendor blast markers — the chargebackgurus.com / FPRONE class
 * from ticket 5dcb1240. A dispute-alert vendor bot resends an identical automated template asking
 * us to "attempt refund" for a dispute Alert ID — no order number, amount, card, or merchant
 * descriptor, and no matching charge on our side. The template is written in the vendor's own
 * dispute-network voice, never a customer's. The 'refund' cue in `findUnsatisfiedCustomerRequests`
 * matches it and downgrades a correct `close_no_action` into an endless Sol re-session loop (the
 * same loop class the GemX Terms/Privacy blast caused — see VENDOR_NOTIFICATION_BODY_MARKERS).
 *
 * Kept vendor-voiced + dispute-scoped so a real customer asking for a refund never trips:
 *   - FPRONE / FPR-ONE — the pre-dispute alert network signature, never in a customer email.
 *   - "ChargebackGurus" — the vendor's own name appearing in the body.
 *   - "Alert ID" paired (within 80 chars, either order) with a dispute/chargeback/refund/gateway/
 *     descriptor cue — the dispute-alert identifier a customer would never cite.
 *   - vendor-voiced "attempt (a) refund … in (the) Gateway / for the Alert / to avoid a chargeback"
 *     (a customer says "I want a refund" / "please refund me", not "attempt a refund in the Gateway").
 */
const CHARGEBACK_VENDOR_BODY_MARKERS: readonly RegExp[] = [
  /\bfpr[-\s]?one\b/i,
  /\bchargeback\s*gurus\b/i,
  /\balert id\b[\s\S]{0,80}\b(?:refund|chargeback|dispute|gateway|descriptor)\b/i,
  /\b(?:refund|chargeback|dispute|gateway|descriptor)\b[\s\S]{0,80}\balert id\b/i,
  /\battempt(?:ing)? (?:a |an |to )?refund\b[\s\S]{0,60}\b(?:gateway|alert|dispute|chargeback)\b/i,
];

/**
 * Known chargeback / dispute-mitigation vendor sender domains. Match the exact domain or any
 * subdomain. A ticket whose From address is on one of these is a dispute-vendor blast, never a
 * customer — safe to exempt from the close_no_action unsatisfied-request guard. Kept narrow: only
 * domains that are 100% dispute-vendor automation (sender support@/abdulsalam.a@chargebackgurus.com
 * in ticket 5dcb1240).
 */
const CHARGEBACK_VENDOR_DOMAINS: readonly string[] = [
  "chargebackgurus.com",
];

/**
 * Does the inbound body carry a chargeback-mitigation / dispute-vendor template marker
 * (ticket 5dcb1240)? Scoped to the close-gate exemption only — see CHARGEBACK_VENDOR_BODY_MARKERS.
 */
function bodyHasChargebackVendorMarker(body: string | null | undefined): boolean {
  if (!body) return false;
  return CHARGEBACK_VENDOR_BODY_MARKERS.some(re => re.test(body));
}

/**
 * Does the From address sit on a known chargeback / dispute-mitigation vendor domain
 * (ticket 5dcb1240)? Mirrors `isAutomatedSender`'s domain match but is scoped to the close-gate
 * exemption, so adding a dispute-vendor domain never auto-closes a customer ticket.
 */
function isChargebackVendorSender(fromAddress: string | null | undefined): boolean {
  if (!fromAddress) return false;
  const addr = fromAddress.toLowerCase().trim();
  const at = addr.lastIndexOf("@");
  if (at <= 0 || at === addr.length - 1) return false;
  const domain = addr.slice(at + 1);
  return CHARGEBACK_VENDOR_DOMAINS.some(d => domain === d || domain.endsWith("." + d));
}

/**
 * Does the inbound body carry an out-of-office / auto-reply / vendor-notification marker — the
 * class the active 'Auto-close tickets from automatic replies' and 'Auto-replies/OOO bounces'
 * policy rules recognize? Complements `bodyHasAutomatedMarker` (whose markers stay narrow for the
 * zero-cost outreach auto-close); this one is scoped to the `close_no_action` guard exclusion in
 * `findUnsatisfiedCustomerRequests`, where a false-positive only honors a close June ALREADY chose.
 */
export function bodyHasAutoReplyOrNotificationMarker(body: string | null | undefined): boolean {
  if (!body) return false;
  return (
    AUTO_REPLY_BODY_MARKERS.some(re => re.test(body)) ||
    VENDOR_NOTIFICATION_BODY_MARKERS.some(re => re.test(body)) ||
    bodyHasChargebackVendorMarker(body)
  );
}

/**
 * Is this inbound an auto-reply / OOO / vendor-notification blast that carries NO actionable
 * customer ask? Superset of `isAutomatedInbound` (no-reply senders + automated boilerplate) plus
 * the OOO / policy-blast body markers. Used ONLY by the CS Director's `close_no_action` guard to
 * exclude a non-customer inbound from the unsatisfied-request check, so a cue word inside a vendor
 * blast can't re-open a ticket that has nothing to act on (ticket f3977ec6 —
 * [[../../docs/brain/specs/close-no-action-guard-must-exempt-notification-and-auto-reply-emails.md]]).
 */
export function isAutoReplyOrNotificationInbound(
  fromAddress: string | null | undefined,
  body: string | null | undefined,
): boolean {
  return (
    isAutomatedInbound(fromAddress, body) ||
    isChargebackVendorSender(fromAddress) ||
    bodyHasAutoReplyOrNotificationMarker(body)
  );
}
