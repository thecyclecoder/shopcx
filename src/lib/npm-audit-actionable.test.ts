import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  isActionableAdvisory,
  isDowngradeFix,
  installedVersionReader,
  packageJsonVersionReader,
} from "./npm-audit-actionable";

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

test("2026-10-14 preview regression: declared package.json range holds the downgrade filter when node_modules is pruned", () => {
  // Vercel preview (what the pre-merge spec-test runs against) prunes devDependencies, so
  // node_modules/eslint-config-next is absent and the node_modules-only reader returned null →
  // the downgrade-only fix (eslint-config-next@14.2.35) read as actionable → the check could
  // never pass. The reader must fall back to the declared package.json range, which survives.
  const dir = mkdtempSync(join(tmpdir(), "npm-audit-actionable-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        devDependencies: { "eslint-config-next": "^16.4.0" },
        overrides: { "postcss-selector-parser@<7.1.6": "^7.1.6" },
      }),
    );
    // No node_modules/ created → simulates the devDep-pruned preview deploy.
    const reader = installedVersionReader(dir);
    assert.equal(reader("eslint-config-next"), "^16.4.0");
    assert.equal(reader("postcss-selector-parser"), "^7.1.6");
    const v = {
      severity: "high",
      fixAvailable: { name: "eslint-config-next", version: "14.2.35", isSemVerMajor: true },
    };
    assert.equal(isDowngradeFix(v.fixAvailable, reader), true);
    assert.equal(isActionableAdvisory(v, reader), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installed node_modules version wins over the declared range", () => {
  const dir = mkdtempSync(join(tmpdir(), "npm-audit-actionable-nm-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { "eslint-config-next": "^16.4.0" } }));
    mkdirSync(join(dir, "node_modules", "eslint-config-next"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "eslint-config-next", "package.json"), JSON.stringify({ version: "16.4.0" }));
    assert.equal(installedVersionReader(dir)("eslint-config-next"), "16.4.0");
    assert.equal(packageJsonVersionReader(dir)("eslint-config-next"), "^16.4.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
