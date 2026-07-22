/**
 * Publisher regression test for the "stale/unavailable Meta ad set fails closed"
 * fix. Pins the stable fingerprint the classifier writes onto the publish job +
 * recommendation, and pins the wire so an unavailable adset RETURNS from the
 * `createAd` boundary instead of rethrowing (a rethrow surfaces as a
 * `/api/inngest` crash + Control Tower incident every time — the exact class
 * this spec closes).
 *
 * Runs via: npx tsx --test src/lib/inngest/ad-tool.publish-adset-unavailable.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("ad-tool publisher imports the stable stale-adset classifier + reason", async () => {
  const src = await readFile(new URL("./ad-tool.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /from "@\/lib\/ads\/publish-adset-unavailable-classifier"/,
    "the publisher must import the shared classifier module so the stable failure reason cannot drift out of sync",
  );
  assert.match(
    src,
    /\bSTALE_ADSET_FAILURE_REASON\b/,
    "the publisher must reference STALE_ADSET_FAILURE_REASON so the stable `meta_adset_unavailable` fingerprint is used, not a bespoke string",
  );
  assert.match(
    src,
    /\bisMetaAdsetUnavailableError\b/,
    "the publisher must call isMetaAdsetUnavailableError to gate the fail-closed branch, so unrelated errors keep throwing",
  );
});

test("ad-tool publisher catches Meta object-missing at the createAd boundary and returns instead of throwing", async () => {
  const src = await readFile(new URL("./ad-tool.ts", import.meta.url), "utf8");
  // Match the shape: a try wrapping createAd, then a catch that classifies via
  // isMetaAdsetUnavailableError, then a `return { ok: false, reason: STALE_ADSET_FAILURE_REASON }`.
  const guarded =
    /try\s*\{\s*adId\s*=\s*await\s+createAd\([\s\S]*?\}\s*catch\s*\([^)]*\)\s*\{\s*if\s*\(\s*isMetaAdsetUnavailableError\([\s\S]*?return\s*\{\s*ok:\s*false,\s*reason:\s*STALE_ADSET_FAILURE_REASON\s*\}[\s\S]*?throw\s+err\s*;/;
  assert.match(
    src,
    guarded,
    "the createAd boundary must classify unavailable-target errors, return normally with reason=STALE_ADSET_FAILURE_REASON, and rethrow anything else",
  );
});

test("ad-tool publisher mirrors the stable stale-adset reason onto the linked recommendation", async () => {
  const src = await readFile(new URL("./ad-tool.ts", import.meta.url), "utf8");
  // Inside the classified branch, the recommendation update must also carry
  // STALE_ADSET_FAILURE_REASON — otherwise Growth's recommendation feed shows a
  // bespoke error message on one side and the stable fingerprint on the other.
  assert.match(
    src,
    /isMetaAdsetUnavailableError\([\s\S]*?iteration_recommendations[\s\S]*?error:\s*STALE_ADSET_FAILURE_REASON/,
    "when the classifier matches, the recommendation mirror must write STALE_ADSET_FAILURE_REASON so the publish-job and recommendation rows agree",
  );
});
