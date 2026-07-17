/**
 * market-sophistication tests — pin the +1 escalation POLICY invariants the
 * [[../../../docs/brain/specs/dahlia-market-sophistication-escalation]] spec's
 * verification list depends on. Runs via:
 *   npm run test:market-sophistication
 *   (or) npx tsx --test src/lib/ads/market-sophistication.test.ts
 *
 * Pure — no live network / DB. The last test (productId argv pin) uses a
 * fake `getProvenCompetitorAngles` injected via the exported override
 * parameter, so the structural contract "the read is per-product" is
 * verified without a Supabase mock.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeMarketSophistication,
  computeMarketSophisticationFromShelf,
  escalateShelfModal,
} from "./market-sophistication";
import type { CompetitorAngle, CompetitorAngleOptions, ProvenAnglesResult } from "./creative-sourcing";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

const WS = "00000000-0000-0000-0000-0000000000ws";
const PRODUCT = "prod-super-tabs";

function makeAngle(over: Partial<CompetitorAngle> = {}): CompetitorAngle {
  return {
    advertiser: "Rival Co",
    hook: "clean energy",
    framework: null,
    mechanismClaim: null,
    proof: null,
    offer: null,
    daysRunning: 60,
    heat: null,
    destinationDomain: null,
    imageUrl: null,
    resumeAdvertising: true,
    ...over,
  };
}

const fakeAdmin = {} as Admin;

test("empty shelf → {shelfModal:3, targetLevel:4, evidence contains 'no proven competitor shelf'}", () => {
  const result = computeMarketSophisticationFromShelf([]);
  assert.equal(result.shelfModal, 3);
  assert.equal(result.targetLevel, 4);
  assert.equal(result.evidence.length, 1);
  assert.match(result.evidence[0], /no proven competitor shelf/);
});

test("all-L4 shelf → {shelfModal:4, targetLevel:5}", () => {
  const shelf: CompetitorAngle[] = [
    makeAngle({ hook: "real adaptogen stack" }),
    makeAngle({ hook: "ashwagandha inside" }),
    makeAngle({ hook: "l-theanine every serving" }),
  ];
  const result = computeMarketSophisticationFromShelf(shelf);
  assert.equal(result.shelfModal, 4);
  assert.equal(result.targetLevel, 5);
  assert.equal(result.evidence.length, 3);
});

test("all-L5 shelf → {shelfModal:5, targetLevel:5} (clamped at 5)", () => {
  const shelf: CompetitorAngle[] = [
    makeAngle({ hook: "vs coffee, half the crash" }),
    makeAngle({ hook: "compared to your morning cup" }),
    makeAngle({ hook: "instead of an espresso" }),
  ];
  const result = computeMarketSophisticationFromShelf(shelf);
  assert.equal(result.shelfModal, 5);
  assert.equal(result.targetLevel, 5, "escalation clamps at 5 — never L6");
});

test("L3 majority with L4 tail → {shelfModal:3, targetLevel:4} + evidence names each contributing angle with advertiser + level", () => {
  const shelf: CompetitorAngle[] = [
    makeAngle({ advertiser: "Alpha Co", hook: "clean energy for the afternoon" }),
    makeAngle({ advertiser: "Bravo Co", hook: "focus support all day long" }),
    makeAngle({ advertiser: "Charlie Co", hook: "clean energy every morning" }),
    makeAngle({ advertiser: "Delta Co", hook: "real adaptogen stack" }),
  ];
  const result = computeMarketSophisticationFromShelf(shelf);
  assert.equal(result.shelfModal, 3, "3 × L3 vs 1 × L4 → modal is 3");
  assert.equal(result.targetLevel, 4, "+1 escalation over L3 = L4");
  assert.equal(result.evidence.length, 4, "one evidence line per contributing angle");
  assert.match(result.evidence[0], /advertiser=Alpha Co/);
  assert.match(result.evidence[0], /level=L3/);
  assert.match(result.evidence[0], /hook=clean energy for the afternoon/);
  assert.match(result.evidence[3], /advertiser=Delta Co/);
  assert.match(result.evidence[3], /level=L4/);
});

test("productId filter is passed to getProvenCompetitorAngles (structural pin)", async () => {
  const calls: Array<{ workspaceId: string; opts: CompetitorAngleOptions }> = [];
  const fakeGet = async (
    _admin: Admin,
    workspaceId: string,
    opts: CompetitorAngleOptions = {},
  ): Promise<ProvenAnglesResult> => {
    calls.push({ workspaceId, opts });
    return { angles: [], usedFallback: false };
  };
  const result = await computeMarketSophistication(fakeAdmin, WS, PRODUCT, fakeGet);
  assert.equal(calls.length, 1, "exactly one call to getProvenCompetitorAngles");
  assert.equal(calls[0].workspaceId, WS);
  assert.equal(calls[0].opts.productId, PRODUCT, "the read is per-product (creative_skeletons.product_id — the deliberate imitate link)");
  assert.equal(calls[0].opts.minDaysRunning, 30, "spec-pinned floor: 30d proven-competitor pool");
  // Empty shelf → the safe mid-market default still applies.
  assert.equal(result.shelfModal, 3);
  assert.equal(result.targetLevel, 4);
});

test("escalateShelfModal: +1 monotonic across 1..4, clamped at 5", () => {
  assert.equal(escalateShelfModal(1), 2);
  assert.equal(escalateShelfModal(2), 3);
  assert.equal(escalateShelfModal(3), 4);
  assert.equal(escalateShelfModal(4), 5);
  assert.equal(escalateShelfModal(5), 5, "clamped — no L6");
});

test("computeMarketSophistication tolerates getProvenCompetitorAngles rejections (safe mid-market default)", async () => {
  const fakeGetRejects = async (): Promise<ProvenAnglesResult> => {
    throw new Error("db_down");
  };
  const result = await computeMarketSophistication(fakeAdmin, WS, PRODUCT, fakeGetRejects);
  assert.equal(result.shelfModal, 3, "read error → treated as empty shelf, safe default");
  assert.equal(result.targetLevel, 4);
});
