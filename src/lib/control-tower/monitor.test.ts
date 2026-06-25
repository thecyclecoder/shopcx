/**
 * Unit tests for the cron-expression parser + first-scheduled-firing computation
 * (control-tower-cron-grace-uses-next-firing-after-registration spec, Phase 1).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/control-tower/monitor.test.ts
 *
 * Focus: the originating false page (security-dep-watch `0 4 * * *` with
 * registeredAt 00:00 UTC) and the common cron shapes used across the registry.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { evalAgentKind, extractCronExpr, jobStuckSince, nextFiringAtOrAfter, parseCronExpr, type ActiveJob } from "./monitor";
import type { MonitoredLoop } from "./registry";

test("extractCronExpr pulls the 5-field expression from expectedCadence", () => {
  assert.equal(extractCronExpr("daily (0 4 * * *)"), "0 4 * * *");
  assert.equal(extractCronExpr("hourly (30 * * * *)"), "30 * * * *");
  assert.equal(extractCronExpr("every 5 min (*/5 * * * *)"), "*/5 * * * *");
  assert.equal(extractCronExpr("every ~30 min (20,50 * * * *)"), "20,50 * * * *");
  assert.equal(extractCronExpr("every minute (* * * * *)"), "* * * * *");
});

test("extractCronExpr returns null for non-Inngest cadences (box jobs, polls)", () => {
  assert.equal(extractCronExpr("every ~30 min (box job)"), null);
  assert.equal(extractCronExpr("polls every ~5s"), null);
  assert.equal(extractCronExpr("daily (box job)"), null);
});

test("parseCronExpr handles literals, lists, wildcards, and steps", () => {
  const daily4am = parseCronExpr("0 4 * * *");
  assert.ok(daily4am);
  assert.deepEqual([...daily4am!.minute], [0]);
  assert.deepEqual([...daily4am!.hour], [4]);
  assert.equal(daily4am!.dayOfMonth.size, 31);
  assert.equal(daily4am!.dayOfWeek.size, 7);

  const every5 = parseCronExpr("*/5 * * * *");
  assert.ok(every5);
  assert.equal(every5!.minute.size, 12);
  assert.ok(every5!.minute.has(0));
  assert.ok(every5!.minute.has(55));
  assert.equal(every5!.minute.has(3), false);

  const twiceHourly = parseCronExpr("20,50 * * * *");
  assert.ok(twiceHourly);
  assert.deepEqual([...twiceHourly!.minute].sort((a, b) => a - b), [20, 50]);
});

test("parseCronExpr rejects malformed expressions", () => {
  assert.equal(parseCronExpr("0 4 * *"), null);
  assert.equal(parseCronExpr("0 99 * * *"), null);
  assert.equal(parseCronExpr("box job"), null);
});

test("nextFiringAtOrAfter returns the cron's first firing at-or-after a timestamp", () => {
  // The originating false-page case: daily `0 4 * * *` with registeredAt 2026-06-24T00:00:00Z
  // → first scheduled firing is 2026-06-24T04:00:00Z (the SAME day, 4h later), NOT 2026-06-24T00:00:00Z.
  const firstFiring = nextFiringAtOrAfter(new Date("2026-06-24T00:00:00Z"), "0 4 * * *");
  assert.equal(firstFiring?.toISOString(), "2026-06-24T04:00:00.000Z");

  // The deploy-slipped-past-the-tick case the spec describes: same cron, registeredAt 04:08
  // (deploy landed 8 minutes after the daily tick) → the next firing is the FOLLOWING day at 04:00.
  const slipped = nextFiringAtOrAfter(new Date("2026-06-24T04:08:00Z"), "0 4 * * *");
  assert.equal(slipped?.toISOString(), "2026-06-25T04:00:00.000Z");

  // Exact-match boundary: registeredAt exactly at a firing time matches THAT firing, not the next.
  const onTheDot = nextFiringAtOrAfter(new Date("2026-06-24T04:00:00Z"), "0 4 * * *");
  assert.equal(onTheDot?.toISOString(), "2026-06-24T04:00:00.000Z");
});

test("nextFiringAtOrAfter handles every-N-minute crons", () => {
  // `*/15 * * * *` with registeredAt at :07 → next firing :15.
  const fiveMin = nextFiringAtOrAfter(new Date("2026-06-24T10:07:00Z"), "*/15 * * * *");
  assert.equal(fiveMin?.toISOString(), "2026-06-24T10:15:00.000Z");
});

test("nextFiringAtOrAfter handles two-firings-per-hour lists", () => {
  // `20,50 * * * *` with registeredAt at :30 → next firing :50 same hour.
  const next = nextFiringAtOrAfter(new Date("2026-06-24T10:30:00Z"), "20,50 * * * *");
  assert.equal(next?.toISOString(), "2026-06-24T10:50:00.000Z");
});

test("nextFiringAtOrAfter returns null for unparseable expressions", () => {
  assert.equal(nextFiringAtOrAfter(new Date(), "box job"), null);
  assert.equal(nextFiringAtOrAfter(new Date(), "0 4 * *"), null);
});

// ─── Worker-restart clamp for queued stuck-jobs (control-tower-stuck-jobs-clamp-on-worker-restart) ───

const queuedJob = (overrides: Partial<ActiveJob> = {}): ActiveJob => ({
  id: "c9974936-0000-0000-0000-000000000000",
  kind: "spec-test",
  status: "queued",
  created_at: "2026-06-25T10:45:00Z",
  claimed_at: null,
  updated_at: "2026-06-25T10:45:00Z",
  ...overrides,
});

test("jobStuckSince clamps queued floor to worker_heartbeats.started_at when base is older", () => {
  // The originating incident: job enqueued at 10:45 during a worker-down window; the worker came
  // up at 11:45. The stuck-since floor should be 11:45 (worker boot), not 10:45 (created_at).
  const j = queuedJob({ created_at: "2026-06-25T10:45:00Z", updated_at: "2026-06-25T10:45:00Z" });
  assert.equal(jobStuckSince(j, "2026-06-25T11:45:23Z"), "2026-06-25T11:45:23Z");
});

test("jobStuckSince keeps the base when the queued job is newer than the worker boot", () => {
  // A genuinely-stuck queued job (enqueued AFTER the worker came up) should report its own
  // updated_at — not the worker boot — so a real stuck lane still alerts.
  const j = queuedJob({ created_at: "2026-06-25T12:30:00Z", updated_at: "2026-06-25T12:30:00Z" });
  assert.equal(jobStuckSince(j, "2026-06-25T11:45:00Z"), "2026-06-25T12:30:00Z");
});

test("jobStuckSince does NOT clamp building/claimed jobs (claimed_at already reflects worker)", () => {
  // claimed_at can't precede the worker that claimed it — no clamp needed; preserves prior behavior.
  const claimed = queuedJob({ status: "claimed", claimed_at: "2026-06-25T11:50:00Z" });
  assert.equal(jobStuckSince(claimed, "2026-06-25T11:45:00Z"), "2026-06-25T11:50:00Z");
  const building = queuedJob({ status: "building", claimed_at: "2026-06-25T11:55:00Z" });
  assert.equal(jobStuckSince(building, "2026-06-25T11:45:00Z"), "2026-06-25T11:55:00Z");
});

test("jobStuckSince falls back to base when workerStartedAt is null/empty/malformed", () => {
  // Null worker boot (no heartbeat row) → preserve prior behavior (no clamp) so a missing reference
  // never lifts a real stuck-since forward.
  const j = queuedJob({ created_at: "2026-06-25T10:45:00Z", updated_at: "2026-06-25T10:45:00Z" });
  assert.equal(jobStuckSince(j, null), "2026-06-25T10:45:00Z");
  assert.equal(jobStuckSince(j, ""), "2026-06-25T10:45:00Z");
  assert.equal(jobStuckSince(j, "not-a-date"), "2026-06-25T10:45:00Z");
});

test("jobStuckSince clamps queued_resume the same way as queued", () => {
  // queued_resume = a worker died mid-build; the next worker can't have claimed earlier than it
  // started either, so the same clamp applies.
  const j = queuedJob({ status: "queued_resume", created_at: "2026-06-25T10:00:00Z", updated_at: "2026-06-25T10:00:00Z" });
  assert.equal(jobStuckSince(j, "2026-06-25T11:45:00Z"), "2026-06-25T11:45:00Z");
});

const agentKindLoop: MonitoredLoop = {
  id: "agent:spec-test",
  kind: "agent-kind",
  owner: "platform",
  label: "Spec-test agent",
  description: "spec-test agent kind",
  expectedCadence: "on demand",
  agentKind: "spec-test",
  stuckThresholdMs: 60 * 60_000,
};

test("evalAgentKind stays green when an old queued backlog drains under fresh worker uptime", () => {
  // Reproduces the originating false-page exactly: 8 spec-test jobs enqueued at 10:45 (during a
  // worker-down window), worker started_at 11:45:23, monitor checks at 12:00 (15 min into the
  // post-restart drain). Without the clamp every job reads 75 min stuck → red. With the clamp the
  // floor is 11:45 → 15 min < the 60-min threshold → green.
  const enqueuedAt = "2026-06-25T10:45:00Z";
  const queued: ActiveJob[] = Array.from({ length: 8 }, (_, i) => queuedJob({
    id: `c997493${i}-0000-0000-0000-000000000000`,
    created_at: enqueuedAt,
    updated_at: enqueuedAt,
  }));
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-06-25T12:00:00Z");
  try {
    const result = evalAgentKind(agentKindLoop, null, queued, "2026-06-25T11:45:23Z");
    assert.equal(result.color, "green");
    assert.equal(result.violation, null);
  } finally {
    Date.now = realNow;
  }
});

test("evalAgentKind still flags genuinely-stuck queued jobs after a long post-restart drain", () => {
  // The same backlog, but checked 2 hours after the worker came up: 75 min stuck (relative to
  // the worker boot floor) > 60 min threshold → red. The clamp grants a fair drain window, not
  // a free pass.
  const queued: ActiveJob[] = [queuedJob({ created_at: "2026-06-25T10:45:00Z", updated_at: "2026-06-25T10:45:00Z" })];
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-06-25T13:00:00Z");
  try {
    const result = evalAgentKind(agentKindLoop, null, queued, "2026-06-25T11:45:00Z");
    assert.equal(result.color, "red");
    assert.equal(result.violation?.reason, "stuck_jobs");
  } finally {
    Date.now = realNow;
  }
});
