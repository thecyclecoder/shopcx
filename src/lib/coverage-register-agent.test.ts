/**
 * agent-mandate-hardening-coverage-register — bake-in of the 9 accumulated coaching points that the
 * ephemeral appended agent_instructions couldn't make stick. These tests pin the DURABLE mandate:
 *
 *   1. inferOwner catches known growth crons (research/creative/acquisition/lander/scout) — the
 *      previous narrow regex fell through to "platform" for acquisition-research-cadence-cron and
 *      creative-finder-*, so entries shipped with the wrong owner + boilerplate placeholder.
 *   2. inferOwner returns null for truly unknown ids (not a false "platform" default). Callers use
 *      isOwnerConfident() to render the "REQUIRES OWNER CONFIRMATION" warning in the fix spec body
 *      before the owner taps Build.
 *   3. inferLoopEntry uses `platform` as an EXPLICIT low-confidence placeholder when inferOwner
 *      returns null AND flags "REQUIRES OWNER CONFIRMATION" in the description, so a fallthrough
 *      entry cannot silently sail as a confident guess.
 *
 * Run: npx tsx --test src/lib/coverage-register-agent.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { inferOwner, inferLoopEntry, isOwnerConfident } from "./coverage-register-agent";

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

test("inferLoopEntry: confident owner → normal description", () => {
  const entry = inferLoopEntry("acquisition-research-cadence-cron", "0 10 * * *");
  assert.equal(entry.owner, "growth");
  assert.ok(!entry.description.includes("REQUIRES OWNER CONFIRMATION"), "confident entry must NOT carry the low-confidence warning");
  assert.ok(entry.description.includes("Confirm the owner-function"), "confident entry keeps the light 'confirm' nudge");
});

test("inferLoopEntry: low-confidence fallthrough → owner=platform placeholder + REQUIRES OWNER CONFIRMATION", () => {
  // The mandate: a cron id inferOwner can't classify does NOT ship as a confident 'platform' guess.
  // Type demands a value, so 'platform' rides as a PLACEHOLDER and the description makes the low-
  // confidence state explicit — the owner MUST override before merging.
  const entry = inferLoopEntry("xyzzy-cadence", "0 5 * * *");
  assert.equal(entry.owner, "platform");
  assert.ok(entry.description.includes("REQUIRES OWNER CONFIRMATION"), "low-confidence entry MUST warn the owner in the description");
  assert.ok(entry.description.includes("placeholder"), "low-confidence entry MUST call out that platform is a placeholder");
});

test("isOwnerConfident: mirrors inferOwner nullness", () => {
  assert.equal(isOwnerConfident("acquisition-research-cadence-cron"), true);
  assert.equal(isOwnerConfident("ticket-auto-archive"), true);
  assert.equal(isOwnerConfident("control-tower-monitor"), true);
  assert.equal(isOwnerConfident("xyzzy-cadence"), false);
});
