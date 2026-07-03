/**
 * Unit tests for the Phase-1 deterministic pieces of usage-snapshots:
 *   • codexCostOverride — the pure mapping meterAgentJob uses to record a
 *     Codex turn.completed with account='codex' + apiBilled=false;
 *   • discoverLimit — the running MAX(tokens_at_wall) over usage_wall_events,
 *     Claude-only; Codex returns null (its real limit is /status %).
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

function fakeAdminWithWallEvents(rows: Array<{ account: string; window: "5h" | "weekly"; runtime: "claude" | "codex"; tokens_at_wall: number }>): UsageSnapshotsAdmin {
  return {
    from(table: string) {
      assert.equal(table, "usage_wall_events");
      let filter: Record<string, string | number> = {};
      const q = {
        select(_cols: string) {
          return {
            eq(col: string, val: string | number) {
              filter[col] = val;
              return {
                async eq(col2: string, val2: string | number) {
                  filter[col2] = val2;
                  const data = rows
                    .filter((r) => r.account === filter.account && r.window === filter.window)
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
    { account: "Round Robin 2", window: "5h", runtime: "claude", tokens_at_wall: 1_500_000 },
    { account: "Round Robin 2", window: "5h", runtime: "claude", tokens_at_wall: 2_100_000 }, // ← max
    { account: "Round Robin 2", window: "5h", runtime: "claude", tokens_at_wall: 900_000 },
    { account: "Round Robin 2", window: "weekly", runtime: "claude", tokens_at_wall: 9_999_999 }, // different window — ignored
    { account: "Round Robin 3", window: "5h", runtime: "claude", tokens_at_wall: 5_000_000 }, // different account — ignored
  ]);
  const r = await discoverLimit("Round Robin 2", "5h", admin);
  assert.equal(r.limit, 2_100_000);
  assert.equal(r.wallCount, 3);
});

test("discoverLimit: Codex account → limit is null (real limit lives in /status %); wallCount still reports the sampled walls", async () => {
  const admin = fakeAdminWithWallEvents([
    { account: "codex", window: "5h", runtime: "codex", tokens_at_wall: 800_000 },
    { account: "codex", window: "5h", runtime: "codex", tokens_at_wall: 1_400_000 },
  ]);
  const r = await discoverLimit("codex", "5h", admin);
  assert.equal(r.limit, null);
  assert.equal(r.wallCount, 2);
});

test("discoverLimit: weekly window is scoped independently of the 5h window (each has its own MAX)", async () => {
  const admin = fakeAdminWithWallEvents([
    { account: "Round Robin 1", window: "5h", runtime: "claude", tokens_at_wall: 500_000 },
    { account: "Round Robin 1", window: "weekly", runtime: "claude", tokens_at_wall: 12_000_000 },
    { account: "Round Robin 1", window: "weekly", runtime: "claude", tokens_at_wall: 15_500_000 },
  ]);
  const five = await discoverLimit("Round Robin 1", "5h", admin);
  const weekly = await discoverLimit("Round Robin 1", "weekly", admin);
  assert.equal(five.limit, 500_000);
  assert.equal(five.wallCount, 1);
  assert.equal(weekly.limit, 15_500_000);
  assert.equal(weekly.wallCount, 2);
});
