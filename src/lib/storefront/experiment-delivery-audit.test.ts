/**
 * Unit tests for the storefront experiment delivery audit
 * ([[../../../docs/brain/specs/growth-storefront-experiment-delivery-verification.md]] Phase 1).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:experiment-delivery-audit
 *   (= tsx --test src/lib/storefront/experiment-delivery-audit.test.ts)
 *
 * Covers the three verdict cases the spec names:
 *   1. older than MIN_AUDIT_AGE_HOURS + zero+zero → delivered:false, flags:['failed_to_deliver']
 *   2. older than MIN_AUDIT_AGE_HOURS + ≥1 of each → delivered:true
 *   3. younger than MIN_AUDIT_AGE_HOURS → delivered:null (excluded from the verdict)
 *
 * + a full-flow test on `auditExperimentDelivery` with a minimal in-memory admin stub
 * to assert the per-experiment shape AND that every running/promoted row receives a
 * result (the "never silently dropped" invariant in the prod-after-merge verification).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  auditExperimentDelivery,
  computeDeliveryVerdict,
  MIN_AUDIT_AGE_HOURS,
} from "./experiment-delivery-audit";

test("computeDeliveryVerdict: older than the floor + zero+zero ⇒ failed_to_deliver", () => {
  const v = computeDeliveryVerdict({ sessionsCount: 0, exposuresCount: 0, hoursSinceStart: MIN_AUDIT_AGE_HOURS + 1 });
  assert.deepEqual(v, { delivered: false, flags: ["failed_to_deliver"] });
});

test("computeDeliveryVerdict: older than the floor + ≥1 of each ⇒ delivered:true, no flags", () => {
  const v = computeDeliveryVerdict({ sessionsCount: 7, exposuresCount: 4, hoursSinceStart: 24 });
  assert.deepEqual(v, { delivered: true, flags: [] });
});

test("computeDeliveryVerdict: younger than the floor ⇒ delivered:null (excluded from verdict, never failed_to_deliver)", () => {
  const v = computeDeliveryVerdict({ sessionsCount: 0, exposuresCount: 0, hoursSinceStart: MIN_AUDIT_AGE_HOURS - 0.5 });
  assert.deepEqual(v, { delivered: null, flags: [] });
});

test("computeDeliveryVerdict: older + sessions-only (exposure event flaky) ⇒ delivered:true — session stamp is canonical", () => {
  const v = computeDeliveryVerdict({ sessionsCount: 5, exposuresCount: 0, hoursSinceStart: 24 });
  assert.deepEqual(v, { delivered: true, flags: [] });
});

test("computeDeliveryVerdict: older + exposures-only ⇒ delivered:true — any signal disproves silent failure", () => {
  const v = computeDeliveryVerdict({ sessionsCount: 0, exposuresCount: 3, hoursSinceStart: 24 });
  assert.deepEqual(v, { delivered: true, flags: [] });
});

test("computeDeliveryVerdict: opts.minAuditAgeHours override is honored", () => {
  const v = computeDeliveryVerdict({ sessionsCount: 0, exposuresCount: 0, hoursSinceStart: 2, minAuditAgeHours: 1 });
  assert.deepEqual(v, { delivered: false, flags: ["failed_to_deliver"] });
});

// ── full-flow test: a minimal admin stub that returns counts keyed by table + experiment id.

interface AdminStubCounts {
  sessions: Record<string, number>;
  exposures: Record<string, number>;
}

function makeAdminStub(opts: {
  experiments: Array<{ id: string; lander_type: string; started_at: string | null; created_at: string }>;
  counts: AdminStubCounts;
}) {
  return {
    from(table: string) {
      if (table === "storefront_experiments") {
        const builder = {
          _data: opts.experiments,
          select() {
            return builder;
          },
          eq() {
            return builder;
          },
          in() {
            return Promise.resolve({ data: opts.experiments, error: null });
          },
        };
        return builder;
      }
      if (table === "storefront_sessions" || table === "storefront_events") {
        let experimentId: string | null = null;
        const builder = {
          select() {
            return builder;
          },
          eq() {
            return builder;
          },
          gte() {
            return builder;
          },
          contains(_column: string, value: unknown) {
            // Production calls .contains("experiment_assignments", JSON.stringify([...])) —
            // the value arrives as a STRING, not an array. Parse the stringified form so the
            // stub matches production behaviour; then fall through to the object/array shapes.
            let parsed: unknown = value;
            if (typeof value === "string") {
              try { parsed = JSON.parse(value); } catch { /* leave as string */ }
            }
            if (Array.isArray(parsed)) {
              const first = parsed[0] as { experiment_id?: string } | undefined;
              experimentId = first?.experiment_id ?? null;
            } else if (parsed && typeof parsed === "object") {
              experimentId = (parsed as { experiment_id?: string }).experiment_id ?? null;
            }
            const map = table === "storefront_sessions" ? opts.counts.sessions : opts.counts.exposures;
            const count = experimentId ? (map[experimentId] ?? 0) : 0;
            return Promise.resolve({ count, error: null });
          },
        };
        return builder;
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

test("auditExperimentDelivery: returns one row per running/promoted experiment, in input order, with the right verdicts", async () => {
  const nowMs = new Date("2026-06-30T12:00:00.000Z").getTime();
  const longAgo = new Date(nowMs - 48 * 3_600_000).toISOString(); // 48h old
  const recent = new Date(nowMs - 2 * 3_600_000).toISOString(); // 2h old (younger than floor)

  const experiments = [
    { id: "exp-undelivered", lander_type: "advertorial", started_at: longAgo, created_at: longAgo },
    { id: "exp-delivered", lander_type: "listicle", started_at: longAgo, created_at: longAgo },
    { id: "exp-too-young", lander_type: "beforeafter", started_at: recent, created_at: recent },
  ];

  const admin = makeAdminStub({
    experiments,
    counts: {
      sessions: { "exp-delivered": 12 },
      exposures: { "exp-delivered": 9 },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await auditExperimentDelivery(admin as any, { workspaceId: "ws-1", nowMs });

  assert.equal(out.length, 3, "every running/promoted row receives an audit result — never silently dropped");
  assert.deepEqual(out[0], {
    experiment_id: "exp-undelivered",
    lander_type: "advertorial",
    sessions_count: 0,
    exposures_count: 0,
    delivered: false,
    flags: ["failed_to_deliver"],
  });
  assert.deepEqual(out[1], {
    experiment_id: "exp-delivered",
    lander_type: "listicle",
    sessions_count: 12,
    exposures_count: 9,
    delivered: true,
    flags: [],
  });
  assert.deepEqual(out[2], {
    experiment_id: "exp-too-young",
    lander_type: "beforeafter",
    sessions_count: 0,
    exposures_count: 0,
    delivered: null,
    flags: [],
  });
});

test("auditExperimentDelivery: zero experiments ⇒ empty result, no throw", async () => {
  const admin = makeAdminStub({ experiments: [], counts: { sessions: {}, exposures: {} } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await auditExperimentDelivery(admin as any, { workspaceId: "ws-1" });
  assert.deepEqual(out, []);
});
