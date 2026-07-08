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
