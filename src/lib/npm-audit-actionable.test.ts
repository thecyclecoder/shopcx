import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, isActionableAdvisory, isDowngradeFix } from "./npm-audit-actionable";

const installed = (map: Record<string, string>) => (pkg: string) => map[pkg] ?? null;

test("compareVersions orders dotted numeric versions", () => {
  assert.ok(compareVersions("14.2.35", "16.2.9") < 0);
  assert.ok(compareVersions("7.1.6", "7.1.5") > 0);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("^1.0.0", "1.0.0"), 0);
});

test("2026-10-14 incident: eslint-config-next@14.2.35 suggested under 16.2.9 is a downgrade, not actionable", () => {
  const v = { severity: "high", fixAvailable: { name: "eslint-config-next", version: "14.2.35", isSemVerMajor: true } };
  const reader = installed({ "eslint-config-next": "16.2.9" });
  assert.equal(isDowngradeFix(v.fixAvailable, reader), true);
  assert.equal(isActionableAdvisory(v, reader), false);
});

test("a forward fix (even semver-major) stays actionable", () => {
  const v = { severity: "moderate", fixAvailable: { name: "next", version: "17.0.0", isSemVerMajor: true } };
  assert.equal(isActionableAdvisory(v, installed({ next: "16.2.0" })), true);
});

test("fixAvailable=true is actionable; false/absent is not", () => {
  assert.equal(isActionableAdvisory({ severity: "critical", fixAvailable: true }, installed({})), true);
  assert.equal(isActionableAdvisory({ severity: "critical", fixAvailable: false }, installed({})), false);
  assert.equal(isActionableAdvisory({ severity: "critical" }, installed({})), false);
});

test("low severity is never actionable", () => {
  assert.equal(isActionableAdvisory({ severity: "low", fixAvailable: true }, installed({})), false);
});

test("unknown installed version does not suppress a fix", () => {
  const v = { severity: "high", fixAvailable: { name: "x", version: "1.0.0" } };
  assert.equal(isActionableAdvisory(v, installed({})), true);
});
