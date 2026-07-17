/**
 * winners-flow — advertiser-resolution ranker. STRICT name matching (normalized-equal, or brand + a single
 * corporate suffix) so the loose token/prefix matcher can't mis-pick a wrong big page. Pins the live cases
 * (2026-07-17). Pure — no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pickBestCandidate, nameMatches } from "./adlibrary-winners";

test("exact (punctuation/space-insensitive) matches: MUD\\WTR ~ 'MUD WTR', Obvi ~ Obvi", () => {
  assert.equal(nameMatches("MUD\\WTR", "MUD WTR"), true);
  assert.equal(nameMatches("Obvi", "Obvi"), true);
  assert.equal(nameMatches("Organifi", "organifi"), true);
});

test("brand + a single corporate suffix matches (Vital Proteins ~ 'Vital Proteins LLC')", () => {
  assert.equal(nameMatches("Vital Proteins", "Vital Proteins LLC"), true);
  assert.equal(nameMatches("Cymbiotika", "Cymbiotika Inc"), true);
});

test("loose token/prefix collisions do NOT match (the bugs we fixed)", () => {
  assert.equal(nameMatches("Bulletproof", "Bulletproof Automotive"), false);
  assert.equal(nameMatches("RYZE", "Ryze Hendricks"), false);
  assert.equal(nameMatches("Beam Dream", "Do Architects Dream of Concrete Beams?"), false);
  assert.equal(nameMatches("Live it Up", "Live Update Pvt Ltd"), false);
  assert.equal(nameMatches("trip", "Triple H"), false);
});

test("pickBestCandidate: MUD\\WTR picks the real 124K page; the bogus 0-like 'Wellness' no longer matches", () => {
  const m = pickBestCandidate("MUD\\WTR", [
    { id: "bogus", name: "Mud Wtr Wellness", likes: 0 }, // no longer matches (strict)
    { id: "real", name: "MUD\\WTR", likes: 124502 },
  ]);
  assert.equal(m?.id, "real");
});

test("no strict match → null (routes to domain lane / bad seed)", () => {
  assert.equal(pickBestCandidate("Beam Dream", [{ id: "x", name: "Do Architects Dream of Concrete Beams?", likes: 99999 }]), null);
});
