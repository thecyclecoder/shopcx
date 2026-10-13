/**
 * Unit tests for citesUnverifiedFix — Phase 1 of
 * docs/brain/specs/repair-transient-park-verifies-itself.md.
 *
 * The scar: three Sep 18 deploy-storm crons (deploy-guardian-cron, meta-capi-dispatch-cron,
 * amplifier-import-reconcile) got a CORRECT "transient" repair verdict, but the reason described
 * the deploy reaping *in-flight Inngest runs* — and the old bare `in[-\s]?flight` alternative
 * matched that, mis-parking them as "pending verification — unverified fix cited". They reached
 * the CEO inbox as Park Backstop cards and sat 25 days.
 *
 * These three reasons MUST NOT match (bare in-flight describing the cron, not a cited fix); the
 * original phantom-close examples MUST still match.
 *
 * Pure helper — no DB, no network, no clock. Run:
 *   npx tsx --test src/lib/repair-verdict-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { citesUnverifiedFix, beatsAreRecovered, loopIdFromSignature } from "./repair-verdict-guard";

// ── The three real Sep 18 deploy-storm reasons — bare in-flight describes the CRON, not a fix. ──
const SEP18_TRANSIENT_REASONS = [
  "deploy-guardian-cron went red for one tick because the Sep 18 deploy reaped in-flight Inngest runs mid-deploy; the next tick emitted fresh healthy heartbeats.",
  "meta-capi-dispatch-cron: a deploy during the storm reaped in-flight functions, so one scheduled run never recorded a beat; it self-recovered on the following tick.",
  "amplifier-import-reconcile skipped a tick — deploys reap in-flight Inngest cron ticks — and recovered on its own with no code change.",
];

for (const reason of SEP18_TRANSIENT_REASONS) {
  test(`Sep 18 deploy-storm reason MUST NOT match (bare in-flight): ${reason.slice(0, 48)}…`, () => {
    assert.equal(
      citesUnverifiedFix(reason),
      false,
      `a correct transient verdict describing in-flight Inngest runs reaped by a deploy is NOT a cited fix — it must not park:\n${reason}`,
    );
  });
}

// ── The original phantom-close examples — each cites an unverified pending fix → MUST match. ──
const PHANTOM_CLOSE_REASONS: Array<[string, string]> = [
  ["pending deploy", "the fix is merged and pending deploy; the metric should recover once it lands."],
  ["pending verification", "transient — pending verification that the error signature stops recurring."],
  ["already-fixed", "already-fixed by the last PR; awaiting the next cycle."],
  ["resolved-by", "resolved-by the merged change to the dunning retry."],
  ["auto-queued", "auto-queued a build for the regression."],
  ["queued build", "queued build for the corrected cron registration."],
  ["fix in-flight", "the fix is in-flight on a claude/build branch, not yet deployed."],
  ["in-flight build", "there is an in-flight build for this signature already."],
  ["in-flight spec", "an in-flight spec addresses this; waiting on merge."],
  ["in-flight PR", "the in-flight PR for the retry wrapper will close this."],
  ["in-flight deploy", "an in-flight deploy carries the fix."],
  ["[[spec-slug]] link", "root cause understood; see [[dunning-retry-backoff]] for the fix."],
];

for (const [label, reason] of PHANTOM_CLOSE_REASONS) {
  test(`phantom-close example MUST match (${label})`, () => {
    assert.equal(
      citesUnverifiedFix(reason),
      true,
      `a transient reason citing an unverified fix (${label}) must park pending verification:\n${reason}`,
    );
  });
}

// ── A genuine one-off with no pending fix behind it → MUST NOT match (closes cleanly). ──
test("genuine one-off recovery with no cited fix MUST NOT match", () => {
  assert.equal(
    citesUnverifiedFix("a momentary upstream 529 from the embeddings API self-cleared on retry; no code change."),
    false,
  );
});

// ── Phase 2: beatsAreRecovered — the pure loop-heartbeat recovery predicate. ──

test("recovered: ≥2 ok beats since the anchor, none red after the latest ok", () => {
  assert.equal(
    beatsAreRecovered([
      { ran_at: "2026-09-18T10:00:00Z", ok: true },
      { ran_at: "2026-09-18T10:05:00Z", ok: true },
      { ran_at: "2026-09-18T10:10:00Z", ok: true },
    ]),
    true,
  );
});

test("NOT recovered: only one ok beat (below minOkBeats default of 2)", () => {
  assert.equal(beatsAreRecovered([{ ran_at: "2026-09-18T10:00:00Z", ok: true }]), false);
});

test("NOT recovered: empty window — the loop never ran since the alert", () => {
  assert.equal(beatsAreRecovered([]), false);
});

test("NOT recovered: a failed beat landed AFTER the latest ok (loop went red again)", () => {
  assert.equal(
    beatsAreRecovered([
      { ran_at: "2026-09-18T10:00:00Z", ok: true },
      { ran_at: "2026-09-18T10:05:00Z", ok: true },
      { ran_at: "2026-09-18T10:10:00Z", ok: false }, // flapped back to red
    ]),
    false,
  );
});

test("recovered: an early red beat is fine as long as the latest beats are healthy", () => {
  assert.equal(
    beatsAreRecovered([
      { ran_at: "2026-09-18T10:00:00Z", ok: false }, // the alert-era failure
      { ran_at: "2026-09-18T10:05:00Z", ok: true },
      { ran_at: "2026-09-18T10:10:00Z", ok: true },
    ]),
    true,
  );
});

test("beatsAreRecovered sorts an out-of-order window (does not assume input order)", () => {
  assert.equal(
    beatsAreRecovered([
      { ran_at: "2026-09-18T10:10:00Z", ok: true },
      { ran_at: "2026-09-18T10:00:00Z", ok: false },
      { ran_at: "2026-09-18T10:05:00Z", ok: true },
    ]),
    true,
  );
});

test("minOkBeats is honored — require 3 ok beats", () => {
  assert.equal(
    beatsAreRecovered(
      [
        { ran_at: "2026-09-18T10:00:00Z", ok: true },
        { ran_at: "2026-09-18T10:05:00Z", ok: true },
      ],
      3,
    ),
    false,
  );
});

// ── Phase 2: loopIdFromSignature — strip the `loop:` prefix off a repair signature. ──

test("loopIdFromSignature strips the loop: prefix", () => {
  assert.equal(loopIdFromSignature("loop:deploy-guardian-cron"), "deploy-guardian-cron");
});

test("loopIdFromSignature returns null for a non-loop signature", () => {
  assert.equal(loopIdFromSignature("inngest/dunning.retry:500"), null);
  assert.equal(loopIdFromSignature(null), null);
  assert.equal(loopIdFromSignature(undefined), null);
});
