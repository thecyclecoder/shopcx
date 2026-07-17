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
import { canonicalizeEmail } from "./email-utils";

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

/**
 * Phase 4 wedge — ticket 54f0f29e (Julie Metz). Her real record and her Gmail dot-variant
 * shadow share the same canonical inbox; the email BRANCH of findUnlinkedMatches now matches
 * candidates by `email_canonical` equality (Phase 2 index), so both surface as email-signal
 * candidates for grading. This test pins the two shape guarantees the widening rests on:
 *
 *   1. `canonicalizeEmail` collapses the source (`metz.julie323@gmail.com`) and the stored
 *      twin (`metzjulie323@gmail.com`) to the SAME key → the DB `.eq('email_canonical', src)`
 *      selects the twin as a candidate.
 *   2. The grader accepts an email-only candidate (signals: ['email']) as at-least LOW and
 *      surfaces it — the widening's whole point. If the grader silently dropped it, Phase 4
 *      would surface no new candidates in practice.
 *
 * Grader stays unchanged (name/phone/address corroboration still required for HIGH); this
 * only widens the candidate pool. The email-signal-only case grades LOW so a namesake
 * shadow can never auto-link — Sol/June still confirm before proposing.
 */
test("Phase 4 wedge — Gmail dot-variant twin surfaces via the email branch", () => {
  // 1. Shape guarantee — source and twin share a canonical → the DB query would surface the twin.
  const sourceEmail = "metz.julie323@gmail.com";
  const twinStoredEmail = "metzjulie323@gmail.com";
  assert.equal(
    canonicalizeEmail(sourceEmail),
    canonicalizeEmail(twinStoredEmail),
    "Julie's dot-variant and stored twin must canonicalize equal — otherwise the .eq('email_canonical', src) branch cannot match them",
  );

  // 2. Behaviour guarantee — the grader surfaces an email-only candidate (as LOW).
  //    The DB branch (`.eq('email_canonical', src)`) tags the candidate with signals:['email'];
  //    the grader must include it in output so `findUnlinkedMatches` returns the twin.
  const src: GradeSource = { last_name: "Metz", address1: null, zip: null };
  const twinCandidate: CandidateInput = {
    id: "twin",
    email: twinStoredEmail,
    last_name: null,
    address1: null,
    zip: null,
    signals: ["email"],
  };
  const out = gradeUnlinkedCandidates(src, [twinCandidate], new Set(), new Set());
  assert.equal(out.length, 1, "email-signal-only twin must be surfaced as a candidate");
  assert.equal(out[0].id, "twin");
  assert.deepEqual(out[0].signals, ["email"]);
  // Grader keeps confidence LOW — same-inbox alone doesn't equal same-person for Sol/June's
  // auto-link decision. A name/address/phone corroboration is still required for HIGH.
  assert.equal(out[0].confidence, "low");
});

test("Phase 4 — non-gmail addresses stay DISTINCT (dots significant outside Gmail)", () => {
  // The widening must NOT fuse `first.last@fastmail.com` and `firstlast@fastmail.com` —
  // those are distinct inboxes at every non-Gmail provider. If canonicalization collapsed
  // them, findUnlinkedMatches would surface unrelated customers as email candidates.
  assert.notEqual(
    canonicalizeEmail("first.last@fastmail.com"),
    canonicalizeEmail("firstlast@fastmail.com"),
  );
});
