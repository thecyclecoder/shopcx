/**
 * winners-flow — advertiser-resolution ranker. STRICT name matching (normalized-equal, or brand + a single
 * corporate suffix) so the loose token/prefix matcher can't mis-pick a wrong big page. Pins the live cases
 * (2026-07-17). Pure — no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pickBestCandidate, nameMatches, parseScanWinnersBody } from "./adlibrary-winners";

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

// ── parseScanWinnersBody — the silent-per-competitor-drop fix (spec Phase 1) ─────────
// The old shape sniff (`trimmed.startsWith("{") && includes('"results"') && !includes("\n{")`)
// mis-routed a cached JSON body whose nested arrays contained `\n{` to the NDJSON path — every
// per-line JSON.parse then threw and the parser returned []. That reproduced the Creamer silent
// drop (Obvi/NativePath/Vital Proteins yielded 0 skeletons though the endpoint returned ads fine).

test("parseScanWinnersBody: cached JSON with nested newlines still parses (the Creamer/Obvi silent-drop fix)", () => {
  const body = JSON.stringify(
    {
      summary: { total: 2 },
      results: [
        { ad: { ad_key: "a1", advertiser: "Obvi", page_id: "2431731276838642" }, score: { tier: "winner", composite: 88 } },
        { ad: { ad_key: "a2", advertiser: "Obvi" }, score: { tier: "high_confidence_winner", composite: 92 } },
      ],
    },
    null,
    2, // pretty-print → nested `\n{` inside content-arrays. The old sniff mis-routed this to NDJSON.
  );
  const scored = parseScanWinnersBody(body);
  assert.equal(scored.length, 2);
  assert.equal((scored[0].ad as { ad_key: string }).ad_key, "a1");
  assert.equal((scored[1].ad as { ad_key: string }).ad_key, "a2");
});

test("parseScanWinnersBody: dense JSON with no nested newlines (the original cached shape)", () => {
  const body = `{"summary":{"total":1},"results":[{"ad":{"ad_key":"x1","advertiser":"MUD\\\\WTR"},"score":{"tier":"winner","composite":80}}]}`;
  const scored = parseScanWinnersBody(body);
  assert.equal(scored.length, 1);
  assert.equal((scored[0].ad as { ad_key: string }).ad_key, "x1");
});

test("parseScanWinnersBody: NDJSON fresh-run stream still works (the fallback path)", () => {
  const body = [
    JSON.stringify({ _stage: "start" }),
    JSON.stringify({ _stage: "score", ad: { ad_key: "n1", advertiser: "Vital Proteins" }, score: { tier: "winner" } }),
    "not-json-noise", // must be tolerated
    JSON.stringify({ _stage: "score", ad: { ad_key: "n2", advertiser: "Vital Proteins" }, score: { tier: "middle" } }),
    JSON.stringify({ _stage: "done" }),
  ].join("\n");
  const scored = parseScanWinnersBody(body);
  assert.equal(scored.length, 2);
  assert.equal((scored[0].ad as { ad_key: string }).ad_key, "n1");
  assert.equal((scored[1].ad as { ad_key: string }).ad_key, "n2");
});

test("parseScanWinnersBody: empty/blank body returns []", () => {
  assert.deepEqual(parseScanWinnersBody(""), []);
  assert.deepEqual(parseScanWinnersBody("   \n   "), []);
});
