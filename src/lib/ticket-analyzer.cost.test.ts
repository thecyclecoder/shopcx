/**
 * Unit tests for `analyzerCostCentsForRun` — the fleet-cost apiBilled rule applied to a per-ticket
 * ticket-analyzer run. ticket-cost-distinguishes-max-subscription-from-real-api-spend Phase 2:
 * "A Max analyzer run's ticket_analyses.cost_cents is null/0 (not ~34¢); the ticket's cumulative
 * dollar cost excludes Max box-session runs and includes only api-billed runs; the box-down API
 * fallback still records its real cost." Pins the predicate without a DB.
 *
 * Built-in node:test — run:
 *   npx tsx --test src/lib/ticket-analyzer.cost.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { analyzerCostCentsForRun, type AnalyzerBoxRunUsage } from "./ticket-analyzer";
import { usageCostCents } from "./ai-usage";

const MODEL = "claude-sonnet-4-6";

// The realistic per-run token profile a grader turn produces — the shape usageCostCents accepts
// and the shape the box lane hands applyAnalyzerVerdict via AnalyzerBoxRunUsage.
const REAL_TOKENS = {
  input_tokens: 12_000,
  output_tokens: 400,
  cache_creation_tokens: 0,
  cache_read_tokens: 40_000,
};

test("Max box lane (apiBilled=false) → 0¢ (not a fabricated dollar figure)", () => {
  const usage: AnalyzerBoxRunUsage = { ...REAL_TOKENS, model: MODEL, apiBilled: false };
  assert.equal(analyzerCostCentsForRun(usage, MODEL), 0);
});

test("API-fallback path (apiBilled=true) → real usageCostCents (matches [[fleet-cost]]'s predicate)", () => {
  const usage: AnalyzerBoxRunUsage = { ...REAL_TOKENS, model: MODEL, apiBilled: true };
  const got = analyzerCostCentsForRun(usage, MODEL);
  const expected = usageCostCents(MODEL, REAL_TOKENS);
  assert.equal(got, expected);
  assert.ok(got > 0, "an api-billed run with real tokens must record a positive cost");
});

test("apiBilled=undefined (caller didn't record it) → 0¢ (honest unknown, no fabricated $)", () => {
  const usage: AnalyzerBoxRunUsage = { ...REAL_TOKENS, model: MODEL };
  assert.equal(analyzerCostCentsForRun(usage, MODEL), 0);
});

test("apiBilled=true but zero tokens → 0¢ (usageCostCents is skipped)", () => {
  const usage: AnalyzerBoxRunUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    model: MODEL,
    apiBilled: true,
  };
  assert.equal(analyzerCostCentsForRun(usage, MODEL), 0);
});

test("null/undefined usage → 0¢ (no crash)", () => {
  assert.equal(analyzerCostCentsForRun(null, MODEL), 0);
  assert.equal(analyzerCostCentsForRun(undefined, MODEL), 0);
});

test("apiBilled=true with no model on usage → falls back to GRADER_MODEL and still records real cents", () => {
  const usage: AnalyzerBoxRunUsage = { ...REAL_TOKENS, apiBilled: true };
  const got = analyzerCostCentsForRun(usage, MODEL);
  const expected = usageCostCents(MODEL, REAL_TOKENS);
  assert.equal(got, expected);
});
