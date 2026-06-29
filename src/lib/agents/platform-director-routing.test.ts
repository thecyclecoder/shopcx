/**
 * Unit tests for the PURE build-driver keystone helpers (CEO directive 2026-06-29 — Ada/Platform is the
 * SOLE builder for EVERY department, build-driving DECOUPLED from the spec's owner). Built-in node:test —
 * no test-runner dependency. Run:
 *   tsx --test src/lib/agents/platform-director-routing.test.ts
 *
 * Asserts `specDriver` / `platformDrivesSpec` over fixture autonomy maps: whenever Platform is live+autonomous
 * it drives EVERY owner's spec (including a department whose OWN director is live+autonomous — that no longer
 * flips build-driving off Ada). The ONLY fail-safe: Platform dormant ⇒ build-driving falls to the CEO.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CEO, type OrgChartGraph, type AutonomyMap } from "./approval-router";
import { specDriver, platformDrivesSpec, PLATFORM } from "./platform-director";

const FLAT: OrgChartGraph = {
  parentOf: { growth: CEO, cmo: CEO, retention: CEO, cs: CEO, platform: CEO },
};

const PLATFORM_ONLY: AutonomyMap = { platform: { live: true, autonomous: true } };

test("Platform live+autonomous: Ada drives EVERY owner's spec (owner is attribution, not the build driver)", () => {
  for (const owner of ["platform", "cs", "growth", "cmo", "retention", undefined, null]) {
    assert.equal(specDriver(owner, FLAT, PLATFORM_ONLY), PLATFORM, `owner=${owner}`);
    assert.equal(platformDrivesSpec(owner, FLAT, PLATFORM_ONLY), true, `owner=${owner}`);
  }
});

test("a department going live+autonomous does NOT move build-driving off Ada — she still builds its specs", () => {
  // A live+autonomous department OPERATES its software + AUTHORS specs; it never builds. Build-driving stays Ada.
  const csLive: AutonomyMap = { platform: { live: true, autonomous: true }, cs: { live: true, autonomous: true } };
  for (const owner of ["cs", "growth", "platform", "retention", undefined, null]) {
    assert.equal(specDriver(owner, FLAT, csLive), PLATFORM, `owner=${owner}`);
    assert.equal(platformDrivesSpec(owner, FLAT, csLive), true, `owner=${owner}`);
  }
});

test("fail-safe: Platform NOT live+autonomous ⇒ build-driving falls through to the CEO for every owner", () => {
  // Platform live-but-not-autonomous: dormant ⇒ nothing auto-builds, the CEO is the build driver.
  const platformLiveOnly: AutonomyMap = { platform: { live: true, autonomous: false } };
  // A department being live+autonomous does NOT rescue build-driving when Platform itself is off.
  const deptLivePlatformOff: AutonomyMap = { platform: { live: false, autonomous: false }, cs: { live: true, autonomous: true } };
  for (const autonomy of [{}, platformLiveOnly, deptLivePlatformOff]) {
    for (const owner of ["platform", "cs", "growth", "retention", undefined, null]) {
      assert.equal(specDriver(owner, FLAT, autonomy), CEO, `owner=${owner}`);
      assert.equal(platformDrivesSpec(owner, FLAT, autonomy), false, `owner=${owner}`);
    }
  }
});
