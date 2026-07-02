/**
 * Unit tests for the failed-builds supersede selector (box-failed-build-supersede-and-dismiss Phase 1).
 * Pure helper — no DB. Run:
 *   npm run test:box-failed-supersede
 *   (= tsx --test src/lib/box-failed-supersede.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { selectLatestBuildBySlug } from "./box-failed-supersede";

test("a later-created failed attempt does NOT mask a merged sibling (box-self-update-persist-skip-reason, 2026-07-02)", () => {
  const attempts = [
    { id: "failed-08:41", spec_slug: "box-self-update-persist-skip-reason", status: "failed", created_at: "2026-07-02T08:41:00Z" },
    { id: "merged-06:09", spec_slug: "box-self-update-persist-skip-reason", status: "merged", created_at: "2026-07-02T06:09:00Z" },
  ];
  const winners = selectLatestBuildBySlug(attempts);
  const w = winners.get("box-self-update-persist-skip-reason");
  assert.equal(w?.id, "merged-06:09");
  assert.equal(w?.status, "merged");
});

test("a later-created failed attempt does NOT mask a completed sibling either", () => {
  const attempts = [
    { id: "failed", spec_slug: "s", status: "failed", created_at: "2026-07-02T10:00:00Z" },
    { id: "completed", spec_slug: "s", status: "completed", created_at: "2026-07-02T09:00:00Z" },
  ];
  assert.equal(selectLatestBuildBySlug(attempts).get("s")?.status, "completed");
});

test("only/newest attempt is failed with no successful sibling → still failed (card must still surface)", () => {
  const attempts = [
    { id: "failed", spec_slug: "solo", status: "failed", created_at: "2026-07-02T09:00:00Z" },
  ];
  assert.equal(selectLatestBuildBySlug(attempts).get("solo")?.status, "failed");
});

test("an in-flight retry supersedes an older failed attempt (retry outranks failure)", () => {
  const attempts = [
    { id: "queued", spec_slug: "retry", status: "queued", created_at: "2026-07-02T09:30:00Z" },
    { id: "failed", spec_slug: "retry", status: "failed", created_at: "2026-07-02T09:00:00Z" },
  ];
  assert.equal(selectLatestBuildBySlug(attempts).get("retry")?.status, "queued");
});

test("within the same outcome tier, the newer created_at wins", () => {
  const attempts = [
    { id: "older-failed", spec_slug: "same", status: "failed", created_at: "2026-07-02T01:00:00Z" },
    { id: "newer-failed", spec_slug: "same", status: "failed", created_at: "2026-07-02T02:00:00Z" },
  ];
  assert.equal(selectLatestBuildBySlug(attempts).get("same")?.id, "newer-failed");
});

test("input order does not matter — merged wins whether it appears first or last", () => {
  const a = selectLatestBuildBySlug([
    { id: "merged", spec_slug: "x", status: "merged", created_at: "2026-07-02T06:00:00Z" },
    { id: "failed", spec_slug: "x", status: "failed", created_at: "2026-07-02T07:00:00Z" },
  ]);
  const b = selectLatestBuildBySlug([
    { id: "failed", spec_slug: "x", status: "failed", created_at: "2026-07-02T07:00:00Z" },
    { id: "merged", spec_slug: "x", status: "merged", created_at: "2026-07-02T06:00:00Z" },
  ]);
  assert.equal(a.get("x")?.status, "merged");
  assert.equal(b.get("x")?.status, "merged");
});

test("multiple slugs are picked independently", () => {
  const attempts = [
    { id: "a-failed", spec_slug: "a", status: "failed", created_at: "2026-07-02T02:00:00Z" },
    { id: "a-merged", spec_slug: "a", status: "merged", created_at: "2026-07-02T01:00:00Z" },
    { id: "b-failed", spec_slug: "b", status: "failed", created_at: "2026-07-02T03:00:00Z" },
  ];
  const w = selectLatestBuildBySlug(attempts);
  assert.equal(w.get("a")?.status, "merged");
  assert.equal(w.get("b")?.status, "failed");
});
