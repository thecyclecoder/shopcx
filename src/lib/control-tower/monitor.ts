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
  WORKER_BOX_ID,
  type LoopKind,
  type MonitoredLoop,
  type OwnerFunction,
} from "@/lib/control-tower/registry";
import { buildCoverageAudit, type CoverageAudit } from "@/lib/control-tower/self-audit";

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

/** Compact duration string from a millisecond span (e.g. "3m", "2h", "1d"). */
function fmtDur(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86_400)}d`;
}

interface WorkerRow {
  running_sha: string | null;
  status: string | null;
  active_builds: number | null;
  detail: string | null;
  last_poll_at: string | null;
  started_at: string | null;
}

interface ActiveJob {
  id: string;
  kind: string;
  status: string;
  created_at: string | null;
  claimed_at: string | null;
  updated_at: string | null;
}

/** When did this in-flight job last make progress? (claim time for running jobs.) */
function jobStuckSince(j: ActiveJob): string | null {
  if (j.status === "building" || j.status === "claimed") {
    return j.claimed_at ?? j.updated_at ?? j.created_at;
  }
  return j.updated_at ?? j.created_at;
}

function evalWorker(loop: MonitoredLoop, row: WorkerRow | null): Omit<LoopStatus, "history" | "openAlert" | "owner"> {
  const base = {
    id: loop.id,
    kind: loop.kind,
    label: loop.label,
    description: loop.description,
    expectedCadence: loop.expectedCadence,
    lastRanAt: row?.last_poll_at ?? null,
    lastProduced: row ? { active_builds: row.active_builds ?? 0 } : null,
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
  // running_sha behind origin/main (deployed SHA) for longer than the grace window
  // ⇒ self-update is broken (the worker is alive but stuck on old code). Only pages
  // when the worker is IDLE — a busy worker legitimately DEFERS self-update until its
  // in-flight lanes clear (sacrosanct), so behind-while-building is healthy, not stuck.
  const deployed = process.env.VERCEL_GIT_COMMIT_SHA || "";
  const running = row.running_sha || "";
  const idle = (row.active_builds ?? 0) === 0;
  const behind = !!deployed && !!running && deployed.slice(0, running.length) !== running;
  const behindTooLong = behind && idle && ageMs(row.started_at) > (loop.shaGraceMs ?? 30 * 60_000);
  if (behindTooLong) {
    return { ...base, color: "red", statusText: `behind origin/main — running ${running}, deployed ${deployed.slice(0, 7)}`, detail: row.detail ?? null, violation: { reason: "liveness", detail: `Box build worker is running ${running} but origin/main is ${deployed.slice(0, 7)} — self-update stuck for ${elapsed(row.started_at)}.` } };
  }
  // Behind but BUSY (active build in flight) ⇒ the worker is intentionally deferring
  // self-update until its lanes clear (sacrosanct — never kill an in-flight build). That's
  // healthy, not a warning — keep it GREEN so a normal post-deploy build doesn't false-amber.
  if (behind && !idle) {
    return { ...base, color: "green", statusText: `building — update deferred (${running} → ${deployed.slice(0, 7)} when idle)`, detail: row.detail ?? null, violation: null };
  }
  // Behind + IDLE but within grace ⇒ it should self-update on its next poll; brief amber.
  if (behind) {
    return { ...base, color: "amber", statusText: `updating — running ${running}, deployed ${deployed.slice(0, 7)}`, detail: row.detail ?? null, violation: null };
  }
  return { ...base, color: "green", statusText: `healthy · ${running || "?"} · last poll ${elapsed(row.last_poll_at)} ago`, detail: row.detail ?? null, violation: null };
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

function evalCron(loop: MonitoredLoop, latest: LoopHistoryRow | null, deployAgeMs: number | null, everBeatCount: number, beatsReadFailed = false): Omit<LoopStatus, "history" | "openAlert" | "owner"> {
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
  // The all-time beats read failed (RPC error / statement timeout): latest and everBeatCount are
  // not trustworthy — a failed read collapses every cron to latest=null/everBeatCount=0. Stay
  // conservative (amber) instead of false-firing never_fired/cron_freshness reds and paging owners
  // on a healthy cron. Mirrors the deployAgeMs==null guard. (control-tower-beats-read-failure-guard.)
  if (beatsReadFailed) {
    return { ...base, color: "amber", statusText: "beats read unavailable — staying conservative", violation: null };
  }
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
  // never_fired. everBeatCount is the all-time beat count from the per-loop grouped read; with that
  // read `latest` is already non-null whenever everBeatCount>0, but we gate the red on the count
  // EXPLICITLY so the old deploy-boundary false positive can't silently return if the read changes.
  if (!latest) {
    const window = loop.livenessWindowMs ?? 26 * 60 * 60_000;
    if (everBeatCount === 0 && deployAgeMs != null && deployAgeMs > window) {
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
    return { ...base, color: "amber", statusText: "no heartbeat yet — awaiting first run", violation: null };
  }
  const stale = ageMs(latest.ran_at) > (loop.livenessWindowMs ?? 26 * 60 * 60_000);
  if (stale) {
    return { ...base, color: "red", statusText: `hasn't run in ${elapsed(latest.ran_at)} (expected ${loop.expectedCadence})`, violation: { reason: "cron_freshness", detail: `Cron ${loop.id} hasn't run in ${elapsed(latest.ran_at)} (expected ${loop.expectedCadence}; last beat ${latest.ran_at}).` } };
  }
  if (!latest.ok) {
    // P1 surfaces a not-ok beat as amber; the output-assertion (false-success)
    // layer that pages on it is Phase 2.
    return { ...base, color: "amber", statusText: `last run reported not-ok (${elapsed(latest.ran_at)} ago)`, violation: null };
  }
  return { ...base, color: "green", statusText: `ran ${elapsed(latest.ran_at)} ago`, violation: null };
}

function evalAgentKind(loop: MonitoredLoop, latest: LoopHistoryRow | null, activeJobs: ActiveJob[]): Omit<LoopStatus, "history" | "openAlert" | "owner"> {
  const mine = activeJobs.filter((j) => j.kind === loop.agentKind);
  const threshold = loop.stuckThresholdMs ?? 60 * 60_000;
  const stuck = mine.filter((j) => ageMs(jobStuckSince(j)) > threshold);
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
    const oldest = stuck.reduce((a, b) => (ageMs(jobStuckSince(a)) > ageMs(jobStuckSince(b)) ? a : b));
    return {
      ...base,
      color: "red",
      statusText: `${stuck.length} job${stuck.length === 1 ? "" : "s"} stuck (oldest ${elapsed(jobStuckSince(oldest))})`,
      violation: { reason: "stuck_jobs", detail: `${stuck.length} ${loop.agentKind} job(s) stuck in ${stuck[0].status} past ${Math.round(threshold / 60_000)}m (oldest ${elapsed(jobStuckSince(oldest))}, job ${oldest.id.slice(0, 8)}).` },
    };
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

/** Per-inline-agent window state: upstream work + ok/errored beat counts + latest/history. */
interface InlineAgentState {
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

function evalInlineAgent(loop: MonitoredLoop, state: InlineAgentState | undefined): Omit<LoopStatus, "history" | "openAlert" | "owner"> {
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
            const { count } = await admin
              .from("tickets")
              .select("id", { count: "exact", head: true })
              .eq("status", "closed")
              .contains("tags", ["ai"])
              .is("last_analyzed_at", null)
              .gte("updated_at", sinceIso);
            return count ?? 0;
          }
          case "journeys-awaiting-delivery": {
            const { count } = await admin
              .from("journey_sessions")
              .select("id", { count: "exact", head: true })
              .gte("created_at", sinceIso);
            return count ?? 0;
          }
          case "orders-awaiting-fraud-screen": {
            const { count } = await admin
              .from("orders")
              .select("id", { count: "exact", head: true })
              .gte("created_at", sinceIso);
            return count ?? 0;
          }
          case "tickets-awaiting-decision": {
            // Inbound customer messages in-window — every one fires unified-ticket-handler →
            // callSonnetOrchestratorV2. Inbound traffic with 0 successful decision beats means
            // the per-ticket decision agent went silent (couldn't reply or act on anyone).
            const { count } = await admin
              .from("ticket_messages")
              .select("id", { count: "exact", head: true })
              .eq("direction", "inbound")
              .eq("author_type", "customer")
              .gte("created_at", sinceIso);
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
  /** most-recent triage-escalations agent_jobs.created_at (any status), or null. */
  latestTriageJobAt: string | null;
  /** most-recent spec-test agent_jobs.created_at (any status), or null. */
  latestSpecTestJobAt: string | null;
  /** active internal subs whose next_billing_date is already in the past (overdue). */
  overdueInternalSubs: number;
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
 * holds — leave the Phase 1 tile as-is). Pure given (loop, latest beat, inputs).
 */
function evalOutputAssertion(
  loop: MonitoredLoop,
  latest: LoopHistoryRow | null,
  inputs: AssertionInputs,
): { statusText: string; violation: { reason: string; detail: string } } | null {
  switch (loop.outputAssertion) {
    case "escalation-idle": {
      // Idle-while-work: tickets wait but no triage job enqueued within the cadence.
      if (inputs.escalatedWaiting <= 0) return null;
      const windowMs = loop.livenessWindowMs ?? 2 * 60 * 60_000;
      const enqueuedRecently = inputs.latestTriageJobAt != null && ageMs(inputs.latestTriageJobAt) <= windowMs;
      if (enqueuedRecently) return null;
      const n = inputs.escalatedWaiting;
      return {
        statusText: `idle while ${n} ticket${n === 1 ? "" : "s"} wait${n === 1 ? "s" : ""}`,
        violation: {
          reason: "idle_while_work",
          detail: `Escalation triage idle while ${n} routine-escalated ticket${n === 1 ? "" : "s"} wait — no triage-escalations job enqueued in the last ${Math.round(windowMs / 60_000)}m (last enqueue ${elapsed(inputs.latestTriageJobAt)} ago).`,
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
    default:
      return null;
  }
}

/** READ-ONLY: fetch the extra state the Phase 2 output assertions evaluate against. */
async function fetchAssertionInputs(admin: Admin): Promise<AssertionInputs> {
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  const [escalated, triageJob, specTestJob, overdueSubs] = await Promise.all([
    // Routine-owned escalated tickets still open — mirrors triage-escalations-cron's query.
    admin
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .not("escalated_at", "is", null)
      .is("escalated_to", null)
      .not("status", "in", '("archived","closed")'),
    admin.from("agent_jobs").select("created_at").eq("kind", "triage-escalations").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("agent_jobs").select("created_at").eq("kind", "spec-test").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    // Overdue = strictly before today 00:00 UTC ⇒ a full renewal window has passed
    // (no false positive on a sub merely due today that the async attempt hasn't processed yet).
    admin
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("is_internal", true)
      .eq("status", "active")
      .lt("next_billing_date", startOfToday.toISOString()),
  ]);

  return {
    escalatedWaiting: escalated.count ?? 0,
    latestTriageJobAt: (triageJob.data as { created_at: string } | null)?.created_at ?? null,
    latestSpecTestJobAt: (specTestJob.data as { created_at: string } | null)?.created_at ?? null,
    overdueInternalSubs: overdueSubs.count ?? 0,
  };
}

/** READ-ONLY: evaluate every registered loop → tiles. Used by the dashboard + the monitor. */
export async function buildControlTowerSnapshot(adminClient?: Admin): Promise<ControlTowerSnapshot> {
  const admin = adminClient ?? createAdminClient();

  const [{ data: workerRow }, { data: beats, error: beatsError }, { data: openAlerts }, { data: jobs }, assertionInputs, inlineState, selfAudit] = await Promise.all([
    admin.from("worker_heartbeats").select("running_sha, status, active_builds, detail, last_poll_at, started_at").eq("id", WORKER_BOX_ID).maybeSingle(),
    // ONE bounded, index-friendly grouped read (control-tower-monitor-accuracy P1): the latest
    // HISTORY_LIMIT beats PER loop_id + the all-time beat count, for cron + agent-kind loops only.
    // Replaces the old global "latest 600 beats, order by ran_at desc" window, which (a) crowded a
    // low-frequency cron's latest beat out → false `never_fired`, and (b) had no single-column index
    // to ride → 500-ing GET /rest/v1/loop_heartbeats as the table grew. Inline-agent/reactive beats
    // are high-volume and excluded here — they get latest + history + ok/err counts from
    // fetchInlineAgentState below. Rides the existing (loop_id, ran_at desc) index.
    admin.rpc("control_tower_loop_beats", { p_history_limit: HISTORY_LIMIT }),
    admin.from("loop_alerts").select("id, loop_id, reason, detail, opened_at, last_seen_at").eq("status", "open"),
    admin.from("agent_jobs").select("id, kind, status, created_at, claimed_at, updated_at").in("status", ["queued", "claimed", "building", "queued_resume"]),
    fetchAssertionInputs(admin),
    fetchInlineAgentState(admin),
    buildCoverageAudit(),
  ]);

  // Trustworthy deploy-age reference for the never-fired cron check (evalCron).
  const deployAgeMs = deployRefAgeMs(workerRow as WorkerRow | null);

  // Did the all-time beats read itself fail? The control_tower_loop_beats RPC can 500 under a
  // statement timeout (sig loop:meta-capi-dispatch-cron). On error Supabase returns data=null, so
  // byLoop/countByLoop collapse to empty and EVERY cron looks like everBeatCount=0/latest=null —
  // false-firing never_fired/cron_freshness reds and paging owners on healthy loops. When the read
  // failed we keep crons conservative (amber), the same way deployAgeMs==null keeps a missing
  // deploy-age reference from false-alarming. (control-tower-beats-read-failure-guard P1.)
  const beatsReadFailed = beatsError != null;

  // Group heartbeats by loop_id (the RPC returns them ordered by loop_id, rn=newest-first, already
  // capped at HISTORY_LIMIT per loop) and capture the all-time beat count for the never-fired check.
  // A loop with zero beats returns NO rows → absent from both maps → countByLoop default 0.
  const byLoop = new Map<string, LoopHistoryRow[]>();
  const countByLoop = new Map<string, number>();
  for (const b of (beats ?? []) as Array<LoopHistoryRow & { loop_id: string; total_count: number }>) {
    const arr = byLoop.get(b.loop_id) ?? [];
    arr.push({ ran_at: b.ran_at, ok: b.ok, produced: b.produced, detail: b.detail, duration_ms: b.duration_ms });
    byLoop.set(b.loop_id, arr);
    countByLoop.set(b.loop_id, Number(b.total_count));
  }
  const alertByLoop = new Map<string, OpenAlert>();
  for (const a of (openAlerts ?? []) as Array<OpenAlert & { loop_id: string }>) {
    alertByLoop.set(a.loop_id, { id: a.id, reason: a.reason, detail: a.detail, opened_at: a.opened_at, last_seen_at: a.last_seen_at });
  }
  const activeJobs = (jobs ?? []) as ActiveJob[];

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
    if (loop.kind === "worker") core = evalWorker(loop, workerRow as WorkerRow | null);
    else if (loop.kind === "cron") core = evalCron(loop, latest, deployAgeMs, countByLoop.get(loop.id) ?? 0, beatsReadFailed);
    else core = evalAgentKind(loop, latest, activeJobs);
    // Phase 2: layer the output assertion on top. Only escalates green/amber → red
    // (a P1 red — silent/stale/stuck — is the higher-priority violation; keep it).
    if (loop.outputAssertion && core.color !== "red") {
      const a = evalOutputAssertion(loop, latest, assertionInputs);
      if (a) core = { ...core, color: "red", statusText: a.statusText, violation: a.violation };
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

/** Evaluate + act: open de-duped alerts on red loops (paging on first sight), auto-resolve on recovery. */
export async function runControlTowerMonitor(): Promise<MonitorResult> {
  const admin = createAdminClient();
  const snap = await buildControlTowerSnapshot(admin);

  // Self-audit findings are amber (surfaced on the dashboard + folded into counts), not a page —
  // but log them so a coverage gap is greppable in the cron's run output too.
  if (snap.selfAudit.unregistered.length) {
    console.warn(`[control-tower] self-audit: ${snap.selfAudit.unregistered.length} unregistered cron(s) in code with no tile: ${snap.selfAudit.unregistered.map((u) => u.id).join(", ")}`);
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
