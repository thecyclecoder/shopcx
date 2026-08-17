/**
 * a-branch-security-review-is-fresh-only-for-the-exact-head-sha-it-reviewed Phase 2 pins:
 *
 *   Fix #1 (freshness keys on head SHA). `enqueueSecurityReviewBranch`'s dedup (2) compares the newest
 *   suppressing review's recorded `instructions.reviewed_head_sha` against the branch's CURRENT head
 *   (`input.headSha`). Equal ⇒ skip. Different / either side absent ⇒ enqueue (conservative — cannot
 *   prove currency, so re-review). The old `updated_at`-based timestamp comparison is retired: a merge
 *   commit that Pax's conflict-resolution flow (or any human) pushes never touches the build job's
 *   `updated_at`, and the SHA moves regardless of who pushed. This is the 2026-08-17 defect (PR 2486
 *   reviewed 13:22 → merge commit d8727bf0 pushed 14:05 → no re-review under the old code).
 *
 *   Fix #2 (real-vuln is not a clean review). A completed review whose `instructions.verdict` is
 *   `real-vuln` (or any non-clean verdict — routed via [[isRealVulnVerdict]] so "clean" means the
 *   same thing wherever it's read) MUST NOT suppress the next pass. Only a genuinely-clean completed
 *   review for the CURRENT head can.
 *
 *   Preserved: guards (0) merged-branch + (1) one-open-review-per-branch STILL fire before dedup (2),
 *   and `force: true` STILL bypasses dedup (2) only ([[../src/lib/agent-jobs]]
 *   `retestOriginBranchSecurityIfFixMerged`).
 *
 * Pure — an in-memory admin fake stands in for Supabase. Run:
 *   npm run test:security-agent-branch-freshness
 *   (= tsx --test src/lib/security-agent.branch-freshness.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SecurityBranchInstructions } from "./security-agent";
import { enqueueSecurityReviewJob } from "./security-agent";

type InsertedRow = { kind: string; spec_slug: string; spec_branch?: string | null; instructions: string; status: string };

/** Row shape the tests seed for the "newest completed review" query. */
interface CompletedReviewRow {
  instructions: string; // JSON — SecurityBranchInstructions with reviewed_head_sha + optional verdict
}
/** Row shape the tests seed for guard (0). */
interface LastBuildJobRow {
  status: string; // 'merged' → guard (0) fires
  updated_at: string;
}
/** Row shape the tests seed for guard (1). */
interface OpenReviewRow {
  id: string;
  status: string;
}

interface AdminFixture {
  lastBuildJob?: LastBuildJobRow | null;
  openReviews?: OpenReviewRow[];
  newestCompletedReview?: CompletedReviewRow | null;
}

/**
 * Route each `.from("agent_jobs")` chain to the right seeded result by watching which `.eq()` filters
 * the caller applies. This intentionally mimics the exact call-order in `enqueueSecurityReviewBranch`:
 *   • guard (0) — `.eq('kind','build')` → seeded `lastBuildJob`, via `.maybeSingle()`.
 *   • guard (1) — `.eq('kind','security-review') + .in('status', [...])` → seeded `openReviews`, via `.then()`.
 *   • dedup (2) — `.eq('kind','security-review') + .eq('status','completed')` → seeded
 *     `newestCompletedReview`, via `.maybeSingle()`.
 */
function makeAdmin(fixture: AdminFixture): { admin: unknown; inserts: InsertedRow[] } {
  const inserts: InsertedRow[] = [];

  function agentJobsChain() {
    const state: { kind?: string; status?: string; usedIn?: boolean } = {};
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = () => self();
    chain.eq = (col: string, val: string) => {
      if (col === "kind") state.kind = val;
      if (col === "status") state.status = val;
      return self();
    };
    chain.in = () => {
      state.usedIn = true;
      return self();
    };
    chain.order = () => self();
    chain.limit = () => self();
    chain.gte = () => self();
    chain.not = () => self();
    chain.like = () => self();
    chain.maybeSingle = async () => {
      if (state.kind === "build") return { data: fixture.lastBuildJob ?? null, error: null };
      if (state.kind === "security-review" && state.status === "completed") {
        return { data: fixture.newestCompletedReview ?? null, error: null };
      }
      return { data: null, error: null };
    };
    chain.then = async <T,>(r: (v: unknown) => T) => {
      // Only guard (1) awaits the chain directly (no maybeSingle) — it .in()'s over live statuses.
      if (state.kind === "security-review" && state.usedIn) {
        return r({ data: fixture.openReviews ?? [], error: null });
      }
      return r({ data: [], error: null });
    };
    chain.insert = async (row: InsertedRow) => {
      inserts.push(row);
      return { error: null };
    };
    return chain;
  }
  const workspaceChain = {
    select: () => workspaceChain,
    order: () => workspaceChain,
    limit: () => workspaceChain,
    maybeSingle: async () => ({ data: { id: "ws-stub" }, error: null }),
  };
  const admin = {
    from: (table: string) => {
      if (table === "workspaces") return workspaceChain;
      return agentJobsChain();
    },
  };
  return { admin, inserts };
}

const SHA_A = "0".repeat(39) + "a";
const SHA_B = "0".repeat(39) + "b";
const BRANCH = "claude/build-example";

/** Compact factory: a completed review row whose recorded reviewed_head_sha + verdict come from args. */
function completedReview(headSha: string | null, verdict?: string): CompletedReviewRow {
  const instr: SecurityBranchInstructions = {
    mode: "branch",
    branch: BRANCH,
    preview_origin: "",
    spec_slug: "example",
    reviewed_head_sha: headSha,
    ...(verdict ? { verdict } : {}),
  };
  return { instructions: JSON.stringify(instr) };
}

/** Compact factory: the branch-mode enqueue input for these tests. */
function enqueueInput(headSha: string | null, force = false) {
  return {
    branch: BRANCH,
    previewOrigin: "",
    specSlug: "example",
    workspaceId: "ws-stub",
    headSha,
    ...(force ? { force: true } : {}),
  };
}

// ── Fix #1 ────────────────────────────────────────────────────────────────────────────────────────
test("dedup (2): current head SHA equals the recorded reviewed SHA → SKIP (reviewed diff is current)", async () => {
  const { admin, inserts } = makeAdmin({ newestCompletedReview: completedReview(SHA_A) });
  const r = await enqueueSecurityReviewJob(admin as never, enqueueInput(SHA_A));
  assert.equal(r.enqueued, false);
  assert.match(String(r.reason ?? ""), /current head sha/i);
  assert.equal(inserts.length, 0, "no insert on a suppress");
});

test("dedup (2): current head SHA differs from the recorded reviewed SHA → ENQUEUE (branch advanced)", async () => {
  const { admin, inserts } = makeAdmin({ newestCompletedReview: completedReview(SHA_A) });
  const r = await enqueueSecurityReviewJob(admin as never, enqueueInput(SHA_B));
  assert.equal(r.enqueued, true, `expected enqueue, got ${JSON.stringify(r)}`);
  assert.equal(inserts.length, 1);
});

test("dedup (2): the 2026-08-17 defect — a merge commit changes the head SHA (regardless of who pushed) → ENQUEUE", async () => {
  // The reviewed SHA is whatever Vault reviewed at 13:22. Pax's conflict-resolution flow pushes merge
  // commit d8727bf0 at 14:05 — the build lane's `updated_at` never bumped, but the head SHA moved.
  // The OLD timestamp comparison would have skipped ("branch has not changed since"); the new
  // SHA comparison correctly re-reviews.
  const reviewedAt1322 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const afterMergeCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const { admin } = makeAdmin({
    newestCompletedReview: completedReview(reviewedAt1322),
    // A merge commit does NOT touch the build job — leave the lastBuildJob absent so the OLD
    // timestamp path would have concluded "no newer build push" and skipped. The SHA path re-reviews.
    lastBuildJob: null,
  });
  const r = await enqueueSecurityReviewJob(admin as never, enqueueInput(afterMergeCommit));
  assert.equal(r.enqueued, true, "the merge-commit push must re-review — this is the whole point of Phase 2");
});

test("dedup (2): recorded reviewed_head_sha is null (legacy pre-Phase-1 row / worker crashed pre-stamp) → ENQUEUE (conservative)", async () => {
  const { admin } = makeAdmin({ newestCompletedReview: completedReview(null) });
  const r = await enqueueSecurityReviewJob(admin as never, enqueueInput(SHA_A));
  assert.equal(r.enqueued, true, "an absent recorded SHA cannot prove currency — re-review");
});

test("dedup (2): current head SHA is null (server-side caller with no git access, non-forced) → ENQUEUE (conservative)", async () => {
  const { admin } = makeAdmin({ newestCompletedReview: completedReview(SHA_A) });
  const r = await enqueueSecurityReviewJob(admin as never, enqueueInput(null));
  assert.equal(r.enqueued, true, "an absent current SHA cannot prove currency — re-review");
});

test("dedup (2): no prior completed review → ENQUEUE (nothing to suppress against)", async () => {
  const { admin } = makeAdmin({ newestCompletedReview: null });
  const r = await enqueueSecurityReviewJob(admin as never, enqueueInput(SHA_A));
  assert.equal(r.enqueued, true);
});

// ── Fix #2 ────────────────────────────────────────────────────────────────────────────────────────
test("dedup (2): newest completed review has verdict='real-vuln' + same SHA → ENQUEUE (real-vuln never suppresses)", async () => {
  const { admin } = makeAdmin({ newestCompletedReview: completedReview(SHA_A, "real-vuln") });
  const r = await enqueueSecurityReviewJob(admin as never, enqueueInput(SHA_A));
  assert.equal(r.enqueued, true, "a real-vuln completed row must never satisfy the freshness skip");
});

test("dedup (2): real-vuln is case-insensitive + whitespace-tolerant (same tolerance as isRealVulnVerdict)", async () => {
  for (const verdict of ["REAL-VULN", " real-vuln ", "Real-Vuln"]) {
    const { admin } = makeAdmin({ newestCompletedReview: completedReview(SHA_A, verdict) });
    const r = await enqueueSecurityReviewJob(admin as never, enqueueInput(SHA_A));
    assert.equal(r.enqueued, true, `verdict=${JSON.stringify(verdict)} must never suppress`);
  }
});

test("dedup (2): verdict='clean' + same SHA → SKIP (a genuinely clean review for the current head is the whole point)", async () => {
  const { admin } = makeAdmin({ newestCompletedReview: completedReview(SHA_A, "clean") });
  const r = await enqueueSecurityReviewJob(admin as never, enqueueInput(SHA_A));
  assert.equal(r.enqueued, false);
});

test("dedup (2): verdict='false-positive' + same SHA → SKIP (false-positive = no vuln, same suppress class as clean)", async () => {
  const { admin } = makeAdmin({ newestCompletedReview: completedReview(SHA_A, "false-positive") });
  const r = await enqueueSecurityReviewJob(admin as never, enqueueInput(SHA_A));
  assert.equal(r.enqueued, false);
});

test("dedup (2): unparseable instructions on the newest completed row → ENQUEUE (conservative, cannot verify SHA)", async () => {
  const { admin } = makeAdmin({ newestCompletedReview: { instructions: "not json" } });
  const r = await enqueueSecurityReviewJob(admin as never, enqueueInput(SHA_A));
  assert.equal(r.enqueued, true);
});

// ── Guards preserved ──────────────────────────────────────────────────────────────────────────────
test("guard (0) still fires: latest build job is 'merged' → SKIP BEFORE the SHA comparison (branch deleted)", async () => {
  const { admin } = makeAdmin({
    lastBuildJob: { status: "merged", updated_at: "2026-08-17T14:05:00Z" },
    // Even a same-SHA suppressing review must not be reached — guard (0) short-circuits.
    newestCompletedReview: completedReview(SHA_A, "clean"),
  });
  const r = await enqueueSecurityReviewJob(admin as never, enqueueInput(SHA_A));
  assert.equal(r.enqueued, false);
  assert.match(String(r.reason ?? ""), /merged/i);
});

test("guard (1) still fires: an OPEN review already exists → SKIP BEFORE the SHA comparison", async () => {
  const { admin } = makeAdmin({
    openReviews: [{ id: "existing", status: "queued" }],
    // Even a different-SHA current head must not enqueue — guard (1) short-circuits.
    newestCompletedReview: completedReview(SHA_A, "clean"),
  });
  const r = await enqueueSecurityReviewJob(admin as never, enqueueInput(SHA_B));
  assert.equal(r.enqueued, false);
  assert.match(String(r.reason ?? ""), /already open/i);
});

test("force: true STILL bypasses dedup (2) — even a same-SHA clean review does not skip", async () => {
  const { admin, inserts } = makeAdmin({ newestCompletedReview: completedReview(SHA_A, "clean") });
  const r = await enqueueSecurityReviewJob(admin as never, enqueueInput(SHA_A, /* force */ true));
  assert.equal(r.enqueued, true, "retestOriginBranchSecurityIfFixMerged relies on force bypassing dedup (2)");
  assert.equal(inserts.length, 1);
});

test("force: true does NOT bypass guard (0) — a merged branch is still skipped (no deleted-ref reviews)", async () => {
  const { admin } = makeAdmin({
    lastBuildJob: { status: "merged", updated_at: "2026-08-17T14:05:00Z" },
    newestCompletedReview: completedReview(SHA_A, "clean"),
  });
  const r = await enqueueSecurityReviewJob(admin as never, enqueueInput(SHA_A, /* force */ true));
  assert.equal(r.enqueued, false);
  assert.match(String(r.reason ?? ""), /merged/i);
});

test("force: true does NOT bypass guard (1) — a live open review still blocks a duplicate enqueue", async () => {
  const { admin } = makeAdmin({
    openReviews: [{ id: "existing", status: "building" }],
    newestCompletedReview: completedReview(SHA_A, "clean"),
  });
  const r = await enqueueSecurityReviewJob(admin as never, enqueueInput(SHA_A, /* force */ true));
  assert.equal(r.enqueued, false);
  assert.match(String(r.reason ?? ""), /already open/i);
});

// ── Regression: the exact 2026-08-17 case-in-point ────────────────────────────────────────────────
test("2026-08-17 PR 2486 ground truth: real-vuln at 13:22 + merge commit d8727bf0 at 14:05 → re-review enqueues", async () => {
  // Under Phase 2, TWO independent fixes both point to "enqueue" for this case:
  //   Fix #1: the head SHA moved (merge commit d8727bf0 landed) — different SHA → re-review.
  //   Fix #2: the earlier verdict was real-vuln — never suppresses, regardless of SHA.
  // Both hold; either alone would flip the old wrong behavior.
  const reviewed = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // review at 13:22 covered this SHA
  const afterMerge = "d8727bf000000000000000000000000000000000"; // merge commit d8727bf0 at 14:05
  const { admin, inserts } = makeAdmin({
    newestCompletedReview: completedReview(reviewed, "real-vuln"),
  });
  const r = await enqueueSecurityReviewJob(admin as never, enqueueInput(afterMerge));
  assert.equal(r.enqueued, true);
  assert.equal(inserts.length, 1);
  const instr = JSON.parse(inserts[0].instructions) as SecurityBranchInstructions;
  assert.equal(instr.reviewed_head_sha, afterMerge, "Phase 1: the new review records the SHA it will cover");
});
