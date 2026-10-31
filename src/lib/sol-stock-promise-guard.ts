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
  /**
   * Variants the 3PL CAN ship — `in_stock === true` from `getCxProducts`. Used only to SUPPRESS a
   * false match: a bare OOS flavour token ("Berry") that is a substring of an in-stock variant name
   * the reply actually names ("Mixed Berry") is not an offer of the OOS variant. Optional — when
   * omitted no suppression happens and the guard behaves exactly as before.
   * Ticket 42f55634: an OOS "Sleep Gummies / Berry" false-blocked a correct "Superfood Tabs /
   * Mixed Berry" reactivation confirmation because "berry" is a substring of "mixed berry".
   */
  inStock?: StockPromiseVariant[];
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

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * All `[start, end)` spans where `phrase` occurs in `text` on WORD BOUNDARIES — so the OOS token
 * "berry" matches the standalone word "berry" but not the "berry" inside "blueberry". Both inputs
 * are already normalized (lowercase a–z/0–9/space), so boundaries are "not an alphanumeric".
 */
function wordBoundarySpans(text: string, phrase: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  if (!phrase) return spans;
  const re = new RegExp(`(?<![a-z0-9])${escapeRe(phrase)}(?![a-z0-9])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    spans.push([m.index, m.index + m[0].length]);
    if (m.index === re.lastIndex) re.lastIndex++; // never loop on a zero-width match
  }
  return spans;
}

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

  // Spans the reply has already "spent" naming an IN-STOCK variant. A match of a bare OOS token that
  // falls entirely inside one of these is explained by the in-stock variant the reply names (e.g.
  // the OOS "berry" inside the in-stock "mixed berry") and must not be treated as an offer of the
  // OOS variant. Ticket 42f55634: a shared flavour token can no longer false-block.
  const coveredSpans: Array<[number, number]> = [];
  for (const iv of ctx.inStock ?? []) {
    const name = norm(iv.variant ?? "");
    if (!name) continue;
    for (const sp of wordBoundarySpans(reply, name)) coveredSpans.push(sp);
  }
  const coveredBy = ([s, e]: [number, number]): boolean =>
    coveredSpans.some(([cs, ce]) => s >= cs && e <= ce);

  const offending: string[] = [];
  for (const v of ctx.outOfStock) {
    const variant = norm(v.variant ?? "");
    // A one-word variant like "Apple" is too generic to match safely; require a real name.
    if (!variant || variant.length < 4) continue;
    // Match on word boundaries (not bare substring), then keep only occurrences NOT accounted for by
    // an in-stock variant name the reply also names. One genuine (uncovered) occurrence is an offer.
    const spans = wordBoundarySpans(reply, variant);
    const genuinelyOffered = spans.some((sp) => !coveredBy(sp));
    if (genuinelyOffered) {
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
