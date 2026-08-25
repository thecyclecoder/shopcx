/**
 * creative-scout-job — pins the `agent_jobs` row shape `enqueueCreativeScoutJob` inserts.
 *
 * The regression this locks: `agent_jobs.spec_slug` is `NOT NULL`, so an insert missing it
 * fails at the DB boundary and no scout work is queued. A fake supabase chain captures the
 * insert payload so the assertion is exact (workspace_id, kind, status, instructions JSON,
 * and the stable `spec_slug`) — no pooler, no network.
 *
 * Runs via: npx tsx --test src/lib/ads/creative-scout-job.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  enqueueCreativeScoutJob,
  CREATIVE_SCOUT_KIND,
  CREATIVE_SCOUT_SPEC_SLUG,
} from "./creative-scout-job";

interface CapturedInsert {
  table: string;
  row: Record<string, unknown>;
}

/** Fake admin — records the insert body and returns a synthetic id. The inflight query returns
 *  no rows so the dedup gate short-circuits and the insert path always runs. */
function makeFakeAdmin(): { admin: unknown; captured: CapturedInsert[] } {
  const captured: CapturedInsert[] = [];
  const admin = {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            eq() {
              return this;
            },
            in() {
              return this;
            },
            limit() {
              return Promise.resolve({ data: [] as unknown[], error: null });
            },
          };
        },
        insert(row: Record<string, unknown>) {
          captured.push({ table, row });
          return {
            select(_cols: string) {
              return {
                single() {
                  return Promise.resolve({ data: { id: `job-${captured.length}` }, error: null });
                },
              };
            },
          };
        },
      };
    },
  };
  return { admin, captured };
}

test("the exposed slug constant is a stable, non-empty string (the DB rejects null)", () => {
  assert.equal(typeof CREATIVE_SCOUT_SPEC_SLUG, "string");
  assert.ok(CREATIVE_SCOUT_SPEC_SLUG.length > 0);
});

test("insert payload carries workspace_id, kind, status, instructions JSON, and the stable spec_slug", async () => {
  const { admin, captured } = makeFakeAdmin();
  const result = await enqueueCreativeScoutJob(
    { workspaceId: "ws-1", productId: "prod-42", force: true },
    admin as never,
  );

  assert.deepEqual(result, { enqueued: true, jobId: "job-1" });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.table, "agent_jobs");

  const row = captured[0]!.row;
  assert.equal(row.workspace_id, "ws-1");
  assert.equal(row.kind, CREATIVE_SCOUT_KIND);
  assert.equal(row.status, "queued");
  assert.equal(row.spec_slug, CREATIVE_SCOUT_SPEC_SLUG);

  // The instructions blob is a JSON string the box worker re-parses.
  assert.equal(typeof row.instructions, "string");
  const parsed = JSON.parse(row.instructions as string) as Record<string, unknown>;
  assert.deepEqual(parsed, { workspaceId: "ws-1", productId: "prod-42", force: true });
});

test("the productId is optional — omitted input still stamps a non-null spec_slug", async () => {
  const { admin, captured } = makeFakeAdmin();
  await enqueueCreativeScoutJob({ workspaceId: "ws-1" }, admin as never);

  const row = captured[0]!.row;
  assert.equal(row.spec_slug, CREATIVE_SCOUT_SPEC_SLUG);
  assert.ok(row.spec_slug, "spec_slug must be truthy so the NOT NULL insert doesn't fail");

  const parsed = JSON.parse(row.instructions as string) as Record<string, unknown>;
  assert.equal(parsed.productId, null);
  assert.equal(parsed.force, false);
});
