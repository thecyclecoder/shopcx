/**
 * Unit test for cancel-jobs-for-archived-specs-reads-db-fold-not-just-markdown Phase 1 — the pure
 * decision half of [[cancelJobsForArchivedSpecs]] (`filterJobsForArchivedSpecs`).
 *
 *   npm run test:cancel-jobs-archived-db-folded
 *   (= tsx --test src/lib/agent-jobs.cancel-archived-db-folded.test.ts)
 *
 * Covers the spec's Verification bullet:
 *   "a DB-folded spec's active build job is included in the cancel set even when no markdown archive
 *    file exists"
 * — i.e. the FS-archived set can be empty, and a spec that was folded/deferred purely in the DB (its
 * status override set via setSpecStatus) still gets its stuck build/spec-test job cancelled.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { filterJobsForArchivedSpecs } from "./agent-jobs";

interface FakeJob {
  id: string;
  spec_slug: string;
  workspace_id: string;
}

test("DB-folded spec's active job is cancelled when the FS archive is empty (the core bug)", () => {
  const jobs: FakeJob[] = [{ id: "j1", spec_slug: "media-buyer-agent-test-mock-support-neq-filter", workspace_id: "ws-1" }];
  const fsArchived = new Set<string>(); // no markdown archive file (post-markdown-retire, or lagging FS)
  const dbArchivedByWs = new Map<string, Set<string>>([
    ["ws-1", new Set(["media-buyer-agent-test-mock-support-neq-filter"])],
  ]);
  const out = filterJobsForArchivedSpecs(jobs, fsArchived, dbArchivedByWs);
  assert.deepEqual(out.map((j) => j.id), ["j1"]);
});

test("DB-deferred spec's job is also cancelled (folded ∪ deferred is the archived set)", () => {
  const jobs: FakeJob[] = [{ id: "j2", spec_slug: "some-deferred-slug", workspace_id: "ws-1" }];
  const fsArchived = new Set<string>();
  const dbArchivedByWs = new Map<string, Set<string>>([["ws-1", new Set(["some-deferred-slug"])]]);
  const out = filterJobsForArchivedSpecs(jobs, fsArchived, dbArchivedByWs);
  assert.deepEqual(out.map((j) => j.id), ["j2"]);
});

test("FS-archived spec still cancelled (the existing behavior — the DB path is a strict superset)", () => {
  const jobs: FakeJob[] = [{ id: "j3", spec_slug: "old-fs-archived-spec", workspace_id: "ws-1" }];
  const fsArchived = new Set(["old-fs-archived-spec"]);
  const dbArchivedByWs = new Map<string, Set<string>>([["ws-1", new Set()]]);
  const out = filterJobsForArchivedSpecs(jobs, fsArchived, dbArchivedByWs);
  assert.deepEqual(out.map((j) => j.id), ["j3"]);
});

test("A live (non-archived) spec's job is NOT cancelled", () => {
  const jobs: FakeJob[] = [{ id: "j4", spec_slug: "still-building", workspace_id: "ws-1" }];
  const fsArchived = new Set<string>();
  const dbArchivedByWs = new Map<string, Set<string>>([["ws-1", new Set(["something-else-folded"])]]);
  const out = filterJobsForArchivedSpecs(jobs, fsArchived, dbArchivedByWs);
  assert.deepEqual(out, []);
});

test("DB-archived slug in workspace A does NOT cancel workspace B's job of the same slug (workspace-scoped)", () => {
  const jobs: FakeJob[] = [
    { id: "jA", spec_slug: "shared-slug", workspace_id: "ws-A" },
    { id: "jB", spec_slug: "shared-slug", workspace_id: "ws-B" },
  ];
  const fsArchived = new Set<string>();
  const dbArchivedByWs = new Map<string, Set<string>>([
    ["ws-A", new Set(["shared-slug"])],
    ["ws-B", new Set()],
  ]);
  const out = filterJobsForArchivedSpecs(jobs, fsArchived, dbArchivedByWs);
  assert.deepEqual(out.map((j) => j.id), ["jA"]);
});

test("Missing DB entry for a workspace does not blow up (returns empty archived set for that workspace)", () => {
  const jobs: FakeJob[] = [{ id: "j5", spec_slug: "any-slug", workspace_id: "ws-unknown" }];
  const fsArchived = new Set<string>();
  const dbArchivedByWs = new Map<string, Set<string>>(); // no entry for ws-unknown
  const out = filterJobsForArchivedSpecs(jobs, fsArchived, dbArchivedByWs);
  assert.deepEqual(out, []);
});
