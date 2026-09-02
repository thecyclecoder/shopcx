/**
 * Pins the Phase 2 invariants for docs/brain/specs/review-request-post-order-ask.md:
 *
 *   1. **The copy shape branches on TRIGGER.** The ticket ask can reference
 *      a conversation that just happened — that's where its warmth comes
 *      from. The post-order ask has no thread; a message that gestures at
 *      a support interaction that never occurred reads worse than a plain
 *      one. This is the failing state the spec pins verbatim: the post-
 *      order composer must NEVER emit thank-you / support-conversation
 *      language.
 *
 *   2. **The angle labels are stable across triggers.** The rubric's
 *      `unapproved_pretext` rail reads `draft.angle` (the raw angle set),
 *      NOT the ladder-row's trigger-prefixed label. The composer's angle
 *      branch (defend vs fence-sitter) must remain independent of
 *      trigger; a divergence would leak angle labels the validator
 *      doesn't recognize.
 *
 *   3. **SMS block layout survives the composer.** The validator's
 *      `sms_link_not_on_its_own_line` and `sms_missing_block_layout` rails
 *      hard-block a shipped message; the composer's SMS branch must ship
 *      output that passes both rails at once.
 *
 * The failing state these exist to prevent: a composer that thanks a
 * customer "for reaching out" over a post-order trigger (fabricated
 * support interaction), or one that emits a run-on SMS that fails the
 * validator's block-layout rails.
 *
 * Run: npx tsx --test src/lib/review-request-compose.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { composeReviewRequestFirstTouchBody } from "./review-request-compose";
import { validateReviewRequest } from "./review-request-validator";

test("post-order: NEVER references a support conversation (no fabricated warmth)", () => {
  // The named failing state — a post-order composer that emits "thanks
  // for reaching out" over an event where the customer never reached out
  // is worse than a plain message. This test asserts the CORRECT state:
  // the post-order body must not contain the ticket-trigger warmth
  // markers.
  const { body } = composeReviewRequestFirstTouchBody({
    trigger: "post-order",
    channel: "email",
    angle: "fence-sitter",
    productName: "Superfood Tabs",
    customerFirstName: "Amy",
    reviewUrl: "https://x/review/abcd",
    window: "repeat",
    tenureDays: 400,
  });
  assert.doesNotMatch(body, /reaching out/i);
  assert.doesNotMatch(body, /glad we got you sorted/i);
  assert.doesNotMatch(body, /thanks again/i);
});

test("post-order + repeat: leans on the 'ordered again' warrant", () => {
  const { body } = composeReviewRequestFirstTouchBody({
    trigger: "post-order",
    channel: "email",
    angle: "fence-sitter",
    productName: "Creatine Prime+",
    customerFirstName: "Sam",
    reviewUrl: "https://x/review/xyz",
    window: "repeat",
    tenureDays: 400,
  });
  assert.match(body, /ordered .* again/i);
  assert.match(body, /Creatine Prime\+/);
});

test("post-order + first-time: leans on the 'tried for the first time' warrant", () => {
  const { body } = composeReviewRequestFirstTouchBody({
    trigger: "post-order",
    channel: "email",
    angle: "fence-sitter",
    productName: "Sleep Gummies",
    customerFirstName: "Sam",
    reviewUrl: "https://x/review/xyz",
    window: "first-time",
    tenureDays: 200,
  });
  assert.match(body, /tried .* for the first time/i);
  assert.match(body, /Sleep Gummies/);
});

test("ticket trigger: keeps the thread warmth phrasing", () => {
  const { body } = composeReviewRequestFirstTouchBody({
    trigger: "ticket",
    channel: "email",
    angle: "fence-sitter",
    productName: "Superfood Tabs",
    customerFirstName: "Amy",
    reviewUrl: "https://x/review/abcd",
    window: null,
  });
  assert.match(body, /Thanks again for reaching out/i);
});

test("post-order email: subject names the product so the customer sees what the ask is about", () => {
  const { subject } = composeReviewRequestFirstTouchBody({
    trigger: "post-order",
    channel: "email",
    angle: "fence-sitter",
    productName: "Amazing Coffee",
    customerFirstName: null,
    reviewUrl: "https://x/review/xyz",
    window: "repeat",
    tenureDays: 500,
  });
  assert.match(subject, /Amazing Coffee/);
});

test("post-order sms: passes the shared validator's block-layout + link-line + STOP rails", () => {
  // The reuse invariant — the shared composer must produce SMS that
  // survives the shared validator's SMS-shape rails. A regression here
  // would ship a runaway or run-on SMS that the validator hard-blocks.
  const { body, subject } = composeReviewRequestFirstTouchBody({
    trigger: "post-order",
    channel: "sms",
    angle: "fence-sitter",
    productName: "Sleep Gummies",
    customerFirstName: "Ren",
    reviewUrl: "https://x/review/xyz",
    window: "first-time",
    tenureDays: 90,
  });
  const verdict = validateReviewRequest({
    channel: "sms",
    subject,
    body,
    tenureDays: 90,
    orderCount: 2,
    angle: "fence-sitter",
    productName: "Sleep Gummies",
    coupon: { include: false },
    smsShortlink: "https://x/review/xyz",
  });
  assert.equal(
    verdict.allow,
    true,
    `expected allow=true, got reasons=${verdict.reasons.join(",")}`,
  );
});

test("both triggers respect the SAME angle set (defend / fence-sitter) — the validator's unapproved_pretext rail sees the same value regardless of trigger", () => {
  // Structural check — the trigger label is a ladder-row concern, not a
  // draft/validator concern. If a future edit made the composer key its
  // angle branch off the trigger, the validator's `unapproved_pretext`
  // rail would blow up on the leaked prefix.
  const ticket = composeReviewRequestFirstTouchBody({
    trigger: "ticket",
    channel: "email",
    angle: "defend",
    productName: "Amazing Coffee",
    customerFirstName: "Ali",
    reviewUrl: "https://x/review/xyz",
    window: null,
  });
  const post = composeReviewRequestFirstTouchBody({
    trigger: "post-order",
    channel: "email",
    angle: "defend",
    productName: "Amazing Coffee",
    customerFirstName: "Ali",
    reviewUrl: "https://x/review/xyz",
    window: "repeat",
    tenureDays: 400,
  });
  // Both `defend` bodies carry the "worried about whether it actually
  // works" antagonist claim — the angle branch is trigger-agnostic.
  assert.match(ticket.body, /worried about whether/i);
  assert.match(post.body, /worried about whether/i);
});

// 4. **The review link must point at a route that exists.** The post-order
//    sender minted `/journey/product-review/<token>` — a path with no
//    `src/app` route — so every ask it drafted would have landed the
//    customer on a 404. The composer's own tests passed because they
//    asserted the string, never the route. Pin the path to the real
//    public magic-link route so a rename has to break this test first.
test("the review link path resolves to a real app route", () => {
  const senderSrc = readFileSync(
    new URL("./review-request-sender.ts", import.meta.url),
    "utf8",
  );
  const match = senderSrc.match(/const reviewUrl = `\$\{siteUrl\}(\/[^$`]*)\$\{token\}`/);
  assert.ok(match, "review-request-sender must build reviewUrl from siteUrl + a literal path + token");
  const path = match![1];
  assert.equal(path, "/review/", `review link path ${path} is not the public magic-link route`);
  assert.ok(
    existsSync(new URL(`../app${path}[token]/page.tsx`, import.meta.url)),
    `no src/app${path}[token]/page.tsx — the review link would 404`,
  );
});

// 5. **The review-request ticket lands closed.** The ask is one-way; there is
//    no reply expected and no agent work to do. Creating it `open` put 91
//    tickets into the CS queue in a single night. The inbound webhook
//    reopens a closed ticket when the customer actually writes back, so
//    closed-on-create loses nothing.
test("the post-order ask creates its ticket closed, not open", () => {
  const senderSrc = readFileSync(
    new URL("./review-request-sender.ts", import.meta.url),
    "utf8",
  );
  const insert = senderSrc.slice(senderSrc.indexOf('subject: `Review request'));
  const status = insert.match(/status: "(\w+)"/);
  assert.ok(status, "review-request ticket insert must set an explicit status");
  assert.equal(
    status![1],
    "closed",
    "a review request is a one-way ask — an open ticket lands in the CS queue with no work to do",
  );
});

// 6. **A submitted review carries the reviewer's name.** The journey's insert
//    set customer_id but never `reviewer_name`, so every review it wrote
//    rendered as "Anonymous" on /dashboard/reviews and the PDP — against
//    10,745 legacy rows that all read "First L.". The customer signed it with
//    their name; the byline has to show it.
test("the review insert populates reviewer_name from the customer", () => {
  const coreSrc = readFileSync(
    new URL("./review-journey-core.ts", import.meta.url),
    "utf8",
  );
  const insert = coreSrc.slice(coreSrc.indexOf('.from("product_reviews")'));
  assert.match(
    insert,
    /reviewer_name:/,
    "product_reviews insert must set reviewer_name or the review renders as Anonymous",
  );
  // "First L." — the shape every named legacy review uses.
  assert.match(
    coreSrc,
    /\$\{firstName\} \$\{lastInitial\.toUpperCase\(\)\}\./,
    "reviewer_name must be built as First + last initial + period",
  );
});
