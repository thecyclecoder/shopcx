/**
 * Pins the Phase 1 invariants for docs/brain/specs/review-request-post-order-ask.md:
 *
 *   1. **Window classification is PER PRODUCT, not per customer.** A
 *      first-timer for this product needs 21d; a repeat-buyer needs 10d.
 *      The classifier must never read the 10d and 21d windows off the
 *      same "days since order" branch — a first-timer graded on the 10d
 *      window would be asked three days after the package arrived, before
 *      they have anything honest to say.
 *
 *   2. **Reachability follows the spec's "SMS → email → drop" rule.** A
 *      customer explicitly unsubscribed from email AND not SMS-subscribed
 *      is unreachable and must be skipped; the sender would drop the ask
 *      anyway.
 *
 *   3. **Ladder / already-reviewed / not-due skips are exclusive.** A key
 *      that matches an already-asked / already-reviewed row is counted
 *      under its own bucket and never leaks through into `ready` — the
 *      spec's "same predicates the ticket path uses" contract.
 *
 * The failing state these exist to prevent: a detector that reads the 10d
 * and 21d branches from the same "days since order" arithmetic (thereby
 * treating every candidate as repeat), or one that skips the reachability
 * predicate and enqueues asks for customers the sender will silently drop.
 *
 * Run: npx tsx --test src/lib/inngest/post-order-review-ask-detector-cron.selection.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  POST_ORDER_FIRST_TIME_WINDOW_DAYS,
  POST_ORDER_READ_CAP,
  POST_ORDER_REPEAT_WINDOW_DAYS,
  classifyPostOrderWindow,
  isPostOrderCustomerReachable,
  selectPostOrderReadyCandidates,
  type PostOrderCandidate,
} from "./post-order-review-ask-detector-cron";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(n: number): string {
  return new Date(NOW - n * DAY).toISOString();
}

function makeCandidate(overrides: Partial<PostOrderCandidate>): PostOrderCandidate {
  return {
    workspaceId: "ws-1",
    customerId: "cust-1",
    productId: "prod-1",
    shopifyProductId: "shopify-100",
    orderId: "order-1",
    orderCreatedAt: daysAgo(11),
    ...overrides,
  };
}

test("classify: a repeat-buyer at 10 days is READY (10d + 0 ≤ now)", () => {
  const r = classifyPostOrderWindow({
    orderCreatedAt: daysAgo(10),
    firstTimeForProduct: false,
    now: NOW,
  });
  assert.equal(r.window, "repeat");
  assert.equal(r.ready, true);
});

test("classify: a repeat-buyer at 9 days is NOT READY (10d not yet reached)", () => {
  const r = classifyPostOrderWindow({
    orderCreatedAt: daysAgo(9),
    firstTimeForProduct: false,
    now: NOW,
  });
  assert.equal(r.ready, false);
});

test("classify: a first-timer at 10 days is NOT READY — the 21d window is per-PRODUCT, not per-customer", () => {
  // The named failing state — a detector that reads both windows off the
  // same "days since order" arithmetic would enqueue this first-timer at
  // 10d, three days after their package arrived. The classifier must
  // route first-timers through the 21d branch instead.
  const r = classifyPostOrderWindow({
    orderCreatedAt: daysAgo(10),
    firstTimeForProduct: true,
    now: NOW,
  });
  assert.equal(r.window, "first-time");
  assert.equal(r.ready, false);
});

test("classify: a first-timer at 21 days IS READY", () => {
  const r = classifyPostOrderWindow({
    orderCreatedAt: daysAgo(21),
    firstTimeForProduct: true,
    now: NOW,
  });
  assert.equal(r.window, "first-time");
  assert.equal(r.ready, true);
});

test("classify: the repeat window is < the first-time window by construction", () => {
  // Structural pin — a future edit that inverts the two windows (e.g.
  // makes first-timers wait 10d and repeat-buyers wait 21d) breaks the
  // spec's core reasoning. This asserts the ordering directly.
  assert.ok(
    POST_ORDER_REPEAT_WINDOW_DAYS < POST_ORDER_FIRST_TIME_WINDOW_DAYS,
    `repeat=${POST_ORDER_REPEAT_WINDOW_DAYS} must remain < first-time=${POST_ORDER_FIRST_TIME_WINDOW_DAYS}`,
  );
});

test("reachable: sms-subscribed customer is reachable regardless of email status", () => {
  assert.equal(
    isPostOrderCustomerReachable({
      smsMarketingStatus: "subscribed",
      emailMarketingStatus: "unsubscribed",
    }),
    true,
  );
});

test("reachable: explicit email unsubscribe + no sms subscription is UNREACHABLE", () => {
  // The spec's "never to an explicit unsubscribe" rule. A customer who has
  // no SMS opt-in AND explicitly said no to email is a clean skip.
  assert.equal(
    isPostOrderCustomerReachable({
      smsMarketingStatus: null,
      emailMarketingStatus: "unsubscribed",
    }),
    false,
  );
});

test("reachable: null / not_subscribed email is still a legal recipient for a review ask (email default)", () => {
  // A customer who hasn't taken any action on marketing consent is still a
  // legal recipient for a transactional-adjacent review ask (email
  // default). Only an EXPLICIT unsubscribe closes the door.
  assert.equal(
    isPostOrderCustomerReachable({
      smsMarketingStatus: null,
      emailMarketingStatus: null,
    }),
    true,
  );
  assert.equal(
    isPostOrderCustomerReachable({
      smsMarketingStatus: null,
      emailMarketingStatus: "not_subscribed",
    }),
    true,
  );
});

test("select: an already-asked (customer, product) key is counted under skipped_already_asked and never leaks into ready", () => {
  // The spec's one-ladder invariant — the ticket path and the post-order
  // path must never both ask the same customer about the same product.
  const c = makeCandidate({});
  const r = selectPostOrderReadyCandidates({
    candidates: [c],
    askedKeys: new Set([`${c.customerId}|${c.productId}`]),
    reviewedKeys: new Set(),
    marketingByCustomer: new Map([
      [c.customerId, { sms_marketing_status: "subscribed", email_marketing_status: null }],
    ]),
    firstTimeKeys: new Set(),
    blindHistoryCustomers: new Set<string>(),
    now: NOW,
    readCap: POST_ORDER_READ_CAP,
  });
  assert.equal(r.ready.length, 0);
  assert.equal(r.skipped_already_asked, 1);
  assert.equal(r.skipped_already_reviewed, 0);
});

test("select: an already-reviewed (customer, product) key is counted under skipped_already_reviewed", () => {
  const c = makeCandidate({});
  const r = selectPostOrderReadyCandidates({
    candidates: [c],
    askedKeys: new Set(),
    reviewedKeys: new Set([`${c.customerId}|${c.productId}`]),
    marketingByCustomer: new Map([
      [c.customerId, { sms_marketing_status: "subscribed", email_marketing_status: null }],
    ]),
    firstTimeKeys: new Set(),
    blindHistoryCustomers: new Set<string>(),
    now: NOW,
    readCap: POST_ORDER_READ_CAP,
  });
  assert.equal(r.ready.length, 0);
  assert.equal(r.skipped_already_reviewed, 1);
});

test("select: an unreachable customer is counted under skipped_unreachable", () => {
  const c = makeCandidate({});
  const r = selectPostOrderReadyCandidates({
    candidates: [c],
    askedKeys: new Set(),
    reviewedKeys: new Set(),
    marketingByCustomer: new Map([
      [c.customerId, { sms_marketing_status: null, email_marketing_status: "unsubscribed" }],
    ]),
    firstTimeKeys: new Set(),
    blindHistoryCustomers: new Set<string>(),
    now: NOW,
    readCap: POST_ORDER_READ_CAP,
  });
  assert.equal(r.ready.length, 0);
  assert.equal(r.skipped_unreachable, 1);
});

test("select: a first-timer at 10 days is NOT READY (per-product 21d window)", () => {
  // The end-to-end reach of the classifier through the selector — the
  // failing state pinned above, tested one level up. A customer whose
  // (customer, product) key is in firstTimeKeys must clear the 21d gate
  // regardless of how many other products they've bought before.
  const c = makeCandidate({ orderCreatedAt: daysAgo(10) });
  const r = selectPostOrderReadyCandidates({
    candidates: [c],
    askedKeys: new Set(),
    reviewedKeys: new Set(),
    marketingByCustomer: new Map([
      [c.customerId, { sms_marketing_status: "subscribed", email_marketing_status: null }],
    ]),
    firstTimeKeys: new Set([`${c.customerId}|${c.productId}`]),
    blindHistoryCustomers: new Set<string>(),
    now: NOW,
    readCap: POST_ORDER_READ_CAP,
  });
  assert.equal(r.ready.length, 0);
  assert.equal(r.skipped_not_due, 1);
});

test("select: a repeat-buyer at 10 days IS READY under the 10d window", () => {
  const c = makeCandidate({ orderCreatedAt: daysAgo(10) });
  const r = selectPostOrderReadyCandidates({
    candidates: [c],
    askedKeys: new Set(),
    reviewedKeys: new Set(),
    marketingByCustomer: new Map([
      [c.customerId, { sms_marketing_status: "subscribed", email_marketing_status: null }],
    ]),
    firstTimeKeys: new Set(),
    blindHistoryCustomers: new Set<string>(), // not in the set → REPEAT
    now: NOW,
    readCap: POST_ORDER_READ_CAP,
  });
  assert.equal(r.ready.length, 1);
  assert.equal(r.ready[0].window, "repeat");
});

test("select: same (customer, product) across two orders in the window is de-duped to ONE ask", () => {
  // The spec's ladder is keyed on (workspace, customer, product) — a
  // customer with two orders of the same product inside the sliding
  // window must not receive two asks. The earliest anchor date wins.
  const c1 = makeCandidate({
    orderId: "order-1",
    orderCreatedAt: daysAgo(11),
  });
  const c2 = makeCandidate({
    orderId: "order-2",
    orderCreatedAt: daysAgo(10),
  });
  const r = selectPostOrderReadyCandidates({
    candidates: [c1, c2],
    askedKeys: new Set(),
    reviewedKeys: new Set(),
    marketingByCustomer: new Map([
      [c1.customerId, { sms_marketing_status: "subscribed", email_marketing_status: null }],
    ]),
    firstTimeKeys: new Set(),
    blindHistoryCustomers: new Set<string>(), // repeat window
    now: NOW,
    readCap: POST_ORDER_READ_CAP,
  });
  assert.equal(r.ready.length, 1);
  assert.equal(r.ready[0].orderId, "order-1"); // earliest wins
});

// ── The blind-history rail ────────────────────────────────────────────────
//
// `firstTimeKeys` is built by ABSENCE: a (customer, product) key is
// "first-time" when no prior order was found containing that product. But
// `orders.line_items[].product_id` was only 4-12% populated before July 2026
// (94% after), so for a tenured customer that absence usually means "we
// cannot see their history", not "they never bought it".
//
// The failing state this pins, observed in production: the first 132 drafted
// asks were 132/132 "you tried it for the first time" — and 96 of those
// customers had SIX OR MORE prior orders. Absence of evidence was going out
// to customers as evidence of absence.

test("a blind history withholds the first-time claim, keeping the neutral copy", () => {
  const cls = classifyPostOrderWindow({
    orderCreatedAt: new Date(Date.now() - 22 * 86400_000).toISOString(),
    firstTimeForProduct: true,
    historyVisible: false,
    now: Date.now(),
  });
  assert.equal(
    cls.window,
    null,
    "an unreadable history must not assert 'you tried it for the first time'",
  );
  assert.equal(cls.ready, true, "withholding the claim must not withhold the ask");
});

test("a visible history still makes the first-time claim", () => {
  const cls = classifyPostOrderWindow({
    orderCreatedAt: new Date(Date.now() - 22 * 86400_000).toISOString(),
    firstTimeForProduct: true,
    historyVisible: true,
    now: Date.now(),
  });
  assert.equal(cls.window, "first-time");
});

test("a blind history keeps the LONGER first-time cadence, never the 10-day one", () => {
  const orderedAt = new Date(Date.now() - 12 * 86400_000).toISOString();
  const cls = classifyPostOrderWindow({
    orderCreatedAt: orderedAt,
    firstTimeForProduct: true,
    historyVisible: false,
    now: Date.now(),
  });
  // 12 days in: past the 10d repeat window, short of the 21d first-time one.
  // Withholding the claim must not silently promote them to the fast cadence.
  assert.equal(cls.ready, false, "a blind candidate must still wait the 21-day window");
});

test("a known repeat buyer is unaffected by the blind-history rail", () => {
  const cls = classifyPostOrderWindow({
    orderCreatedAt: new Date(Date.now() - 11 * 86400_000).toISOString(),
    firstTimeForProduct: false,
    historyVisible: false,
    now: Date.now(),
  });
  assert.equal(cls.window, "repeat", "a positive match is evidence; only absence is unreliable");
  assert.equal(cls.ready, true);
});
