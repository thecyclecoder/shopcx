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
import { evalAgentKind, evalCron, evalWorker, extractCronExpr, firstScheduledFiringMs, jobStuckSince, nextFiringAtOrAfter, parseCronExpr, type ActiveJob, type WorkerRow } from "./monitor";
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
    const result = evalWorker(workerLoop, idleBehindWorker(), 3, false);
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
    const result = evalWorker(workerLoop, idleBehindWorker(), 0, false);
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
    const result = evalWorker(workerLoop, idleBehindWorker(), 5, true);
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
    const result = evalWorker(workerLoop, idleBehindWorker({ active_builds: 2 }), 0, false);
    assert.equal(result.color, "green");
    assert.equal(result.violation, null);
    assert.match(result.statusText, /building — update deferred/);
  } finally {
    Date.now = realNow;
    if (realEnv === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = realEnv;
  }
});
