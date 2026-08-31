/**
 * drift-suspect-runs-the-audit-it-recommends Phase 1 — pins the three branches of
 * `flagShippedWithoutProvenance` in [[./platform-director]]:
 *
 *   (1) enqueue succeeded (queued OR dedup='open') → detector acts (a `drift_suspect_audit_queued`
 *       activity row is written) and NO CEO escalation.
 *   (2) enqueue deduped as `recent_terminal` (an audit ran within 24h and could not resolve) →
 *       escalation still raised (this is the load-bearing "genuinely ambiguous" case).
 *   (3) enqueue THREW → escalation still raised (fail-open: never swallow a drift signal because
 *       the repair path errored).
 *
 * The last two branches are load-bearing — this change must NEVER turn a real phantom ship into
 * silence. The stubs assert both the CEO card and the activity ledger row for each branch.
 *
 *   npx tsx --test src/lib/agents/platform-director.drift-autorepair.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { flagShippedWithoutProvenance } from "./platform-director";
import type { SpecCard } from "@/lib/brain-roadmap";

// Minimal SpecCard fixture with two shipped, tagless phases (the drift-suspect condition).
function makeCard(slug = "phantom-slug"): SpecCard {
  return {
    slug,
    title: "Phantom slug",
    status: "shipped",
    summary: "",
    phases: [
      { title: "P1", status: "shipped", pr: null, merge_sha: null },
      { title: "P2", status: "shipped", pr: null, merge_sha: null },
    ],
    counts: { planned: 0, in_progress: 0, shipped: 2, rejected: 0 },
    blockedBy: [],
    repairSignature: false,
  };
}

type ActivityRow = { actionKind: string; specSlug?: string | null; metadata?: Record<string, unknown>; reason: string };
type EscalationCall = { escalationKind: string; dedupeKey: string; diagnosis: string; metadata?: Record<string, unknown> };

function makeStubs(opts: {
  enqueueResult?: { enqueued: true; jobId: string } | { enqueued: false; dedup: "open" | "recent_terminal"; existingJobId: string };
  enqueueThrows?: Error;
}) {
  const activityRows: ActivityRow[] = [];
  const escalations: EscalationCall[] = [];
  const enqueueCalls: Array<{ workspaceId: string; slug: string; opts: { requestedBy: string; reason: string } }> = [];

  const enqueueAudit = (async (workspaceId: string, slug: string, o: { requestedBy: string; reason: string }) => {
    enqueueCalls.push({ workspaceId, slug, opts: o });
    if (opts.enqueueThrows) throw opts.enqueueThrows;
    return opts.enqueueResult!;
  }) as never; // typed as never because the test cast satisfies the deps parameter shape

  const escalateFn = (async (_admin: unknown, args: EscalationCall) => {
    escalations.push({
      escalationKind: args.escalationKind,
      dedupeKey: args.dedupeKey,
      diagnosis: args.diagnosis,
      metadata: args.metadata,
    });
    return { emitted: true };
  }) as never;

  const recordActivityFn = (async (
    _admin: unknown,
    input: { actionKind: string; specSlug?: string | null; metadata?: Record<string, unknown>; reason: string },
  ) => {
    activityRows.push({
      actionKind: input.actionKind,
      specSlug: input.specSlug,
      metadata: input.metadata,
      reason: input.reason,
    });
    return { recorded: true };
  }) as never;

  return { enqueueAudit, escalateFn, recordActivityFn, activityRows, escalations, enqueueCalls };
}

test("branch (1a) — enqueue QUEUED a fresh audit → detector records `drift_suspect_audit_queued` and does NOT escalate", async () => {
  const stubs = makeStubs({ enqueueResult: { enqueued: true, jobId: "audit-job-abcdef12" } });
  const card = makeCard();
  await flagShippedWithoutProvenance({} as never, "ws-1", card, "test-lane", {
    enqueueAudit: stubs.enqueueAudit,
    escalateFn: stubs.escalateFn,
    recordActivityFn: stubs.recordActivityFn,
  });
  // The repair path fired first with the right slug + workspace + requestedBy.
  assert.equal(stubs.enqueueCalls.length, 1);
  assert.equal(stubs.enqueueCalls[0].workspaceId, "ws-1");
  assert.equal(stubs.enqueueCalls[0].slug, card.slug);
  assert.equal(stubs.enqueueCalls[0].opts.requestedBy, "platform-director:drift-suspect");
  // No CEO card was raised — the audit is doing the work.
  assert.equal(stubs.escalations.length, 0);
  // Detector-acted activity row was written with the audit_job_id + audit_dedup=null (fresh enqueue).
  assert.equal(stubs.activityRows.length, 1);
  assert.equal(stubs.activityRows[0].actionKind, "drift_suspect_audit_queued");
  assert.equal(stubs.activityRows[0].specSlug, card.slug);
  assert.equal(stubs.activityRows[0].metadata?.audit_job_id, "audit-job-abcdef12");
  assert.equal(stubs.activityRows[0].metadata?.audit_dedup, null);
  assert.deepEqual(stubs.activityRows[0].metadata?.drift_suspect_phase_indices, [0, 1]);
});

test("branch (1b) — enqueue deduped as 'open' (audit already in flight) → detector records `drift_suspect_audit_queued` and does NOT escalate", async () => {
  const stubs = makeStubs({ enqueueResult: { enqueued: false, dedup: "open", existingJobId: "in-flight-audit-1" } });
  const card = makeCard();
  await flagShippedWithoutProvenance({} as never, "ws-1", card, "test-lane", {
    enqueueAudit: stubs.enqueueAudit,
    escalateFn: stubs.escalateFn,
    recordActivityFn: stubs.recordActivityFn,
  });
  assert.equal(stubs.escalations.length, 0);
  assert.equal(stubs.activityRows.length, 1);
  assert.equal(stubs.activityRows[0].actionKind, "drift_suspect_audit_queued");
  assert.equal(stubs.activityRows[0].metadata?.audit_job_id, "in-flight-audit-1");
  assert.equal(stubs.activityRows[0].metadata?.audit_dedup, "open");
});

test("branch (2) — audit RAN RECENTLY and phase is STILL tagless (dedup='recent_terminal') → escalation IS raised (load-bearing)", async () => {
  const stubs = makeStubs({
    enqueueResult: { enqueued: false, dedup: "recent_terminal", existingJobId: "prior-audit-xyz98765" },
  });
  const card = makeCard();
  await flagShippedWithoutProvenance({} as never, "ws-1", card, "test-lane", {
    enqueueAudit: stubs.enqueueAudit,
    escalateFn: stubs.escalateFn,
    recordActivityFn: stubs.recordActivityFn,
  });
  // Escalation raised — this is the genuinely ambiguous case a human must decide.
  assert.equal(stubs.escalations.length, 1);
  assert.equal(stubs.escalations[0].escalationKind, "drift_suspect");
  assert.equal(stubs.escalations[0].dedupeKey, `drift:${card.slug}`);
  assert.match(stubs.escalations[0].diagnosis, /audit-spec-shipped-state.*ran.*could not re-derive/i);
  assert.equal(stubs.escalations[0].metadata?.audit_state, "ran_and_unresolved");
  assert.equal(stubs.escalations[0].metadata?.prior_audit_job_id, "prior-audit-xyz98765");
  // Companion activity row is `drift_suspect_flagged` (the fallback path).
  const flagged = stubs.activityRows.find((r) => r.actionKind === "drift_suspect_flagged");
  assert.ok(flagged, "expected a drift_suspect_flagged activity row on the escalate path");
  assert.equal(flagged!.metadata?.audit_state, "ran_and_unresolved");
  // The detector-acted `drift_suspect_audit_queued` row must NOT be written on the escalate path.
  assert.equal(stubs.activityRows.filter((r) => r.actionKind === "drift_suspect_audit_queued").length, 0);
});

test("branch (3) — enqueue THREW → escalation IS raised (fail-open, never swallow a drift signal)", async () => {
  const stubs = makeStubs({ enqueueThrows: new Error("db down") });
  const card = makeCard();
  await flagShippedWithoutProvenance({} as never, "ws-1", card, "test-lane", {
    enqueueAudit: stubs.enqueueAudit,
    escalateFn: stubs.escalateFn,
    recordActivityFn: stubs.recordActivityFn,
  });
  assert.equal(stubs.escalations.length, 1);
  assert.equal(stubs.escalations[0].escalationKind, "drift_suspect");
  assert.match(stubs.escalations[0].diagnosis, /audit enqueue itself errored.*db down/i);
  assert.equal(stubs.escalations[0].metadata?.audit_state, "enqueue_error");
  // Companion activity row is `drift_suspect_flagged` on the escalate path.
  const flagged = stubs.activityRows.find((r) => r.actionKind === "drift_suspect_flagged");
  assert.ok(flagged, "expected a drift_suspect_flagged activity row on the enqueue-error escalate path");
  assert.equal(flagged!.metadata?.audit_state, "enqueue_error");
});
