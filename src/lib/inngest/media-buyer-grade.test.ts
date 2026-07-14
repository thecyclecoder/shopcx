/**
 * Unit tests for the per-workspace media-buyer-grade sweep — the pure
 * `dispatchMediaBuyerGradeSweep` helper the Inngest handler wraps. Focused
 * regression coverage for the `spec_slug` NOT NULL insert boundary (the
 * 2026-07-14 outage — Control Tower signature `inngest:c54fe7cef7e4a4ff`),
 * mirroring the [[./ad-creative-cadence.test]] shape.
 *
 * Run:
 *   npx tsx --test src/lib/inngest/media-buyer-grade.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  dispatchMediaBuyerGradeSweep,
  mediaBuyerGradeSpecSlug,
  MEDIA_BUYER_GRADE_DEFAULT_LIMIT,
  MEDIA_BUYER_GRADE_SPEC_SLUG,
} from "./media-buyer-grade";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function makeAdmin(tables: Tables) {
  return {
    from(table: string) {
      return {
        insert: async (row: Row | Row[]) => {
          const arr = tables[table] ?? (tables[table] = []);
          const rows = Array.isArray(row) ? row : [row];
          if (table === "agent_jobs") {
            // Simulate the DB NOT NULL constraint on spec_slug — the exact
            // insert failure Inngest signature `inngest:c54fe7cef7e4a4ff` captured.
            for (const r of rows) {
              const slug = (r as Row).spec_slug;
              if (typeof slug !== "string" || slug.length === 0) {
                return {
                  data: null,
                  error: {
                    message:
                      'null value in column "spec_slug" of relation "agent_jobs" violates not-null constraint',
                  },
                };
              }
            }
          }
          const asRow = (r: Row): Row => ({
            id: `job-${arr.length + 1}`,
            status: "queued",
            created_at: "2026-07-14T14:00:00.000Z",
            ...r,
          });
          for (const r of rows) arr.push(asRow(r));
          return { data: null, error: null };
        },
      };
    },
  } as unknown as Parameters<typeof dispatchMediaBuyerGradeSweep>[0];
}

const WS = "ws-1";

test("mediaBuyerGradeSpecSlug — stable, workspace-scoped, non-empty", () => {
  assert.equal(mediaBuyerGradeSpecSlug(), "media-buyer-grade:workspace");
  assert.equal(mediaBuyerGradeSpecSlug(), MEDIA_BUYER_GRADE_SPEC_SLUG);
  assert.ok(mediaBuyerGradeSpecSlug().length > 0);
});

test("dispatchMediaBuyerGradeSweep — inserted row carries spec_slug, kind='media-buyer-grade', instructions.limit=default", async () => {
  const tables: Tables = { agent_jobs: [] };
  const admin = makeAdmin(tables);
  const r = await dispatchMediaBuyerGradeSweep(admin, WS);
  assert.equal(r.dispatched, 1);
  assert.equal(tables.agent_jobs.length, 1);
  const [job] = tables.agent_jobs;
  assert.equal(
    job.spec_slug,
    "media-buyer-grade:workspace",
    "spec_slug must satisfy the NOT NULL constraint with the stable workspace-scoped bucket",
  );
  assert.equal(job.kind, "media-buyer-grade");
  assert.equal(job.workspace_id, WS);
  const instr = JSON.parse(String(job.instructions));
  assert.equal(instr.limit, MEDIA_BUYER_GRADE_DEFAULT_LIMIT);
});

test("dispatchMediaBuyerGradeSweep — omitting spec_slug throws the NOT NULL constraint error (regression guard)", async () => {
  // If a future refactor drops the slug from the insert, the fake admin returns
  // the exact Postgres NOT NULL error string, dispatchMediaBuyerGradeSweep
  // throws, and this test fails — the same boundary Vercel logged as
  // `inngest:c54fe7cef7e4a4ff` on 2026-07-14.
  const tables: Tables = { agent_jobs: [] };
  const bareAdmin = {
    from() {
      return {
        insert: async () => ({
          data: null,
          error: {
            message:
              'null value in column "spec_slug" of relation "agent_jobs" violates not-null constraint',
          },
        }),
      };
    },
  } as unknown as Parameters<typeof dispatchMediaBuyerGradeSweep>[0];
  await assert.rejects(
    () => dispatchMediaBuyerGradeSweep(bareAdmin, WS),
    /spec_slug.*not-null constraint/,
  );
  assert.equal(tables.agent_jobs.length, 0);
});
