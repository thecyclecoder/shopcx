/**
 * Unit tests for [[../scripts/builder-worker.account-tier.ts]] — Max accounts (RR1/RR2) carry the load,
 * Pro accounts (RR3/RR4) only take overflow.
 *
 *   npx tsx --test scripts/builder-worker.account-tier.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_OVERFLOW_CONFIG_DIRS,
  DEFAULT_PRIMARY_SOFT_MAX,
  parseOverflowDirs,
  parsePrimarySoftMax,
  pickTieredAccount,
} from "./builder-worker.account-tier";

const RR1 = "/home/builder/.claude";
const RR2 = "/home/builder/.claude-personal";
const RR3 = "/home/builder/.claude-third";
const RR4 = "/home/builder/.claude-fourth";
const OVERFLOW = new Set([RR3, RR4]);
const acct = (configDir: string, inFlight = 0, lastAssignedAt = 0) => ({ configDir, inFlight, lastAssignedAt });

test("idle pool: new work goes to a Max primary, never to Pro overflow", () => {
  const pick = pickTieredAccount([acct(RR1), acct(RR2), acct(RR3), acct(RR4)], OVERFLOW, 4);
  assert.ok(pick && [RR1, RR2].includes(pick.configDir));
});

test("primaries share the load least-loaded first, then least-recently-used", () => {
  assert.equal(pickTieredAccount([acct(RR1, 2), acct(RR2, 1), acct(RR3), acct(RR4)], OVERFLOW, 4)?.configDir, RR2);
  assert.equal(pickTieredAccount([acct(RR1, 1, 200), acct(RR2, 1, 100), acct(RR3), acct(RR4)], OVERFLOW, 4)?.configDir, RR2);
});

test("both primaries at the soft max: spill to the least-loaded overflow account", () => {
  const pick = pickTieredAccount([acct(RR1, 4), acct(RR2, 4), acct(RR3, 1), acct(RR4, 0)], OVERFLOW, 4);
  assert.equal(pick?.configDir, RR4);
});

test("primaries capped/held (absent from healthy): overflow takes the work", () => {
  assert.equal(pickTieredAccount([acct(RR3, 1), acct(RR4, 0)], OVERFLOW, 4)?.configDir, RR4);
});

test("overflow capped too: stack on the least-loaded primary rather than park", () => {
  assert.equal(pickTieredAccount([acct(RR1, 6), acct(RR2, 5)], OVERFLOW, 4)?.configDir, RR2);
});

test("empty healthy set → null (the caller parks blocked_on_usage)", () => {
  assert.equal(pickTieredAccount([], OVERFLOW, 4), null);
});

test("config parsing: defaults, explicit list, and 'none' = flat pool", () => {
  assert.deepEqual([...parseOverflowDirs(undefined)], DEFAULT_OVERFLOW_CONFIG_DIRS);
  assert.deepEqual([...parseOverflowDirs(" /a/ , /b ")], ["/a", "/b"]);
  assert.equal(parseOverflowDirs("none").size, 0);
  assert.equal(parsePrimarySoftMax(undefined), DEFAULT_PRIMARY_SOFT_MAX);
  assert.equal(parsePrimarySoftMax("6"), 6);
  assert.equal(parsePrimarySoftMax("0"), DEFAULT_PRIMARY_SOFT_MAX);
});
