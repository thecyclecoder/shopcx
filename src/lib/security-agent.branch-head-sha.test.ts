/**
 * a-branch-security-review-is-fresh-only-for-the-exact-head-sha-it-reviewed Phase 1 pins:
 *
 *   1. `SecurityBranchInstructions` carries a `reviewed_head_sha` field (the SHA the review covered).
 *   2. `enqueueSecurityReviewJob` in branch mode records `input.headSha` onto the inserted
 *      `agent_jobs.instructions.reviewed_head_sha` — the enqueue-time stamp. `null` when the caller
 *      cannot resolve a SHA (server-side callers with no local git access); the worker lane
 *      overrides on completion with the RUN-TIME reviewed SHA.
 *   3. `enqueueSecurityReviewJob` in DIFF mode is UNCHANGED — no reviewed_head_sha stamped (diff mode
 *      is keyed by merge SHA, not branch head; this field is branch-mode-only).
 *
 * Pure — an in-memory admin fake stands in for Supabase. Run:
 *   npm run test:security-agent-branch-head-sha
 *   (= tsx --test src/lib/security-agent.branch-head-sha.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SecurityBranchInstructions } from "./security-agent";
import { enqueueSecurityReviewJob } from "./security-agent";

type InsertedRow = { kind: string; spec_slug: string; spec_branch?: string | null; instructions: string; status: string };

/**
 * Minimal admin fake — the enqueue path issues exactly these operations:
 *   - `.from('agent_jobs').select(...).eq(...).limit(...).maybeSingle()` to check the last build job
 *   - `.from('agent_jobs').select(...).eq(...).in(...).limit(...)` for the open-review dedup
 *   - `.from('agent_jobs').select(...).eq(...).order(...).limit(...).maybeSingle()` for the clean-review dedup
 *   - `.from('workspaces').select(...).order(...).limit(...).maybeSingle()` to resolve the workspace
 *   - `.from('agent_jobs').insert({...})` — the write we're asserting on
 */
function makeAdmin(): { admin: unknown; inserts: InsertedRow[] } {
  const inserts: InsertedRow[] = [];
  const emptyResult = { data: null, error: null } as const;
  const emptyArr = { data: [], error: null } as const;

  const chain: Record<string, unknown> & {
    select: (..._a: unknown[]) => typeof chain;
    eq: (..._a: unknown[]) => typeof chain;
    in: (..._a: unknown[]) => typeof chain;
    order: (..._a: unknown[]) => typeof chain;
    limit: (..._a: unknown[]) => typeof chain;
    gte: (..._a: unknown[]) => typeof chain;
    not: (..._a: unknown[]) => typeof chain;
    like: (..._a: unknown[]) => typeof chain;
    maybeSingle: () => Promise<typeof emptyResult>;
    then: <T>(_r: (v: unknown) => T) => Promise<T>;
  } = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => chain,
    gte: () => chain,
    not: () => chain,
    like: () => chain,
    maybeSingle: async () => emptyResult,
    then: async (r) => r(emptyArr),
  };

  const workspaceChain = {
    select: () => workspaceChain,
    order: () => workspaceChain,
    limit: () => workspaceChain,
    maybeSingle: async () => ({ data: { id: "ws-stub" }, error: null }),
  };

  const admin = {
    from: (table: string) => {
      if (table === "workspaces") return workspaceChain;
      return {
        ...chain,
        insert: async (row: InsertedRow) => {
          inserts.push(row);
          return { error: null };
        },
      };
    },
  };
  return { admin, inserts };
}

test("enqueueSecurityReviewJob (branch mode) records the caller-supplied headSha onto instructions.reviewed_head_sha", async () => {
  const { admin, inserts } = makeAdmin();
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const r = await enqueueSecurityReviewJob(admin as never, {
    branch: "claude/build-example-slug",
    previewOrigin: "https://preview.vercel.app",
    specSlug: "example-slug",
    prNumber: 42,
    workspaceId: "ws-stub",
    headSha: sha,
  });
  assert.equal(r.enqueued, true, `expected enqueued=true, got ${JSON.stringify(r)}`);
  assert.equal(inserts.length, 1, "exactly one insert");
  const instr = JSON.parse(inserts[0].instructions) as SecurityBranchInstructions;
  assert.equal(instr.mode, "branch");
  assert.equal(instr.reviewed_head_sha, sha, "reviewed_head_sha must be recorded on the inserted row");
});

test("enqueueSecurityReviewJob (branch mode) records reviewed_head_sha=null when caller supplies none (server-side callers with no git access)", async () => {
  const { admin, inserts } = makeAdmin();
  const r = await enqueueSecurityReviewJob(admin as never, {
    branch: "claude/build-no-sha",
    previewOrigin: "",
    specSlug: "no-sha",
    workspaceId: "ws-stub",
  });
  assert.equal(r.enqueued, true);
  const instr = JSON.parse(inserts[0].instructions) as SecurityBranchInstructions;
  assert.equal(instr.reviewed_head_sha, null, "missing headSha input MUST record null (not undefined) so Phase 2 can key on absence");
});

test("enqueueSecurityReviewJob (branch mode) accepts headSha=null explicitly — treated the same as omission", async () => {
  const { admin, inserts } = makeAdmin();
  const r = await enqueueSecurityReviewJob(admin as never, {
    branch: "claude/build-null-sha",
    previewOrigin: "",
    specSlug: "null-sha",
    workspaceId: "ws-stub",
    headSha: null,
  });
  assert.equal(r.enqueued, true);
  const instr = JSON.parse(inserts[0].instructions) as SecurityBranchInstructions;
  assert.equal(instr.reviewed_head_sha, null);
});

test("enqueueSecurityReviewJob (DIFF mode) does NOT record reviewed_head_sha (branch-mode-only field)", async () => {
  const { admin, inserts } = makeAdmin();
  const r = await enqueueSecurityReviewJob(admin as never, {
    mergeSha: "deadbeef00000000000000000000000000000000",
    specSlug: "some-merged-spec",
    workspaceId: "ws-stub",
  });
  assert.equal(r.enqueued, true);
  const instr = JSON.parse(inserts[0].instructions) as { mode: string; reviewed_head_sha?: unknown; merge_sha?: string };
  assert.equal(instr.mode, "diff");
  assert.equal("reviewed_head_sha" in instr, false, "diff-mode instructions must NOT carry reviewed_head_sha (it is a branch-mode-only field)");
});

test("SecurityBranchInstructions type carries an OPTIONAL reviewed_head_sha field (string | null | undefined) — pinned at the type layer so callers get a compile-time signal", () => {
  const withHead: SecurityBranchInstructions = {
    mode: "branch",
    branch: "b",
    preview_origin: "p",
    spec_slug: "s",
    reviewed_head_sha: "0".repeat(40),
  };
  const withoutHead: SecurityBranchInstructions = {
    mode: "branch",
    branch: "b",
    preview_origin: "p",
    spec_slug: "s",
  };
  const explicitNull: SecurityBranchInstructions = {
    mode: "branch",
    branch: "b",
    preview_origin: "p",
    spec_slug: "s",
    reviewed_head_sha: null,
  };
  assert.equal(withHead.reviewed_head_sha, "0".repeat(40));
  assert.equal(withoutHead.reviewed_head_sha, undefined);
  assert.equal(explicitNull.reviewed_head_sha, null);
});
