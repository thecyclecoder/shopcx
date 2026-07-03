/**
 * Unit tests for the deterministic pieces of usage-snapshots:
 *   Phase 1 — codexCostOverride + discoverLimit.
 *   Phase 2 — validateMacReportPayload + mapCcusageToSnapshots (the
 *     Mac reporter's payload gate and the ccusage→payload mapper).
 *
 * Built-in node:test — run:
 *   npm run test:usage-snapshots
 *   (= tsx --test src/lib/usage-snapshots.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildUsageCockpit,
  codexCostOverride,
  discoverLimit,
  mapCcusageToSnapshots,
  validateMacReportPayload,
  type AccountUsageSnapshotRow,
  type CcusageOutputLike,
  type CockpitApiPanel,
  type DepartmentBudgetInput,
  type FleetFunctionBucket,
  type UsageSnapshotsAdmin,
  type WallCounts,
} from "./usage-snapshots";

// ── codexCostOverride ─────────────────────────────────────────────────────────

test("codexCostOverride: a Codex model → account='codex', configDir=null, apiBilled=false", () => {
  const overlay = codexCostOverride("codex/gpt-5-codex");
  assert.ok(overlay, "overlay should be present for a codex/* model");
  assert.equal(overlay!.account, "codex");
  assert.equal(overlay!.configDir, null);
  assert.equal(overlay!.apiBilled, false);
});

test("codexCostOverride: a Claude model → null (caller keeps Round-Robin defaults)", () => {
  assert.equal(codexCostOverride("claude-opus-4-7"), null);
  assert.equal(codexCostOverride("claude-sonnet-4-6"), null);
});

test("codexCostOverride: a null/undefined/empty model → null (no overlay)", () => {
  assert.equal(codexCostOverride(null), null);
  assert.equal(codexCostOverride(undefined), null);
  assert.equal(codexCostOverride(""), null);
});

// The spec's Codex-turn contract: meterAgentJob composes the recordAgentJobCost
// params by applying the overlay when non-null. Simulate that composition here
// to prove the end shape (account='codex', apiBilled=false) is what would land
// on the row, regardless of the Claude config-dir the wrapper picked.
test("codexCostOverride: composed recordAgentJobCost params for a Codex turn.completed carry account='codex' + apiBilled=false", () => {
  const configDir = "/home/builder/.claude-fourth"; // Round Robin 4 — irrelevant on a Codex turn
  const model = "codex/gpt-5-codex";
  const overlay = codexCostOverride(model);
  const params = {
    account: overlay ? overlay.account : configDir ? "Round Robin 4" : null,
    configDir: overlay ? overlay.configDir : configDir,
    apiBilled: overlay ? overlay.apiBilled : false,
  };
  assert.equal(params.account, "codex");
  assert.equal(params.configDir, null);
  assert.equal(params.apiBilled, false);
});

// ── discoverLimit ─────────────────────────────────────────────────────────────

function fakeAdminWithWallEvents(rows: Array<{ account: string; window_kind: "5h" | "weekly"; runtime: "claude" | "codex"; tokens_at_wall: number }>): UsageSnapshotsAdmin {
  return {
    from(table: string) {
      assert.equal(table, "usage_wall_events");
      const filter: Record<string, string | number> = {};
      const q = {
        select(_cols: string) {
          return {
            eq(col: string, val: string | number) {
              filter[col] = val;
              return {
                async eq(col2: string, val2: string | number) {
                  filter[col2] = val2;
                  const data = rows
                    .filter((r) => r.account === filter.account && r.window_kind === filter.window_kind)
                    .map((r) => ({ tokens_at_wall: r.tokens_at_wall, runtime: r.runtime }));
                  return { data, error: null };
                },
              };
            },
          };
        },
      };
      return q;
    },
  };
}

test("discoverLimit: no walls sampled → { limit: null, wallCount: 0 } ('learning…')", async () => {
  const admin = fakeAdminWithWallEvents([]);
  const r = await discoverLimit("Round Robin 1", "5h", admin);
  assert.deepEqual(r, { limit: null, wallCount: 0 });
});

test("discoverLimit: Claude account → MAX(tokens_at_wall) over the seeded walls (tightens toward true limit)", async () => {
  const admin = fakeAdminWithWallEvents([
    { account: "Round Robin 2", window_kind: "5h", runtime: "claude", tokens_at_wall: 1_500_000 },
    { account: "Round Robin 2", window_kind: "5h", runtime: "claude", tokens_at_wall: 2_100_000 }, // ← max
    { account: "Round Robin 2", window_kind: "5h", runtime: "claude", tokens_at_wall: 900_000 },
    { account: "Round Robin 2", window_kind: "weekly", runtime: "claude", tokens_at_wall: 9_999_999 }, // different window — ignored
    { account: "Round Robin 3", window_kind: "5h", runtime: "claude", tokens_at_wall: 5_000_000 }, // different account — ignored
  ]);
  const r = await discoverLimit("Round Robin 2", "5h", admin);
  assert.equal(r.limit, 2_100_000);
  assert.equal(r.wallCount, 3);
});

test("discoverLimit: Codex account → limit is null (real limit lives in /status %); wallCount still reports the sampled walls", async () => {
  const admin = fakeAdminWithWallEvents([
    { account: "codex", window_kind: "5h", runtime: "codex", tokens_at_wall: 800_000 },
    { account: "codex", window_kind: "5h", runtime: "codex", tokens_at_wall: 1_400_000 },
  ]);
  const r = await discoverLimit("codex", "5h", admin);
  assert.equal(r.limit, null);
  assert.equal(r.wallCount, 2);
});

test("discoverLimit: weekly window is scoped independently of the 5h window (each has its own MAX)", async () => {
  const admin = fakeAdminWithWallEvents([
    { account: "Round Robin 1", window_kind: "5h", runtime: "claude", tokens_at_wall: 500_000 },
    { account: "Round Robin 1", window_kind: "weekly", runtime: "claude", tokens_at_wall: 12_000_000 },
    { account: "Round Robin 1", window_kind: "weekly", runtime: "claude", tokens_at_wall: 15_500_000 },
  ]);
  const five = await discoverLimit("Round Robin 1", "5h", admin);
  const weekly = await discoverLimit("Round Robin 1", "weekly", admin);
  assert.equal(five.limit, 500_000);
  assert.equal(five.wallCount, 1);
  assert.equal(weekly.limit, 15_500_000);
  assert.equal(weekly.wallCount, 2);
});

// ── Phase 2 — validateMacReportPayload ────────────────────────────────────────

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

function baseSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account: "Round Robin 1",
    runtime: "claude",
    window: "5h",
    input_tokens: 1000,
    output_tokens: 500,
    cache_creation_tokens: 100,
    cache_read_tokens: 2000,
    ...overrides,
  };
}

test("validateMacReportPayload: happy path → { ok, payload }", () => {
  const r = validateMacReportPayload({ workspace_id: WS, snapshots: [baseSnapshot(), baseSnapshot({ runtime: "codex", account: "codex", window: "weekly" })] });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.payload.workspace_id, WS);
    assert.equal(r.payload.snapshots.length, 2);
    assert.equal(r.payload.snapshots[0].account, "Round Robin 1");
    assert.equal(r.payload.snapshots[1].runtime, "codex");
  }
});

test("validateMacReportPayload: non-UUID workspace_id → 400 diagnosis", () => {
  const r = validateMacReportPayload({ workspace_id: "not-a-uuid", snapshots: [baseSnapshot()] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /workspace_id/);
});

test("validateMacReportPayload: empty snapshots array → 400 diagnosis", () => {
  const r = validateMacReportPayload({ workspace_id: WS, snapshots: [] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /snapshots/);
});

test("validateMacReportPayload: invalid runtime → 400 diagnosis", () => {
  const r = validateMacReportPayload({ workspace_id: WS, snapshots: [baseSnapshot({ runtime: "gpt" })] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /runtime/);
});

test("validateMacReportPayload: invalid window → 400 diagnosis", () => {
  const r = validateMacReportPayload({ workspace_id: WS, snapshots: [baseSnapshot({ window: "daily" })] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /window/);
});

test("validateMacReportPayload: negative token counter → 400 diagnosis", () => {
  const r = validateMacReportPayload({ workspace_id: WS, snapshots: [baseSnapshot({ input_tokens: -5 })] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /token counter/);
});

test("validateMacReportPayload: missing body → 400 diagnosis", () => {
  const r = validateMacReportPayload(null);
  assert.equal(r.ok, false);
});

// ── Phase 2 — mapCcusageToSnapshots ──────────────────────────────────────────

// A snapshot in AST time — 2026-08-14T10:00:00Z. Deterministic `now` so weekly
// windowing is stable across CI clocks.
const NOW_MS = Date.parse("2026-08-14T10:00:00.000Z");
const FIVE_H_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

test("mapCcusageToSnapshots: always emits exactly one 5h + one weekly row per call (contract Phase-1's rollup asserts)", () => {
  const [five, weekly] = mapCcusageToSnapshots({ blocks: [] }, { account: "Round Robin 1", runtime: "claude", now: NOW_MS });
  assert.equal(five.window, "5h");
  assert.equal(weekly.window, "weekly");
  assert.equal(five.account, "Round Robin 1");
  assert.equal(weekly.account, "Round Robin 1");
  assert.equal(five.input_tokens, 0);
  assert.equal(weekly.input_tokens, 0);
});

test("mapCcusageToSnapshots: 5h picks the ACTIVE block; weekly SUMS all real blocks in the trailing 7 days", () => {
  const ccu: CcusageOutputLike = {
    blocks: [
      // 10d ago — outside the weekly window, ignored
      { startTime: new Date(NOW_MS - 10 * DAY_MS).toISOString(), endTime: new Date(NOW_MS - 10 * DAY_MS + FIVE_H_MS).toISOString(), tokenCounts: { inputTokens: 999, outputTokens: 999 } },
      // 3d ago — inside weekly
      { startTime: new Date(NOW_MS - 3 * DAY_MS).toISOString(), endTime: new Date(NOW_MS - 3 * DAY_MS + FIVE_H_MS).toISOString(), tokenCounts: { inputTokens: 100, outputTokens: 200, cacheCreationInputTokens: 10, cacheReadInputTokens: 400 } },
      // 1d ago — inside weekly
      { startTime: new Date(NOW_MS - DAY_MS).toISOString(), endTime: new Date(NOW_MS - DAY_MS + FIVE_H_MS).toISOString(), tokenCounts: { inputTokens: 50, outputTokens: 60, cacheCreationInputTokens: 5, cacheReadInputTokens: 100 } },
      // active block
      { startTime: new Date(NOW_MS - 2 * 60 * 60 * 1000).toISOString(), endTime: new Date(NOW_MS + 3 * 60 * 60 * 1000).toISOString(), isActive: true, tokenCounts: { inputTokens: 1000, outputTokens: 2000, cacheCreationInputTokens: 100, cacheReadInputTokens: 3000 } },
      // projection — must be skipped
      { startTime: new Date(NOW_MS + 60 * 60 * 1000).toISOString(), endTime: new Date(NOW_MS + 5 * 60 * 60 * 1000).toISOString(), projection: {}, tokenCounts: { inputTokens: 9999 } },
      // gap — must be skipped
      { isGap: true, startTime: new Date(NOW_MS - 5 * DAY_MS).toISOString(), tokenCounts: { inputTokens: 8888 } },
    ],
  };
  const [five, weekly] = mapCcusageToSnapshots(ccu, { account: "Round Robin 1", runtime: "claude", now: NOW_MS });
  // Active block totals
  assert.equal(five.input_tokens, 1000);
  assert.equal(five.output_tokens, 2000);
  assert.equal(five.cache_creation_tokens, 100);
  assert.equal(five.cache_read_tokens, 3000);
  // Weekly totals (3d + 1d + active — 10d filtered out; projection + gap skipped)
  assert.equal(weekly.input_tokens, 100 + 50 + 1000);
  assert.equal(weekly.output_tokens, 200 + 60 + 2000);
  assert.equal(weekly.cache_creation_tokens, 10 + 5 + 100);
  assert.equal(weekly.cache_read_tokens, 400 + 100 + 3000);
});

test("mapCcusageToSnapshots: no active block → 5h falls back to the most recent real block", () => {
  const ccu: CcusageOutputLike = {
    blocks: [
      { startTime: new Date(NOW_MS - 3 * DAY_MS).toISOString(), endTime: new Date(NOW_MS - 3 * DAY_MS + FIVE_H_MS).toISOString(), tokenCounts: { inputTokens: 100, outputTokens: 200 } },
      { startTime: new Date(NOW_MS - DAY_MS).toISOString(), endTime: new Date(NOW_MS - DAY_MS + FIVE_H_MS).toISOString(), tokenCounts: { inputTokens: 555, outputTokens: 777 } },
    ],
  };
  const [five] = mapCcusageToSnapshots(ccu, { account: "Round Robin 1", runtime: "claude", now: NOW_MS });
  assert.equal(five.input_tokens, 555);
  assert.equal(five.output_tokens, 777);
});

test("mapCcusageToSnapshots: null / missing input → zeroed 5h + weekly per account (never throws)", () => {
  const [fiveA, weeklyA] = mapCcusageToSnapshots(null, { account: "codex", runtime: "codex", now: NOW_MS });
  assert.equal(fiveA.window, "5h");
  assert.equal(weeklyA.window, "weekly");
  assert.equal(fiveA.input_tokens, 0);
  assert.equal(weeklyA.input_tokens, 0);
  assert.equal(fiveA.account, "codex");
  assert.equal(fiveA.runtime, "codex");

  const [fiveB, weeklyB] = mapCcusageToSnapshots(undefined, { account: "Round Robin 2", runtime: "claude", now: NOW_MS });
  assert.equal(fiveB.input_tokens, 0);
  assert.equal(weeklyB.input_tokens, 0);
});

test("mapCcusageToSnapshots: accepts flat inputTokens (not just tokenCounts) — schema drift tolerance", () => {
  const ccu: CcusageOutputLike = {
    blocks: [{ startTime: new Date(NOW_MS - 60 * 60 * 1000).toISOString(), endTime: new Date(NOW_MS + 60 * 60 * 1000).toISOString(), isActive: true, inputTokens: 42, outputTokens: 84 }],
  };
  const [five] = mapCcusageToSnapshots(ccu, { account: "Round Robin 3", runtime: "claude", now: NOW_MS });
  assert.equal(five.input_tokens, 42);
  assert.equal(five.output_tokens, 84);
});

// ── Phase 3 — buildUsageCockpit ──────────────────────────────────────────────

const EMPTY_WALLS: WallCounts = { fiveH: { limit: null, wallCount: 0 }, weekly: { limit: null, wallCount: 0 } };
function emptyApiPanel(): CockpitApiPanel {
  return {
    window_days: 7,
    total_cost_cents: 0,
    total_tokens: 0,
    cache: { raw_input_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, output_tokens: 0, read_ratio_pct: 0 },
    by_model: [],
    by_purpose: [],
  };
}

test("buildUsageCockpit: accounts[] SUM source='box' + source='mac' per (account, window) — the seeded pair sums correctly", () => {
  const snapshots: AccountUsageSnapshotRow[] = [
    { source: "box", runtime: "claude", account: "Round Robin 1", window_kind: "5h", input_tokens: 1000, output_tokens: 500, cache_creation_tokens: 100, cache_read_tokens: 2000 },
    { source: "mac", runtime: "claude", account: "Round Robin 1", window_kind: "5h", input_tokens: 200, output_tokens: 50, cache_creation_tokens: 10, cache_read_tokens: 500 },
    { source: "box", runtime: "claude", account: "Round Robin 1", window_kind: "weekly", input_tokens: 5000, output_tokens: 2500, cache_creation_tokens: 500, cache_read_tokens: 10000 },
    { source: "mac", runtime: "claude", account: "Round Robin 1", window_kind: "weekly", input_tokens: 100, output_tokens: 50, cache_creation_tokens: 10, cache_read_tokens: 200 },
  ];
  const cockpit = buildUsageCockpit({ snapshots, wallLimits: {}, functionBuckets: [], budgets: [], api: emptyApiPanel(), now: NOW_MS });
  const card = cockpit.accounts.find((a) => a.account === "Round Robin 1");
  assert.ok(card, "Round Robin 1 must always render");
  assert.equal(card!.windows.fiveH.input_tokens, 1200);
  assert.equal(card!.windows.fiveH.output_tokens, 550);
  assert.equal(card!.windows.fiveH.cache_creation_tokens, 110);
  assert.equal(card!.windows.fiveH.cache_read_tokens, 2500);
  assert.equal(card!.windows.fiveH.total_tokens, 1200 + 550 + 110 + 2500);
  assert.equal(card!.windows.weekly.total_tokens, 5100 + 2550 + 510 + 10200);
});

test("buildUsageCockpit: Claude with ≥1 sampled wall → status='discovered' with burn/limit %; 0 walls → status='learning' (no fabricated %)", () => {
  const snapshots: AccountUsageSnapshotRow[] = [
    { source: "box", runtime: "claude", account: "Round Robin 2", window_kind: "5h", input_tokens: 200_000, output_tokens: 300_000, cache_creation_tokens: 0, cache_read_tokens: 500_000 },
    { source: "box", runtime: "claude", account: "Round Robin 3", window_kind: "5h", input_tokens: 100_000, output_tokens: 100_000, cache_creation_tokens: 0, cache_read_tokens: 200_000 },
  ];
  const wallLimits: Record<string, WallCounts> = {
    "Round Robin 2": { fiveH: { limit: 2_000_000, wallCount: 3 }, weekly: { limit: null, wallCount: 0 } },
    // Round Robin 3 gets no wall entry — should degrade to 'learning'
  };
  const cockpit = buildUsageCockpit({ snapshots, wallLimits, functionBuckets: [], budgets: [], api: emptyApiPanel(), now: NOW_MS });
  const rr2 = cockpit.accounts.find((a) => a.account === "Round Robin 2")!;
  assert.equal(rr2.windows.fiveH.limit.status, "discovered");
  if (rr2.windows.fiveH.limit.status === "discovered") {
    assert.equal(rr2.windows.fiveH.limit.limit_tokens, 2_000_000);
    assert.equal(rr2.windows.fiveH.limit.wall_count, 3);
    // (200k + 300k + 0 + 500k) / 2M = 50%
    assert.equal(rr2.windows.fiveH.limit.burn_pct, 50);
  }
  const rr3 = cockpit.accounts.find((a) => a.account === "Round Robin 3")!;
  assert.equal(rr3.windows.fiveH.limit.status, "learning");
});

test("buildUsageCockpit: Codex uses the REPORTED limit_pct — NEVER discoverLimit (even if walls exist)", () => {
  const snapshots: AccountUsageSnapshotRow[] = [
    { source: "mac", runtime: "codex", account: "codex", window_kind: "5h", input_tokens: 100_000, output_tokens: 50_000, cache_creation_tokens: 0, cache_read_tokens: 100_000, limit_pct: 42 },
  ];
  const wallLimits: Record<string, WallCounts> = {
    codex: { fiveH: { limit: 999_999, wallCount: 2 }, weekly: { limit: null, wallCount: 0 } },
  };
  const cockpit = buildUsageCockpit({ snapshots, wallLimits, functionBuckets: [], budgets: [], api: emptyApiPanel(), now: NOW_MS });
  const codex = cockpit.accounts.find((a) => a.account === "codex")!;
  assert.equal(codex.runtime, "codex");
  assert.equal(codex.windows.fiveH.limit.status, "reported");
  if (codex.windows.fiveH.limit.status === "reported") {
    assert.equal(codex.windows.fiveH.limit.limit_pct, 42);
    assert.equal(codex.windows.fiveH.limit.wall_count, 2);
  }
});

test("buildUsageCockpit: departments[] carry tokens + $ + ceiling + breach flag from fleet_budgets/rollupFleetCost", () => {
  const functionBuckets: FleetFunctionBucket[] = [
    { key: "platform", input_tokens: 5_000_000, output_tokens: 3_000_000, cache_creation_tokens: 500_000, cache_read_tokens: 15_000_000, total_tokens: 23_500_000, usd_cents: 4200, subscription_only: false },
    { key: "cs", input_tokens: 1_000_000, output_tokens: 500_000, cache_creation_tokens: 100_000, cache_read_tokens: 2_000_000, total_tokens: 3_600_000, usd_cents: null, subscription_only: true },
  ];
  const budgets: DepartmentBudgetInput[] = [
    { ownerFunction: "platform", windowDays: 7, tokenCeiling: 20_000_000, usdCeilingCents: 5000 },
    { ownerFunction: "cs", windowDays: 7, tokenCeiling: 5_000_000, usdCeilingCents: null },
  ];
  const cockpit = buildUsageCockpit({ snapshots: [], wallLimits: {}, functionBuckets, budgets, api: emptyApiPanel(), now: NOW_MS });
  const platform = cockpit.departments.find((d) => d.owner_function === "platform")!;
  assert.equal(platform.total_tokens, 23_500_000);
  assert.equal(platform.usd_cents, 4200);
  assert.equal(platform.token_ceiling, 20_000_000);
  assert.equal(platform.usd_ceiling_cents, 5000);
  assert.equal(platform.breach, true, "tokens 23.5M > ceiling 20M ⇒ breach");
  assert.ok(platform.breach_reason && platform.breach_reason.includes("tokens"));

  const cs = cockpit.departments.find((d) => d.owner_function === "cs")!;
  assert.equal(cs.total_tokens, 3_600_000);
  assert.equal(cs.usd_cents, null);
  assert.equal(cs.subscription_only, true);
  assert.equal(cs.breach, false, "3.6M ≤ 5M ceiling ⇒ ok");
});

test("buildUsageCockpit: account cards NEVER carry a $ figure (two-currency honesty); api panel carries real $", () => {
  const snapshots: AccountUsageSnapshotRow[] = [
    { source: "box", runtime: "claude", account: "Round Robin 1", window_kind: "5h", input_tokens: 1000, output_tokens: 500, cache_creation_tokens: 0, cache_read_tokens: 2000 },
  ];
  const api: CockpitApiPanel = {
    window_days: 7,
    total_cost_cents: 12345,
    total_tokens: 999,
    cache: { raw_input_tokens: 100, cache_creation_tokens: 50, cache_read_tokens: 400, output_tokens: 449, read_ratio_pct: 73 },
    by_model: [{ model: "claude-sonnet-4-6", input_tokens: 100, output_tokens: 200, cache_creation_tokens: 50, cache_read_tokens: 400, total_tokens: 750, usd_cents: 12345, calls: 5 }],
    by_purpose: [{ purpose: "orchestrator-decision", input_tokens: 100, output_tokens: 200, cache_creation_tokens: 50, cache_read_tokens: 400, total_tokens: 750, usd_cents: 12345, calls: 5 }],
  };
  const cockpit = buildUsageCockpit({ snapshots, wallLimits: {}, functionBuckets: [], budgets: [], api, now: NOW_MS });
  const card = cockpit.accounts.find((a) => a.account === "Round Robin 1")!;
  // Account card has NO $ field of any kind — enumerate keys and assert.
  for (const w of [card.windows.fiveH, card.windows.weekly]) {
    for (const k of Object.keys(w)) {
      assert.ok(!/\$|cents|usd|cost/i.test(k), `account window carries a $-shaped field: ${k}`);
    }
  }
  assert.equal(cockpit.api.total_cost_cents, 12345);
  assert.equal(cockpit.api.by_model[0].usd_cents, 12345);
});

test("buildUsageCockpit: renders 5 account cards (4 Max + Codex) even when no snapshots exist yet", () => {
  const cockpit = buildUsageCockpit({ snapshots: [], wallLimits: {}, functionBuckets: [], budgets: [], api: emptyApiPanel(), now: NOW_MS });
  const labels = cockpit.accounts.map((a) => a.account);
  assert.deepEqual(labels, ["Round Robin 1", "Round Robin 2", "Round Robin 3", "Round Robin 4", "codex"]);
});
