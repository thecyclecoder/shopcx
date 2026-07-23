/**
 * Unit tests for the graduate-crowned-winners-into-scaler flow — pins each of
 * the four gates + the happy path's Meta call sequence.
 *
 * Run:
 *   npx tsx --test src/lib/media-buyer/graduate-scaler.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  describeArmingDenial,
  graduateCrownedWinnerToScaler,
  GRADUATE_SCALER_SPEC_SLUG,
  type CrownedWinnerInput,
  type GraduateMetaClient,
} from "./graduate-scaler";
import type { ColdScalerAuthorizationRow } from "./cold-scaler-arming-gate";

// ── Fake admin (in-memory) ───────────────────────────────────────────────────
// Wide enough to serve the three read paths this flow uses:
//   (a) media_buyer_cold_scaler_cohorts SELECT (via getEffectiveMediaBuyerColdScalerCohort)
//   (b) media_buyer_cold_scaler_arming_authorization SELECT (via readLatestColdScalerArmingAuthorization)
//   (c) director_activity INSERT (via recordDirectorActivity)

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface Filter { kind: "eq" | "is"; col: string; val: unknown }

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    if (f.kind === "eq" && row[f.col] !== f.val) return false;
    if (f.kind === "is" && row[f.col] !== null) return false;
  }
  return true;
}

interface AdminHandle {
  admin: Parameters<typeof graduateCrownedWinnerToScaler>[0];
  tables: Tables;
  directorInserts: Row[];
}

function makeAdmin(seed: Tables): AdminHandle {
  const tables: Tables = { ...seed };
  const directorInserts: Row[] = [];
  const admin = {
    from(table: string) {
      const filters: Filter[] = [];
      let orderCol: string | null = null;
      let orderAsc = true;
      let limitN: number | null = null;
      const chain: {
        select: (...args: unknown[]) => typeof chain;
        eq: (col: string, val: unknown) => typeof chain;
        is: (col: string, val: unknown) => typeof chain;
        order: (col: string, opts: { ascending?: boolean }) => typeof chain;
        limit: (n: number) => typeof chain;
        maybeSingle: () => Promise<{ data: Row | null; error: null }>;
        insert: (row: Row) => Promise<{ data: null; error: null }>;
        then: (onFulfilled: (v: { data: Row[]; error: null }) => unknown) => Promise<unknown>;
      } = {
        select: () => chain,
        eq: (col, val) => { filters.push({ kind: "eq", col, val }); return chain; },
        is: (col, val) => {
          if (val !== null) throw new Error("only .is(col, null) is stubbed");
          filters.push({ kind: "is", col, val: null });
          return chain;
        },
        order: (col, opts) => {
          orderCol = col;
          orderAsc = opts?.ascending !== false;
          return chain;
        },
        limit: (n) => { limitN = n; return chain; },
        maybeSingle: async () => {
          let rows = (tables[table] ?? []).filter((r) => matches(r, filters));
          if (orderCol) {
            const col = orderCol;
            rows = [...rows].sort((a, b) => {
              const va = String(a[col] ?? "");
              const vb = String(b[col] ?? "");
              return orderAsc ? (va < vb ? -1 : va > vb ? 1 : 0) : (va > vb ? -1 : va < vb ? 1 : 0);
            });
          }
          if (limitN != null) rows = rows.slice(0, limitN);
          return { data: rows[0] ?? null, error: null as null };
        },
        insert: async (row) => {
          if (table === "director_activity") directorInserts.push(row);
          (tables[table] ||= []).push(row);
          return { data: null, error: null as null };
        },
        then: (onFulfilled) => {
          const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
          return Promise.resolve({ data: rows, error: null as null }).then(onFulfilled);
        },
      };
      return chain;
    },
  } as unknown as Parameters<typeof graduateCrownedWinnerToScaler>[0];
  return { admin, tables, directorInserts };
}

// ── Meta client stub ─────────────────────────────────────────────────────────

interface MetaCall { kind: "listAds" | "createAdSet" | "createAd"; args: unknown }

function makeMetaClient(seed: {
  existingAds?: Array<{ adId: string; creativeId: string }>;
  newAdsetId?: string;
  newAdId?: string;
}): { client: GraduateMetaClient; calls: MetaCall[] } {
  const calls: MetaCall[] = [];
  const client: GraduateMetaClient = {
    async listAdsForCampaign(campaignId) {
      calls.push({ kind: "listAds", args: campaignId });
      return seed.existingAds ?? [];
    },
    async createAdSet(args) {
      calls.push({ kind: "createAdSet", args });
      return seed.newAdsetId ?? "adset-new-1";
    },
    async createAd(args) {
      calls.push({ kind: "createAd", args });
      return seed.newAdId ?? "ad-new-1";
    },
  };
  return { client, calls };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const WS = "ws-1";
const ACCT = "acct-A";
const ACT_ID = "act_1234567890";
const PRODUCT_A = "prod-A";
const COHORT_ID = "cohort-A";
const SCALER_CAMPAIGN_ID = "meta-campaign-scaler-1";
const NOW = new Date("2026-07-23T12:00:00.000Z");

function cohortRow(overrides: Row = {}): Row {
  return {
    id: COHORT_ID,
    workspace_id: WS,
    meta_ad_account_id: ACCT,
    product_id: PRODUCT_A,
    scaler_meta_campaign_id: SCALER_CAMPAIGN_ID,
    daily_scaler_ceiling_cents: 200000,
    is_active: true,
    notes: null,
    updated_by: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function armingRow(overrides: Row = {}): Row {
  return {
    id: "auth-1",
    workspace_id: WS,
    meta_ad_account_id: ACCT,
    cold_scaler_cohort_id: COHORT_ID,
    iso_week: "2026-W30",
    allowed: true,
    reasons: null,
    evaluated_at: "2026-07-22T00:00:00.000Z",
    expires_at: "2026-07-29T00:00:00.000Z",
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

const WINNER: CrownedWinnerInput = {
  metaAdId: "meta-ad-11111111",
  metaAdsetId: "meta-adset-11111111",
  metaCreativeId: "meta-creative-11111111",
  targeting: { age_min: 50, age_max: 65, genders: [2], geo_locations: { countries: ["US"] } },
  pixelId: "PX-999",
};

// ── describeArmingDenial (pure) ──────────────────────────────────────────────

test("describeArmingDenial — null authorization → 'no arming authorization row'", () => {
  const r = describeArmingDenial(null, NOW);
  assert.equal(r, "no arming authorization row for this cohort");
});

test("describeArmingDenial — allowed=false → refused w/ iso week", () => {
  const auth = armingRow({ allowed: false }) as unknown as ColdScalerAuthorizationRow;
  const r = describeArmingDenial(auth, NOW);
  assert.match(r ?? "", /arming refused .* 2026-W30/);
});

test("describeArmingDenial — expires_at in the past → 'expired at …'", () => {
  const auth = armingRow({ expires_at: "2026-07-01T00:00:00.000Z" }) as unknown as ColdScalerAuthorizationRow;
  const r = describeArmingDenial(auth, NOW);
  assert.match(r ?? "", /expired at 2026-07-01T00:00:00\.000Z/);
});

test("describeArmingDenial — allowed=true + future expires_at → null (cleared)", () => {
  const auth = armingRow() as unknown as ColdScalerAuthorizationRow;
  assert.equal(describeArmingDenial(auth, NOW), null);
});

// ── Gate 1 — no active cohort ────────────────────────────────────────────────

test("graduateCrownedWinnerToScaler — Gate 1: no active cohort → skip_no_cohort, no Meta call, records skip", async () => {
  const h = makeAdmin({
    media_buyer_cold_scaler_cohorts: [], // no rows
  });
  const { client, calls } = makeMetaClient({});
  const r = await graduateCrownedWinnerToScaler(h.admin, {
    workspaceId: WS,
    productId: PRODUCT_A,
    metaAdAccountId: ACCT,
    metaAccountActId: ACT_ID,
    winner: WINNER,
    now: NOW,
    metaClient: client,
  });
  assert.equal(r.outcome, "skip_no_cohort");
  assert.equal(r.cohortId, null);
  assert.equal(calls.length, 0, "no Meta calls fire when the cohort is absent");
  assert.equal(h.directorInserts.length, 1);
  assert.equal(h.directorInserts[0].action_kind, "cold_scaler_graduate_skipped");
  assert.equal(h.directorInserts[0].spec_slug, GRADUATE_SCALER_SPEC_SLUG);
  const meta = h.directorInserts[0].metadata as Row;
  assert.equal(meta.skip_reason, "no_cohort");
  assert.equal(meta.source_meta_ad_id, WINNER.metaAdId);
});

// ── Gate 2 — cohort exists but scaler_meta_campaign_id is null ───────────────

test("graduateCrownedWinnerToScaler — Gate 2: cohort has no scaler_meta_campaign_id → skip_no_campaign, no Meta call", async () => {
  const h = makeAdmin({
    media_buyer_cold_scaler_cohorts: [cohortRow({ scaler_meta_campaign_id: null })],
  });
  const { client, calls } = makeMetaClient({});
  const r = await graduateCrownedWinnerToScaler(h.admin, {
    workspaceId: WS,
    productId: PRODUCT_A,
    metaAdAccountId: ACCT,
    metaAccountActId: ACT_ID,
    winner: WINNER,
    now: NOW,
    metaClient: client,
  });
  assert.equal(r.outcome, "skip_no_campaign");
  assert.equal(r.cohortId, COHORT_ID);
  assert.equal(r.scalerCampaignId, null);
  assert.equal(calls.length, 0);
  const meta = h.directorInserts[0].metadata as Row;
  assert.equal(meta.skip_reason, "no_campaign");
});

// ── Gate 3 — arming denials ──────────────────────────────────────────────────

test("graduateCrownedWinnerToScaler — Gate 3: no arming row → skip_not_armed (fail-closed on missing auth)", async () => {
  const h = makeAdmin({
    media_buyer_cold_scaler_cohorts: [cohortRow()],
    media_buyer_cold_scaler_arming_authorization: [], // no auth row
  });
  const { client, calls } = makeMetaClient({});
  const r = await graduateCrownedWinnerToScaler(h.admin, {
    workspaceId: WS,
    productId: PRODUCT_A,
    metaAdAccountId: ACCT,
    metaAccountActId: ACT_ID,
    winner: WINNER,
    now: NOW,
    metaClient: client,
  });
  assert.equal(r.outcome, "skip_not_armed");
  assert.equal(calls.length, 0);
  const meta = h.directorInserts[0].metadata as Row;
  assert.equal(meta.skip_reason, "not_armed");
});

test("graduateCrownedWinnerToScaler — Gate 3: arming allowed=false → skip_not_armed", async () => {
  const h = makeAdmin({
    media_buyer_cold_scaler_cohorts: [cohortRow()],
    media_buyer_cold_scaler_arming_authorization: [armingRow({ allowed: false })],
  });
  const { client, calls } = makeMetaClient({});
  const r = await graduateCrownedWinnerToScaler(h.admin, {
    workspaceId: WS,
    productId: PRODUCT_A,
    metaAdAccountId: ACCT,
    metaAccountActId: ACT_ID,
    winner: WINNER,
    now: NOW,
    metaClient: client,
  });
  assert.equal(r.outcome, "skip_not_armed");
  assert.equal(calls.length, 0);
});

test("graduateCrownedWinnerToScaler — Gate 3: authorization expired → skip_not_armed", async () => {
  const h = makeAdmin({
    media_buyer_cold_scaler_cohorts: [cohortRow()],
    media_buyer_cold_scaler_arming_authorization: [armingRow({ expires_at: "2026-07-01T00:00:00.000Z" })],
  });
  const { client, calls } = makeMetaClient({});
  const r = await graduateCrownedWinnerToScaler(h.admin, {
    workspaceId: WS,
    productId: PRODUCT_A,
    metaAdAccountId: ACCT,
    metaAccountActId: ACT_ID,
    winner: WINNER,
    now: NOW,
    metaClient: client,
  });
  assert.equal(r.outcome, "skip_not_armed");
  assert.equal(calls.length, 0);
  const meta = h.directorInserts[0].metadata as Row;
  assert.equal(meta.arming_allowed, true, "the expired-but-allowed row is preserved in the audit metadata");
});

// ── Gate 4 — idempotency ─────────────────────────────────────────────────────

test("graduateCrownedWinnerToScaler — Gate 4: creative already published under scaler → skip_already_graduated (no double-mint)", async () => {
  const h = makeAdmin({
    media_buyer_cold_scaler_cohorts: [cohortRow()],
    media_buyer_cold_scaler_arming_authorization: [armingRow()],
  });
  const { client, calls } = makeMetaClient({
    existingAds: [{ adId: "prior-scaler-ad-1", creativeId: WINNER.metaCreativeId }],
  });
  const r = await graduateCrownedWinnerToScaler(h.admin, {
    workspaceId: WS,
    productId: PRODUCT_A,
    metaAdAccountId: ACCT,
    metaAccountActId: ACT_ID,
    winner: WINNER,
    now: NOW,
    metaClient: client,
  });
  assert.equal(r.outcome, "skip_already_graduated");
  assert.equal(r.scalerAdId, "prior-scaler-ad-1");
  // Only the listAds probe fires; createAdSet / createAd MUST NOT.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "listAds");
  const meta = h.directorInserts[0].metadata as Row;
  assert.equal(meta.skip_reason, "already_graduated");
  assert.equal(meta.existing_scaler_ad_id, "prior-scaler-ad-1");
});

// ── Happy path ───────────────────────────────────────────────────────────────

test("graduateCrownedWinnerToScaler — happy path: all four gates pass → duplicates via createAdSet + createAd, records graduation audit", async () => {
  const h = makeAdmin({
    media_buyer_cold_scaler_cohorts: [cohortRow()],
    media_buyer_cold_scaler_arming_authorization: [armingRow()],
  });
  const { client, calls } = makeMetaClient({
    existingAds: [{ adId: "unrelated-1", creativeId: "some-other-creative" }],
    newAdsetId: "meta-adset-new-42",
    newAdId: "meta-ad-new-42",
  });
  const r = await graduateCrownedWinnerToScaler(h.admin, {
    workspaceId: WS,
    productId: PRODUCT_A,
    metaAdAccountId: ACCT,
    metaAccountActId: ACT_ID,
    winner: WINNER,
    now: NOW,
    metaClient: client,
  });
  assert.equal(r.outcome, "graduated");
  assert.equal(r.cohortId, COHORT_ID);
  assert.equal(r.scalerCampaignId, SCALER_CAMPAIGN_ID);
  assert.equal(r.scalerAdsetId, "meta-adset-new-42");
  assert.equal(r.scalerAdId, "meta-ad-new-42");

  // Call sequence: listAds (idempotency probe) → createAdSet → createAd, in order.
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.kind), ["listAds", "createAdSet", "createAd"]);
  const createAdSetArgs = calls[1].args as {
    name: string; campaignId: string; pixelId: string; targeting: Record<string, unknown>;
  };
  assert.equal(createAdSetArgs.campaignId, SCALER_CAMPAIGN_ID);
  assert.equal(createAdSetArgs.pixelId, WINNER.pixelId);
  assert.deepEqual(createAdSetArgs.targeting, WINNER.targeting, "targeting is reused VERBATIM — no re-authoring");
  const createAdArgs = calls[2].args as { name: string; adsetId: string; creativeId: string };
  assert.equal(createAdArgs.adsetId, "meta-adset-new-42");
  assert.equal(createAdArgs.creativeId, WINNER.metaCreativeId, "creative is reused VERBATIM (not a fresh mint)");

  // Audit row on the graduate side.
  assert.equal(h.directorInserts.length, 1);
  assert.equal(h.directorInserts[0].action_kind, "cold_scaler_graduated");
  const meta = h.directorInserts[0].metadata as Row;
  assert.equal(meta.cohort_id, COHORT_ID);
  assert.equal(meta.scaler_campaign_id, SCALER_CAMPAIGN_ID);
  assert.equal(meta.scaler_adset_id, "meta-adset-new-42");
  assert.equal(meta.scaler_ad_id, "meta-ad-new-42");
  assert.equal(meta.source_meta_ad_id, WINNER.metaAdId);
  assert.equal(meta.source_meta_creative_id, WINNER.metaCreativeId);
  assert.equal(meta.daily_scaler_ceiling_cents, 200000);
});
