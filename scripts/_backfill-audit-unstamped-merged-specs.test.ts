/**
 * merged-but-unstamped-specs-reach-the-audit-instead-of-being-dropped Phase 2 — pins the pure
 * `selectStrandedSpecsForAudit` predicate the backfill uses to decide which specs get handed off
 * to the audit lane. GUARD-BEFORE-MUTATION (coaching #11 / #12 / #14): the predicate is the last
 * filter before an enqueue fan-out, so a mistake here would either (a) miss a genuinely stranded
 * spec (the whole point of the backfill) or (b) sweep in a spec whose provenance is already fine.
 *
 * Named failing states the spec calls out:
 *   - a merged spec whose phases carry ZERO provenance must be selected
 *   - a spec with ANY shipped-sibling merge_sha is NOT stranded (the reconciler handles it)
 *   - a spec whose every phase is already shipped/rejected is NOT stranded
 *   - a zero-phase (one-shot) spec is NOT stranded (its provenance lives on the card, not phases)
 *   - a `dismissed`-build spec never reaches this predicate — the enumeration filters status='merged'
 *     already, but the shape is worth pinning at the record type level
 *
 *   npx tsx --test scripts/_backfill-audit-unstamped-merged-specs.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { selectStrandedSpecsForAudit } from "./_backfill-audit-unstamped-merged-specs";

type Phase = { status: string; merge_sha: string | null };
type SpecShape = { slug: string; phases: Phase[] };

const mk = (slug: string, phases: Phase[]): SpecShape => ({ slug, phases });

test("selects a spec whose phases carry NO merge_sha AND have an un-done phase (the whole point)", () => {
  const specs: SpecShape[] = [
    mk("stranded", [
      { status: "planned", merge_sha: null },
      { status: "planned", merge_sha: null },
    ]),
  ];
  const r = selectStrandedSpecsForAudit(specs);
  assert.deepEqual(r.map((s) => s.slug), ["stranded"]);
});

test("SKIPS a spec whose ANY phase carries a merge_sha (the reconciler has a sibling to copy)", () => {
  const specs: SpecShape[] = [
    mk("has-sibling", [
      { status: "shipped", merge_sha: "abc" },
      { status: "planned", merge_sha: null },
    ]),
  ];
  const r = selectStrandedSpecsForAudit(specs);
  assert.deepEqual(r, []);
});

test("SKIPS a fully-shipped spec (nothing to do)", () => {
  const specs: SpecShape[] = [
    mk("done", [
      { status: "shipped", merge_sha: "abc" },
      { status: "shipped", merge_sha: "abc" },
    ]),
  ];
  const r = selectStrandedSpecsForAudit(specs);
  assert.deepEqual(r, []);
});

test("SKIPS a spec whose every phase is shipped OR rejected (a rejected phase is terminal — nothing un-done)", () => {
  const specs: SpecShape[] = [
    mk("all-terminal", [
      { status: "shipped", merge_sha: "abc" },
      { status: "rejected", merge_sha: null },
    ]),
  ];
  const r = selectStrandedSpecsForAudit(specs);
  assert.deepEqual(r, []);
});

test("SKIPS a zero-phase (one-shot) spec — provenance lives on the card, not per phase", () => {
  const r = selectStrandedSpecsForAudit([mk("one-shot", [])]);
  assert.deepEqual(r, []);
});

test("selects only the truly stranded ones across a mixed input (order preserved)", () => {
  const specs: SpecShape[] = [
    mk("stranded-a", [
      { status: "planned", merge_sha: null },
    ]),
    mk("has-sibling", [
      { status: "shipped", merge_sha: "abc" },
      { status: "planned", merge_sha: null },
    ]),
    mk("stranded-b", [
      { status: "in_progress", merge_sha: null },
      { status: "planned", merge_sha: null },
    ]),
    mk("done", [
      { status: "shipped", merge_sha: "def" },
    ]),
  ];
  const r = selectStrandedSpecsForAudit(specs);
  assert.deepEqual(r.map((s) => s.slug), ["stranded-a", "stranded-b"]);
});

test("in_progress + rejected mix WITHOUT any merge_sha still counts (rejected doesn't count as provenance)", () => {
  const specs: SpecShape[] = [
    mk("mixed", [
      { status: "rejected", merge_sha: null },
      { status: "in_progress", merge_sha: null },
    ]),
  ];
  const r = selectStrandedSpecsForAudit(specs);
  assert.deepEqual(r.map((s) => s.slug), ["mixed"]);
});
