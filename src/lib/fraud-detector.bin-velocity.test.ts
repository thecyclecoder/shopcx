/**
 * Unit tests for evaluateBinCluster — Phase 1 of
 * docs/brain/specs/fraud-bin-velocity-requires-real-cross-account-link.md.
 *
 * Ground truth: the Sep-2026 bin:414740 false-positive case. The BIN-velocity
 * branch grouped every customer whose card started 414740 (a common Chase Visa
 * range) into one "stolen-card batch" case. The account-blind "one card reused
 * 4–5 times" corroborator was a single fraudster (Patricia Ohara) reusing HER
 * OWN card on HER OWN account, yet it swept in 8 unrelated legit customers.
 *
 * The rule: a shared BIN is NEVER enough. A case opens only on a genuine
 * CROSS-ACCOUNT link (same card / address / phone / IP on ≥2 distinct accounts,
 * or ≤2 surnames across ≥3 accounts) or an order-level suspicion signal, and is
 * scoped to ONLY the linked accounts. crossAccountCardReuse counts DISTINCT
 * accounts per card — one account reusing its own card never corroborates.
 *
 * Pure function — no DB, no network, no clock. Run:
 *   npx tsx --test src/lib/fraud-detector.bin-velocity.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateBinCluster,
  applyDismissalSuppression,
  type BinClusterRow,
  type BinCustomerHistory,
  type VelocityCaseMember,
} from "./fraud-detector";

const BIN = "414740";

// Minimal row factory — only the fields a case hinges on need to be set.
function row(p: Partial<BinClusterRow> & { orderId: string; customerId: string }): BinClusterRow {
  return {
    shopOrderId: p.orderId,
    email: `${p.customerId}@example.com`,
    cardLast4: "",
    cardExp: "",
    cardName: "",
    billingName: "",
    shipAddress1: "",
    shipZip5: "",
    phone: "",
    browserIp: "",
    avsResultCode: "",
    cvvResultCode: "",
    riskRecommendation: "",
    ...p,
  };
}

const noHistory = new Map<string, BinCustomerHistory>();

// Distinct alphabetic surnames for "crowd of unrelated customers" fixtures.
// (Digits are stripped during surname normalization, so "Surname1" ≠ a distinct
// surname — a crowd must use genuinely different words.)
const SURNAMES = ["Johnson", "Williams", "Brown", "Davis", "Miller", "Wilson", "Moore", "Taylor", "Anderson", "Thomas", "Jackson", "Lewis"];

test("(i) Sep-2026 shape: 1 account × 6 orders on its own card + 8 unrelated accounts → NO case", () => {
  const rows: BinClusterRow[] = [];
  // Patricia: one account, six orders, all on HER OWN card.
  for (let i = 0; i < 6; i++) {
    rows.push(
      row({
        orderId: `p${i}`,
        customerId: "patricia",
        cardLast4: "1111",
        cardExp: "12/2027",
        cardName: "Patricia Ohara",
        shipAddress1: "1 Patricia Way",
        shipZip5: "10001",
      }),
    );
  }
  // 8 unrelated customers, each with their own distinct card / address / surname.
  for (let i = 0; i < 8; i++) {
    rows.push(
      row({
        orderId: `u${i}`,
        customerId: `user${i}`,
        cardLast4: `20${i}0`,
        cardExp: `0${(i % 9) + 1}/2026`,
        cardName: `First ${SURNAMES[i]}`,
        shipAddress1: `${i} Main St`,
        shipZip5: `9000${i}`,
      }),
    );
  }

  const res = evaluateBinCluster(BIN, rows, noHistory);
  assert.equal(res.fired, false, "a shared BIN with one self-reusing account and 8 unrelated buyers must NOT open a case");
  assert.equal(res.crossAccountCardReuse, 1, "Patricia's own card is used by only 1 distinct account — never a corroborator");
  assert.deepEqual(res.linkedCustomerIds, [], "no accounts are linked");
});

test("(i-variant) the self-reusing account independently qualifies (AVS failure) → case with ONLY that account", () => {
  const rows: BinClusterRow[] = [];
  for (let i = 0; i < 6; i++) {
    rows.push(
      row({
        orderId: `p${i}`,
        customerId: "patricia",
        cardLast4: "1111",
        cardExp: "12/2027",
        cardName: "Patricia Ohara",
        // one of her orders trips an order-level suspicion signal
        avsResultCode: i === 0 ? "N" : "Y",
      }),
    );
  }
  for (let i = 0; i < 8; i++) {
    rows.push(row({ orderId: `u${i}`, customerId: `user${i}`, cardLast4: `20${i}0`, cardExp: "01/2026", cardName: `First ${SURNAMES[i]}` }));
  }

  const res = evaluateBinCluster(BIN, rows, noHistory);
  assert.equal(res.fired, true);
  assert.deepEqual(res.linkedCustomerIds, ["patricia"], "only the independently-qualifying account is linked");
  assert.equal(res.corroborator, "order_level_suspicion");
});

test("(ii) one card on 3 different accounts → case with ONLY those 3 accounts", () => {
  const rows: BinClusterRow[] = [
    row({ orderId: "a1", customerId: "A", cardLast4: "9999", cardExp: "05/2028" }),
    row({ orderId: "b1", customerId: "B", cardLast4: "9999", cardExp: "05/2028" }),
    row({ orderId: "c1", customerId: "C", cardLast4: "9999", cardExp: "05/2028" }),
    // two unrelated accounts, their own distinct cards — NOT linked
    row({ orderId: "d1", customerId: "D", cardLast4: "1234", cardExp: "01/2026" }),
    row({ orderId: "e1", customerId: "E", cardLast4: "5678", cardExp: "02/2026" }),
  ];
  const res = evaluateBinCluster(BIN, rows, noHistory);
  assert.equal(res.fired, true);
  assert.equal(res.corroborator, "cross_account_card");
  assert.equal(res.crossAccountCardReuse, 3);
  assert.deepEqual(res.linkedCustomerIds.sort(), ["A", "B", "C"]);
  assert.deepEqual(res.linkedOrderIds.sort(), ["a1", "b1", "c1"]);
  assert.ok(res.summary.includes("stolen-card batch"), "cross-account card reuse earns the stolen-card-batch summary");
});

test("(iii) shared shipping address across 4 accounts → case with those 4", () => {
  const rows: BinClusterRow[] = [];
  for (const c of ["A", "B", "C", "D"]) {
    rows.push(
      row({
        orderId: `${c}1`,
        customerId: c,
        cardLast4: `${c}000`,
        cardExp: "01/2027",
        shipAddress1: "500 Drop St",
        shipZip5: "33101",
      }),
    );
  }
  // an unrelated account at a different address — not linked
  rows.push(row({ orderId: "z1", customerId: "Z", cardLast4: "7777", cardExp: "01/2026", shipAddress1: "9 Other Rd", shipZip5: "99999" }));

  const res = evaluateBinCluster(BIN, rows, noHistory);
  assert.equal(res.fired, true);
  assert.equal(res.corroborator, "shared_shipping_address");
  assert.deepEqual(res.linkedCustomerIds.sort(), ["A", "B", "C", "D"]);
  assert.ok(!res.summary.includes("stolen-card batch"), "only (a) earns the stolen-card-batch claim");
});

test("(iv) established clean customer swept in by surname alone is EXCLUDED", () => {
  // Three accounts sharing ≤2 surnames (the soft surname corroborator). One of
  // them is a long-standing clean customer on the same card they've always used.
  const rows: BinClusterRow[] = [
    row({ orderId: "s1", customerId: "newA", cardLast4: "1000", cardExp: "01/2027", cardName: "Jim Smith" }),
    row({ orderId: "s2", customerId: "newB", cardLast4: "2000", cardExp: "02/2027", cardName: "Jane Smith" }),
    row({ orderId: "s3", customerId: "loyal", cardLast4: "3000", cardExp: "03/2027", cardName: "Bob Smith" }),
  ];
  const history = new Map<string, BinCustomerHistory>([
    ["loyal", { priorPaidOrders: 7, hasChargeback: false, priorCardKeys: new Set(["3000|03/2027"]) }],
  ]);

  const res = evaluateBinCluster(BIN, rows, history);
  assert.equal(res.corroborator, "few_surnames");
  assert.ok(!res.linkedCustomerIds.includes("loyal"), "established clean customer is NOT pulled in on surname grounds alone");
  assert.deepEqual(res.linkedCustomerIds.sort(), ["newA", "newB"]);
  assert.equal(res.excludedEstablishedCustomerCount, 1);
});

test("established customer with a HARD cross-account link stays in", () => {
  // loyal shares a card with newA — a hard link overrides the exclusion.
  const rows: BinClusterRow[] = [
    row({ orderId: "s1", customerId: "newA", cardLast4: "5000", cardExp: "01/2027", cardName: "Jim Smith" }),
    row({ orderId: "s3", customerId: "loyal", cardLast4: "5000", cardExp: "01/2027", cardName: "Bob Smith" }),
  ];
  const history = new Map<string, BinCustomerHistory>([
    ["loyal", { priorPaidOrders: 7, hasChargeback: false, priorCardKeys: new Set(["9000|09/2027"]) }],
  ]);
  const res = evaluateBinCluster(BIN, rows, history);
  assert.equal(res.corroborator, "cross_account_card");
  assert.deepEqual(res.linkedCustomerIds.sort(), ["loyal", "newA"]);
  assert.equal(res.excludedEstablishedCustomerCount, 0);
});

test("account-blind reuse is gone: diverse BIN crowd with no cross-account link → NO case", () => {
  const rows: BinClusterRow[] = [];
  for (let i = 0; i < 12; i++) {
    rows.push(
      row({
        orderId: `o${i}`,
        customerId: `cust${i}`,
        cardLast4: `${1000 + i}`,
        cardExp: `0${(i % 9) + 1}/2026`,
        cardName: `First ${SURNAMES[i]}`,
        shipAddress1: `${i} Elm St`,
        shipZip5: `${10000 + i}`,
      }),
    );
  }
  const res = evaluateBinCluster(BIN, rows, noHistory);
  assert.equal(res.fired, false, "a crowd of unrelated customers who merely bank with the same issuer never opens a case");
});

// ── Phase 2 — a dismissed BIN case stays dismissed for the same customers ────

// Build the linked members openCase would feed the suppression step, from the
// corroborated BIN cluster.
function linkedMembers(rows: BinClusterRow[]): VelocityCaseMember[] {
  const res = evaluateBinCluster(BIN, rows, noHistory);
  const linkedOrders = new Set(res.linkedOrderIds);
  return rows
    .filter((r) => linkedOrders.has(r.orderId))
    .map((r) => ({ customerId: r.customerId, orderId: r.orderId, shopOrderId: r.shopOrderId }));
}

test("Phase 2: dismissed {A,B}, a fresh order from A linked to B by shared card → NO new case", () => {
  // A and B share a card (the corroborator), so both are linked. Both were on a
  // previously-dismissed case for this key → nothing new remains.
  const rows: BinClusterRow[] = [
    row({ orderId: "a1", customerId: "A", cardLast4: "4242", cardExp: "11/2027" }),
    row({ orderId: "b1", customerId: "B", cardLast4: "4242", cardExp: "11/2027" }),
  ];
  const members = linkedMembers(rows);
  assert.deepEqual([...new Set(members.map((m) => m.customerId))].sort(), ["A", "B"]);

  const { kept, suppressedPresent } = applyDismissalSuppression(members, ["A", "B"]);
  assert.equal(kept.length, 0, "every linked customer was previously dismissed → openCase opens nothing");
  assert.deepEqual(suppressedPresent.sort(), ["A", "B"]);
});

test("Phase 2: dismissed {A,B}, new customer C linked to A by a shared card → case with ONLY C", () => {
  // C shares a card with A (so C and A are linked); A and B were dismissed. The
  // suppression drops A, leaving a case for the genuinely-new customer C only.
  const rows: BinClusterRow[] = [
    row({ orderId: "a1", customerId: "A", cardLast4: "7788", cardExp: "03/2028" }),
    row({ orderId: "c1", customerId: "C", cardLast4: "7788", cardExp: "03/2028" }),
  ];
  const members = linkedMembers(rows);
  const { kept, suppressedPresent } = applyDismissalSuppression(members, ["A", "B"]);
  const keptCustomers = [...new Set(kept.map((m) => m.customerId))];
  assert.deepEqual(keptCustomers, ["C"], "only the new customer remains after suppressing dismissed A");
  assert.deepEqual(kept.map((m) => m.orderId), ["c1"], "only C's order is held");
  assert.deepEqual(suppressedPresent, ["A"], "A reappeared and is recorded as a suppressed dismissed customer");
});

test("applyDismissalSuppression: no prior dismissal is a pass-through with no suppressed ids", () => {
  const members: VelocityCaseMember[] = [
    { customerId: "X", orderId: "x1", shopOrderId: "x1" },
    { customerId: "Y", orderId: "y1", shopOrderId: "y1" },
  ];
  const { kept, suppressedPresent } = applyDismissalSuppression(members, []);
  assert.equal(kept.length, 2);
  assert.deepEqual(suppressedPresent, []);
});
