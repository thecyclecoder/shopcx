/**
 * The grader's most powerful output — `inaccuracy` — has to show its work.
 *
 * `inaccuracy` is the only issue type that BOTH caps the score and force-escalates. Its own
 * prompt already says a claim the grader "CANNOT SETTLE" must not be emitted as one, and that a
 * real one must "cite what you looked up and what it returned". That was prose; nothing enforced
 * it.
 *
 * Ticket b28e7744 (Juana) is the case: the grader read `subscriptions.items[].price_cents`
 * ($59.96 flat), concluded a 3-bag subscription bills $179.88, and flagged the AI's correct
 * "$158.30 is the subscribe-and-save price" as an inaccuracy. The quantity break isn't on the
 * line — it's an Appstle AUTOMATIC_DISCOUNT ("Buy 3 Discount", 12%) and a
 * `pricing_rules.quantity_breaks` row for internal subs. $79.95 × 3 × 0.75 × 0.88 = $158.30,
 * exactly as advertised. The claim was right; the grader's surface just didn't hold the discount
 * layer. It capped the score to 5 and silently re-opened a closed, human-resolved ticket.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  demoteUnevidencedInaccuracies,
  SEVERE_ISSUE_TYPES,
  UNVERIFIED_FROM_SURFACE_ISSUE_TYPE,
} from "./ticket-analyzer";

test("an inaccuracy with no evidence is demoted out of the severe set", () => {
  const [issue] = demoteUnevidencedInaccuracies([
    { type: "inaccuracy", description: "AI said $158.30 is the subscribe price; subs bill $59.96/bag flat." },
  ]);
  assert.equal(issue.type, UNVERIFIED_FROM_SURFACE_ISSUE_TYPE);
  assert.equal(
    SEVERE_ISSUE_TYPES.has(issue.type),
    false,
    "a demoted finding must not force-escalate",
  );
  assert.match(issue.description!, /demoted from inaccuracy/);
  assert.match(issue.description!, /\$158\.30/, "the original claim is preserved for a human");
});

test("an inaccuracy that cites its lookup keeps full weight", () => {
  const [issue] = demoteUnevidencedInaccuracies([
    {
      type: "inaccuracy",
      description: "AI quoted $47.99/unit.",
      evidence: { looked_up: "orders.line_items for SC137380", returned: "price_cents 5099 per unit" },
    },
  ]);
  assert.equal(issue.type, "inaccuracy");
  assert.equal(SEVERE_ISSUE_TYPES.has(issue.type), true);
});

test("half-filled evidence does not count", () => {
  for (const evidence of [
    { looked_up: "the subscription" },
    { returned: "$59.96" },
    { looked_up: "  ", returned: "  " },
    {},
    null,
    "I checked it",
  ]) {
    const [issue] = demoteUnevidencedInaccuracies([
      { type: "inaccuracy", description: "x", evidence },
    ]);
    assert.equal(
      issue.type,
      UNVERIFIED_FROM_SURFACE_ISSUE_TYPE,
      `evidence ${JSON.stringify(evidence)} should not qualify`,
    );
  }
});

test("other issue types are untouched, evidence or not", () => {
  const issues = demoteUnevidencedInaccuracies([
    { type: "false_promise", description: "promised a refund that never issued" },
    { type: "broken_action", description: "cancel claimed, sub still active" },
    { type: "drift", description: "two contradictory stories" },
    { type: "missed_opportunity", description: "no next step offered" },
  ]);
  assert.deepEqual(
    issues.map((i) => i.type),
    ["false_promise", "broken_action", "drift", "missed_opportunity"],
  );
});

test("empty / malformed input is safe", () => {
  assert.deepEqual(demoteUnevidencedInaccuracies([]), []);
  assert.deepEqual(demoteUnevidencedInaccuracies(null), []);
  assert.deepEqual(demoteUnevidencedInaccuracies(undefined), []);
});
