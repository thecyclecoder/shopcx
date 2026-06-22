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

  const loops: LoopStatus[] = MONITORED_LOOPS.map((loop) => {
    const history = byLoop.get(loop.id) ?? [];
    const latest = history[0] ?? null;
    let core: Omit<LoopStatus, "history" | "openAlert">;
    if (loop.kind === "worker") core = evalWorker(loop, workerRow as WorkerRow | null);
    else if (loop.kind === "cron") core = evalCron(loop, latest);
    else core = evalAgentKind(loop, latest, activeJobs);
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
