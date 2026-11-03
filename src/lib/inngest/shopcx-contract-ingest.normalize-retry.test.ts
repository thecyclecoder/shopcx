/**
 * F4: a failed checkout-contract normalization used to be logged and swallowed. Nothing threw, so
 * Inngest never retried, and the new PDP subscriber renewed at full MSRP (+33% per unit, tier lost)
 * until a human fixed the contract. The step now throws so Inngest retries it, and on the last
 * attempt it gives up with a `normalize_failed` beat (the renewal re-runs the normalizer before
 * charging — see shopify-subscription-renewals.settle-and-claim.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeFailureDisposition } from "./shopcx-contract-ingest";

test("F4: every attempt before the last retries", () => {
  assert.equal(normalizeFailureDisposition(0, 3), "retry");
  assert.equal(normalizeFailureDisposition(1, 3), "retry");
  assert.equal(normalizeFailureDisposition(2, 3), "retry");
});

test("F4: the final attempt gives up instead of dying without a heartbeat", () => {
  assert.equal(normalizeFailureDisposition(3, 3), "give_up");
});

test("F4: the normalize step throws on a retryable failure", () => {
  const SRC = readFileSync(join(__dirname, "shopcx-contract-ingest.ts"), "utf8");
  const stepAt = SRC.indexOf('step.run("normalize-pricing"');
  const body = SRC.slice(stepAt, SRC.indexOf('step.run("beat"', stepAt));
  assert.match(body, /if \(normalizeFailureDisposition\(attempt\) === "retry"\) \{\s*throw new Error/);
  assert.match(SRC, /retries: INGEST_RETRIES,/, "the disposition and the function share one retry budget");
  assert.match(SRC, /async \(\{ event, step, attempt \}\)/);
});
