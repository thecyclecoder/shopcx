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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyShaDirectionLocal,
  countRenewalIntegrityOverdueSubs,
  countSegmentStaleTail,
  countStuckDunningCycles,
  SEGMENT_COVERAGE_POST_CRON_UPDATE_GRACE,
  SEGMENT_COVERAGE_STALE_TAIL_RUN_GRACE,
  evalAgentKind,
  evalCron,
  evalInlineAgent,
  evalOutputAssertion,
  evalWorker,
  extractCronExpr,
  extractSolHandleBypassTicketIds,
  SOL_HANDLE_BYPASS_REASONS,
  firstScheduledFiringMs,
  FRAUD_DETECTOR_HEARTBEAT_COALESCE_GRACE_MS,
  INTERNAL_RENEWAL_ORDER_SOURCE_NAMES,
  isBoxEmittedCronLoop,
  isOrderAwaitingFraudScreen,
  isWorkerUnavailable,
  orderIsInsideFraudCoalesceCoverage,
  jobStuckSince,
  nextFiringAtOrAfter,
  parseCronExpr,
  type ActiveJob,
  type AssertionInputs,
  type InlineAgentState,
  type LoopHistoryRow,
  type WorkerRow,
} from "./monitor";
import { INLINE_AGENT_IDS, MONITORED_LOOPS, type MonitoredLoop } from "./registry";
import { SPEC_TEST_FIXTURES } from "@/lib/spec-test-sandbox";
import type { createAdminClient } from "@/lib/supabase/admin";

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

// ─── Worker-unavailable suppression of child-agent stuck reds
// (control-tower-suppress-agent-stuck-during-worker-outage Phase 1) ───

test("isWorkerUnavailable is true when the worker has no row, no last_poll_at, is stale, or needs_attention", () => {
  const livenessWindowMs = 5 * 60_000;
  const now = Date.parse("2026-07-16T12:00:00Z");
  const realNow = Date.now;
  Date.now = () => now;
  try {
    // No row (never reported).
    assert.equal(isWorkerUnavailable(null, livenessWindowMs), true);
    // Row exists but no last_poll_at.
    assert.equal(isWorkerUnavailable({ running_sha: null, status: "ok", active_builds: 0, detail: null, last_poll_at: null, started_at: null, accounts: null }, livenessWindowMs), true);
    // Stale — last poll 30 min ago, window 5 min.
    assert.equal(isWorkerUnavailable({ running_sha: null, status: "ok", active_builds: 0, detail: null, last_poll_at: "2026-07-16T11:30:00Z", started_at: null, accounts: null }, livenessWindowMs), true);
    // Crash-loop.
    assert.equal(isWorkerUnavailable({ running_sha: null, status: "needs_attention", active_builds: 0, detail: "crash-loop", last_poll_at: "2026-07-16T11:59:00Z", started_at: null, accounts: null }, livenessWindowMs), true);
    // Healthy — last poll 1 min ago.
    assert.equal(isWorkerUnavailable({ running_sha: null, status: "ok", active_builds: 0, detail: null, last_poll_at: "2026-07-16T11:59:00Z", started_at: null, accounts: null }, livenessWindowMs), false);
  } finally {
    Date.now = realNow;
  }
});

test("evalAgentKind suppresses stuck_jobs on queued/queued_resume rows when the worker is unavailable", () => {
  // The originating false-page: the box worker is stale, so a healthy pr-resolve lane has a
  // stack of queued jobs waiting on the SAME parent outage. Opening a stuck_jobs red on the
  // pr-resolve tile just duplicates the box `liveness` page and points at the wrong root cause.
  const prResolveLoop: MonitoredLoop = {
    id: "agent:pr-resolve",
    kind: "agent-kind",
    owner: "platform",
    label: "PR resolve agent",
    description: "pr-resolve agent kind",
    expectedCadence: "on demand",
    agentKind: "pr-resolve",
    stuckThresholdMs: 60 * 60_000,
  };
  const enqueuedAt = "2026-07-16T09:00:00Z"; // 3h before now — well past the 60-min threshold.
  const queued: ActiveJob[] = [
    { id: "aaaaaaaa-0000-0000-0000-000000000000", kind: "pr-resolve", status: "queued", created_at: enqueuedAt, claimed_at: null, updated_at: enqueuedAt },
    { id: "bbbbbbbb-0000-0000-0000-000000000000", kind: "pr-resolve", status: "queued_resume", created_at: enqueuedAt, claimed_at: null, updated_at: enqueuedAt },
  ];
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-07-16T12:00:00Z");
  try {
    // Worker unavailable → the queued rows are attributed to the worker outage. No stuck_jobs red.
    const suppressed = evalAgentKind(prResolveLoop, null, queued, null, true);
    assert.notEqual(suppressed.color, "red");
    assert.equal(suppressed.violation, null);
  } finally {
    Date.now = realNow;
  }
});

test("evalAgentKind keeps building/claimed stuck reds even when the worker is unavailable", () => {
  // A queued-only backlog is waiting on the parent outage — suppress. But a job the worker
  // ALREADY claimed and is midway through (or that got stuck in the `building` status) is a
  // lane-specific defect: the outage predicate doesn't let it hide. This is the seam that
  // keeps the guard from becoming a blanket "skip all stuck detection when the worker is down."
  const specTestLoop: MonitoredLoop = {
    id: "agent:spec-test",
    kind: "agent-kind",
    owner: "platform",
    label: "Spec-test agent",
    description: "spec-test agent kind",
    expectedCadence: "on demand",
    agentKind: "spec-test",
    stuckThresholdMs: 60 * 60_000,
  };
  const claimedAt = "2026-07-16T09:00:00Z";
  const claimed: ActiveJob[] = [
    { id: "cccccccc-0000-0000-0000-000000000000", kind: "spec-test", status: "building", created_at: claimedAt, claimed_at: claimedAt, updated_at: claimedAt },
  ];
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-07-16T12:00:00Z");
  try {
    const result = evalAgentKind(specTestLoop, null, claimed, null, true);
    assert.equal(result.color, "red");
    assert.equal(result.violation?.reason, "stuck_jobs");
  } finally {
    Date.now = realNow;
  }
});

test("evalAgentKind renders amber/off for a switched-off queued lane before stuck_jobs aging (blocked_off precedes stuck)", () => {
  // control-tower-agent-kind-switch-off-precedes-stuck-jobs Phase 1 — the originating false-page:
  // the ad-creative kill switch is on, the worker refuses to claim, writeSuppressedClaimHeartbeats
  // has stamped `{blocked_off:true, offBy:'ad-creative', scope:'agent'}` as the latest beat, and a
  // queued ad-creative job sits in the queue past the 60-min threshold. Before this fix `stuck_jobs`
  // was evaluated first, so the CEO's explicit switch-off read as a red incident. The fix reorders
  // so the authoritative control-plane state is honored: amber/off, no violation.
  const adCreativeLoop: MonitoredLoop = {
    id: "agent:ad-creative",
    kind: "agent-kind",
    owner: "growth",
    label: "Ad-creative agent",
    description: "ad-creative agent kind",
    expectedCadence: "on demand",
    agentKind: "ad-creative",
    stuckThresholdMs: 60 * 60_000,
  };
  const enqueuedAt = "2026-08-16T09:00:00Z"; // 3h before now — well past the 60-min threshold.
  const queued: ActiveJob[] = [
    { id: "eeeeeeee-0000-0000-0000-000000000000", kind: "ad-creative", status: "queued", created_at: enqueuedAt, claimed_at: null, updated_at: enqueuedAt },
  ];
  const blockedOffBeat: LoopHistoryRow = {
    ran_at: "2026-08-16T11:59:00Z",
    ok: true,
    produced: { blocked_off: true, offBy: "ad-creative", scope: "agent" },
    detail: null,
    duration_ms: null,
  };
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-08-16T12:00:00Z");
  try {
    // Healthy worker so the worker-outage guard is off — the ONLY thing keeping this lane out of
    // red is the reordered blocked_off precedence. workerStartedAt older than enqueuedAt so the
    // stuck clamp wouldn't lift the floor either.
    const result = evalAgentKind(adCreativeLoop, blockedOffBeat, queued, "2026-08-16T08:00:00Z", false);
    assert.equal(result.color, "amber");
    assert.equal(result.violation, null);
    assert.match(result.statusText, /off by ad-creative \(agent\)/);
  } finally {
    Date.now = realNow;
  }
});

test("evalAgentKind still flags a genuinely-stuck queued lane once the switch is lifted (no free pass)", () => {
  // The mirror-image regression guard: if the latest beat is NOT a blocked_off beat (e.g. the
  // switch was removed and a normal completion beat overwrote it), the queued row past the
  // threshold must STILL trip stuck_jobs on the very next tick. The reorder must not become a
  // silent free-pass for lanes that were once switched off.
  const adCreativeLoop: MonitoredLoop = {
    id: "agent:ad-creative",
    kind: "agent-kind",
    owner: "growth",
    label: "Ad-creative agent",
    description: "ad-creative agent kind",
    expectedCadence: "on demand",
    agentKind: "ad-creative",
    stuckThresholdMs: 60 * 60_000,
  };
  const enqueuedAt = "2026-08-16T09:00:00Z";
  const queued: ActiveJob[] = [
    { id: "ffffffff-0000-0000-0000-000000000000", kind: "ad-creative", status: "queued", created_at: enqueuedAt, claimed_at: null, updated_at: enqueuedAt },
  ];
  // Latest beat is a normal completion (no blocked_off), so the switched-off precedence does NOT
  // apply and the stuck-job path must run.
  const normalBeat: LoopHistoryRow = { ran_at: "2026-08-16T11:59:00Z", ok: true, produced: { ok: true }, detail: null, duration_ms: null };
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-08-16T12:00:00Z");
  try {
    const result = evalAgentKind(adCreativeLoop, normalBeat, queued, "2026-08-16T08:00:00Z", false);
    assert.equal(result.color, "red");
    assert.equal(result.violation?.reason, "stuck_jobs");
  } finally {
    Date.now = realNow;
  }
});

test("evalAgentKind still flags queued stuck jobs when the worker is healthy (regression guard)", () => {
  // The existing behavior — the guard must ONLY suppress when the worker really is unavailable.
  // A healthy worker + a queued row past its threshold is a genuinely-wedged lane and must still
  // page. This is the "healthy-worker case still returns red" the spec's verification calls for.
  const enqueuedAt = "2026-07-16T09:00:00Z";
  const queued: ActiveJob[] = [
    { id: "dddddddd-0000-0000-0000-000000000000", kind: "spec-test", status: "queued", created_at: enqueuedAt, claimed_at: null, updated_at: enqueuedAt },
  ];
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-07-16T12:00:00Z");
  try {
    // workerStartedAt older than enqueuedAt so the clamp doesn't lift the floor above the threshold,
    // workerUnavailable=false so the new guard is off — the queued job is 3h past the 60-min threshold.
    const result = evalAgentKind(agentKindLoop, null, queued, "2026-07-16T08:00:00Z", false);
    assert.equal(result.color, "red");
    assert.equal(result.violation?.reason, "stuck_jobs");
  } finally {
    Date.now = realNow;
  }
});

// ─── Observed-first-seen anchor for registered_not_firing grace ───
// (control-tower-registered-not-firing-observed-anchor-grace spec, Phase 1)

const fleetSpendGovernorLoop: MonitoredLoop = {
  id: "fleet-spend-governor",
  kind: "cron",
  owner: "platform",
  label: "Fleet spend governor",
  description: "Reads each effective fleet_budgets row vs the fleet-cost rollup → escalates a lane/function over its ceiling.",
  expectedCadence: "every ~30 min (10,40 * * * *)",
  livenessWindowMs: 90 * 60_000,
  // Hand-edited to early-midnight BEFORE the cron actually shipped — the originating false-page case.
  registeredAt: "2026-06-25T00:00:00Z",
};

test("firstScheduledFiringMs without an observed anchor returns the computed first firing", () => {
  // No firstObservedMs: same behavior as before — computes 00:10 (the first `10,40 * * * *` tick
  // at-or-after registeredAt 00:00).
  const ms = firstScheduledFiringMs(fleetSpendGovernorLoop);
  assert.equal(ms, Date.parse("2026-06-25T00:10:00Z"));
});

test("firstScheduledFiringMs takes the MAX of computed-first-firing and the observed anchor", () => {
  // The fleet-spend-governor case: registeredAt 00:00 hand-edited (cron computes 00:10), but the
  // monitor first SAW the loop at 09:30 (the deploy actually landed that morning). The grace clock
  // must anchor to the LATER value (09:30), not the hand-edited pre-existence one (00:10), so the
  // 90-min window doesn't evaporate before the cron has had any chance to fire.
  const firstObservedMs = Date.parse("2026-06-25T09:30:00Z");
  const ms = firstScheduledFiringMs(fleetSpendGovernorLoop, firstObservedMs);
  assert.equal(ms, firstObservedMs);
});

test("firstScheduledFiringMs ignores an observed anchor that's EARLIER than the computed first firing", () => {
  // A first-seen older than the computed first firing means the loop has been registered for at
  // least as long as registeredAt implies — keep the computed value, don't pull the grace back.
  const firstObservedMs = Date.parse("2026-06-24T23:00:00Z");
  const ms = firstScheduledFiringMs(fleetSpendGovernorLoop, firstObservedMs);
  assert.equal(ms, Date.parse("2026-06-25T00:10:00Z"));
});

test("firstScheduledFiringMs falls back to the observed anchor when registeredAt is absent", () => {
  // A loop without registeredAt (legacy crons) still gets a grace anchor from first-observed when
  // available — the empirical anchor is itself a sufficient grace clock.
  const legacy: MonitoredLoop = { ...fleetSpendGovernorLoop, registeredAt: undefined };
  const firstObservedMs = Date.parse("2026-06-25T09:30:00Z");
  assert.equal(firstScheduledFiringMs(legacy, firstObservedMs), firstObservedMs);
  // No registeredAt + no observed ⇒ no grace clock (caller skips the registeredAt gate).
  assert.equal(firstScheduledFiringMs(legacy), null);
});

test("evalCron HOLDS AMBER for fleet-spend-governor when registeredAt is hand-edited early but first_observed_at is recent", () => {
  // The fleet-spend-governor false-page case end-to-end:
  //   - registeredAt 2026-06-25T00:00:00Z (hand-edited early-midnight)
  //   - cadence `10,40 * * * *` → computed first firing 2026-06-25T00:10:00Z
  //   - livenessWindowMs 90 min
  //   - first_observed_at 2026-06-25T09:30:00Z (the deploy actually landed mid-morning)
  //   - watchdog has been alive 30h ⇒ monitorUptimeMs WOULD trip the deploy-independent gate
  //   - 0 beats ever (latest=null, everBeatCount=0)
  // "Now" is 2026-06-25T10:00:00Z — only 30 min since first_observed_at, well inside the 90-min
  // grace. WITHOUT the observed-anchor fix: sinceFirstFiringMs = 10:00 − 00:10 = 9h50m > 90m,
  // so the grace check fails and monitorUptimeMs > window flips the tile RED registered_not_firing.
  // WITH the fix: max(00:10, 09:30) = 09:30, sinceFirstFiringMs = 30 min ≤ 90m, grace HOLDS → AMBER.
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-06-25T10:00:00Z");
  try {
    const firstObservedMs = Date.parse("2026-06-25T09:30:00Z");
    const monitorUptimeMs = 30 * 60 * 60_000; // 30h — would otherwise be enough to fire registered_not_firing
    const result = evalCron(fleetSpendGovernorLoop, null, null, 0, false, monitorUptimeMs, firstObservedMs);
    assert.equal(result.color, "amber");
    assert.equal(result.violation, null);
    assert.match(result.statusText, /awaiting first run/);
  } finally {
    Date.now = realNow;
  }
});

test("evalCron WITHOUT the observed anchor would still false-page fleet-spend-governor (regression guard)", () => {
  // Same scenario as above WITHOUT firstObservedMs (firstObservedMs=null) — locks in that the
  // observed-anchor fix is what's holding the grace. Pre-fix: 9h50m since computed first firing,
  // well past the 90-min grace, so the deploy-independent monitorUptimeMs gate flips it RED.
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-06-25T10:00:00Z");
  try {
    const monitorUptimeMs = 30 * 60 * 60_000;
    const result = evalCron(fleetSpendGovernorLoop, null, null, 0, false, monitorUptimeMs, null);
    assert.equal(result.color, "red");
    assert.equal(result.violation?.reason, "registered_not_firing");
  } finally {
    Date.now = realNow;
  }
});

test("evalCron still flips RED for a genuinely-dead cron once the observed-anchor grace itself expires", () => {
  // Same loop, but "now" is 24h after first_observed_at — well past the 90-min grace, watchdog alive
  // 30h, 0 beats ever. The empirical anchor grants a fair window, not a free pass: a cron that's
  // been observed registered for a full window and still hasn't beaten is the real registered_not_firing.
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-06-26T09:30:00Z");
  try {
    const firstObservedMs = Date.parse("2026-06-25T09:30:00Z");
    const monitorUptimeMs = 30 * 60 * 60_000;
    const result = evalCron(fleetSpendGovernorLoop, null, null, 0, false, monitorUptimeMs, firstObservedMs);
    assert.equal(result.color, "red");
    assert.equal(result.violation?.reason, "registered_not_firing");
  } finally {
    Date.now = realNow;
  }
});

// ─── Newcron grace gates BOTH reds (received-sms-rollup-cron-heartbeat Phase 3 Fix 2) ───
// A newly-registered cron whose box worker has been up for > window (deployAgeMs > window)
// used to trip `never_fired` before the awaiting-first-tick grace could fire — the exact
// received-sms-rollup-cron regression where Fix 1's registeredAt landed but the tile still went
// RED never_fired because `deployAgeMs > window` was checked first. Fix 2 reorders evalCron so
// the grace check gates BOTH never_fired AND registered_not_firing, matching the intent of the
// per-loop reference ("how long has this loop been registered") on both anchors.
const receivedSmsRollupLoop: MonitoredLoop = {
  id: "received-sms-rollup-cron",
  kind: "cron",
  owner: "platform",
  label: "Received SMS rollup",
  description: "Moves delivered SMS recipients into profile_events for segmentation + campaign reporting.",
  expectedCadence: "every 5 min (*/5 * * * *)",
  livenessWindowMs: 20 * 60_000,
  registeredAt: "2026-07-09T04:00:00Z",
};

test("evalCron HOLDS AMBER for received-sms-rollup-cron when registeredAt is fresh but deployAgeMs and monitorUptimeMs are past window (Fix 2)", () => {
  // The received-sms-rollup-cron Fix-2 regression scenario end-to-end:
  //   - registeredAt 2026-07-09T04:00:00Z (fresh anchor Fix 2 lands on)
  //   - cadence `*/5 * * * *` → computed first firing 04:00
  //   - livenessWindowMs 20 min
  //   - first_observed_at 2026-07-09T00:35:00Z (loop entry landed earlier that morning)
  //   - deployAgeMs 6h — the box worker restarted 6h ago and has been up on this SHA since;
  //     under the pre-Fix-2 ordering this WOULD flip the tile RED never_fired.
  //   - watchdog has been alive 30h → monitorUptimeMs > window
  //   - 0 beats ever (latest=null, everBeatCount=0)
  // "Now" is 2026-07-09T04:05:00Z — only 5 min past registeredAt-firing, well inside the 20-min
  // grace. Fix 2 reordering: the grace check runs BEFORE never_fired / registered_not_firing, so
  // both reds are skipped and the tile stays AMBER "awaiting first run" until the first beat lands.
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-07-09T04:05:00Z");
  try {
    const firstObservedMs = Date.parse("2026-07-09T00:35:00Z");
    const deployAgeMs = 6 * 60 * 60_000; // 6h — well past 20-min window
    const monitorUptimeMs = 30 * 60 * 60_000; // 30h — well past 20-min window
    const result = evalCron(receivedSmsRollupLoop, null, deployAgeMs, 0, false, monitorUptimeMs, firstObservedMs);
    assert.equal(result.color, "amber");
    assert.equal(result.violation, null);
    assert.match(result.statusText, /awaiting first run/);
  } finally {
    Date.now = realNow;
  }
});

test("evalCron still flips RED never_fired once the newcron grace itself expires (Fix 2 regression guard)", () => {
  // Same loop, but "now" is well past the 20-min grace window. deployAgeMs > window remains > window
  // → the reordered evalCron falls through the grace check and hits the never_fired red. Confirms
  // the reorder doesn't muzzle a genuinely-dead cron; it only holds amber while the grace is live.
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-07-09T05:00:00Z");
  try {
    const firstObservedMs = Date.parse("2026-07-09T00:35:00Z");
    const deployAgeMs = 6 * 60 * 60_000;
    const result = evalCron(receivedSmsRollupLoop, null, deployAgeMs, 0, false, null, firstObservedMs);
    assert.equal(result.color, "red");
    assert.equal(result.violation?.reason, "never_fired");
  } finally {
    Date.now = realNow;
  }
});

// ─── Queue-aware self-update deferral (control-tower-self-update-tile-queue-aware) ───
// evalWorker mirrors scripts/builder-worker.ts:4290 — an idle worker BEHIND origin/main
// while {queued, queued_resume} > 0 is intentionally parking its self-update until a
// sustained idle. Reading that as "self-update stuck" was the monitor false positive
// (signal loop:box). A MANUAL queue restart (drain_for_update=true) is the explicit
// "restart at idle regardless of the queue" lever — so it still reds at grace.

const workerLoop: MonitoredLoop = {
  id: "box",
  kind: "worker",
  owner: "platform",
  label: "Box build worker",
  description: "The self-hosted build worker poll loop.",
  expectedCadence: "polls every ~5s",
  livenessWindowMs: 5 * 60_000,
  shaGraceMs: 30 * 60_000,
};

const idleBehindWorker = (overrides: Partial<WorkerRow> = {}): WorkerRow => ({
  running_sha: "aaaaaaa",
  status: null,
  active_builds: 0,
  detail: null,
  last_poll_at: "2026-06-25T11:59:55Z",
  // started_at well past the 30-min shaGraceMs so the only thing keeping it green is queue/drain.
  started_at: "2026-06-25T10:00:00Z",
  accounts: null,
  ...overrides,
});

test("evalWorker stays GREEN with update-deferred status when behind+idle but queued > 0 and no manual drain", () => {
  // The loop:box false-positive case: SHA behind origin/main, box at idle, but builds are queued
  // for back-to-back specs — the worker intentionally parks its self-update so it doesn't restart
  // between specs. Must NOT be a red.
  const realEnv = process.env.VERCEL_GIT_COMMIT_SHA;
  const realNow = Date.now;
  process.env.VERCEL_GIT_COMMIT_SHA = "bbbbbbbcccccccc";
  Date.now = () => Date.parse("2026-06-25T12:00:00Z");
  try {
    const result = evalWorker(workerLoop, idleBehindWorker(), 3, false, "worker-behind");
    assert.equal(result.color, "green");
    assert.equal(result.violation, null);
    assert.match(result.statusText, /update deferred · 3 queued/);
  } finally {
    Date.now = realNow;
    if (realEnv === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = realEnv;
  }
});

test("evalWorker flips RED at shaGrace when behind+idle and queue is empty (no defer)", () => {
  // Empty backlog ⇒ no excuse for parking the self-update. shaGrace exhausted ⇒ the real
  // "self-update stuck" condition we still want to page on.
  const realEnv = process.env.VERCEL_GIT_COMMIT_SHA;
  const realNow = Date.now;
  process.env.VERCEL_GIT_COMMIT_SHA = "bbbbbbbcccccccc";
  Date.now = () => Date.parse("2026-06-25T12:00:00Z");
  try {
    const result = evalWorker(workerLoop, idleBehindWorker(), 0, false, "worker-behind");
    assert.equal(result.color, "red");
    assert.equal(result.violation?.reason, "liveness");
    assert.match(result.statusText, /behind origin\/main/);
  } finally {
    Date.now = realNow;
    if (realEnv === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = realEnv;
  }
});

test("evalWorker flips RED at shaGrace under a MANUAL drain regardless of queued count", () => {
  // worker_controls.drain_for_update=true means the CEO explicitly wants the box to restart at
  // idle ignoring the queue — so a queued backlog DOES NOT defer the red.
  const realEnv = process.env.VERCEL_GIT_COMMIT_SHA;
  const realNow = Date.now;
  process.env.VERCEL_GIT_COMMIT_SHA = "bbbbbbbcccccccc";
  Date.now = () => Date.parse("2026-06-25T12:00:00Z");
  try {
    const result = evalWorker(workerLoop, idleBehindWorker(), 5, true, "worker-behind");
    assert.equal(result.color, "red");
    assert.equal(result.violation?.reason, "liveness");
    assert.match(result.violation!.detail, /manual drain set/);
  } finally {
    Date.now = realNow;
    if (realEnv === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = realEnv;
  }
});

test("evalWorker still flags behind+busy as GREEN (existing behavior — never interrupt an in-flight build)", () => {
  // Sanity guard the new queue-aware branch did not displace the existing behind+busy path.
  const realEnv = process.env.VERCEL_GIT_COMMIT_SHA;
  const realNow = Date.now;
  process.env.VERCEL_GIT_COMMIT_SHA = "bbbbbbbcccccccc";
  Date.now = () => Date.parse("2026-06-25T12:00:00Z");
  try {
    const result = evalWorker(workerLoop, idleBehindWorker({ active_builds: 2 }), 0, false, "worker-behind");
    assert.equal(result.color, "green");
    assert.equal(result.violation, null);
    assert.match(result.statusText, /building — update deferred/);
  } finally {
    Date.now = realNow;
    if (realEnv === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = realEnv;
  }
});

// ─── behindTooLong anchored to firstDivergentAt (drift age), not worker uptime ───
// control-tower-box-behind-elapsed-anchored-to-drift-not-uptim (signal loop:box, verdict
// monitor-false-positive). The originating false page: worker booted 44 minutes ago on
// 5c923ae9e, origin/main advanced ~5 minutes before the alert, and the tile immediately fired
// "self-update stuck for 44m." The 44-min claim was factually wrong — the drift was 5 minutes
// old — because the anchor was worker uptime, not when drift began. Anchoring elapsed to
// `min(uptime, driftAge)` gives a fresh commit its full shaGrace poll window even on a
// long-lived worker, matching the actual self-update SLA.

test("evalWorker stays out of RED on fresh drift even when worker uptime is past shaGrace (the incident this fix targets)", () => {
  // Worker booted ~44m ago (past the 30m shaGrace), origin/main advanced ~5m ago (well inside
  // shaGrace). Prior code compared worker uptime to shaGrace and reddened; the new anchor uses
  // min(uptime, driftAge), so drift-age (5m) < shaGrace(30m) ⇒ no red. The tile should sit in
  // the AMBER "updating" state (behind+idle, within grace) with no violation raised.
  const realEnv = process.env.VERCEL_GIT_COMMIT_SHA;
  const realNow = Date.now;
  process.env.VERCEL_GIT_COMMIT_SHA = "bbbbbbbcccccccc";
  Date.now = () => Date.parse("2026-06-25T12:00:00Z");
  try {
    // started_at at 11:16 ⇒ 44m uptime; firstDivergentAt at 11:55 ⇒ 5m drift.
    const result = evalWorker(
      workerLoop,
      idleBehindWorker({ started_at: "2026-06-25T11:16:00Z" }),
      0,
      false,
      "worker-behind",
      "2026-06-25T11:55:00Z",
    );
    assert.notEqual(result.color, "red");
    assert.equal(result.violation, null);
    assert.doesNotMatch(result.statusText, /behind origin\/main/);
    assert.match(result.statusText, /updating —/);
  } finally {
    Date.now = realNow;
    if (realEnv === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = realEnv;
  }
});

test("evalWorker still flips RED when BOTH the uptime anchor AND the drift anchor are past shaGrace", () => {
  // Regression guard: the min-anchor must not hide a genuinely stuck worker. Long uptime AND
  // drift older than shaGrace ⇒ still red, with the accurate drift-age in the violation detail.
  const realEnv = process.env.VERCEL_GIT_COMMIT_SHA;
  const realNow = Date.now;
  process.env.VERCEL_GIT_COMMIT_SHA = "bbbbbbbcccccccc";
  Date.now = () => Date.parse("2026-06-25T12:00:00Z");
  try {
    // started_at 2h ago; firstDivergentAt 1h ago — both past the 30m shaGrace.
    const result = evalWorker(
      workerLoop,
      idleBehindWorker({ started_at: "2026-06-25T10:00:00Z" }),
      0,
      false,
      "worker-behind",
      "2026-06-25T11:00:00Z",
    );
    assert.equal(result.color, "red");
    assert.equal(result.violation?.reason, "liveness");
    assert.match(result.statusText, /behind origin\/main/);
    assert.match(result.violation!.detail, /behind for /);
  } finally {
    Date.now = realNow;
    if (realEnv === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = realEnv;
  }
});

test("evalWorker still flips RED when firstDivergentAt is null and worker uptime is past shaGrace (fallback path — no regression on the ambiguous case)", () => {
  // No compare-API drift-age available (e.g. malformed response, missing commits[0].commit.author.date).
  // The uptime anchor must still trip the shaGrace red — otherwise a genuinely stuck worker with
  // no drift-timestamp evidence would silently ride forever.
  const realEnv = process.env.VERCEL_GIT_COMMIT_SHA;
  const realNow = Date.now;
  process.env.VERCEL_GIT_COMMIT_SHA = "bbbbbbbcccccccc";
  Date.now = () => Date.parse("2026-06-25T12:00:00Z");
  try {
    // Explicitly pass null for firstDivergentAt — the compare API confirmed worker-behind but
    // didn't surface a divergent-at timestamp.
    const result = evalWorker(
      workerLoop,
      idleBehindWorker(), // started_at at 10:00 ⇒ 2h uptime, well past 30m grace.
      0,
      false,
      "worker-behind",
      null,
    );
    assert.equal(result.color, "red");
    assert.equal(result.violation?.reason, "liveness");
    assert.match(result.statusText, /behind origin\/main/);
  } finally {
    Date.now = realNow;
    if (realEnv === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = realEnv;
  }
});

// ─── SHA-direction gate (control-tower-box-sha-direction-check) ───
// A plain string mismatch can't distinguish "worker on stale code" from "worker on newer main
// but Vercel deploy still lags." The originating false page (signal loop:box, verdict
// monitor-false-positive): worker was running 6f43ec9e0 while VERCEL_GIT_COMMIT_SHA pointed at the
// ancestor b3934ff — worker-AHEAD, healthy. evalWorker must red ONLY on a CONFIRMED worker-behind.

test("classifyShaDirectionLocal returns 'same' when SHAs are prefix-equal or identical", () => {
  assert.equal(classifyShaDirectionLocal("6f43ec9e0abc123", "6f43ec9e0"), "same");
  assert.equal(classifyShaDirectionLocal("6f43ec9e0", "6f43ec9e0abc123"), "same");
  assert.equal(classifyShaDirectionLocal("abc", "abc"), "same");
});

test("classifyShaDirectionLocal returns 'unknown' when either SHA is empty or they don't share a prefix", () => {
  assert.equal(classifyShaDirectionLocal("", "abc"), "unknown");
  assert.equal(classifyShaDirectionLocal("abc", ""), "unknown");
  assert.equal(classifyShaDirectionLocal("", ""), "unknown");
  // Non-prefix pairs are "unknown" locally — direction must be resolved by the GitHub compare API.
  assert.equal(classifyShaDirectionLocal("6f43ec9e0", "b3934ff37"), "unknown");
});

test("evalWorker stays GREEN on worker-AHEAD (Vercel deploy lag) — the originating false page", () => {
  // Deployed ancestor SHA (Vercel still on the previous commit), worker on the newer main head.
  // Prior code compared strings and reddened; the fix returns GREEN with a "deploy lag" note.
  const realEnv = process.env.VERCEL_GIT_COMMIT_SHA;
  const realNow = Date.now;
  process.env.VERCEL_GIT_COMMIT_SHA = "b3934ff37000000";
  Date.now = () => Date.parse("2026-06-25T12:00:00Z");
  try {
    const result = evalWorker(
      workerLoop,
      idleBehindWorker({ running_sha: "6f43ec9e0" }),
      0,
      false,
      "worker-ahead",
    );
    assert.equal(result.color, "green");
    assert.equal(result.violation, null);
    assert.match(result.statusText, /deploy lag/);
  } finally {
    Date.now = realNow;
    if (realEnv === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = realEnv;
  }
});

test("evalWorker stays GREEN on UNKNOWN direction (compare API blip / diverged / missing token)", () => {
  // Empty queue + past shaGrace: under the old prefix check this would already be RED (behind).
  // The new gate refuses to red on an ambiguous compare — same conservative posture as
  // deployAgeMs==null in evalCron. A confirmed worker-behind still reds (see test above).
  const realEnv = process.env.VERCEL_GIT_COMMIT_SHA;
  const realNow = Date.now;
  process.env.VERCEL_GIT_COMMIT_SHA = "bbbbbbbcccccccc";
  Date.now = () => Date.parse("2026-06-25T12:00:00Z");
  try {
    const result = evalWorker(workerLoop, idleBehindWorker(), 0, false, "unknown");
    assert.equal(result.color, "green");
    assert.equal(result.violation, null);
    assert.doesNotMatch(result.statusText, /behind origin\/main/);
  } finally {
    Date.now = realNow;
    if (realEnv === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = realEnv;
  }
});

test("evalWorker stays GREEN on SAME direction (identical or prefix-equal SHAs)", () => {
  const realEnv = process.env.VERCEL_GIT_COMMIT_SHA;
  const realNow = Date.now;
  process.env.VERCEL_GIT_COMMIT_SHA = "aaaaaaa";
  Date.now = () => Date.parse("2026-06-25T12:00:00Z");
  try {
    const result = evalWorker(workerLoop, idleBehindWorker(), 0, false, "same");
    assert.equal(result.color, "green");
    assert.equal(result.violation, null);
    assert.match(result.statusText, /healthy · aaaaaaa/);
  } finally {
    Date.now = realNow;
    if (realEnv === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = realEnv;
  }
});

// ─── ai:fraud-detector work probe — exclude internal renewal orders ───
// control-tower-fraud-detector-workprobe-exclude-internal-renewals
// (signal loop:ai:fraud-detector, verdict monitor-false-positive).
// The originating false page was: one item awaited the fraud detector while it
// was silent — but the item was an `orders` row written by the internal
// subscription-renewal cron (source_name='internal_subscription_renewal'),
// which by design never emits `fraud/order.check` and therefore never calls
// `checkOrderForFraud`. The probe was counting it as fraud-detector work.

test("isOrderAwaitingFraudScreen excludes internal renewal source_name values", () => {
  // The two internal-renewal source_name markers stamped by
  // src/lib/inngest/internal-subscription-renewals.ts are the ONLY orders we
  // exclude — nothing else in the count changes.
  for (const src of INTERNAL_RENEWAL_ORDER_SOURCE_NAMES) {
    assert.equal(isOrderAwaitingFraudScreen({ source_name: src }), false, src);
  }
});

test("isOrderAwaitingFraudScreen keeps every Shopify/web/unknown source_name in the count", () => {
  // Real Shopify webhooks pass upstream `source_name` through (web/pos/tiktok/…);
  // the storefront checkout route stamps 'storefront'; and older/unknown-source
  // orders (source_name null) stay counted — same as the pre-fix behavior, so
  // a genuine detector outage on those paths still flips the tile red.
  assert.equal(isOrderAwaitingFraudScreen({ source_name: "web" }), true);
  assert.equal(isOrderAwaitingFraudScreen({ source_name: "storefront" }), true);
  assert.equal(isOrderAwaitingFraudScreen({ source_name: "pos" }), true);
  assert.equal(isOrderAwaitingFraudScreen({ source_name: "tiktok" }), true);
  assert.equal(isOrderAwaitingFraudScreen({ source_name: null }), true);
  assert.equal(isOrderAwaitingFraudScreen({}), true);
});

test("evalInlineAgent stays GREEN on a renewal-only window with no ai:fraud-detector beat", () => {
  // The originating condition (signal loop:ai:fraud-detector): 6h window with
  // zero fraud-detector beats but internal renewal orders present. The tightened
  // probe now returns work=0 for that window (renewals excluded at the DB layer
  // by the same predicate), so evalInlineAgent falls through to genuinely-idle
  // green — no idle_while_work violation, no false red tile for Platform.
  const fraudLoop = MONITORED_LOOPS.find((l) => l.id === INLINE_AGENT_IDS.fraudDetector);
  assert.ok(fraudLoop, "ai:fraud-detector loop must be registered");

  const pastBeat: LoopHistoryRow = { ran_at: "2026-06-24T00:00:00Z", ok: true, produced: null, detail: null, duration_ms: null };
  const state: InlineAgentState = { work: 0, okCount: 0, errCount: 0, latest: pastBeat, history: [pastBeat] };
  const result = evalInlineAgent(fraudLoop!, state);
  assert.equal(result.color, "green");
  assert.equal(result.violation, null);
});

test("evalInlineAgent still flips RED on a real Shopify/web order with no ai:fraud-detector beat", () => {
  // No-false-negative guard: a real Shopify/web order in-window still counts
  // (the probe only excludes the two internal-renewal markers), so a genuine
  // fraud-detector outage — work=1, 0 successful beats, history not empty —
  // still surfaces idle_while_work on the tile.
  const fraudLoop = MONITORED_LOOPS.find((l) => l.id === INLINE_AGENT_IDS.fraudDetector);
  assert.ok(fraudLoop, "ai:fraud-detector loop must be registered");

  const pastBeat: LoopHistoryRow = { ran_at: "2026-06-24T00:00:00Z", ok: true, produced: null, detail: null, duration_ms: null };
  const state: InlineAgentState = { work: 1, okCount: 0, errCount: 0, latest: pastBeat, history: [pastBeat] };
  const result = evalInlineAgent(fraudLoop!, state);
  assert.equal(result.color, "red");
  assert.equal(result.violation?.reason, "idle_while_work");
});

// ─── ai:fraud-detector work probe — coalesce-coverage grace ───
// control-tower-fraud-workprobe-coalesce-grace (signal loop:ai:fraud-detector,
// verdict monitor-false-positive). Originating false page: a quiet edge minute
// where an order arrived just before a successful ai:fraud-detector heartbeat
// whose in-memory 60s coalesce (HEARTBEAT_COALESCE_MS in
// src/lib/control-tower/heartbeat.ts) suppressed the order's own beat. When the
// 6h liveness window later slid past that beat, the write rolled out but the
// order stayed in — okCount=0 while work=1 → false idle_while_work on the tile.
// The grace teaches the probe to skip orders inside the coalescing coverage
// window of the latest successful beat, so the tile stays green on that shape.
// Orders beyond the grace still count, so a genuine detector outage after a
// stale beat still flips the tile red.

test("FRAUD_DETECTOR_HEARTBEAT_COALESCE_GRACE_MS matches the heartbeat writer's coalesce budget", () => {
  // Pinned so the probe's coverage window can't silently drift apart from the
  // writer's suppression budget (HEARTBEAT_COALESCE_MS = 60_000 in
  // src/lib/control-tower/heartbeat.ts). If the writer's budget changes, this
  // test forces a same-PR update on both constants — anything else re-opens
  // the exact edge-window false page this spec repairs.
  assert.equal(FRAUD_DETECTOR_HEARTBEAT_COALESCE_GRACE_MS, 60_000);
});

test("orderIsInsideFraudCoalesceCoverage covers the exact edge of the coalesce window", () => {
  // The boundary that reproduces the originating alert: an order created
  // 30s AFTER the latest successful beat rides on that beat's coalesced run —
  // its own beat would have been suppressed by HEARTBEAT_COALESCE_MS — so the
  // probe must NOT count it as unscreened work. The exclusive edges (before T
  // and past T + grace) fall outside the coverage window and DO count.
  const beat = Date.parse("2026-08-27T18:00:00Z");
  // Inside the window (inclusive of T, inclusive of T + grace):
  assert.equal(orderIsInsideFraudCoalesceCoverage(beat, beat), true);
  assert.equal(orderIsInsideFraudCoalesceCoverage(beat + 30_000, beat), true);
  assert.equal(orderIsInsideFraudCoalesceCoverage(beat + 60_000, beat), true);
  // Just outside the window on both edges — these are the orders that count:
  assert.equal(orderIsInsideFraudCoalesceCoverage(beat - 1, beat), false);
  assert.equal(orderIsInsideFraudCoalesceCoverage(beat + 60_001, beat), false);
  // Null latest beat (never any successful run) — nothing to coalesce:
  assert.equal(orderIsInsideFraudCoalesceCoverage(beat, null), false);
});

test("orderIsInsideFraudCoalesceCoverage covers the sliding-window edge shape from the alert", () => {
  // Directly models the originating false page: the liveness window is
  // `[now - 6h, now]`, the latest successful beat T fell 30s BEFORE the window
  // opened (so it has now rolled OUT of the 6h liveness window and okCount=0
  // in-window), yet its 60s coalescing coverage window extends 30s INTO the
  // demand window. An order arriving in that overlap [windowStart, T + 60s]
  // was handled by T's run but had its own beat suppressed by the coalesce —
  // the exact edge that made work=1 / okCount=0 false-fire before this grace.
  const now = Date.parse("2026-08-27T18:00:00Z");
  const windowStart = now - 6 * 60 * 60 * 1000;
  const beat = windowStart - 30_000; // 30s BEFORE window opens (rolled out of the liveness window)
  // 5s AFTER windowStart = 35s AFTER beat → INSIDE both the demand window and
  // the coalesce coverage window [beat, beat + 60s].
  const orderInsideCoverage = windowStart + 5_000;
  // 45s AFTER windowStart = 75s AFTER beat → INSIDE the demand window but
  // BEYOND the coalesce coverage window (past beat + 60s).
  const orderBeyondCoverage = windowStart + 45_000;
  assert.equal(orderIsInsideFraudCoalesceCoverage(orderInsideCoverage, beat), true);
  assert.equal(orderIsInsideFraudCoalesceCoverage(orderBeyondCoverage, beat), false);
  // Window sanity: both orders are actually inside the 6h demand window (this
  // is what made the pre-grace probe count both and false-fire on the
  // coverage-covered one).
  assert.ok(orderInsideCoverage >= windowStart && orderInsideCoverage <= now);
  assert.ok(orderBeyondCoverage >= windowStart && orderBeyondCoverage <= now);
});

test("evalInlineAgent stays GREEN when the probe excludes coalesce-covered orders (edge-of-window boundary)", () => {
  // Boundary case from the originating alert (loop:ai:fraud-detector,
  // monitor-false-positive): once the probe applies the coalesce grace, the
  // only in-window order was inside the coverage window of a beat that has
  // since rolled off the 6h liveness window. So the probe returns work=0
  // even though okCount=0 in-window (the beat is now outside the window), and
  // evalInlineAgent falls through to genuinely-idle green — no idle_while_work
  // violation, no false red tile for Platform.
  const fraudLoop = MONITORED_LOOPS.find((l) => l.id === INLINE_AGENT_IDS.fraudDetector);
  assert.ok(fraudLoop, "ai:fraud-detector loop must be registered");

  const now = Date.parse("2026-08-27T18:00:00Z");
  const windowStart = now - 6 * 60 * 60 * 1000;
  const beatMs = windowStart - 30_000;
  const orderMs = beatMs + 10_000;
  assert.equal(
    orderIsInsideFraudCoalesceCoverage(orderMs, beatMs),
    true,
    "the sole in-window order rides on the coalesced beat — probe must exclude it",
  );
  const rolledOutBeat: LoopHistoryRow = { ran_at: new Date(beatMs).toISOString(), ok: true, produced: null, detail: null, duration_ms: null };
  const state: InlineAgentState = { work: 0, okCount: 0, errCount: 0, latest: rolledOutBeat, history: [rolledOutBeat] };
  const result = evalInlineAgent(fraudLoop!, state);
  assert.equal(result.color, "green");
  assert.equal(result.violation, null);
});

test("evalInlineAgent still flips RED on an order that arrived AFTER the coalesce grace with no follow-up beat", () => {
  // No-false-negative guard for the coalesce grace: an order created OUTSIDE
  // the coalescing coverage window of the latest successful beat and with no
  // subsequent successful beat is real unscreened work. The probe counts it
  // (`orderIsInsideFraudCoalesceCoverage` returns false for beat + grace + 1),
  // so idle_while_work still fires and Platform still pages on a real outage.
  const fraudLoop = MONITORED_LOOPS.find((l) => l.id === INLINE_AGENT_IDS.fraudDetector);
  assert.ok(fraudLoop, "ai:fraud-detector loop must be registered");

  const now = Date.parse("2026-08-27T18:00:00Z");
  const windowStart = now - 6 * 60 * 60 * 1000;
  const beatMs = windowStart - 30_000;
  const orderMs = beatMs + FRAUD_DETECTOR_HEARTBEAT_COALESCE_GRACE_MS + 1;
  assert.equal(
    orderIsInsideFraudCoalesceCoverage(orderMs, beatMs),
    false,
    "an order past the coalesce grace is NOT covered — probe must still count it",
  );
  const rolledOutBeat: LoopHistoryRow = { ran_at: new Date(beatMs).toISOString(), ok: true, produced: null, detail: null, duration_ms: null };
  const state: InlineAgentState = { work: 1, okCount: 0, errCount: 0, latest: rolledOutBeat, history: [rolledOutBeat] };
  const result = evalInlineAgent(fraudLoop!, state);
  assert.equal(result.color, "red");
  assert.equal(result.violation?.reason, "idle_while_work");
});

// ── tickets-awaiting-decision Sol bypass exclusions (first_touch + inflection) ─
// Originating false pages (signal `loop:ai:orchestrator`, verdict monitor-false-positive):
//   1) An inbound customer email dispatched to Sol as a `ticket-handle` first-touch job counted
//      as orchestrator-owned work in the `tickets-awaiting-decision` probe. The chat-only ack
//      ledger row (`ticket_resolution_events(reasoning='sol_first_touch_ack')`) is skipped by
//      design on async channels, so the probe subtracted nothing and the tile flipped red on 0
//      beats. Spec: `ticket-decision-workprobe-exclude-async-sol-first-touch`.
//   2) A drift/frustration inbound routed through [[../inflection-detector]] `reSessionSol`
//      (which supersedes the live Direction and enqueues a fresh `ticket-handle` job with
//      `reason: 'inflection'`) never reaches callSonnetOrchestratorV2 either — no orchestrator
//      beat is emitted — but the same probe still counted it as orchestrator work. Spec:
//      `ticket-decision-workprobe-exclude-sol-inflection-resessions`.
// The channel-agnostic dispatch signal is the `agent_jobs` row that unified-ticket-handler.ts
// (§ 2b, first_touch) and `reSessionSol` (inflection) both write with `kind='ticket-handle'`
// and `instructions.reason` in `SOL_HANDLE_BYPASS_REASONS`. These tests pin the pure helper
// that extracts the ticket_ids from that batch — the piece the probe subtracts so async
// first-touch tickets AND inflection re-sessions no longer manufacture a false red tile.

test("SOL_HANDLE_BYPASS_REASONS carries the two Sol-owned ticket-handle reasons the tickets-awaiting-decision probe subtracts", () => {
  // The shared list is the source of truth the probe's LIKE prefilter and the helper's Node-side
  // filter both derive from. Pinning its membership catches a silent drop that would re-open the
  // false page (e.g. removing 'inflection' would let a drift/frustration inbound with no
  // orchestrator beat re-flip the tile red).
  assert.deepEqual([...SOL_HANDLE_BYPASS_REASONS], ["first_touch", "inflection"]);
});

test("extractSolHandleBypassTicketIds picks up an async (email) first-touch ticket-handle job with no ack row", () => {
  // The originating condition for the first-touch false page: unified-ticket-handler.ts § 2b
  // takes the async channel branch — no send, no `sol_first_touch_ack` `ticket_resolution_events`
  // row — and enqueues a ticket-handle `agent_jobs` row with `reason: 'first_touch'` in the
  // instructions payload. Direct mirror of the enqueue shape at unified-ticket-handler.ts:2030-2041
  // (`JSON.stringify({ ticket_id, workspace_id, turn_index: 1, reason: 'first_touch' })`) — the
  // exact payload the async email path writes.
  const rows = [
    {
      instructions: JSON.stringify({
        ticket_id: "ticket-async-email",
        workspace_id: "ws-1",
        turn_index: 1,
        reason: "first_touch",
      }),
    },
  ];
  const ids = extractSolHandleBypassTicketIds(rows);
  assert.deepEqual(ids, ["ticket-async-email"]);
  // Consumed by the probe as `.in('ticket_id', [...])` → the inbound-message count for this ticket
  // is subtracted from the total, so the async-first-touch email that fired the false page now
  // reads as work=0 instead of work=1 in the ai:orchestrator tile — no idle_while_work violation.
});

test("extractSolHandleBypassTicketIds picks up an inflection re-session ticket-handle job (drift / frustration bounce)", () => {
  // The originating condition for THIS spec's false page: the inflection gate
  // ([[../inflection-detector]] `applyInflectionGate`) fires on a subsequent inbound, stages
  // the `sol:inflection-<kind>` ledger row, optionally sends a holding message, and calls
  // `reSessionSol` — which supersedes the live Direction and enqueues a ticket-handle
  // `agent_jobs` row with `reason: 'inflection'` in the instructions payload. Direct mirror of
  // the enqueue shape at inflection-detector.ts:679-697 (`JSON.stringify({ ticket_id,
  // workspace_id, turn_index, reason: 'inflection', kind, evidence, superseded_direction_id })`)
  // — callSonnetOrchestratorV2 never runs on that inbound, so no ai:orchestrator beat is emitted
  // and the probe MUST subtract the message from orchestrator demand.
  const rows = [
    {
      instructions: JSON.stringify({
        ticket_id: "ticket-drift-inflection",
        workspace_id: "ws-1",
        turn_index: 3,
        reason: "inflection",
        kind: "drift",
        evidence: { markers: ["drift:direction_mismatch"] },
        superseded_direction_id: "dir-old",
      }),
    },
  ];
  const ids = extractSolHandleBypassTicketIds(rows);
  assert.deepEqual(ids, ["ticket-drift-inflection"]);
});

test("extractSolHandleBypassTicketIds returns both first_touch and inflection ticket_ids from a mixed batch", () => {
  // The probe's `agent_jobs` window will typically contain a mix of Sol-owned dispatch classes.
  // The helper must return every bypass ticket_id in one pass so the single `.in('ticket_id',
  // ids)` subtraction below the probe can cover both classes without a second query.
  const rows = [
    { instructions: JSON.stringify({ ticket_id: "ticket-ft", workspace_id: "ws-1", turn_index: 1, reason: "first_touch" }) },
    { instructions: JSON.stringify({ ticket_id: "ticket-in", workspace_id: "ws-1", turn_index: 4, reason: "inflection", kind: "frustration", evidence: null, superseded_direction_id: "d-1" }) },
  ];
  assert.deepEqual(extractSolHandleBypassTicketIds(rows).sort(), ["ticket-ft", "ticket-in"]);
});

test("extractSolHandleBypassTicketIds also catches a failed first-touch job (dispatch was made, so orchestrator was still bypassed)", () => {
  // The spec's other named scenario: a `ticket-handle` job that later transitioned to `failed`
  // still represents a Sol dispatch — unified-ticket-handler.ts / reSessionSol already handed
  // the inbound message to Sol and returned before callSonnetOrchestratorV2 could run, so no
  // ai:orchestrator beat is emitted regardless of the box worker's later outcome. The helper is
  // status-agnostic (the probe's caller doesn't filter on status either) so a queued OR failed
  // job of the same shape both exclude their inbound message.
  const rows = [
    {
      instructions: JSON.stringify({
        ticket_id: "ticket-async-failed",
        workspace_id: "ws-1",
        turn_index: 1,
        reason: "first_touch",
      }),
    },
  ];
  assert.deepEqual(extractSolHandleBypassTicketIds(rows), ["ticket-async-failed"]);
});

test("extractSolHandleBypassTicketIds skips ticket-handle jobs with a reason outside SOL_HANDLE_BYPASS_REASONS (portal_error, drift, unknown)", () => {
  // Only reasons in SOL_HANDLE_BYPASS_REASONS are subtracted here — portal-error ticket-handle
  // jobs (enqueueSolFirstTouchForPortalError) have their own downstream accounting
  // (portal-errors-route-to-sol-first-escalate-to-june) and their inbound messages already went
  // through a Sonnet path that produced a beat. A `reason: 'drift'` marker (the classifier
  // kind, NOT the enqueue reason — the enqueue reason for a drift bounce is 'inflection') must
  // not accidentally leak in via a substring match; the strict allowlist check keeps the
  // exclusion tight to the actual pre-orchestrator bypass classes the false pages fired on.
  const rows = [
    { instructions: JSON.stringify({ ticket_id: "ticket-portal", workspace_id: "ws-1", turn_index: 1, reason: "portal_error", route: "cancel", error_code: null }) },
    { instructions: JSON.stringify({ ticket_id: "ticket-drift-mislabel", workspace_id: "ws-1", turn_index: 3, reason: "drift" }) },
    { instructions: JSON.stringify({ ticket_id: "ticket-future-kind", workspace_id: "ws-1", turn_index: 2, reason: "some_future_reason" }) },
    { instructions: JSON.stringify({ ticket_id: "ticket-first-touch", workspace_id: "ws-1", turn_index: 1, reason: "first_touch" }) },
    { instructions: JSON.stringify({ ticket_id: "ticket-inflection", workspace_id: "ws-1", turn_index: 4, reason: "inflection" }) },
  ];
  assert.deepEqual(
    extractSolHandleBypassTicketIds(rows).sort(),
    ["ticket-first-touch", "ticket-inflection"],
  );
});

test("extractSolHandleBypassTicketIds tolerates null / non-JSON / malformed instructions without throwing", () => {
  // The probe already null/error-safes at the outer layer (defaults dispatch count to 0). The
  // helper matches that contract so a legacy or future kind whose instructions aren't a JSON
  // object can't blow up the tickets-awaiting-decision computation.
  const rows = [
    { instructions: null },
    { instructions: "not json at all" },
    { instructions: JSON.stringify(["array-not-object"]) },
    { instructions: JSON.stringify({ ticket_id: "", reason: "first_touch" }) }, // empty id
    { instructions: JSON.stringify({ reason: "first_touch" }) }, // no ticket_id
    { instructions: JSON.stringify({ ticket_id: "T", reason: "first_touch" }) }, // valid — kept
    { instructions: JSON.stringify({ ticket_id: "U", reason: "inflection" }) }, // valid — kept
    { instructions: JSON.stringify({ ticket_id: "V", reason: 42 }) }, // non-string reason
  ];
  assert.deepEqual(extractSolHandleBypassTicketIds(rows).sort(), ["T", "U"]);
});

test("extractSolHandleBypassTicketIds dedupes when a ticket has multiple bypass ticket-handle jobs in the window", () => {
  // A ticket may match more than one bypass class in-window (first-touch on the opening inbound,
  // then an inflection re-session on a later turn). The set guarantees a single message can't be
  // subtracted twice via the `in('ticket_id', ids)` fan-out.
  const rows = [
    { instructions: JSON.stringify({ ticket_id: "T", workspace_id: "ws-1", turn_index: 1, reason: "first_touch" }) },
    { instructions: JSON.stringify({ ticket_id: "T", workspace_id: "ws-1", turn_index: 1, reason: "first_touch" }) },
    { instructions: JSON.stringify({ ticket_id: "T", workspace_id: "ws-1", turn_index: 4, reason: "inflection" }) },
  ];
  assert.deepEqual(extractSolHandleBypassTicketIds(rows), ["T"]);
});

// ── tickets-awaiting-decision settle-window + outreach bypass ─────────────────
// Originating false page (signal `loop:ai:orchestrator`, verdict monitor-false-positive):
// a fresh Flippa-style cold-outreach inbound flipped the ai:orchestrator tile red because
// unified-ticket-handler.ts closes outreach deterministically (§ 1c decideOutreachRoute →
// `outreach-deterministic-close`, no callSonnetOrchestratorV2 beat), but the monitor's
// tickets-awaiting-decision probe sampled the inbound BEFORE the classifier stamped
// `cls:outreach` / `outreach` tags + `status='closed'`, so the message counted as
// orchestrator work with 0 beats. Spec: control-tower-ticket-decision-workprobe-settle-and-outreach-bypass.
//
// Fix has two moving parts, both pinned by source-inspection tests here (the case body itself
// is inline in the switch statement rather than a pure helper — a source-fingerprint test is
// the closest thing to a behavioral pin without dragging in a full Supabase-admin mock, and
// matches the sibling regression test file for `tickets-awaiting-handler-dispatch`):
//   1) An upper `.lte("created_at", now - TICKET_DECISION_SETTLE_MS)` cutoff on every
//      count query so a fresh inbound waits through the classifier / deterministic-close race
//      before entering the count.
//   2) The `outreach` / `cls:outreach` tags are included alongside `csat:reopened` in the
//      bypass OR clause so an outreach ticket that HAS aged past the settle window is still
//      subtracted at the tag layer (defensive — the settle window alone drops the count to
//      zero when the deterministic-close lands cleanly, and the tag exclusion covers the
//      edge case where the classifier ran but the close status hasn't propagated yet).

function ticketsAwaitingDecisionCaseBlock(): string {
  const src = readFileSync(resolve(process.cwd(), "src/lib/control-tower/monitor.ts"), "utf-8");
  const m = src.match(/case\s+"tickets-awaiting-decision":\s*\{([\s\S]*?)\n\s*\}\s*\n\s*case\s+"/);
  assert.ok(m, "tickets-awaiting-decision case block not found in monitor.ts — did the switch shape change?");
  return m[1];
}

test("Flippa-style outreach close race — tickets-awaiting-decision probe subtracts outreach + cls:outreach tags", () => {
  // unified-ticket-handler.ts stamps BOTH `cls:outreach` (from `addTicketTag(tid, \`cls:${'${'}msgType${'}'}\`)`
  // at ~1100) AND the bare `outreach` tag (~1101) whenever the classifier bucket is 'outreach',
  // AND the automated-sender pre-filter block (~1048) stamps the same pair for the deterministic
  // pre-classifier outreach lane. Either tag alone is sufficient evidence the deterministic
  // outreach handler ran — the Sonnet orchestrator never fires. The probe's OR-clause must
  // include BOTH so a future refactor that removes one of the addTicketTag calls (or a
  // production race where one lands before the other) still leaves the exclusion intact.
  const block = ticketsAwaitingDecisionCaseBlock();
  assert.match(
    block,
    /tags\.cs\.\{outreach\}/,
    "`tickets-awaiting-decision` case must include `tags.cs.{outreach}` in its exclusion OR clause — unified-ticket-handler.ts stamps this tag on every deterministic outreach close (classifier bucket 'outreach' + automated-sender pre-filter). Without it, a Flippa-style cold outreach pitch counts as orchestrator work with 0 beats and false-fires idle_while_work on the ai:orchestrator tile even after the handler correctly closed it.",
  );
  assert.match(
    block,
    /tags\.cs\.\{cls:outreach\}/,
    "`tickets-awaiting-decision` case must include `tags.cs.{cls:outreach}` in its exclusion OR clause — the classifier bucket tag is the FIRST tag written on the outreach lane (before the bare `outreach` tag), so relying on `outreach` alone loses a small race window and re-opens the false-positive the spec is designed to close.",
  );
});

test("Flippa-style outreach close race — tickets-awaiting-decision probe applies an upper created_at settle cutoff", () => {
  // The tag-based exclusion alone doesn't cover the earliest moment of the race: an inbound row
  // exists BEFORE unified-ticket-handler.ts even begins classifying (dispatchInboundMessage
  // inserts + fires the event first). Without an upper `.lte("created_at", cutoff)` bound the
  // probe would still count the fresh inbound as work — hitting a monitor tick in the ~seconds
  // between the insert and the addTicketTag/setStatus calls flips the tile red on a healthy
  // system. The `TICKET_DECISION_SETTLE_MS` boundary must be applied at query time via
  // `Date.now() - TICKET_DECISION_SETTLE_MS` so the window slides with wall-clock, mirroring
  // the shape HANDLER_DISPATCH_SETTLE_MS uses on the sibling handler-dispatch probe.
  const block = ticketsAwaitingDecisionCaseBlock();
  assert.match(
    block,
    /TICKET_DECISION_SETTLE_MS/,
    "`tickets-awaiting-decision` case must key its settle cutoff on TICKET_DECISION_SETTLE_MS — a bare ms literal in the case body silently drifts and re-opens the race the spec is designed to close.",
  );
  assert.match(
    block,
    /Date\.now\(\s*\)\s*-\s*TICKET_DECISION_SETTLE_MS/,
    "`tickets-awaiting-decision` case must derive its cutoff from `Date.now() - TICKET_DECISION_SETTLE_MS` — a static build-time cutoff would let a fresh inbound age past the settle boundary without waiting for the classifier / deterministic-close to run, re-opening the false-positive.",
  );
  assert.match(
    block,
    /\.lte\(\s*"created_at"\s*,/,
    "`tickets-awaiting-decision` case must apply `.lte(\"created_at\", cutoff)` to bound the count from above — dropping this filter turns the settle constant into dead code and lets the Flippa-style outreach close race fire the ai:orchestrator tile red again.",
  );
});

// ── tickets-awaiting-decision auto-merge remap grace ──────────────────────────
// Spec: ticket-decision-workprobe-grace-merge-remapped-inbounds-by-t.
// Originating false page (signal `loop:ai:orchestrator`, verdict monitor-false-positive):
// ticket auto-merge (unified-ticket-handler.ts § 1a, mergeTickets → newest as target) remaps
// inbound `ticket_messages` rows from older tickets onto a brand-new ticket while keeping
// their ORIGINAL `created_at`. A 16-minute-old inbound whose parent ticket is now 13 seconds
// old ages past `TICKET_DECISION_SETTLE_MS` on its own timestamp before the classifier /
// first-touch dispatch have had a chance to run on the FRESH parent ticket, so it counts as
// orchestrator demand with 0 beats and flips the tile red on healthy traffic. Fix: extend the
// settle cutoff to `MAX(msg.created_at, ticket.created_at)` — a message counts only when
// BOTH its own timestamp AND its current parent ticket's timestamp are older than the cutoff.
// Source-inspection tests here (the case body is inline in the switch statement rather than a
// pure helper — matches the sibling settle-window + outreach-bypass tests just above).

test("Auto-merge remap race — tickets-awaiting-decision probe applies the settle cutoff to tickets.created_at as well", () => {
  // The joined-ticket cutoff (`.lte("tickets.created_at", cutoff)`) is what implements the
  // MAX(msg.created_at, ticket.created_at) settle grace. Without it, a message whose OWN
  // created_at is already past the cutoff (because auto-merge remapped it from an older ticket)
  // counts as demand even though its CURRENT parent ticket was created seconds ago and the
  // classifier + first-touch dispatch haven't had a chance to run yet — the exact false page
  // the spec closes.
  const block = ticketsAwaitingDecisionCaseBlock();
  assert.match(
    block,
    /\.lte\(\s*"tickets\.created_at"\s*,\s*decisionSettleCutoffIso\s*\)/,
    "`tickets-awaiting-decision` case must apply `.lte(\"tickets.created_at\", decisionSettleCutoffIso)` on the joined tickets row — this is the ticket-side half of the MAX(msg.created_at, ticket.created_at) settle grace and the sole gate that prevents an auto-merged old inbound from counting as demand before the classifier + first-touch dispatch have run on the fresh parent ticket.",
  );
});

test("Auto-merge remap race — every count query gates on BOTH msg.created_at AND tickets.created_at (symmetric filter)", () => {
  // If any of the four count queries (allRes, excludedRes, solFirstTouchAckRes, and the
  // solFirstTouchDispatchExcluded follow-up) applies the ticket-side cutoff without the
  // others, the subtraction is asymmetric and the Math.max floor no longer covers the
  // auto-merge case: e.g. allRes drops the fresh-ticket message but excludedRes does not,
  // so the message stays in the total-count residual even though its counterpart was pruned
  // upstream. The four queries must all filter identically on both `created_at` and
  // `tickets.created_at` for the settle boundary to hold across the whole computation.
  const block = ticketsAwaitingDecisionCaseBlock();
  const msgCutoffMatches = block.match(/\.lte\(\s*"created_at"\s*,\s*decisionSettleCutoffIso\s*\)/g) ?? [];
  const ticketCutoffMatches = block.match(/\.lte\(\s*"tickets\.created_at"\s*,\s*decisionSettleCutoffIso\s*\)/g) ?? [];
  assert.equal(
    ticketCutoffMatches.length,
    msgCutoffMatches.length,
    `every ticket_messages count query in the tickets-awaiting-decision case must gate on both msg.created_at AND tickets.created_at — found ${msgCutoffMatches.length} msg-side cutoffs and ${ticketCutoffMatches.length} ticket-side cutoffs. An asymmetric filter re-opens the auto-merge remap race the ticket-decision-workprobe-grace-merge-remapped-inbounds-by-t spec is designed to close.`,
  );
  // Sanity floor: at least one of each (all four queries share the ticket_messages shape today —
  // if this drops to zero, the case body was refactored and this whole file needs a re-look).
  assert.ok(msgCutoffMatches.length >= 4, `expected ≥4 msg-side settle cutoffs in the tickets-awaiting-decision case (one per ticket_messages count query), found ${msgCutoffMatches.length}. Did the case body shape change?`);
});

test("Auto-merge remap race — the `all` (unbypassed) count query joins tickets!inner so the ticket-side cutoff can apply", () => {
  // Before this spec, `allRes` selected only from `ticket_messages` with no join — there was
  // no `tickets` row on the query for a `.lte("tickets.created_at", ...)` filter to bind to.
  // The fix must add `tickets!inner(id)` to the `allRes` select so PostgREST parses the
  // nested-column filter as a scope-qualified predicate rather than dropping it silently.
  // Guard: the count block must include at least TWO `tickets!inner` join specs — one for
  // `allRes` (added by this spec) and one for `excludedRes` (pre-existing). The
  // `solFirstTouchAckRes` uses `tickets!inner(id, ticket_resolution_events!inner(id))` which
  // this regex intentionally does NOT match — keeps the assertion pinned on the two plain
  // `tickets!inner(id)` joins the spec is directly responsible for.
  const block = ticketsAwaitingDecisionCaseBlock();
  const plainInnerJoins = block.match(/tickets!inner\(id\)/g) ?? [];
  assert.ok(
    plainInnerJoins.length >= 2,
    `expected ≥2 \`tickets!inner(id)\` joins in the tickets-awaiting-decision case (allRes + excludedRes; solFirstTouchDispatchExcluded adds a 3rd) to bind the \`tickets.created_at\` settle cutoff onto every count query — found ${plainInnerJoins.length}. Without the join the nested-column filter is silently ignored and the auto-merge remap race re-opens.`,
  );
});

// ── tickets-awaiting-decision unclaimed dispatch-intent exclusion ────────────
// Spec: ticket-decision-workprobe-exclude-unclaimed-dispatch-intents.
// Originating false page (signal `loop:ai:orchestrator`, verdict monitor-false-positive):
// an inbound row was inserted with `dispatch_pending_at` stamped by dispatchInboundMessage but
// the unified handler's `clearDispatchIntent` never ran (the ticket/inbound-message event was
// lost / handler restart / Inngest delivery gap). That inbound never crossed the handler claim
// boundary and never reached callSonnetOrchestratorV2, so no ai:orchestrator beat can exist —
// yet the tickets-awaiting-decision probe counted it as orchestrator demand and flipped the
// tile red. The correct owner is the `tickets-awaiting-handler-dispatch` probe + the
// unanswered-inbound-backstop cron, which already re-fire the lost dispatch. Fix: gate every
// count query in the case on `.is("dispatch_pending_at", null)` so an un-cleared intent is
// STRUCTURALLY excluded from the decision-demand surface — no subtraction, no race.

test("Unclaimed dispatch — tickets-awaiting-decision probe filters out non-NULL dispatch_pending_at rows", () => {
  const block = ticketsAwaitingDecisionCaseBlock();
  assert.match(
    block,
    /\.is\(\s*"dispatch_pending_at"\s*,\s*null\s*\)/,
    "`tickets-awaiting-decision` case must call .is(\"dispatch_pending_at\", null) — an un-cleared dispatch intent means the handler never claimed the inbound and never invoked the AI orchestrator, so counting it as decision-demand pages the ai:orchestrator owner on a recoverable upstream miss the unanswered-inbound-backstop cron is about to re-fire. See ticket-decision-workprobe-exclude-unclaimed-dispatch-intents.",
  );
});

test("Unclaimed dispatch — every count query in the tickets-awaiting-decision case gates on dispatch_pending_at IS NULL (symmetric filter)", () => {
  // Symmetric across allRes / excludedRes / solFirstTouchAckRes / the solFirstTouchDispatchExcluded
  // follow-up: an asymmetric filter would leak an unclaimed inbound into the total-count residual
  // even though its counterpart was pruned upstream (Math.max(0, all - excluded - ...) still
  // yields the leak). The msg-side `.lte("created_at", decisionSettleCutoffIso)` pin is the
  // established shape for this — count the msg-side settle cutoffs, then assert the dispatch
  // filter appears on every one of them.
  const block = ticketsAwaitingDecisionCaseBlock();
  const dispatchFilterMatches = block.match(/\.is\(\s*"dispatch_pending_at"\s*,\s*null\s*\)/g) ?? [];
  const msgCutoffMatches = block.match(/\.lte\(\s*"created_at"\s*,\s*decisionSettleCutoffIso\s*\)/g) ?? [];
  assert.equal(
    dispatchFilterMatches.length,
    msgCutoffMatches.length,
    `every ticket_messages count query in the tickets-awaiting-decision case must gate on .is("dispatch_pending_at", null) — found ${msgCutoffMatches.length} msg-side settle cutoffs and ${dispatchFilterMatches.length} dispatch_pending_at null filters. An asymmetric filter re-opens the class ticket-decision-workprobe-exclude-unclaimed-dispatch-intents is designed to close.`,
  );
  assert.ok(
    msgCutoffMatches.length >= 4,
    `expected ≥4 msg-side settle cutoffs (one per ticket_messages count query — allRes / excludedRes / solFirstTouchAckRes / solFirstTouchDispatchExcluded), found ${msgCutoffMatches.length}. Did the case body shape change?`,
  );
});

test("Unclaimed dispatch — tickets-awaiting-decision case does NOT reintroduce the .not(\"dispatch_pending_at\", ...) shape (that lives on the handler-dispatch probe)", () => {
  // Keeps the two probes semantically separate. The handler-dispatch probe queries for
  // non-NULL / aged un-cleared stamps (lost dispatches it must re-fire). The decision probe
  // filters those out (they can't have produced an orchestrator beat). Reintroducing `.not(...)`
  // here would flip the surface back to counting exactly the class we just excluded.
  const block = ticketsAwaitingDecisionCaseBlock();
  assert.doesNotMatch(
    block,
    /\.not\(\s*"dispatch_pending_at"\s*,\s*"is"\s*,\s*null\s*\)/,
    "`tickets-awaiting-decision` case must NOT call .not(\"dispatch_pending_at\", \"is\", null) — that predicate defines the sibling `tickets-awaiting-handler-dispatch` probe (aged un-cleared stamps = lost handler dispatches). Bringing it here re-collapses the split-probe design.",
  );
});

test("Unclaimed dispatch — only the tickets-awaiting-handler-dispatch case body queries for non-NULL dispatch_pending_at", () => {
  // Whole-file guard: the dispatch-intent NOT-NULL predicate is the exclusive fingerprint of the
  // handler-dispatch probe. If any other case (or a stray helper) grows the same predicate, the
  // split-probe architecture (handler-dispatch counts lost stamps; decision counts everything
  // else) has silently drifted and the fix regresses.
  const src = readFileSync(resolve(process.cwd(), "src/lib/control-tower/monitor.ts"), "utf-8");
  const handlerDispatchMatch = src.match(/case\s+"tickets-awaiting-handler-dispatch":\s*\{([\s\S]*?)\n\s*\}\s*\n\s*(?:case\s+"|default)/);
  assert.ok(handlerDispatchMatch, "tickets-awaiting-handler-dispatch case block not found in monitor.ts — did the switch shape change?");
  const handlerBody = handlerDispatchMatch[1];
  const totalNotNullPredicates = (src.match(/\.not\(\s*"dispatch_pending_at"\s*,\s*"is"\s*,\s*null\s*\)/g) ?? []).length;
  const handlerNotNullPredicates = (handlerBody.match(/\.not\(\s*"dispatch_pending_at"\s*,\s*"is"\s*,\s*null\s*\)/g) ?? []).length;
  assert.ok(
    handlerNotNullPredicates >= 1,
    `tickets-awaiting-handler-dispatch case must keep its .not("dispatch_pending_at", "is", null) predicate — it IS the probe's inclusion criterion. Found ${handlerNotNullPredicates} in the handler-dispatch case body.`,
  );
  assert.equal(
    totalNotNullPredicates,
    handlerNotNullPredicates,
    `the .not("dispatch_pending_at", "is", null) predicate must live ONLY in the tickets-awaiting-handler-dispatch case — file-wide count ${totalNotNullPredicates} exceeded handler-dispatch case count ${handlerNotNullPredicates}. A stray occurrence outside that case (e.g. reintroduced into tickets-awaiting-decision) would double-count aged unclaimed dispatches across two probes and undo the split.`,
  );
});

test("evalInlineAgent still flips RED on a settled real inbound with no ai:orchestrator beat (no false negative)", () => {
  // No-false-negative guard for the settle-window + outreach exclusion. The probe now waits
  // through TICKET_DECISION_SETTLE_MS AND subtracts outreach-tagged messages, but a settled
  // inbound customer message with NO bypass class matching (not closed, not csat:reopened, no
  // active_playbook_id, not outreach-tagged, no Sol first-touch ack, no first-touch
  // ticket-handle enqueue) is genuine orchestrator work. That message survives every
  // exclusion — so if the orchestrator went silent (work=1, 0 successful beats, history not
  // empty) the tile still flips red and fires idle_while_work on loop:ai:orchestrator. This is
  // the exact class the monitor exists to alert on; the fix must never mask it.
  const orchLoop = MONITORED_LOOPS.find((l) => l.id === INLINE_AGENT_IDS.orchestrator);
  assert.ok(orchLoop, "ai:orchestrator loop must be registered");

  const pastBeat: LoopHistoryRow = { ran_at: "2026-06-24T00:00:00Z", ok: true, produced: null, detail: null, duration_ms: null };
  const state: InlineAgentState = { work: 1, okCount: 0, errCount: 0, latest: pastBeat, history: [pastBeat] };
  const result = evalInlineAgent(orchLoop!, state);
  assert.equal(result.color, "red");
  assert.equal(result.violation?.reason, "idle_while_work");
});

// ── countRenewalIntegrityOverdueSubs — dunning-aware renewal-integrity helper ──
// (build-control-tower-renewal-integrity-exclude-active-dunning P1) — an overdue internal sub
// already owned by an active dunning cycle is HEALTHY retention state, not a renewal-cron miss.

interface FakeSubscriptionRow {
  id: string;
  workspace_id: string;
  is_internal: boolean;
  status: string;
  next_billing_date: string;
  updated_at?: string | null;
}
interface FakeDunningRow {
  subscription_id: string | null;
  workspace_id: string;
  status: string;
}

/**
 * Tiny fake admin that models only the two calls `countRenewalIntegrityOverdueSubs` makes:
 *   1) `.from("subscriptions").select("id").eq("is_internal", true).eq("status","active")
 *       .lt("next_billing_date", cutoff).neq("workspace_id", sandbox)` → rows
 *   2) `.from("dunning_cycles").select("subscription_id").in("status", [...])
 *       .in("subscription_id", overdueIds).neq("workspace_id", sandbox)` → rows
 * Enough to cover the helper's contract without pulling in the full monitor mock.
 */
function fakeRenewalIntegrityAdmin(seed: {
  subscriptions: FakeSubscriptionRow[];
  dunning_cycles: FakeDunningRow[];
}): ReturnType<typeof createAdminClient> {
  const state = { subscriptions: [...seed.subscriptions], dunning_cycles: [...seed.dunning_cycles] };

  const build = (table: keyof typeof state) => {
    let filtered: Array<Record<string, unknown>> = state[table].map((r) => ({ ...r }));
    const chain = {
      select: (_cols?: string) => chain,
      eq: (col: string, val: unknown) => {
        filtered = filtered.filter((r) => r[col] === val);
        return chain;
      },
      lt: (col: string, val: unknown) => {
        filtered = filtered.filter((r) => (r[col] as string) < (val as string));
        return chain;
      },
      neq: (col: string, val: unknown) => {
        filtered = filtered.filter((r) => r[col] !== val);
        return chain;
      },
      in: (col: string, vals: unknown[]) => {
        const set = new Set(vals);
        filtered = filtered.filter((r) => set.has(r[col]));
        return chain;
      },
      then: (onFulfilled: (v: { data: Array<Record<string, unknown>>; error: null }) => unknown) =>
        Promise.resolve(onFulfilled({ data: filtered, error: null })),
    } as unknown as Record<string, unknown>;
    return chain;
  };
  return { from: (t: string) => build(t as keyof typeof state) } as unknown as ReturnType<typeof createAdminClient>;
}

const CUTOFF_ISO = "2026-07-14T00:00:00.000Z"; // "today" for the fixtures — start of the UTC day.
const OVERDUE_ISO = "2026-07-12T00:00:00.000Z"; // strictly before cutoff — genuinely overdue.
const WS = "11111111-1111-4111-8111-111111111111";
const SANDBOX_WS = SPEC_TEST_FIXTURES.workspaceId;

test("countRenewalIntegrityOverdueSubs: overdue sub in retrying dunning does NOT count as renewal_integrity violation", async () => {
  const admin = fakeRenewalIntegrityAdmin({
    subscriptions: [
      { id: "sub-retrying", workspace_id: WS, is_internal: true, status: "active", next_billing_date: OVERDUE_ISO },
    ],
    dunning_cycles: [
      { subscription_id: "sub-retrying", workspace_id: WS, status: "retrying" },
    ],
  });
  // The sub is overdue AND in retrying dunning → payment failed, waiting for its retry date.
  // That is healthy retention state, NOT a renewal-cron miss. The helper subtracts it.
  const n = await countRenewalIntegrityOverdueSubs(admin, CUTOFF_ISO);
  assert.equal(n, 0);
});

test("countRenewalIntegrityOverdueSubs: overdue sub WITHOUT any dunning cycle still counts (real renewal miss)", async () => {
  const admin = fakeRenewalIntegrityAdmin({
    subscriptions: [
      { id: "sub-naked", workspace_id: WS, is_internal: true, status: "active", next_billing_date: OVERDUE_ISO },
    ],
    dunning_cycles: [],
  });
  // Nothing routed this sub into dunning — the renewal cron missed it. The helper counts it.
  const n = await countRenewalIntegrityOverdueSubs(admin, CUTOFF_ISO);
  assert.equal(n, 1);
});

test("countRenewalIntegrityOverdueSubs: mix of covered + uncovered overdue subs returns ONLY the uncovered count", async () => {
  const admin = fakeRenewalIntegrityAdmin({
    subscriptions: [
      { id: "sub-rotating", workspace_id: WS, is_internal: true, status: "active", next_billing_date: OVERDUE_ISO },
      { id: "sub-retrying", workspace_id: WS, is_internal: true, status: "active", next_billing_date: OVERDUE_ISO },
      { id: "sub-paused", workspace_id: WS, is_internal: true, status: "active", next_billing_date: OVERDUE_ISO },
      { id: "sub-skipped", workspace_id: WS, is_internal: true, status: "active", next_billing_date: OVERDUE_ISO },
      { id: "sub-active", workspace_id: WS, is_internal: true, status: "active", next_billing_date: OVERDUE_ISO },
      { id: "sub-naked", workspace_id: WS, is_internal: true, status: "active", next_billing_date: OVERDUE_ISO },
      { id: "sub-exhausted", workspace_id: WS, is_internal: true, status: "active", next_billing_date: OVERDUE_ISO },
      { id: "sub-recovered", workspace_id: WS, is_internal: true, status: "active", next_billing_date: OVERDUE_ISO },
    ],
    dunning_cycles: [
      { subscription_id: "sub-rotating", workspace_id: WS, status: "rotating" },
      { subscription_id: "sub-retrying", workspace_id: WS, status: "retrying" },
      { subscription_id: "sub-paused", workspace_id: WS, status: "paused" },
      { subscription_id: "sub-skipped", workspace_id: WS, status: "skipped" },
      { subscription_id: "sub-active", workspace_id: WS, status: "active" },
      // Terminal cycles do NOT cover — the retention flow is done with these subs, so they
      // remain visible to the renewal-integrity assertion if they're still overdue.
      { subscription_id: "sub-exhausted", workspace_id: WS, status: "exhausted" },
      { subscription_id: "sub-recovered", workspace_id: WS, status: "recovered" },
    ],
  });
  // Uncovered: sub-naked, sub-exhausted, sub-recovered. The five non-terminal dunning subs are subtracted.
  const n = await countRenewalIntegrityOverdueSubs(admin, CUTOFF_ISO);
  assert.equal(n, 3);
});

test("countRenewalIntegrityOverdueSubs: spec-test sandbox subs are always excluded (seeded stuck fixture isn't a real anomaly)", async () => {
  const admin = fakeRenewalIntegrityAdmin({
    subscriptions: [
      { id: "sandbox-sub", workspace_id: SANDBOX_WS, is_internal: true, status: "active", next_billing_date: OVERDUE_ISO },
    ],
    dunning_cycles: [],
  });
  const n = await countRenewalIntegrityOverdueSubs(admin, CUTOFF_ISO);
  assert.equal(n, 0);
});

test("countRenewalIntegrityOverdueSubs: subs due TODAY (>= cutoff) are not counted — full renewal window hasn't passed", async () => {
  const admin = fakeRenewalIntegrityAdmin({
    subscriptions: [
      { id: "sub-due-today", workspace_id: WS, is_internal: true, status: "active", next_billing_date: CUTOFF_ISO },
    ],
    dunning_cycles: [],
  });
  const n = await countRenewalIntegrityOverdueSubs(admin, CUTOFF_ISO);
  assert.equal(n, 0);
});

test("countRenewalIntegrityOverdueSubs: cancelled/inactive subs and non-internal subs are ignored regardless of billing date", async () => {
  const admin = fakeRenewalIntegrityAdmin({
    subscriptions: [
      { id: "sub-cancelled", workspace_id: WS, is_internal: true, status: "cancelled", next_billing_date: OVERDUE_ISO },
      { id: "sub-external", workspace_id: WS, is_internal: false, status: "active", next_billing_date: OVERDUE_ISO },
    ],
    dunning_cycles: [],
  });
  const n = await countRenewalIntegrityOverdueSubs(admin, CUTOFF_ISO);
  assert.equal(n, 0);
});

// ── Latest-renewal-cron-grace tests
// (control-tower-renewal-integrity-post-cron-activation-grace P1) — an overdue sub whose row
// changed AFTER the cron already ran (e.g. a paused sub the portal auto-resumed post-cron)
// isn't yet blamable on the renewal cron; the next daily cycle re-judges it.

// The last renewal cron ran a few hours before "today" — well before OVERDUE_ISO.
const LAST_CRON_BEAT_ISO = "2026-07-13T09:00:00.000Z";
// A sub row was updated AFTER the last cron ran (e.g. auto-resumed at 12:00 UTC).
const POST_CRON_UPDATE_ISO = "2026-07-13T12:00:00.000Z";
// A sub row that was last touched BEFORE the last cron beat.
const PRE_CRON_UPDATE_ISO = "2026-07-13T06:00:00.000Z";

test("countRenewalIntegrityOverdueSubs: overdue sub whose row was updated AFTER the last renewal-cron beat is graced (not counted)", async () => {
  const admin = fakeRenewalIntegrityAdmin({
    subscriptions: [
      // Auto-resumed at 12:00 UTC — after the 09:00 UTC cron already finished. The cron
      // couldn't renew this sub because it was still paused during its run, so the assertion
      // must wait for the next daily cycle to judge it.
      {
        id: "sub-post-cron-resume",
        workspace_id: WS,
        is_internal: true,
        status: "active",
        next_billing_date: OVERDUE_ISO,
        updated_at: POST_CRON_UPDATE_ISO,
      },
    ],
    dunning_cycles: [],
  });
  const n = await countRenewalIntegrityOverdueSubs(admin, CUTOFF_ISO, LAST_CRON_BEAT_ISO);
  assert.equal(n, 0);
});

test("countRenewalIntegrityOverdueSubs: overdue sub whose row was updated BEFORE the last renewal-cron beat still counts", async () => {
  const admin = fakeRenewalIntegrityAdmin({
    subscriptions: [
      // This sub was active + overdue at 06:00 UTC — the cron at 09:00 UTC should have
      // renewed it and didn't. Real miss → still counts.
      {
        id: "sub-pre-cron",
        workspace_id: WS,
        is_internal: true,
        status: "active",
        next_billing_date: OVERDUE_ISO,
        updated_at: PRE_CRON_UPDATE_ISO,
      },
    ],
    dunning_cycles: [],
  });
  const n = await countRenewalIntegrityOverdueSubs(admin, CUTOFF_ISO, LAST_CRON_BEAT_ISO);
  assert.equal(n, 1);
});

test("countRenewalIntegrityOverdueSubs: grace is off when no renewal-cron beat is known (null) — every overdue sub still counts", async () => {
  const admin = fakeRenewalIntegrityAdmin({
    subscriptions: [
      { id: "sub-a", workspace_id: WS, is_internal: true, status: "active", next_billing_date: OVERDUE_ISO, updated_at: POST_CRON_UPDATE_ISO },
      { id: "sub-b", workspace_id: WS, is_internal: true, status: "active", next_billing_date: OVERDUE_ISO, updated_at: PRE_CRON_UPDATE_ISO },
    ],
    dunning_cycles: [],
  });
  // Null beat ⇒ fail-safe: no grace, both overdue rows count. A missing beat can't hide a real miss.
  const n = await countRenewalIntegrityOverdueSubs(admin, CUTOFF_ISO, null);
  assert.equal(n, 2);
});

// ─── Box-emitted cron freshness suppression during worker outage
// (control-tower-suppress-box-cron-freshness-during-worker-outage Phase 1) ───

const dbHealthSlowQueryLoop: MonitoredLoop = {
  id: "db-health-slow-query",
  kind: "cron",
  owner: "platform",
  label: "DB Health — slow-query root-cause",
  description: "Box job: top pg_stat_statements offenders → EXPLAIN → classify cause → propose the matching fix.",
  expectedCadence: "every ~hour (box job)",
  livenessWindowMs: 2 * 60 * 60_000,
  registeredAt: "2026-06-23T00:00:00Z",
  runsOnBox: true,
};

const inngestOnlyCronLoop: MonitoredLoop = {
  id: "renewal-integrity-cron",
  kind: "cron",
  owner: "platform",
  label: "Renewal integrity",
  description: "Inngest cron dispatched by the deployed runtime — not a box-hosted job.",
  expectedCadence: "every ~15 min (*/15 * * * *)",
  livenessWindowMs: 45 * 60_000,
};

test("isBoxEmittedCronLoop is true only for cron loops flagged runsOnBox", () => {
  assert.equal(isBoxEmittedCronLoop(dbHealthSlowQueryLoop), true);
  assert.equal(isBoxEmittedCronLoop(inngestOnlyCronLoop), false);
  // A non-cron kind can never be "box-emitted cron" even with runsOnBox set (defensive).
  const notACron: MonitoredLoop = { ...dbHealthSlowQueryLoop, kind: "worker" };
  assert.equal(isBoxEmittedCronLoop(notACron), false);
});

test("evalCron SUPPRESSES cron_freshness on db-health-slow-query when the box worker is unavailable", () => {
  // The originating incident: DB Health slow-query tile went red during a box worker outage even
  // though loop:box already carried the parent failure. Beat is 6h old (past the 2h window) but
  // workerUnavailable=true → the box `liveness` red is the useful page. The tile stays amber and
  // never opens a cron_freshness alert.
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-07-17T12:00:00Z");
  try {
    const latest: LoopHistoryRow = {
      ran_at: "2026-07-17T06:00:00Z",
      ok: true,
      duration_ms: 800,
      produced: null,
      detail: null,
    };
    const result = evalCron(dbHealthSlowQueryLoop, latest, null, 5, false, null, null, true);
    assert.equal(result.color, "amber");
    assert.equal(result.violation, null);
    assert.match(result.statusText, /waiting on box worker outage/);
  } finally {
    Date.now = realNow;
  }
});

test("evalCron STILL flips cron_freshness on db-health-slow-query when the box worker is healthy (control case)", () => {
  // Same stale beat, but workerUnavailable=false — the beat is genuinely late while the worker is
  // up, so it's a real DB Health lane failure and must still page. This is the healthy-worker
  // control case the spec's verification calls for; the guard only fires during a worker outage.
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-07-17T12:00:00Z");
  try {
    const latest: LoopHistoryRow = {
      ran_at: "2026-07-17T06:00:00Z",
      ok: true,
      duration_ms: 800,
      produced: null,
      detail: null,
    };
    const result = evalCron(dbHealthSlowQueryLoop, latest, null, 5, false, null, null, false);
    assert.equal(result.color, "red");
    assert.equal(result.violation?.reason, "cron_freshness");
  } finally {
    Date.now = realNow;
  }
});

test("evalCron does NOT suppress cron_freshness on a non-box cron even during a worker outage", () => {
  // A pure Inngest-dispatched cron (runsOnBox not set) doesn't depend on the box worker — a stale
  // beat there is still a real freshness failure regardless of worker status. Guarantees the guard
  // stays scoped to box-emitted loops and doesn't muzzle unrelated tiles.
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-07-17T12:00:00Z");
  try {
    const latest: LoopHistoryRow = {
      ran_at: "2026-07-17T09:00:00Z", // 3h stale, window is 45m
      ok: true,
      duration_ms: 800,
      produced: null,
      detail: null,
    };
    const result = evalCron(inngestOnlyCronLoop, latest, null, 5, false, null, null, true);
    assert.equal(result.color, "red");
    assert.equal(result.violation?.reason, "cron_freshness");
  } finally {
    Date.now = realNow;
  }
});

test("evalCron keeps a FRESH box-emitted beat green even while the worker is unavailable", () => {
  // The suppression path only fires when the underlying result would be red. A fresh beat is still
  // green — the guard mustn't paint healthy tiles amber just because the worker went down between
  // the last beat and the current tick.
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-07-17T12:00:00Z");
  try {
    const latest: LoopHistoryRow = {
      ran_at: "2026-07-17T11:45:00Z", // 15 min ago, well inside the 2h window
      ok: true,
      duration_ms: 800,
      produced: null,
      detail: null,
    };
    const result = evalCron(dbHealthSlowQueryLoop, latest, null, 5, false, null, null, true);
    assert.equal(result.color, "green");
    assert.equal(result.violation, null);
  } finally {
    Date.now = realNow;
  }
});

// ── countStuckDunningCycles — scoped to the payday-retry cron's owned population ──
// (build-control-tower-stuck-dunning-scope-to-payday-cron Phase 1) — a `retrying` cycle on an
// internal-* contract is Braintree-billed work handled by handleInternalDunningFailure / the
// internal renewal cron, NEVER by dunning-payday-retry-cron. Blaming that Appstle tile for a
// stuck internal-* cycle produced a noisy Control Tower false page, so the monitor query now
// mirrors the cron's find-retryable-cycles filter (`.not("shopify_contract_id","ilike","internal-%")`).

interface FakeStuckDunningRow {
  status: string;
  next_retry_at: string | null;
  shopify_contract_id: string | null;
  workspace_id: string;
}

/**
 * Tiny fake admin that models only the shape `countStuckDunningCycles` uses:
 *   `.from("dunning_cycles").select("id",{count:"exact",head:true}).eq(...).lt(...)
 *    .not("shopify_contract_id","ilike","internal-%").neq("workspace_id", sandbox)` → { count }
 * The chain resolves with `{ count, error: null }` — matching the head-only count contract.
 */
function fakeStuckDunningAdmin(rows: FakeStuckDunningRow[]): ReturnType<typeof createAdminClient> {
  const build = () => {
    let filtered: FakeStuckDunningRow[] = rows.map((r) => ({ ...r }));
    let head = false;
    const chain = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) head = true;
        return chain;
      },
      eq: (col: keyof FakeStuckDunningRow, val: unknown) => {
        filtered = filtered.filter((r) => r[col] === val);
        return chain;
      },
      lt: (col: keyof FakeStuckDunningRow, val: string) => {
        filtered = filtered.filter((r) => {
          const cell = r[col] as string | null;
          if (cell == null) return false; // null-safe: null next_retry_at is excluded
          return cell < val;
        });
        return chain;
      },
      neq: (col: keyof FakeStuckDunningRow, val: unknown) => {
        filtered = filtered.filter((r) => r[col] !== val);
        return chain;
      },
      not: (col: keyof FakeStuckDunningRow, op: string, val: string) => {
        if (op !== "ilike") throw new Error(`fake only models ilike, got ${op}`);
        // SQL `%` → prefix match, case-insensitive; keep rows that do NOT match.
        const prefix = val.replace(/%$/, "").toLowerCase();
        filtered = filtered.filter((r) => {
          const cell = (r[col] as string | null)?.toLowerCase() ?? "";
          return !cell.startsWith(prefix);
        });
        return chain;
      },
      then: (onFulfilled: (v: { count: number; data: null; error: null }) => unknown) =>
        Promise.resolve(onFulfilled({ count: head ? filtered.length : filtered.length, data: null, error: null })),
    } as unknown as Record<string, unknown>;
    return chain;
  };
  return { from: (_t: string) => build() } as unknown as ReturnType<typeof createAdminClient>;
}

// Fixed clock so `stuckBeforeIso` is deterministic in the fixtures below.
const STUCK_BEFORE_ISO = "2026-07-14T00:00:00.000Z"; // "now - grace" for the fixtures
const OVERDUE_RETRY_ISO = "2026-07-13T00:00:00.000Z"; // strictly before → stuck
const FRESH_RETRY_ISO = "2026-07-14T06:00:00.000Z"; // strictly after → not yet stuck

test("countStuckDunningCycles: overdue internal-* retrying cycle yields ZERO — it's Braintree work, not payday-retry-cron's", async () => {
  const admin = fakeStuckDunningAdmin([
    // Overdue, retrying, but on an internal-* contract → the payday retry cron never selects it
    // (see dunning-payday-retry-cron find-retryable-cycles), so it must not page that tile.
    { status: "retrying", next_retry_at: OVERDUE_RETRY_ISO, shopify_contract_id: "internal-abc-123", workspace_id: WS },
    { status: "retrying", next_retry_at: OVERDUE_RETRY_ISO, shopify_contract_id: "INTERNAL-DEF-456", workspace_id: WS }, // ilike is case-insensitive
  ]);
  const n = await countStuckDunningCycles(admin, STUCK_BEFORE_ISO);
  assert.equal(n, 0);
});

test("countStuckDunningCycles: overdue non-internal retrying cycle still counts as one", async () => {
  const admin = fakeStuckDunningAdmin([
    { status: "retrying", next_retry_at: OVERDUE_RETRY_ISO, shopify_contract_id: "gid://shopify/SubscriptionContract/789", workspace_id: WS },
  ]);
  const n = await countStuckDunningCycles(admin, STUCK_BEFORE_ISO);
  assert.equal(n, 1);
});

test("countStuckDunningCycles: mix of internal + Appstle overdue rows returns ONLY the Appstle count (mirrors payday-retry-cron scope)", async () => {
  const admin = fakeStuckDunningAdmin([
    { status: "retrying", next_retry_at: OVERDUE_RETRY_ISO, shopify_contract_id: "internal-11111111", workspace_id: WS },
    { status: "retrying", next_retry_at: OVERDUE_RETRY_ISO, shopify_contract_id: "internal-22222222", workspace_id: WS },
    { status: "retrying", next_retry_at: OVERDUE_RETRY_ISO, shopify_contract_id: "gid://shopify/SubscriptionContract/333", workspace_id: WS },
    { status: "retrying", next_retry_at: OVERDUE_RETRY_ISO, shopify_contract_id: "gid://shopify/SubscriptionContract/444", workspace_id: WS },
  ]);
  const n = await countStuckDunningCycles(admin, STUCK_BEFORE_ISO);
  assert.equal(n, 2);
});

test("countStuckDunningCycles: non-retrying, fresh-retry, or null-retry rows are excluded regardless of contract type", async () => {
  const admin = fakeStuckDunningAdmin([
    // Not retrying — outside the assertion's scope entirely.
    { status: "recovered", next_retry_at: OVERDUE_RETRY_ISO, shopify_contract_id: "gid://shopify/SubscriptionContract/1", workspace_id: WS },
    // Retrying but next_retry_at hasn't passed yet — not stuck.
    { status: "retrying", next_retry_at: FRESH_RETRY_ISO, shopify_contract_id: "gid://shopify/SubscriptionContract/2", workspace_id: WS },
    // Retrying but no next_retry_at yet — awaiting scheduling, null-safe exclusion.
    { status: "retrying", next_retry_at: null, shopify_contract_id: "gid://shopify/SubscriptionContract/3", workspace_id: WS },
  ]);
  const n = await countStuckDunningCycles(admin, STUCK_BEFORE_ISO);
  assert.equal(n, 0);
});

test("countStuckDunningCycles: spec-test sandbox stuck-dunning fixture is always excluded", async () => {
  const admin = fakeStuckDunningAdmin([
    { status: "retrying", next_retry_at: OVERDUE_RETRY_ISO, shopify_contract_id: "gid://shopify/SubscriptionContract/999", workspace_id: SANDBOX_WS },
  ]);
  const n = await countStuckDunningCycles(admin, STUCK_BEFORE_ISO);
  assert.equal(n, 0);
});

// ── countSegmentStaleTail — post-cron opt-in grace (segment-coverage-ignore-post-cron-opt-ins P1) ──
// The stale-tail head-count blames the refresh-customer-segments cron for subscribed rows with
// segments_refreshed_at >48h or NULL. An EXISTING customer whose row updates AFTER the last
// refresh beat (e.g. an SMS opt-in flipped `sms_marketing_status` to 'subscribed' after the daily
// cron completed) is graced from the count until the next scheduled cycle — the cron never had a
// chance to see them in their new state. Pre-existing stale subscribers still count.
interface FakeCustomerRow {
  sms_marketing_status: string;
  workspace_id: string;
  created_at: string;
  updated_at: string;
  segments_refreshed_at: string | null;
}

/**
 * Tiny fake admin modelling the shape `countSegmentStaleTail` uses on the `customers` table:
 *   .from("customers").select("id",{count:"exact",head:true})
 *     .eq("sms_marketing_status","subscribed").neq("workspace_id", sandbox)
 *     [.lte("created_at", beat).lte("updated_at", beat)]
 *     .or("segments_refreshed_at.is.null,segments_refreshed_at.lt.<iso>") → { count }
 */
function fakeSegmentCustomersAdmin(rows: FakeCustomerRow[]): ReturnType<typeof createAdminClient> {
  const build = () => {
    let filtered: FakeCustomerRow[] = rows.map((r) => ({ ...r }));
    const chain = {
      select: (_cols?: string, _opts?: { count?: string; head?: boolean }) => chain,
      eq: (col: keyof FakeCustomerRow, val: unknown) => {
        filtered = filtered.filter((r) => r[col] === val);
        return chain;
      },
      neq: (col: keyof FakeCustomerRow, val: unknown) => {
        filtered = filtered.filter((r) => r[col] !== val);
        return chain;
      },
      lte: (col: keyof FakeCustomerRow, val: string) => {
        filtered = filtered.filter((r) => {
          const cell = r[col] as string | null;
          if (cell == null) return false;
          return cell <= val;
        });
        return chain;
      },
      or: (expr: string) => {
        // Model exactly the two-clause OR the helper builds:
        //   `segments_refreshed_at.is.null,segments_refreshed_at.lt.<iso>`
        const match = /^segments_refreshed_at\.is\.null,segments_refreshed_at\.lt\.(.+)$/.exec(expr);
        if (!match) throw new Error(`fake only models the segment stale-tail .or clause, got: ${expr}`);
        const cutoff = match[1];
        filtered = filtered.filter((r) => r.segments_refreshed_at == null || r.segments_refreshed_at < cutoff);
        return chain;
      },
      then: (onFulfilled: (v: { count: number; data: null; error: null }) => unknown) =>
        Promise.resolve(onFulfilled({ count: filtered.length, data: null, error: null })),
    } as unknown as Record<string, unknown>;
    return chain;
  };
  return { from: (_t: string) => build() } as unknown as ReturnType<typeof createAdminClient>;
}

const SEG_BEAT_ISO = "2026-08-14T07:00:00.000Z"; // "latest daily refresh cron beat"
const SEG_STALE_CUTOFF_ISO = "2026-08-12T07:00:00.000Z"; // 48h before the beat
const SEG_WS = "22222222-2222-4222-8222-222222222222";

test("countSegmentStaleTail: pre-existing SMS-subscribed customer >48h stale still counts (regression guard for existing stale-tail behavior)", async () => {
  const admin = fakeSegmentCustomersAdmin([
    {
      sms_marketing_status: "subscribed",
      workspace_id: SEG_WS,
      created_at: "2026-08-01T00:00:00.000Z", // before the beat
      updated_at: "2026-08-01T00:00:00.000Z", // before the beat
      segments_refreshed_at: "2026-08-10T00:00:00.000Z", // >48h stale vs beat
    },
  ]);
  const n = await countSegmentStaleTail(admin, {
    staleCutoffIso: SEG_STALE_CUTOFF_ISO,
    latestSegmentsCronBeatIso: SEG_BEAT_ISO,
  });
  assert.equal(n, 1);
});

test("countSegmentStaleTail: existing customer created BEFORE beat but UPDATED AFTER beat with NULL segments_refreshed_at is graced (post-cron opt-in scenario)", async () => {
  const admin = fakeSegmentCustomersAdmin([
    {
      sms_marketing_status: "subscribed",
      workspace_id: SEG_WS,
      created_at: "2026-08-01T00:00:00.000Z", // pre-existing customer
      updated_at: "2026-08-14T10:00:00.000Z", // opted in AFTER the 07:00 refresh beat
      segments_refreshed_at: null, // cron didn't see them as subscribed at run time
    },
  ]);
  const n = await countSegmentStaleTail(admin, {
    staleCutoffIso: SEG_STALE_CUTOFF_ISO,
    latestSegmentsCronBeatIso: SEG_BEAT_ISO,
  });
  // The post-cron update grace excludes them — the cron never had a chance to refresh their new
  // sms_marketing_status='subscribed' state until the next scheduled cycle.
  assert.equal(n, 0);
});

test("countSegmentStaleTail: brand-new subscriber created AFTER beat is graced (segment-coverage-ignore-post-cron-new-subscribers Phase 1 regression guard)", async () => {
  const admin = fakeSegmentCustomersAdmin([
    {
      sms_marketing_status: "subscribed",
      workspace_id: SEG_WS,
      created_at: "2026-08-14T12:00:00.000Z", // AFTER the 07:00 beat
      updated_at: "2026-08-14T12:00:00.000Z",
      segments_refreshed_at: null,
    },
  ]);
  const n = await countSegmentStaleTail(admin, {
    staleCutoffIso: SEG_STALE_CUTOFF_ISO,
    latestSegmentsCronBeatIso: SEG_BEAT_ISO,
  });
  assert.equal(n, 0);
});

test("countSegmentStaleTail: fallback path (no beat ever recorded) keeps the unfiltered count so a never-firing cron still trips", async () => {
  const admin = fakeSegmentCustomersAdmin([
    {
      sms_marketing_status: "subscribed",
      workspace_id: SEG_WS,
      // Everything post-hypothetical-beat — but without a beat we can't know that, so the
      // unfiltered NULL/>48h shape must still count so a truly-registered-but-never-firing
      // cron doesn't hide behind the grace.
      created_at: "2026-08-14T12:00:00.000Z",
      updated_at: "2026-08-14T12:00:00.000Z",
      segments_refreshed_at: null,
    },
  ]);
  const n = await countSegmentStaleTail(admin, {
    staleCutoffIso: SEG_STALE_CUTOFF_ISO,
    latestSegmentsCronBeatIso: null,
  });
  assert.equal(n, 1);
});

test("countSegmentStaleTail: spec-test sandbox subscriber is always excluded", async () => {
  const admin = fakeSegmentCustomersAdmin([
    {
      sms_marketing_status: "subscribed",
      workspace_id: SANDBOX_WS, // sandbox
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
      segments_refreshed_at: null,
    },
  ]);
  const n = await countSegmentStaleTail(admin, {
    staleCutoffIso: SEG_STALE_CUTOFF_ISO,
    latestSegmentsCronBeatIso: SEG_BEAT_ISO,
  });
  assert.equal(n, 0);
});

test("SEGMENT_COVERAGE_POST_CRON_UPDATE_GRACE fingerprint is present in monitor.ts (grep-able marker for the post-cron opt-in grace)", () => {
  const monitorSrc = readFileSync(resolve(__dirname, "./monitor.ts"), "utf8");
  assert.ok(
    monitorSrc.includes("SEGMENT_COVERAGE_POST_CRON_UPDATE_GRACE"),
    "monitor.ts must carry the SEGMENT_COVERAGE_POST_CRON_UPDATE_GRACE fingerprint " +
      "so a grep locates the post-cron opt-in grace behavior",
  );
  assert.equal(SEGMENT_COVERAGE_POST_CRON_UPDATE_GRACE, "segment-coverage-ignore-post-cron-opt-ins");
});

// ── segment-coverage stale-tail run-in-progress grace (segment-coverage-stale-tail-run-grace) ──
// During the daily refresh-customer-segments fan-out the monitor can sample the still-in-progress
// boundary and read a subscriber as stale seconds before its fresh timestamp commits. The
// assertion waits for the run grace to elapse from the loop's latest heartbeat before declaring
// a stale tail; a missing heartbeat falls back to enforcing the rule so a never-firing cron
// can't hide behind the grace.
const SEGMENT_COVERAGE_LOOP = MONITORED_LOOPS.find((l) => l.id === "refresh-customer-segments-cron")!;
assert.ok(SEGMENT_COVERAGE_LOOP, "refresh-customer-segments-cron must be a registered monitored loop");
assert.equal(SEGMENT_COVERAGE_LOOP.outputAssertion, "segment-coverage");

const ONE_HOUR_MS = 60 * 60_000;

function baselineAssertionInputs(overrides: Partial<AssertionInputs>): AssertionInputs {
  return {
    escalatedWaiting: 0,
    oldestEscalatedAt: null,
    latestTriageJobAt: null,
    latestSpecTestJobAt: null,
    overdueInternalSubs: 0,
    renewalCurrent: {
      total: 0,
      charged: 0,
      skipped_no_payment_method: 0,
      skipped_zero_total: 0,
      declined_to_dunning: 0,
      comp_shipped: 0,
      comp_blocked: 0,
      skipped_other: 0,
    },
    renewalBaseline: {
      total: 0,
      charged: 0,
      skipped_no_payment_method: 0,
      skipped_zero_total: 0,
      declined_to_dunning: 0,
      comp_shipped: 0,
      comp_blocked: 0,
      skipped_other: 0,
    },
    stuckDunningCycles: 0,
    smsSubscribedTotal: 0,
    smsSubscribedFresh26h: 0,
    smsSubscribedStale48h: 0,
    ...overrides,
  };
}

function segmentCoverageLatest(ranAtIso: string): LoopHistoryRow {
  return { ran_at: ranAtIso, ok: true, produced: null, detail: null, duration_ms: null };
}

test("evalOutputAssertion segment-coverage: does NOT alert on stale-tail while the refresh cron beat is still inside the run grace (false-alert during healthy fan-out)", () => {
  // A healthy fan-out that started 5 minutes ago — the monitor sampled the still-in-progress
  // boundary and sees 3 subscribers with a NULL/>48h segments_refreshed_at. That is the
  // expected shape of an in-progress walk, not a break.
  const ranAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const verdict = evalOutputAssertion(
    "segment-coverage",
    SEGMENT_COVERAGE_LOOP,
    segmentCoverageLatest(ranAt),
    baselineAssertionInputs({
      smsSubscribedTotal: 500,
      smsSubscribedFresh26h: 495,
      smsSubscribedStale48h: 3,
    }),
  );
  assert.equal(verdict, null);
});

test("evalOutputAssertion segment-coverage: alerts on stale-tail once the refresh cron beat is outside the run grace (real break stays flagged)", () => {
  // Same stale subscribers, but the last beat was 7 hours ago — well past the 6h run grace.
  // The cron ran but part of the book didn't refresh, and the tile must go red.
  const ranAt = new Date(Date.now() - 7 * ONE_HOUR_MS).toISOString();
  const verdict = evalOutputAssertion(
    "segment-coverage",
    SEGMENT_COVERAGE_LOOP,
    segmentCoverageLatest(ranAt),
    baselineAssertionInputs({
      smsSubscribedTotal: 500,
      smsSubscribedFresh26h: 495,
      smsSubscribedStale48h: 3,
    }),
  );
  assert.ok(verdict, "stale-tail must trip after the run grace elapses");
  assert.equal(verdict!.violation.reason, "segment_coverage");
  assert.ok(
    /stale-tail/i.test(verdict!.violation.detail),
    `violation detail should describe the stale-tail: ${verdict!.violation.detail}`,
  );
});

test("evalOutputAssertion segment-coverage: missing heartbeat still trips stale-tail (fallback — a never-firing cron can't hide behind the run grace)", () => {
  const verdict = evalOutputAssertion(
    "segment-coverage",
    SEGMENT_COVERAGE_LOOP,
    null,
    baselineAssertionInputs({
      smsSubscribedTotal: 500,
      smsSubscribedFresh26h: 495,
      smsSubscribedStale48h: 3,
    }),
  );
  assert.ok(verdict, "no heartbeat ⇒ no grace, stale-tail must still trip");
  assert.equal(verdict!.violation.reason, "segment_coverage");
});

test("SEGMENT_COVERAGE_STALE_TAIL_RUN_GRACE fingerprint is present in monitor.ts (grep-able marker for the stale-tail run-in-progress grace)", () => {
  const monitorSrc = readFileSync(resolve(__dirname, "./monitor.ts"), "utf8");
  assert.ok(
    monitorSrc.includes("SEGMENT_COVERAGE_STALE_TAIL_RUN_GRACE"),
    "monitor.ts must carry the SEGMENT_COVERAGE_STALE_TAIL_RUN_GRACE fingerprint " +
      "so a grep locates the stale-tail run-in-progress grace behavior",
  );
  assert.equal(SEGMENT_COVERAGE_STALE_TAIL_RUN_GRACE, "segment-coverage-stale-tail-run-grace");
});

// Fingerprint guard: the monitor query MUST carry the same internal-* exclusion the payday
// retry cron uses. If either side drifts, the tile becomes a false page again — that's the
// exact incident this spec fixes.
test("monitor.ts stuck-dunning helper mirrors dunning-payday-retry-cron's find-retryable-cycles internal-* filter", () => {
  const monitorSrc = readFileSync(resolve(__dirname, "./monitor.ts"), "utf8");
  const cronSrc = readFileSync(resolve(__dirname, "../inngest/dunning.ts"), "utf8");
  const FINGERPRINT = '.not("shopify_contract_id", "ilike", "internal-%")';
  assert.ok(
    monitorSrc.includes(FINGERPRINT),
    "src/lib/control-tower/monitor.ts must exclude internal-% shopify_contract_id from the stuck-dunning count " +
      "(build-control-tower-stuck-dunning-scope-to-payday-cron Phase 1)",
  );
  assert.ok(
    cronSrc.includes(FINGERPRINT),
    "src/lib/inngest/dunning.ts find-retryable-cycles must still carry the internal-% exclusion the monitor mirrors",
  );
});
