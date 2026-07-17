/**
 * winners-flow Phase 1 — advertiser-resolution ranker. Pins the two live-battle-tested lessons
 * (2026-07-17): pick the HIGHEST-LIKES name-matching candidate (not blind best_match), and match names
 * case/punctuation-insensitively. Pure — no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pickBestCandidate, nameMatches } from "./adlibrary-winners";

test("MUD\\WTR — picks the real 124K page over the bogus 0-like best_match", () => {
  const m = pickBestCandidate("MUD\\WTR", [
    { id: "bogus", name: "Mud Wtr Wellness", likes: 0 },
    { id: "real", name: "MUD\\WTR", likes: 124502 },
    { id: "gather", name: "MUD\\WTR :gather", likes: 63 },
  ]);
  assert.equal(m?.id, "real");
});

test("nameMatches is case/punctuation-insensitive (MUD\\WTR ~ 'MUD WTR')", () => {
  assert.equal(nameMatches("MUD\\WTR", "MUD WTR"), true);
  assert.equal(nameMatches("Obvi", "Obvi"), true);
  assert.equal(nameMatches("Vital Proteins", "Vital Proteins"), true);
});

test("an unrelated candidate does not match → null (bad seed signal)", () => {
  const m = pickBestCandidate("Zorbex", [{ id: "x", name: "Completely Different Brand", likes: 999999 }]);
  assert.equal(m, null);
});

test("among multiple name-matches, higher likes wins", () => {
  const m = pickBestCandidate("Bloom", [
    { id: "small", name: "Bloom", likes: 100 },
    { id: "big", name: "Bloom Nutrition", likes: 67734 },
  ]);
  assert.equal(m?.id, "big");
});
