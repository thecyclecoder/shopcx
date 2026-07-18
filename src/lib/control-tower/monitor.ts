/**
 * Control Tower — monitor + snapshot (control-tower spec, Phase 1).
 *
 * `buildControlTowerSnapshot` is the READ-ONLY evaluation: for every registered
 * loop it computes a green/amber/red tile from worker_heartbeats (the box),
 * loop_heartbeats (crons + agent kinds), open loop_alerts, and in-flight
 * agent_jobs (stuck detection). The dashboard renders this verbatim.
 *
 * `runControlTowerMonitor` runs the same evaluation, then ACTS on it: it opens a
 * de-duped alert per red loop (one open incident per loop, paging the owners on
 * first sight) and auto-resolves an open alert the moment its loop goes healthy.
 * Called by the control-tower-monitor cron (~every 15 min).
 *
 * Three checks, matching the registry's loop kinds:
 *   - LIVENESS (worker)     — last_poll_at fresh + running_sha not behind origin/main too long.
 *   - CRON FRESHNESS (cron) — a heartbeat within the loop's window.
 *   - STUCK JOBS (agent)    — no agent_jobs queued/building past the per-kind threshold.
 * Healthy / genuinely-idle loops are GREEN — assertions never false-positive on a
 * fine-but-quiet loop (no escalations to triage, no builds queued = green, not red).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyOpsAlert } from "@/lib/notify-ops-alert";
import {
  MONITORED_LOOPS,
  OWNER_FUNCTIONS,
  RENEWAL_BAD_OUTCOMES,
  WORKER_BOX_ID,
  type LoopKind,
  type MonitoredLoop,
  type OutputAssertionId,
  type OwnerFunction,
} from "@/lib/control-tower/registry";
import { aggregateRenewalOutcomes, type RenewalOutcomeCounts } from "@/lib/control-tower/heartbeat";
import { buildCoverageAudit, type CoverageAudit } from "@/lib/control-tower/self-audit";
import { SPEC_TEST_FIXTURES } from "@/lib/spec-test-sandbox";

// The permanent spec-test sandbox tenant (is_test=true). Its seeded fixtures are deliberately stuck
// (e.g. SPEC_TEST_FIXTURES.subscriptionCompId is a comp sub whose customer has no comp_role, so the
// fail-closed comp gate intentionally never advances it). Output-assertion integrity queries scan
// GLOBAL tables, so without this exclusion a synthetic fixture reads as a real production anomaly and
// trips a loop tile RED. Every assertion query over a workspace-scoped table excludes this tenant.
const SPEC_TEST_SANDBOX_WORKSPACE_ID = SPEC_TEST_FIXTURES.workspaceId;

type Admin = ReturnType<typeof createAdminClient>;

export type LoopColor = "green" | "amber" | "red";

export interface LoopHistoryRow {
  ran_at: string;
  ok: boolean;
  produced: unknown;
  detail: string | null;
  duration_ms: number | null;
}

export interface OpenAlert {
  id: string;
  reason: string;
  detail: string;
  opened_at: string;
  last_seen_at: string;
}

export interface LoopStatus {
  id: string;
  kind: LoopKind;
  /** Phase 3: the org-chart function that owns this loop (drives the department rollups). */
  owner: OwnerFunction;
  label: string;
  description: string;
  expectedCadence: string;
  color: LoopColor;
  statusText: string;
  lastRanAt: string | null;
  lastProduced: unknown;
  detail: string | null;
  /** set when color === 'red' — the violation an alert records. */
  violation: { reason: string; detail: string } | null;
  history: LoopHistoryRow[];
  openAlert: OpenAlert | null;
}

/**
 * Phase 3: a per-department rollup health tile (CEO-glance). One per org function that owns at
 * least one loop — worst-of color across its loops, a healthy/total count + open-alert count.
 */
export interface DepartmentRollup {
  owner: OwnerFunction;
  /** Short department label ("Platform", "Growth", …). */
  label: string;
  /** Rollup-tile health label ("Platform Health", …). */
  healthLabel: string;
  color: LoopColor;
  total: number;
  healthy: number;
  counts: { green: number; amber: number; red: number };
  openAlerts: number;
}

export interface ControlTowerSnapshot {
  generatedAt: string;
  counts: { green: number; amber: number; red: number };
  loops: LoopStatus[];
  /** Phase 3 department rollups (CEO-glance, worst-of per org function). */
  departments: DepartmentRollup[];
  /** Phase 2 coverage self-audit: crons in code with no tile + the in-code↔Inngest-registered diff. */
  selfAudit: CoverageAudit;
}

const HISTORY_LIMIT = 10;

/**
 * Feeder-cadence grace for the `tickets-awaiting-qc` work probe (ticket-analyzer-workprobe-cron-grace).
 * The ai:ticket-analyzer is fed by ticket-analysis-cron (every 30 min), which stamps last_analyzed_at
 * even on skip. A closed AI ticket only counts as 'awaited but unserviced' once it has survived at
 * least one FULL feeder cycle still unprocessed (last_analyzed_at null) — so a ticket closing between
 * cron ticks (the 20:30→~21:00 gap that fired the false idle_while_work) isn't counted before any cron
 * cycle could service it. Grace = one 30-min cadence + a buffer for the cron+analyzer run latency. A
 * genuinely-stuck analyzer (the ticket survives a whole cycle unprocessed) still trips the alert. */
const TICKET_ANALYSIS_FEEDER_GRACE_MS = 40 * 60_000;

/**
 * Cora's settle window for the `tickets-awaiting-qc` work probe
 * (ticket-analyzer-workprobe-last-customer-settle-grace). Mirrors CORA_CLOSE_SETTLE_MS in
 * src/lib/inngest/ticket-analysis-cron.ts — the cron's `passesCoraSelectionGate` requires
 * `last_customer_message_at` to be at least this old before it will select the ticket. Keeping the
 * probe keyed on `updated_at` alone (without this settle window) flags a ticket the cron is
 * DELIBERATELY waiting on as "awaited but unserviced" and fires a false idle_while_work on
 * loop:ai:ticket-analyzer. If the cron's constant moves, the sibling regression test pins the two
 * to match so this doesn't silently drift. */
const TICKET_ANALYSIS_CORA_SETTLE_MS = 30 * 60_000;

/**
 * Settle window for the `tickets-awaiting-handler-dispatch` work probe
 * (control-tower-unified-handler-dispatch-workprobe). Mirrors INTENT_SETTLE_MS in
 * src/lib/inngest/unanswered-inbound-backstop-cron.ts — every ingest chokepoint stamps
 * `dispatch_pending_at` BEFORE firing `ticket/inbound-message`, and the handler's
 * `clearDispatchIntent` clears it at the top of every claimed run. A stamp older than this window
 * with no clear is the same signal the backstop reconciler uses to re-fire a lost send. Keeping
 * the probe on the SAME boundary means the tile alerts on exactly the set of dispatched inbounds
 * the reconciler is about to re-fire — never on a raw inbound still inside the Inngest delivery
 * window. If the cron's constant moves, the sibling regression test pins the two to match so this
 * doesn't silently drift. */
const HANDLER_DISPATCH_SETTLE_MS = 3 * 60_000;

/**
 * Settle window for the `tickets-awaiting-decision` work probe
 * (control-tower-ticket-decision-workprobe-settle-and-outreach-bypass). An inbound customer
 * message becomes eligible to count as ai:orchestrator demand only AFTER this window closes;
 * anything fresher is still inside the pre-orchestrator handling race — the classifier may still
 * be running, the outreach deterministic-close may not have stamped `status='closed'` /
 * `tags cs {outreach, cls:outreach}` yet, and a Sol first-touch `ticket-handle` job may not
 * have been enqueued. Without this window the monitor can query in the ~seconds between the
 * inbound insert and the handler's short-circuit and count a legitimately-bypassed inbound
 * (a cold Flippa-style outreach pitch, an outreach-tagged brand pitch, a Sol first-touch async
 * email) as orchestrator work with 0 beats — the exact monitor-false-positive that flipped
 * loop:ai:orchestrator red on healthy traffic. Same boundary shape as HANDLER_DISPATCH_SETTLE_MS
 * — mirror the deterministic pre-orchestrator gates rather than the raw inbound event. */
const TICKET_DECISION_SETTLE_MS = 3 * 60_000;

/** Compact elapsed string from an ISO timestamp to now (e.g. "3m", "2h", "1d"). */
function elapsed(iso: string | null | undefined): string {
  if (!iso) return "never";
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86_400)}d`;
}

function ageMs(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  return Date.now() - new Date(iso).getTime();
}

/**
 * When the ticket-analyzer's `tickets-awaiting-qc` work probe should FIRST regard a candidate
 * ticket as truly eligible for the next feeder cycle to service
 * (ticket-analyzer-workprobe-eligibility-grace).
 *
 * The prior probe used only `last_customer_message_at + CORA_SETTLE` as the eligibility clock,
 * so a ticket the customer last messaged hours ago but that only closed / was handled a few
 * minutes ago was already "past cutoff" and counted as awaited work — even though the ticket
 * literally became gradeable a moment earlier, before any 30-min cron tick could have picked
 * it up. Result: a false `idle_while_work` on loop:ai:ticket-analyzer during the between-tick
 * gap the fresh close landed in.
 *
 * The real eligibility ready-at is the LATEST of the anchors the cron's `passesCoraSelectionGate`
 * requires simultaneously:
 *   1. the later handled stamp (ai_handled_at OR sol_handled_at — the cron treats either as
 *      "we handled it"; whichever fired last is when the current handling cycle began);
 *   2. `closed_at` (the cron requires the ticket to be closed at all);
 *   3. `last_customer_message_at + CORA_SETTLE` (the settle window on customer activity).
 *
 * A candidate with no customer message OR no handled stamp OR no closed_at is not eligible at
 * all — the cron would skip it — so this returns `null` in those cases and the probe skips it
 * too. The probe caller then only counts a candidate whose ready-at is older than a full feeder
 * cycle (TICKET_ANALYSIS_FEEDER_GRACE_MS), giving the ticket-analysis-cron a fair chance to run.
 */
export function ticketAnalyzerEligibilityReadyAt(args: {
  closedAtMs: number | null;
  aiHandledAtMs: number | null;
  solHandledAtMs: number | null;
  latestCustomerMessageAtMs: number | null;
  coraSettleMs: number;
}): number | null {
  if (args.closedAtMs == null) return null;
  if (args.latestCustomerMessageAtMs == null) return null;
  const handledMs =
    args.aiHandledAtMs != null && args.solHandledAtMs != null
      ? Math.max(args.aiHandledAtMs, args.solHandledAtMs)
      : (args.aiHandledAtMs ?? args.solHandledAtMs);
  if (handledMs == null) return null;
  const settleReadyAt = args.latestCustomerMessageAtMs + args.coraSettleMs;
  return Math.max(args.closedAtMs, handledMs, settleReadyAt);
}

/** Compact duration string from a millisecond span (e.g. "3m", "2h", "1d"). */
function fmtDur(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86_400)}d`;
}

// ── registered_not_firing grace clock (control-tower-cron-grace-uses-next-firing-after-registration) ──
// The grace starts at the cron's FIRST scheduled firing at-or-after `registeredAt`, not at
// `registeredAt` itself. A daily cron registered just after its hour-of-day tick (e.g.
// security-dep-watch at `0 4 * * *` with registeredAt 00:00 UTC + a deploy that landed at 04:08)
// would otherwise false-page registered_not_firing 26h after midnight even though the first valid
// firing was at 04:00 the next day. We parse the cron expression carried inside `expectedCadence`
// (e.g. "daily (0 4 * * *)"), compute the first firing at-or-after registeredAt, and use THAT as
// the grace anchor — preserving the red for genuinely-dead schedules but removing the boundary
// false-page. Computed once per loop and memoized (both inputs are code constants).
import { extractCronExpr, parseCronExpr, type CronSets } from "./cron-parse";
export { extractCronExpr, parseCronExpr, type CronSets };

function cronDayMatch(sets: CronSets, t: Date): boolean {
  const dom = t.getUTCDate();
  const dow = t.getUTCDay();
  const domRestricted = sets.dayOfMonth.size !== 31;
  const dowRestricted = sets.dayOfWeek.size !== 7;
  // Standard Vixie cron: if BOTH day-of-month and day-of-week are restricted, match either.
  if (domRestricted && dowRestricted) return sets.dayOfMonth.has(dom) || sets.dayOfWeek.has(dow);
  if (domRestricted) return sets.dayOfMonth.has(dom);
  if (dowRestricted) return sets.dayOfWeek.has(dow);
  return true;
}

/** First firing at-or-after `from` for the given cron expression, in UTC. Returns null when the
 *  expression can't be parsed (caller stays conservative — falls back to registeredAt). */
export function nextFiringAtOrAfter(from: Date, expr: string): Date | null {
  const sets = parseCronExpr(expr);
  if (!sets) return null;
  // Round up to the next whole minute (cron fires on minute boundaries; ms/sec ⇒ post-tick).
  const t = new Date(from.getTime());
  t.setUTCMilliseconds(0);
  if (t.getUTCSeconds() !== 0) {
    t.setUTCSeconds(0);
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  // Walk at most 8 days: any standard 5-field cron matches within a week, +1d safety margin.
  const MAX_MINUTES = 8 * 24 * 60;
  for (let i = 0; i < MAX_MINUTES; i++) {
    if (
      sets.minute.has(t.getUTCMinutes()) &&
      sets.hour.has(t.getUTCHours()) &&
      sets.month.has(t.getUTCMonth() + 1) &&
      cronDayMatch(sets, t)
    ) {
      return t;
    }
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  return null;
}

/** ms-since-epoch of the loop's grace anchor — the LATER of:
 *  (a) the cron's first scheduled firing at-or-after `registeredAt`, parsed from the cadence
 *      (falls back to `registeredAt` itself when the cadence carries no parseable cron expression,
 *      e.g. "box job" cadences), and
 *  (b) `firstObservedMs` — the empirical first time the snapshot SAW this loop registered, read
 *      from `monitored_loops_first_seen` (a deploy-SURVIVING per-loop anchor).
 *
 *  The empirical anchor prevents a hand-edited registeredAt SET BEFORE the cron actually shipped
 *  from shortening the grace below "we have actually seen this loop registered for one full
 *  window" — fleet-spend-governor (registeredAt 00:00 UTC with cadence `10,40 * * * *`) was
 *  computing a first firing of 00:10 SAME day, so its 90-min grace evaporated the moment the
 *  deploy landed; using max() with first_observed_at restores the window
 *  (control-tower-registered-not-firing-observed-anchor-grace P1).
 *
 *  Returns null when the loop has no `registeredAt` AND no `firstObservedMs` (no grace clock). */
export function firstScheduledFiringMs(loop: MonitoredLoop, firstObservedMs: number | null = null): number | null {
  let result: number | null = null;
  if (loop.registeredAt) {
    const registered = Date.parse(loop.registeredAt);
    if (Number.isFinite(registered)) {
      result = registered;
      const expr = extractCronExpr(loop.expectedCadence);
      if (expr) {
        const next = nextFiringAtOrAfter(new Date(registered), expr);
        if (next) result = next.getTime();
      }
    }
  }
  if (firstObservedMs != null && Number.isFinite(firstObservedMs)) {
    result = result != null ? Math.max(result, firstObservedMs) : firstObservedMs;
  }
  return result;
}

// Per-account Max load the box worker writes onto its heartbeat (box-multi-account-failover Phase 2). The
// box tile reads `all_capped` to surface a (non-silent) all-accounts-capped state, and shows per-account load.
interface AccountsSnapshot {
  pool?: { label: string; in_flight: number; capped: boolean; capped_until: string | null }[];
  healthy?: number;
  total?: number;
  all_capped?: boolean;
  soonest_reset?: string | null;
}
export interface WorkerRow {
  running_sha: string | null;
  status: string | null;
  active_builds: number | null;
  detail: string | null;
  last_poll_at: string | null;
  started_at: string | null;
  accounts: AccountsSnapshot | null;
}

export interface ActiveJob {
  id: string;
  kind: string;
  status: string;
  created_at: string | null;
  claimed_at: string | null;
  updated_at: string | null;
}

/** When did this in-flight job last make progress? (claim time for running jobs.)
 *
 * Worker-restart clamp for queued/queued_resume jobs
 * (control-tower-stuck-jobs-clamp-on-worker-restart): a worker that wasn't alive earlier couldn't
 * have claimed earlier than it started, so the queued-floor is `max(base, worker.started_at)`.
 * Without this, a backlog enqueued during a worker-down window is mis-attributed as a stuck lane
 * the moment the worker restarts and false-pages stuck_jobs, even though the lane is actively
 * draining post-restart (the signal `loop:agent:spec-test` incident: 8 spec-test rows queued at
 * 10:45 by the regression-backlog sweep, the box was offline until 11:45, the monitor at 12:00
 * read 75-min ages and went red even though the queue had only existed for 15 min of worker
 * uptime). Building/claimed jobs are NOT clamped — `claimed_at` already reflects the worker that
 * picked them up. */
export function jobStuckSince(j: ActiveJob, workerStartedAt: string | null = null): string | null {
  if (j.status === "building" || j.status === "claimed") {
    return j.claimed_at ?? j.updated_at ?? j.created_at;
  }
  const base = j.updated_at ?? j.created_at;
  if (!workerStartedAt) return base;
  const startedMs = Date.parse(workerStartedAt);
  if (!Number.isFinite(startedMs)) return base;
  if (!base) return workerStartedAt;
  const baseMs = Date.parse(base);
  if (!Number.isFinite(baseMs)) return workerStartedAt;
  return baseMs >= startedMs ? base : workerStartedAt;
}

/**
 * SHA-direction between the deployed runtime (VERCEL_GIT_COMMIT_SHA) and the worker's `running_sha`.
 * "same" ⇒ identical (or one is a prefix of the other); "worker-behind" ⇒ deployed is a descendant of
 * running (the real self-update-stuck condition); "worker-ahead" ⇒ running is a descendant of deployed
 * (the box has already pulled a newer main commit while Vercel still reports the previous one — deploy
 * lag, NOT stuck); "unknown" ⇒ we can't classify (missing SHAs, unrelated commits, or the compare API
 * failed). Only "worker-behind" produces the "self-update stuck" red — the false-positive that reddened
 * a healthy box tile (signal loop:box, verdict monitor-false-positive): worker was running 6f43ec9e0
 * while the deployed runtime still reported b3934ff, an ancestor of 6f43ec9e0.
 */
export type ShaDirection = "same" | "worker-behind" | "worker-ahead" | "unknown";

/**
 * Trivial local classification — no network call. Prefix-equal or identical ⇒ "same"; either side
 * empty ⇒ "unknown". Every other case defers to the GitHub compare API (fetchShaDirection). Kept
 * pure so it's the ONE definition the tests and the runtime share.
 */
export function classifyShaDirectionLocal(deployed: string, running: string): ShaDirection {
  if (!deployed || !running) return "unknown";
  const short = deployed.length <= running.length ? deployed : running;
  const long = deployed.length <= running.length ? running : deployed;
  if (long.slice(0, short.length) === short) return "same";
  return "unknown";
}

const GH_REPO_FOR_COMPARE = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";

function ghCompareToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}

/**
 * The compare result: which side is ahead AND (when the worker is behind) the ISO timestamp of the
 * FIRST commit that landed on origin/main after the worker's running_sha — i.e. the exact moment
 * drift began. `firstDivergentAt` lets `evalWorker` anchor its shaGrace elapsed to when drift
 * actually started rather than to worker uptime, so a fresh commit landing on a long-lived worker
 * doesn't instantly-red before the worker has had its normal self-update poll window.
 */
export type ShaDirectionResult = { direction: ShaDirection; firstDivergentAt: string | null };

/**
 * Ask GitHub which side is ahead — the direction check evalWorker gates its "behind" red on. Fails
 * CLOSED to "unknown" (missing token, unreachable API, unrelated SHAs) so a transient API error can
 * never turn a healthy worker into a red page. On a confirmed worker-behind, also reads
 * `body.commits[0].commit.author.date` — the author date of the FIRST commit past running_sha,
 * which is exactly when the worker fell behind. Called once per snapshot from
 * buildControlTowerSnapshot.
 */
export async function fetchShaDirection(deployed: string, running: string): Promise<ShaDirectionResult> {
  const local = classifyShaDirectionLocal(deployed, running);
  if (local !== "unknown") return { direction: local, firstDivergentAt: null };
  if (!ghCompareToken() || !deployed || !running) return { direction: "unknown", firstDivergentAt: null };
  try {
    // base = running, head = deployed. GitHub returns `status`: "identical" | "ahead" | "behind" | "diverged".
    // "ahead"  ⇒ head (deployed) is ahead of base (running) ⇒ WORKER-BEHIND.
    // "behind" ⇒ head (deployed) is behind base (running)   ⇒ WORKER-AHEAD (deploy lag — healthy).
    const url = `https://api.github.com/repos/${GH_REPO_FOR_COMPARE}/compare/${encodeURIComponent(running)}...${encodeURIComponent(deployed)}`;
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${ghCompareToken()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    });
    if (!r.ok) return { direction: "unknown", firstDivergentAt: null };
    const body = (await r.json()) as {
      status?: string;
      commits?: Array<{ commit?: { author?: { date?: string } } }>;
    };
    if (body.status === "identical") return { direction: "same", firstDivergentAt: null };
    if (body.status === "ahead") {
      // commits[0] is the earliest commit in base..head — the first commit that landed after
      // running_sha, so its author.date IS the moment the worker fell behind. Missing/malformed
      // ⇒ null (evalWorker falls back to the worker-uptime anchor).
      const firstDivergentAt = body.commits?.[0]?.commit?.author?.date ?? null;
      return { direction: "worker-behind", firstDivergentAt };
    }
    if (body.status === "behind") return { direction: "worker-ahead", firstDivergentAt: null };
    return { direction: "unknown", firstDivergentAt: null }; // "diverged" or an unrecognized status — stay conservative.
  } catch {
    return { direction: "unknown", firstDivergentAt: null };
  }
}

export function evalWorker(
  loop: MonitoredLoop,
  row: WorkerRow | null,
  queuedCount = 0,
  manualDrain = false,
  shaDirection: ShaDirection = "unknown",
  firstDivergentAt: string | null = null,
): Omit<LoopStatus, "history" | "openAlert" | "owner"> {
  const base = {
    id: loop.id,
    kind: loop.kind,
    label: loop.label,
    description: loop.description,
    expectedCadence: loop.expectedCadence,
    lastRanAt: row?.last_poll_at ?? null,
    // Per-account Max load rides lastProduced so the box tile shows how each account's quota is burning
    // (box-multi-account-failover Phase 2) alongside the lane count.
    lastProduced: row ? { active_builds: row.active_builds ?? 0, accounts: row.accounts ?? null } : null,
  };
  if (!row || !row.last_poll_at) {
    return { ...base, color: "red", statusText: "no heartbeat — box never reported", detail: row?.detail ?? null, violation: { reason: "liveness", detail: "Box build worker has no heartbeat — it never reported in." } };
  }
  const stale = ageMs(row.last_poll_at) > (loop.livenessWindowMs ?? 5 * 60_000);
  if (stale) {
    return { ...base, color: "red", statusText: `stale — last poll ${elapsed(row.last_poll_at)} ago`, detail: row.detail ?? null, violation: { reason: "liveness", detail: `Box build worker stale since ${row.last_poll_at} (last poll ${elapsed(row.last_poll_at)} ago).` } };
  }
  if (row.status === "needs_attention") {
    return { ...base, color: "red", statusText: `needs attention — ${row.detail ?? "crash-loop"}`, detail: row.detail ?? null, violation: { reason: "liveness", detail: `Box build worker flagged needs_attention: ${row.detail ?? "crash-loop guard tripped"}.` } };
  }
  // All Max accounts capped (box-multi-account-failover Phase 2): builds are parked `blocked_on_usage` and
  // auto-resume at the soonest reset — NOT a failure (no manual rebuild), so AMBER not red. The point is that
  // an "everything's capped" state is no longer silent: a green box tile that's actually building nothing
  // because every account hit its wall would hide a real throughput stall.
  if (row.accounts?.all_capped) {
    const reset = row.accounts.soonest_reset ? ` — soonest reset ${elapsed(row.accounts.soonest_reset)} away` : "";
    return { ...base, color: "amber", statusText: `all Max accounts capped — builds parked, auto-resume${reset}`, detail: row.detail ?? null, violation: null };
  }
  // SHA-direction gate (control-tower-box-sha-direction-check, signal loop:box, verdict
  // monitor-false-positive). The prior check compared `deployed.slice(0, running.length) !== running`
  // and reddened on ANY mismatch — false-paging on the healthy worker-ahead case where the box had
  // already pulled a newer main commit while the deployed Vercel runtime was still reporting the
  // previous ancestor (the originating incident: running 6f43ec9e0, deployed still on b3934ff). We
  // now gate red ONLY on a CONFIRMED worker-behind (deployed is a descendant of running per the
  // GitHub compare API): "worker-ahead" stays green with a deploy-lag note; "unknown" stays
  // conservative — no red on an ambiguous compare (same posture as deployAgeMs==null).
  const deployed = process.env.VERCEL_GIT_COMMIT_SHA || "";
  const running = row.running_sha || "";
  const idle = (row.active_builds ?? 0) === 0;

  // Worker-ahead ⇒ deploy lag, not stuck. Never red.
  if (shaDirection === "worker-ahead") {
    return { ...base, color: "green", statusText: `healthy · ${running || "?"} · deploy lag (Vercel on ${deployed.slice(0, 7)})`, detail: row.detail ?? null, violation: null };
  }
  // Only a CONFIRMED worker-behind enters the queue-aware / behind-red logic below. "same" and
  // "unknown" both fall through to the healthy return at the bottom.
  if (shaDirection !== "worker-behind") {
    return { ...base, color: "green", statusText: `healthy · ${running || "?"} · last poll ${elapsed(row.last_poll_at)} ago`, detail: row.detail ?? null, violation: null };
  }
  // Mirror the worker's queue-aware self-update deferral (scripts/builder-worker.ts:4290 —
  // self-restart-defers-to-idle): when the box is IDLE but `queued > 0` AND no manual drain is set,
  // the worker INTENTIONALLY parks the self-update until a sustained idle so a cascade of queued
  // builds isn't restarted between specs. A MANUAL queue-restart (worker_controls.drain_for_update)
  // still restarts at idle regardless of the queue (that's its purpose), so behindTooLong still
  // reds at grace under a manual drain.
  const queueDeferred = idle && queuedCount > 0 && !manualDrain;
  if (queueDeferred) {
    return { ...base, color: "green", statusText: `idle — update deferred · ${queuedCount} queued (${running} → ${deployed.slice(0, 7)} on sustained idle)`, detail: row.detail ?? null, violation: null };
  }
  // Red when behind+idle AND past shaGrace AND not queue-deferred (queue empty OR manual drain set).
  // Anchor elapsed to the smaller of (worker uptime, drift age): a fresh commit landing on a
  // long-lived worker deserves the full shaGrace poll window before we page — the prior anchor
  // (worker uptime alone) instant-red every long-lived worker on the next commit, defeating the
  // grace. `firstDivergentAt` is the author date of the FIRST commit past running_sha (fetched
  // by fetchShaDirection from GitHub's compare API); when null we fall back to the uptime anchor
  // so the "unknown" / prefix-equal paths behave exactly as before.
  const shaGraceMs = loop.shaGraceMs ?? 30 * 60_000;
  const uptimeElapsedMs = ageMs(row.started_at);
  const driftElapsedMs = firstDivergentAt ? ageMs(firstDivergentAt) : Number.POSITIVE_INFINITY;
  const behindTooLong = idle && !queueDeferred && Math.min(uptimeElapsedMs, driftElapsedMs) > shaGraceMs;
  if (behindTooLong) {
    const stuckFor = firstDivergentAt ? elapsed(firstDivergentAt) : elapsed(row.started_at);
    return { ...base, color: "red", statusText: `behind origin/main — running ${running}, deployed ${deployed.slice(0, 7)}`, detail: row.detail ?? null, violation: { reason: "liveness", detail: `Box build worker is running ${running} but origin/main is ${deployed.slice(0, 7)} — behind for ${stuckFor}${manualDrain ? " (manual drain set)" : ""}.` } };
  }
  // Behind but BUSY (active build in flight) ⇒ the worker is intentionally deferring self-update
  // until its lanes clear (sacrosanct — never kill an in-flight build).
  if (!idle) {
    return { ...base, color: "green", statusText: `building — update deferred (${running} → ${deployed.slice(0, 7)} when idle)`, detail: row.detail ?? null, violation: null };
  }
  // Behind + IDLE but within grace ⇒ it should self-update on its next poll; brief amber.
  return { ...base, color: "amber", statusText: `updating — running ${running}, deployed ${deployed.slice(0, 7)}`, detail: row.detail ?? null, violation: null };
}

/**
 * A trustworthy lower bound on how long the CURRENT deploy has been live, or null when we
 * can't tell (so callers stay conservative — never a false red). The box build worker
 * self-updates to origin/main and restarts on adopting a new SHA, so once its running_sha
 * matches the deployed SHA (VERCEL_GIT_COMMIT_SHA), worker.started_at is ~when this code
 * went live. Used by the never-fired cron check below. (control-tower-complete-coverage P2.)
 */
function deployRefAgeMs(worker: WorkerRow | null): number | null {
  const deployed = process.env.VERCEL_GIT_COMMIT_SHA || "";
  if (!deployed) return null; // local / unknown — never red on a missing first beat.
  if (!worker?.started_at || !worker.running_sha) return null;
  const caughtUp = deployed.slice(0, worker.running_sha.length) === worker.running_sha;
  if (!caughtUp) return null; // box still self-updating to this deploy — be conservative.
  return ageMs(worker.started_at);
}

/**
 * True iff this cron loop runs INSIDE the box build worker process (a BOX-EMITTED cron —
 * migration-drift-check, the db-health passes). Its beats can only land while the worker is up,
 * so cron_freshness / never_fired / registered_not_firing on it during a worker outage is a
 * cascade of the box's own `liveness` red, not an independent lane defect.
 * (control-tower-suppress-box-cron-freshness-during-worker-outage Phase 1)
 */
export function isBoxEmittedCronLoop(loop: MonitoredLoop): boolean {
  return loop.kind === "cron" && loop.runsOnBox === true;
}

export function evalCron(loop: MonitoredLoop, latest: LoopHistoryRow | null, deployAgeMs: number | null, everBeatCount: number, beatsReadFailed = false, monitorUptimeMs: number | null = null, firstObservedMs: number | null = null, workerUnavailable = false): Omit<LoopStatus, "history" | "openAlert" | "owner"> {
  const base = {
    id: loop.id,
    kind: loop.kind,
    label: loop.label,
    description: loop.description,
    expectedCadence: loop.expectedCadence,
    lastRanAt: latest?.ran_at ?? null,
    lastProduced: latest?.produced ?? null,
    detail: latest?.detail ?? null,
  };
  // control-tower-suppress-box-cron-freshness-during-worker-outage Phase 1 — a BOX-EMITTED cron
  // (migration-drift-check, db-health-*) only beats while the box worker is up. When the worker
  // itself is stale/absent/crash-looping, the useful page is loop:box; opening a duplicate red
  // on each box-hosted child cron (cron_freshness / never_fired / registered_not_firing) just
  // pins the wrong lane and re-alerts the same parent outage. Suppress the child red → amber
  // ("waiting on box worker outage"). Once the worker recovers (workerUnavailable=false), the
  // existing freshness windows still page real stale-loop failures.
  const suppressForBoxOutage = workerUnavailable && isBoxEmittedCronLoop(loop);
  const boxOutageAmber = (statusTextForWaiting: string): Omit<LoopStatus, "history" | "openAlert" | "owner"> => ({
    ...base,
    color: "amber",
    statusText: statusTextForWaiting,
    violation: null,
  });
  // No beat yet: distinguish NEVER-FIRED-PAST-GRACE (red) from AWAITING-FIRST-TICK (amber).
  // A registered cron whose deploy has been live longer than its cadence+grace (livenessWindowMs)
  // but has 0 heartbeats is NOT awaiting its first tick — Inngest isn't invoking it (the exact
  // control-tower-monitor "awaiting first run for days" gap). Red + page. Only flips red with a
  // trustworthy deploy-age reference (prod + box caught up); otherwise a genuinely-fresh cron
  // (or unknown deploy age) stays amber so a just-shipped cron never false-alarms.
  //
  // NEVER-FIRED = 0 beats in ALL of history, NOT 0-since-deploy (control-tower-monitor-accuracy
  // P1). A cron with ANY historical beat is being invoked by Inngest — a longer-than-window real
  // cadence (daily today-sync, bursty meta-capi-dispatch) is at most a freshness alert below, never
  // never_fired. everBeatCount is the loop's beat count from the lateral-join read (capped at the
  // history limit, so it's a presence flag, not a true total): >0 ⇔ the loop appeared in the
  // distinct-loop_id set ⇔ it has beaten at least once. `latest` is already non-null whenever
  // everBeatCount>0, but we gate the red on the count EXPLICITLY so the old deploy-boundary false
  // positive can't silently return if the read changes.
  if (!latest) {
    // The beats read failed (RPC error/timeout) → everBeatCount=0 and latest=null are artifacts of
    // an UNKNOWN read, not a true zero. Stay amber; never false-fire never_fired off a failed read.
    if (beatsReadFailed) {
      return { ...base, color: "amber", statusText: "beat read unavailable — status unknown", violation: null };
    }
    const window = loop.livenessWindowMs ?? 26 * 60 * 60_000;
    // NEWLY-ADDED-CRON GRACE (control-tower-registered-not-firing-newcron-grace, refined by
    // control-tower-cron-grace-uses-next-firing-after-registration, refined again by
    // control-tower-registered-not-firing-observed-anchor-grace, and again by
    // received-sms-rollup-cron-heartbeat Phase 3 Fix 2 to gate the never_fired path too):
    // computed BEFORE the never_fired / registered_not_firing reds so a loop still inside its
    // first-firing window can't be false-paged by EITHER deploy-anchored `deployAgeMs` or the
    // watchdog-uptime `monitorUptimeMs` backstop. Without this ordering, a freshly-registered
    // loop whose box worker has been up for > window (deployAgeMs > window) trips `never_fired`
    // even when the loop entry itself is only minutes old — the exact received-sms-rollup-cron
    // Fix-1 regression whose alert flipped reason='registered_not_firing' → 'never_fired' the
    // moment Phase 2's registeredAt landed. Post-Fix-2 the same grace clock (max of computed
    // first-firing and the empirical first_observed_at) governs both reds — the intent of the
    // per-loop reference has always been "how long has this loop been registered", and that
    // applies to BOTH the deploy-anchored AND the watchdog-anchored gates.
    //
    // `registeredAt` (a code constant, deploy-SURVIVING unlike deployAgeMs) is the WRONG grace
    // clock on its own when it falls before the cron's hour-of-day: security-dep-watch
    // (`0 4 * * *`) registered at 00:00 UTC has 4h before its first valid tick, so a 26h window
    // measured from 00:00 trips at 02:00 the next day, 2h before it has actually had a chance
    // to fire. We use the first scheduled firing AT-OR-AFTER `registeredAt` (parsed from
    // expectedCadence) — preserves the red for genuinely-dead schedules but removes the
    // boundary false-page. And we additionally take the MAX with the empirical `first_observed_at`
    // (from monitored_loops_first_seen) so a hand-edited registeredAt SET BEFORE the cron
    // actually shipped (fleet-spend-governor: registeredAt 00:00 with cadence `10,40 * * * *`
    // → computed first-firing 00:10 SAME day → grace evaporates the moment the deploy lands
    // hours later) can never shorten the grace below "we have empirically seen this loop
    // registered for at least one full window." Unset (legacy crons) ⇒ no extra gate → the
    // reds below still apply.
    const firstFiringMs = firstScheduledFiringMs(loop, firstObservedMs);
    const sinceFirstFiringMs = firstFiringMs != null ? Date.now() - firstFiringMs : null;
    if (everBeatCount === 0 && sinceFirstFiringMs != null && sinceFirstFiringMs <= window) {
      const statusText = sinceFirstFiringMs >= 0
        ? `awaiting first run — first scheduled firing ${fmtDur(sinceFirstFiringMs)} ago (within ${fmtDur(window)} cadence+grace)`
        : `awaiting first run — first scheduled firing in ${fmtDur(-sinceFirstFiringMs)}`;
      return { ...base, color: "amber", statusText, violation: null };
    }
    if (everBeatCount === 0 && deployAgeMs != null && deployAgeMs > window) {
      if (suppressForBoxOutage) {
        return boxOutageAmber(`waiting on box worker outage — no beat yet (${fmtDur(deployAgeMs)} since box came up on this SHA)`);
      }
      return {
        ...base,
        color: "red",
        statusText: `registered but has never run (deploy ${fmtDur(deployAgeMs)} old)`,
        violation: {
          reason: "never_fired",
          detail: `Cron ${loop.id} is registered in code but has never emitted a heartbeat — ${fmtDur(deployAgeMs)} after deploy, past its ${fmtDur(window)} cadence+grace (expected ${loop.expectedCadence}). Inngest is not invoking it — a deploy may not have re-synced the app.`,
        },
      };
    }
    // REGISTERED-BUT-NOT-FIRING (spec-drift-reconcile-not-firing P1) — the deploy-independent
    // backstop the deploy-anchored never_fired above misses. The box self-updates to origin/main and
    // restarts on every ship, so deployRefAgeMs (deployAgeMs) keeps RESETTING under a long-dead cron:
    // with frequent deploys its current-deploy clock rarely exceeds the window, so a cron registered
    // for weeks that has NEVER fired once (the real spec-drift-reconcile failure) slips past never_fired
    // forever. The watchdog's own continuous run-span is a deploy-SURVIVING lower bound on how long this
    // registered cron has had to fire: if control-tower-monitor has itself been beating for longer than
    // this cron's full window and the cron still has 0 beats EVER, Inngest is not invoking it — distinct
    // from never-registered (the self-audit's Inngest-registration diff): this fn IS in the registered
    // set, the schedule just isn't active. monitorUptimeMs alone is NOT enough to say a cron has had a
    // window to fire, though: it's the watchdog's run-span, independent of when a given cron was ADDED,
    // so a cron shipped after the watchdog passed its window would false-trip on day one (the
    // control-tower-registered-not-firing-newcron-grace signal). The newcron grace above gates this
    // check too so a registered cron that still produces nothing a full window past BOTH a
    // provably-alive watchdog AND its own registration IS the problem we want to page.
    // (monitorUptimeMs is conservative — beat retention can only shorten it, never inflate it — so it
    // never over-fires; null = unknown ⇒ stay amber.)
    if (everBeatCount === 0 && monitorUptimeMs != null && monitorUptimeMs > window) {
      if (suppressForBoxOutage) {
        return boxOutageAmber(`waiting on box worker outage — no beat yet (watchdog uptime ${fmtDur(monitorUptimeMs)})`);
      }
      return {
        ...base,
        color: "red",
        statusText: `registered but not firing — 0 beats in ${fmtDur(monitorUptimeMs)} of watchdog uptime`,
        violation: {
          reason: "registered_not_firing",
          detail: `Cron ${loop.id} is registered with Inngest but has NEVER emitted a heartbeat — the Control Tower watchdog has been continuously running for ${fmtDur(monitorUptimeMs)}, well past this cron's ${fmtDur(window)} cadence+grace (expected ${loop.expectedCadence}), yet 0 beats. Inngest is not invoking it (its cron schedule isn't active in the prod env) — distinct from never-registered: the function IS in the registered set. Re-sync the app (PUT /api/inngest / dashboard "sync new app version") to activate the schedule.`,
        },
      };
    }
    return { ...base, color: "amber", statusText: "no heartbeat yet — awaiting first run", violation: null };
  }
  const stale = ageMs(latest.ran_at) > (loop.livenessWindowMs ?? 26 * 60 * 60_000);
  if (stale && !beatsReadFailed) {
    // (Defensive: a failed read returns no latest, so this path won't normally run with
    // beatsReadFailed — but a partial/stale read must not page cron_freshness either.)
    if (suppressForBoxOutage) {
      // Originating incident: DB Health slow-query tile went red during a box worker outage while
      // the box `liveness` tile already identified the parent failure. The DB Health pass recovered
      // immediately once the worker restarted — a cascade, not a freshness defect.
      return boxOutageAmber(`waiting on box worker outage — last beat ${elapsed(latest.ran_at)} ago`);
    }
    return { ...base, color: "red", statusText: `hasn't run in ${elapsed(latest.ran_at)} (expected ${loop.expectedCadence})`, violation: { reason: "cron_freshness", detail: `Cron ${loop.id} hasn't run in ${elapsed(latest.ran_at)} (expected ${loop.expectedCadence}; last beat ${latest.ran_at}).` } };
  }
  if (!latest.ok) {
    // P1 surfaces a not-ok beat as amber; the output-assertion (false-success)
    // layer that pages on it is Phase 2.
    return { ...base, color: "amber", statusText: `last run reported not-ok (${elapsed(latest.ran_at)} ago)`, violation: null };
  }
  return { ...base, color: "green", statusText: `ran ${elapsed(latest.ran_at)} ago`, violation: null };
}

/**
 * True iff the box build worker itself is currently non-live per the SAME inputs `evalWorker` uses
 * to open a `liveness` red: no heartbeat row, no `last_poll_at`, stale beyond `livenessWindowMs`,
 * or crash-looping (`status='needs_attention'`). Kept as a pure predicate so `evalAgentKind` and
 * the worker tile share ONE definition of "worker unavailable" — a lane can never disagree with
 * the box tile about whether the worker is actually up. (control-tower-suppress-agent-stuck-during-worker-outage)
 */
export function isWorkerUnavailable(row: WorkerRow | null, livenessWindowMs: number = 5 * 60_000): boolean {
  if (!row || !row.last_poll_at) return true;
  if (ageMs(row.last_poll_at) > livenessWindowMs) return true;
  if (row.status === "needs_attention") return true;
  return false;
}

export function evalAgentKind(loop: MonitoredLoop, latest: LoopHistoryRow | null, activeJobs: ActiveJob[], workerStartedAt: string | null = null, workerUnavailable = false): Omit<LoopStatus, "history" | "openAlert" | "owner"> {
  // control-tower-suppress-agent-stuck-during-worker-outage Phase 1 — when the box build worker
  // itself is stale/absent/crash-looping, its `liveness` red is the useful alert and every
  // queued/queued_resume row is waiting on the SAME parent (the worker can't claim while it's
  // down). Opening a stuck_jobs red on each healthy agent lane (pr-resolve, spec-test, …) just
  // duplicates the box-tile page and pins the wrong lane. Building/claimed jobs are NOT
  // suppressed — a genuinely-wedged in-flight job is still a lane-specific failure and stays
  // red. Once the worker recovers (isWorkerUnavailable=false) every stuck threshold behaves as
  // before; the worker-restart clamp (workerStartedAt → jobStuckSince) then grants the fresh
  // uptime a fair drain window before any queued row can trip red.
  const relevantForStuck = workerUnavailable
    ? activeJobs.filter((j) => j.kind === loop.agentKind && j.status !== "queued" && j.status !== "queued_resume")
    : activeJobs.filter((j) => j.kind === loop.agentKind);
  const mine = activeJobs.filter((j) => j.kind === loop.agentKind);
  const threshold = loop.stuckThresholdMs ?? 60 * 60_000;
  const stuck = relevantForStuck.filter((j) => ageMs(jobStuckSince(j, workerStartedAt)) > threshold);
  const base = {
    id: loop.id,
    kind: loop.kind,
    label: loop.label,
    description: loop.description,
    expectedCadence: loop.expectedCadence,
    lastRanAt: latest?.ran_at ?? null,
    lastProduced: latest?.produced ?? null,
    detail: latest?.detail ?? null,
  };
  if (stuck.length) {
    const oldest = stuck.reduce((a, b) => (ageMs(jobStuckSince(a, workerStartedAt)) > ageMs(jobStuckSince(b, workerStartedAt)) ? a : b));
    return {
      ...base,
      color: "red",
      statusText: `${stuck.length} job${stuck.length === 1 ? "" : "s"} stuck (oldest ${elapsed(jobStuckSince(oldest, workerStartedAt))})`,
      violation: { reason: "stuck_jobs", detail: `${stuck.length} ${loop.agentKind} job(s) stuck in ${stuck[0].status} past ${Math.round(threshold / 60_000)}m (oldest ${elapsed(jobStuckSince(oldest, workerStartedAt))}, job ${oldest.id.slice(0, 8)}).` },
    };
  }
  // claim-rpc-kill-switch-enforcement Phase 2 — the box worker calls
  // public.claim_agent_job_diag whenever a `claim_agent_job` returns null and
  // writes an agent-kind heartbeat whose `produced` carries
  // `{blocked_off:true, offBy, scope}` naming the first ancestor node_id whose
  // kill switch fired (see writeSuppressedClaimHeartbeats in
  // scripts/builder-worker.ts). Render that as amber "off by <ancestor>
  // (<scope>)" so a switched-off tile is not confused with a green silent-idle
  // (or a false red). The latest beat is authoritative: once the switch is
  // removed and the next claim succeeds, the launch-path's completion beat
  // overwrites this one and the tile returns to green.
  const producedObj = (latest?.produced && typeof latest.produced === "object")
    ? (latest.produced as { blocked_off?: unknown; offBy?: unknown; scope?: unknown })
    : null;
  if (producedObj && producedObj.blocked_off === true) {
    const offBy = typeof producedObj.offBy === "string" ? producedObj.offBy : "unknown";
    const scope = typeof producedObj.scope === "string" ? producedObj.scope : "unknown";
    return { ...base, color: "amber", statusText: `off by ${offBy} (${scope})`, violation: null };
  }
  // Genuinely-idle or running-within-threshold = green (no false positives).
  if (mine.length) {
    return { ...base, color: "green", statusText: `running · ${mine.length} active`, violation: null };
  }
  return { ...base, color: "green", statusText: latest ? `idle · last ran ${elapsed(latest.ran_at)} ago` : "idle · never run", violation: null };
}

// ── Inline event-driven AI agents (control-tower-agent-coverage spec, Phase 1) ──
// A server-side AI agent that runs per-ticket / per-order / per-journey has no cron
// cadence and no agent_jobs queue, so neither evalCron nor evalAgentKind fits: silence
// is only a violation when work that should have triggered it exists. Two checks:
//   - LIVENESS-WHEN-WORK-EXISTS — upstream work waited in the window but the agent had
//     0 SUCCESSFUL beats (the exact silent-death the dashboard couldn't show before).
//   - ERROR-RATE — errored beats over the window past the loop's threshold (the agent is
//     running but producing nothing useful — e.g. erroring on every ticket).
// A genuinely-idle agent (no work waiting, no runs) is GREEN — no false positives.

// control-tower-fraud-detector-workprobe-exclude-internal-renewals (signal
// loop:ai:fraud-detector, verdict monitor-false-positive): source_name values
// written by the internal subscription-renewal loop (see
// src/lib/inngest/internal-subscription-renewals.ts — the regular renewal path
// stamps `internal_subscription_renewal`, the $0 comp path stamps
// `internal_subscription_comp_renewal`). Those orders are created by the billing
// renewal cron and NEVER emit `fraud/order.check`, so `checkOrderForFraud` never
// runs for them by design. Counting them as fraud-detector work makes a quiet
// renewal-only window read as "work=1 / 0 beats" and false-fires `idle_while_work`
// on the `ai:fraud-detector` tile. Real Shopify webhooks pass their upstream
// `source_name` through and DO fire the fraud gate (shopify-webhooks.ts:776);
// internal storefront checkouts stamp `source_name="storefront"` and call
// `checkOrderForFraud` directly (src/app/api/checkout/route.ts:946) — both stay
// in the probe's work count. Standing pattern for this class of monitor
// false-positive: mirror the source filter at the probe, not a JS post-filter.
export const INTERNAL_RENEWAL_ORDER_SOURCE_NAMES = [
  "internal_subscription_renewal",
  "internal_subscription_comp_renewal",
] as const;

/**
 * True iff an `orders` row is upstream work the fraud detector is expected to
 * screen. Internal renewal orders are the ONE class we exclude — every other
 * shape (Shopify webhook, storefront, unknown/null `source_name`) DOES route
 * through `checkOrderForFraud` and stays in the work count. Kept as a pure
 * predicate so the DB-side probe filter and the unit test share one definition.
 */
export function isOrderAwaitingFraudScreen(order: { source_name?: string | null }): boolean {
  const src = order.source_name ?? null;
  if (src === null) return true;
  return !(INTERNAL_RENEWAL_ORDER_SOURCE_NAMES as readonly string[]).includes(src);
}

/**
 * Extract the set of ticket_ids from a batch of `agent_jobs.kind='ticket-handle'` rows whose
 * `instructions` payload identifies a Sol first-touch dispatch (`reason: 'first_touch'`).
 *
 * `agent_jobs` has no ticket_id column (see [[../../lib/portal/enqueue-sol-first-touch]] and
 * unified-ticket-handler.ts:2030-2041) — every kind stores its per-job params inside a
 * `JSON.stringify(...)`'d `instructions` text column. The `tickets-awaiting-decision` monitor
 * probe uses this helper to turn a window of first-touch dispatch rows into the ticket-id set it
 * subtracts from the inbound-message count, so Sol-first-touch async channels (email/SMS/portal —
 * every non-chat channel skips the `sol_first_touch_ack` ledger row by design) aren't counted as
 * orchestrator-owned work with 0 beats. Extracted from the probe body so it can be unit-tested
 * without mocking Supabase — same pattern as `isOrderAwaitingFraudScreen`.
 *
 * Robustness:
 *  - Non-JSON / malformed `instructions` rows are silently skipped (pre-Sol jobs, or a future
 *    kind whose payload isn't JSON) — the probe's null/error-safe defaults do not change.
 *  - Rows with a `reason` other than 'first_touch' are skipped (inflection, portal_error, etc.
 *    each keep their own accounting).
 *  - Returned ids are deduped so a re-enqueue on the same ticket doesn't inflate the exclusion.
 */
export function extractSolFirstTouchDispatchTicketIds(
  rows: Array<{ instructions: string | null }>,
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const raw = row.instructions;
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const payload = parsed as { ticket_id?: unknown; reason?: unknown };
    if (payload.reason !== "first_touch") continue;
    if (typeof payload.ticket_id !== "string" || payload.ticket_id.length === 0) continue;
    ids.add(payload.ticket_id);
  }
  return [...ids];
}

/** Per-inline-agent window state: upstream work + ok/errored beat counts + latest/history. */
export interface InlineAgentState {
  /** independent upstream-demand count over the window (the inlineWorkSignal probe). */
  work: number;
  /** successful beats in the window. */
  okCount: number;
  /** errored beats in the window. */
  errCount: number;
  /** most-recent beat ever (regardless of window) — drives last-ran / last-produced. */
  latest: LoopHistoryRow | null;
  /** last ~10 beats for the dashboard history strip. */
  history: LoopHistoryRow[];
}

export function evalInlineAgent(loop: MonitoredLoop, state: InlineAgentState | undefined): Omit<LoopStatus, "history" | "openAlert" | "owner"> {
  const s = state ?? { work: 0, okCount: 0, errCount: 0, latest: null, history: [] };
  const base = {
    id: loop.id,
    kind: loop.kind,
    label: loop.label,
    description: loop.description,
    expectedCadence: loop.expectedCadence,
    lastRanAt: s.latest?.ran_at ?? null,
    lastProduced: s.latest?.produced ?? null,
    detail: s.latest?.detail ?? null,
  };
  const total = s.okCount + s.errCount;
  const windowMin = Math.round((loop.livenessWindowMs ?? 6 * 60 * 60_000) / 60_000);

  // 0. Never-run grace (first-run / deploy boundary) — an inline agent with ZERO heartbeats *ever*
  // is awaiting its first invocation, not silently failing. These agents beat on EVERY run (incl.
  // failures, via finally), so zero-ever-beats = the agent was never even invoked → the in-window
  // "work" was handled by a pre-heartbeat code path (the deploy boundary) or isn't really the
  // agent's backlog (e.g. a `pending` journey_session = awaiting the customer, not the delivery
  // agent — the agent already created it). Amber, never red. Mirrors the cron first-run grace.
  // (An agent that HAS run before but went silent in-window still alerts below: history non-empty.)
  if (s.history.length === 0) {
    return {
      ...base,
      color: s.work > 0 ? "amber" : "green",
      statusText: s.work > 0 ? `awaiting first run — ${s.work} in window, none handled yet` : "idle · no runs yet",
      violation: null,
    };
  }

  // 1. Liveness-when-work-exists — work waited but 0 successful runs in the window.
  if (s.work > 0 && s.okCount === 0) {
    return {
      ...base,
      color: "red",
      statusText: `silent while ${s.work} await${s.work === 1 ? "s" : ""} (0 ok runs in ${windowMin}m)`,
      violation: {
        reason: "idle_while_work",
        detail: `${loop.label} silent while ${s.work} item${s.work === 1 ? "" : "s"} awaited it — 0 successful runs in the last ${windowMin}m${s.errCount ? ` (${s.errCount} errored)` : ""}.`,
      },
    };
  }

  // 2. Error-rate — enough runs + errored fraction over the threshold.
  const threshold = loop.errorRateThreshold ?? 0.5;
  const minRuns = loop.minRunsForErrorRate ?? 5;
  if (total >= minRuns && s.errCount / total >= threshold) {
    const pct = Math.round((s.errCount / total) * 100);
    return {
      ...base,
      color: "red",
      statusText: `failing: ${s.errCount}/${total} runs errored (${pct}%)`,
      violation: {
        reason: "error_rate",
        detail: `${loop.label} failing: ${s.errCount} of ${total} runs errored (${pct}%) in the last ${windowMin}m — running but producing nothing useful.`,
      },
    };
  }

  // Healthy / genuinely-idle = green (no false positives).
  if (total === 0) {
    return { ...base, color: "green", statusText: s.latest ? `idle · last ran ${elapsed(s.latest.ran_at)} ago` : "idle · never run", violation: null };
  }
  return { ...base, color: "green", statusText: `healthy · ${s.okCount} ok${s.errCount ? `, ${s.errCount} errored` : ""} in window`, violation: null };
}

/** READ-ONLY: per-inline-agent window state — exact ok/err beat counts + the upstream work probe. */
async function fetchInlineAgentState(admin: Admin): Promise<Map<string, InlineAgentState>> {
  // Reactive event-driven Inngest agents share the inline-agent evaluation model
  // (idle = green, liveness-when-work-exists + error-rate), so they're fetched here too.
  const inline = MONITORED_LOOPS.filter((l) => l.kind === "inline-agent" || l.kind === "reactive");
  const out = new Map<string, InlineAgentState>();

  await Promise.all(
    inline.map(async (loop) => {
      const windowMs = loop.livenessWindowMs ?? 6 * 60 * 60_000;
      const sinceIso = new Date(Date.now() - windowMs).toISOString();

      // Work probe — independent upstream-demand count over the loop's window.
      const workPromise: Promise<number> = (async () => {
        switch (loop.inlineWorkSignal) {
          case "tickets-awaiting-qc": {
            // Closed AI-handled tickets never analyzed (last_analyzed_at null), updated in-window —
            // exactly what the ticket-analysis cron feeds analyzeTicket. The cron stamps
            // last_analyzed_at even on skip, so a null here is a genuinely-unprocessed ticket.
            // Human-veto mirror (ticket-analyzer-workprobe-exclude-analyzer-locked): analyzer_locked
            // is EXCLUDED at the source, mirroring ticket-analysis-cron.ts:48-54 — a human has
            // vetoed the analyzer on those rows (Phase 2 of human-directives-hard-gates-over-ticket-ai),
            // so the cron will never process them by design. Counting them here manufactures a false
            // idle_while_work on loop:ai:ticket-analyzer during otherwise-quiet windows. The probe and
            // the cron have to see the same universe of work (standing pattern — siblings:
            // ticket-decision-workprobe-exclude-positive-close, ticket-decision-workprobe-exclude-active-playbook).
            //
            // Cron-selection mirror (journey-completion-stamps-closed-at-so-cora-can-grade Fix 1) —
            // the cron's `find-tickets` gate ALSO requires `closed_at IS NOT NULL AND
            // sol_handled_at IS NOT NULL` (ticket-analysis-cron.ts:154-155). A closed AI ticket
            // whose close writer forgot to stamp `closed_at` (the origin bug this spec repairs —
            // journey completion routes shipped status='closed'+resolved_at but no closed_at) is
            // permanently invisible to the cron, so counting it as awaited work manufactures a
            // false idle_while_work on loop:ai:ticket-analyzer even after Phase 1 closes the
            // source. Same for `sol_handled_at`-null tickets (never touched by Sol → cron skips).
            // Adding the two `.not(*, "is", null)` filters aligns the probe with the cron's real
            // selection universe (learning #1: change the durable predicate).
            //
            // Cora settle-window mirror (ticket-analyzer-workprobe-last-customer-settle-grace) —
            // the cron's real eligibility gate (ticket-analysis-cron.ts `passesCoraSelectionGate`)
            // is keyed on the LATEST CUSTOMER MESSAGE, not on `updated_at`: it requires that a
            // customer message exists AND its `created_at` is at least CORA_CLOSE_SETTLE_MS (30 min)
            // in the past. Keying the probe on `updated_at <= now - FEEDER_GRACE` alone lets a
            // ticket the cron is DELIBERATELY waiting on (customer last spoke 5 min ago, ticket
            // updated 45 min ago by an internal side-effect) count as awaited work — the exact
            // false idle_while_work the first pass of this spec repairs. We derive the latest
            // customer message per candidate and combine it with CORA_CLOSE_SETTLE_MS + the
            // existing TICKET_ANALYSIS_FEEDER_GRACE_MS below.
            //
            // Fresh-close eligibility grace (ticket-analyzer-workprobe-eligibility-grace) —
            // customer-message settle alone still lets a NEWLY CLOSED ticket look overdue: if a
            // customer last spoke hours ago and Sol closed the ticket 5 min ago, the cron will
            // legitimately service it on the NEXT 30-min tick (~25 min from now), yet the
            // customer-message-only cutoff already treats it as awaited work — a false
            // idle_while_work in the between-tick gap the fresh close landed in. We now compute
            // `ticketAnalyzerEligibilityReadyAt` = MAX(handled_at, closed_at, last_customer_msg +
            // CORA_SETTLE) — the moment ALL of the cron's real gates first hold — and only count
            // the candidate once (now - readyAt) >= TICKET_ANALYSIS_FEEDER_GRACE_MS. That gives
            // a freshly-closed / freshly-handled ticket one full feeder cycle to be picked up
            // before we flag it, while a truly-stuck analyzer (a fully-settled ticket that's
            // survived a full cycle unprocessed) still trips the alert.
            const nowMs = Date.now();
            const { data: candidates } = await admin
              .from("tickets")
              .select("id, closed_at, ai_handled_at, sol_handled_at")
              .eq("status", "closed")
              .eq("analyzer_locked", false)
              .contains("tags", ["ai"])
              .not("closed_at", "is", null)
              .not("sol_handled_at", "is", null)
              .is("last_analyzed_at", null)
              .gte("updated_at", sinceIso);
            type Candidate = {
              id: string;
              closed_at: string | null;
              ai_handled_at: string | null;
              sol_handled_at: string | null;
            };
            const candidateRows = (candidates ?? []) as Candidate[];
            if (!candidateRows.length) return 0;
            const candidateIds = candidateRows.map((c) => c.id);
            // Latest customer message per candidate — mirrors the cron's per-run reduction
            // (ticket-analysis-cron.ts:203-211) so the probe and the cron see the same universe
            // of work. Volume is small (candidate cap is the base filter's natural bound).
            const { data: custMsgRows } = await admin
              .from("ticket_messages")
              .select("ticket_id, created_at")
              .in("ticket_id", candidateIds)
              .eq("author_type", "customer");
            const latestCustomerMsgMs = new Map<string, number>();
            for (const m of ((custMsgRows ?? []) as Array<{ ticket_id: string; created_at: string }>)) {
              const ms = Date.parse(m.created_at);
              if (!Number.isFinite(ms)) continue;
              const prev = latestCustomerMsgMs.get(m.ticket_id);
              if (prev == null || ms > prev) latestCustomerMsgMs.set(m.ticket_id, ms);
            }
            let count = 0;
            for (const c of candidateRows) {
              const latestMs = latestCustomerMsgMs.get(c.id);
              // No customer message → outbound-only → not gradeable (mirrors the cron's
              // `if (!last_customer_message_at) return false` in passesCoraSelectionGate).
              if (latestMs == null) continue;
              const readyAt = ticketAnalyzerEligibilityReadyAt({
                closedAtMs: c.closed_at ? Date.parse(c.closed_at) : null,
                aiHandledAtMs: c.ai_handled_at ? Date.parse(c.ai_handled_at) : null,
                solHandledAtMs: c.sol_handled_at ? Date.parse(c.sol_handled_at) : null,
                latestCustomerMessageAtMs: latestMs,
                coraSettleMs: TICKET_ANALYSIS_CORA_SETTLE_MS,
              });
              // No cron-eligibility yet (missing an anchor) → cron would skip → don't count.
              if (readyAt == null) continue;
              // Not old enough for a full feeder cycle to have legally picked it up → cron
              // would service on the next tick → don't count as awaited work.
              if (nowMs - readyAt < TICKET_ANALYSIS_FEEDER_GRACE_MS) continue;
              count++;
            }
            return count;
          }
          case "journeys-awaiting-delivery": {
            const { count } = await admin
              .from("journey_sessions")
              .select("id", { count: "exact", head: true })
              .gte("created_at", sinceIso);
            return count ?? 0;
          }
          case "orders-awaiting-fraud-screen": {
            // Feeder-surface mirror (control-tower-fraud-detector-workprobe-exclude-internal-renewals,
            // signal loop:ai:fraud-detector). Real fraud-detector work = orders whose creation path
            // fires `fraud/order.check` → `checkOrderForFraud`. Shopify webhooks
            // (src/lib/shopify-webhooks.ts:776) and the storefront checkout route
            // (src/app/api/checkout/route.ts:946) both do so; the internal subscription-renewal cron
            // (src/lib/inngest/internal-subscription-renewals.ts) does NOT. So exclude the two
            // internal-renewal source_name markers here — the same predicate that
            // isOrderAwaitingFraudScreen enforces in JS. NULL source_name stays in the count
            // (defensive: unknown-source orders are treated as real; matches the pre-fix behavior).
            const excluded = INTERNAL_RENEWAL_ORDER_SOURCE_NAMES.map((n) => `"${n}"`).join(",");
            const { count } = await admin
              .from("orders")
              .select("id", { count: "exact", head: true })
              .gte("created_at", sinceIso)
              .or(`source_name.is.null,source_name.not.in.(${excluded})`);
            return count ?? 0;
          }
          case "tickets-awaiting-decision": {
            // Inbound customer messages in-window — every one fires unified-ticket-handler →
            // callSonnetOrchestratorV2. Inbound traffic with 0 successful decision beats means
            // the per-ticket decision agent went silent (couldn't reply or act on anyone).
            //
            // Four legitimate-bypass classes are subtracted because each one is an inbound
            // customer message that, by design, will NOT produce an ai:orchestrator beat:
            //
            // (1) CSAT-reopen path (control-tower-ticket-decision-workprobe-scope): not every
            //     inbound/customer insert fires ticket/inbound-message. The CSAT-reopen route
            //     (src/app/api/csat/[ticketId]/route.ts) inserts an inbound customer message,
            //     reopens the ticket, and routes it to a human — emitting NO
            //     ticket/inbound-message event — so the handler legitimately never beats on it.
            //     A single reopen note in an otherwise-quiet window would otherwise read as
            //     work=1 with 0 beats and false-fire idle_while_work.
            //
            // (2) Closed-ticket short-circuit (ticket-decision-workprobe-exclude-positive-close):
            //     the handler DOES fire ticket/inbound-message for these, but several
            //     pre-orchestrator gates resolve and CLOSE the ticket BEFORE reaching
            //     callSonnetOrchestratorV2 — the positive-close path
            //     (unified-ticket-handler.ts:1635 → status 'positive_close'), the fraud gate,
            //     and the chargeback gate (~1654). Those messages never drive an ai:orchestrator
            //     beat, so a lone 'Thank you' that triggers a positive-close in an otherwise-
            //     quiet window would over-count demand the same way.
            //
            // (3) Active-playbook continuation (ticket-decision-workprobe-exclude-active-playbook):
            //     a customer mid-playbook (refund/cancel/return flow) routes through
            //     executePlaybookStep and never reaches callSonnetOrchestratorV2, so the
            //     orchestrator legitimately emits no beat on those messages. Two such playbook-
            //     continuation inbounds in a quiet 120m window are enough to flip the
            //     ai:orchestrator tile red. An active-playbook ticket has a designated handler
            //     that already owns the message.
            //
            // (4) Sol first-touch dispatch (ticket-decision-workprobe-exclude-sol-first-touch,
            //     see sol-ticket-direction-artifact-and-first-touch-box-session): a first-touch
            //     inbound on a channel with sol_first_touch_enabled=true is served by a Sol
            //     ticket-handle agent_job — unified-ticket-handler.ts:498-522 acks the customer
            //     (chat only) and enqueues kind='ticket-handle' where the box authors the
            //     Direction + first reply. callSonnetOrchestratorV2 never runs on that inbound
            //     so no ai:orchestrator beat is emitted. On Superfoods every channel has the
            //     flag on, so a single quiet-window Sol-first-touch inbound would flip the tile
            //     red on healthy traffic.
            //     Two parallel exclusions cover this class, because the two available signals
            //     each cover a subset of channels:
            //       (a) `ticket_resolution_events(reasoning='sol_first_touch_ack')` — the chat
            //           ack ledger row (see docs/brain/tables/ticket_resolution_events.md).
            //           unified-ticket-handler.ts only writes this ack row on chat; async
            //           channels (email/SMS/portal/etc.) skip the send AND the ledger row by
            //           design (Sol's real reply is the sole first-touch customer message),
            //           so this exclusion alone leaves async first-touch tickets counting as
            //           orchestrator work with 0 beats — the exact monitor-false-positive that
            //           red-tiled `ai:orchestrator` on a quiet-window inbound email. Kept as-is
            //           for chat.
            //       (b) `agent_jobs(kind='ticket-handle', instructions.reason='first_touch')`
            //           — the durable dispatch signal that unified-ticket-handler.ts writes for
            //           EVERY first-touch channel (chat + async), captured off the enqueue
            //           payload. Extends the exclusion to async channels using the same
            //           handler-side ownership decision (the ticket is a Sol first-touch
            //           dispatch, not orchestrator work) rather than a channel-scoped
            //           downstream ledger row. This is the channel-agnostic signal the spec
            //           `ticket-decision-workprobe-exclude-async-sol-first-touch` calls for.
            //     A message may match both (a) and (b) on chat; per the overlap-safe note
            //     below, double-subtraction only lowers the work count further, so the tile
            //     still cannot false-fire idle_while_work.
            //
            // A still-OPEN, no-playbook, no-Sol-first-touch ticket with no beat keeps counting,
            // so a genuine orchestrator outage (inbound traffic piling up on tickets nothing can
            // close or hand to a playbook / Sol) still alerts; a normally-served ticket that the
            // orchestrator closed has its own ok beat, so dropping it from the work count never
            // manufactures a false negative.
            //
            // (5) Outreach short-circuit (control-tower-ticket-decision-workprobe-settle-and-outreach-bypass):
            //     unified-ticket-handler.ts § 1a (`isAutomatedInbound` pre-filter, ~1048) and § 1c
            //     (`decideOutreachRoute` classifier close, ~1127) both stamp the ticket with the
            //     `cls:outreach` + `outreach` tags and close it BEFORE ever reaching the Sonnet
            //     orchestrator — outreach = cold sales pitch / brand collab / UGC / partnership,
            //     not a customer-service request. Those inbounds are handled by the deterministic
            //     outreach lane by design, so no ai:orchestrator beat is emitted on them.
            //     Without this exclusion a single Flippa-style outreach inbound in an otherwise-
            //     quiet window would read as work=1 with 0 beats and flip the tile red — a
            //     monitor-false-positive on a healthy system (the correct handler ran, the
            //     ticket closed, the human never should have paged).
            //
            // Settle window (control-tower-ticket-decision-workprobe-settle-and-outreach-bypass):
            //     Even with (5) in place, the pre-orchestrator race remains: the classifier bucket
            //     is stamped over ~seconds AFTER the inbound row is inserted (`step.run(...)`
            //     boundaries + async Inngest fanout), so a monitor tick sampling in that gap sees
            //     the raw inbound but not yet its `cls:outreach` tag / closed status / enqueued
            //     `ticket-handle` job. The upper `created_at` cutoff below (now minus
            //     TICKET_DECISION_SETTLE_MS) waits through that boundary before counting a fresh
            //     inbound as orchestrator demand — the same shape as HANDLER_DISPATCH_SETTLE_MS
            //     mirrors the backstop reconciler's INTENT_SETTLE_MS. A message older than the
            //     window with none of the bypass classes matching is genuine orchestrator work
            //     and still counts.
            //
            // The first three exclusions are expressed as a single positive-match on the
            // tickets row (closed OR csat:reopened OR active_playbook_id IS NOT NULL) —
            // NULL-safe (tickets with NULL/empty tags or NULL active_playbook_id still count)
            // and overlap-free (a csat:reopened ticket that later closes is counted once, not
            // double-subtracted). The outreach class (5) rides along in the same positive-match
            // via the `tags cs {cls:outreach}` / `tags cs {outreach}` clauses (either tag alone
            // is sufficient — both are always stamped together on outreach). The Sol-first-touch
            // class lives on sibling tables (ticket_resolution_events for the chat ack,
            // agent_jobs for the channel-agnostic dispatch signal), so it runs as two parallel
            // queries. Overlap between any of the exclusion sets (e.g. a Sol-first-touch chat
            // ticket that later closes, matching (2), (4a), and (4b)) can double-subtract, which
            // is safe: it only lowers the work count further, never inflates it, so the tile
            // still can't false-fire idle_while_work — and a genuinely orchestrator-owned ticket
            // sits in NONE of the sets, so no false negatives.
            const decisionSettleCutoffIso = new Date(Date.now() - TICKET_DECISION_SETTLE_MS).toISOString();
            const [allRes, excludedRes, solFirstTouchAckRes, solFirstTouchDispatchJobsRes] = await Promise.all([
              admin
                .from("ticket_messages")
                .select("id", { count: "exact", head: true })
                .eq("direction", "inbound")
                .eq("author_type", "customer")
                .gte("created_at", sinceIso)
                .lte("created_at", decisionSettleCutoffIso),
              admin
                .from("ticket_messages")
                .select("id, tickets!inner(id)", { count: "exact", head: true })
                .eq("direction", "inbound")
                .eq("author_type", "customer")
                .gte("created_at", sinceIso)
                .lte("created_at", decisionSettleCutoffIso)
                .or(
                  "status.eq.closed,tags.cs.{csat:reopened},tags.cs.{outreach},tags.cs.{cls:outreach},active_playbook_id.not.is.null",
                  { referencedTable: "tickets" },
                ),
              admin
                .from("ticket_messages")
                .select("id, tickets!inner(id, ticket_resolution_events!inner(id))", { count: "exact", head: true })
                .eq("direction", "inbound")
                .eq("author_type", "customer")
                .gte("created_at", sinceIso)
                .lte("created_at", decisionSettleCutoffIso)
                .eq("tickets.ticket_resolution_events.reasoning", "sol_first_touch_ack"),
              // agent_jobs has no ticket_id column (see enqueueSolFirstTouchForPortalError.ts) —
              // the ticket_id lives in the JSON-encoded `instructions` string. Prefilter on the
              // reason marker with a LIKE (underscore escaped so `first_touch` is literal, not a
              // single-char wildcard) then parse the ticket_ids in Node via the pure
              // extractSolFirstTouchDispatchTicketIds helper for unit-testability. The
              // decisionSettleCutoffIso window is applied when we subtract by ticket_id below,
              // NOT here — we want to catch a first-touch job whose enqueue landed inside the
              // settle boundary for an inbound that will soon leave the settle boundary.
              admin
                .from("agent_jobs")
                .select("instructions")
                .eq("kind", "ticket-handle")
                .gte("created_at", sinceIso)
                .like("instructions", '%"reason":"first\\_touch"%'),
            ]);
            const dispatchTicketIds = extractSolFirstTouchDispatchTicketIds(
              (solFirstTouchDispatchJobsRes.data ?? []) as Array<{ instructions: string | null }>,
            );
            let solFirstTouchDispatchExcluded = 0;
            if (dispatchTicketIds.length > 0) {
              const { count } = await admin
                .from("ticket_messages")
                .select("id", { count: "exact", head: true })
                .eq("direction", "inbound")
                .eq("author_type", "customer")
                .gte("created_at", sinceIso)
                .lte("created_at", decisionSettleCutoffIso)
                .in("ticket_id", dispatchTicketIds);
              solFirstTouchDispatchExcluded = count ?? 0;
            }
            return Math.max(
              0,
              (allRes.count ?? 0)
                - (excludedRes.count ?? 0)
                - (solFirstTouchAckRes.count ?? 0)
                - solFirstTouchDispatchExcluded,
            );
          }
          case "tickets-awaiting-handler-dispatch": {
            // The handler's OWN work signal (control-tower-unified-handler-dispatch-workprobe).
            //
            // Every ingest chokepoint routes through [[../inngest/dispatch-inbound-message]]
            // `dispatchInboundMessage`, which stamps `dispatch_pending_at = now` on the just-inserted
            // inbound `ticket_messages` row BEFORE firing `ticket/inbound-message`. The counterpart in
            // [[../inngest/unified-ticket-handler]] `clearDispatchIntent` clears the stamp at the TOP
            // of every claimed run (regardless of disposition — real turn, ai_disabled skip, empty
            // inbound, spam), so an un-cleared stamp survives ONLY when the handler never received
            // the event. Aging that stamp past `HANDLER_DISPATCH_SETTLE_MS` (mirrors INTENT_SETTLE_MS
            // in the unanswered-inbound-backstop cron) turns it into an unambiguous LOST handler
            // dispatch — the exact signal loop:unified-ticket-handler is supposed to alert on.
            //
            // Why the shift from `tickets-awaiting-decision` (which counts inbound customer messages
            // in-window and subtracts several bypass classes): that probe measures the AI orchestrator's
            // upstream demand, which is a strict superset of the handler's. A raw inbound row that
            // was NOT stamped (because its ingest path deliberately bypassed the handler — CSAT
            // reopen inserts, sentinel merges) still counted as "handler work" under the old probe
            // and could fire idle_while_work on a quiet-window inbound that never should have
            // invoked the handler at all. Keying the probe on `dispatch_pending_at` eliminates that
            // class at the source: no stamp ⇒ no work ⇒ no alert.
            //
            // Filter shape:
            //   - `dispatch_pending_at IS NOT NULL` — a real dispatch intent exists on this row.
            //   - `dispatch_pending_at <= now - HANDLER_DISPATCH_SETTLE_MS` — settled past the same
            //     boundary the backstop reconciler uses (`INTENT_SETTLE_MS`), so a fresh dispatch
            //     still inside the Inngest delivery window doesn't count as awaited work.
            //   - `direction = 'inbound'` AND `author_type = 'customer'` — defensive, since only
            //     inbound customer messages ever receive a stamp today, but pinning the filter
            //     matches the semantic of "the handler is supposed to service THIS class" so a
            //     future outbound-side use of the column can't accidentally leak into the count.
            const dispatchCutoff = new Date(Date.now() - HANDLER_DISPATCH_SETTLE_MS).toISOString();
            const { count } = await admin
              .from("ticket_messages")
              .select("id", { count: "exact", head: true })
              .eq("direction", "inbound")
              .eq("author_type", "customer")
              .not("dispatch_pending_at", "is", null)
              .lte("dispatch_pending_at", dispatchCutoff);
            return count ?? 0;
          }
          default:
            return 0;
        }
      })();

      const [work, okRes, errRes, recent] = await Promise.all([
        workPromise,
        admin.from("loop_heartbeats").select("id", { count: "exact", head: true }).eq("loop_id", loop.id).eq("ok", true).gte("ran_at", sinceIso),
        admin.from("loop_heartbeats").select("id", { count: "exact", head: true }).eq("loop_id", loop.id).eq("ok", false).gte("ran_at", sinceIso),
        admin.from("loop_heartbeats").select("ran_at, ok, produced, detail, duration_ms").eq("loop_id", loop.id).order("ran_at", { ascending: false }).limit(HISTORY_LIMIT),
      ]);

      const history = (recent.data ?? []) as LoopHistoryRow[];
      out.set(loop.id, {
        work,
        okCount: okRes.count ?? 0,
        errCount: errRes.count ?? 0,
        latest: history[0] ?? null,
        history,
      });
    }),
  );

  return out;
}

// ── Phase 2: output assertions (false-success + idle-while-work) ─────────────
// Phase 1 catches a loop that went SILENT (no/stale heartbeat). These catch the
// Goodhart failure it can't: the loop RAN (fresh beat, green on P1) but silently
// did nothing/the wrong thing. Each is a read-only state-check; on violation the
// tile flips red and the monitor opens an alert + pages, exactly like a P1 red.

/** Extra read-only state the output assertions need (one cheap query each). */
interface AssertionInputs {
  /** open, routine-owned escalated tickets waiting (escalated_at set, escalated_to null). */
  escalatedWaiting: number;
  /** the OLDEST waiting ticket's escalated_at (min over the waiting set) — how long real work has actually waited, or null. */
  oldestEscalatedAt: string | null;
  /** most-recent triage-escalations agent_jobs.created_at (any status), or null. */
  latestTriageJobAt: string | null;
  /** most-recent spec-test agent_jobs.created_at (any status), or null. */
  latestSpecTestJobAt: string | null;
  /**
   * Active internal subs whose next_billing_date is already in the past (overdue) AND that
   * aren't already owned by an active/rotating/retrying/paused/skipped dunning cycle. A sub
   * whose payment failed and is waiting in dunning is HEALTHY retention state, not a
   * renewal-cron miss (build-control-tower-renewal-integrity-exclude-active-dunning P1).
   */
  overdueInternalSubs: number;
  /** per-sub renewal outcome breakdown for the LIVE current cycle (since the latest renewal-cron beat). */
  renewalCurrent: RenewalOutcomeCounts;
  /** per-sub renewal outcome breakdown for the rolling baseline (prior cycles before the current one). */
  renewalBaseline: RenewalOutcomeCounts;
  /** dunning_cycles still 'retrying' more than the grace past next_retry_at (stuck). */
  stuckDunningCycles: number;
  /** SMS-subscribed customers (segment-coverage assertion): total in the book. */
  smsSubscribedTotal: number;
  /** SMS-subscribed customers with segments_refreshed_at within 26h (fresh cohort). */
  smsSubscribedFresh26h: number;
  /** SMS-subscribed customers with segments_refreshed_at older than 48h OR null (stale tail). */
  smsSubscribedStale48h: number;
}

// ── Outcome-distribution + stuck-dunning thresholds (control-tower-renewal-integrity-assertions, P1) ──
/** Need at least this many per-sub outcomes in the current cycle before judging its mix (avoids 1/1=100% noise on a tiny cycle). */
const RENEWAL_MIN_CYCLE_SAMPLE = 10;
/** Anomalous-rate this cycle that trips the alert regardless of baseline — a systemic break (bad creds declining everyone, mass no-PM). */
const RENEWAL_HARD_FLOOR_RATE = 0.5;
/** Below this absolute anomalous-rate a relative spike is ignored (don't alarm on tiny noise even if it's 3× a near-zero baseline). */
const RENEWAL_MIN_SPIKE_RATE = 0.15;
/** Relative spike: current anomalous-rate ≥ baseline × this. */
const RENEWAL_SPIKE_FACTOR = 2.5;
/** Absolute spike: current anomalous-rate ≥ baseline + this (percentage points). */
const RENEWAL_SPIKE_MARGIN = 0.15;
/** Need at least this much baseline history before a relative spike comparison is meaningful. */
const RENEWAL_MIN_BASELINE_SAMPLE = 50;
/** A dunning cycle still 'retrying' more than this long past next_retry_at is stuck (generous vs the daily internal renewal cadence + weekend paydays). */
const STUCK_DUNNING_GRACE_MS = 48 * 60 * 60_000;
/** How far back to read renewal outcome beats for the rolling baseline. */
const RENEWAL_BASELINE_WINDOW_MS = 30 * 24 * 60 * 60_000;

// ── segment-coverage thresholds (fix-segment-refresh-coverage P2) ──
/** Fresh-cohort ratio (segments_refreshed_at within 26h) below this trips the assertion. */
const SEGMENT_COVERAGE_MIN_RATIO = 0.95;
/** A subscribed customer whose segments_refreshed_at is older than this (or NULL) is a stale tail. */
const SEGMENT_COVERAGE_MAX_AGE_MS = 48 * 60 * 60_000;
/** Below this book size don't judge — a workspace with 0-99 subscribers can noise-fire. */
const SEGMENT_COVERAGE_MIN_SAMPLE = 100;
/** Run-in-progress grace: skip the fresh-cohort ratio check while the daily refresh-customer-segments cron is still fanning out (comfortably longer than the observed worst-case fanout). The stale48h check stays active. */
const SEGMENT_COVERAGE_RUN_GRACE_MS = 6 * 60 * 60_000;

/** Sum the anomalous ("bad") outcomes in a renewal breakdown. */
function badOutcomeCount(c: RenewalOutcomeCounts): number {
  return RENEWAL_BAD_OUTCOMES.reduce((sum, k) => sum + c[k as keyof RenewalOutcomeCounts], 0);
}

/**
 * Read the migration-drift check's missing-tables list out of its heartbeat `produced` jsonb.
 * Detection happens on the box (it reads the .sql files + live schema); the monitor only reads the
 * conveyed result. Defensive against any shape — an unparseable blob ⇒ [] (no false drift alert).
 */
function readMissingTables(produced: unknown): Array<{ table: string; migration: string }> {
  if (!produced || typeof produced !== "object" || Array.isArray(produced)) return [];
  const raw = (produced as Record<string, unknown>).missing;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ table: string; migration: string }> = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const t = (item as Record<string, unknown>).table;
      const mg = (item as Record<string, unknown>).migration;
      if (typeof t === "string" && t) out.push({ table: t, migration: typeof mg === "string" ? mg : "unknown" });
    }
  }
  return out;
}

/**
 * Read the migration-drift check's merged-but-unapplied list out of its heartbeat `produced` jsonb
 * (ci-guard-migrations-applied-not-just-merged spec Phase 1). Detection happens on the box (it
 * enumerates supabase/migrations/*.sql on main and reads supabase_migrations.schema_migrations);
 * the monitor only reads the conveyed result. Phase 2 additionally attaches `severity` +
 * `outcome` per item — the tile detail distinguishes 'applied'/'approval-needed'/'apply-failed'.
 * Defensive against any shape — an unparseable blob ⇒ [].
 */
function readMergedButUnapplied(produced: unknown): Array<{
  version: string;
  file: string;
  severity?: string;
  outcome?: string;
}> {
  if (!produced || typeof produced !== "object" || Array.isArray(produced)) return [];
  const raw = (produced as Record<string, unknown>).mergedButUnapplied;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ version: string; file: string; severity?: string; outcome?: string }> = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const v = (item as Record<string, unknown>).version;
      const f = (item as Record<string, unknown>).file;
      const sev = (item as Record<string, unknown>).severity;
      const oc = (item as Record<string, unknown>).outcome;
      if (typeof v === "string" && v) {
        out.push({
          version: v,
          file: typeof f === "string" ? f : "unknown",
          severity: typeof sev === "string" ? sev : undefined,
          outcome: typeof oc === "string" ? oc : undefined,
        });
      }
    }
  }
  return out;
}

/** Pull a numeric counter out of a loop_heartbeats.produced jsonb blob (0 if absent). */
function producedCount(produced: unknown, key: string): number {
  if (produced && typeof produced === "object" && !Array.isArray(produced)) {
    const v = (produced as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

/**
 * The Phase 2 expected-output check for a loop. Returns a red override (statusText
 * + violation) when the loop ran but failed its assertion, else null (assertion
 * holds — leave the Phase 1 tile as-is). Pure given (assertion id, loop, latest beat, inputs).
 */
function evalOutputAssertion(
  assertionId: OutputAssertionId,
  loop: MonitoredLoop,
  latest: LoopHistoryRow | null,
  inputs: AssertionInputs,
): { statusText: string; violation: { reason: string; detail: string } } | null {
  switch (assertionId) {
    case "escalation-idle": {
      // Idle-while-work: a ticket has actually been WAITING longer than the cadence and no triage
      // job has been created since it escalated. Key off the oldest waiting ticket's escalated_at
      // (real work age), NOT the last enqueued job's age — triage-escalations-cron only enqueues when
      // escalated work exists, so latestTriageJobAt legitimately goes stale across quiet stretches and
      // a just-now escalation hasn't waited long enough to flag (the next hourly tick will pick it up).
      if (inputs.escalatedWaiting <= 0 || inputs.oldestEscalatedAt == null) return null;
      // Grace ≥ the cron's hourly cadence so a ticket escalating between ticks isn't flagged before the next run.
      const windowMs = loop.livenessWindowMs ?? 2 * 60 * 60_000;
      const waitedMs = ageMs(inputs.oldestEscalatedAt);
      if (waitedMs <= windowMs) return null;
      // A triage job created AT/AFTER the ticket escalated means the work was picked up — not idle.
      const handledSinceEscalation =
        inputs.latestTriageJobAt != null &&
        new Date(inputs.latestTriageJobAt).getTime() >= new Date(inputs.oldestEscalatedAt).getTime();
      if (handledSinceEscalation) return null;
      const n = inputs.escalatedWaiting;
      return {
        statusText: `idle while ${n} ticket${n === 1 ? "" : "s"} wait${n === 1 ? "s" : ""} (oldest ${elapsed(inputs.oldestEscalatedAt)})`,
        violation: {
          reason: "idle_while_work",
          detail: `Escalation triage idle while ${n} routine-escalated ticket${n === 1 ? "" : "s"} wait — oldest has waited ${elapsed(inputs.oldestEscalatedAt)} (past the ${Math.round(windowMs / 60_000)}m grace) with no triage-escalations job enqueued since it escalated (last enqueue ${elapsed(inputs.latestTriageJobAt)} ago).`,
        },
      };
    }
    case "spec-test-persisted": {
      // False-success: the beat reports enqueued>0 but no spec-test job actually landed.
      const enqueued = producedCount(latest?.produced, "enqueued");
      if (!latest || enqueued <= 0) return null;
      const SLACK_MS = 10 * 60_000; // tolerate clock skew between the cron beat and the insert.
      const persisted =
        inputs.latestSpecTestJobAt != null &&
        new Date(inputs.latestSpecTestJobAt).getTime() >= new Date(latest.ran_at).getTime() - SLACK_MS;
      if (persisted) return null;
      return {
        statusText: `reported ${enqueued} enqueued, persisted 0`,
        violation: {
          reason: "false_success",
          detail: `Spec-test reported ${enqueued} job${enqueued === 1 ? "" : "s"} enqueued at ${latest.ran_at} but 0 spec-test agent_jobs persisted (last spec-test job ${elapsed(inputs.latestSpecTestJobAt)} ago).`,
        },
      };
    }
    case "renewal-integrity": {
      // Renewal integrity: active internal subs overdue ⇒ the cron ran but didn't advance them.
      if (inputs.overdueInternalSubs <= 0) return null;
      const n = inputs.overdueInternalSubs;
      return {
        statusText: `${n} internal sub${n === 1 ? "" : "s"} overdue — not renewed`,
        violation: {
          reason: "renewal_integrity",
          detail: `${n} active internal subscription${n === 1 ? "" : "s"} have next_billing_date in the past (before today UTC) — the renewal cron ran but did not advance ${n === 1 ? "it" : "them"}.`,
        },
      };
    }
    case "renewal-outcome-distribution": {
      // The cron ran AND each decline individually "routed to dunning correctly", but the
      // per-cycle outcome MIX is broken: a systemic anomalous rate (bad creds declining everyone,
      // a mass no-payment-method skip) or a spike vs the rolling baseline. Aggregated from the
      // per-sub outcome beats. Needs a minimum cycle sample so a quiet day can't false-fire.
      const cur = inputs.renewalCurrent;
      if (cur.total < RENEWAL_MIN_CYCLE_SAMPLE) return null;
      const bad = badOutcomeCount(cur);
      const rate = bad / cur.total;

      let tripped: "systemic" | "spike" | null = null;
      let baselineNote = "";
      if (rate >= RENEWAL_HARD_FLOOR_RATE) {
        tripped = "systemic";
      } else if (inputs.renewalBaseline.total >= RENEWAL_MIN_BASELINE_SAMPLE && rate >= RENEWAL_MIN_SPIKE_RATE) {
        const baseRate = badOutcomeCount(inputs.renewalBaseline) / inputs.renewalBaseline.total;
        if (rate >= Math.max(baseRate * RENEWAL_SPIKE_FACTOR, baseRate + RENEWAL_SPIKE_MARGIN)) {
          tripped = "spike";
          baselineNote = ` (baseline ${Math.round(baseRate * 100)}%)`;
        }
      }
      if (!tripped) return null;

      const pct = Math.round(rate * 100);
      const declinePct = cur.total > 0 ? Math.round((cur.declined_to_dunning / cur.total) * 100) : 0;
      return {
        statusText: `renewal outcome ${tripped === "systemic" ? "break" : "spike"} — ${pct}% anomalous (${cur.declined_to_dunning} declined, ${cur.skipped_no_payment_method} no-PM)`,
        violation: {
          reason: "renewal_outcome_distribution",
          detail: `Renewal cycle outcome ${tripped === "systemic" ? "break" : "spike"}: ${bad}/${cur.total} outcomes anomalous (${pct}%${baselineNote}) — ${cur.declined_to_dunning} declined→dunning (${declinePct}% decline rate), ${cur.skipped_no_payment_method} skipped no-payment-method, ${cur.comp_blocked} comp-blocked. The renewal cron ran and each decline routed correctly, but the per-cycle mix signals a systemic break (e.g. bad Braintree creds, a no-payment-method spike).`,
        },
      };
    }
    case "stuck-dunning": {
      // A dunning cycle still 'retrying' well past its next_retry_at means the retry engine ran
      // but isn't advancing it (recovered/exhausted). A sub correctly mid-dunning (within its
      // retry schedule, next_retry_at in the future or only recently passed) is NOT flagged.
      if (inputs.stuckDunningCycles <= 0) return null;
      const n = inputs.stuckDunningCycles;
      const graceH = Math.round(STUCK_DUNNING_GRACE_MS / 3_600_000);
      return {
        statusText: `${n} sub${n === 1 ? "" : "s"} stuck in dunning past retry`,
        violation: {
          reason: "stuck_dunning",
          detail: `${n} dunning_cycle${n === 1 ? " is" : "s are"} still 'retrying' more than ${graceH}h past next_retry_at — the retry engine isn't advancing ${n === 1 ? "it" : "them"} to recovered/exhausted on schedule.`,
        },
      };
    }
    case "segment-coverage": {
      // fix-segment-refresh-coverage P2: the refresh-customer-segments cron is fresh + green on
      // P1, but the WHOLE-BOOK coverage is broken — < 95% of SMS-subscribed rows have
      // segments_refreshed_at within 26h, OR any subscribed row's segments_refreshed_at is
      // older than 48h / NULL. The 2026-07 regression (PostgREST 1000-row cap + STEP_BATCH=2000
      // → cursor nulled after page 1 → 1000/138K refreshed daily, back half 29d stale) went
      // undetected for weeks because P1 was green: the cron fired every day on schedule. This
      // assertion polls the LIVE customers table each monitor tick — the number in
      // produced.sms_subscribed_* is for the tile, the DECISION is on the live probe so a
      // silently-lying beat can't hide it. Sample-guarded (book must have MIN_SAMPLE
      // subscribers) so a fresh/tiny workspace never false-fires.
      const total = inputs.smsSubscribedTotal;
      if (total < SEGMENT_COVERAGE_MIN_SAMPLE) return null;
      const fresh = inputs.smsSubscribedFresh26h;
      const stale = inputs.smsSubscribedStale48h;
      const ratio = fresh / total;
      const minPct = Math.round(SEGMENT_COVERAGE_MIN_RATIO * 100);
      const maxAgeH = Math.round(SEGMENT_COVERAGE_MAX_AGE_MS / 3_600_000);
      // Run-in-progress grace: the fresh-cohort ratio only signals 'yesterday's cron didn't cover the book'
      // AFTER today's cron has had a chance to finish. While the daily refresh-customer-segments fanout is
      // still walking the book (~4-5h across 138K rows), a below-floor ratio is the expected shape of an
      // in-progress walk, not a break. If the loop's most recent beat is within the grace window, skip the
      // ratio check. The stale48h check below stays active — a subscriber older than 48h is a genuine break
      // even mid-run — and once the grace elapses the 95% floor re-engages.
      const withinRunGrace =
        latest?.ran_at != null && ageMs(latest.ran_at) <= SEGMENT_COVERAGE_RUN_GRACE_MS;
      if (!withinRunGrace && ratio < SEGMENT_COVERAGE_MIN_RATIO) {
        const pct = Math.round(ratio * 100);
        return {
          statusText: `only ${pct}% of subscribers fresh (${fresh}/${total}, need ${minPct}%)`,
          violation: {
            reason: "segment_coverage",
            detail: `Segment refresh coverage break: only ${fresh}/${total} SMS-subscribed customers (${pct}%) have segments_refreshed_at within 26h — below the ${minPct}% floor. The cron ran but did not refresh the whole book (2026-07 PostgREST-cap regression signature: back half stayed stale).`,
          },
        };
      }
      if (stale > 0) {
        return {
          statusText: `${stale} subscriber${stale === 1 ? "" : "s"} stale >${maxAgeH}h`,
          violation: {
            reason: "segment_coverage",
            detail: `Segment refresh stale-tail: ${stale} SMS-subscribed customer${stale === 1 ? "" : "s"} ${stale === 1 ? "has" : "have"} segments_refreshed_at older than ${maxAgeH}h (or NULL). The cron ran but part of the book didn't refresh.`,
          },
        };
      }
      return null;
    }
    case "migration-drift": {
      // The box's migration-drift check runs TWO axes and rides both on the same heartbeat:
      //  1. TABLE-PRESENCE: parse every supabase/migrations/*.sql for the tables they CREATE (net of
      //     drops/renames) and diff the live public schema; an expected-but-absent table = a
      //     silently-skipped migration → `produced.missing`.
      //  2. APPLIED-SET RECONCILE (ci-guard-migrations-applied-not-just-merged P1): compare local
      //     migration versions against supabase_migrations.schema_migrations.version; a file on main
      //     whose version isn't in the applied set = merged-but-unapplied →
      //     `produced.mergedButUnapplied`.
      // Either axis reddens the tile. Allowlisted/sunset tables are excluded box-side.
      const missing = readMissingTables(latest?.produced);
      const mergedButUnapplied = readMergedButUnapplied(latest?.produced);
      if (!latest || (missing.length === 0 && mergedButUnapplied.length === 0)) return null;
      const statusParts: string[] = [];
      const detailParts: string[] = [];
      if (missing.length > 0) {
        const n = missing.length;
        const list = missing.slice(0, 5).map((m) => `${m.table} (${m.migration})`).join(", ");
        statusParts.push(`${n} migration table${n === 1 ? "" : "s"} missing from live schema`);
        detailParts.push(
          `${n} table${n === 1 ? "" : "s"} that a migration creates ${n === 1 ? "is" : "are"} absent from the live public schema — ${list}${n > 5 ? `, +${n - 5} more` : ""}. A migration was silently skipped in the apply pipeline (the code references the table; every upsert hits PGRST205). Re-apply the migration${n === 1 ? "" : "s"}.`,
        );
      }
      if (mergedButUnapplied.length > 0) {
        const n = mergedButUnapplied.length;
        // Phase 2 (ci-guard-migrations-applied-not-just-merged): outcomes let the tile detail split
        // applied / approval-needed / apply-failed so the CEO reads what's actionable (destructive
        // migrations waiting for a human run) vs what auto-cleared (additive) vs what threw.
        const approvalNeeded = mergedButUnapplied.filter((m) => m.outcome === "approval-needed");
        const applyFailed = mergedButUnapplied.filter((m) => m.outcome === "apply-failed");
        const alreadyApplied = mergedButUnapplied.filter((m) => m.outcome === "already-applied");
        const list = mergedButUnapplied
          .slice(0, 5)
          .map((m) => {
            const oc = m.outcome === "approval-needed"
              ? ` — needs approval${m.severity ? `, ${m.severity}` : ""}`
              : m.outcome === "apply-failed"
                ? " — apply-failed"
                : m.outcome === "applied"
                  ? " — applied"
                  : m.outcome === "already-applied"
                    ? " — already-applied (ledger reconciled)"
                    : "";
            return `${m.version} (${m.file})${oc}`;
          })
          .join(", ");
        const gateNote: string[] = [];
        if (approvalNeeded.length) gateNote.push(`${approvalNeeded.length} destructive await${approvalNeeded.length === 1 ? "s" : ""} approval`);
        if (applyFailed.length) gateNote.push(`${applyFailed.length} apply-failed`);
        if (alreadyApplied.length) gateNote.push(`${alreadyApplied.length} already-applied`);
        const gateTail = gateNote.length ? ` — ${gateNote.join(", ")}` : "";
        statusParts.push(`${n} merged-but-unapplied migration${n === 1 ? "" : "s"}${gateTail}`);
        detailParts.push(
          `${n} migration file${n === 1 ? "" : "s"} on main whose version${n === 1 ? " is" : "s are"} not in the DB's applied set (supabase_migrations.schema_migrations) — ${list}${n > 5 ? `, +${n - 5} more` : ""}. The PR merged but the apply pipeline never ran ${n === 1 ? "it" : "them"} — dependent code silently no-ops until applied. Additive DDL is auto-applied by the box; destructive DDL is gated for approval (classify via classifyMigrationSql — run the sanctioned apply script manually).`,
        );
      }
      return {
        statusText: statusParts.join("; "),
        violation: {
          reason: "migration_drift",
          detail: `Migration drift: ${detailParts.join(" ")}`,
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Non-terminal dunning statuses: a cycle in one of these is still actively working the retry
 * flow (rotating cards, waiting for a payday retry, paused pending a customer action, or the
 * legacy 'active'/'skipped' pre-terminal states). Terminal statuses ('recovered', 'exhausted')
 * are NOT here — a sub whose only dunning cycle is terminal has no live coverage and should
 * still trip renewal-integrity if it's overdue. Kept in sync with `getActiveDunningCycle` in
 * src/lib/dunning.ts, the canonical "is dunning still owning this sub" question.
 */
const ACTIVE_DUNNING_STATUSES = ["active", "rotating", "retrying", "skipped", "paused"] as const;

/**
 * READ-ONLY: overdue active internal subscriptions that AREN'T already owned by an active
 * dunning cycle (build-control-tower-renewal-integrity-exclude-active-dunning Phase 1).
 *
 * An overdue internal sub whose payment failed and dunning is waiting for the next retry is
 * a HEALTHY retention state, not a renewal-cron miss — counting it as renewal_integrity
 * false-pages the platform owner. So subtract subs whose subscription_id is joined to a
 * non-terminal `dunning_cycles` row. Uncovered overdue subs still flag as renewal_integrity;
 * dunning-owned subs remain visible through the stuck-dunning assertion if their retry
 * schedule is missed.
 *
 * The join is on subscription_id (internal UUID) per the CLAUDE.md invariant that internal
 * joins never go through shopify_*_id. The spec-test sandbox is excluded on both sides so a
 * seeded stuck-overdue fixture can't inflate the real count.
 */
export async function countRenewalIntegrityOverdueSubs(admin: Admin, startOfTodayIso: string): Promise<number> {
  const { data: overdueRows, error: overdueErr } = await admin
    .from("subscriptions")
    .select("id")
    .eq("is_internal", true)
    .eq("status", "active")
    .lt("next_billing_date", startOfTodayIso)
    .neq("workspace_id", SPEC_TEST_SANDBOX_WORKSPACE_ID);
  if (overdueErr || !overdueRows || overdueRows.length === 0) return 0;
  const overdueIds = overdueRows.map((r) => (r as { id: string }).id);

  const { data: coveredRows, error: coveredErr } = await admin
    .from("dunning_cycles")
    .select("subscription_id")
    .in("status", [...ACTIVE_DUNNING_STATUSES])
    .in("subscription_id", overdueIds)
    .neq("workspace_id", SPEC_TEST_SANDBOX_WORKSPACE_ID);
  if (coveredErr) return overdueIds.length;
  const coveredIds = new Set<string>();
  for (const row of coveredRows ?? []) {
    const subId = (row as { subscription_id: string | null }).subscription_id;
    if (subId) coveredIds.add(subId);
  }

  let uncovered = 0;
  for (const id of overdueIds) if (!coveredIds.has(id)) uncovered += 1;
  return uncovered;
}

/** READ-ONLY: fetch the extra state the Phase 2 output assertions evaluate against. */
async function fetchAssertionInputs(admin: Admin): Promise<AssertionInputs> {
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  // A dunning cycle still 'retrying' more than the grace past next_retry_at is stuck.
  const stuckBeforeIso = new Date(Date.now() - STUCK_DUNNING_GRACE_MS).toISOString();
  // Segment-coverage window bounds (fix-segment-refresh-coverage P2).
  const segFreshCutoffIso = new Date(Date.now() - 26 * 60 * 60_000).toISOString();
  const segStaleCutoffIso = new Date(Date.now() - SEGMENT_COVERAGE_MAX_AGE_MS).toISOString();

  const [escalated, oldestEscalated, triageJob, specTestJob, overdueInternalSubsUncovered, renewalCronBeat, stuckDunning, smsTotal, smsFresh, smsStale] = await Promise.all([
    // Routine-owned escalated tickets still open — mirrors triage-escalations-cron's query.
    admin
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .not("escalated_at", "is", null)
      .is("escalated_to", null)
      .not("status", "in", '("archived","closed")'),
    // The OLDEST waiting ticket's escalated_at — how long real escalated work has actually been waiting.
    admin
      .from("tickets")
      .select("escalated_at")
      .not("escalated_at", "is", null)
      .is("escalated_to", null)
      .not("status", "in", '("archived","closed")')
      .order("escalated_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    // june-review-replaces-solver-skeptic-quorum-triage Phase 1: the triage-escalations cron now
    // enqueues cs-director-call jobs (one per eligible escalated ticket) as the primary triage
    // instead of the legacy per-workspace triage-escalations sweep. Consider BOTH kinds so the
    // "no triage job since it escalated" check keeps working during rollout AND after — the newest
    // create_at across the two is what "the last time the cron picked work up" means.
    admin
      .from("agent_jobs")
      .select("created_at")
      .in("kind", ["cs-director-call", "triage-escalations"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from("agent_jobs").select("created_at").eq("kind", "spec-test").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    // Overdue = strictly before today 00:00 UTC ⇒ a full renewal window has passed
    // (no false positive on a sub merely due today that the async attempt hasn't processed yet).
    // Subs already owned by an ACTIVE dunning cycle (rotating/retrying/paused/skipped) are
    // subtracted — a payment-failed sub waiting for its retry date is healthy retention state,
    // not a renewal-cron miss (build-control-tower-renewal-integrity-exclude-active-dunning P1).
    countRenewalIntegrityOverdueSubs(admin, startOfToday.toISOString()),
    // The latest renewal-cron beat marks the start of the LIVE current cycle — outcome beats since
    // then belong to it (vs everything older = the rolling baseline).
    admin.from("loop_heartbeats").select("ran_at").eq("loop_id", "internal-subscription-renewal-cron").order("ran_at", { ascending: false }).limit(1).maybeSingle(),
    // Stuck dunning: 'retrying' with next_retry_at older than the grace. (next_retry_at < x is
    // null-safe — null next_retry_at rows are excluded, so a cycle awaiting scheduling isn't flagged.)
    admin
      .from("dunning_cycles")
      .select("id", { count: "exact", head: true })
      .eq("status", "retrying")
      .lt("next_retry_at", stuckBeforeIso)
      // Exclude the spec-test sandbox: a deliberately-stuck dunning fixture isn't a real anomaly.
      .neq("workspace_id", SPEC_TEST_SANDBOX_WORKSPACE_ID),
    // Segment refresh coverage inputs (fix-segment-refresh-coverage P2). Three global head-counts
    // over the SMS-subscribed set, excluding the spec-test sandbox tenant. Each is index-friendly
    // (sms_marketing_status + segments_refreshed_at) and head:true (no row payload), so this stays
    // cheap even on a 100K+ book.
    admin
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("sms_marketing_status", "subscribed")
      .neq("workspace_id", SPEC_TEST_SANDBOX_WORKSPACE_ID),
    admin
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("sms_marketing_status", "subscribed")
      .neq("workspace_id", SPEC_TEST_SANDBOX_WORKSPACE_ID)
      .gte("segments_refreshed_at", segFreshCutoffIso),
    // Stale tail: segments_refreshed_at older than 48h OR NULL. `.or` gives us both branches in
    // one count (NULL-safe: `is.null` matches never-refreshed rows the `lt` branch would skip).
    admin
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("sms_marketing_status", "subscribed")
      .neq("workspace_id", SPEC_TEST_SANDBOX_WORKSPACE_ID)
      .or(`segments_refreshed_at.is.null,segments_refreshed_at.lt.${segStaleCutoffIso}`),
  ]);

  // Renewal outcome distribution: current cycle (since the last cron beat, or a 26h fallback) vs a
  // rolling baseline (the prior cycles before it). Aggregated from the per-sub outcome beats.
  const cycleStartIso = (renewalCronBeat.data as { ran_at: string } | null)?.ran_at ?? new Date(Date.now() - 26 * 60 * 60_000).toISOString();
  const baselineStartIso = new Date(new Date(cycleStartIso).getTime() - RENEWAL_BASELINE_WINDOW_MS).toISOString();
  const [renewalCurrent, renewalBaseline] = await Promise.all([
    aggregateRenewalOutcomes(admin, cycleStartIso),
    aggregateRenewalOutcomes(admin, baselineStartIso, cycleStartIso),
  ]);

  return {
    escalatedWaiting: escalated.count ?? 0,
    oldestEscalatedAt: (oldestEscalated.data as { escalated_at: string } | null)?.escalated_at ?? null,
    latestTriageJobAt: (triageJob.data as { created_at: string } | null)?.created_at ?? null,
    latestSpecTestJobAt: (specTestJob.data as { created_at: string } | null)?.created_at ?? null,
    overdueInternalSubs: overdueInternalSubsUncovered,
    renewalCurrent,
    renewalBaseline,
    stuckDunningCycles: stuckDunning.count ?? 0,
    smsSubscribedTotal: smsTotal.count ?? 0,
    smsSubscribedFresh26h: smsFresh.count ?? 0,
    smsSubscribedStale48h: smsStale.count ?? 0,
  };
}

/** READ-ONLY: evaluate every registered loop → tiles. Used by the dashboard + the monitor. */
export async function buildControlTowerSnapshot(adminClient?: Admin): Promise<ControlTowerSnapshot> {
  const admin = adminClient ?? createAdminClient();

  const [{ data: workerRow }, { data: beats, error: beatsError }, { data: openAlerts }, { data: jobs }, assertionInputs, inlineState, selfAudit, { data: oldestMonitorBeat }, { data: firstSeenRows }, { data: workerCtrl }] = await Promise.all([
    admin.from("worker_heartbeats").select("running_sha, status, active_builds, detail, last_poll_at, started_at, accounts").eq("id", WORKER_BOX_ID).maybeSingle(),
    // ONE bounded, index-friendly read (control-tower-loop-beats-rpc-perf P1): a lateral join takes
    // the distinct cron + agent-kind loop_ids and, per loop, reads only its latest HISTORY_LIMIT
    // beats off the (loop_id, ran_at desc) index — ≤N index rows per loop, no global scan/sort. It
    // returns no all-time count: PRESENCE is the ever-beaten signal (absent ⇒ 0 beats ⇒ never_fired
    // candidate). Replaces the prior per-row `count(*) OVER`/`row_number() OVER` window, which still
    // scanned + sorted the whole (ever-growing) beat history per call → statement-timeout 500s on
    // POST /rest/v1/rpc/control_tower_loop_beats. Inline-agent/reactive beats are high-volume and
    // excluded here — they get latest + history + ok/err counts from fetchInlineAgentState below.
    admin.rpc("control_tower_loop_beats", { p_history_limit: HISTORY_LIMIT }),
    admin.from("loop_alerts").select("id, loop_id, reason, detail, opened_at, last_seen_at").eq("status", "open"),
    admin.from("agent_jobs").select("id, kind, status, created_at, claimed_at, updated_at").in("status", ["queued", "claimed", "building", "queued_resume"]),
    fetchAssertionInputs(admin),
    fetchInlineAgentState(admin),
    buildCoverageAudit(),
    // Deploy-SURVIVING watchdog-uptime reference for the registered-but-not-firing cron check
    // (evalCron): the OLDEST control-tower-monitor beat = how long the watchdog itself has been
    // continuously running. Unlike deployRefAgeMs it doesn't reset on the box's self-update/restart,
    // so a long-dead registered cron can't keep hiding behind a freshly-reset deploy clock. Uses the
    // (loop_id, ran_at) index (single oldest row). Beat retention can only shorten this span, never
    // inflate it ⇒ conservative (never a false registered_not_firing).
    admin.from("loop_heartbeats").select("ran_at").eq("loop_id", "control-tower-monitor").order("ran_at", { ascending: true }).limit(1).maybeSingle(),
    // Empirical first-observed-at anchor for the registered_not_firing grace
    // (control-tower-registered-not-firing-observed-anchor-grace P1). A deploy-SURVIVING per-loop
    // record of when the snapshot first SAW each loop registered. The grace clock in evalCron takes
    // MAX(firstScheduledFiringMs, first_observed_at), so a hand-edited `registeredAt` SET BEFORE the
    // cron actually shipped (fleet-spend-governor: registeredAt 00:00 with cadence `10,40 * * * *`
    // → computed first-firing 00:10 SAME day → the 90-min grace evaporates the moment the deploy
    // lands hours later) can never shorten the grace below "we have empirically seen this loop
    // registered for at least one full window." Tiny table (one row per registered loop) — read
    // unbounded.
    admin.from("monitored_loops_first_seen").select("loop_id, first_seen_at"),
    // Manual queue-restart flag (worker_controls.drain_for_update) — mirrors the worker's own
    // self-update decision (scripts/builder-worker.ts:4290): a manual drain restarts at idle
    // regardless of the queue (that's the whole point), so when it's set the queue-aware deferral
    // is suppressed and behindTooLong still reds at grace. Singleton row keyed by WORKER_BOX_ID;
    // missing row ⇒ drain off (no-op).
    admin.from("worker_controls").select("drain_for_update").eq("box_id", WORKER_BOX_ID).maybeSingle(),
  ]);

  // Trustworthy deploy-age reference for the never-fired cron check (evalCron).
  const deployAgeMs = deployRefAgeMs(workerRow as WorkerRow | null);
  // How long the watchdog itself has been observably alive (oldest monitor beat → now), or null if it
  // has never beat (bootstrapping / pruned). Feeds the deploy-independent registered_not_firing guard.
  const monitorUptimeMs = (oldestMonitorBeat as { ran_at: string } | null)?.ran_at
    ? ageMs((oldestMonitorBeat as { ran_at: string }).ran_at)
    : null;

  // A failed/timed-out control_tower_loop_beats RPC (statement timeout scanning the feed) returns
  // beats=null → empty byLoop → every cron looks like 0 beats ever (absent) + no latest. That is
  // UNKNOWN, not "never fired": suppress the never_fired + cron_freshness reds and stay conservative
  // (amber) so a transient read failure can't false-fire and page healthy crons — the same posture
  // as the deployAgeMs==null guard that keeps a missing deploy-age reference from false-alarming.
  const beatsReadFailed = beatsError != null;

  // Group heartbeats by loop_id (the RPC returns them ordered by loop_id, rn=newest-first, already
  // capped at HISTORY_LIMIT per loop). PRESENCE in this map is the ever-beaten signal: the lateral-
  // join RPC no longer returns an all-time count (the costly per-row window is gone) — a loop with
  // zero beats simply isn't in the distinct-loop_id set → absent from byLoop → never_fired candidate;
  // present (history non-empty) ⇒ it has beaten ⇒ at most a freshness alert, never never_fired.
  const byLoop = new Map<string, LoopHistoryRow[]>();
  for (const b of (beats ?? []) as Array<LoopHistoryRow & { loop_id: string }>) {
    const arr = byLoop.get(b.loop_id) ?? [];
    arr.push({ ran_at: b.ran_at, ok: b.ok, produced: b.produced, detail: b.detail, duration_ms: b.duration_ms });
    byLoop.set(b.loop_id, arr);
  }
  const alertByLoop = new Map<string, OpenAlert>();
  for (const a of (openAlerts ?? []) as Array<OpenAlert & { loop_id: string }>) {
    alertByLoop.set(a.loop_id, { id: a.id, reason: a.reason, detail: a.detail, opened_at: a.opened_at, last_seen_at: a.last_seen_at });
  }
  const activeJobs = (jobs ?? []) as ActiveJob[];
  // Queue-aware self-update deferral inputs (mirror-worker-queue-aware-self-update). The worker
  // intentionally parks its self-update while {queued, queued_resume} > 0 unless a MANUAL queue
  // restart is set — without these the box tile reads "self-update stuck" while the worker is
  // behaving exactly as designed (the loop:box false positive).
  const queuedCount = activeJobs.filter((j) => j.status === "queued" || j.status === "queued_resume").length;
  const manualDrain = !!(workerCtrl as { drain_for_update: boolean } | null)?.drain_for_update;

  // Attribute queued agent-kind backlog to the box worker when the worker itself is stale/absent/
  // crash-looping, instead of opening a stuck_jobs red on every healthy agent lane
  // (pr-resolve, spec-test, …). Read the worker loop's livenessWindowMs from the same registry row
  // evalWorker uses — falls back to the same 5m default — so the two tiles can never disagree.
  // (control-tower-suppress-agent-stuck-during-worker-outage Phase 1)
  const workerLoop = MONITORED_LOOPS.find((l) => l.kind === "worker");
  const workerUnavailable = isWorkerUnavailable(
    workerRow as WorkerRow | null,
    workerLoop?.livenessWindowMs ?? 5 * 60_000,
  );

  // SHA-direction (control-tower-box-sha-direction-check, signal loop:box). Classify the box
  // worker's running_sha vs VERCEL_GIT_COMMIT_SHA via the GitHub compare API BEFORE evalWorker
  // decides "behind" — a plain prefix mismatch can't tell stale-code (worker-behind) from deploy
  // lag (worker-ahead). Fails CLOSED to "unknown" (no red on an ambiguous compare, mirroring the
  // deployAgeMs==null posture). Prefix-equal SHAs are resolved locally (no round-trip).
  const deployedShaForDirection = process.env.VERCEL_GIT_COMMIT_SHA || "";
  const runningShaForDirection = (workerRow as WorkerRow | null)?.running_sha ?? "";
  const { direction: shaDirection, firstDivergentAt } = await fetchShaDirection(
    deployedShaForDirection,
    runningShaForDirection,
  );

  // Empirical first-observed-at anchor (control-tower-registered-not-firing-observed-anchor-grace
  // P1). Build the loop_id → first_seen_at(ms) map from the read above, then best-effort upsert a
  // fresh row for every registered loop missing one — on-conflict-do-nothing so the FIRST tick that
  // ever sees a loop wins, and every subsequent tick is a no-op. We compute the timestamp NOW (one
  // shared value per tick) so a future-now() column isn't sensitive to clock skew, and so the
  // freshly-upserted rows are immediately usable in this same tick. Failures are swallowed: the
  // empirical anchor is a refinement of the existing grace, not a load-bearing dependency — a
  // transient DB error must not break the snapshot or false-page anything.
  const firstSeenByLoop = new Map<string, number>();
  for (const r of (firstSeenRows ?? []) as Array<{ loop_id: string; first_seen_at: string }>) {
    const ms = Date.parse(r.first_seen_at);
    if (Number.isFinite(ms)) firstSeenByLoop.set(r.loop_id, ms);
  }
  const tickIso = new Date().toISOString();
  const tickMs = Date.parse(tickIso);
  const missingFirstSeen = MONITORED_LOOPS.filter((l) => !firstSeenByLoop.has(l.id));
  if (missingFirstSeen.length) {
    try {
      const { error: upsertErr } = await admin
        .from("monitored_loops_first_seen")
        .upsert(
          missingFirstSeen.map((l) => ({ loop_id: l.id, first_seen_at: tickIso })),
          { onConflict: "loop_id", ignoreDuplicates: true },
        );
      if (upsertErr) {
        console.warn(`[control-tower] monitored_loops_first_seen upsert failed:`, upsertErr.message);
      } else {
        for (const l of missingFirstSeen) firstSeenByLoop.set(l.id, tickMs);
      }
    } catch (e) {
      console.warn(`[control-tower] monitored_loops_first_seen upsert threw:`, e instanceof Error ? e.message : e);
    }
  }

  const loops: LoopStatus[] = MONITORED_LOOPS.map((loop) => {
    // Inline + reactive agents source their history + latest from the dedicated windowed fetch
    // (they're excluded from the main beats query above) and share the inline evaluation.
    if (loop.kind === "inline-agent" || loop.kind === "reactive") {
      const st = inlineState.get(loop.id);
      const core = evalInlineAgent(loop, st);
      return { ...core, owner: loop.owner, history: st?.history ?? [], openAlert: alertByLoop.get(loop.id) ?? null };
    }
    const history = byLoop.get(loop.id) ?? [];
    const latest = history[0] ?? null;
    let core: Omit<LoopStatus, "history" | "openAlert" | "owner">;
    if (loop.kind === "worker") core = evalWorker(loop, workerRow as WorkerRow | null, queuedCount, manualDrain, shaDirection, firstDivergentAt);
    else if (loop.kind === "cron") core = evalCron(loop, latest, deployAgeMs, history.length, beatsReadFailed, monitorUptimeMs, firstSeenByLoop.get(loop.id) ?? null, workerUnavailable);
    else core = evalAgentKind(loop, latest, activeJobs, (workerRow as WorkerRow | null)?.started_at ?? null, workerUnavailable);
    // Phase 2: layer the output assertion(s) on top. Only escalates green/amber → red
    // (a P1 red — silent/stale/stuck — is the higher-priority violation; keep it). A loop may
    // carry several (the renewal cron: renewal-integrity + outcome-distribution) — first to fail wins.
    const assertionIds = loop.outputAssertions ?? (loop.outputAssertion ? [loop.outputAssertion] : []);
    if (assertionIds.length && core.color !== "red") {
      for (const aid of assertionIds) {
        const a = evalOutputAssertion(aid, loop, latest, assertionInputs);
        if (a) {
          core = { ...core, color: "red", statusText: a.statusText, violation: a.violation };
          break;
        }
      }
    }
    return { ...core, owner: loop.owner, history, openAlert: alertByLoop.get(loop.id) ?? null };
  });

  const counts = { green: 0, amber: 0, red: 0 };
  for (const l of loops) counts[l.color]++;
  // Fold the self-audit findings into the honest amber count: every cron in code with no tile
  // ("unregistered loop: X") and every in-code↔Inngest-registered gap is a coverage warning,
  // so the header never reads "all healthy" while the watchdog itself has a blind spot.
  counts.amber += selfAudit.unregistered.length + selfAudit.inngestRegistration.missing.length;

  // Phase 3: department rollups (CEO-glance). Each org function's loops collapse to a worst-of
  // health tile (red > amber > green) with a healthy/total count + open-alert count — the dashboard
  // leads with these, then drills into the per-loop cards.
  const departments = buildDepartmentRollups(loops);

  return { generatedAt: new Date().toISOString(), counts, loops, departments, selfAudit };
}

/** Worst-of color across a set of loops (red dominates amber dominates green). */
function worstColor(colors: LoopColor[]): LoopColor {
  if (colors.includes("red")) return "red";
  if (colors.includes("amber")) return "amber";
  return "green";
}

/**
 * Phase 3: collapse every loop into its owning org function → one rollup health tile per
 * department (Platform/Growth/Retention/CS/CMO). Worst-of color, a healthy/total count, and the
 * open-alert count — the CEO glance before the per-loop drill-in. Departments stay in
 * OWNER_FUNCTIONS order; one with no loops is omitted.
 */
function buildDepartmentRollups(loops: LoopStatus[]): DepartmentRollup[] {
  return OWNER_FUNCTIONS.map(({ id, label, healthLabel }) => {
    const mine = loops.filter((l) => l.owner === id);
    const counts = { green: 0, amber: 0, red: 0 };
    for (const l of mine) counts[l.color]++;
    return {
      owner: id,
      label,
      healthLabel,
      color: worstColor(mine.map((l) => l.color)),
      total: mine.length,
      healthy: counts.green,
      counts,
      openAlerts: mine.filter((l) => l.openAlert).length,
    };
  }).filter((d) => d.total > 0);
}

/** Distinct workspaces with at least one Slack-connected owner/admin to page. */
async function alertWorkspaceIds(admin: Admin): Promise<string[]> {
  const { data } = await admin
    .from("workspace_members")
    .select("workspace_id")
    .in("role", ["owner", "admin"])
    .not("slack_user_id", "is", null);
  return Array.from(new Set(((data ?? []) as Array<{ workspace_id: string }>).map((m) => m.workspace_id)));
}

/** Page the owners of every Slack-connected workspace about a newly-opened alert. */
async function pageOwners(admin: Admin, loop: LoopStatus): Promise<void> {
  const wsIds = await alertWorkspaceIds(admin);
  for (const wsId of wsIds) {
    await notifyOpsAlert(wsId, {
      title: `Control Tower: ${loop.label} ${loop.color === "red" ? "🔴" : "⚠️"}`,
      severity: "critical",
      lines: [
        loop.violation?.detail ?? loop.statusText,
        loop.lastRanAt ? `Last good: ${loop.lastRanAt} (${elapsed(loop.lastRanAt)} ago)` : "Last good: never",
        "See /dashboard/developer/control-tower",
      ],
    });
  }
}

export interface MonitorResult {
  evaluated: number;
  red: number;
  amber: number;
  green: number;
  opened: number;
  resolved: number;
}

/**
 * The Control Tower act loop (alert insert/update/resolve, owner paging, Repair +
 * coverage-register enqueue) writes to the SHARED loop_alerts feed, so it must run
 * only on the canonical production deploy. A preview/branch deploy carries a
 * branch-local MONITORED_LOOPS registry — e.g. a cron that exists only on an
 * unmerged WIP branch — so letting it write leaks phantom registered_not_firing
 * alerts into prod and wakes the Repair Agent for loops absent from HEAD (the
 * loop:claude-status-poll-cron incident). Every other env may still build the
 * read-only snapshot for its own dashboard; it just never writes to the feed.
 * Vercel sets VERCEL_ENV="production" only on the production deployment.
 */
function isCanonicalProductionDeploy(): boolean {
  return process.env.VERCEL_ENV === "production";
}

/** Evaluate + act: open de-duped alerts on red loops (paging on first sight), auto-resolve on recovery. */
export async function runControlTowerMonitor(): Promise<MonitorResult> {
  const admin = createAdminClient();
  const snap = await buildControlTowerSnapshot(admin);

  // Environment guard — only the canonical production deploy may act on the snapshot
  // (write to the shared loop_alerts feed, page owners, enqueue Repair/coverage jobs).
  // Non-prod deploys still evaluate the snapshot above (for counts / their own
  // dashboard) but return here before any write. See isCanonicalProductionDeploy.
  if (!isCanonicalProductionDeploy()) {
    console.warn(
      `[control-tower] non-production deploy (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}) — evaluated ${snap.loops.length} loop(s) read-only; skipping act loop (no alert writes, paging, or job enqueues).`,
    );
    return { evaluated: snap.loops.length, red: snap.counts.red, amber: snap.counts.amber, green: snap.counts.green, opened: 0, resolved: 0 };
  }

  // Self-audit findings are amber (surfaced on the dashboard + folded into counts), not a page —
  // but log them so a coverage gap is greppable in the cron's run output too.
  if (snap.selfAudit.unregistered.length) {
    console.warn(`[control-tower] self-audit: ${snap.selfAudit.unregistered.length} unregistered cron(s) in code with no tile: ${snap.selfAudit.unregistered.map((u) => u.id).join(", ")}`);
    // coverage-register agent trigger (event-driven on the audit): for each unregistered loop, propose
    // the inferred MONITORED_LOOPS entry for one-tap owner Build (deduped: one open proposal per loop
    // id). Best-effort — never let it break the monitor's act loop. See docs/brain/specs/
    // coverage-auto-register-agent.md · docs/brain/libraries/coverage-register-agent.md.
    try {
      const { enqueueCoverageRegisterJob } = await import("@/lib/coverage-register-agent");
      for (const u of snap.selfAudit.unregistered) {
        await enqueueCoverageRegisterJob(admin, { loopId: u.id, cadence: u.cadence });
      }
    } catch (e) {
      console.warn(`[control-tower] coverage-register enqueue failed:`, e instanceof Error ? e.message : e);
    }
  }
  if (snap.selfAudit.inngestRegistration.status === "ok" && snap.selfAudit.inngestRegistration.missing.length) {
    console.warn(`[control-tower] self-audit: ${snap.selfAudit.inngestRegistration.missing.length} fn(s) served in code but not registered with Inngest: ${snap.selfAudit.inngestRegistration.missing.join(", ")}`);
  }

  let opened = 0;
  let resolved = 0;
  for (const loop of snap.loops) {
    if (loop.color === "red" && loop.violation) {
      if (loop.openAlert) {
        // Already open — bump last_seen_at + refresh detail. NO re-page (de-dupe).
        await admin
          .from("loop_alerts")
          .update({ last_seen_at: new Date().toISOString(), reason: loop.violation.reason, detail: loop.violation.detail })
          .eq("id", loop.openAlert.id);
      } else {
        // Newly red → open an incident + page owners. The partial unique index is
        // the backstop against a racing double-open (concurrency-1 cron makes it rare).
        //
        // Snapshot-vs-write race guard (cron_freshness only): the snapshot's beats
        // read happens ~ms before this insert. For a cron whose livenessWindowMs is
        // ~2× its cadence, the next scheduled firing's heartbeat can land in the same
        // second the alert row is being written (loop:portal-auto-resume-cron — 20:15
        // UTC beat wrote at 20:15:12.049, snapshot-based alert would have written at
        // 20:15:12.281 → false page). Re-read the single most recent beat right at
        // the write moment; if it's now within the window, the cron has already
        // recovered mid-tick — skip the insert. A truly stale cron still has no
        // fresh beat, so the assertion is unchanged for real failures.
        if (loop.violation.reason === "cron_freshness") {
          const { data: fresh } = await admin
            .from("loop_heartbeats")
            .select("ran_at")
            .eq("loop_id", loop.id)
            .order("ran_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (fresh?.ran_at) {
            const def = MONITORED_LOOPS.find((l) => l.id === loop.id);
            const windowMs = def?.livenessWindowMs ?? 26 * 60 * 60_000;
            if (Date.now() - new Date(fresh.ran_at).getTime() <= windowMs) {
              continue;
            }
          }
        }
        const { error } = await admin.from("loop_alerts").insert({
          loop_id: loop.id,
          kind: loop.kind,
          reason: loop.violation.reason,
          detail: loop.violation.detail,
          status: "open",
        });
        if (!error) {
          opened++;
          await pageOwners(admin, loop);
          // Repair Agent trigger: a newly-opened loop_alert is the second place the Control Tower
          // records a NEW problem — enqueue a diagnose→propose-fix job for it (deduped by the
          // `loop:<id>` signature). Best-effort — never let it break the monitor's act loop.
          try {
            const { enqueueRepairJob } = await import("@/lib/repair-agent");
            await enqueueRepairJob(admin, {
              source: "loop-alert",
              signature: `loop:${loop.id}`,
              title: `${loop.label}: ${loop.violation.detail}`,
            });
          } catch (e) {
            console.warn(`[control-tower] repair enqueue failed for ${loop.id}:`, e instanceof Error ? e.message : e);
          }
        } else if (error.code !== "23505") {
          console.warn(`[control-tower] alert insert failed for ${loop.id}:`, error.message);
        }
      }
    } else if (loop.openAlert) {
      // Recovered (green or amber) → auto-resolve the open incident.
      await admin
        .from("loop_alerts")
        .update({ status: "resolved", resolved_at: new Date().toISOString() })
        .eq("id", loop.openAlert.id);
      resolved++;
    }
  }

  return { evaluated: snap.loops.length, red: snap.counts.red, amber: snap.counts.amber, green: snap.counts.green, opened, resolved };
}
