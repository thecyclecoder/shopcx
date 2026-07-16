/**
 * Unit test for reap-needs-attention-jobs-for-archived-specs Phase 1 — the reaper's status set is
 * a superset of ACTIVE_STATUSES that ALSO includes 'needs_attention', so a folded/deferred/
 * FS-archived spec's PARKED needs_attention build job is caught by the same
 * filterJobsForArchivedSpecs membership check.
 *
 *   npm run test:reap-needs-attention-archived
 *   (= tsx --test src/lib/agent-jobs.reap-needs-attention-archived.test.ts)
 *
 * Covers the spec's Verification bullets:
 *   - a needs_attention build job for a folded spec is INCLUDED in the reap set
 *   - a needs_attention build job for a LIVE spec is EXCLUDED from the reap set
 *   - cancelJobsForArchivedSpecs's status set (REAPABLE_STATUSES_FOR_ARCHIVED_SPECS) contains
 *     'needs_attention' AND is a superset of ACTIVE_STATUSES (never mutates it)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ACTIVE_STATUSES, REAPABLE_STATUSES_FOR_ARCHIVED_SPECS, filterJobsForArchivedSpecs } from "./agent-jobs";

interface FakeJob {
  id: string;
  spec_slug: string;
  workspace_id: string;
  status: "needs_attention" | "queued" | "claimed" | "building";
}

test("the reaper status set contains 'needs_attention'", () => {
  assert.equal(REAPABLE_STATUSES_FOR_ARCHIVED_SPECS.includes("needs_attention"), true);
});

test("the reaper status set is a strict superset of ACTIVE_STATUSES (widening, never mutation)", () => {
  for (const s of ACTIVE_STATUSES) {
    assert.equal(REAPABLE_STATUSES_FOR_ARCHIVED_SPECS.includes(s), true, `reaper set missing ACTIVE status ${s}`);
  }
  // The widening is ONLY needs_attention; ACTIVE_STATUSES itself must not be mutated.
  assert.equal(ACTIVE_STATUSES.includes("needs_attention" as (typeof ACTIVE_STATUSES)[number]), false);
});

test("a needs_attention job for a DB-folded spec IS included in the reap set (the root fix)", () => {
  const jobs: FakeJob[] = [
    { id: "j-parked", spec_slug: "director-sms-cockpit-per-director", workspace_id: "ws-1", status: "needs_attention" },
  ];
  const fsArchived = new Set<string>();
  const dbArchivedByWs = new Map<string, Set<string>>([
    ["ws-1", new Set(["director-sms-cockpit-per-director"])],
  ]);
  const out = filterJobsForArchivedSpecs(jobs, fsArchived, dbArchivedByWs);
  assert.deepEqual(out.map((j) => j.id), ["j-parked"]);
});

test("a needs_attention job for a LIVE (non-archived) spec is NOT included (live-spec jobs untouched)", () => {
  const jobs: FakeJob[] = [
    { id: "j-live", spec_slug: "still-building-spec", workspace_id: "ws-1", status: "needs_attention" },
  ];
  const fsArchived = new Set<string>();
  const dbArchivedByWs = new Map<string, Set<string>>([["ws-1", new Set()]]);
  const out = filterJobsForArchivedSpecs(jobs, fsArchived, dbArchivedByWs);
  assert.deepEqual(out, []);
});

test("mixed batch: folded-spec needs_attention + folded-spec queued + live-spec needs_attention → only the two folded-spec jobs reaped", () => {
  const jobs: FakeJob[] = [
    { id: "j-folded-parked", spec_slug: "claim-rpc-kill-switch-enforcement", workspace_id: "ws-1", status: "needs_attention" },
    { id: "j-folded-queued", spec_slug: "claim-rpc-kill-switch-enforcement", workspace_id: "ws-1", status: "queued" },
    { id: "j-live-parked", spec_slug: "some-live-spec", workspace_id: "ws-1", status: "needs_attention" },
  ];
  const fsArchived = new Set<string>();
  const dbArchivedByWs = new Map<string, Set<string>>([
    ["ws-1", new Set(["claim-rpc-kill-switch-enforcement"])],
  ]);
  const out = filterJobsForArchivedSpecs(jobs, fsArchived, dbArchivedByWs);
  assert.deepEqual(out.map((j) => j.id).sort(), ["j-folded-parked", "j-folded-queued"].sort());
});

test("FS-archived spec's needs_attention job is also included (FS ∪ DB is the archived set)", () => {
  const jobs: FakeJob[] = [
    { id: "j-fs-parked", spec_slug: "old-fs-archived-spec", workspace_id: "ws-1", status: "needs_attention" },
  ];
  const fsArchived = new Set(["old-fs-archived-spec"]);
  const dbArchivedByWs = new Map<string, Set<string>>([["ws-1", new Set()]]);
  const out = filterJobsForArchivedSpecs(jobs, fsArchived, dbArchivedByWs);
  assert.deepEqual(out.map((j) => j.id), ["j-fs-parked"]);
});
