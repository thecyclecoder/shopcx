import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Regression for the fleet-wide silent test-launch freeze (2026-07-21):
// `evaluateMediaBuyerTestPublish`'s purchaser/customer-exclusion rail reads the proposed
// targeting from `input.createAdsetSpec?.targeting ?? input.targeting ?? null`. The publisher
// in ad-tool.ts used to call the gate WITHOUT `createAdsetSpec`, so the rail saw `null`
// targeting and refused `missing_purchaser_exclusion` on EVERY per-test publish the moment a
// cohort declared an exclusion audience — every hero product's new tests posted PAUSED, silently.
// The gate itself is correct + covered (publish-gate.test.ts); this guards the CALLER contract so
// the publisher can never again hand the exclusion rail a null spec.
test("ad-tool publisher passes createAdsetSpec to the media-buyer test gate (exclusion rail needs the real targeting)", async () => {
  const src = await readFile(new URL("./ad-tool.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /evaluateMediaBuyerTestPublish\(admin, \{[\s\S]*?createAdsetSpec: perTestSpec[\s\S]*?\}\)/,
    "the ad-tool publisher must pass `createAdsetSpec: perTestSpec` into evaluateMediaBuyerTestPublish so the purchaser/customer-exclusion rail inspects the real excluded_custom_audiences instead of a null spec",
  );
});
