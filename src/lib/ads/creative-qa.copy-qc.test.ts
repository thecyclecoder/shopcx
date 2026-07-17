/**
 * creative-qa.copy-qc — pin-tests for the dahlia-shared-deterministic-copy-validator Phase 2
 * wire-in on the Max copy-QC side. Runs the pure `computeCopyQcPreCheck` helper and the
 * dispatch wrapper `runQaCreativeCopyViaBoxSession` with a scripted dispatcher so the flow is
 * deterministically testable without a real box session:
 *
 *   (a) the shared validator is invoked BEFORE the dispatch — a clean pass returns pass:true
 *       + a TRUSTED CONTEXT block that lists every rail.
 *   (b) a rail failure (competitor leak) surfaces on the pass:false result AND is threaded
 *       into the trusted-context block Max sees.
 *   (c) the dispatcher receives the TRUSTED CONTEXT block as the PROMPT (outside any DATA
 *       fence) so a downstream reader can verify the wire-in without spawning a session.
 *   (d) a dispatch error is fail-closed — the outcome carries the validator result AND a
 *       reason, so operators can observe the mismatch downstream.
 *
 * Runs via: npx tsx --test src/lib/ads/creative-qa.copy-qc.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeCopyQcPreCheck,
  runQaCreativeCopyViaBoxSession,
  parseCopyQaVerdict,
  insertCopyQaVerdict,
  type CopyQcSessionDispatcher,
} from "./creative-qa";
import type { CreativeBrief } from "./creative-brief";

const stubBrief = { productTitle: "Amazing Coffee" } as unknown as CreativeBrief;

const cleanCopy = {
  headline: "Cleaner morning energy",
  primaryText: "Drink one cup and get through the afternoon without the crash.",
  description: "Real reviews from customers.",
};

test("(a) computeCopyQcPreCheck: clean copy → validator pass + TRUSTED CONTEXT block lists every rail", () => {
  const result = computeCopyQcPreCheck({
    copy: cleanCopy,
    brief: stubBrief,
    context: { audience_temperature: "warm", competitorAdvertisers: [], ourBrand: "Amazing Coffee" },
  });
  assert.equal(result.validator.pass, true);
  // TRUSTED CONTEXT block must be the fence Max's SKILL.md documents.
  assert.match(result.trustedContextBlock, /BEGIN_VALIDATOR_TRUSTED_CONTEXT_v1/);
  assert.match(result.trustedContextBlock, /END_VALIDATOR_TRUSTED_CONTEXT_v1/);
  assert.match(result.trustedContextBlock, /VALIDATOR_PASS: true/);
  // Every rail must appear so Max can align his hard_gates output on the same names.
  for (const rail of ["lf8", "meta_caps", "no_msrp", "no_competitor_leak", "cold_offer_gate", "single_promise"]) {
    assert.match(result.trustedContextBlock, new RegExp(rail));
  }
});

test("(b) computeCopyQcPreCheck: competitor leak → validator pass:false + block flags the same rail", () => {
  const result = computeCopyQcPreCheck({
    copy: { ...cleanCopy, primaryText: "Cleaner than MUD/WTR — and half the caffeine crash." },
    brief: stubBrief,
    context: { audience_temperature: "warm", competitorAdvertisers: ["MUD/WTR"], ourBrand: "Amazing Coffee" },
  });
  assert.equal(result.validator.pass, false);
  assert.match(result.trustedContextBlock, /VALIDATOR_PASS: false/);
  // The failing rail line must carry a reason so Max sees WHY it failed (not just that it did).
  assert.match(result.trustedContextBlock, /no_competitor_leak: fail/);
});

test("(c) runQaCreativeCopyViaBoxSession: dispatcher receives the TRUSTED CONTEXT block as the prompt", async () => {
  let captured: { prompt: string; imagePath: string } | null = null;
  const dispatch: CopyQcSessionDispatcher = async (prompt, imagePath) => {
    captured = { prompt, imagePath };
    return { resultText: '{"hard_gate_pass":true}', isError: false };
  };
  const outcome = await runQaCreativeCopyViaBoxSession(
    {
      copy: cleanCopy,
      brief: stubBrief,
      context: { audience_temperature: "warm", competitorAdvertisers: [], ourBrand: "Amazing Coffee" },
      imagePath: "/tmp/pinned-copy-qc.jpg",
    },
    dispatch,
  );
  assert.equal(outcome.kind, "ok");
  const cap = captured as unknown as { prompt: string; imagePath: string } | null;
  assert.ok(cap, "dispatcher must have been invoked");
  assert.equal(cap!.imagePath, "/tmp/pinned-copy-qc.jpg");
  // The prompt Max sees MUST carry the TRUSTED CONTEXT block from the pre-check —
  // Max reads it to align his hard-gate output on the same six rail names.
  assert.match(cap!.prompt, /BEGIN_VALIDATOR_TRUSTED_CONTEXT_v1/);
  // The outcome MUST carry the same validator result the block reported, so a downstream
  // observer can compare Max's hard-gates against the SSOT rails.
  if (outcome.kind === "ok") {
    assert.equal(outcome.validator.pass, true);
  }
});

test("(d) runQaCreativeCopyViaBoxSession: dispatcher throws → dispatch_error outcome with the validator result still attached (fail-closed)", async () => {
  const dispatch: CopyQcSessionDispatcher = async () => {
    throw new Error("boom");
  };
  const outcome = await runQaCreativeCopyViaBoxSession(
    {
      copy: cleanCopy,
      brief: stubBrief,
      context: { audience_temperature: "warm", competitorAdvertisers: [], ourBrand: "Amazing Coffee" },
      imagePath: "/tmp/pinned-copy-qc.jpg",
    },
    dispatch,
  );
  assert.equal(outcome.kind, "dispatch_error");
  if (outcome.kind === "dispatch_error") {
    assert.match(outcome.reason, /qa_copy_session_dispatch_error/);
    // Fail-closed does NOT erase the pre-check — operators still see the validator's typed result.
    assert.equal(outcome.validator.pass, true);
  }
});

test("(d) runQaCreativeCopyViaBoxSession: dispatcher isError=true → dispatch_error outcome (no throw path)", async () => {
  const dispatch: CopyQcSessionDispatcher = async () => ({ resultText: "", isError: true });
  const outcome = await runQaCreativeCopyViaBoxSession(
    {
      copy: cleanCopy,
      brief: stubBrief,
      context: { audience_temperature: "warm", competitorAdvertisers: [], ourBrand: "Amazing Coffee" },
      imagePath: "/tmp/pinned-copy-qc.jpg",
    },
    dispatch,
  );
  assert.equal(outcome.kind, "dispatch_error");
  if (outcome.kind === "dispatch_error") {
    assert.equal(outcome.reason, "qa_copy_session_error");
  }
});

// ── max-copy-qc-scroll-stop-dims Phase 1 pinning cases ────────────────────────────────────────
// These two cases pin the parser + SDK contract for the new advisory scroll_stop dimensions:
//   (e) parseCopyQaVerdict accepts a verdict CARRYING scroll_stop → the parsed CopyQaVerdict
//       has the three named sub-scores + evidence array populated, AND insertCopyQaVerdict
//       writes the field on the row body it hands to admin.from(...).insert().
//   (f) parseCopyQaVerdict REFUSES a verdict where scroll_stop is missing OR explicitly null
//       — same shape as the M1 hard-gate mismatch parse failure (fail-closed).

const passVerdictWithScrollStop = {
  hard_gate_pass: true,
  hard_gates: {
    no_fabrication: true,
    no_cold_offer: true,
    no_competitor_leak: true,
    single_promise: true,
    render_ok: true,
  },
  persuasion_score: 7,
  persuasion_rubric: {
    lf8: 2,
    schwartz: 1,
    cialdini: 2,
    hopkins: 1,
    sugarman: 1,
    evidence: ["lf8: 'stand at the counter shaking' — physical scene of a primal desire"],
  },
  scroll_stop: {
    headline_readable_in_3_frames: 2,
    visual_hierarchy_supports_headline: 1,
    first_line_earns_the_second: 1,
    evidence: [
      "headline_readable_in_3_frames: 'Cleaner morning energy' set large against a neutral plate",
      "visual_hierarchy_supports_headline: hero mug anchors but pack sticker competes",
    ],
  },
  verdict_reason: "clean caption grounded in the brief",
};

test("(e) parseCopyQaVerdict: verdict carrying scroll_stop → parsed with the three named sub-scores + evidence populated", () => {
  const parsed = parseCopyQaVerdict(JSON.stringify(passVerdictWithScrollStop));
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  assert.equal(parsed.verdict.hard_gate_pass, true);
  assert.deepEqual(parsed.verdict.scroll_stop, {
    headline_readable_in_3_frames: 2,
    visual_hierarchy_supports_headline: 1,
    first_line_earns_the_second: 1,
    evidence: [
      "headline_readable_in_3_frames: 'Cleaner morning energy' set large against a neutral plate",
      "visual_hierarchy_supports_headline: hero mug anchors but pack sticker competes",
    ],
  });
});

test("(e) insertCopyQaVerdict: writes scroll_stop on the row body it hands to the admin client", async () => {
  const parsed = parseCopyQaVerdict(JSON.stringify(passVerdictWithScrollStop));
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  let capturedBody: Record<string, unknown> | null = null;
  // Minimal admin fake — records the body handed to .insert(...) so the pinning is a pure unit
  // test (no supabase pooler, no network). The chain shape mirrors admin.from(t).insert(b).select(c).single().
  const fakeAdmin = {
    from(_table: string) {
      return {
        insert(body: Record<string, unknown>) {
          capturedBody = body;
          return {
            select(_cols: string) {
              return {
                async single() {
                  return { data: { id: "verdict-pinned-uuid" }, error: null };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof insertCopyQaVerdict>[0];
  const result = await insertCopyQaVerdict(fakeAdmin, {
    workspaceId: "ws-1",
    adCampaignId: "camp-1",
    verdict: parsed.verdict,
    retryIndex: 0,
  });
  assert.deepEqual(result, { id: "verdict-pinned-uuid" });
  assert.ok(capturedBody, "insertCopyQaVerdict must call .insert() with a body");
  const body = capturedBody as unknown as Record<string, unknown>;
  assert.equal(body.workspace_id, "ws-1");
  assert.equal(body.ad_campaign_id, "camp-1");
  assert.equal(body.hard_gate_pass, true);
  assert.equal(body.retry_index, 0);
  // The scroll_stop field is REQUIRED on every insert per the max-copy-qc-scroll-stop-dims
  // Phase 1 contract — advisory sub-scores go on the row for later CAC correlation.
  assert.deepEqual(body.scroll_stop, {
    headline_readable_in_3_frames: 2,
    visual_hierarchy_supports_headline: 1,
    first_line_earns_the_second: 1,
    evidence: [
      "headline_readable_in_3_frames: 'Cleaner morning energy' set large against a neutral plate",
      "visual_hierarchy_supports_headline: hero mug anchors but pack sticker competes",
    ],
  });
});

test("(f) parseCopyQaVerdict: verdict MISSING scroll_stop → parse_error (fail-closed)", () => {
  const missing = { ...passVerdictWithScrollStop } as Record<string, unknown>;
  delete missing.scroll_stop;
  const parsed = parseCopyQaVerdict(JSON.stringify(missing));
  assert.equal(parsed.kind, "parse_error");
  if (parsed.kind === "parse_error") {
    assert.equal(parsed.reason, "copy_qc_verdict_missing_scroll_stop");
  }
});

test("(f) parseCopyQaVerdict: verdict with scroll_stop:null → parse_error (fail-closed)", () => {
  const nulled = { ...passVerdictWithScrollStop, scroll_stop: null };
  const parsed = parseCopyQaVerdict(JSON.stringify(nulled));
  assert.equal(parsed.kind, "parse_error");
  if (parsed.kind === "parse_error") {
    assert.equal(parsed.reason, "copy_qc_verdict_missing_scroll_stop");
  }
});

test("(f) parseCopyQaVerdict: scroll_stop sub-score out of 0..2 range → parse_error (fail-closed)", () => {
  const outOfRange = {
    ...passVerdictWithScrollStop,
    scroll_stop: {
      ...passVerdictWithScrollStop.scroll_stop,
      first_line_earns_the_second: 3,
    },
  };
  const parsed = parseCopyQaVerdict(JSON.stringify(outOfRange));
  assert.equal(parsed.kind, "parse_error");
  if (parsed.kind === "parse_error") {
    assert.match(parsed.reason, /scroll_stop_first_line_earns_the_second_out_of_range/);
  }
});

test("(f) parseCopyQaVerdict: hard-gate fail carries scroll_stop unchanged (advisory-only contract)", () => {
  // A fail-mode verdict still carries the three sub-scores on the row (they're advisory; the
  // bounce is the persuasion signal, but the scroll_stop record is what CAC correlation reads).
  const failVerdict = {
    hard_gate_pass: false,
    hard_gates: {
      no_fabrication: false,
      no_cold_offer: true,
      no_competitor_leak: true,
      single_promise: true,
      render_ok: true,
    },
    persuasion_score: null,
    persuasion_rubric: null,
    scroll_stop: {
      headline_readable_in_3_frames: 1,
      visual_hierarchy_supports_headline: 0,
      first_line_earns_the_second: 0,
      evidence: ["headline_readable_in_3_frames: unusually long headline forces a stop-and-parse"],
    },
    verdict_reason: "primary text invents a '35% of women' stat the brief doesn't ground",
  };
  const parsed = parseCopyQaVerdict(JSON.stringify(failVerdict));
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  assert.equal(parsed.verdict.hard_gate_pass, false);
  assert.equal(parsed.verdict.persuasion_score, null);
  // scroll_stop MUST persist on a fail — that's the advisory contract from Phase 1.
  assert.equal(parsed.verdict.scroll_stop.headline_readable_in_3_frames, 1);
  assert.equal(parsed.verdict.scroll_stop.first_line_earns_the_second, 0);
});
