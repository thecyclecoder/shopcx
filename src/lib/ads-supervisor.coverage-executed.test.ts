/**
 * ads-supervisor Phase-2 coverage-executed tests
 * ([[./ads-supervisor]] · [[../../docs/brain/specs/media-buyer-decided-kills-must-execute-on-meta-not-just-be-recorded]] Phase 2).
 *
 * Locks the new coverage contract: an `iteration_actions` row counts as covering a
 * missed-crown/missed-kill finding ONLY when `status='executed'`. A `decided`-only row
 * (a pause Bianca DECIDED but the runner never actually fired on Meta) MUST NOT satisfy
 * the coverage check — otherwise the exact bug the parent spec fixes (four Superfood
 * duds stayed live at ROAS 0.00 while the ledger CLAIMED a pause it never made) gets
 * hidden by the supervisor that's supposed to catch it.
 *
 *   npx tsx --test src/lib/ads-supervisor.coverage-executed.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readExecutedIterationActionsForAdsets } from "./ads-supervisor";

// A row shape mirroring `iteration_actions` — only the columns the coverage-check reads +
// filters on. `workspace_id` is included so the fake's .eq("workspace_id", …) filter matches.
type Row = { workspace_id: string; object_id: string; action_type: string; status: string };
interface FilterCapture {
  eqs: Array<{ col: string; val: unknown }>;
  ins: Array<{ col: string; vals: unknown[] }>;
  select: string;
  table: string;
}

/**
 * Fake Supabase client scoped to a single `.from(table).select(...).eq/in()` read.
 * Captures every filter the coverage-check applies so we can PIN the `status='executed'`
 * gate at the argv level (not just at the result level) — a stray edit that removes the
 * filter would silently regress to the pre-Phase-2 shape but still pass a "does the return
 * value have the right shape" test on the filtered fake rows.
 */
function makeFakeAdmin(rows: Row[]) {
  const capture: FilterCapture = { eqs: [], ins: [], select: "", table: "" };
  const chain: {
    select: (cols: string) => typeof chain;
    eq: (col: string, val: unknown) => typeof chain;
    in: (col: string, vals: unknown[]) => typeof chain;
    then: (onFulfilled: (v: { data: Row[]; error: null }) => unknown) => Promise<unknown>;
  } = {
    select(cols) { capture.select = cols; return chain; },
    eq(col, val) { capture.eqs.push({ col, val }); return chain; },
    in(col, vals) { capture.ins.push({ col, vals }); return chain; },
    then(onFulfilled) {
      // Return only rows whose object_id + action_type + status match every applied filter —
      // mirrors the real filter semantics so the test is grounded in Supabase's actual behavior.
      const filtered = rows.filter((r) => {
        for (const f of capture.eqs) {
          const rv = (r as unknown as Record<string, unknown>)[f.col];
          if (rv !== f.val) return false;
        }
        for (const f of capture.ins) {
          const rv = (r as unknown as Record<string, unknown>)[f.col];
          if (!f.vals.includes(rv)) return false;
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
  } as unknown as Parameters<typeof readExecutedIterationActionsForAdsets>[0];
  return { admin, capture };
}

test("Phase 2 — coverage read applies .eq('status', 'executed') so a 'decided'-only row is NOT counted", async () => {
  // The test's core assertion: the filter list handed to Supabase MUST include
  // ('status','executed'). Absent this filter the pre-Phase-2 shape counted every decided
  // + executed row as covered — the ads-supervisor's watcher-of-Bianca was blind to the
  // exact execution gap Phase 1 fixes.
  const { admin, capture } = makeFakeAdmin([
    { workspace_id: "ws-1", object_id: "adset-only-decided", action_type: "pause", status: "decided" },
    { workspace_id: "ws-1", object_id: "adset-executed", action_type: "pause", status: "executed" },
    { workspace_id: "ws-1", object_id: "adset-failed", action_type: "pause", status: "failed" },
  ]);
  const acted = await readExecutedIterationActionsForAdsets(admin, "ws-1", [
    "adset-only-decided",
    "adset-executed",
    "adset-failed",
  ]);

  // Argv pin — the predicate is present in the query. Grep-style tests on the source file
  // catch a comment-only change but miss a subtle .eq argument change; this pin catches both.
  assert.deepEqual(
    capture.eqs.map((e) => [e.col, e.val]),
    [["workspace_id", "ws-1"], ["status", "executed"]],
    "readExecutedIterationActionsForAdsets MUST filter by ('status','executed') — a decided-only row is un-covered per the no-false-promises principle",
  );
  assert.deepEqual(
    capture.ins.map((i) => i.col),
    ["object_id", "action_type"],
    "coverage read still scopes by object_id + action_type — Phase 2 preserves those filters",
  );

  // Result pin — the map reports the executed row as covered, and every OTHER adset as
  // absent from the map (so `acted?.hasPause` reads false at the call site → the missed-kill
  // finding fires for the decided-only adset, exactly what the parent spec's Phase 2 wants).
  assert.deepEqual(acted.get("adset-executed"), { hasScaleUp: false, hasPause: true }, "an executed pause counts as covered");
  assert.equal(acted.get("adset-only-decided"), undefined, "a decided-only pause MUST NOT appear in the coverage map → the missed-kill finding fires");
  assert.equal(acted.get("adset-failed"), undefined, "a failed pause MUST NOT appear in the coverage map either (the ledger says it didn't happen)");
});

test("Phase 2 — a promote (executed scale_up) counts as covered; a decided-only scale_up does NOT", async () => {
  const { admin } = makeFakeAdmin([
    { workspace_id: "ws-1", object_id: "adset-crown-executed", action_type: "scale_up", status: "executed" },
    { workspace_id: "ws-1", object_id: "adset-crown-decided", action_type: "scale_up", status: "decided" },
  ]);
  const acted = await readExecutedIterationActionsForAdsets(admin, "ws-1", [
    "adset-crown-executed",
    "adset-crown-decided",
  ]);
  assert.deepEqual(acted.get("adset-crown-executed"), { hasScaleUp: true, hasPause: false }, "an executed promote counts as covered");
  assert.equal(acted.get("adset-crown-decided"), undefined, "a decided-only promote MUST NOT count as covered — the missed-crown finding fires");
});

test("Phase 2 — mixed adset with BOTH an executed pause AND an executed scale_up rolls up both booleans", async () => {
  const { admin } = makeFakeAdmin([
    { workspace_id: "ws-1", object_id: "adset-mix", action_type: "pause", status: "executed" },
    { workspace_id: "ws-1", object_id: "adset-mix", action_type: "scale_up", status: "executed" },
  ]);
  const acted = await readExecutedIterationActionsForAdsets(admin, "ws-1", ["adset-mix"]);
  assert.deepEqual(acted.get("adset-mix"), { hasScaleUp: true, hasPause: true });
});

test("Phase 2 — empty adsetIds → empty map, no DB read attempted (short-circuit preserved)", async () => {
  const { admin, capture } = makeFakeAdmin([]);
  const acted = await readExecutedIterationActionsForAdsets(admin, "ws-1", []);
  assert.equal(acted.size, 0);
  assert.equal(capture.table, "", "short-circuit MUST NOT hit the DB when the input adset list is empty");
});

// Structural pin — grep guard so a stray edit that removes the .eq("status", "executed")
// filter regresses THIS test at merge, not in prod when four more duds have already burned
// $325 each waiting for a coverage watcher that is silently blind.
test("ads-supervisor.ts — readExecutedIterationActionsForAdsets literal filter includes .eq(\"status\", \"executed\") (grep guard against the pre-Phase-2 shape)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./ads-supervisor.ts", import.meta.url), "utf8");
  assert.ok(
    /\.eq\(\s*["']status["']\s*,\s*["']executed["']\s*\)/.test(src),
    "ads-supervisor.ts must call .eq(\"status\", \"executed\") on the iteration_actions coverage read — the no-false-promises coverage contract (Phase 2)",
  );
});
