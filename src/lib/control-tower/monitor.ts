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
 *   - LIVENESS (worker)        — last_poll_at fresh + running_sha not behind origin/main too long.
 *   - CRON FRESHNESS (cron)    — a heartbeat within the loop's window.
 *   - STUCK JOBS (agent)       — no agent_jobs queued/building past the per-kind threshold.
 *   - INLINE AGENT (inline)    — over a rolling window: (a) silent-while-work-exists (upstream
 *                                demand existed but 0 successful runs) and (b) error-rate spike
 *                                (too many errored runs / N consecutive failures).
 * Healthy / genuinely-idle loops are GREEN — assertions never false-positive on a
 * fine-but-quiet loop (no escalations to triage, no builds queued, no tickets to QC = green).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyOpsAlert } from "@/lib/notify-ops-alert";
import {
  MONITORED_LOOPS,
  WORKER_BOX_ID,
  type LoopKind,
  type MonitoredLoop,
} from "@/lib/control-tower/registry";

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

export interface ControlTowerSnapshot {
  generatedAt: string;
  counts: { green: number; amber: number; red: number };
  loops: LoopStatus[];
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

function evalWorker(loop: MonitoredLoop, row: WorkerRow | null): Omit<LoopStatus, "history" | "openAlert"> {
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
  if (behind) {
    return { ...base, color: "amber", statusText: `updating — running ${running}, deployed ${deployed.slice(0, 7)}`, detail: row.detail ?? null, violation: null };
  }
  return { ...base, color: "green", statusText: `healthy · ${running || "?"} · last poll ${elapsed(row.last_poll_at)} ago`, detail: row.detail ?? null, violation: null };
}

function evalCron(loop: MonitoredLoop, latest: LoopHistoryRow | null): Omit<LoopStatus, "history" | "openAlert"> {
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
  // No beat yet ⇒ amber (awaiting first run), never red — so a freshly-shipped
  // cron doesn't false-alarm before its first scheduled tick.
  if (!latest) {
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

function evalAgentKind(loop: MonitoredLoop, latest: LoopHistoryRow | null, activeJobs: ActiveJob[]): Omit<LoopStatus, "history" | "openAlert"> {
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

/** Per-inline-agent window data: recent history, the window's beats, + upstream work count. */
interface InlineAgentData {
  history: LoopHistoryRow[];   // last ≤10 all-time, newest-first
  windowBeats: LoopHistoryRow[]; // beats within the loop's window, newest-first
  workCount: number;            // upstream demand that existed in the window
}

function windowLabel(ms: number | undefined): string {
  const h = Math.round((ms ?? 2 * 60 * 60_000) / 60_000 / 60);
  return h <= 1 ? "1h" : `${h}h`;
}

/**
 * Inline AI agents have no fixed cadence — they fire per ticket / order. Two
 * assertions over the rolling window, with idle staying GREEN:
 *   (a) liveness-when-work-exists — upstream work existed but 0 successful runs;
 *   (b) error-rate — errored/total over threshold, or N consecutive failures.
 */
function evalInlineAgent(loop: MonitoredLoop, data: InlineAgentData): Omit<LoopStatus, "history" | "openAlert"> {
  const { history, windowBeats, workCount } = data;
  const latest = history[0] ?? null;
  // Show the last *real* output (most recent ok beat with produced), not a skip/null.
  const lastProduced = history.find((h) => h.ok && h.produced != null)?.produced ?? latest?.produced ?? null;
  const base = {
    id: loop.id,
    kind: loop.kind,
    label: loop.label,
    description: loop.description,
    expectedCadence: loop.expectedCadence,
    lastRanAt: latest?.ran_at ?? null,
    lastProduced,
    detail: latest?.detail ?? null,
  };

  const total = windowBeats.length;
  const success = windowBeats.filter((b) => b.ok).length;
  const errored = total - success;
  const win = windowLabel(loop.windowMs);

  // (a) Liveness-when-work-exists: demand existed but nothing succeeded → silent death.
  if (workCount > 0 && success === 0) {
    return {
      ...base,
      color: "red",
      statusText: `silent while ${workCount} awaited (0 successful runs in ${win})`,
      violation: {
        reason: "inline_agent_silent",
        detail: `${loop.label} silent: ${workCount} item(s) awaited it in the last ${win} but it produced 0 successful runs${total ? ` (${errored} errored)` : " (no runs at all)"}.`,
      },
    };
  }

  // (b) Error-rate: too many errored runs, or a run of consecutive failures.
  let consecutive = 0;
  for (const b of windowBeats) {
    if (!b.ok) consecutive++;
    else break;
  }
  const minSample = loop.errorRateMinSample ?? 4;
  const threshold = loop.errorRateThreshold ?? 0.5;
  const consecLimit = loop.consecutiveFailureLimit ?? 5;
  const rate = total > 0 ? errored / total : 0;
  const rateTripped = total >= minSample && rate > threshold;
  const consecTripped = consecutive >= consecLimit;
  if (rateTripped || consecTripped) {
    const why = consecTripped ? `${consecutive} consecutive failures` : `${Math.round(rate * 100)}% errored`;
    return {
      ...base,
      color: "red",
      statusText: `failing — ${errored}/${total} runs errored in ${win}`,
      violation: {
        reason: "inline_agent_error_rate",
        detail: `${loop.label} failing: ${errored}/${total} runs errored in the last ${win} (${why}) — running but producing nothing useful.`,
      },
    };
  }

  // Genuinely-idle (no runs, no work) or healthy = green.
  if (total === 0) {
    return { ...base, color: "green", statusText: latest ? `idle · last ran ${elapsed(latest.ran_at)} ago` : "idle · never run", violation: null };
  }
  return { ...base, color: "green", statusText: `healthy · ${success}/${total} ok in ${win} · last ran ${elapsed(latest?.ran_at)} ago`, violation: null };
}

/** Count the upstream demand that existed in the window for an inline agent's work signal. */
async function countInlineWork(admin: Admin, signal: MonitoredLoop["workSignal"], sinceIso: string): Promise<number> {
  if (signal === "closed-ai-tickets") {
    // Closed AI tickets updated in the window that haven't been analyzed since
    // their last update — the exact "awaiting QC" backlog the cron drains. (Column-
    // to-column compare isn't supported in PostgREST, so filter in JS — same as
    // ticket-analysis-cron.)
    const { data } = await admin
      .from("tickets")
      .select("id, last_analyzed_at, updated_at")
      .eq("status", "closed")
      .contains("tags", ["ai"])
      .gte("updated_at", sinceIso)
      .limit(300);
    return (data ?? []).filter(
      (t: { last_analyzed_at: string | null; updated_at: string | null }) =>
        !t.last_analyzed_at || (t.updated_at != null && new Date(t.last_analyzed_at) < new Date(t.updated_at)),
    ).length;
  }
  if (signal === "journey-sessions") {
    // Journey sessions created in the window — each represents a journey that was
    // "queued" for delivery (the row is inserted before the channel send).
    const { count } = await admin
      .from("journey_sessions")
      .select("id", { count: "exact", head: true })
      .gte("created_at", sinceIso);
    return count ?? 0;
  }
  if (signal === "web-orders") {
    // Web-checkout orders created in the window — exactly what gets fraud-screened.
    const { count } = await admin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("source_name", "web")
      .gte("created_at", sinceIso);
    return count ?? 0;
  }
  return 0;
}

/** Fetch each inline agent's history + window beats + upstream work count (dedicated, high-volume safe). */
async function fetchInlineAgentData(admin: Admin, loops: MonitoredLoop[]): Promise<Map<string, InlineAgentData>> {
  const now = Date.now();
  const out = new Map<string, InlineAgentData>();
  await Promise.all(
    loops.map(async (loop) => {
      const sinceIso = new Date(now - (loop.windowMs ?? 2 * 60 * 60_000)).toISOString();
      const [historyRes, windowRes, workCount] = await Promise.all([
        admin
          .from("loop_heartbeats")
          .select("ran_at, ok, produced, detail, duration_ms")
          .eq("loop_id", loop.id)
          .order("ran_at", { ascending: false })
          .limit(HISTORY_LIMIT),
        admin
          .from("loop_heartbeats")
          .select("ran_at, ok, produced, detail, duration_ms")
          .eq("loop_id", loop.id)
          .gte("ran_at", sinceIso)
          .order("ran_at", { ascending: false })
          .limit(300),
        countInlineWork(admin, loop.workSignal, sinceIso),
      ]);
      out.set(loop.id, {
        history: (historyRes.data ?? []) as LoopHistoryRow[],
        windowBeats: (windowRes.data ?? []) as LoopHistoryRow[],
        workCount,
      });
    }),
  );
  return out;
}

/** READ-ONLY: evaluate every registered loop → tiles. Used by the dashboard + the monitor. */
export async function buildControlTowerSnapshot(adminClient?: Admin): Promise<ControlTowerSnapshot> {
  const admin = adminClient ?? createAdminClient();

  const [{ data: workerRow }, { data: beats }, { data: openAlerts }, { data: jobs }] = await Promise.all([
    admin.from("worker_heartbeats").select("running_sha, status, active_builds, detail, last_poll_at, started_at").eq("id", WORKER_BOX_ID).maybeSingle(),
    admin.from("loop_heartbeats").select("loop_id, ran_at, ok, produced, detail, duration_ms").order("ran_at", { ascending: false }).limit(600),
    admin.from("loop_alerts").select("id, loop_id, reason, detail, opened_at, last_seen_at").eq("status", "open"),
    admin.from("agent_jobs").select("id, kind, status, created_at, claimed_at, updated_at").in("status", ["queued", "claimed", "building", "queued_resume"]),
  ]);

  // Group heartbeats by loop_id (already newest-first).
  const byLoop = new Map<string, LoopHistoryRow[]>();
  for (const b of (beats ?? []) as Array<LoopHistoryRow & { loop_id: string }>) {
    const arr = byLoop.get(b.loop_id) ?? [];
    if (arr.length < HISTORY_LIMIT) {
      arr.push({ ran_at: b.ran_at, ok: b.ok, produced: b.produced, detail: b.detail, duration_ms: b.duration_ms });
      byLoop.set(b.loop_id, arr);
    }
  }
  const alertByLoop = new Map<string, OpenAlert>();
  for (const a of (openAlerts ?? []) as Array<OpenAlert & { loop_id: string }>) {
    alertByLoop.set(a.loop_id, { id: a.id, reason: a.reason, detail: a.detail, opened_at: a.opened_at, last_seen_at: a.last_seen_at });
  }
  const activeJobs = (jobs ?? []) as ActiveJob[];

  // Inline agents fire per ticket/order (high volume) — fetch their beats +
  // upstream work counts in dedicated queries so a busy agent can't starve the
  // shared 600-beat pull above (and vice versa).
  const inlineData = await fetchInlineAgentData(
    admin,
    MONITORED_LOOPS.filter((l) => l.kind === "inline-agent"),
  );

  const loops: LoopStatus[] = MONITORED_LOOPS.map((loop) => {
    let core: Omit<LoopStatus, "history" | "openAlert">;
    let history: LoopHistoryRow[];
    if (loop.kind === "inline-agent") {
      const data = inlineData.get(loop.id) ?? { history: [], windowBeats: [], workCount: 0 };
      history = data.history;
      core = evalInlineAgent(loop, data);
    } else {
      history = byLoop.get(loop.id) ?? [];
      const latest = history[0] ?? null;
      if (loop.kind === "worker") core = evalWorker(loop, workerRow as WorkerRow | null);
      else if (loop.kind === "cron") core = evalCron(loop, latest);
      else core = evalAgentKind(loop, latest, activeJobs);
    }
    return { ...core, history, openAlert: alertByLoop.get(loop.id) ?? null };
  });

  const counts = { green: 0, amber: 0, red: 0 };
  for (const l of loops) counts[l.color]++;

  return { generatedAt: new Date().toISOString(), counts, loops };
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
