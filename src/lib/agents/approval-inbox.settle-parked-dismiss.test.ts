/**
 * Unit tests for `settleParkedJobOnDismiss` — dismissing-a-park-card-closes-its-job Phase 1.
 *
 * THE GAP THIS PINS. Dismissing a CEO inbox card for a parked `agent_jobs` row only flipped
 * `dashboard_notifications.dismissed`; the job stayed needs_attention, so the needs-attention-route
 * backstop re-minted a fresh "Park Backstop" card within the hour (21 re-minted on 2026-10-13). A
 * dismiss must SETTLE the job — decline its pending actions, mark it completed with a recorded reason,
 * and (kind='repair') resolve the originating error_events signature — so a dismissed park stays dismissed.
 *
 * Run:  npx tsx --test src/lib/agents/approval-inbox.settle-parked-dismiss.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { settleParkedJobOnDismiss } from "./approval-inbox";

type Row = Record<string, unknown>;

/**
 * Minimal admin stub: serves the job read, captures the agent_jobs compare-and-set patch, the
 * error_events resolve, and the director_activity insert. `casRows` is what the CAS `.select("id")`
 * returns — `[]` models a job that already left the parked state between read and write.
 */
function fakeAdmin(job: Row | null, casRows: Row[] = [{ id: "job-1" }]) {
  const captured: {
    jobPatch: Row | null;
    errorEventsPatch: Row | null;
    errorEventsSignature: string | null;
    activity: Row | null;
  } = { jobPatch: null, errorEventsPatch: null, errorEventsSignature: null, activity: null };

  const admin = {
    from(table: string) {
      if (table === "agent_jobs") {
        let updating = false;
        const b: Record<string, unknown> = {};
        b.select = (..._a: unknown[]) => (updating ? Promise.resolve({ data: casRows, error: null }) : b);
        b.update = (patch: Row) => {
          updating = true;
          captured.jobPatch = patch;
          return b;
        };
        b.eq = () => b;
        b.in = () => b;
        b.maybeSingle = async () => ({ data: job, error: null });
        return b;
      }
      if (table === "error_events") {
        return {
          update(patch: Row) {
            captured.errorEventsPatch = patch;
            return {
              eq: async (_col: string, val: string) => {
                captured.errorEventsSignature = val;
                return { error: null };
              },
            };
          },
        };
      }
      // director_activity
      return {
        insert(row: Row) {
          captured.activity = row;
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { admin: admin as never, captured };
}

const parkedJob = {
  id: "job-1",
  kind: "cs-director-call",
  status: "needs_attention",
  spec_slug: null,
  pending_actions: [{ id: "a1", type: "spec", status: "pending" }],
};

test("settles a parked needs_attention job: completed + 'dismissed by owner', actions declined", async () => {
  const { admin, captured } = fakeAdmin({ ...parkedJob });
  const res = await settleParkedJobOnDismiss(admin, { workspace_id: "ws-1", metadata: { job_id: "job-1" } });
  assert.equal(res.settled, true);
  assert.equal(res.jobId, "job-1");
  assert.equal(captured.jobPatch?.status, "completed");
  assert.equal(captured.jobPatch?.error, "dismissed by owner");
  const actions = (captured.jobPatch?.pending_actions ?? []) as Row[];
  assert.equal(actions[0].status, "declined");
  assert.equal(captured.activity?.action_kind, "owner_dismissed_park");
});

test("also resolves agent_job_id metadata key (routed approval), not just job_id", async () => {
  const { admin, captured } = fakeAdmin({ ...parkedJob, status: "needs_approval" });
  const res = await settleParkedJobOnDismiss(admin, { workspace_id: "ws-1", metadata: { agent_job_id: "job-1" } });
  assert.equal(res.settled, true);
  assert.equal(captured.jobPatch?.status, "completed");
});

test("kind='repair' resolves the originating error_events signature with a recorded reason", async () => {
  const { admin, captured } = fakeAdmin({ ...parkedJob, kind: "repair", spec_slug: "vercel:boom-sig" });
  await settleParkedJobOnDismiss(admin, { workspace_id: "ws-1", metadata: { job_id: "job-1" } });
  assert.equal(captured.errorEventsPatch?.status, "resolved");
  assert.equal(captured.errorEventsPatch?.resolution_reason, "dismissed by owner");
  assert.equal(captured.errorEventsSignature, "vercel:boom-sig");
});

test("a non-repair job never touches error_events", async () => {
  const { admin, captured } = fakeAdmin({ ...parkedJob, kind: "cs-director-call", spec_slug: "some-spec" });
  await settleParkedJobOnDismiss(admin, { workspace_id: "ws-1", metadata: { job_id: "job-1" } });
  assert.equal(captured.errorEventsPatch, null);
});

test("no job id in metadata → no-op (never reads or writes)", async () => {
  const { admin, captured } = fakeAdmin(null);
  const res = await settleParkedJobOnDismiss(admin, { workspace_id: "ws-1", metadata: { foo: "bar" } });
  assert.equal(res.settled, false);
  assert.equal(res.reason, "no_job_id");
  assert.equal(captured.jobPatch, null);
});

test("a job already OUT of a parked state is left untouched (guard-before-mutation)", async () => {
  const { admin, captured } = fakeAdmin({ ...parkedJob, status: "completed" });
  const res = await settleParkedJobOnDismiss(admin, { workspace_id: "ws-1", metadata: { job_id: "job-1" } });
  assert.equal(res.settled, false);
  assert.ok(String(res.reason).startsWith("job_not_parked"));
  assert.equal(captured.jobPatch, null);
  assert.equal(captured.activity, null);
});

test("CAS flips zero rows (job moved on between read and write) → no error_events, no activity", async () => {
  const { admin, captured } = fakeAdmin({ ...parkedJob, kind: "repair", spec_slug: "vercel:x" }, []);
  const res = await settleParkedJobOnDismiss(admin, { workspace_id: "ws-1", metadata: { job_id: "job-1" } });
  assert.equal(res.settled, false);
  assert.equal(res.reason, "job_moved_on");
  assert.equal(captured.errorEventsPatch, null);
  assert.equal(captured.activity, null);
});

test("job not found → no-op", async () => {
  const { admin, captured } = fakeAdmin(null);
  const res = await settleParkedJobOnDismiss(admin, { workspace_id: "ws-1", metadata: { job_id: "job-1" } });
  assert.equal(res.settled, false);
  assert.equal(res.reason, "job_not_found");
  assert.equal(captured.jobPatch, null);
});
