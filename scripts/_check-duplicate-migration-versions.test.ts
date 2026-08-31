/**
 * Tests for the migration-version collision guard — specifically the CROSS-BRANCH half.
 *
 * Pinned on the real incident (2026-08-28): `review-collection-foundations` merged at 17:45 with
 * `20261215120000_review_collection_foundations.sql`; PR #2617 merged at 18:15 with
 * `20261215120000_subscription_cycle_charges.sql`, its branch based on a commit predating the
 * first merge. Each branch was clean ON ITS OWN, so the pre-existing local check passed both.
 * The collision only existed post-merge: one migration was silently skipped, the code upserting
 * into the un-created table shipped, every write hit PGRST205, and Reva rolled the deploy back.
 *
 * Registered as `test:duplicate-migration-versions`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCrossBranchCollisions, extractPrefix } from "./_check-duplicate-migration-versions";

test("catches the 2026-08-28 incident: same version, different file on the merge target", () => {
  const branch = ["20261215120000_subscription_cycle_charges.sql"];
  const main = ["20261215120000_review_collection_foundations.sql", "20261214120000_other.sql"];
  const hits = detectCrossBranchCollisions(branch, main);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].version, "20261215120000");
  assert.match(hits[0].files.join(" "), /subscription_cycle_charges/);
  assert.match(hits[0].files.join(" "), /review_collection_foundations\.sql \(on merge target\)/);
});

test("does NOT fire when the branch simply already contains main's file", () => {
  // A branch rebased onto main carries main's migrations verbatim — same version, SAME filename.
  // Flagging that would fail every ordinary branch.
  const same = ["20261215120000_review_collection_foundations.sql"];
  assert.deepEqual(detectCrossBranchCollisions(same, same), []);
});

test("does NOT fire on a genuinely new version", () => {
  const branch = ["20261215140000_subscription_cycle_charges.sql"];
  const main = ["20261215120000_review_collection_foundations.sql"];
  assert.deepEqual(detectCrossBranchCollisions(branch, main), []);
});

test("reports every colliding version, sorted", () => {
  const branch = ["20261215120000_b.sql", "20261214120000_a.sql", "20261216120000_ok.sql"];
  const main = ["20261215120000_x.sql", "20261214120000_y.sql"];
  const hits = detectCrossBranchCollisions(branch, main);
  assert.deepEqual(hits.map((h) => h.version), ["20261214120000", "20261215120000"]);
});

test("ignores files that don't follow the timestamp convention", () => {
  const branch = ["_PENDING_scratch.sql", "readme.sql"];
  const main = ["20261215120000_review_collection_foundations.sql"];
  assert.deepEqual(detectCrossBranchCollisions(branch, main), []);
  assert.equal(extractPrefix("_PENDING_scratch.sql"), null);
  assert.equal(extractPrefix("20261215120000_x.sql"), "20261215120000");
});

test("empty inputs are a no-op, never a false red", () => {
  assert.deepEqual(detectCrossBranchCollisions([], ["20261215120000_a.sql"]), []);
  assert.deepEqual(detectCrossBranchCollisions(["20261215120000_a.sql"], []), []);
});
