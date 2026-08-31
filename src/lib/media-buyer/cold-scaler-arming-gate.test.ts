/**
 * Unit tests for the cold-scaler arming gate — Phase 2 verification
 * (bianca-cold-scaler-arming-gate-shadow-to-armed) with Precondition #1
 * rewritten by
 * [[../../../docs/brain/specs/cold-scaler-arming-decides-on-evidence-not-absence.md]]
 * Phase 3. Pins each denial branch of the PURE `evaluateColdScalerArmingPure`
 * on fixture inputs so the guard predicates are locked before the DB-touching
 * runner assembles them, plus one round-trip through
 * `readLatestColdScalerArmingAuthorization` against an in-memory admin fake.
 *
 * The named branches the spec calls out:
 *   1. insufficient_graded_scale_actions — <MIN_GRADED_SCALE_ACTIONS graded
 *      SCALE-vocabulary actions in the 14d window.
 *   2. scale_grade_below_bar — pass-rate (overall_grade>=7) below MIN_SCALE_PASS_RATE.
 *   3. trust_no_snapshots — zero sensor-trust snapshots in the window.
 *   4. trust_streak_short — <MIN_CONSECUTIVE_GREEN_TRUST consecutive green snapshots.
 *   5. cac_ltv_below_target — cacLtvRatio present but < target.
 *   6. cac_ltv_unknown — cacLtvRatio null (no CAC / no LTV / no mapping).
 *
 * Plus the happy path (all three preconditions clear → allowed=true, reasons=[])
 * AND the KILL-lift guard: a fixture of all-excellent `media_buyer_paused_loser`
 * grades with poor promote grades still denies — the pure gate must not let a
 * kill grade lift the scale verdict.
 *
 * Run:
 *   npx tsx --test src/lib/media-buyer/cold-scaler-arming-gate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateColdScalerArmingPure,
  readLatestColdScalerArmingAuthorization,
  isoWeekLabel,
  MIN_GRADED_SCALE_ACTIONS,
  MIN_SCALE_PASS_RATE,
  MIN_CONSECUTIVE_GREEN_TRUST,
  SCALE_GRADE_PASS_THRESHOLD,
  DEFAULT_COLD_SCALER_CAC_LTV_TARGET,
  type GradedScaleActionInput,
  type TrustSnapshotInput,
  type CacLtvInput,
  type ScaleActionKind,
} from "./cold-scaler-arming-gate";

// ── Fixture builders ────────────────────────────────────────────────────────

/**
 * Build `n` graded SCALE-vocabulary rows, of which `passing` clear the
 * 7/10 pass threshold. Alternates between the two SCALE kinds so the
 * fixture exercises both entries in `SCALE_ACTION_KINDS`.
 */
function makeGrades(n: number, passing: number, actionKind?: ScaleActionKind): GradedScaleActionInput[] {
  const now = new Date("2026-07-08T12:00:00Z").getTime();
  const rows: GradedScaleActionInput[] = [];
  const kinds: ScaleActionKind[] = actionKind
    ? [actionKind]
    : ["media_buyer_promoted_winner", "media_buyer_replenished_test_cohort"];
  for (let i = 0; i < n; i++) {
    rows.push({
      actionKind: kinds[i % kinds.length],
      overallGrade: i < passing ? SCALE_GRADE_PASS_THRESHOLD + 1 : SCALE_GRADE_PASS_THRESHOLD - 3,
      gradedAt: new Date(now - i * 3_600_000).toISOString(),
    });
  }
  return rows;
}

function makeGreenStreak(n: number, endDate = "2026-07-08"): TrustSnapshotInput[] {
  const rows: TrustSnapshotInput[] = [];
  const end = new Date(`${endDate}T00:00:00Z`).getTime();
  for (let i = 0; i < n; i++) {
    rows.push({
      snapshotDate: new Date(end - i * 86_400_000).toISOString().slice(0, 10),
      band: "green",
    });
  }
  return rows;
}

function makeBrokenStreak(): TrustSnapshotInput[] {
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

function cac(cacLtvRatio: number | null, opts: Partial<CacLtvInput> = {}): CacLtvInput {
  return {
    cacLtvRatio,
    target: opts.target ?? DEFAULT_COLD_SCALER_CAC_LTV_TARGET,
    unknownFlags: opts.unknownFlags,
  };
}

// ── Happy path ──────────────────────────────────────────────────────────────

test("evaluateColdScalerArmingPure — all three preconditions clear → allowed=true", () => {
  const grades = makeGrades(MIN_GRADED_SCALE_ACTIONS, MIN_GRADED_SCALE_ACTIONS); // 100% pass
  const trust = makeGreenStreak(MIN_CONSECUTIVE_GREEN_TRUST + 1);
  const r = evaluateColdScalerArmingPure({
    gradedScaleActions: grades,
    trustSnapshots: trust,
    cacLtv: cac(3.5),
  });
  assert.equal(r.allowed, true);
  assert.equal(r.reasons.length, 0);
  assert.equal(r.metrics.gradedScaleActionCount, MIN_GRADED_SCALE_ACTIONS);
  assert.equal(r.metrics.passingScaleActionCount, MIN_GRADED_SCALE_ACTIONS);
  assert.equal(r.metrics.scalePassRate, 1);
  assert.equal(r.metrics.consecutiveGreenCount, MIN_CONSECUTIVE_GREEN_TRUST + 1);
  assert.equal(r.metrics.cacLtvRatio, 3.5);
  assert.equal(r.metrics.target, DEFAULT_COLD_SCALER_CAC_LTV_TARGET);
});

// ── Deny branch 1: insufficient_graded_scale_actions ────────────────────────

test("evaluateColdScalerArmingPure — fewer than MIN_GRADED_SCALE_ACTIONS grades → insufficient_graded_scale_actions", () => {
  const r = evaluateColdScalerArmingPure({
    gradedScaleActions: makeGrades(4, 4),
    trustSnapshots: makeGreenStreak(MIN_CONSECUTIVE_GREEN_TRUST + 1),
    cacLtv: cac(3.5),
  });
  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(
    codes.includes("insufficient_graded_scale_actions"),
    `expected insufficient_graded_scale_actions, got ${codes.join(",")}`,
  );
  assert.equal(r.metrics.gradedScaleActionCount, 4);
});

// ── Deny branch 2: scale_grade_below_bar ────────────────────────────────────

test("evaluateColdScalerArmingPure — pass rate below MIN_SCALE_PASS_RATE → scale_grade_below_bar", () => {
  // 60% pass rate: 12 of 20 passing.
  const r = evaluateColdScalerArmingPure({
    gradedScaleActions: makeGrades(20, 12),
    trustSnapshots: makeGreenStreak(MIN_CONSECUTIVE_GREEN_TRUST + 1),
    cacLtv: cac(3.5),
  });
  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(
    codes.includes("scale_grade_below_bar"),
    `expected scale_grade_below_bar, got ${codes.join(",")}`,
  );
  assert.ok(r.metrics.scalePassRate !== null && r.metrics.scalePassRate < MIN_SCALE_PASS_RATE);
});

// ── Above the floor + above the bar → scale precondition clears ─────────────

test("evaluateColdScalerArmingPure — ≥ floor at/above the bar → scale branch clears", () => {
  // 90% pass rate at the sample floor.
  const r = evaluateColdScalerArmingPure({
    gradedScaleActions: makeGrades(20, 18),
    trustSnapshots: makeGreenStreak(MIN_CONSECUTIVE_GREEN_TRUST + 1),
    cacLtv: cac(3.5),
  });
  assert.equal(r.allowed, true);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(
    !codes.includes("insufficient_graded_scale_actions") && !codes.includes("scale_grade_below_bar"),
    `scale branch should have cleared, got ${codes.join(",")}`,
  );
});

// ── Deny branch 3: trust_no_snapshots ───────────────────────────────────────

test("evaluateColdScalerArmingPure — zero sensor-trust snapshots → trust_no_snapshots", () => {
  const r = evaluateColdScalerArmingPure({
    gradedScaleActions: makeGrades(MIN_GRADED_SCALE_ACTIONS, MIN_GRADED_SCALE_ACTIONS),
    trustSnapshots: [],
    cacLtv: cac(3.5),
  });
  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("trust_no_snapshots"), `expected trust_no_snapshots, got ${codes.join(",")}`);
  assert.equal(r.metrics.consecutiveGreenCount, 0);
});

// ── Deny branch 4: trust_streak_short ───────────────────────────────────────

test("evaluateColdScalerArmingPure — <MIN_CONSECUTIVE_GREEN_TRUST consecutive greens → trust_streak_short", () => {
  const r = evaluateColdScalerArmingPure({
    gradedScaleActions: makeGrades(MIN_GRADED_SCALE_ACTIONS, MIN_GRADED_SCALE_ACTIONS),
    trustSnapshots: makeBrokenStreak(),
    cacLtv: cac(3.5),
  });
  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("trust_streak_short"), `expected trust_streak_short, got ${codes.join(",")}`);
  assert.equal(r.metrics.consecutiveGreenCount, 3);
});

// ── Deny branch 5: cac_ltv_below_target ─────────────────────────────────────

test("evaluateColdScalerArmingPure — CAC:LTV below target → cac_ltv_below_target", () => {
  const r = evaluateColdScalerArmingPure({
    gradedScaleActions: makeGrades(MIN_GRADED_SCALE_ACTIONS, MIN_GRADED_SCALE_ACTIONS),
    trustSnapshots: makeGreenStreak(MIN_CONSECUTIVE_GREEN_TRUST + 1),
    cacLtv: cac(1.5),
  });
  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("cac_ltv_below_target"), `expected cac_ltv_below_target, got ${codes.join(",")}`);
});

// ── Deny branch 6: cac_ltv_unknown ──────────────────────────────────────────

test("evaluateColdScalerArmingPure — CAC:LTV null → cac_ltv_unknown", () => {
  const r = evaluateColdScalerArmingPure({
    gradedScaleActions: makeGrades(MIN_GRADED_SCALE_ACTIONS, MIN_GRADED_SCALE_ACTIONS),
    trustSnapshots: makeGreenStreak(MIN_CONSECUTIVE_GREEN_TRUST + 1),
    cacLtv: cac(null, { unknownFlags: ["no new customers in window"] }),
  });
  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes("cac_ltv_unknown"), `expected cac_ltv_unknown, got ${codes.join(",")}`);
});

// ── KILL-lift guard: a kill grade cannot lift the verdict ───────────────────

test("evaluateColdScalerArmingPure — all-excellent KILL grades with poor promote grades still denies", () => {
  // A caller that leaked KILL grades into `gradedScaleActions` must not be able
  // to inflate the pass rate — the pure gate re-filters to SCALE kinds, so a
  // fixture of 30 excellent `media_buyer_paused_loser` grades + 5 poor
  // `media_buyer_promoted_winner` grades reads as 5 scale grades below the
  // floor → `insufficient_graded_scale_actions`. Not `scale_grade_below_bar`
  // (that fires ONLY when the sample is large enough to trust the ratio), and
  // NEVER `allowed=true`. Bianca's 97%-sound kill skill cannot vouch for her
  // 36%-sound promote skill.
  const now = new Date("2026-07-08T12:00:00Z").getTime();
  const killGrades: GradedScaleActionInput[] = Array.from({ length: 30 }, (_, i) => ({
    // The type says ScaleActionKind, but the pure gate must defend against a
    // caller that leaked a KILL row in — cast to unknown then to the type so
    // we exercise the pure gate's own filter, not the DB loader's filter.
    actionKind: "media_buyer_paused_loser" as unknown as ScaleActionKind,
    overallGrade: 10,
    gradedAt: new Date(now - i * 3_600_000).toISOString(),
  }));
  const poorPromoteGrades = makeGrades(5, 0, "media_buyer_promoted_winner");
  const r = evaluateColdScalerArmingPure({
    gradedScaleActions: [...killGrades, ...poorPromoteGrades],
    trustSnapshots: makeGreenStreak(MIN_CONSECUTIVE_GREEN_TRUST + 1),
    cacLtv: cac(3.5),
  });
  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code);
  assert.ok(
    codes.includes("insufficient_graded_scale_actions"),
    `KILL grades must not count toward the SCALE sample; expected insufficient_graded_scale_actions, got ${codes.join(",")}`,
  );
  assert.equal(r.metrics.gradedScaleActionCount, 5);
  assert.equal(r.metrics.passingScaleActionCount, 0);
});

// ── Multiple denials compose ────────────────────────────────────────────────

test("evaluateColdScalerArmingPure — multiple failing preconditions surface every reason", () => {
  const r = evaluateColdScalerArmingPure({
    gradedScaleActions: makeGrades(3, 1),
    trustSnapshots: [],
    cacLtv: cac(null),
  });
  assert.equal(r.allowed, false);
  const codes = r.reasons.map((x) => x.code).sort();
  assert.deepEqual(codes, ["cac_ltv_unknown", "insufficient_graded_scale_actions", "trust_no_snapshots"]);
});

// ── ISO week label ──────────────────────────────────────────────────────────

test("isoWeekLabel — 2026-07-08 lands in ISO week 28", () => {
  assert.equal(isoWeekLabel(new Date("2026-07-08T12:00:00Z")), "2026-W28");
});

// ── readLatestColdScalerArmingAuthorization: round-trip against in-memory admin ─

type Op = { kind: "select" | "insert" | "update"; table: string; filters: string[] };

function buildMockAdmin(opts: { rows: Array<Record<string, unknown>> }) {
  const ops: Op[] = [];
  let selectedRows: Array<Record<string, unknown>> = [];
  let orderColumn: string | null = null;
  let ascending = true;
  let limitN: number | null = null;
  const makeBuilder = (op: Op) => {
    const b: any = {
      eq(col: string, val: unknown) {
        op.filters.push(`eq:${col}=${String(val)}`);
        selectedRows = selectedRows.filter((r) => r[col] === val);
        return b;
      },
      is(col: string, val: unknown) {
        op.filters.push(`is:${col}=${String(val)}`);
        selectedRows = selectedRows.filter((r) => (r[col] ?? null) === val);
        return b;
      },
      gte(col: string, val: unknown) {
        op.filters.push(`gte:${col}=${String(val)}`);
        selectedRows = selectedRows.filter((r) => (r[col] as string) >= (val as string));
        return b;
      },
      order(col: string, o: { ascending: boolean }) {
        orderColumn = col;
        ascending = o.ascending;
        return b;
      },
      limit(n: number) {
        limitN = n;
        return b;
      },
      select(_cols: string) {
        return b;
      },
      async maybeSingle() {
        if (orderColumn) {
          selectedRows = [...selectedRows].sort((a, b_) => {
            const av = String(a[orderColumn!]);
            const bv = String(b_[orderColumn!]);
            return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        if (limitN !== null) selectedRows = selectedRows.slice(0, limitN);
        const first = selectedRows[0] ?? null;
        return { data: first, error: null };
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
          selectedRows = [...opts.rows];
          orderColumn = null;
          ascending = true;
          limitN = null;
          return makeBuilder(op);
        },
      };
    },
  };
  return { admin, ops };
}

test("readLatestColdScalerArmingAuthorization — returns the newest matching row by evaluated_at DESC", async () => {
  const rows = [
    {
      id: "auth_older",
      workspace_id: "ws_1",
      meta_ad_account_id: "act_42",
      cold_scaler_cohort_id: "cohort_a",
      iso_week: "2026-W27",
      allowed: true,
      reasons: {},
      evaluated_at: "2026-07-01T12:00:00Z",
      expires_at: "2026-07-08T12:00:00Z",
      created_at: "2026-07-01T12:00:00Z",
      updated_at: "2026-07-01T12:00:00Z",
    },
    {
      id: "auth_newer",
      workspace_id: "ws_1",
      meta_ad_account_id: "act_42",
      cold_scaler_cohort_id: "cohort_a",
      iso_week: "2026-W28",
      allowed: false,
      reasons: { reasons: [{ code: "cac_ltv_below_target" }] },
      evaluated_at: "2026-07-08T12:00:00Z",
      expires_at: "2026-07-15T12:00:00Z",
      created_at: "2026-07-08T12:00:00Z",
      updated_at: "2026-07-08T12:00:00Z",
    },
    {
      // Different cohort — must be excluded by the scope filter.
      id: "auth_other_cohort",
      workspace_id: "ws_1",
      meta_ad_account_id: "act_42",
      cold_scaler_cohort_id: "cohort_z",
      iso_week: "2026-W28",
      allowed: true,
      reasons: {},
      evaluated_at: "2026-07-08T12:00:00Z",
      expires_at: "2026-07-15T12:00:00Z",
      created_at: "2026-07-08T12:00:00Z",
      updated_at: "2026-07-08T12:00:00Z",
    },
  ];
  const { admin, ops } = buildMockAdmin({ rows });
  const row = await readLatestColdScalerArmingAuthorization(admin, {
    workspaceId: "ws_1",
    metaAdAccountId: "act_42",
    coldScalerCohortId: "cohort_a",
  });
  assert.ok(row);
  assert.equal(row!.id, "auth_newer");
  assert.equal(row!.iso_week, "2026-W28");
  const select = ops[0];
  assert.equal(select.kind, "select");
  assert.equal(select.table, "media_buyer_cold_scaler_arming_authorization");
  assert.ok(select.filters.includes("eq:workspace_id=ws_1"));
  assert.ok(select.filters.includes("eq:cold_scaler_cohort_id=cohort_a"));
  assert.ok(select.filters.includes("eq:meta_ad_account_id=act_42"));
});

test("readLatestColdScalerArmingAuthorization — null account uses .is(meta_ad_account_id, null)", async () => {
  const { admin, ops } = buildMockAdmin({ rows: [] });
  const row = await readLatestColdScalerArmingAuthorization(admin, {
    workspaceId: "ws_1",
    metaAdAccountId: null,
    coldScalerCohortId: "cohort_a",
  });
  assert.equal(row, null);
  const select = ops[0];
  assert.ok(select.filters.includes("is:meta_ad_account_id=null"));
  assert.ok(!select.filters.some((f) => f.startsWith("eq:meta_ad_account_id")));
});

test("readLatestColdScalerArmingAuthorization — no row for the trio → null", async () => {
  const { admin } = buildMockAdmin({ rows: [] });
  const row = await readLatestColdScalerArmingAuthorization(admin, {
    workspaceId: "ws_missing",
    metaAdAccountId: "act_42",
    coldScalerCohortId: "cohort_missing",
  });
  assert.equal(row, null);
});
