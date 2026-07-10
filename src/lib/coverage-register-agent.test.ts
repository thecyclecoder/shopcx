/**
 * coverage-register-agent tests. Two durable contracts:
 *
 *   A) `inferOwner` is a legacy DOMAIN classifier (growth/cs/retention/cmo/platform, else null) — still
 *      correct, still tested, but NO LONGER decides a loop tile's owner.
 *   B) coverage-register-always-platform (CEO directive, 2026-07): a monitored-loop ENTRY is ALWAYS
 *      `platform`-owned (loop LIVENESS is a platform-reliability concern regardless of the cron's business
 *      domain). So `inferLoopEntry` always sets owner=`platform`, with no low-confidence placeholder / no
 *      "REQUIRES OWNER CONFIRMATION"; `isOwnerConfident` is always true; and the register/exempt spec bodies
 *      carry `**Why:**`/`**What:**` intent so they author cleanly through the intent-gated chokepoint (the
 *      upsertSpec self-gate requires spec-level why/what — a null-intent coverage spec used to throw).
 *
 * Run: npx tsx --test src/lib/coverage-register-agent.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { inferOwner, inferLoopEntry, isOwnerConfident, buildRegisterSpecBody, buildExemptSpecBody } from "./coverage-register-agent";
import { extractIntentHeaders, extractPhaseBodies } from "./author-spec";

test("inferOwner: growth crons — research / creative / acquisition / lander / scout / brand", () => {
  // The named failing state from the accumulated coaching: acquisition-research-cadence-cron and
  // creative-finder-* landed with owner:'platform' + "Confirm the owner-function" boilerplate.
  assert.equal(inferOwner("acquisition-research-cadence-cron"), "growth");
  assert.equal(inferOwner("creative-finder-daily-cron"), "growth");
  assert.equal(inferOwner("creative-finder-video-process"), "growth");
  assert.equal(inferOwner("research-sensor-cron"), "growth");
  assert.equal(inferOwner("storefront-experiments-tick"), "growth");
  assert.equal(inferOwner("meta-fatigue-scan-cron"), "growth");
  assert.equal(inferOwner("lander-blueprint-cron"), "growth");
  assert.equal(inferOwner("scout-daily"), "growth");
  assert.equal(inferOwner("prospect-enrich-cron"), "growth");
  assert.equal(inferOwner("brand-refresh-cron"), "growth");
});

test("inferOwner: cs / retention / cmo shapes", () => {
  assert.equal(inferOwner("ticket-auto-archive"), "cs");
  assert.equal(inferOwner("escalation-triage-cron"), "cs");
  assert.equal(inferOwner("csat-followup"), "cs");
  assert.equal(inferOwner("inbox-drain-cron"), "cs");

  assert.equal(inferOwner("dunning-payday-retry-cron"), "retention");
  assert.equal(inferOwner("subscription-renewal-sweep"), "retention");
  assert.equal(inferOwner("loyalty-tier-refresh"), "retention");
  assert.equal(inferOwner("return-window-close"), "retention");
  assert.equal(inferOwner("refund-audit-cron"), "retention");
  assert.equal(inferOwner("churn-signal-sweep"), "retention");

  assert.equal(inferOwner("scorecard-daily"), "cmo");
  assert.equal(inferOwner("crisis-daily-campaign"), "cmo");
  assert.equal(inferOwner("auto-blog-generate"), "cmo");
});

test("inferOwner: recognized platform infra crons", () => {
  assert.equal(inferOwner("control-tower-monitor"), "platform");
  assert.equal(inferOwner("brain-index-refresh"), "platform");
  assert.equal(inferOwner("security-dep-watch"), "platform");
  assert.equal(inferOwner("platform-director-cron"), "platform");
  assert.equal(inferOwner("deploy-guardian-sweep"), "platform");
  assert.equal(inferOwner("sync-inventory"), "platform");
});

test("inferOwner: returns null on unclassifiable ids — never a silent 'platform' guess", () => {
  // The bake-in guardrail: an id we don't confidently recognize returns null so inferLoopEntry
  // marks the entry low-confidence rather than shipping a fake platform default with the boilerplate
  // "Confirm the owner-function" description. This is the failing state coaching #7 named.
  assert.equal(inferOwner("xyzzy-cadence"), null);
  assert.equal(inferOwner("quux-tick"), null);
  assert.equal(inferOwner(""), null);
});

test("inferLoopEntry: owner is ALWAYS platform (coverage-register-always-platform)", () => {
  // A monitored loop's LIVENESS is a platform-reliability concern, regardless of the cron's business
  // domain — so the tile owner is always platform, even for a growth-shaped id. No placeholder, no warning.
  for (const id of ["acquisition-research-cadence-cron", "ticket-auto-archive", "dunning-payday-retry-cron", "xyzzy-cadence", "quux-tick"]) {
    const entry = inferLoopEntry(id, "0 10 * * *");
    assert.equal(entry.owner, "platform", `${id} → platform`);
    assert.ok(!entry.description.includes("REQUIRES OWNER CONFIRMATION"), `${id}: no low-confidence warning`);
    assert.ok(!entry.description.toLowerCase().includes("placeholder"), `${id}: no placeholder language`);
  }
});

test("isOwnerConfident: always true (owner is always the confident platform)", () => {
  assert.equal(isOwnerConfident("acquisition-research-cadence-cron"), true);
  assert.equal(isOwnerConfident("xyzzy-cadence"), true);
  assert.equal(isOwnerConfident(""), true);
});

test("register + exempt spec bodies carry **Why:**/**What:** intent AND a phase Verification (authors through the gate)", () => {
  // Regression guard for the null-intent break: the upsertSpec self-gate requires spec-level why/what, so a
  // coverage spec body with no intent throws. Both bodies must carry it, and the register body a Verification.
  const entry = inferLoopEntry("some-loop-cron", "0 8 16 * *", "2026-07-10T00:00:00.000Z");
  const reg = buildRegisterSpecBody(entry);
  const regIntent = extractIntentHeaders(reg);
  assert.ok(regIntent.why && regIntent.why.trim(), "register body has **Why:**");
  assert.ok(regIntent.what && regIntent.what.trim(), "register body has **What:**");
  const phases = extractPhaseBodies(reg);
  assert.ok(phases[0]?.verification && phases[0].verification.trim(), "register phase 1 carries a Verification");

  const ex = buildExemptSpecBody("some-loop-cron", entry.owner);
  const exIntent = extractIntentHeaders(ex);
  assert.ok(exIntent.why && exIntent.why.trim(), "exempt body has **Why:**");
  assert.ok(exIntent.what && exIntent.what.trim(), "exempt body has **What:**");
});
