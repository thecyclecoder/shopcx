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
  codexCostOverride,
  discoverLimit,
  mapCcusageToSnapshots,
  validateMacReportPayload,
  type CcusageOutputLike,
  type UsageSnapshotsAdmin,
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
