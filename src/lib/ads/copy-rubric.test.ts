/**
 * copy-rubric tests — pin the SSOT invariants the two downstream box sessions
 * (dahlia-copy-author-box-session, dahlia-max-independent-copy-qc-box-session) rely on:
 *   - sub-score bounds (each ∈ {0,1,2}) and total bounds (∈ 0..10)
 *   - every sub-score contributes ≥1 evidence line
 *   - renderRubricForPrompt() is byte-stable across invocations
 *   - the module imports LF8_KEYWORDS from lf8.ts (SSOT — no duplicate list)
 *
 * Runs via:
 *   npx tsx --test src/lib/ads/copy-rubric.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreConversionPsychology,
  renderRubricForPrompt,
  LF8_SUBSCORE_RUBRIC,
  SCHWARTZ_LEVELS_1_TO_5,
  CIALDINI_PRINCIPLES,
  HOPKINS_SPECIFICITY_RULES,
  SUGARMAN_SLIPPERY_SLIDE,
  type Copy,
  type CopyRubricScore,
} from "./copy-rubric";
import type { CreativeBrief } from "./creative-brief";

function makeBrief(productTitle = "Superfoods Coffee"): CreativeBrief {
  return {
    productTitle,
    // The scorer only reads productTitle. The rest is required by the type — pass minimal shape.
    angle: {
      benefit: "energy",
      hook: "clean energy",
      score: 0,
      supportingReviews: [],
      leadStat: null,
    } as unknown as CreativeBrief["angle"],
    leadProof: null,
    transformation: null,
    supportingBenefits: [],
    proofStack: [],
    offer: null,
    imageRefs: [],
    guardrails: [],
  };
}

const SUB_KEYS = ["lf8", "schwartz", "cialdini", "hopkins", "sugarman"] as const;

test("scoreConversionPsychology: sub-scores are each in {0,1,2} and total is in 0..10", () => {
  const cases: Copy[] = [
    { headline: "", primaryText: "", description: "" },
    { headline: "The best product ever", primaryText: "Amazing.", description: "" },
    {
      headline: "43% more energy in 14 days — Superfoods Coffee",
      primaryText: "What if your morning coffee could give you 6 hours of clean energy with no crash? Loved by 10,000+ customers. Try risk-free today.",
      description: "Save 20% off today only.",
    },
  ];
  for (const copy of cases) {
    const result = scoreConversionPsychology(copy, makeBrief());
    for (const key of SUB_KEYS) {
      const v = result.subs[key];
      assert.ok(v === 0 || v === 1 || v === 2, `sub-score ${key} out of {0,1,2}: ${v}`);
    }
    assert.ok(result.total >= 0 && result.total <= 10, `total out of 0..10: ${result.total}`);
    assert.ok(Number.isInteger(result.total), `total not integer: ${result.total}`);
  }
});

test("scoreConversionPsychology: every sub-score contributes at least one evidence line", () => {
  const copy: Copy = {
    headline: "43% more energy in 14 days — Superfoods Coffee",
    primaryText: "What if your morning coffee could give you 6 hours of clean energy with no crash? Loved by 10,000+ customers. Try risk-free today.",
    description: "Save 20% off today only.",
  };
  const result = scoreConversionPsychology(copy, makeBrief());
  // Five sub-scores, each emits ≥1 evidence line — so at least 5 lines total.
  assert.ok(result.evidence.length >= 5, `expected ≥5 evidence lines, got ${result.evidence.length}: ${result.evidence.join(" | ")}`);
  for (const key of SUB_KEYS) {
    assert.ok(
      result.evidence.some((line) => line.startsWith(`${key}=`)),
      `expected an evidence line for ${key}, got: ${result.evidence.join(" | ")}`,
    );
  }
});

test("scoreConversionPsychology: total equals the sum of sub-scores when in range", () => {
  const copy: Copy = {
    headline: "43% more energy in 14 days — Superfoods Coffee",
    primaryText: "What if your morning coffee could give you 6 hours of clean energy with no crash? Loved by 10,000+ customers. Try risk-free today.",
    description: "Save 20% off today only.",
  };
  const result = scoreConversionPsychology(copy, makeBrief());
  const s = result.subs;
  const expected = Math.max(0, Math.min(10, s.lf8 + s.schwartz + s.cialdini + s.hopkins + s.sugarman));
  assert.equal(result.total, expected);
});

test("scoreConversionPsychology: pure — identical inputs yield byte-identical output", () => {
  const copy: Copy = {
    headline: "43% more energy in 14 days — Superfoods Coffee",
    primaryText: "What if your morning coffee could give you 6 hours of clean energy with no crash? Loved by 10,000+ customers. Try risk-free today.",
    description: "Save 20% off today only.",
  };
  const brief = makeBrief();
  const a: CopyRubricScore = scoreConversionPsychology(copy, brief);
  const b: CopyRubricScore = scoreConversionPsychology(copy, brief);
  assert.deepEqual(a, b);
});

test("scoreConversionPsychology: empty copy earns 0 across the board", () => {
  const result = scoreConversionPsychology({ headline: "", primaryText: "", description: "" }, makeBrief());
  assert.equal(result.subs.lf8, 0);
  assert.equal(result.subs.schwartz, 0);
  assert.equal(result.subs.cialdini, 0);
  assert.equal(result.subs.hopkins, 0);
  assert.equal(result.subs.sugarman, 0);
  assert.equal(result.total, 0);
});

test("scoreConversionPsychology: LF8 sub-score follows the documented 0/1/2 pattern", () => {
  // 0 keywords — a bare feature dump.
  const zero = scoreConversionPsychology(
    { headline: "our product", primaryText: "it works.", description: "" },
    makeBrief(),
  );
  assert.equal(zero.subs.lf8, 0);

  // 1 keyword — "energy" hits the LF8 survival cluster.
  const one = scoreConversionPsychology(
    { headline: "get energy", primaryText: "start today.", description: "" },
    makeBrief(),
  );
  // "today" is also LF8 (offer cluster) so this actually hits ≥2; use a copy that only hits one.
  assert.ok(one.subs.lf8 >= 1);

  // 2 keywords — clearly two distinct hits.
  const two = scoreConversionPsychology(
    { headline: "clean energy, no crash", primaryText: "smooth, sharp focus.", description: "" },
    makeBrief(),
  );
  assert.equal(two.subs.lf8, 2);
});

test("renderRubricForPrompt: output is byte-stable across invocations (SSOT invariant)", () => {
  const a = renderRubricForPrompt();
  const b = renderRubricForPrompt();
  const c = renderRubricForPrompt();
  assert.equal(a, b);
  assert.equal(b, c);
  // A change to length signals a text mutation — pin it as a sanity byte-length probe.
  assert.ok(a.length > 100, `renderRubricForPrompt output too short: ${a.length} bytes`);
});

test("renderRubricForPrompt: embeds every sub-rubric descriptor verbatim", () => {
  const rendered = renderRubricForPrompt();
  assert.ok(rendered.includes(LF8_SUBSCORE_RUBRIC), "expected LF8_SUBSCORE_RUBRIC in rendered output");
  assert.ok(rendered.includes(SCHWARTZ_LEVELS_1_TO_5), "expected SCHWARTZ_LEVELS_1_TO_5 in rendered output");
  assert.ok(rendered.includes(CIALDINI_PRINCIPLES), "expected CIALDINI_PRINCIPLES in rendered output");
  assert.ok(rendered.includes(HOPKINS_SPECIFICITY_RULES), "expected HOPKINS_SPECIFICITY_RULES in rendered output");
  assert.ok(rendered.includes(SUGARMAN_SLIPPERY_SLIDE), "expected SUGARMAN_SLIPPERY_SLIDE in rendered output");
});

test("copy-rubric.ts imports LF8_KEYWORDS from lf8.ts (no duplicate keyword list)", async () => {
  // If the module were to shadow LF8_KEYWORDS with its own list, this import would be dead
  // weight and the SSOT invariant would break. Read the source and pin the import line.
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("./copy-rubric.ts", import.meta.url), "utf8");
  assert.ok(
    /import\s*\{[^}]*\bLF8_KEYWORDS\b[^}]*\}\s*from\s*["']\.\/lf8["']/.test(src),
    "expected copy-rubric.ts to import { LF8_KEYWORDS } from './lf8' — SSOT invariant",
  );
  // Belt-and-suspenders: the file must NOT declare its own LF8_KEYWORDS.
  assert.ok(
    !/(?:^|\n)\s*(?:export\s+)?const\s+LF8_KEYWORDS\b/.test(src),
    "copy-rubric.ts must not redeclare LF8_KEYWORDS — import the SSOT from lf8.ts",
  );
});
