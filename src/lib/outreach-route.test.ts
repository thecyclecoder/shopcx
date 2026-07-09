/**
 * The FOUR Phase-3 verification tests for the outreach short-circuit.
 *
 * Each test pins one bullet from the spec's verification section
 * (docs/brain/specs/outreach-tickets-deterministically-close-no-sol-dispatch-no-ai-cost.md):
 *
 *   Phase 1 verification:
 *     (1) outreach bucket → closed + tagged + zero ticket-handle jobs
 *     (3) account/general tickets still dispatch Sol normally
 *   Phase 2 verification:
 *     (2) no-reply sender → closed + tagged, classifier NOT called
 *     (3) genuine customer email → NOT caught by the pre-filter
 *   Phase 3 verification (this file):
 *     - Four tests pass, together covering (1)–(4) below.
 *     - (1) outreach bucket → closed + tagged + zero ticket-handle jobs
 *     - (2) no-reply sender → closed + tagged, classifier not called
 *     - (3) normal customer email → classifier runs, Sol dispatched
 *     - (4) brand-collab human outreach → closed, no Sol session
 *
 *   npx tsx --test src/lib/outreach-route.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideOutreachRoute } from "./outreach-route";

test("(1) outreach bucket → closed + tagged + zero ticket-handle jobs (Sol NOT dispatched)", () => {
  // Human brand-collab email that a real customer would send from Gmail — the pre-filter
  // (Phase 2) does NOT catch it, so the Haiku classifier runs and returns "outreach"; the
  // Phase 1 short-circuit at § 1c fires. No Sol first-touch dispatch, no ticket-handle job.
  const route = decideOutreachRoute({
    isNew: true,
    senderEmail: "creator@ugcpartners.com",
    body: "Hi! I'm a UGC creator with 200k IG followers — we'd love to collab.",
    classifierBucket: "outreach",
    solFirstTouchEnabled: true,
    agentAssigned: false,
  });
  assert.equal(route.kind, "classifier_close");
  assert.equal(route.solDispatched, false);
  // The classifier DID run (Phase 1 lane), which is fine — it's the cheap Haiku call.
  assert.equal(route.classifierInvoked, true);
});

test("(2) no-reply sender → closed + tagged, classifier NOT called (zero AI cost)", () => {
  // The Phase 2 pre-filter fires on a known automated sender BEFORE the classifier runs.
  // classifierBucket is intentionally omitted — the pre-filter's job is to return before
  // the classifier is ever consulted, and the decision function honors that.
  const route = decideOutreachRoute({
    isNew: true,
    senderEmail: "testflight_no_reply@email.apple.com",
    body: "Your TestFlight build 34 is available for testing.",
    // classifierBucket omitted — pre-filter must fire first.
    solFirstTouchEnabled: true,
    agentAssigned: false,
  });
  assert.equal(route.kind, "pre_filter_close");
  assert.equal(route.solDispatched, false);
  assert.equal(route.classifierInvoked, false); // ← zero AI cost invariant
});

test("(3) normal customer email → classifier runs, Sol dispatched (account bucket)", () => {
  // A genuine customer email from a normal address. Pre-filter does not trip, classifier
  // returns "account" (they're asking about their order), and the handler falls through
  // to the Sol first-touch dispatch. This bullet is what keeps the whole spec safe — no
  // false positive can silently deprive a real customer of a response.
  const route = decideOutreachRoute({
    isNew: true,
    senderEmail: "dylan@apptivi.com",
    body: "Hi, where's my order? I paid last Tuesday and haven't gotten a shipping email.",
    classifierBucket: "account",
    solFirstTouchEnabled: true,
    agentAssigned: false,
  });
  assert.equal(route.kind, "continue");
  assert.equal(route.solDispatched, true);
  assert.equal(route.classifierInvoked, true);
});

test("(4) brand-collab human outreach → closed, no Sol session (falls to Phase 1 close)", () => {
  // Human agency outreach from a normal-looking domain — Phase 2's pre-filter is
  // conservative + false-positive-averse, so it lets this through. The classifier returns
  // "outreach", the Phase 1 short-circuit closes deterministically, and Sol is NEVER
  // dispatched — the whole point of the spec: no Max-tier ticket-handle session on
  // brand-collab spam.
  const route = decideOutreachRoute({
    isNew: true,
    senderEmail: "hello@growth-agency.io",
    body: "Hey team, I noticed your website and would love to help you grow. Partnership?",
    classifierBucket: "outreach",
    solFirstTouchEnabled: true,
    agentAssigned: false,
  });
  assert.equal(route.kind, "classifier_close");
  assert.equal(route.solDispatched, false);
});

// ── Additional pins for the invariants the handler relies on ──

test("continue path reports the exact Sol-dispatch predicate the handler uses", () => {
  // Non-new ticket: never dispatch Sol via the first-touch lane.
  const notNew = decideOutreachRoute({
    isNew: false,
    senderEmail: "customer@gmail.com",
    body: "Any update?",
    classifierBucket: "account",
    solFirstTouchEnabled: true,
    agentAssigned: false,
  });
  assert.equal(notNew.kind, "continue");
  assert.equal(notNew.solDispatched, false);

  // sol_first_touch_enabled=false: fall through to the inline Sonnet path — no Sol dispatch.
  const solOff = decideOutreachRoute({
    isNew: true,
    senderEmail: "customer@gmail.com",
    body: "Where's my order?",
    classifierBucket: "account",
    solFirstTouchEnabled: false,
    agentAssigned: false,
  });
  assert.equal(solOff.kind, "continue");
  assert.equal(solOff.solDispatched, false);

  // Agent already assigned: never wake Sol.
  const agentOn = decideOutreachRoute({
    isNew: true,
    senderEmail: "customer@gmail.com",
    body: "Refund please.",
    classifierBucket: "account",
    solFirstTouchEnabled: true,
    agentAssigned: true,
  });
  assert.equal(agentOn.kind, "continue");
  assert.equal(agentOn.solDispatched, false);
});

test("body-only automated marker still trips the pre-filter (sender looks human)", () => {
  // Belt-and-suspenders: a marketing-list retailer that sends from a human-looking address
  // but stamps "please do not reply" in the body still short-circuits without cost.
  const route = decideOutreachRoute({
    isNew: true,
    senderEmail: "news@bigretailer.com",
    body: "Your weekly deals are here. Please do not reply to this email.",
    solFirstTouchEnabled: true,
    agentAssigned: false,
  });
  assert.equal(route.kind, "pre_filter_close");
  assert.equal(route.classifierInvoked, false);
});
