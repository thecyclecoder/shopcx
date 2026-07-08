/**
 * Unit tests for the media-buyer arming gate — Phase 1 verification
 * (media-buyer-arming-gate). Pins each denial branch of the PURE
 * `evaluateMediaBuyerArmingPure` on fixture inputs so the guard predicates
 * are locked before the DB-touching runner assembles them.
 *
 * The named branches the spec calls out (§ Phase 1):
 *   1. insufficient_sample — reviewed shadow actions < MIN_REVIEWED_SHADOW_ACTIONS.
 *   2. low_agreement — concur rate below MIN_AGREEMENT_RATE.
 *   3. trust_no_snapshots — zero sensor-trust snapshots in the window.
 *   4. trust_streak_short — <MIN_CONSECUTIVE_GREEN_TRUST consecutive green snapshots.
 *   5. blended_cac_ltv_below_target — cacLtvRatio present but < target.
 *   6. blended_cac_ltv_unknown — cacLtvRatio null (no CAC / no LTV / no mapping).
 *
 * Plus the happy path (all three preconditions clear → allowed=true, reasons=[]).
 *
 * Run:
 *   npx tsx --test src/lib/media-buyer/arming-gate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMediaBuyerArmingPure,
  MIN_REVIEWED_SHADOW_ACTIONS,
  MIN_AGREEMENT_RATE,
  MIN_CONSECUTIVE_GREEN_TRUST,
  isoWeekLabel,
  upsertAuthorization,
  type ShadowReviewInput,
  type TrustSnapshotInput,
} from "./arming-gate";
import { DEFAULT_BLENDED_CAC_LTV_TARGET, type BlendedCacLtvResult } from "@/lib/blended-cac-ltv";

// ── Fixture builders ────────────────────────────────────────────────────────

function makeReviews(concurred: number, dissented: number, undecided: number): ShadowReviewInput[] {
  const rows: ShadowReviewInput[] = [];
  const now = new Date("2026-07-08T12:00:00Z").getTime();
  const push = (verdict: ShadowReviewInput["verdict"], i: number) =>
    rows.push({ verdict, reviewedAt: new Date(now - i * 3_600_000).toISOString() });
  for (let i = 0; i < concurred; i++) push("concur", i);
  for (let i = 0; i < dissented; i++) push("dissent", concurred + i);
  for (let i = 0; i < undecided; i++) push("undecided", concurred + dissented + i);
  return rows;
}

function makeGreenStreak(n: number, endDate = "2026-07-08"): TrustSnapshotInput[] {
  const rows: TrustSnapshotInput[] = [];
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  for (let i = 0; i < n; i++) {
    rows.push({ snapshotDate: new Date(end - i * 86_400_000).toISOString().slice(0, 10), band: "green" });
  }
  return rows;
}

function makeBrokenStreak(): TrustSnapshotInput[] {
  // The latest snapshot is green, then a yellow breaks the streak at position 3.
  const end = new Date("2026-07-08T00:00:00Z").getTime();
  return [
    { snapshotDate: new Date(end - 0 * 86_400_000).toISOString().slice(0, 10), band: "green" },
    { snapshotDate: new Date(end - 1 * 86_400_000).toISOString().slice(0, 10), band: "green" },
    { snapshotDate: new Date(end - 2 * 86_400_000).toISOString().slice(0, 10), band: "green" },
    { snapshotDate: new Date(end - 3 * 86_400_000).toISOString().slice(0, 10), band: "yellow" },
    { snapshotDate: new Date(end - 4 * 86_400_000).toISOString().slice(0, 10), band: "green" },
    { snapshotDate: new Date(end - 5 * 86_400_000).toISOString().slice(0, 10), band: "green" },
    { snapshotDate: new Date(end - 6 * 86_400_000).toISOString().slice(0, 10), band: "green" },
    { snapshotDate: new Date(end - 7 * 86_400_000).toISOString().slice(0, 10), band: "green" },
  ];
}

function makeBlended(overrides: Partial<BlendedCacLtvResult> = {}): BlendedCacLtvResult {
  return {
    cacLtvRatio: DEFAULT_BLENDED_CAC_LTV_TARGET, // exactly at the floor → allowed
    paybackDays: 90,
    blendedSpendCents: 100000,
    blendedNewCustomers: 50,
    blendedRevenueCents: 500000,
    blendedLtvCents: 600000,
    assumptions: {
      marginRoasBlockedOnCogs: true,
      ltvProxyUncalibrated: true,
      creditAmazonHalo: true,
      countAllNonRenewal: true,
      paybackUsesWindowRateExtrapolation: true,
      targetCacLtv: DEFAULT_BLENDED_CAC_LTV_TARGET,
      targetPaybackDays: null,
    },
    flags: [],
    ...overrides,
  };
}

// ── Happy path ──────────────────────────────────────────────────────────────

test("evaluateMediaBuyerArmingPure — all three preconditions clear → allowed=true", () => {
  const reviews = makeReviews(24, 1, 0); // 25 reviewed, 24 concur ≥ 0.8 rate
  const trust = makeGreenStreak(MIN_CONSECUTIVE_GREEN_TRUST + 1);
  const blended = makeBlended({ cacLtvRatio: 3.5 });

  const r = evaluateMediaBuyerArmingPure({ shadowReviews: reviews, trustSnapshots: trust, blended });

  assert.equal(r.allowed, true);
  assert.equal(r.reasons.length, 0);
  assert.equal(r.metrics.reviewed, 25);
  assert.equal(r.metrics.concurred, 24);
  assert.equal(r.metrics.consecutiveGreen, MIN_CONSECUTIVE_GREEN_TRUST + 1);
  assert.equal(r.metrics.cacLtvRatio, 3.5);
});

// ── Deny branch 1: insufficient_sample ──────────────────────────────────────

test("evaluateMediaBuyerArmingPure — fewer than MIN_REVIEWED_SHADOW_ACTIONS reviews → insufficient_sample", () => {
  const reviews = makeReviews(4, 1, 0); // only 5 reviewed
  const trust = makeGreenStreak(MIN_CONSECUTIVE_GREEN_TRUST + 1);
  const blended = makeBlended({ cacLtvRatio: 3.5 });

  const r = evaluateMediaBuyerArmingPure({ shadowReviews: reviews, trustSnapshots: trust, blended });

  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("insufficient_sample"), `expected insufficient_sample, got ${codes.join(",")}`);
  assert.equal(r.metrics.reviewed, 5);
});

// ── Deny branch 2: low_agreement ────────────────────────────────────────────

test("evaluateMediaBuyerArmingPure — concur rate below MIN_AGREEMENT_RATE → low_agreement", () => {
  // 25 reviewed, 15 concur → 60% — under the 80% floor.
  const reviews = makeReviews(15, 8, 2);
  const trust = makeGreenStreak(MIN_CONSECUTIVE_GREEN_TRUST + 1);
  const blended = makeBlended({ cacLtvRatio: 3.5 });

  const r = evaluateMediaBuyerArmingPure({ shadowReviews: reviews, trustSnapshots: trust, blended });

  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("low_agreement"), `expected low_agreement, got ${codes.join(",")}`);
  assert.ok(r.metrics.agreementRate !== null && r.metrics.agreementRate < MIN_AGREEMENT_RATE);
});

// ── Deny branch 3: trust_no_snapshots ───────────────────────────────────────

test("evaluateMediaBuyerArmingPure — zero sensor-trust snapshots → trust_no_snapshots", () => {
  const reviews = makeReviews(24, 1, 0);
  const trust: TrustSnapshotInput[] = [];
  const blended = makeBlended({ cacLtvRatio: 3.5 });

  const r = evaluateMediaBuyerArmingPure({ shadowReviews: reviews, trustSnapshots: trust, blended });

  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("trust_no_snapshots"), `expected trust_no_snapshots, got ${codes.join(",")}`);
  assert.equal(r.metrics.consecutiveGreen, 0);
});

// ── Deny branch 4: trust_streak_short ───────────────────────────────────────

test("evaluateMediaBuyerArmingPure — <MIN_CONSECUTIVE_GREEN_TRUST consecutive greens → trust_streak_short", () => {
  const reviews = makeReviews(24, 1, 0);
  const trust = makeBrokenStreak(); // only 3 consecutive green from the latest
  const blended = makeBlended({ cacLtvRatio: 3.5 });

  const r = evaluateMediaBuyerArmingPure({ shadowReviews: reviews, trustSnapshots: trust, blended });

  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("trust_streak_short"), `expected trust_streak_short, got ${codes.join(",")}`);
  assert.equal(r.metrics.consecutiveGreen, 3);
});

// ── Deny branch 5: blended_cac_ltv_below_target ─────────────────────────────

test("evaluateMediaBuyerArmingPure — blended CAC:LTV below target → blended_cac_ltv_below_target", () => {
  const reviews = makeReviews(24, 1, 0);
  const trust = makeGreenStreak(MIN_CONSECUTIVE_GREEN_TRUST + 1);
  const blended = makeBlended({ cacLtvRatio: 1.5 }); // below the 3× target

  const r = evaluateMediaBuyerArmingPure({ shadowReviews: reviews, trustSnapshots: trust, blended });

  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(
    codes.includes("blended_cac_ltv_below_target"),
    `expected blended_cac_ltv_below_target, got ${codes.join(",")}`,
  );
});

// ── Deny branch 6: blended_cac_ltv_unknown ──────────────────────────────────

test("evaluateMediaBuyerArmingPure — blended CAC:LTV null → blended_cac_ltv_unknown", () => {
  const reviews = makeReviews(24, 1, 0);
  const trust = makeGreenStreak(MIN_CONSECUTIVE_GREEN_TRUST + 1);
  const blended = makeBlended({ cacLtvRatio: null, flags: ["no new customers in window"] });

  const r = evaluateMediaBuyerArmingPure({ shadowReviews: reviews, trustSnapshots: trust, blended });

  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("blended_cac_ltv_unknown"), `expected blended_cac_ltv_unknown, got ${codes.join(",")}`);
});

// ── Multiple denials compose ────────────────────────────────────────────────

test("evaluateMediaBuyerArmingPure — multiple failing preconditions surface every reason", () => {
  const reviews = makeReviews(3, 1, 0); // insufficient_sample
  const trust: TrustSnapshotInput[] = []; // trust_no_snapshots
  const blended = makeBlended({ cacLtvRatio: null }); // blended_cac_ltv_unknown

  const r = evaluateMediaBuyerArmingPure({ shadowReviews: reviews, trustSnapshots: trust, blended });

  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code).sort();
  assert.deepEqual(codes, ["blended_cac_ltv_unknown", "insufficient_sample", "trust_no_snapshots"]);
});

// ── ISO week label ──────────────────────────────────────────────────────────

test("isoWeekLabel — 2026-07-08 lands in ISO week 28", () => {
  assert.equal(isoWeekLabel(new Date("2026-07-08T12:00:00Z")), "2026-W28");
});

test("isoWeekLabel — Monday 2026-01-05 is week 02", () => {
  assert.equal(isoWeekLabel(new Date("2026-01-05T00:00:00Z")), "2026-W02");
});

// ── upsertAuthorization: pins the Fix-2 select-then-write pattern ───────────
// The composite unique on media_buyer_arming_authorization is an EXPRESSION index
// (coalesce(meta_ad_account_id::text, '')), which Supabase-js's `.upsert(...,{onConflict})`
// can't target. Fix 2 replaced the shipped upsert with a manual select-then-write —
// these tests lock the branch structure so we don't regress back to a broken onConflict.

type Op = { kind: "select" | "insert" | "update"; table: string; filters: string[]; row?: unknown };

function buildMockAdmin(opts: {
  existingRow?: { id: string } | null;
  insertReturns?: Array<{ id: string }>;
  updateReturns?: Array<{ id: string }>;
}) {
  const ops: Op[] = [];
  const state = {
    existing: opts.existingRow ?? null,
    inserted: opts.insertReturns ?? [{ id: "arm_inserted" }],
    updated: opts.updateReturns ?? [{ id: "arm_updated" }],
  };
  const makeBuilder = (op: Op) => {
    const b: any = {
      eq(col: string, val: unknown) {
        op.filters.push(`eq:${col}=${String(val)}`);
        return b;
      },
      is(col: string, val: unknown) {
        op.filters.push(`is:${col}=${String(val)}`);
        return b;
      },
      select(_cols: string) {
        return b;
      },
      async maybeSingle() {
        if (op.kind === "select") return { data: state.existing, error: null };
        return { data: null, error: null };
      },
      then(resolve: (v: unknown) => unknown) {
        if (op.kind === "insert") return resolve({ data: state.inserted, error: null });
        if (op.kind === "update") return resolve({ data: state.updated, error: null });
        return resolve({ data: null, error: null });
      },
    };
    return b;
  };
  const admin: any = {
    from(table: string) {
      return {
        select(_cols: string) {
          const op: Op = { kind: "select", table, filters: [] };
          ops.push(op);
          return makeBuilder(op);
        },
        insert(row: unknown) {
          const op: Op = { kind: "insert", table, filters: [], row };
          ops.push(op);
          return makeBuilder(op);
        },
        update(row: unknown) {
          const op: Op = { kind: "update", table, filters: [], row };
          ops.push(op);
          return makeBuilder(op);
        },
      };
    },
  };
  return { admin, ops };
}

const CANON_ARGS = {
  workspaceId: "ws_1",
  isoWeek: "2026-W28",
  allowed: true,
  reasons: [] as import("./arming-gate").ArmingGateReason[],
  metrics: {
    reviewed: 25,
    concurred: 24,
    agreementRate: 0.96,
    consecutiveGreen: 8,
    cacLtvRatio: 3.5,
    targetCacLtv: DEFAULT_BLENDED_CAC_LTV_TARGET,
  },
  evaluatedAt: "2026-07-08T12:00:00Z",
  expiresAt: "2026-07-15T12:00:00Z",
};

test("upsertAuthorization — no existing row + non-null account → INSERT with .eq('meta_ad_account_id', <id>) on the SELECT", async () => {
  const { admin, ops } = buildMockAdmin({ existingRow: null });
  const id = await upsertAuthorization(admin, {
    ...CANON_ARGS,
    metaAdAccountId: "act_42",
  });
  assert.equal(id, "arm_inserted");
  // First op: SELECT with workspace + iso_week + eq on meta_ad_account_id.
  const select = ops[0];
  assert.equal(select.kind, "select");
  assert.equal(select.table, "media_buyer_arming_authorization");
  assert.ok(select.filters.includes("eq:workspace_id=ws_1"));
  assert.ok(select.filters.includes("eq:iso_week=2026-W28"));
  assert.ok(select.filters.includes("eq:meta_ad_account_id=act_42"));
  // Second op: INSERT (no update since existingRow=null).
  const insert = ops[1];
  assert.equal(insert.kind, "insert");
  assert.equal((insert.row as { meta_ad_account_id: string }).meta_ad_account_id, "act_42");
});

test("upsertAuthorization — no existing row + null account → INSERT with .is('meta_ad_account_id', null) on the SELECT", async () => {
  const { admin, ops } = buildMockAdmin({ existingRow: null });
  const id = await upsertAuthorization(admin, {
    ...CANON_ARGS,
    metaAdAccountId: null,
  });
  assert.equal(id, "arm_inserted");
  const select = ops[0];
  assert.equal(select.kind, "select");
  assert.ok(select.filters.includes("is:meta_ad_account_id=null"));
  assert.ok(!select.filters.some((f) => f.startsWith("eq:meta_ad_account_id")));
  assert.equal(ops[1].kind, "insert");
});

test("upsertAuthorization — existing row → UPDATE by id, workspace-scoped, .select('id') assertion", async () => {
  const { admin, ops } = buildMockAdmin({ existingRow: { id: "arm_existing" } });
  const id = await upsertAuthorization(admin, {
    ...CANON_ARGS,
    metaAdAccountId: "act_42",
  });
  assert.equal(id, "arm_existing");
  // Second op should be UPDATE (not INSERT), scoped by id + workspace_id.
  const update = ops[1];
  assert.equal(update.kind, "update");
  assert.ok(update.filters.includes("eq:id=arm_existing"), `filters were ${update.filters.join(",")}`);
  assert.ok(update.filters.includes("eq:workspace_id=ws_1"));
  // No INSERT op at all — regression guard against the old onConflict path.
  assert.ok(!ops.some((o) => o.kind === "insert"));
});
