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
  isPostable,
} from "./publish-gate";
import { MAX_QC_ELIGIBILITY_FLOOR } from "@/lib/ads/creative-agent";
import type { StoredCopyQaVerdict } from "@/lib/ads/creative-qa";
import type { PostabilityOverride } from "@/lib/ads/postability-override";

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

function makeAdmin(
  rows: StoredCopyQaVerdict[],
  overrideRow: Partial<{
    override_postable: boolean | null;
    override_score: number | null;
    override_reason: string | null;
    override_by: string | null;
    override_at: string | null;
  }> | null = null,
) {
  const verdictTable = "ad_creative_copy_qc_verdicts";
  const campaignTable = "ad_campaigns";
  return {
    from(t: string) {
      if (t === verdictTable) {
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
      }
      if (t === campaignTable) {
        // bianca-posts-only-at-9of10 Phase 2 — readPostabilityOverride reads
        // `ad_campaigns` scoped to (workspace_id, id) with .maybeSingle(). The
        // fake returns the injected override record (or an all-null row when
        // no override was set on this fixture).
        const data: Row = {
          override_postable: overrideRow?.override_postable ?? null,
          override_score: overrideRow?.override_score ?? null,
          override_reason: overrideRow?.override_reason ?? null,
          override_by: overrideRow?.override_by ?? null,
          override_at: overrideRow?.override_at ?? null,
        };
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data, error: null as null }),
        };
        return chain;
      }
      throw new Error(`unexpected table ${t}`);
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
    assert.equal(gate.verdict?.persuasion_score, 9);
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

// ── bianca-posts-only-at-9of10 Phase 2 — CEO manual postability override ─────
// Pin the four states the spec's verification calls out:
//   (1) score 6 (no override)              → NOT postable
//   (2) score 6 + CEO override present     → postable (override wins)
//   (3) score 9 (no override)              → postable (Max's own gate clears it)
//   (4) Max's real grade is UNTOUCHED by the override — the verdict row rides on
//       the allow-result at its true score, so the Max-vs-CEO gap is preserved
//       as the tuning signal the CEO wants for live Claude sessions.

const activeOverride: PostabilityOverride = {
  override_postable: true,
  override_score: 9,
  override_reason: "CEO judged the headline lands the objection Max under-weighted.",
  override_by: "user-ceo",
  override_at: "2026-07-18T12:00:00Z",
};

const emptyOverride: PostabilityOverride = {
  override_postable: null,
  override_score: null,
  override_reason: null,
  override_by: null,
  override_at: null,
};

test("Phase 2 (pure): isPostable — Max score 6/10 + no override → NOT postable (Max's below-floor grade stands)", () => {
  const v = verdict({ persuasion_score: 6 });
  assert.equal(isPostable(v, null), false);
  assert.equal(isPostable(v, emptyOverride), false, "empty override record equivalent to null override");
});

test("Phase 2 (pure): isPostable — Max score 6/10 + CEO override present → POSTABLE (override wins)", () => {
  const v = verdict({ persuasion_score: 6 });
  assert.equal(isPostable(v, activeOverride), true);
});

test("Phase 2 (pure): isPostable — Max score 9/10 + no override → POSTABLE (Max cleared his own gate)", () => {
  const v = verdict({ persuasion_score: 9 });
  assert.equal(isPostable(v, null), true);
});

test("Phase 2 (pure): isPostable — override on a hard-gate-fail verdict still wins (CEO's judgment is final during tuning)", () => {
  const v = verdict({
    hard_gate_pass: false,
    hard_gates: { no_fabrication: true, no_cold_offer: false, no_competitor_leak: true, single_promise: true, render_ok: true },
    persuasion_score: null,
  });
  assert.equal(isPostable(v, activeOverride), true);
  assert.equal(isPostable(v, null), false);
});

test("Phase 2 (DB-aware): score 6/10 verdict + CEO override on the campaign → gate returns ok:true and the override rides on the result", async () => {
  const admin = makeAdmin([verdict({ persuasion_score: 6 })], activeOverride);
  const gate = await evaluateMaxCopyQcAtPublish(admin, {
    workspaceId: "ws-1",
    adCampaignId: "campaign-1",
  });
  assert.equal(gate.ok, true);
  if (gate.ok) {
    assert.ok(gate.override, "override must ride on the allow-result so the audit trail can cite it");
    assert.equal(gate.override!.override_postable, true);
    assert.equal(gate.override!.override_reason?.includes("CEO"), true);
    // Max's REAL grade must be preserved on the allow-result unchanged — the whole
    // point of the override is that the Max-vs-CEO gap survives as the tuning signal.
    assert.equal(gate.verdict?.persuasion_score, 6, "Max's real persuasion_score MUST remain 6/10 on the allow-result");
    assert.equal(gate.verdict?.hard_gate_pass, true);
  }
});

test("Phase 2 (DB-aware): score 6/10 verdict + NO CEO override → gate refuses ('below_score_floor') even at the new 9/10 floor", async () => {
  const admin = makeAdmin([verdict({ persuasion_score: 6 })], null);
  const gate = await evaluateMaxCopyQcAtPublish(admin, {
    workspaceId: "ws-1",
    adCampaignId: "campaign-1",
  });
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.equal(gate.reason, "below_score_floor");
});

test("Phase 2 (DB-aware): score 9/10 verdict + no override → gate returns ok:true with a null override on the result (Max cleared it, no CEO action needed)", async () => {
  const admin = makeAdmin([verdict({ persuasion_score: 9 })], null);
  const gate = await evaluateMaxCopyQcAtPublish(admin, {
    workspaceId: "ws-1",
    adCampaignId: "campaign-1",
  });
  assert.equal(gate.ok, true);
  if (gate.ok) {
    assert.equal(gate.override?.override_postable, null, "no override → the record's override_postable is null (or absent)");
    assert.equal(gate.verdict?.persuasion_score, 9);
  }
});

test("Phase 2 (invariant): Max's stored verdict row is NEVER read-written by the override path — the allow-result carries the SAME verdict object read from the DB", async () => {
  // Snapshot Max's verdict, run the gate with a CEO override, and confirm the
  // verdict shape returned on the allow-result matches the snapshot byte-for-byte
  // (hard_gate_pass, persuasion_score, retry_index). This pins the "override
  // never overwrites Max's real grade" invariant at the gate seam.
  const originalScore = 6;
  const admin = makeAdmin([verdict({ persuasion_score: originalScore, retry_index: 0 })], activeOverride);
  const gate = await evaluateMaxCopyQcAtPublish(admin, {
    workspaceId: "ws-1",
    adCampaignId: "campaign-1",
  });
  assert.equal(gate.ok, true);
  if (gate.ok) {
    assert.equal(gate.verdict?.persuasion_score, originalScore);
    assert.equal(gate.verdict?.retry_index, 0);
  }
});
