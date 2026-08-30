/**
 * ads-supervisor rail-deferral-coverage tests
 * ([[./ads-supervisor]] `readRecentScaleRailDeferralsForAdsets`).
 *
 * Locks the coverage contract for the per-object cooldown rail (armed 2026-08-24 in
 * commit 6a9902a9e7): a `media_buyer_scale_rail_deferred` `director_activity` row within
 * the last `RAIL_DEFERRAL_LOOKBACK_MS` on the adset in question IS legitimate coverage
 * of the crown — Bianca DID evaluate the winner and chose to defer per policy, so the
 * supervisor MUST NOT fire a fresh `bianca_missed_crown` fix-spec every 3h while the
 * cooldown holds. Without this the supervisor's #director-growth-max digest floods with
 * false positives on every crowned adset that promoted in the previous 24h.
 *
 *   npx tsx --test src/lib/ads-supervisor.rail-defer-coverage.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  readRecentScaleRailDeferralsForAdsets,
  readRecentKillRailDeferralsForAdsets,
  RAIL_DEFERRAL_LOOKBACK_MS,
} from "./ads-supervisor";

type Row = {
  workspace_id: string;
  action_kind: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
};
interface FilterCapture {
  eqs: Array<{ col: string; val: unknown }>;
  gtes: Array<{ col: string; val: unknown }>;
  select: string;
  table: string;
}

/**
 * Fake Supabase client scoped to a single `.from(table).select(...).eq/gte()` read.
 * Captures every filter so we can PIN the query shape (action_kind, workspace scope,
 * created_at >= sinceIso) at the argv level — a stray edit that removes the
 * `action_kind='media_buyer_scale_rail_deferred'` filter would silently start counting
 * every director_activity row as coverage.
 */
function makeFakeAdmin(rows: Row[]) {
  const capture: FilterCapture = { eqs: [], gtes: [], select: "", table: "" };
  const chain: {
    select: (cols: string) => typeof chain;
    eq: (col: string, val: unknown) => typeof chain;
    gte: (col: string, val: unknown) => typeof chain;
    then: (onFulfilled: (v: { data: Row[]; error: null }) => unknown) => Promise<unknown>;
  } = {
    select(cols) { capture.select = cols; return chain; },
    eq(col, val) { capture.eqs.push({ col, val }); return chain; },
    gte(col, val) { capture.gtes.push({ col, val }); return chain; },
    then(onFulfilled) {
      const filtered = rows.filter((r) => {
        for (const f of capture.eqs) {
          const rv = (r as unknown as Record<string, unknown>)[f.col];
          if (rv !== f.val) return false;
        }
        for (const f of capture.gtes) {
          const rv = (r as unknown as Record<string, unknown>)[f.col];
          if (typeof rv !== "string" || typeof f.val !== "string") return false;
          if (rv < f.val) return false;
        }
        return true;
      });
      return Promise.resolve(onFulfilled({ data: filtered, error: null }));
    },
  };
  const admin = {
    from(table: string) {
      capture.table = table;
      return chain;
    },
  } as unknown as Parameters<typeof readRecentScaleRailDeferralsForAdsets>[0];
  return { admin, capture };
}

test("a recent scale_rail_deferred row on the adset counts as coverage; older-than-24h does NOT", async () => {
  const nowMs = Date.parse("2026-08-24T18:00:00Z");
  const withinIso = new Date(nowMs - 3 * 3600_000).toISOString(); // 3h ago
  const staleIso = new Date(nowMs - 26 * 3600_000).toISOString(); // 26h ago — outside cap
  const { admin, capture } = makeFakeAdmin([
    // fresh cooldown defer on the target adset — MUST count
    { workspace_id: "ws-1", action_kind: "media_buyer_scale_rail_deferred", created_at: withinIso, metadata: { target_object_id: "adset-crown-cooldown", rail: "per_object_cooldown" } },
    // stale defer — the .gte("created_at", sinceIso) filter drops it
    { workspace_id: "ws-1", action_kind: "media_buyer_scale_rail_deferred", created_at: staleIso, metadata: { target_object_id: "adset-crown-stale", rail: "per_object_cooldown" } },
    // fresh defer on a DIFFERENT workspace — the .eq("workspace_id",…) filter drops it
    { workspace_id: "ws-other", action_kind: "media_buyer_scale_rail_deferred", created_at: withinIso, metadata: { target_object_id: "adset-crown-cooldown", rail: "per_object_cooldown" } },
    // wrong action_kind — the .eq("action_kind",…) filter drops it
    { workspace_id: "ws-1", action_kind: "media_buyer_promoted_winner", created_at: withinIso, metadata: { target_object_id: "adset-crown-cooldown" } },
  ]);
  const deferred = await readRecentScaleRailDeferralsForAdsets(
    admin,
    "ws-1",
    ["adset-crown-cooldown", "adset-crown-stale"],
    nowMs,
  );

  // Argv pin — the filters that gate this read from swallowing every director_activity row.
  assert.deepEqual(
    capture.eqs.map((e) => [e.col, e.val]),
    [["workspace_id", "ws-1"], ["action_kind", "media_buyer_scale_rail_deferred"]],
    "readRecentScaleRailDeferralsForAdsets MUST filter by workspace + action_kind='media_buyer_scale_rail_deferred'",
  );
  assert.equal(capture.gtes.length, 1, "the freshness gate (.gte created_at) MUST be present");
  assert.equal(capture.gtes[0].col, "created_at");
  const sinceMsFromArgv = Date.parse(String(capture.gtes[0].val));
  assert.equal(sinceMsFromArgv, nowMs - RAIL_DEFERRAL_LOOKBACK_MS, "sinceIso MUST equal nowMs - RAIL_DEFERRAL_LOOKBACK_MS (24h)");

  // Result pin — fresh in, stale out, wrong workspace out, wrong action_kind out.
  assert.ok(deferred.has("adset-crown-cooldown"), "a fresh cooldown defer on the target adset covers the crown");
  assert.ok(!deferred.has("adset-crown-stale"), "a defer older than RAIL_DEFERRAL_LOOKBACK_MS MUST NOT count as coverage — the cooldown has passed");
});

test("a per_account_daily_budget_delta_ceiling defer on the adset counts the same as a per_object_cooldown defer", async () => {
  const nowMs = Date.parse("2026-08-24T18:00:00Z");
  const withinIso = new Date(nowMs - 2 * 3600_000).toISOString();
  const { admin } = makeFakeAdmin([
    { workspace_id: "ws-1", action_kind: "media_buyer_scale_rail_deferred", created_at: withinIso, metadata: { target_object_id: "adset-crown-ceiling", rail: "per_account_daily_budget_delta_ceiling" } },
  ]);
  const deferred = await readRecentScaleRailDeferralsForAdsets(admin, "ws-1", ["adset-crown-ceiling"], nowMs);
  assert.ok(deferred.has("adset-crown-ceiling"), "the ceiling rail is a legitimate defer too — Bianca evaluated the crown");
});

test("only adsets in the input list flow into the result — a defer on an unlisted adset is ignored", async () => {
  const nowMs = Date.parse("2026-08-24T18:00:00Z");
  const withinIso = new Date(nowMs - 3600_000).toISOString();
  const { admin } = makeFakeAdmin([
    { workspace_id: "ws-1", action_kind: "media_buyer_scale_rail_deferred", created_at: withinIso, metadata: { target_object_id: "adset-listed", rail: "per_object_cooldown" } },
    { workspace_id: "ws-1", action_kind: "media_buyer_scale_rail_deferred", created_at: withinIso, metadata: { target_object_id: "adset-unlisted", rail: "per_object_cooldown" } },
  ]);
  const deferred = await readRecentScaleRailDeferralsForAdsets(admin, "ws-1", ["adset-listed"], nowMs);
  assert.deepEqual([...deferred], ["adset-listed"]);
});

test("empty adsetIds → empty set, no DB read attempted (short-circuit preserves the executed-only test's zero-DB invariant)", async () => {
  const { admin, capture } = makeFakeAdmin([]);
  const deferred = await readRecentScaleRailDeferralsForAdsets(admin, "ws-1", [], Date.parse("2026-08-24T18:00:00Z"));
  assert.equal(deferred.size, 0);
  assert.equal(capture.table, "");
});

test("a defer row with null metadata OR a non-string target_object_id is skipped, not thrown", async () => {
  const nowMs = Date.parse("2026-08-24T18:00:00Z");
  const withinIso = new Date(nowMs - 3600_000).toISOString();
  const { admin } = makeFakeAdmin([
    { workspace_id: "ws-1", action_kind: "media_buyer_scale_rail_deferred", created_at: withinIso, metadata: null },
    { workspace_id: "ws-1", action_kind: "media_buyer_scale_rail_deferred", created_at: withinIso, metadata: { target_object_id: 12345 } },
    { workspace_id: "ws-1", action_kind: "media_buyer_scale_rail_deferred", created_at: withinIso, metadata: { target_object_id: "adset-legit" } },
  ]);
  const deferred = await readRecentScaleRailDeferralsForAdsets(admin, "ws-1", ["adset-legit"], nowMs);
  assert.deepEqual([...deferred], ["adset-legit"]);
});

// ── kill-rail coverage (ads-supervisor-fix-fdc11e10-bianca-kill-120253384730390184) ──
//
// Kill-side twin of the scale-rail coverage pins above. A `media_buyer_kill_rail_deferred`
// row in the freshness window on the dud IS the coverage — Bianca DID evaluate the loser
// and chose to defer per `policy.never_pause_object_ids`. Without this read the supervisor
// authors a fresh `bianca_missed_kill` fix-spec every 3h on a CEO-protected dud, flooding
// the digest with false positives on a legitimate policy hold.

test("kill: a recent kill_rail_deferred row on the adset counts as coverage; older-than-24h does NOT", async () => {
  const nowMs = Date.parse("2026-08-30T18:00:00Z");
  const withinIso = new Date(nowMs - 3 * 3600_000).toISOString(); // 3h ago
  const staleIso = new Date(nowMs - 26 * 3600_000).toISOString(); // 26h ago — outside cap
  const { admin, capture } = makeFakeAdmin([
    { workspace_id: "ws-1", action_kind: "media_buyer_kill_rail_deferred", created_at: withinIso, metadata: { target_object_id: "adset-dud-protected", rail: "never_pause_list" } },
    { workspace_id: "ws-1", action_kind: "media_buyer_kill_rail_deferred", created_at: staleIso, metadata: { target_object_id: "adset-dud-stale", rail: "never_pause_list" } },
    { workspace_id: "ws-other", action_kind: "media_buyer_kill_rail_deferred", created_at: withinIso, metadata: { target_object_id: "adset-dud-protected", rail: "never_pause_list" } },
    // wrong action_kind — the scale-rail defer MUST NOT accidentally satisfy the kill coverage read.
    { workspace_id: "ws-1", action_kind: "media_buyer_scale_rail_deferred", created_at: withinIso, metadata: { target_object_id: "adset-dud-protected", rail: "per_object_cooldown" } },
  ]);
  const deferred = await readRecentKillRailDeferralsForAdsets(
    admin,
    "ws-1",
    ["adset-dud-protected", "adset-dud-stale"],
    nowMs,
  );

  assert.deepEqual(
    capture.eqs.map((e) => [e.col, e.val]),
    [["workspace_id", "ws-1"], ["action_kind", "media_buyer_kill_rail_deferred"]],
    "readRecentKillRailDeferralsForAdsets MUST filter by workspace + action_kind='media_buyer_kill_rail_deferred' — a stray edit that widens the filter would let a scale-rail defer silently count as kill coverage",
  );
  assert.equal(capture.gtes.length, 1, "the freshness gate (.gte created_at) MUST be present on the kill-side read too");
  assert.equal(capture.gtes[0].col, "created_at");
  const sinceMsFromArgv = Date.parse(String(capture.gtes[0].val));
  assert.equal(sinceMsFromArgv, nowMs - RAIL_DEFERRAL_LOOKBACK_MS, "sinceIso MUST equal nowMs - RAIL_DEFERRAL_LOOKBACK_MS (24h)");

  assert.ok(deferred.has("adset-dud-protected"), "a fresh never_pause_list defer on the protected dud covers the kill — Bianca evaluated the loser and held per policy");
  assert.ok(!deferred.has("adset-dud-stale"), "a defer older than RAIL_DEFERRAL_LOOKBACK_MS MUST NOT count — a CEO removing the adset from never_pause_object_ids MUST see a fresh miss on the next tick");
});

test("kill: only adsets in the input list flow into the result — a kill-defer on an unlisted adset is ignored", async () => {
  const nowMs = Date.parse("2026-08-30T18:00:00Z");
  const withinIso = new Date(nowMs - 3600_000).toISOString();
  const { admin } = makeFakeAdmin([
    { workspace_id: "ws-1", action_kind: "media_buyer_kill_rail_deferred", created_at: withinIso, metadata: { target_object_id: "adset-listed", rail: "never_pause_list" } },
    { workspace_id: "ws-1", action_kind: "media_buyer_kill_rail_deferred", created_at: withinIso, metadata: { target_object_id: "adset-unlisted", rail: "never_pause_list" } },
  ]);
  const deferred = await readRecentKillRailDeferralsForAdsets(admin, "ws-1", ["adset-listed"], nowMs);
  assert.deepEqual([...deferred], ["adset-listed"]);
});

test("kill: empty adsetIds → empty set, no DB read attempted (short-circuit)", async () => {
  const { admin, capture } = makeFakeAdmin([]);
  const deferred = await readRecentKillRailDeferralsForAdsets(admin, "ws-1", [], Date.parse("2026-08-30T18:00:00Z"));
  assert.equal(deferred.size, 0);
  assert.equal(capture.table, "");
});

test("kill: a defer row with null metadata OR a non-string target_object_id is skipped, not thrown", async () => {
  const nowMs = Date.parse("2026-08-30T18:00:00Z");
  const withinIso = new Date(nowMs - 3600_000).toISOString();
  const { admin } = makeFakeAdmin([
    { workspace_id: "ws-1", action_kind: "media_buyer_kill_rail_deferred", created_at: withinIso, metadata: null },
    { workspace_id: "ws-1", action_kind: "media_buyer_kill_rail_deferred", created_at: withinIso, metadata: { target_object_id: 98765 } },
    { workspace_id: "ws-1", action_kind: "media_buyer_kill_rail_deferred", created_at: withinIso, metadata: { target_object_id: "adset-legit" } },
  ]);
  const deferred = await readRecentKillRailDeferralsForAdsets(admin, "ws-1", ["adset-legit"], nowMs);
  assert.deepEqual([...deferred], ["adset-legit"]);
});

// Structural pin — grep guard so a stray edit that removes the freshness gate regresses THIS
// test at merge, not in prod when a year-old defer row is silently counted as covering a crown.
test("ads-supervisor.ts — readRecentScaleRailDeferralsForAdsets literal filters include .eq(\"action_kind\", \"media_buyer_scale_rail_deferred\") + .gte(\"created_at\", …) (grep guard)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./ads-supervisor.ts", import.meta.url), "utf8");
  assert.ok(
    /\.eq\(\s*["']action_kind["']\s*,\s*["']media_buyer_scale_rail_deferred["']\s*\)/.test(src),
    "ads-supervisor.ts must call .eq(\"action_kind\", \"media_buyer_scale_rail_deferred\") on the coverage read",
  );
  assert.ok(
    /\.gte\(\s*["']created_at["']\s*,\s*sinceIso\s*\)/.test(src),
    "the freshness gate .gte(\"created_at\", sinceIso) MUST be present — a missing gate silently ages the coverage into a year-long free pass",
  );
});

test("ads-supervisor.ts — readRecentKillRailDeferralsForAdsets literal filters include .eq(\"action_kind\", \"media_buyer_kill_rail_deferred\") (grep guard)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./ads-supervisor.ts", import.meta.url), "utf8");
  assert.ok(
    /\.eq\(\s*["']action_kind["']\s*,\s*["']media_buyer_kill_rail_deferred["']\s*\)/.test(src),
    "ads-supervisor.ts must call .eq(\"action_kind\", \"media_buyer_kill_rail_deferred\") on the kill-side coverage read — a missing filter would silently count every director_activity row as coverage",
  );
});
