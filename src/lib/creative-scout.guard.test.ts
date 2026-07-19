/**
 * creative-scout Phase 1 — the approved-advertiser guard + the per-product approved set.
 *
 * Pins the three behaviors the spec calls out (Creamer's silent per-competitor drops + non-mapped
 * leakage of "Healthy Habits" / "A Path to Better Health"): only ads whose advertiser normalizes to
 * an APPROVED competitor of the product survive; a null advertiser is refused; an empty approved set
 * opts out of the guard (matches the pre-per-product path).
 *
 * Pure — no DB, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Seed } from "./adlibrary";
import { filterAdsByApprovedAdvertisers } from "./creative-skeleton";
import { buildApprovedAdvertiserSet } from "./inngest/creative-scout";

const seed = (keyword: string, expectedAdvertiser?: string): Seed => ({
  keyword,
  kind: "competitor",
  competitorId: `cid-${keyword}`,
  productId: "creamer",
  expectedAdvertiser,
});

test("buildApprovedAdvertiserSet flattens brand + expectedAdvertiser to normalized handles", () => {
  const seeds = [
    seed("Obvi"),
    seed("NativePath"),
    seed("Vital Proteins", "Vital Proteins LLC"),
    seed("Ancient Nutrition"),
    seed("SkinnyFit"),
  ];
  const set = buildApprovedAdvertiserSet(seeds);
  // Every approved competitor's brand is in
  assert.equal(set.has("obvi"), true);
  assert.equal(set.has("nativepath"), true);
  assert.equal(set.has("vitalproteins"), true);
  assert.equal(set.has("ancientnutrition"), true);
  assert.equal(set.has("skinnyfit"), true);
  // The expectedAdvertiser variant is ALSO in (both are handles for the same brand)
  assert.equal(set.has("vitalproteinsllc"), true);
  // The non-mapped affiliates the spec flags are NOT in
  assert.equal(set.has("healthyhabits"), false);
  assert.equal(set.has("apathtobetterhealth"), false);
});

test("buildApprovedAdvertiserSet ignores empty keywords (never admits a blank handle)", () => {
  const set = buildApprovedAdvertiserSet([{ keyword: "", kind: "competitor" }]);
  assert.equal(set.size, 0);
});

test("filterAdsByApprovedAdvertisers: an approved advertiser's ad passes", () => {
  const approved = new Set(["obvi", "nativepath", "vitalproteins"]);
  const ads = [{ ad_key: "a1", advertiser: "Obvi" }];
  const { kept, dropped } = filterAdsByApprovedAdvertisers(ads, approved);
  assert.equal(kept.length, 1);
  assert.equal(dropped, 0);
});

test("filterAdsByApprovedAdvertisers: the Creamer leakage advertisers are DROPPED", () => {
  // The exact fingerprint the spec calls out — a Creamer sweep that returned these two got them
  // persisted before this guard existed.
  const approved = new Set(["obvi", "nativepath", "vitalproteins", "ancientnutrition", "skinnyfit"]);
  const ads = [
    { ad_key: "healthy1", advertiser: "Healthy Habits" },
    { ad_key: "path1", advertiser: "A Path to Better Health" },
    { ad_key: "obvi1", advertiser: "Obvi" }, // control — an approved competitor's ad passes
  ];
  const { kept, dropped } = filterAdsByApprovedAdvertisers(ads, approved);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].ad_key, "obvi1");
  assert.equal(dropped, 2);
});

test("filterAdsByApprovedAdvertisers: a null/blank advertiser is DROPPED (cannot verify → cannot admit)", () => {
  const approved = new Set(["obvi"]);
  const ads = [
    { ad_key: "n1", advertiser: null },
    { ad_key: "n2", advertiser: "" },
    { ad_key: "n3", advertiser: "   " },
  ];
  const { kept, dropped } = filterAdsByApprovedAdvertisers(ads, approved);
  assert.equal(kept.length, 0);
  assert.equal(dropped, 3);
});

test("filterAdsByApprovedAdvertisers: an empty approved set opts out (no guard)", () => {
  const ads = [{ ad_key: "a1", advertiser: "Anyone" }, { ad_key: "a2", advertiser: null }];
  const { kept, dropped } = filterAdsByApprovedAdvertisers(ads, new Set<string>());
  assert.equal(kept.length, 2);
  assert.equal(dropped, 0);
});

test("filterAdsByApprovedAdvertisers: 'Vital Proteins LLC' passes when its handle is in the set", () => {
  // The seed builder adds BOTH brand + expectedAdvertiser handles, so a page-name variant of the
  // same brand (Meta occasionally serves "Vital Proteins LLC" as advertiser) is admitted.
  const seeds = [seed("Vital Proteins", "Vital Proteins LLC")];
  const approved = buildApprovedAdvertiserSet(seeds);
  const ads = [
    { ad_key: "vp1", advertiser: "Vital Proteins" },
    { ad_key: "vp2", advertiser: "Vital Proteins LLC" },
  ];
  const { kept, dropped } = filterAdsByApprovedAdvertisers(ads, approved);
  assert.equal(kept.length, 2);
  assert.equal(dropped, 0);
});
