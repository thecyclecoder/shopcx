/**
 * Engine fraud velocity + freemail tests, built from real incidents (PII scrubbed).
 *
 *  - 2026-06-18 @netscape.net false positive: 4 unrelated long-time customers
 *    shared only a legacy freemail domain the old hand-seeded list missed.
 *    A freemail domain must NEVER open a domain-velocity case.
 *  - 2026-06 ring on a throwaway custom domain (@safelywater.com shape): fresh
 *    local parts on one domain the ring controls. Must fire at ≥4 accounts.
 *  - Reinard-shaped surname ring: one surname reused across fresh accounts,
 *    several on custom domains.
 *
 * Run: npx tsx --test src/lib/engine/fraud/velocity.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  FREEMAIL_DOMAINS,
  emailDomain,
  isCustomDomain,
  firstNameOverlap,
  evaluateDomainVelocity,
  evaluateSurnameVelocity,
} from "./index";

test("freemail list covers legacy providers (netscape.net) and the inline supplement", () => {
  assert.ok(FREEMAIL_DOMAINS.size > 10_000);
  for (const d of ["gmail.com", "aol.com", "netscape.net", "netscape.com"]) assert.ok(FREEMAIL_DOMAINS.has(d), d);
  assert.equal(isCustomDomain("netscape.net"), false);
  assert.equal(isCustomDomain("safelywater.com"), true);
  assert.equal(isCustomDomain(""), false);
});

test("emailDomain lowercases, trims, and uses the last @", () => {
  assert.equal(emailDomain("  Jane.Doe@SafelyWater.COM "), "safelywater.com");
  assert.equal(emailDomain("weird@name@host.io"), "host.io");
  assert.equal(emailDomain("no-at-sign"), "");
  assert.equal(emailDomain(null), "");
});

test("@netscape.net incident: 4 unrelated accounts on a freemail domain → NO case", () => {
  const rows = ["a", "b", "c", "d"].map((c) => ({ customerId: c, email: `${c}person@netscape.net` }));
  const r = evaluateDomainVelocity("netscape.net", rows);
  assert.equal(r.fired, false);
  assert.equal(r.customerCount, 4);
});

test("throwaway custom domain: 4 fresh accounts → case, worded like legacy", () => {
  const rows = ["a", "b", "c", "d"].map((c) => ({ customerId: c, email: `${c}buyer@SafelyWater.com` }));
  const r = evaluateDomainVelocity("safelywater.com", rows);
  assert.equal(r.fired, true);
  assert.equal(r.emailCount, 4);
  assert.equal(r.title, "4 accounts on @safelywater.com ordered in 30d");
  assert.ok(r.emails.every((e) => e === e.toLowerCase()));
});

test("custom domain below threshold (3 accounts, or 4 accounts reusing 3 emails) → NO case", () => {
  const three = ["a", "b", "c"].map((c) => ({ customerId: c, email: `${c}@ring.io` }));
  assert.equal(evaluateDomainVelocity("ring.io", three).fired, false);
  const reused = [
    { customerId: "a", email: "x@ring.io" },
    { customerId: "b", email: "x@ring.io" },
    { customerId: "c", email: "y@ring.io" },
    { customerId: "d", email: "z@ring.io" },
  ];
  assert.equal(evaluateDomainVelocity("ring.io", reused).fired, false);
});

test("one account repeating orders on a custom domain never fires", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ customerId: "solo", email: `solo${i}@ring.io` }));
  assert.equal(evaluateDomainVelocity("ring.io", rows).fired, false);
});

test("Reinard-shaped surname ring: 5 new accounts, 3 on custom domains → case", () => {
  const rows = [
    { email: "r1@gmail.com" },
    { email: "r2@yahoo.com" },
    { email: "r3@safelywater.com" },
    { email: "r4@safelywater.com" },
    { email: "r5@purewell.co" },
  ];
  const r = evaluateSurnameVelocity("Reinard", rows);
  assert.equal(r.fired, true);
  assert.equal(r.nonFreemailCount, 3);
  assert.equal(r.title, '5 new "Reinard" accounts (3 on custom domains, 30d)');
});

test("common surname on all-freemail accounts (a family, a popular name) → NO case", () => {
  const rows = ["gmail.com", "aol.com", "netscape.net", "yahoo.com", "hotmail.com"].map((d, i) => ({ email: `s${i}@${d}` }));
  assert.equal(evaluateSurnameVelocity("Smith", rows).fired, false);
});

test("surname shorter than 3 letters never groups", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ email: `n${i}@ring${i}.io` }));
  assert.equal(evaluateSurnameVelocity("Li", rows).fired, false);
  assert.equal(evaluateSurnameVelocity("Lin", rows).fired, true);
});

test("firstNameOverlap catches name padding but not short collisions", () => {
  assert.equal(firstNameOverlap("stephen", "benstephen"), true);
  assert.equal(firstNameOverlap("estephen", "stephen"), true);
  assert.equal(firstNameOverlap("al", "alan"), false);
  assert.equal(firstNameOverlap("", "alan"), false);
});
