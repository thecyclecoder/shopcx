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
