/**
 * Unit tests for the pure parts of the Phase-2 Haiku-suggester
 * (docs/brain/specs/orchestrator-handler-alias-catalog-for-no-handler-misses.md,
 * Phase 2). Covers the prompt shape and the parser's out-of-set guard so
 * the executor cannot be taught to route to a non-existent handler.
 *
 * Run:
 *   npm run test:proposed-action-aliases
 *   (= tsx --test src/lib/proposed-action-aliases.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildSuggestPrompt, parseSuggestion } from "./proposed-action-aliases";

const HANDLERS = ["cancel", "pause", "resume", "partial_refund", "create_return", "apply_coupon"];

test("buildSuggestPrompt names the emitted source_type and every candidate handler", () => {
  const prompt = buildSuggestPrompt("cancel_subscription", HANDLERS);
  assert.match(prompt, /cancel_subscription/);
  for (const key of HANDLERS) assert.match(prompt, new RegExp(`- ${key}\\b`));
});

test("buildSuggestPrompt tells Haiku to return no_match if nothing fits", () => {
  const prompt = buildSuggestPrompt("foo_bar_baz", HANDLERS);
  assert.match(prompt, /no_match/);
});

test("parseSuggestion picks a valid in-set target", () => {
  const raw = 'Here is my answer:\n{"target":"cancel","reasoning":"cancel_subscription is a rewording of cancel"}';
  const s = parseSuggestion(raw, HANDLERS);
  assert.equal(s?.target, "cancel");
  assert.match(s!.reasoning, /rewording/);
});

test("parseSuggestion rejects a target that is NOT in handlerKeys (guards against phantom handler)", () => {
  // Haiku hallucinated a plausible-sounding handler name that doesn't exist.
  // The parser MUST reject it — approving that would silently teach the
  // executor to route to a non-existent handler, which is the bug this
  // whole queue exists to catch.
  const raw = '{"target":"cancel_now","reasoning":"seems close enough"}';
  assert.equal(parseSuggestion(raw, HANDLERS), null);
});

test("parseSuggestion rejects the no_match sentinel (no suggestion is written)", () => {
  const raw = '{"target":"no_match","reasoning":"nothing fits"}';
  assert.equal(parseSuggestion(raw, HANDLERS), null);
});

test("parseSuggestion rejects malformed JSON without throwing", () => {
  assert.equal(parseSuggestion("not json at all", HANDLERS), null);
  assert.equal(parseSuggestion("{ not_json }", HANDLERS), null);
  assert.equal(parseSuggestion("", HANDLERS), null);
});

test("parseSuggestion rejects an empty target string", () => {
  const raw = '{"target":"","reasoning":"idk"}';
  assert.equal(parseSuggestion(raw, HANDLERS), null);
});

test("parseSuggestion tolerates prose surrounding the JSON block", () => {
  const raw = 'I think the answer is:\n\n{"target":"partial_refund","reasoning":"refund_partial is the reversed word order of partial_refund"}\n\nHope that helps!';
  const s = parseSuggestion(raw, HANDLERS);
  assert.equal(s?.target, "partial_refund");
});
