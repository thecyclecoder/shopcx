/**
 * Unit tests for `applyBoxCsDirectorCall` — the Phase-2-executor scaffold that materializes June's
 * verdicts (docs/brain/specs/cs-director-call-phase-2-executor-fires-june-verdicts.md Phase 1).
 *
 * Verification (each bullet mirrors the spec's Phase-1 Verification block):
 *   - `applyBoxCsDirectorCall` exists and returns { ok, handler } — called once per cs-director-call
 *     job after the Phase-1 record.
 *   - A verdict whose `decision` is `approve_remedy` / `author_spec` / `escalate_founder` routes to
 *     its handler (surfaced on `handler`).
 *   - Any other value is a logged no-op (`handler:'noop'`, `ok:true`) — never a crash / never a
 *     silent upgrade to an autonomous action.
 *
 * The mutator queries `agent_jobs` to guard against a wrong-kind job id (defensive shape check
 * mirroring `applyBoxDeployReview`). Stubbing the Supabase admin is enough for the routing
 * verification — the per-decision handlers are Phase-1 stubs (they log + return).
 *
 * Run:
 *   npx tsx --test src/lib/cs-director.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { applyBoxCsDirectorCall, type CsDirectorVerdictInput } from "./cs-director";

type Admin = Parameters<typeof applyBoxCsDirectorCall>[0];

function stubAdmin(row: { id: string; workspace_id: string; kind: string } | null): Admin {
  return {
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, _val: string) {
              return {
                async maybeSingle() {
                  return { data: row, error: null } as { data: typeof row; error: null };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Admin;
}

const CS_JOB_ROW = { id: "job-1", workspace_id: "ws-1", kind: "cs-director-call" as const };

test("approve_remedy routes to its handler", async () => {
  const admin = stubAdmin(CS_JOB_ROW);
  const verdict: CsDirectorVerdictInput = {
    decision: "approve_remedy",
    reasoning: "Portal changedate remedy is in-leash — restore next_billing_date to 2026-10-06 and message the customer.",
    remedy: { action_type: "change_next_date", summary: "restore requested date", payload: { next_billing_date: "2026-10-06" } },
  };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict);
  assert.equal(result.ok, true);
  assert.equal(result.handler, "approve_remedy");
});

test("author_spec routes to its handler", async () => {
  const admin = stubAdmin(CS_JOB_ROW);
  const verdict: CsDirectorVerdictInput = {
    decision: "author_spec",
    reasoning: "Two prior turns drifted on the same coupon path — the analyzer misses this class.",
    spec_seed: {
      slug: "cs-analyzer-coupon-gap",
      title: "Analyzer routes repeat-coupon tickets to remedy",
      intent: "route",
      problem: "analyzer skipped remedy path on repeat coupon",
    },
  };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict);
  assert.equal(result.ok, true);
  assert.equal(result.handler, "author_spec");
});

test("escalate_founder routes to its handler", async () => {
  const admin = stubAdmin(CS_JOB_ROW);
  const verdict: CsDirectorVerdictInput = {
    decision: "escalate_founder",
    reasoning: "Out-of-leash — grandfathered price lock on a $26.89 overcharge needs the CEO's ruling.",
    recommended_remedy: { kind: "refund_and_price_lock", summary: "Refund + restore the $33.01 grandfathered price before next renewal" },
  };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict);
  assert.equal(result.ok, true);
  assert.equal(result.handler, "escalate_founder");
});

test("a decision value outside the three literals is a clean no-op", async () => {
  const admin = stubAdmin(CS_JOB_ROW);
  // Cast through unknown — the runtime input can hit this state if `normalizeCsDirectorVerdict`
  // ever changes its defensive fallback (or a future caller bypasses it). The scaffold must never
  // crash or silently upgrade to an autonomous action.
  const verdict = { decision: "revert", reasoning: "should not route" } as unknown as CsDirectorVerdictInput;
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict);
  assert.equal(result.ok, true);
  assert.equal(result.handler, "noop");
});

test("a missing agent_jobs row surfaces as ok:false without throwing", async () => {
  const admin = stubAdmin(null);
  const verdict: CsDirectorVerdictInput = { decision: "approve_remedy", reasoning: "any" };
  const result = await applyBoxCsDirectorCall(admin, "job-missing", verdict);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "job_not_found");
});

test("a wrong-kind agent_jobs row surfaces as ok:false without throwing", async () => {
  const admin = stubAdmin({ id: "job-1", workspace_id: "ws-1", kind: "build" });
  const verdict: CsDirectorVerdictInput = { decision: "approve_remedy", reasoning: "any" };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "wrong_kind:build");
});
