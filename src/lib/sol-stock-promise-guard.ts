/**
 * Machine gate: Sol must never OFFER a flavor the 3PL cannot ship.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
 * Ticket 0c9f11a7 (2026-08-28). Keira asked to reorder her usual four flavours. Sol replied
 * "I've got your usual set right here: Superfood Tabs in Mixed Berry and Strawberry Lemonade,
 * plus Amazing Coffee in Hazelnut and Cocoa" — while Strawberry Lemonade had been out of stock
 * at the 3PL since 2026-07-30, under an ACTIVE `crisis_events` row. The order could not include
 * it, she was billed $213.24 anyway, and the make-good cost a free unit plus a subscription fix.
 *
 * Sol wasn't lying — it had no stock signal at all. `getCxProducts`, the SDK Sol is instructed to
 * call, listed every active variant with a price and nothing else. That is fixed at the source
 * ([[./cx-agent-sdk]] now carries per-variant 3PL ship truth), but a prompt-visible fact is
 * advisory: the policy precedent ([[./sol-policy-bait-guard]]) exists precisely because telling an
 * agent a rule does not reliably stop it breaking the rule. So we gate the draft too.
 *
 * ── WHAT PASSES ────────────────────────────────────────────────────────────────────────
 * Naming an out-of-stock flavour is FINE — required, even — as long as the reply says it is
 * unavailable. "Strawberry Lemonade is out of stock right now, so I wasn't able to include it"
 * PASSES. The block is only for a bare OFFER: naming it as something the customer is getting or
 * could get, with no unavailability anywhere in the reply.
 *
 * Deterministic: string matching over the reply plus the live OOS list. No model call, no cost.
 */

export interface StockPromiseVariant {
  /** Product title, e.g. "Superfood Tabs". */
  product: string | null;
  /** Variant title, e.g. "Strawberry Lemonade". This is what a reply actually names. */
  variant: string | null;
}

export interface SolStockPromiseContext {
  /** The DRAFT reply Sol wants to send. */
  firstReply: string;
  /**
   * Variants the 3PL cannot ship right now — `in_stock === false` from `getCxProducts`.
   * Deliberately NOT including `in_stock === null` (stock unknown): an unknown is a reason for Sol
   * to check, not a reason to block a send, and blocking on it would fire on every variant we have
   * no 3PL row for.
   */
  outOfStock: StockPromiseVariant[];
}

export interface SolStockPromiseAssessment {
  /** True ⇒ do NOT send; escalate to June instead. */
  blocked: boolean;
  /** Variant names the reply offered without disclosing they're unavailable. */
  offendingVariants: string[];
  /** One-line operator-readable reason, or null when nothing fired. */
  reason: string | null;
}

/**
 * Phrases that turn "naming a flavour" into "disclosing it's unavailable". Matched anywhere in the
 * reply, not just adjacent to the name: a reply that says the flavour is out somewhere and then
 * mentions it again later is still an honest reply.
 */
const UNAVAILABLE_MARKERS = [
  "out of stock",
  "out-of-stock",
  "sold out",
  "unavailable",
  "not available",
  "isn't available",
  "is not available",
  "back in stock",
  "restock",
  "temporarily out",
  "wasn't able to include",
  "was not able to include",
  "couldn't include",
  "could not include",
  "can't include",
  "cannot include",
  "currently out",
  "no longer available",
];

const norm = (s: string): string =>
  (s || "")
    .toLowerCase()
    // strip HTML so a rendered reply is matched the same as a plain one
    .replace(/<[^>]+>/g, " ")
    // collapse punctuation that commonly splits a flavour name (Mixed-Berry, Mixed  Berry)
    .replace(/[‐-―\-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Does the reply OFFER an out-of-stock variant without saying it's unavailable?
 *
 * Fails OPEN on an empty reply or an empty OOS list — this gate only ever adds a block, it never
 * manufactures one from missing inputs.
 */
export function assessSolStockPromiseRisk(
  ctx: SolStockPromiseContext,
): SolStockPromiseAssessment {
  const clean = { blocked: false, offendingVariants: [], reason: null } as SolStockPromiseAssessment;
  const reply = norm(ctx.firstReply);
  if (!reply) return clean;
  if (!ctx.outOfStock?.length) return clean;

  // One honest disclosure anywhere clears the whole reply — Sol is allowed (and expected) to name
  // the flavour when explaining that it can't ship.
  const discloses = UNAVAILABLE_MARKERS.some((m) => reply.includes(norm(m)));
  if (discloses) return clean;

  const offending: string[] = [];
  for (const v of ctx.outOfStock) {
    const variant = norm(v.variant ?? "");
    // A one-word variant like "Apple" is too generic to match safely; require a real name.
    if (!variant || variant.length < 4) continue;
    if (reply.includes(variant)) {
      const label = v.product ? `${v.product} / ${v.variant}` : String(v.variant);
      if (!offending.includes(label)) offending.push(label);
    }
  }
  if (!offending.length) return clean;

  return {
    blocked: true,
    offendingVariants: offending,
    reason:
      `reply names out-of-stock variant(s) [${offending.join(", ")}] without saying they are ` +
      `unavailable — the 3PL cannot ship them (ticket 0c9f11a7 shape)`,
  };
}
