/**
 * Unit tests for Phase 3 of
 * [[../../../docs/brain/specs/bianca-actually-graduates-crowned-winners-and-a-dead-meta-verb-cannot-fail-silently]].
 *
 * Pins the three named failing states the spec exists to prevent:
 *
 *   1. A cohort with NO eligible crowned winners MUST NOT escalate — a healthy
 *      quiet rail. Alerting on it would train the CEO to ignore the signal.
 *   2. A cohort with an eligible crowned winner AND no successful graduate in
 *      the bounded window MUST escalate — the silent-dead-rail condition.
 *   3. A second escalation on the SAME (workspace, cohort, day) MUST collapse
 *      to ONE card — dedupe on `metadata->>dedupe_key`.
 *
 * Also pins the pure formatter behavior consumed by the Growth Director digest.
 *
 * Run:
 *   npx tsx --test src/lib/media-buyer/cold-scaler-graduate-heartbeat.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  escalateColdScalerGraduateStall,
  formatCohortGraduateHeartbeatsForDigest,
  isCohortGraduateStalled,
  type CohortGraduateHeartbeat,
} from "./cold-scaler-graduate-heartbeat";
import { APPROVAL_REQUEST_TYPE } from "@/lib/agents/inbox";

type Row = {
  workspace_id: string;
  type: string;
  title: string;
  metadata: Record<string, unknown>;
};

/**
 * Minimal admin stub emulating `dashboard_notifications` INSERT + the dedupe
 * SELECT chain used by `escalateColdScalerGraduateStall`.
 * Supports:
 *   admin.from('dashboard_notifications')
 *     .select('id')
 *     .eq('workspace_id', X)
 *     .eq('type', APPROVAL_REQUEST_TYPE)
 *     .eq('metadata->>dedupe_key', K)
 *     .limit(1)
 *   admin.from('dashboard_notifications').insert({...})
 */
interface FakeChain {
  select: (cols?: string) => FakeChain;
  eq: (col: string, val: unknown) => FakeChain;
  limit: (n: number) => FakeChain;
  then: (
    onFulfilled: (v: { data: Array<{ id: string }>; error: null }) => unknown,
  ) => Promise<unknown>;
  insert: (row: {
    workspace_id: string;
    type: string;
    title: string;
    body: string;
    link: string;
    metadata: Record<string, unknown>;
    read: boolean;
    dismissed: boolean;
  }) => Promise<{ error: null }>;
}

interface FakeAdmin {
  rows: Row[];
  from: (table: string) => FakeChain;
}

function makeAdmin(seed: Row[] = []): FakeAdmin {
  const rows: Row[] = [...seed];
  return {
    rows,
    from(table: string): FakeChain {
      if (table !== "dashboard_notifications") throw new Error(`unexpected table: ${table}`);
      const filters: Array<{ col: string; val: unknown }> = [];
      const chain: FakeChain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters.push({ col, val });
          return chain;
        },
        limit: () => chain,
        then: (onFulfilled) => {
          const dedupeKeyFilter = filters.find((f) => f.col === "metadata->>dedupe_key");
          const workspaceFilter = filters.find((f) => f.col === "workspace_id");
          const typeFilter = filters.find((f) => f.col === "type");
          const matches = rows
            .filter(
              (r) =>
                (!workspaceFilter || r.workspace_id === workspaceFilter.val) &&
                (!typeFilter || r.type === typeFilter.val) &&
                (!dedupeKeyFilter ||
                  (r.metadata?.dedupe_key as string | undefined) === dedupeKeyFilter.val),
            )
            .map((_, i) => ({ id: `row-${i}` }));
          return Promise.resolve({ data: matches, error: null as null }).then(onFulfilled);
        },
        insert: (row) => {
          rows.push({
            workspace_id: row.workspace_id,
            type: row.type,
            title: row.title,
            metadata: row.metadata,
          });
          return Promise.resolve({ error: null });
        },
      };
      return chain;
    },
  };
}

function heartbeat(overrides: Partial<CohortGraduateHeartbeat> = {}): CohortGraduateHeartbeat {
  return {
    cohortId: "80ad4acc-1111-2222-3333-444444444444",
    metaAdAccountId: "acct-uuid-1",
    productId: "prod-uuid-1",
    scalerMetaCampaignId: "120249609991450682",
    lastGraduatedAt: null,
    lastSkippedAt: null,
    lastSkipReason: null,
    eligibleWinnerCount: 0,
    ...overrides,
  };
}

// ── State (1) — NO eligible winners must NEVER escalate ──────────────────────

test("isCohortGraduateStalled: zero eligible winners → NOT stalled (healthy quiet rail)", () => {
  assert.equal(isCohortGraduateStalled(heartbeat({ eligibleWinnerCount: 0 })), false);
});

test("escalateColdScalerGraduateStall: zero eligible winners → NO card inserted", async () => {
  const admin = makeAdmin();
  const r = await escalateColdScalerGraduateStall(admin as unknown as Parameters<typeof escalateColdScalerGraduateStall>[0], {
    workspaceId: "ws-1",
    heartbeat: heartbeat({ eligibleWinnerCount: 0 }),
    nowMs: Date.parse("2026-08-01T12:00:00Z"),
  });
  assert.equal(r.emitted, false);
  assert.match(r.reason ?? "", /not stalled/);
  assert.equal(admin.rows.length, 0, "no dashboard_notifications insert on a quiet cohort");
});

// ── State (2) — eligible winner + never graduated → MUST escalate ────────────

test("isCohortGraduateStalled: eligible winner + never graduated → stalled", () => {
  assert.equal(
    isCohortGraduateStalled(heartbeat({ eligibleWinnerCount: 2, lastGraduatedAt: null })),
    true,
  );
});

test("isCohortGraduateStalled: eligible winner + recent graduate → NOT stalled", () => {
  // A graduate in window proves the rail alive — no need to alert.
  assert.equal(
    isCohortGraduateStalled(
      heartbeat({
        eligibleWinnerCount: 1,
        lastGraduatedAt: "2026-07-30T12:00:00Z",
      }),
    ),
    false,
  );
});

test("escalateColdScalerGraduateStall: eligible + never graduated → ONE card inserted with typed metadata", async () => {
  const admin = makeAdmin();
  const r = await escalateColdScalerGraduateStall(admin as unknown as Parameters<typeof escalateColdScalerGraduateStall>[0], {
    workspaceId: "ws-1",
    heartbeat: heartbeat({
      eligibleWinnerCount: 2,
      lastSkippedAt: "2026-07-25T12:00:00Z",
      lastSkipReason: "not_armed",
    }),
    nowMs: Date.parse("2026-08-01T12:00:00Z"),
  });
  assert.equal(r.emitted, true);
  assert.equal(admin.rows.length, 1);
  const row = admin.rows[0];
  assert.equal(row.workspace_id, "ws-1");
  assert.equal(row.type, APPROVAL_REQUEST_TYPE);
  assert.match(row.title, /Cold-scaler cohort 80ad4acc/);
  assert.match(row.title, /2 crowned winners/);
  assert.equal(row.metadata.escalation_kind, "cold_scaler_graduate_stall");
  assert.equal(row.metadata.routed_to_function, "ceo");
  assert.equal(row.metadata.escalated_by_director, "growth");
  assert.equal(row.metadata.cohort_id, "80ad4acc-1111-2222-3333-444444444444");
  assert.equal(row.metadata.eligible_winner_count, 2);
  assert.equal(row.metadata.last_skip_reason, "not_armed");
  assert.equal(row.metadata.window_days, 7);
  assert.equal(row.metadata.dedupe_key, "cold_scaler_graduate_stall:ws-1:80ad4acc-1111-2222-3333-444444444444:2026-08-01");
});

// ── State (3) — same-day duplicate collapses to ONE card ─────────────────────

test("escalateColdScalerGraduateStall: same-day second call → dedupe (no second insert)", async () => {
  const admin = makeAdmin();
  const inputs = {
    workspaceId: "ws-1",
    heartbeat: heartbeat({ eligibleWinnerCount: 1 }),
    nowMs: Date.parse("2026-08-01T09:00:00Z"),
  };
  const first = await escalateColdScalerGraduateStall(admin as unknown as Parameters<typeof escalateColdScalerGraduateStall>[0], inputs);
  const second = await escalateColdScalerGraduateStall(admin as unknown as Parameters<typeof escalateColdScalerGraduateStall>[0], {
    ...inputs,
    nowMs: Date.parse("2026-08-01T21:00:00Z"), // same UTC day
  });
  assert.equal(first.emitted, true);
  assert.equal(second.emitted, false);
  assert.match(second.reason ?? "", /same-day duplicate/);
  assert.equal(admin.rows.length, 1, "same-day duplicate must not insert a second card");
});

test("escalateColdScalerGraduateStall: next UTC day escalates independently", async () => {
  const admin = makeAdmin();
  const base = {
    workspaceId: "ws-1",
    heartbeat: heartbeat({ eligibleWinnerCount: 1 }),
  };
  const first = await escalateColdScalerGraduateStall(admin as unknown as Parameters<typeof escalateColdScalerGraduateStall>[0], {
    ...base,
    nowMs: Date.parse("2026-08-01T21:00:00Z"),
  });
  const second = await escalateColdScalerGraduateStall(admin as unknown as Parameters<typeof escalateColdScalerGraduateStall>[0], {
    ...base,
    nowMs: Date.parse("2026-08-02T09:00:00Z"), // NEXT UTC day
  });
  assert.equal(first.emitted, true);
  assert.equal(second.emitted, true);
  assert.equal(admin.rows.length, 2);
});

// ── Digest formatter ─────────────────────────────────────────────────────────

test("formatCohortGraduateHeartbeatsForDigest: empty heartbeats → no lines", () => {
  assert.deepEqual(formatCohortGraduateHeartbeatsForDigest([]), []);
});

test("formatCohortGraduateHeartbeatsForDigest: never-graduated + eligible → shows the last skip reason", () => {
  const lines = formatCohortGraduateHeartbeatsForDigest(
    [heartbeat({ eligibleWinnerCount: 2, lastSkipReason: "not_armed" })],
    Date.parse("2026-08-01T12:00:00Z"),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /cohort 80ad4acc/);
  assert.match(lines[0], /last graduated never/);
  assert.match(lines[0], /2 eligible winners/);
  assert.match(lines[0], /last skip: not_armed/);
});

test("formatCohortGraduateHeartbeatsForDigest: recent graduate → shows age, no skip suffix", () => {
  const lines = formatCohortGraduateHeartbeatsForDigest(
    [
      heartbeat({
        eligibleWinnerCount: 0,
        lastGraduatedAt: "2026-07-30T12:00:00Z",
      }),
    ],
    Date.parse("2026-08-01T12:00:00Z"),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /last graduated 2d ago/);
  assert.match(lines[0], /0 eligible winners/);
  assert.doesNotMatch(lines[0], /last skip/);
});

test("formatCohortGraduateHeartbeatsForDigest: 1 eligible → singular label", () => {
  const lines = formatCohortGraduateHeartbeatsForDigest(
    [heartbeat({ eligibleWinnerCount: 1 })],
    Date.parse("2026-08-01T12:00:00Z"),
  );
  assert.match(lines[0], /1 eligible winner\b/);
});
