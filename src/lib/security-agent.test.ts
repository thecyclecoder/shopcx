/**
 * Unit test for the `isRealVulnVerdict` predicate that gates `completedClean` in the three security
 * rollup helpers (`getSecurityStateBySlug`, `getSecurityStateForSlug`, `getSecurityStateForBranch`).
 *
 * security-escalation-carries-fix-spec-or-one-click-author-action Fix 1 — a real-vuln finding whose
 * fix was auto-queued (or approved via the Phase-1 `author_fix_spec` action) lands its
 * security-review row at `status='completed'`. Before this fix, the rollups read `status` only, so a
 * known-vulnerable branch/spec read as `completedClean = true` and could satisfy the M4 promote /
 * fold gate. The predicate below is now the SOLE toggle that rejects those rows.
 *
 * Pure — no DB, no I/O. Run: `npx tsx --test src/lib/security-agent.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isRealVulnVerdict } from "./security-agent";

test("isRealVulnVerdict — the exact real-vuln string rejects completedClean", () => {
  assert.equal(isRealVulnVerdict("real-vuln"), true);
});

test("isRealVulnVerdict — case-insensitive + whitespace-tolerant (persisted-JSON tolerance)", () => {
  assert.equal(isRealVulnVerdict("REAL-VULN"), true);
  assert.equal(isRealVulnVerdict(" real-vuln "), true);
  assert.equal(isRealVulnVerdict("Real-Vuln"), true);
});

test("isRealVulnVerdict — clean / false-positive / needs-human never trigger", () => {
  assert.equal(isRealVulnVerdict("clean"), false);
  assert.equal(isRealVulnVerdict("false-positive"), false);
  assert.equal(isRealVulnVerdict("needs-human"), false);
});

test("isRealVulnVerdict — absent / null / undefined / empty is conservative-clean (legacy pre-verdict rows)", () => {
  assert.equal(isRealVulnVerdict(""), false);
  assert.equal(isRealVulnVerdict(null), false);
  assert.equal(isRealVulnVerdict(undefined), false);
});

/**
 * security-review-decline-of-author-fix-spec-must-persist-real-vuln-verdict Phase 1 — pin the
 * rollup semantics for a DECLINED real-vuln author_fix_spec. The `author_fix_spec` action is only
 * parked when the underlying review verdict was `real-vuln`; a decline REJECTS THE AUTO-FIX, not
 * the finding — so the worker persists `instructions.verdict='real-vuln'` AND lands the job in a
 * SURFACED terminal state (`needs_attention`), never a bare `completed`. The three rollup
 * helpers must treat that row as NOT `completedClean` so the slug's Security signal stays RED.
 * Before this fix, the decline path wrote `status='completed'` with no verdict → the rollups
 * (which only consult status + `isRealVulnVerdict`) read the row as clean and the M4 promote /
 * fold gate turned green while the vulnerability still stood. A minimal in-memory admin fake
 * exercises the exact chain the rollups use.
 */
import {
  getSecurityStateBySlug,
  getSecurityStateForSlug,
  getSecurityStateForBranch,
  isLatestSecurityReviewGreen,
} from "./security-agent";

type StubRow = { spec_slug: string; status: string; instructions?: string; created_at?: string };

function makeAdmin(rows: StubRow[]) {
  const terminal = { data: rows, error: null };
  const chain: {
    from: (t: string) => typeof chain;
    select: (c: string) => typeof chain;
    eq: (col: string, val: unknown) => typeof chain;
    order: (col: string, opts?: { ascending?: boolean }) => typeof chain;
    limit: (n: number) => Promise<{ data: StubRow[]; error: null }>;
  } = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: async () => terminal,
  };
  return chain as unknown as Parameters<typeof getSecurityStateBySlug>[0];
}

test("rollup — a DECLINED real-vuln review (needs_attention + verdict=real-vuln) is NOT completedClean (slug stays security-RED)", async () => {
  const admin = makeAdmin([
    {
      spec_slug: "some-spec",
      status: "needs_attention",
      instructions: JSON.stringify({ mode: "diff", verdict: "real-vuln" }),
      created_at: "2026-07-23T00:00:00Z",
    },
  ]);
  const bySlug = await getSecurityStateBySlug(admin, "ws-1");
  assert.deepEqual(bySlug["some-spec"], { live: false, surfaced: true, completedClean: false });
  const forSlug = await getSecurityStateForSlug(admin, "ws-1", "some-spec");
  assert.deepEqual(forSlug, { live: false, surfaced: true, completedClean: false });
});

test("rollup — a bare completed row with NO verdict is NOT completedClean (security-review-lane-must-always-produce-a-verdict Phase 1: no verdict = RED)", async () => {
  const admin = makeAdmin([
    {
      spec_slug: "some-spec",
      status: "completed",
      instructions: JSON.stringify({ mode: "diff" }), // no verdict field — a review that never classified
      created_at: "2026-07-23T00:00:00Z",
    },
  ]);
  const bySlug = await getSecurityStateBySlug(admin, "ws-1");
  // Before Phase 1 the rollups read status + `isRealVulnVerdict` only, so a bare `completed` with no
  // verdict read as clean — the very gate-bypass a needs-human review flipped to completed exploited.
  // Now green requires a real `clean`/`false-positive` verdict on the latest row.
  assert.equal(bySlug["some-spec"]?.completedClean, false, "a review with no real verdict can never satisfy the promote/fold gate");
});

test("rollup — even a hypothetical completed + verdict=real-vuln is NOT completedClean (defense in depth alongside the surfaced status)", async () => {
  const admin = makeAdmin([
    {
      spec_slug: "some-spec",
      status: "completed",
      instructions: JSON.stringify({ mode: "diff", verdict: "real-vuln" }),
      created_at: "2026-07-23T00:00:00Z",
    },
  ]);
  const bySlug = await getSecurityStateBySlug(admin, "ws-1");
  assert.equal(bySlug["some-spec"]?.completedClean, false);
});

// ── security-review-lane-must-always-produce-a-verdict Phase 1 — GREEN means the LATEST review is clean ──

test("isLatestSecurityReviewGreen — latest clean / false-positive is green; needs-human / real-vuln / no-verdict / non-completed / empty is red", () => {
  // newest-first arrays (the rollups all query created_at desc)
  assert.equal(isLatestSecurityReviewGreen([{ status: "completed", verdict: "clean" }]), true);
  assert.equal(isLatestSecurityReviewGreen([{ status: "completed", verdict: "false-positive" }]), true);
  assert.equal(isLatestSecurityReviewGreen([{ status: "completed", verdict: "FALSE-POSITIVE" }]), true); // case-insensitive
  assert.equal(isLatestSecurityReviewGreen([{ status: "completed", verdict: "needs-human" }]), false);
  assert.equal(isLatestSecurityReviewGreen([{ status: "completed", verdict: "real-vuln" }]), false);
  assert.equal(isLatestSecurityReviewGreen([{ status: "completed", verdict: "" }]), false); // no verdict = red
  assert.equal(isLatestSecurityReviewGreen([{ status: "completed" }]), false); // missing verdict = red
  assert.equal(isLatestSecurityReviewGreen([{ status: "needs_attention", verdict: "needs-human" }]), false); // surfaced, no terminal verdict
  assert.equal(isLatestSecurityReviewGreen([{ status: "building" }]), false); // live, no verdict yet
  assert.equal(isLatestSecurityReviewGreen([]), false); // absence ≠ clean
});

test("rollup latest-row rule — older clean + NEWER needs-human (flipped to completed) = RED", async () => {
  // rows newest-first: the needs-human review ran AFTER the clean one, so it supersedes it.
  const admin = makeAdmin([
    { spec_slug: "s", status: "completed", instructions: JSON.stringify({ mode: "diff", verdict: "needs-human" }), created_at: "2026-10-08T00:00:00Z" },
    { spec_slug: "s", status: "completed", instructions: JSON.stringify({ mode: "diff", verdict: "clean" }), created_at: "2026-10-01T00:00:00Z" },
  ]);
  const bySlug = await getSecurityStateBySlug(admin, "ws-1");
  assert.equal(bySlug["s"]?.completedClean, false, "a newer needs-human review can never read green behind a stale clean one");
  const forSlug = await getSecurityStateForSlug(admin, "ws-1", "s");
  assert.equal(forSlug.completedClean, false);
});

test("rollup latest-row rule — older real-vuln + NEWER clean = GREEN (the fix re-reviewed clean)", async () => {
  const admin = makeAdmin([
    { spec_slug: "s", status: "completed", instructions: JSON.stringify({ mode: "diff", verdict: "clean" }), created_at: "2026-10-08T00:00:00Z" },
    { spec_slug: "s", status: "completed", instructions: JSON.stringify({ mode: "diff", verdict: "real-vuln" }), created_at: "2026-10-01T00:00:00Z" },
  ]);
  const bySlug = await getSecurityStateBySlug(admin, "ws-1");
  assert.equal(bySlug["s"]?.completedClean, true, "the latest review classified clean — the old real-vuln is superseded");
  const forSlug = await getSecurityStateForSlug(admin, "ws-1", "s");
  assert.equal(forSlug.completedClean, true);
});

test("getSecurityStateForBranch — latest-row rule applies to the pre-merge promote gate too", async () => {
  // newest-first: a clean review supersedes an earlier real-vuln → branch is green.
  const green = makeAdmin([
    { spec_slug: "s", status: "completed", instructions: JSON.stringify({ mode: "branch", verdict: "clean" }), created_at: "2026-10-08T00:00:00Z" },
    { spec_slug: "s", status: "completed", instructions: JSON.stringify({ mode: "branch", verdict: "real-vuln" }), created_at: "2026-10-01T00:00:00Z" },
  ]);
  assert.equal((await getSecurityStateForBranch(green, "claude/build-x")).completedClean, true);
  // newest-first: a needs-human park supersedes an earlier clean → branch is red.
  const red = makeAdmin([
    { spec_slug: "s", status: "completed", instructions: JSON.stringify({ mode: "branch", verdict: "needs-human" }), created_at: "2026-10-08T00:00:00Z" },
    { spec_slug: "s", status: "completed", instructions: JSON.stringify({ mode: "branch", verdict: "clean" }), created_at: "2026-10-01T00:00:00Z" },
  ]);
  assert.equal((await getSecurityStateForBranch(red, "claude/build-x")).completedClean, false);
});
