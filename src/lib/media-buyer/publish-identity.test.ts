/**
 * Unit tests for the canonical publish-identity resolver
 * (all-product-ads-always-publish-under-the-superfoods-company-fb-page-and-instagram Phase 1).
 *
 * The rules the tests pin — one per CEO invariant the spec called out:
 *   1. Resolver returns the Superfoods Company Facebook Page (104094194369069)
 *      + Instagram (17841409041235543) for the Superfoods workspace.
 *   2. Resolver THROWS for any other workspace id — never a silent per-cohort
 *      fallback (the whole point of pinning one canonical identity).
 *   3. `hasResolvedInstagramIdentity` treats null/undefined/empty/whitespace as
 *      MISSING and a real 17841… value as PRESENT.
 *   4. `buildReplenishJobInsert` stamps the CANONICAL page + IG on the
 *      `ad_publish_jobs` insert body EVEN when the cohort's per-row
 *      `default_meta_page_id`/`default_meta_instagram_user_id` are wrong or
 *      NULL — the 5-of-6 cohorts-missing-IG production defect can never mint
 *      an ad without IG again.
 *   5. `buildReplenishJobInsert` REFUSES (never mints a job) when the resolved
 *      identity's `instagramUserId` is empty — belt-and-suspenders over the
 *      resolver's constant, so a future edit that empties the constant can't
 *      silently ship a Meta 400.
 *
 * Run:
 *   npx tsx --test src/lib/media-buyer/publish-identity.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  hasResolvedInstagramIdentity,
  MISSING_CANONICAL_INSTAGRAM_IDENTITY_REASON,
  resolvePublishIdentity,
  SUPERFOODS_COMPANY_INSTAGRAM_USER_ID,
  SUPERFOODS_COMPANY_PAGE_ID,
  SUPERFOODS_WORKSPACE_ID,
} from "./publish-identity";
import { buildReplenishJobInsert } from "./agent";
import type { MediaBuyerTestCohort } from "./publish-gate";

// ── 1. Resolver returns canonical Superfoods identity ────────────────────────

test("resolvePublishIdentity — Superfoods workspace returns canonical page + IG", () => {
  const id = resolvePublishIdentity(SUPERFOODS_WORKSPACE_ID);
  assert.equal(id.pageId, "104094194369069", "Facebook Page must be the Superfoods Company page");
  assert.equal(id.instagramUserId, "17841409041235543", "Instagram user id must be @superfoodscompany");
  assert.equal(id.pageId, SUPERFOODS_COMPANY_PAGE_ID);
  assert.equal(id.instagramUserId, SUPERFOODS_COMPANY_INSTAGRAM_USER_ID);
});

// ── 2. Resolver throws for any other workspace (no silent fallback) ──────────

test("resolvePublishIdentity — unknown workspace throws (never silently falls back to a per-cohort default)", () => {
  assert.throws(
    () => resolvePublishIdentity("00000000-0000-0000-0000-000000000000"),
    /no canonical publish identity/,
    "unknown workspace must throw so the caller can never publish under an unregistered brand identity",
  );
});

// ── 3. Empty/whitespace/null IG is treated as MISSING ────────────────────────

test("hasResolvedInstagramIdentity — null/undefined/empty/whitespace all MISSING; a real id is PRESENT", () => {
  assert.equal(hasResolvedInstagramIdentity(null), false);
  assert.equal(hasResolvedInstagramIdentity(undefined), false);
  assert.equal(hasResolvedInstagramIdentity({ instagramUserId: "" }), false);
  assert.equal(hasResolvedInstagramIdentity({ instagramUserId: "   " }), false);
  assert.equal(hasResolvedInstagramIdentity({ instagramUserId: SUPERFOODS_COMPANY_INSTAGRAM_USER_ID }), true);
});

// ── 4. buildReplenishJobInsert always stamps the CANONICAL page + IG ─────────

function baseCohort(overrides: Partial<MediaBuyerTestCohort> = {}): MediaBuyerTestCohort {
  return {
    id: "cohort-1",
    workspaceId: "ws-1",
    metaAdAccountId: "acct-A",
    productId: null,
    testMetaAdsetId: "6100000000001",
    dailyTestCeilingCents: 60_000,
    isActive: true,
    notes: null,
    updatedBy: null,
    createdAt: "",
    updatedAt: "",
    defaultMetaAccountId: "act-1",
    defaultMetaPageId: "wrong-per-cohort-page", // divergent per-cohort value
    defaultMetaInstagramUserId: null, // the 5-of-6 cohorts-missing-IG defect
    adsetPerTest: false,
    testMetaCampaignId: null,
    perTestDailyBudgetCents: 15_000,
    adsetTemplate: null,
    excludedPurchaserAudienceId: null,
    excludedAllCustomersAudienceId: null,
    ...overrides,
  };
}

test("buildReplenishJobInsert — stamps canonical Superfoods page + IG regardless of cohort per-row defaults", () => {
  const cohort = baseCohort({ defaultMetaPageId: "771546149377238", defaultMetaInstagramUserId: null });
  const built = buildReplenishJobInsert({
    workspaceId: "ws-1",
    cohort,
    action: {
      kind: "replenish",
      adCampaignId: "cmp-1",
      testMetaAdsetId: "6100000000001",
      adsetPerTest: false,
      dailyTestCeilingCents: 60_000,
      rationale: "test",
    },
    accountId: "act-1",
    publishIdentity: {
      pageId: SUPERFOODS_COMPANY_PAGE_ID,
      instagramUserId: SUPERFOODS_COMPANY_INSTAGRAM_USER_ID,
    },
    videoId: "vid-1",
    adName: "Media Buyer test — cmp-1",
    destination: "https://x/1",
    headlines: ["h"],
    primaryTexts: ["p"],
    descriptions: [],
  });
  assert.equal(built.ok, true, "canonical identity + valid cohort must produce an insert body");
  if (!built.ok) return;
  assert.equal(
    built.insert.meta_page_id,
    SUPERFOODS_COMPANY_PAGE_ID,
    "meta_page_id must be the canonical Superfoods Company page (104094194369069), not the cohort's divergent per-row default",
  );
  assert.equal(
    built.insert.meta_instagram_user_id,
    SUPERFOODS_COMPANY_INSTAGRAM_USER_ID,
    "meta_instagram_user_id must be the canonical Superfoods IG (17841409041235543), not the cohort's null default (the 5-of-6 production defect)",
  );
});

// ── 5. buildReplenishJobInsert REFUSES when identity's IG is empty ───────────

test("buildReplenishJobInsert — empty resolved instagramUserId refuses (never mints an orphan ad set)", () => {
  const built = buildReplenishJobInsert({
    workspaceId: "ws-1",
    cohort: baseCohort(),
    action: {
      kind: "replenish",
      adCampaignId: "cmp-1",
      testMetaAdsetId: "6100000000001",
      adsetPerTest: false,
      dailyTestCeilingCents: 60_000,
      rationale: "test",
    },
    accountId: "act-1",
    publishIdentity: { pageId: SUPERFOODS_COMPANY_PAGE_ID, instagramUserId: "" }, // ← belt-and-suspenders
    videoId: "vid-1",
    adName: "test",
    destination: "https://x",
    headlines: ["h"],
    primaryTexts: ["p"],
    descriptions: [],
  });
  assert.equal(built.ok, false, "empty resolved IG must refuse — never enqueue a job that would 400 at Meta");
  if (!built.ok) {
    assert.equal(built.refusalKind, MISSING_CANONICAL_INSTAGRAM_IDENTITY_REASON);
    assert.equal(built.reason, MISSING_CANONICAL_INSTAGRAM_IDENTITY_REASON);
  }
});
