/**
 * Unit tests for the PURE bucketizers behind getDirectorBoxSnapshot
 * (director-coach-canonical-box-snapshot Phase 1).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:director-box-snapshot
 *   (= tsx --test src/lib/agents/director-box-snapshot.test.ts)
 *
 * Seeds one synthetic `agent_jobs` row per status (the spec's exact ask) and asserts the snapshot
 * bucketizes correctly — including the spec's recurring failure mode (a `running`/`in_progress` row,
 * which isn't in the real enum, MUST NOT inflate any bucket).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BOX_ACTIVE_STATUSES,
  BOX_PARKED_STATUSES,
  BOX_TERMINAL_STATUSES,
  bucketizeJobs,
  groupParkedByClass,
  type BoxStatus,
  type RawJobRow,
} from "./director-box-snapshot";

const NOW = Date.parse("2026-06-25T01:35:06Z");
const MIN_AGO = (m: number) => new Date(NOW - m * 60_000).toISOString();
const HR_AGO = (h: number) => new Date(NOW - h * 60 * 60_000).toISOString();

function row(over: Partial<RawJobRow> & Pick<RawJobRow, "id" | "status">): RawJobRow {
  return {
    spec_slug: `spec-${over.id}`,
    kind: "build",
    needs_attention_class: null,
    updated_at: MIN_AGO(5),
    created_at: MIN_AGO(10),
    completed_at: null,
    error: null,
    ...over,
  };
}

test("BOX_ACTIVE_STATUSES never includes the bad-enum statuses that started this whole spec", () => {
  const active = new Set<string>(BOX_ACTIVE_STATUSES);
  for (const bad of ["running", "in_progress"]) {
    assert.equal(active.has(bad), false, `BOX_ACTIVE_STATUSES must not include ${bad}`);
  }
});

test("BOX_ACTIVE_STATUSES + BOX_PARKED_STATUSES + BOX_TERMINAL_STATUSES are disjoint", () => {
  const all = [...BOX_ACTIVE_STATUSES, ...BOX_PARKED_STATUSES, ...BOX_TERMINAL_STATUSES];
  assert.equal(new Set(all).size, all.length, "status sets overlap");
});

test("bucketizeJobs seeds one row per REAL status and groups them correctly", () => {
  // The exact ask: one row per status from the real enum, plus the spec's bug (a phantom 'running' row).
  const rows: RawJobRow[] = [
    ...BOX_ACTIVE_STATUSES.map((status, i) => row({ id: `a${i}`, status })),
    ...BOX_PARKED_STATUSES.map((status, i) => row({ id: `p${i}`, status })),
    ...BOX_TERMINAL_STATUSES.map((status, i) => row({ id: `t${i}`, status, updated_at: MIN_AGO(15) })),
    // Phantom row — `running` isn't in the real enum. Including it would inflate `active`.
    row({ id: "phantom", status: "running" }),
  ];
  const { counts, samples } = bucketizeJobs(rows, NOW);

  for (const s of BOX_ACTIVE_STATUSES) {
    assert.equal(counts[s], 1, `expected one row in active bucket ${s}`);
    assert.equal(samples[s].length, 1, `expected one sample in active bucket ${s}`);
  }
  for (const s of BOX_PARKED_STATUSES) {
    assert.equal(counts[s], 1, `expected one row in parked bucket ${s}`);
  }
  for (const s of BOX_TERMINAL_STATUSES) {
    assert.equal(counts[s], 1, `expected one row in terminal bucket ${s} (within the 2h window)`);
  }
  // Phantom status must NOT appear anywhere.
  for (const s of Object.keys(counts) as BoxStatus[]) {
    assert.notEqual(s, "running" as BoxStatus, "running must not be in counts");
  }
});

test("bucketizeJobs gives a 0 entry for every known status (no missing keys → no false 'empty')", () => {
  const { counts } = bucketizeJobs([], NOW);
  for (const s of [...BOX_ACTIVE_STATUSES, ...BOX_PARKED_STATUSES, ...BOX_TERMINAL_STATUSES]) {
    assert.equal(counts[s], 0, `${s} must default to 0`);
  }
});

test("bucketizeJobs drops a TERMINAL row outside the 2h window but keeps a stale ACTIVE row", () => {
  const stale: RawJobRow[] = [
    row({ id: "old-complete", status: "completed", updated_at: HR_AGO(3) }),
    row({ id: "old-fail", status: "failed", updated_at: HR_AGO(5) }),
    row({ id: "stale-building", status: "building", updated_at: HR_AGO(8) }),
  ];
  const { counts, samples } = bucketizeJobs(stale, NOW);
  assert.equal(counts.completed, 0, "stale completed outside 2h must be dropped");
  assert.equal(counts.failed, 0, "stale failed outside 2h must be dropped");
  assert.equal(counts.building, 1, "stale ACTIVE row stays — age doesn't matter for active");
  assert.equal(samples.building[0].id, "stale-building");
});

test("bucketizeJobs caps samples per status at 3 but counts every row", () => {
  const flood: RawJobRow[] = Array.from({ length: 7 }, (_, i) => row({ id: `q${i}`, status: "queued" }));
  const { counts, samples } = bucketizeJobs(flood, NOW);
  assert.equal(counts.queued, 7);
  assert.equal(samples.queued.length, 3, "samples cap at 3");
});

test("groupParkedByClass groups needs_attention by class, biggest first, null → 'unclassified'", () => {
  const rows: RawJobRow[] = [
    row({ id: "p1", status: "needs_attention", needs_attention_class: "real_blocker" }),
    row({ id: "p2", status: "needs_attention", needs_attention_class: "real_blocker" }),
    row({ id: "p3", status: "needs_attention", needs_attention_class: "routed_already_shipped" }),
    row({ id: "p4", status: "needs_attention", needs_attention_class: null }),
    row({ id: "p5", status: "needs_attention", needs_attention_class: "" }),
    row({ id: "n1", status: "building", needs_attention_class: null }), // ignored — wrong status
  ];
  const groups = groupParkedByClass(rows, NOW);
  assert.deepEqual(
    groups.map((g) => [g.class_name, g.count]),
    [
      ["real_blocker", 2],
      ["unclassified", 2],
      ["routed_already_shipped", 1],
    ],
  );
  // The non-parked row never leaks into the groups (would be a serious false signal).
  assert.equal(
    groups.find((g) => g.sample.some((s) => s.slug === "spec-n1")),
    undefined,
  );
});

test("groupParkedByClass age_minutes is computed against `now`, rounded down", () => {
  const rows: RawJobRow[] = [
    row({ id: "p1", status: "needs_attention", needs_attention_class: "x", updated_at: MIN_AGO(12) }),
  ];
  const [group] = groupParkedByClass(rows, NOW);
  assert.equal(group.sample[0].age_minutes, 12);
});
