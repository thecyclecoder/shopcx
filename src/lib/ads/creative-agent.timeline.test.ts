/**
 * dahlia-max-live-timeline — the Dahlia→Max ping-pong narration onto agent_jobs.session_note.
 * Pins `humanizeReviseReason`, the pure mapper that turns an internal revise `lastReason` into the
 * short human phrase the session card shows (so a 10-min run reads "Dahlia revising (single promise
 * (pick one benefit))…" instead of a raw rail code or a blank card).
 *
 *   npx tsx --test src/lib/ads/creative-agent.timeline.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { humanizeReviseReason } from "./creative-agent";

test("single_promise validator fail → the plain-English 'pick one benefit' phrase (the Bloom→Creamer case)", () => {
  assert.equal(humanizeReviseReason("validator_failed: single_promise"), "single promise (pick one benefit)");
  // even when stacked with other rails, single_promise wins the phrasing
  assert.equal(humanizeReviseReason("validator_failed: single_promise, lf8"), "single promise (pick one benefit)");
});

test("each internal reason maps to a readable phrase", () => {
  assert.equal(humanizeReviseReason("validator_failed: no_competitor_leak"), "competitor brand leaked in");
  assert.equal(humanizeReviseReason("parse_failed: missing envelope"), "unparseable output");
  assert.equal(humanizeReviseReason("self_score_below_floor (total=4, floor=6)"), "self-score too low");
  assert.equal(humanizeReviseReason("cold_offer_leak"), "offer leaked into cold copy");
  assert.equal(humanizeReviseReason("paragraph_structure_failed: canonical=one_line"), "wrong paragraph shape");
  assert.equal(humanizeReviseReason("human_voice_failed: headline=em_dash"), "AI-tell phrasing (em-dash)");
  assert.equal(humanizeReviseReason("max_qc_below_floor: score=6"), "Max scored below 7/10");
  assert.equal(humanizeReviseReason("session_error"), "session error");
});

test("empty / unknown reasons degrade gracefully (never throws, never blank on a real reason)", () => {
  assert.equal(humanizeReviseReason(""), "revising");
  assert.equal(humanizeReviseReason("something_new_we_didnt_map"), "something_new_we_didnt_map");
});
