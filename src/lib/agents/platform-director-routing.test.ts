/**
 * Unit tests for the PURE keystone routing helpers (director-drives-all-specs-and-deferred-status Phase 2 —
 * owner-agnostic drive, "first live boss else up"). Built-in node:test — no test-runner dependency. Run:
 *   tsx --test src/lib/agents/platform-director-routing.test.ts
 *
 * Asserts `specDriver` / `platformDrivesSpec` over fixture autonomy maps: today only platform is live so it
 * drives every owner's spec; flip a department live+autonomous and its specs route to IT, not platform.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CEO, type OrgChartGraph, type AutonomyMap } from "./approval-router";
import { specDriver, platformDrivesSpec, PLATFORM } from "./platform-director";

const FLAT: OrgChartGraph = {
  parentOf: { growth: CEO, cmo: CEO, retention: CEO, cs: CEO, platform: CEO },
};

const PLATFORM_ONLY: AutonomyMap = { platform: { live: true, autonomous: true } };

test("today (only platform live): platform drives its own + every not-yet-live department's spec", () => {
  for (const owner of ["platform", "cs", "growth", "cmo", "retention", undefined, null]) {
    assert.equal(specDriver(owner, FLAT, PLATFORM_ONLY), PLATFORM, `owner=${owner}`);
    assert.equal(platformDrivesSpec(owner, FLAT, PLATFORM_ONLY), true, `owner=${owner}`);
  }
});

test("a live+autonomous department director drives its OWN specs — platform stops driving them", () => {
  const csLive: AutonomyMap = { platform: { live: true, autonomous: true }, cs: { live: true, autonomous: true } };
  assert.equal(specDriver("cs", FLAT, csLive), "cs");
  assert.equal(platformDrivesSpec("cs", FLAT, csLive), false);
  // platform still covers the departments that AREN'T live yet
  assert.equal(specDriver("growth", FLAT, csLive), PLATFORM);
  assert.equal(platformDrivesSpec("growth", FLAT, csLive), true);
  // and still drives its own
  assert.equal(specDriver("platform", FLAT, csLive), PLATFORM);
});

test("live-but-not-autonomous (or unconfigured) owner falls through to the platform keystone", () => {
  const csLiveOnly: AutonomyMap = { platform: { live: true, autonomous: true }, cs: { live: true, autonomous: false } };
  assert.equal(specDriver("cs", FLAT, csLiveOnly), PLATFORM);
  assert.equal(platformDrivesSpec("cs", FLAT, csLiveOnly), true);
});
