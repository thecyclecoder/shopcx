/**
 * The tsc check type-checks source without the checkout's generated `.next` types, which may belong to
 * another branch's last build (stale routes → a permanent harness error).
 *
 * Run:
 *   npx tsx --test src/lib/spec-check-runner.tsc-config.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTscConfigWithoutNextTypes } from "./spec-check-runner";

test("drops every .next include and extends the repo tsconfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsc-cfg-"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ include: ["**/*.ts", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"] }));
  const name = writeTscConfigWithoutNextTypes(dir);
  assert.ok(name && /^tsconfig\.spec-check\..+\.json$/.test(name));
  const cfg = JSON.parse(readFileSync(join(dir, name!), "utf8"));
  assert.equal(cfg.extends, "./tsconfig.json");
  assert.deepEqual(cfg.include, ["**/*.ts"]);
});

test("no .next include → null (plain tsc)", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsc-cfg-"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ include: ["**/*.ts"] }));
  assert.equal(writeTscConfigWithoutNextTypes(dir), null);
});

test("unreadable tsconfig → null", () => {
  assert.equal(writeTscConfigWithoutNextTypes(mkdtempSync(join(tmpdir(), "tsc-cfg-"))), null);
});
