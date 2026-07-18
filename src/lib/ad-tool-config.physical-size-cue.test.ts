/**
 * Unit tests for physicalSizeCue — the pure helper that derives the real-world
 * size clause injected into buildHoldingProductPrompt so the Nano Banana Pro
 * combine renders the product box true-to-life against the hand.
 *
 * Verifies the spec's two fixtures:
 *   1. A 6"x5"x3" box yields a cue that explicitly names 6 inches by 5 inches
 *      and instructs the model not to shrink it.
 *   2. Missing / partial dimensions yield a safe empty cue (no crash, no
 *      broken sentence in the composed prompt).
 *
 * Run: npm run test:physical-size-cue
 * (= tsx --test src/lib/ad-tool-config.physical-size-cue.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { physicalSizeCue } from "./ad-tool-config";

test("6x5 box yields explicit true-to-life size cue", () => {
  const cue = physicalSizeCue({ length_in: 6, width_in: 5, height_in: 3, shape: "box" });
  assert.ok(cue.length > 0, "cue should be non-empty");
  assert.ok(cue.includes("6 inches by 5 inches"), `expected "6 inches by 5 inches" in cue, got: ${cue}`);
  assert.ok(cue.includes("box"), "cue should include the shape word");
  // The whole point of the fix — the model must NOT shrink the product.
  assert.ok(/do NOT shrink/i.test(cue), "cue must instruct the model not to shrink the product");
});

test("cue leads with a space so it can be safely appended to a preceding sentence", () => {
  const cue = physicalSizeCue({ length_in: 6, width_in: 5, height_in: 3, shape: "box" });
  assert.equal(cue[0], " ", "cue must start with a space to safely concatenate onto a preceding period-terminated sentence");
});

test("largest two axes are used regardless of which axis was called 'height'", () => {
  // A tall bag: height=8, width=5, length=2. The visible face is 8x5 — not 5x2.
  const cue = physicalSizeCue({ length_in: 2, width_in: 5, height_in: 8, shape: "bag" });
  assert.ok(cue.includes("8 inches by 5 inches"), `expected largest two axes (8x5), got: ${cue}`);
});

test("integer dimensions render without decimal noise", () => {
  const cue = physicalSizeCue({ length_in: 6, width_in: 5, height_in: 3, shape: "box" });
  assert.ok(!/6\.0|5\.0/.test(cue), "integer inches must render as '6' not '6.0'");
});

test("fractional dimensions render with one decimal place", () => {
  const cue = physicalSizeCue({ length_in: 6.5, width_in: 4.25, height_in: 2, shape: "box" });
  assert.ok(cue.includes("6.5 inches by 4.3 inches") || cue.includes("6.5 inches by 4.2 inches"), `expected rounded fractional cue, got: ${cue}`);
});

test("missing dims → empty cue (safe fallback)", () => {
  assert.equal(physicalSizeCue(null), "");
  assert.equal(physicalSizeCue(undefined), "");
  assert.equal(physicalSizeCue({}), "");
});

test("only one usable axis → empty cue (need two for a 'A by B' clause)", () => {
  assert.equal(physicalSizeCue({ length_in: 6, shape: "box" }), "");
  assert.equal(physicalSizeCue({ length_in: 6, width_in: null, height_in: null, shape: "box" }), "");
});

test("zero / negative / non-finite dims are ignored", () => {
  assert.equal(physicalSizeCue({ length_in: 0, width_in: 5, height_in: 3, shape: "box" }), physicalSizeCue({ length_in: 5, width_in: 3, shape: "box" }));
  assert.equal(physicalSizeCue({ length_in: -1, width_in: 5, height_in: 3, shape: "box" }), physicalSizeCue({ length_in: 5, width_in: 3, shape: "box" }));
  assert.equal(physicalSizeCue({ length_in: Number.NaN, width_in: 5, height_in: 3, shape: "box" }), physicalSizeCue({ length_in: 5, width_in: 3, shape: "box" }));
  assert.equal(physicalSizeCue({ length_in: Number.POSITIVE_INFINITY, width_in: 5, height_in: 3, shape: "box" }), physicalSizeCue({ length_in: 5, width_in: 3, shape: "box" }));
});

test("missing shape falls back to 'package' without crashing", () => {
  const cue = physicalSizeCue({ length_in: 6, width_in: 5, height_in: 3 });
  assert.ok(cue.length > 0);
  assert.ok(cue.includes("package"), `expected fallback shape 'package', got: ${cue}`);
});
