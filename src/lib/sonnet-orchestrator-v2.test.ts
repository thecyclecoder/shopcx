/**
 * Unit tests for the Phase-2 adoption WARN counter on Sonnet's
 * decision-record fields (ticket-resolution-events-writeahead-ledger-
 * and-decision-schema-extension). Pure helper — no network, no DB. Run:
 *   npm run test:sonnet-orchestrator
 *   (= tsx --test src/lib/sonnet-orchestrator-v2.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  warnOnMissingResolutionFields,
  resolutionSchemaAdoption,
  type SonnetDecision,
} from "./sonnet-orchestrator-v2";

function resetCounters(): void {
  resolutionSchemaAdoption.total = 0;
  resolutionSchemaAdoption.missingProblem = 0;
  resolutionSchemaAdoption.missingConfidence = 0;
  resolutionSchemaAdoption.missingOptions = 0;
  resolutionSchemaAdoption.missingChosen = 0;
}

// ── Named failing state ────────────────────────────────────────────────
// Spec Phase-2 verification bullet #2: "On a Sonnet run where the model
// omits the new fields (backward-compat check) → expect the decision
// still executes AND a WARN counter increments in structured logs".
// The smallest test for that exact state: a real, parsed decision with
// none of the new fields → every miss flagged, total counter +1, and
// the decision itself is not mutated (still executable).
test("real decision missing every new field → 4 misses, adoption total +=1, decision still executes", () => {
  resetCounters();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string) => { warnings.push(String(msg)); };
  try {
    const decision: SonnetDecision = {
      reasoning: "test",
      action_type: "ai_response",
      response_message: "hi",
    };
    const missing = warnOnMissingResolutionFields(decision);
    assert.deepEqual(
      missing.sort(),
      ["chosen", "confidence", "options", "problem"],
      "every new field should be flagged missing",
    );
    assert.equal(resolutionSchemaAdoption.total, 1, "adoption counter should tick once per missed decision");
    assert.equal(resolutionSchemaAdoption.missingProblem, 1);
    assert.equal(resolutionSchemaAdoption.missingConfidence, 1);
    assert.equal(resolutionSchemaAdoption.missingOptions, 1);
    assert.equal(resolutionSchemaAdoption.missingChosen, 1);
    assert.equal(warnings.length, 1, "one structured WARN emitted");
    assert.ok(
      warnings[0].includes("[resolution-schema-adoption]"),
      `WARN should carry the aggregation prefix, got: ${warnings[0]}`,
    );
    // Backward-compat: decision itself is unchanged; the executor still
    // ships response_message as usual.
    assert.equal(decision.action_type, "ai_response");
    assert.equal(decision.response_message, "hi");
  } finally {
    console.warn = originalWarn;
  }
});

// A fully-populated decision must NOT tick any counter — the WARN is
// specifically the "adoption gap" signal, not a per-decision heartbeat.
test("real decision with all four new fields → no misses, no WARN, no counter tick", () => {
  resetCounters();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string) => { warnings.push(String(msg)); };
  try {
    const decision: SonnetDecision = {
      reasoning: "test",
      action_type: "direct_action",
      problem: "customer wants to pause",
      confidence: 0.9,
      options: [
        { label: "pause 30d", expected_effect: "next order pushed 30d" },
      ],
      chosen: { option_index: 0, why: "matches ask" },
    };
    const missing = warnOnMissingResolutionFields(decision);
    assert.deepEqual(missing, []);
    assert.equal(resolutionSchemaAdoption.total, 0);
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});

// Partial adoption is the realistic path during rollout — the counter
// still ticks (there IS a gap) but only the specific missed fields flag.
test("partial adoption (problem + confidence only) → 2 misses tallied on the specific counters", () => {
  resetCounters();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const decision: SonnetDecision = {
      reasoning: "test",
      action_type: "ai_response",
      problem: "shipping question",
      confidence: 0.7,
      // options + chosen deliberately absent
    };
    const missing = warnOnMissingResolutionFields(decision);
    assert.deepEqual(missing.sort(), ["chosen", "options"]);
    assert.equal(resolutionSchemaAdoption.missingProblem, 0);
    assert.equal(resolutionSchemaAdoption.missingConfidence, 0);
    assert.equal(resolutionSchemaAdoption.missingOptions, 1);
    assert.equal(resolutionSchemaAdoption.missingChosen, 1);
    assert.equal(resolutionSchemaAdoption.total, 1);
  } finally {
    console.warn = originalWarn;
  }
});

// NaN confidence is a real-model artifact when the model emits invalid
// JSON that JSON.parse coerces to NaN. Must count as missing (would
// otherwise poison the ticket_resolution_events.confidence CHECK gate).
test("NaN / non-finite confidence counts as missing", () => {
  resetCounters();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const decision: SonnetDecision = {
      reasoning: "test",
      action_type: "ai_response",
      problem: "x",
      confidence: Number.NaN,
      options: [],
      chosen: { option_index: 0, why: "x" },
    };
    const missing = warnOnMissingResolutionFields(decision);
    assert.deepEqual(missing, ["confidence"]);
    assert.equal(resolutionSchemaAdoption.missingConfidence, 1);
  } finally {
    console.warn = originalWarn;
  }
});
