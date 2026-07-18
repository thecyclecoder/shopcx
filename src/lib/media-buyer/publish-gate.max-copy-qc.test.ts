/**
 * Unit tests for the Max copy-QC hard rail at Bianca's publish step —
 * bianca-never-posts-a-creative-without-a-max-grade-of-7-or-higher Phase 1
 * (floor raised from 7 to 9 by bianca-posts-only-at-9of10 Phase 1).
 *
 * Covers the three states the spec's verification calls out:
 *   1) `>=9 verdict with hard_gate_pass=true` → gate PASSES  (post allowed)
 *   2) below-floor verdict with hard_gate_pass=true → gate REFUSES ('below_score_floor')
 *   3) NULL / missing verdict                → gate REFUSES ('missing_max_copy_qc_verdict')
 *
 * Plus the hard-gate-fail branch (a 10/10 score behind a failed hard gate must still
 * refuse) — the "hard gates dominate the floor" invariant the sibling isCopyQcEligible
 * predicate pins in creative-agent.author.test.ts.
 *
 * Run:
 *   npx tsx --test src/lib/media-buyer/publish-gate.max-copy-qc.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyMaxCopyQcAtPublish,
  evaluateMaxCopyQcAtPublish,
} from "./publish-gate";
import { MAX_QC_ELIGIBILITY_FLOOR } from "@/lib/ads/creative-agent";
import type { StoredCopyQaVerdict } from "@/lib/ads/creative-qa";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function verdict(overrides: Partial<StoredCopyQaVerdict> = {}): StoredCopyQaVerdict {
  return {
    id: "verdict-1",
    hard_gate_pass: true,
    hard_gates: {
      no_fabrication: true,
      no_cold_offer: true,
      no_competitor_leak: true,
      single_promise: true,
      render_ok: true,
    },
    persuasion_score: 7,
    persuasion_rubric: null,
    scroll_stop: {
      headline_readable_in_3_frames: 2,
      visual_hierarchy_supports_headline: 2,
      first_line_earns_the_second: 2,
      evidence: [],
    },
    declared_intent: null,
    dahlia_rubric: null,
    verdict_reason: "",
    retry_index: 0,
    created_at: "2026-07-18T00:00:00Z",
    ...overrides,
  } as StoredCopyQaVerdict;
}

// ── Pure classifier ──────────────────────────────────────────────────────────

test("classifyMaxCopyQcAtPublish — 9/10 hard-gate-pass verdict → ok (the exact boundary at the new floor)", () => {
  assert.deepEqual(classifyMaxCopyQcAtPublish(verdict({ persuasion_score: 9 })), { ok: true });
});

test("classifyMaxCopyQcAtPublish — 10/10 verdict → ok", () => {
  assert.deepEqual(classifyMaxCopyQcAtPublish(verdict({ persuasion_score: 10 })), { ok: true });
});

test("classifyMaxCopyQcAtPublish — 8/10 verdict → refuse 'below_score_floor' (previously eligible at 7, now held by the 9/10 CEO oversight floor)", () => {
  const r = classifyMaxCopyQcAtPublish(verdict({ persuasion_score: 8 }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "below_score_floor");
});

test("classifyMaxCopyQcAtPublish — 7/10 verdict → refuse 'below_score_floor' (old floor no longer clears)", () => {
  const r = classifyMaxCopyQcAtPublish(verdict({ persuasion_score: 7 }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "below_score_floor");
});

test("classifyMaxCopyQcAtPublish — 6/10 verdict → refuse 'below_score_floor'", () => {
  const r = classifyMaxCopyQcAtPublish(verdict({ persuasion_score: 6 }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "below_score_floor");
});

test("classifyMaxCopyQcAtPublish — NULL verdict → refuse 'missing_max_copy_qc_verdict'", () => {
  const r = classifyMaxCopyQcAtPublish(null);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "missing_max_copy_qc_verdict");
});

test("classifyMaxCopyQcAtPublish — hard-gate FAIL at 10/10 → refuse 'hard_gate_fail' (hard gates dominate the floor)", () => {
  const r = classifyMaxCopyQcAtPublish(
    verdict({
      hard_gate_pass: false,
      hard_gates: {
        no_fabrication: true,
        no_cold_offer: true,
        no_competitor_leak: true,
        single_promise: true,
        render_ok: false,
      },
      persuasion_score: 10,
    }),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "hard_gate_fail");
});

test("classifyMaxCopyQcAtPublish — hard-gate pass with NULL persuasion_score → refuse 'below_score_floor' (defence-in-depth null-fallback)", () => {
  const r = classifyMaxCopyQcAtPublish(verdict({ persuasion_score: null }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "below_score_floor");
});

test("classifyMaxCopyQcAtPublish — floor constant is 9 (shared with Dahlia's bin gate; bianca-posts-only-at-9of10 Phase 1 raised it from 7)", () => {
  assert.equal(MAX_QC_ELIGIBILITY_FLOOR, 9);
});

// ── DB-aware wrapper ─────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeAdmin(rows: StoredCopyQaVerdict[]) {
  const table = "ad_creative_copy_qc_verdicts";
  return {
    from(t: string) {
      if (t !== table) throw new Error(`unexpected table ${t}`);
      let filtered: Row[] = rows.map((r) => ({
        id: r.id,
        workspace_id: "ws-1",
        ad_campaign_id: "campaign-1",
        hard_gate_pass: r.hard_gate_pass,
        hard_gates: r.hard_gates,
        persuasion_score: r.persuasion_score,
        persuasion_rubric: r.persuasion_rubric,
        scroll_stop: r.scroll_stop,
        declared_intent: r.declared_intent,
        dahlia_rubric: r.dahlia_rubric,
        verdict_reason: r.verdict_reason,
        retry_index: r.retry_index,
        created_at: r.created_at,
      }));
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filtered = filtered.filter((r) => r[col] === val);
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: filtered[0] ?? null, error: null as null }),
      };
      return chain;
    },
  } as unknown as Parameters<typeof evaluateMaxCopyQcAtPublish>[0];
}

test("evaluateMaxCopyQcAtPublish — >=9 verdict on record → gate returns ok:true", async () => {
  const admin = makeAdmin([verdict({ persuasion_score: 9 })]);
  const gate = await evaluateMaxCopyQcAtPublish(admin, {
    workspaceId: "ws-1",
    adCampaignId: "campaign-1",
  });
  assert.equal(gate.ok, true);
  if (gate.ok) {
    assert.equal(gate.scoreFloor, 9);
    assert.equal(gate.verdict.persuasion_score, 9);
  }
});

test("evaluateMaxCopyQcAtPublish — below-floor verdict on record → gate refuses ('below_score_floor') + diagnosis names the campaign", async () => {
  const admin = makeAdmin([verdict({ persuasion_score: 5 })]);
  const gate = await evaluateMaxCopyQcAtPublish(admin, {
    workspaceId: "ws-1",
    adCampaignId: "campaign-1",
  });
  assert.equal(gate.ok, false);
  if (!gate.ok) {
    assert.equal(gate.reason, "below_score_floor");
    assert.ok(gate.diagnosis.includes("campaign-1"));
    assert.ok(gate.diagnosis.includes("5"));
  }
});

test("evaluateMaxCopyQcAtPublish — NO verdict row → gate refuses ('missing_max_copy_qc_verdict')", async () => {
  const admin = makeAdmin([]);
  const gate = await evaluateMaxCopyQcAtPublish(admin, {
    workspaceId: "ws-1",
    adCampaignId: "campaign-1",
  });
  assert.equal(gate.ok, false);
  if (!gate.ok) {
    assert.equal(gate.reason, "missing_max_copy_qc_verdict");
    assert.equal(gate.verdict, null);
    assert.ok(gate.diagnosis.includes("campaign-1"));
  }
});

test("evaluateMaxCopyQcAtPublish — hard-gate fail at 10/10 → gate refuses ('hard_gate_fail') + diagnosis names the failing gate", async () => {
  const admin = makeAdmin([
    verdict({
      hard_gate_pass: false,
      hard_gates: {
        no_fabrication: true,
        no_cold_offer: false,
        no_competitor_leak: true,
        single_promise: true,
        render_ok: true,
      },
      persuasion_score: 10,
    }),
  ]);
  const gate = await evaluateMaxCopyQcAtPublish(admin, {
    workspaceId: "ws-1",
    adCampaignId: "campaign-1",
  });
  assert.equal(gate.ok, false);
  if (!gate.ok) {
    assert.equal(gate.reason, "hard_gate_fail");
    assert.ok(gate.diagnosis.includes("no_cold_offer"));
  }
});
