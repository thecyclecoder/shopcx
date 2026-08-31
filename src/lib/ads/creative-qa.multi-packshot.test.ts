/**
 * Pins the two pure guards behind the 2026-08-24 Dahlia false-positive fixes.
 *
 * The wedge (job 23308ec5, Superfood Tabs): the QC reference packshot was hardcoded to
 * `isolatedPackshots[0]` — always Strawberry Lemonade — while every hero/lifestyle asset for the
 * product is Peach Mango, so the generator rendered Peach Mango and QC called a CORRECT render
 * "wrong dominant pack color, altered flavor art". Two of the three flavours could never pass.
 *
 * Same job also burned all 3 QA attempts rendering "Ozempic" (a Novo Nordisk trademark carried
 * verbatim from the Erth Labs hook) — deterministic, because the hook is fixed input.
 *
 * Run: npx tsx --test src/lib/ads/creative-qa.multi-packshot.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePackshotUrls, MAX_REFERENCE_PACKSHOTS } from "./creative-qa";
import { findThirdPartyTrademark, THIRD_PARTY_TRADEMARKS } from "./creative-agent";

const SL = "https://cdn.example/variants/strawberry-lemonade/isolated.png";
const PM = "https://cdn.example/variants/peach-mango/isolated.png";
const MB = "https://cdn.example/variants/mixed-berry/isolated.png";

// ── resolvePackshotUrls ────────────────────────────────────────────────────

test("every flavour variant reaches QC — the wedge: [0]-only rejected a correct Peach Mango render", () => {
  assert.deepEqual(resolvePackshotUrls({ packshotUrls: [SL, PM, MB] }), [SL, PM, MB]);
});

test("legacy single packshotUrl still works when no list is supplied", () => {
  assert.deepEqual(resolvePackshotUrls({ packshotUrl: SL }), [SL]);
});

test("the list wins over the legacy single field", () => {
  assert.deepEqual(resolvePackshotUrls({ packshotUrl: SL, packshotUrls: [PM, MB] }), [PM, MB]);
});

test("no packshot at all yields an empty list (QC then SKIPS packagingFaithful)", () => {
  assert.deepEqual(resolvePackshotUrls({}), []);
  assert.deepEqual(resolvePackshotUrls({ packshotUrl: null, packshotUrls: null }), []);
  assert.deepEqual(resolvePackshotUrls({ packshotUrls: [] }), []);
});

test("non-http and duplicate entries are dropped", () => {
  assert.deepEqual(
    resolvePackshotUrls({ packshotUrls: [SL, SL, "data:image/png;base64,xx", "", PM] }),
    [SL, PM],
  );
});

test("the reference list is capped so a many-variant product can't blow up the vision call", () => {
  const many = Array.from({ length: 12 }, (_, i) => `https://cdn.example/v${i}.png`);
  assert.equal(resolvePackshotUrls({ packshotUrls: many }).length, MAX_REFERENCE_PACKSHOTS);
});

// ── findThirdPartyTrademark ────────────────────────────────────────────────

test("the exact hook that burned 3 renders is now caught before generation", () => {
  assert.equal(findThirdPartyTrademark("Meet Nature's Ozempic"), "ozempic");
});

test("case and surrounding punctuation don't hide it", () => {
  assert.equal(findThirdPartyTrademark("nature's OZEMPIC, basically"), "ozempic");
  assert.equal(findThirdPartyTrademark("Like Wegovy — without the needle"), "wegovy");
});

test("a clean hook passes, including the prescribed replacement line", () => {
  assert.equal(findThirdPartyTrademark("Nature's Way To Curb Cravings"), null);
  assert.equal(findThirdPartyTrademark("Meet Nature's Answer To Cravings"), null);
});

test("empty / nullish input is not a match", () => {
  assert.equal(findThirdPartyTrademark(null), null);
  assert.equal(findThirdPartyTrademark(undefined), null);
  assert.equal(findThirdPartyTrademark(""), null);
});

test("word-boundary matched, so a substring inside an unrelated word does NOT fire", () => {
  // "botox" must not be found inside a longer non-trademark word.
  assert.equal(findThirdPartyTrademark("robotoxicology report"), null);
  // ...but the standalone word still is.
  assert.equal(findThirdPartyTrademark("no botox needed"), "botox");
});

test("the GLP-1 family is covered — that is the category our competitors keep naming", () => {
  for (const tm of ["ozempic", "wegovy", "mounjaro", "zepbound", "semaglutide", "tirzepatide"]) {
    assert.ok(THIRD_PARTY_TRADEMARKS.includes(tm), `${tm} should be denylisted`);
    assert.equal(findThirdPartyTrademark(`try ${tm} instead`), tm);
  }
});
