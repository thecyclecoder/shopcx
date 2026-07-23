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

test("rollup — the OLD decline shape (bare completed, no verdict persisted) would have read as completedClean — the gate-bypass this Phase 1 closes", async () => {
  const admin = makeAdmin([
    {
      spec_slug: "some-spec",
      status: "completed",
      instructions: JSON.stringify({ mode: "diff" }), // no verdict field — pre-fix decline shape
      created_at: "2026-07-23T00:00:00Z",
    },
  ]);
  const bySlug = await getSecurityStateBySlug(admin, "ws-1");
  assert.equal(bySlug["some-spec"]?.completedClean, true, "pre-fix decline was silently clean — this test documents the regression the Phase 1 decline-writer change prevents by never producing this row shape");
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
