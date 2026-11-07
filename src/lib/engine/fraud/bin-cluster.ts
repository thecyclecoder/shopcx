/**
 * BIN-velocity cluster evaluation — moved verbatim from fraud-detector.ts
 * (engine Phase 1). ShopCX's checkVelocitySignals loads the cluster rows and
 * per-customer history, calls evaluateBinCluster, and persists the case.
 * Tests: src/lib/fraud-detector.bin-velocity.test.ts (Sep-2026 bin:414740).
 */
import { cardBillingNamesAgree, surnameOf, isAvsOrCvvFailure } from "./names";

/** Velocity signals look back this many days. */
export const VELOCITY_WINDOW_DAYS = 30;
// A shared BIN alone is NEVER fraud — a card BIN only identifies the issuing
// bank, and popular consumer banks (e.g. Visa 414740 = a common Chase range)
// issue to millions, so thousands of unrelated legit customers share one BIN
// with fully diverse names/addresses/cards. The Sep-2026 false-positive case
// (bin:414740) proved an account-blind corroborator sweeps in innocents: one
// fraudster reusing HER OWN card on HER OWN account satisfied the old "one card
// reused 4–5 times" test and pulled 8 unrelated subscribers into the case. The
// BIN branch now opens a case ONLY on a genuine CROSS-ACCOUNT link (the same
// card / shipping address / phone / browser IP used by ≥2 DISTINCT accounts, or
// a tiny set of surnames across ≥3 accounts) or an order-level independent
// suspicion signal — and scopes the case to ONLY the linked accounts.
export const CROSS_ACCOUNT_MIN_ACCOUNTS = 2; // a cross-account link must touch ≥2 distinct accounts
export const BIN_SURNAME_MIN_ACCOUNTS = 3; // the surname corroborator requires ≥3 distinct accounts…
export const BIN_MAX_SURNAMES = 2; // …narrowing to ≤2 distinct cardholder surnames
export const ESTABLISHED_MIN_PRIOR_ORDERS = 3; // ≥3 prior paid orders = an established customer
// Phase 2 — a dismissal on a velocity key suppresses re-flagging the SAME
// customers on that key for this many days (the bin:414740 case re-opened 6×
// in Sep-2026 because openCase ignored dismissed cases).
export const BIN_DISMISS_SUPPRESS_DAYS = VELOCITY_WINDOW_DAYS;

// ── BIN-velocity cluster evaluation (pure, unit-tested) ─────────────────────
// Factored out of checkVelocitySignals so the concentration logic is testable
// without a DB. A BIN cluster (all window orders sharing one card BIN) only
// opens a case on genuine CROSS-ACCOUNT evidence or order-level suspicion, and
// the case is scoped to ONLY the linked accounts.
export type BinClusterRow = {
  orderId: string; // internal orders.id (uuid) → fraud_cases.order_ids
  shopOrderId: string | null; // numeric Shopify id for the tagsAdd call
  customerId: string | null;
  email: string | null;
  cardLast4: string;
  cardExp: string;
  cardName: string;
  billingName: string;
  shipAddress1: string;
  shipZip5: string;
  phone: string; // digits only
  browserIp: string;
  avsResultCode: string;
  cvvResultCode: string;
  riskRecommendation: string; // Shopify risk: 'cancel' | 'investigate' | …
};

// Per-customer PRIOR (pre-cluster) history for the established-customer exclusion.
export type BinCustomerHistory = {
  priorPaidOrders: number;
  hasChargeback: boolean;
  priorCardKeys: Set<string>; // card keys (last4|exp) from this customer's prior orders
};

export type BinClusterResult = {
  fired: boolean;
  corroborator: string | null; // primary corroborator label
  corroborators: string[]; // every corroborator that fired
  reason: string; // human phrase for the title/summary
  crossAccountCardReuse: number; // max distinct accounts sharing a single card
  distinctSurnames: number;
  linkedCustomerIds: string[];
  linkedOrderIds: string[]; // internal uuids
  linkedShopOrderIds: string[];
  excludedEstablishedCustomerCount: number;
  title: string;
  summary: string;
};

// A linked member of a velocity case: one order and the account that placed it.
export type VelocityCaseMember = { customerId: string | null; orderId: string; shopOrderId: string | null };

// Phase 2 — drop members whose account was on a previously-dismissed case for
// this same velocity key, so a dismissal stays dismissed for those customers.
// Pure + unit-tested; `openCase` passes the most-recent dismissed case's
// customer_ids. `suppressedPresent` is the subset of dismissed customers that
// actually reappeared (recorded as evidence.suppressed_dismissed_customer_ids).
export function applyDismissalSuppression<T extends { customerId: string | null }>(
  members: T[],
  dismissedCustomerIds: string[],
): { kept: T[]; suppressedPresent: string[] } {
  const dismissed = new Set(dismissedCustomerIds.filter(Boolean));
  const kept = members.filter((m) => !(m.customerId && dismissed.has(m.customerId)));
  const suppressedPresent = [
    ...new Set(members.map((m) => m.customerId).filter((c): c is string => !!c && dismissed.has(c))),
  ];
  return { kept, suppressedPresent };
}

const BIN_CORROBORATOR_PRIORITY = [
  "cross_account_card",
  "shared_shipping_address",
  "shared_phone",
  "shared_ip",
  "few_surnames",
  "order_level_suspicion",
] as const;

export function evaluateBinCluster(
  bin: string,
  rows: BinClusterRow[],
  history: Map<string, BinCustomerHistory>,
): BinClusterResult {
  const cardKey = (r: BinClusterRow) => (r.cardLast4 && r.cardExp ? `${r.cardLast4}|${r.cardExp}` : "");
  const addrKey = (r: BinClusterRow) =>
    r.shipAddress1 && r.shipZip5 ? `${r.shipAddress1.toLowerCase().trim()}|${r.shipZip5}` : "";

  // Group DISTINCT accounts per linkable key. One account repeating on its own
  // card/address never inflates a count — the value is a Set of customer_ids.
  const accountsByCard = new Map<string, Set<string>>();
  const accountsByAddress = new Map<string, Set<string>>();
  const accountsByPhone = new Map<string, Set<string>>();
  const accountsByIp = new Map<string, Set<string>>();
  const surnameAccounts = new Map<string, Set<string>>();

  const add = (m: Map<string, Set<string>>, k: string, cust: string) => {
    if (!k) return;
    if (!m.has(k)) m.set(k, new Set());
    m.get(k)!.add(cust);
  };

  for (const r of rows) {
    const cust = r.customerId;
    if (!cust) continue;
    add(accountsByCard, cardKey(r), cust);
    add(accountsByAddress, addrKey(r), cust);
    add(accountsByPhone, r.phone, cust);
    add(accountsByIp, r.browserIp, cust);
    add(surnameAccounts, surnameOf(r.cardName), cust);
  }

  const hardLinkedCustomers = new Set<string>(); // (a)–(d) + order-level — resist the exclusion
  const linkedCustomers = new Set<string>();
  const linkedOrders = new Set<string>();
  const linkedShopOrders = new Set<string>();
  const corroborators = new Set<string>();

  const linkOrder = (r: BinClusterRow) => {
    linkedOrders.add(r.orderId);
    if (r.shopOrderId) linkedShopOrders.add(r.shopOrderId);
    if (r.customerId) linkedCustomers.add(r.customerId);
  };

  const sharedKeys = (m: Map<string, Set<string>>) =>
    new Set([...m].filter(([, a]) => a.size >= CROSS_ACCOUNT_MIN_ACCOUNTS).map(([k]) => k));

  // crossAccountCardReuse: the max number of DISTINCT accounts on any single
  // card. ≥2 is the stolen-card-batch fingerprint; 1 (an account reusing its own
  // card) never corroborates. This REPLACES the account-blind maxCardReuse.
  let crossAccountCardReuse = 0;
  for (const a of accountsByCard.values()) crossAccountCardReuse = Math.max(crossAccountCardReuse, a.size);

  // (a) same card on ≥2 accounts.
  const sharedCards = sharedKeys(accountsByCard);
  if (sharedCards.size) {
    corroborators.add("cross_account_card");
    for (const r of rows)
      if (r.customerId && sharedCards.has(cardKey(r))) {
        hardLinkedCustomers.add(r.customerId);
        linkOrder(r);
      }
  }
  // (b) same shipping address on ≥2 accounts.
  const sharedAddresses = sharedKeys(accountsByAddress);
  if (sharedAddresses.size) {
    corroborators.add("shared_shipping_address");
    for (const r of rows)
      if (r.customerId && sharedAddresses.has(addrKey(r))) {
        hardLinkedCustomers.add(r.customerId);
        linkOrder(r);
      }
  }
  // (c) same phone on ≥2 accounts.
  const sharedPhones = sharedKeys(accountsByPhone);
  if (sharedPhones.size) {
    corroborators.add("shared_phone");
    for (const r of rows)
      if (r.customerId && r.phone && sharedPhones.has(r.phone)) {
        hardLinkedCustomers.add(r.customerId);
        linkOrder(r);
      }
  }
  // (d) same browser IP on ≥2 accounts.
  const sharedIps = sharedKeys(accountsByIp);
  if (sharedIps.size) {
    corroborators.add("shared_ip");
    for (const r of rows)
      if (r.customerId && r.browserIp && sharedIps.has(r.browserIp)) {
        hardLinkedCustomers.add(r.customerId);
        linkOrder(r);
      }
  }

  // Order-level independent suspicion qualifies THAT one order + its account.
  // A card/billing name mismatch alone is NEVER enough: a different first name on
  // the card is a nickname (Pamela M Boswell vs Pam Boswell) or a family member's
  // card (Michael Maurizi vs Tina Maurizi) far more often than fraud. Suspicion
  // fires only on a failed AVS/CVV check or a Shopify cancel/investigate risk; a
  // co-occurring name mismatch is recorded as supporting evidence only. A customer
  // with a real cross-account link above is already hardLinked regardless of name.
  let orderLevelNameMismatchSeen = false;
  for (const r of rows) {
    if (!r.customerId) continue;
    const nameMismatch = !!r.cardName && !!r.billingName && !cardBillingNamesAgree(r.cardName, r.billingName);
    const avsCvvFail = isAvsOrCvvFailure(r.avsResultCode, r.cvvResultCode);
    const risky = ["cancel", "investigate"].includes(r.riskRecommendation.trim().toLowerCase());
    if (avsCvvFail || risky) {
      corroborators.add("order_level_suspicion");
      hardLinkedCustomers.add(r.customerId);
      linkOrder(r);
      if (nameMismatch) orderLevelNameMismatchSeen = true;
    }
  }

  // (e) ≤2 distinct cardholder surnames across ≥3 distinct accounts. This is a
  // soft signal, so an established clean customer swept in by it alone is excluded.
  const distinctSurnames = surnameAccounts.size;
  const surnameAccountSet = new Set<string>();
  for (const accts of surnameAccounts.values()) for (const c of accts) surnameAccountSet.add(c);
  const surnameLinkedCustomers = new Set<string>();
  if (distinctSurnames > 0 && distinctSurnames <= BIN_MAX_SURNAMES && surnameAccountSet.size >= BIN_SURNAME_MIN_ACCOUNTS) {
    corroborators.add("few_surnames");
    for (const c of surnameAccountSet) surnameLinkedCustomers.add(c);
  }

  // Established-customer exclusion: a customer with ≥3 prior paid orders, no
  // chargebacks, and the same card as their prior orders is NEVER added to a BIN
  // case on BIN (surname) grounds alone. A hard cross-account link keeps them in.
  const isEstablishedClean = (cust: string): boolean => {
    const h = history.get(cust);
    if (!h || h.priorPaidOrders < ESTABLISHED_MIN_PRIOR_ORDERS || h.hasChargeback) return false;
    return rows.some((r) => r.customerId === cust && cardKey(r) && h.priorCardKeys.has(cardKey(r)));
  };

  let excludedEstablishedCustomerCount = 0;
  for (const cust of surnameLinkedCustomers) {
    if (hardLinkedCustomers.has(cust)) {
      linkedCustomers.add(cust);
      continue;
    }
    if (isEstablishedClean(cust)) {
      excludedEstablishedCustomerCount++;
      continue;
    }
    linkedCustomers.add(cust);
  }
  if (corroborators.has("few_surnames")) {
    for (const r of rows) if (r.customerId && linkedCustomers.has(r.customerId) && surnameOf(r.cardName)) linkOrder(r);
  }

  const linkedCustomerIds = [...linkedCustomers];
  const linkedOrderIds = [...linkedOrders];
  const linkedShopOrderIds = [...linkedShopOrders];
  const fired = corroborators.size > 0 && linkedCustomerIds.length > 0;
  const primary = BIN_CORROBORATOR_PRIORITY.find((c) => corroborators.has(c)) || null;

  const reasonMap: Record<string, string> = {
    cross_account_card: `the same card used across ${crossAccountCardReuse} distinct accounts`,
    shared_shipping_address: "the same shipping address shared across ≥2 accounts",
    shared_phone: "the same phone shared across ≥2 accounts",
    shared_ip: "the same browser IP shared across ≥2 accounts",
    few_surnames: `only ${distinctSurnames} distinct cardholder surname(s) across ≥${BIN_SURNAME_MIN_ACCOUNTS} accounts`,
    order_level_suspicion: `an order with an independent suspicion signal (AVS/CVV failure or a Shopify cancel/investigate risk)${orderLevelNameMismatchSeen ? ", with a card/billing name mismatch as supporting evidence" : ""}`,
  };
  const reason = primary ? reasonMap[primary] : "";

  // Only claim the "stolen-card batch" fingerprint when corroborator (a) fired.
  const title = `Card BIN ${bin} — ${linkedCustomerIds.length} linked account(s): ${reason} (30d)`;
  const summary =
    primary === "cross_account_card"
      ? `${linkedOrderIds.length} orders across ${linkedCustomerIds.length} distinct accounts share card BIN ${bin} and ${reason} — the fingerprint of a stolen-card batch being run through different identities.`
      : `${linkedOrderIds.length} order(s) across ${linkedCustomerIds.length} account(s) on card BIN ${bin} were linked by ${reason}. Only the linked accounts are held; other customers who merely share this BIN are not implicated.`;

  return {
    fired,
    corroborator: primary,
    corroborators: [...corroborators],
    reason,
    crossAccountCardReuse,
    distinctSurnames,
    linkedCustomerIds,
    linkedOrderIds,
    linkedShopOrderIds,
    excludedEstablishedCustomerCount,
    title,
    summary,
  };
}
