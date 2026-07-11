/**
 * Pins `gradeUnlinkedCandidates` — address-aware, confidence-graded account matching.
 * The wedge is ticket db8b3d66: a real same-person duplicate (same last name + same exact address)
 * must surface as HIGH confidence and RE-SURFACE despite a prior weak name-only bulk rejection,
 * while 15 common-name namesakes stay LOW and a rejected LOW match stays hidden.
 *
 * Run: npx tsx --test src/lib/account-matching.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { gradeUnlinkedCandidates, type CandidateInput, type GradeSource } from "./account-matching";

const SRC: GradeSource = { last_name: "Johnson", address1: "3 Grassy Pond Road", zip: "02873" };
const cand = (over: Partial<CandidateInput> & { id: string }): CandidateInput => ({
  email: `${over.id}@x.com`, last_name: "Johnson", address1: null, zip: null, signals: ["name"], ...over,
});

test("same last name + same address → HIGH (the real duplicate)", () => {
  const out = gradeUnlinkedCandidates(SRC, [cand({ id: "rustin", address1: "3 Grassy Pond Road", zip: "02873" })], new Set(), new Set());
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, "high");
  assert.deepEqual(out[0].signals.sort(), ["address", "name"]);
});

test("HIGH match re-surfaces DESPITE a prior rejection, flagged previously_rejected", () => {
  const out = gradeUnlinkedCandidates(
    SRC,
    [cand({ id: "rustin", address1: "3 Grassy Pond Road", zip: "02873" })],
    new Set(),
    new Set(["rustin"]), // the db8b3d66 bulk rejection
  );
  assert.equal(out.length, 1, "high match is not suppressed by a weak prior rejection");
  assert.equal(out[0].confidence, "high");
  assert.equal(out[0].previously_rejected, true);
});

test("common-name namesake (name only, different address) → LOW", () => {
  const out = gradeUnlinkedCandidates(SRC, [cand({ id: "namesake", address1: "99 Other St", zip: "10001" })], new Set(), new Set());
  assert.equal(out[0].confidence, "low");
  assert.deepEqual(out[0].signals, ["name"]);
});

test("LOW namesake that was rejected → stays hidden", () => {
  const out = gradeUnlinkedCandidates(SRC, [cand({ id: "namesake" })], new Set(), new Set(["namesake"]));
  assert.equal(out.length, 0);
});

test("shared phone → HIGH even without address", () => {
  const out = gradeUnlinkedCandidates(SRC, [cand({ id: "byphone", signals: ["phone"], last_name: "Different" })], new Set(), new Set());
  assert.equal(out[0].confidence, "high");
});

test("same address but DIFFERENT last name (household member) → LOW, not high", () => {
  const out = gradeUnlinkedCandidates(
    SRC,
    [cand({ id: "spouse", last_name: "Smith", address1: "3 Grassy Pond Road", zip: "02873" })],
    new Set(), new Set(),
  );
  assert.equal(out[0].confidence, "low");
  assert.ok(out[0].signals.includes("address"));
});

test("already-linked candidate → excluded entirely", () => {
  const out = gradeUnlinkedCandidates(
    SRC,
    [cand({ id: "linked", address1: "3 Grassy Pond Road", zip: "02873" })],
    new Set(["linked"]), new Set(),
  );
  assert.equal(out.length, 0);
});

test("HIGH sorts before LOW", () => {
  const out = gradeUnlinkedCandidates(
    SRC,
    [
      cand({ id: "low", address1: "99 Other St", zip: "10001" }),
      cand({ id: "high", address1: "3 Grassy Pond Road", zip: "02873" }),
    ],
    new Set(), new Set(),
  );
  assert.equal(out[0].id, "high");
  assert.equal(out[1].id, "low");
});

test("address normalisation tolerates case + whitespace", () => {
  const out = gradeUnlinkedCandidates(
    { last_name: "Johnson", address1: "  3  GRASSY pond road ", zip: "02873" },
    [cand({ id: "rustin", address1: "3 Grassy Pond Road", zip: "02873" })],
    new Set(), new Set(),
  );
  assert.equal(out[0].confidence, "high");
});
