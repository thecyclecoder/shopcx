/**
 * Scent-match invariant for the ad publish path (attribution-sensor-recalibration
 * Phase 2). Pins that the pure helpers behind the publish route enforce the
 * invariant "final destination_url ALWAYS carries ?angle=&variant=":
 *
 *   - hasScentMatchParams(url)                — the guard the publish route reads
 *   - appendScentMatchParams(url, landerUrl)  — the append the publish route runs
 *
 * Pure — no I/O.
 *   npx tsx --test src/lib/advertorial-pages.scent-match.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendScentMatchParams, hasScentMatchParams } from "./advertorial-pages";

const LANDER = "https://superfoods.co/products/coffee?variant=advertorial&angle=morning-lift";

test("hasScentMatchParams: only true when BOTH angle and variant are present", () => {
  assert.equal(hasScentMatchParams("https://superfoods.co/products/coffee"), false);
  assert.equal(hasScentMatchParams("https://superfoods.co/products/coffee?angle=x"), false);
  assert.equal(hasScentMatchParams("https://superfoods.co/products/coffee?variant=advertorial"), false);
  assert.equal(hasScentMatchParams("https://superfoods.co/products/coffee?angle=x&variant=advertorial"), true);
  assert.equal(hasScentMatchParams(""), false);
  assert.equal(hasScentMatchParams("not a url"), false);
});

test("appendScentMatchParams: bare PDP → gains angle+variant from the lander", () => {
  const out = appendScentMatchParams("https://superfoods.co/products/coffee", LANDER);
  assert.equal(hasScentMatchParams(out), true);
  const u = new URL(out);
  assert.equal(u.searchParams.get("angle"), "morning-lift");
  assert.equal(u.searchParams.get("variant"), "advertorial");
  // Path preserved — we're appending, not replacing.
  assert.equal(u.pathname, "/products/coffee");
});

test("appendScentMatchParams: existing angle wins over the lander's angle", () => {
  const out = appendScentMatchParams("https://superfoods.co/products/coffee?angle=operator-picked", LANDER);
  assert.equal(hasScentMatchParams(out), true);
  const u = new URL(out);
  assert.equal(u.searchParams.get("angle"), "operator-picked");
  assert.equal(u.searchParams.get("variant"), "advertorial");
});

test("appendScentMatchParams: no lander → destination unchanged (nothing to derive)", () => {
  const bare = "https://superfoods.co/products/coffee";
  assert.equal(appendScentMatchParams(bare, null), bare);
  assert.equal(appendScentMatchParams(bare, ""), bare);
});

test("appendScentMatchParams: malformed URL → unchanged (safe default)", () => {
  assert.equal(appendScentMatchParams("not a url", LANDER), "not a url");
  assert.equal(appendScentMatchParams("https://superfoods.co/products/coffee", "not a url"), "https://superfoods.co/products/coffee");
});

test("publish-path invariant: after the guard+append, destination MUST carry angle+variant", () => {
  // Simulates the publish route's post-fallback branch:
  //   if (destinationUrl && !hasScentMatchParams(destinationUrl)) {
  //     const lander = await advertorialLanderUrl(...);
  //     if (lander) destinationUrl = appendScentMatchParams(destinationUrl, lander);
  //   }
  // For every plausible bare / partial destination + a resolvable lander, the
  // final URL MUST carry both params.
  const cases = [
    "https://superfoods.co/products/coffee",
    "https://superfoods.co/products/coffee?utm_source=meta",
    "https://superfoods.co/products/coffee?angle=x", // variant missing
    "https://superfoods.co/products/coffee?variant=advertorial", // angle missing
  ];
  for (const dest of cases) {
    let final = dest;
    if (final && !hasScentMatchParams(final)) {
      final = appendScentMatchParams(final, LANDER);
    }
    assert.equal(hasScentMatchParams(final), true, `${dest} did not gain angle+variant`);
  }
});
