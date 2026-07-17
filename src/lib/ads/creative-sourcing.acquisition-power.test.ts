/**
 * creative-sourcing.acquisition-power tests — pin Phase 2 (drop hardcoded acquisitionPower=9,
 * rank on the full skeleton signal set) of docs/brain/specs/dahlia-deeper-competitor-selection.md.
 *
 * Verification bullets (from the spec's Phase 2):
 *   1. `scoreCompetitorAcquisitionPower` ranks a 60d/high-heat still-running skeleton ABOVE a
 *      30d/low-heat dormant one — no more single-constant flattening.
 *   2. The grep guard: no non-test .ts under src/lib/ads/ contains the hardcoded literal
 *      `acquisitionPower: 9` or `acquisitionPower=9` driving competitor selection (Fix 1's
 *      preview-fail evidence was creative-agent.ts:946 still carrying it).
 *
 * Pure helper — no network, no DB. Runs via:
 *   npx tsx --test src/lib/ads/creative-sourcing.acquisition-power.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { scoreCompetitorAcquisitionPower } from "./creative-sourcing";

test("scoreCompetitorAcquisitionPower — 60d+ / high-heat / still-running OUTRANKS 30d / low-heat / dormant (Phase 2 anti-flatten)", () => {
  const deepHot = scoreCompetitorAcquisitionPower({ daysRunning: 90, heat: 5, resumeAdvertising: true });
  const shallowCold = scoreCompetitorAcquisitionPower({ daysRunning: 30, heat: 1, resumeAdvertising: false });
  assert.ok(
    deepHot > shallowCold,
    `expected deep+hot (${deepHot}) to outrank shallow+cold (${shallowCold}) — anti-flatten fails`,
  );
  // Concretely: 60d+ + still-running base=9 + heat≥4 bonus=+1 → 10; 30d + paused base=5 + heat≤1
  // penalty=-1 → 4. If either edge silently flips (base table change, bonus/floor drift), the
  // regression bites here first.
  assert.equal(deepHot, 10, `deep+hot should ceiling at 10, got ${deepHot}`);
  assert.equal(shallowCold, 4, `shallow+cold + heat penalty should be 4, got ${shallowCold}`);
});

test("scoreCompetitorAcquisitionPower — depth-of-proof piecewise (deep still-running > deep paused > shallow still-running > shallow paused > below-shallow)", () => {
  const NEUTRAL_HEAT = 3; // heat=3 gives no bonus and no penalty — isolate the base
  const deepStill = scoreCompetitorAcquisitionPower({ daysRunning: 90, heat: NEUTRAL_HEAT, resumeAdvertising: true });
  const deepPaused = scoreCompetitorAcquisitionPower({ daysRunning: 90, heat: NEUTRAL_HEAT, resumeAdvertising: false });
  const shallowStill = scoreCompetitorAcquisitionPower({ daysRunning: 45, heat: NEUTRAL_HEAT, resumeAdvertising: true });
  const shallowPaused = scoreCompetitorAcquisitionPower({ daysRunning: 45, heat: NEUTRAL_HEAT, resumeAdvertising: false });
  const belowShallow = scoreCompetitorAcquisitionPower({ daysRunning: 10, heat: NEUTRAL_HEAT, resumeAdvertising: true });

  assert.equal(deepStill, 9, "60d + still-running base = 9");
  assert.equal(deepPaused, 7, "60d + paused base = 7");
  assert.equal(shallowStill, 7, "30–59d + still-running base = 7");
  assert.equal(shallowPaused, 5, "30–59d + paused base = 5");
  assert.equal(belowShallow, 4, "<30d base = 4");
  assert.ok(deepStill > deepPaused && deepPaused >= shallowStill && shallowStill > shallowPaused && shallowPaused > belowShallow,
    "monotone: deep-still > deep-paused ≥ shallow-still > shallow-paused > below-shallow");
});

test("scoreCompetitorAcquisitionPower — null / missing signals never crash, stay bounded in [0,10]", () => {
  const cases = [
    { daysRunning: null, heat: null, resumeAdvertising: null },
    { daysRunning: 200, heat: null, resumeAdvertising: null },
    { daysRunning: 90, heat: 5, resumeAdvertising: null },
    { daysRunning: 0, heat: 0, resumeAdvertising: false },
    { daysRunning: 90, heat: 5, resumeAdvertising: true },
  ];
  for (const c of cases) {
    const v = scoreCompetitorAcquisitionPower(c);
    assert.ok(v >= 0 && v <= 10, `score ${v} out of [0,10] for ${JSON.stringify(c)}`);
    assert.ok(Number.isFinite(v) && Number.isInteger(v), `score ${v} not a finite integer for ${JSON.stringify(c)}`);
  }
});

test("grep guard — no non-test file under src/lib/ads/ still hardcodes `acquisitionPower: 9` / `acquisitionPower=9` to drive competitor selection", () => {
  // Fix 1's failing check pointed at src/lib/ads/creative-agent.ts:946 carrying the constant.
  // Walk src/lib/ads/*.ts (excluding tests + this file's own fixture) and assert the literal is gone
  // as an actual assignment in CODE. Historical mentions inside doc comments (`//`, `*`, or a
  // backticked reference in a docstring) are allowed — they document the deleted behaviour and are
  // not themselves the driving assignment. The test still bites if the raw literal returns to a
  // property/assignment line.
  const root = join(process.cwd(), "src", "lib", "ads");
  const offenders: Array<{ file: string; line: number; text: string }> = [];
  const pattern = /acquisitionPower\s*[:=]\s*9\b/;
  function isCommentLine(line: string): boolean {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return true;
    // The match on this line is wrapped in backticks (documentation ref like `acquisitionPower=9`)
    // rather than being the property assignment itself.
    const m = pattern.exec(line);
    if (m) {
      const before = line.slice(0, m.index);
      const after = line.slice(m.index + m[0].length);
      const tickBefore = (before.match(/`/g) ?? []).length;
      const tickAfter = (after.match(/`/g) ?? []).length;
      if (tickBefore % 2 === 1 && tickAfter >= 1) return true;
    }
    return false;
  }
  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!p.endsWith(".ts")) continue;
      if (p.endsWith(".test.ts")) continue; // creative-brief.test.ts uses acquisitionPower:9 as fixture — allowed
      const txt = readFileSync(p, "utf8");
      txt.split("\n").forEach((line, i) => {
        if (pattern.test(line) && !isCommentLine(line)) offenders.push({ file: p, line: i + 1, text: line.trim() });
      });
    }
  }
  walk(root);
  assert.equal(
    offenders.length,
    0,
    `hardcoded \`acquisitionPower: 9\` still drives selection:\n${offenders.map((o) => `  ${o.file}:${o.line} — ${o.text}`).join("\n")}`,
  );
});
