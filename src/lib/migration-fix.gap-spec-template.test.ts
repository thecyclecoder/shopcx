/**
 * migrationGapSpecMarkdown must survive the spec-authoring chokepoint. Ground truth: the old
 * template's free-text parent ("Retention mandate \"...\"") was rejected by assertValidParent on
 * every attempt, so the migration-fix agent's code-gap specs never landed (2026-09-20, sub
 * 25afd98d — the Appstle free/one-time promo-line class went unfiled for two weeks).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { migrationGapSpecMarkdown } from "./migration-fix";
import {
  buildStructuredSpecInputFromMarkdown,
  assertValidParent,
  assertEveryPhaseHasVerification,
  assertEveryPhaseHasBody,
  assertEveryNodeHasIntent,
} from "./author-spec";

const SPEC = {
  slug: "migration-honours-appstle-free-promo-attributes",
  title: "Migration honours Appstle free / one-time promo line attributes",
  intent: "Appstle marks promo lines free/one-time; the migration ignores the flags and bills them every cycle.",
  problem: "A $0 one-time ACV Gummies bonus became a paid recurring line on sub 25afd98d.",
  target: "src/lib/migrate-to-internal.ts",
};

test("the template's parent passes assertValidParent (it used to read as free text)", () => {
  const md = migrationGapSpecMarkdown(SPEC, "audit-1", "sub-1");
  const s = buildStructuredSpecInputFromMarkdown(SPEC.slug, md);
  assert.match(s.parent, /functions\/retention/);
  assert.doesNotThrow(() => assertValidParent(s.parent));
});

test("owner, intent and phase gates pass on the converted spec", () => {
  const s = buildStructuredSpecInputFromMarkdown(SPEC.slug, migrationGapSpecMarkdown(SPEC, "audit-1", "sub-1"));
  assert.match(s.owner, /retention/);
  const phases = s.phases.map((p) => ({ title: p.title, body: p.body, verification: p.verification ?? null }));
  assert.ok(phases.length >= 1);
  assert.doesNotThrow(() => assertEveryPhaseHasVerification(SPEC.slug, phases));
  assert.doesNotThrow(() => assertEveryPhaseHasBody(SPEC.slug, phases));
  assert.doesNotThrow(() =>
    assertEveryNodeHasIntent(SPEC.slug, { why: s.why, what: s.what }, s.phases.map((p) => ({ title: p.title, why: p.why, what: p.what }))),
  );
});

test("regression pin: the OLD free-text parent is rejected", () => {
  assert.throws(() => assertValidParent('Retention mandate "Subscription continuity & billing integrity"'), /free text/);
});
