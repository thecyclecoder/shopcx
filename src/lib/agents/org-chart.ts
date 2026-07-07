/**
 * Org-chart reader (agents-hub-role-inboxes spec, Phase 1; agent-roster-sync spec, Phases 1–2).
 *
 * Builds the CEO → Directors → Workers tree the Agents hub renders, read entirely
 * from the brain — NO hand-maintained second copy of the org chart (operational-
 * rules: brain is the source of truth, no drift):
 *   - Directors = the `functions/*.md` cards via brain-roadmap `getFunctions()`.
 *   - Each director's mandates + owned/contributed goals come straight from that card.
 *   - The CEO seat carries the finite `goals/*.md` (via `getGoals()`).
 *   - Workers = the RECONCILED roster (agent-roster-sync) of three sources, so the org
 *     view reflects 100% of running agents (the goal's success metric — no hidden agents):
 *       1. the `agent-kind` MONITORED_LOOPS (the box `agent_jobs` queue lanes),
 *       2. the persona-backed `cron` MONITORED_LOOPS (a `personaKind` — e.g.
 *          `control-tower-monitor`→Tao, the two `db-health-*` crons→Devi), and
 *       3. any live `agent_jobs.kind` with recent rows but no registry row (e.g.
 *          `coverage-register`→Cole) — flagged, never silently dropped.
 *     Each worker carries a LIVE status (active · idle-healthy · inactive) from
 *     `agent_jobs` recency + `loop_heartbeats` beats — an honest projection of what's
 *     actually running, with the never-fired ones (e.g. Remi/regression) flagged.
 *
 * Server-only (brain-roadmap reads the bundled fs copy at request time + this now reads
 * agent_jobs/loop_heartbeats via the service role). Surfaced by GET /api/developer/agents →
 * /dashboard/agents. See docs/brain/dashboard/agents.md.
 */
import { getFunctions, getGoals, functionLabel, type GoalStatus } from "@/lib/brain-roadmap";
import { MONITORED_LOOPS, agentLoopId, type MonitoredLoop } from "@/lib/control-tower/registry";
import { getPersona } from "@/lib/agents/personas";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadAutonomyMap, isAutoApprover, type AutonomyMap } from "@/lib/agents/approval-router";

/** Live liveness of a rostered agent (agent-roster-sync Phase 2). */
export type WorkerStatus =
  /** a recent agent_jobs row OR a recent heartbeat — the agent is doing work / beating. */
  | "active"
  /** has fired before (or is a registered, beating cron) but no recent work — idle, not dead. */
  | "idle-healthy"
  /** a persona + lane that has produced ZERO agent_jobs rows ever (e.g. Remi/regression) — never fired. */
  | "inactive";

export interface WorkerLane {
  /** the agent_jobs kind / persona key (box lane, or the persona a cron maps to) */
  kind: string;
  label: string;
  description: string;
  /** Phase 2: live liveness, derived from agent_jobs recency + loop_heartbeats beats. */
  status: WorkerStatus;
  /** one-line why behind `status` (badge tooltip + drift audit). */
  statusReason: string;
  /**
   * Phase 1: true when this lane was UNIONED in from live `agent_jobs` with no MONITORED_LOOPS
   * row (or has no persona entry) — surfaced so it's never hidden, but flagged for registration
   * by the Phase 3 drift audit. A fully-rostered lane is `false`.
   */
  flagged: boolean;
  /** the loop type for the card chip: "agent-kind" | "cron" | "reactive" | "inline-agent" | "" (orphan). */
  loopKind: string;
}

export interface DirectorMandate {
  name: string;
  metric?: string;
  specCount: number;
}

export interface DirectorNode {
  slug: string;
  title: string;
  summary: string;
  mandates: DirectorMandate[];
  goalSlugs: string[];
  workers: WorkerLane[];
  /**
   * Derived from the per-function `function_autonomy` flags (approval-routing-engine M2):
   * live && autonomous ⇒ "autonomous" (an auto-approver — approvals route HERE, then to history);
   * live only ⇒ "live"; neither ⇒ "offline" (approvals route up to the CEO). Seeded all-off, so
   * today every director is "offline" until the owner toggles it on from the Agents hub.
   */
  status: "offline" | "live" | "autonomous";
  /** The raw flags behind `status` — the owner toggles these from the hub. */
  live: boolean;
  autonomous: boolean;
}

export interface OrgChart {
  ceo: {
    /**
     * The finite company goals (goals/*.md). `status` + `proposedBy` surface the director-proposed-goals
     * lifecycle (Phase 2): a `proposed` goal a director authored that AWAITS the CEO's greenlight vs a
     * `greenlit` one the CEO has activated — so the hub shows what each director is proposing vs what's live.
     * `proposedByLabel` is the proposer function's display name (computed server-side; the hub is a client component).
     */
    goals: { slug: string; title: string; pct: number; status: GoalStatus; proposedBy?: string; proposedByLabel?: string }[];
    /**
     * CEO-owned workers rendered UNDER the CEO seat — the founder's own agents that answer directly to
     * her, not to a director (god-mode-becomes-ceo-executive-assistant-agent Phase 2). Today: Eve (the
     * god-mode cockpit executive assistant). Populated from every MONITORED_LOOPS entry with owner="ceo"
     * (via `buildRoster` Step 2's persona-backed reactive branch), with liveness derived from
     * `loop_heartbeats` + the god-mode cockpit's own activity (armed `god_mode_sessions`). Deliberately
     * kept off Ada's roster — the founder's assistant reports to the founder, not to Platform. Every risky
     * action she takes goes through the existing god-mode PIN + risk-tier approvals ([[../god-mode]]),
     * so she does anything the founder asks within his leash + surfaces reasoning inline.
     */
    workers: WorkerLane[];
  };
  directors: DirectorNode[];
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A job/beat within this window ⇒ "active". A daily-beating cron stays inside it. */
const ROSTER_ACTIVE_WINDOW_MS = 7 * DAY;
/**
 * Never-fired grace — mirrors the [[../libraries/control-tower]] `evalCron` registeredAt grace:
 * a lane registered this recently that hasn't fired yet is "awaiting first run" (idle-healthy),
 * NOT inactive. So a freshly-shipped lane is never falsely flagged dead.
 */
const NEVER_FIRED_GRACE_MS = 2 * DAY;

/** Default owner for an unioned orphan lane: the Platform director (Ada) owns the agent fleet. */
const ORPHAN_OWNER = "platform";

/** A director's OWN job kinds — how it "turns on" (its standing pass, its coaching chat, its goal proposals),
 *  NOT agents it supervises. Never rostered as worker cards (the CEO finds them confusing under the director). */
const DIRECTOR_INFRA_KINDS = new Set(["platform-director", "director-coach", "proposed-goal"]);

/** A director's supervisory SWEEP job kinds — a director grading/coaching the layer BELOW it
 *  (`agent-grade`/`agent-coach` = Ada over her platform workers; `director-grade` = the CEO over the
 *  directors' calls; `campaign-grade`/`gap-grade` = Cleo over Growth's work). These are the director's
 *  OWN activity, NOT agents — the same reason the rubric gate rejects them with `not_a_gradeable_worker`
 *  ([[agent-grader]]). They carry no MONITORED_LOOPS row + no persona, so without this they'd fall
 *  through to source 3 and surface as flagged "unregistered" worker cards under Platform. See the
 *  north-star cascade (CEO → director → worker): a supervisor owns the layer below it. */
const DIRECTOR_SWEEP_KINDS = new Set([
  "agent-grade",
  "agent-coach",
  "director-grade",
  "campaign-grade",
  "gap-grade",
]);

/** Internal pre-liveness roster entry — one rostered worker, before its status is computed. */
export interface RosterEntry {
  owner: string;
  kind: string;
  label: string;
  description: string;
  /** loop_heartbeats loop_id(s) whose beats prove this worker is alive. */
  loopIds: string[];
  /** the agent_jobs.kind whose rows prove this worker has fired (null ⇒ pure infra cron). */
  jobKind: string | null;
  /** true ⇒ a registered cron (Control Tower owns its death-detection — never inactive-flag here). */
  cronBacked: boolean;
  /** ISO registration time for the never-fired grace (mirrors evalCron). */
  registeredAt?: string;
  /** unioned from live agent_jobs with no registry row (or no persona) — flagged for registration. */
  flagged: boolean;
  /** the MONITORED_LOOPS loop kind for the type chip: "agent-kind" | "cron" | "reactive" | "inline-agent" | "" (orphan). */
  loopKind: string;
}

/**
 * Reconcile the three roster sources into one de-duped list of rostered workers
 * (agent-roster-sync Phase 1). Pure — takes the brain functions + the set of live
 * agent_jobs kinds and returns who is rostered (no liveness yet). Shared by the org
 * reader AND `scripts/audit-agent-roster.ts` so the drift check measures the SAME roster.
 */
export function buildRoster(directorSlugs: Set<string>, liveKinds: Set<string>): RosterEntry[] {
  const entries: RosterEntry[] = [];
  const seen = new Set<string>(); // global kind de-dup across all three sources

  // 1. agent-kind lanes (the box agent_jobs queue lanes) — as before.
  for (const l of MONITORED_LOOPS) {
    if (l.kind !== "agent-kind" || !l.agentKind) continue;
    const kind = l.agentKind;
    if (seen.has(kind)) continue;
    seen.add(kind);
    entries.push({
      owner: l.owner,
      kind,
      label: l.label,
      description: l.description,
      loopIds: [agentLoopId(kind)],
      jobKind: kind,
      cronBacked: false,
      registeredAt: l.registeredAt,
      flagged: false, // a registered lane — a missing persona is caught by the audit, not a UI chip
      loopKind: "agent-kind",
    });
  }

  // 2. persona-backed crons + reactive lanes (a `personaKind`) — merged by persona key so the
  //    two db-health crons render as ONE Devi worker (loopIds carries both). Reactive lanes with
  //    a personaKind (god-mode-cockpit → Eve, Phase 2 of god-mode-becomes-ceo-executive-assistant-
  //    agent) go through the same branch: the founder's cockpit is event-driven, but it still
  //    surfaces a live persona under the CEO seat with beats-based liveness.
  const byPersona = new Map<string, MonitoredLoop[]>();
  for (const l of MONITORED_LOOPS) {
    if ((l.kind === "cron" || l.kind === "reactive") && l.personaKind) {
      const arr = byPersona.get(l.personaKind) ?? [];
      arr.push(l);
      byPersona.set(l.personaKind, arr);
    }
  }
  for (const [pk, loops] of byPersona) {
    if (seen.has(pk)) continue;
    seen.add(pk);
    const persona = getPersona(pk);
    // latest registeredAt among the merged crons (lenient grace).
    const registeredAt = loops
      .map((l) => l.registeredAt)
      .filter((x): x is string => !!x)
      .sort()
      .at(-1);
    entries.push({
      owner: loops[0].owner,
      kind: pk,
      label: persona.role,
      description: persona.personality,
      loopIds: loops.map((l) => l.id),
      jobKind: pk, // also counts agent_jobs of this kind (0 for a pure cron like monitor)
      cronBacked: true,
      registeredAt,
      flagged: false, // a registered cron — drift is the audit's job, not a UI chip
      loopKind: loops[0].kind, // "cron" | "reactive" | "inline-agent" — the type chip
    });
  }

  // 3. union live agent_jobs.kind with no registry row + not already rostered — surfaced
  //    (flagged), never silently dropped. coverage-register → Cole; a future un-registered
  //    lane shows under Platform until the drift audit gets it a proper registry/persona row.
  const registeredAgentKinds = new Set(
    MONITORED_LOOPS.filter((l) => l.agentKind).map((l) => l.agentKind as string),
  );
  for (const kind of liveKinds) {
    if (seen.has(kind)) continue;
    if (registeredAgentKinds.has(kind)) continue; // an agent-kind lane (rostered in step 1)
    if (DIRECTOR_INFRA_KINDS.has(kind)) continue; // the director's own "turn on" mechanisms — not worker cards
    if (DIRECTOR_SWEEP_KINDS.has(kind)) continue; // a director grading/coaching the layer below it — not a worker
    seen.add(kind);
    const persona = getPersona(kind);
    entries.push({
      owner: ORPHAN_OWNER,
      kind,
      label: persona.role,
      description: persona.personality,
      loopIds: [agentLoopId(kind)],
      jobKind: kind,
      cronBacked: false,
      flagged: true, // a live lane with no MONITORED_LOOPS row is drift — always flag it
      loopKind: "",
    });
  }

  // Defensive: drop an entry whose owner isn't a known director (every MONITORED_LOOPS.owner is).
  return entries.filter((e) => directorSlugs.has(e.owner));
}

/** live && autonomous ⇒ "autonomous"; live only ⇒ "live"; else "offline" (routes to CEO). */
function statusFor(slug: string, autonomy: AutonomyMap): DirectorNode["status"] {
  if (isAutoApprover(slug, autonomy)) return "autonomous";
  return autonomy[slug]?.live ? "live" : "offline";
}

type Admin = ReturnType<typeof createAdminClient>;

/** Safe head-count (returns 0 on any error — the roster never breaks the dashboard). */
async function headCount(q: PromiseLike<{ count: number | null }>): Promise<number> {
  try {
    const { count } = await q;
    return count ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Compute one rostered worker's live status (agent-roster-sync Phase 2) from agent_jobs
 * recency + loop_heartbeats beats. Never false-flags an idle-but-healthy or freshly-shipped
 * lane (the grace mirrors evalCron's never-fired grace).
 */
export async function computeWorkerStatus(
  entry: RosterEntry,
  admin: Admin,
  sinceIso: string,
  nowMs: number,
): Promise<{ status: WorkerStatus; reason: string }> {
  // Phase 2 (god-mode-becomes-ceo-executive-assistant-agent): Eve's liveness is derived from
  // the god-mode cockpit's own activity — an ARMED god_mode_sessions row means she's live
  // right now, even before any explicit `agent:god-mode`-style heartbeat has landed. This runs
  // BEFORE the generic beats/jobs check because god-mode is a founder cockpit (not an
  // `agent_jobs` queue lane), so the standard signals would otherwise register her as always
  // idle. Defensive read (try/catch, no throw) — an unreadable god_mode_sessions table falls
  // through to the normal signals so the roster can never break the dashboard.
  if (entry.kind === "god-mode") {
    try {
      const { data } = await admin
        .from("god_mode_sessions")
        .select("status,last_activity_at")
        .order("last_activity_at", { ascending: false })
        .limit(1);
      const row = (data ?? [])[0] as { status: string | null; last_activity_at: string | null } | undefined;
      if (row?.status === "armed") return { status: "active", reason: "cockpit armed" };
      if (row?.last_activity_at && row.last_activity_at >= sinceIso) {
        return { status: "active", reason: "recent cockpit session" };
      }
      if (row) return { status: "idle-healthy", reason: "cockpit disarmed — awaiting founder" };
    } catch {
      // fall through to the normal signals below
    }
  }
  const [recentBeat, everJob, recentJob] = await Promise.all([
    entry.loopIds.length
      ? headCount(
          admin
            .from("loop_heartbeats")
            .select("id", { count: "exact", head: true })
            .in("loop_id", entry.loopIds)
            .gte("ran_at", sinceIso),
        )
      : Promise.resolve(0),
    entry.jobKind
      ? headCount(admin.from("agent_jobs").select("id", { count: "exact", head: true }).eq("kind", entry.jobKind))
      : Promise.resolve(0),
    entry.jobKind
      ? headCount(
          admin
            .from("agent_jobs")
            .select("id", { count: "exact", head: true })
            .eq("kind", entry.jobKind)
            .gte("created_at", sinceIso),
        )
      : Promise.resolve(0),
  ]);

  if (recentJob > 0 || recentBeat > 0) {
    return { status: "active", reason: recentJob > 0 ? "recent job" : "beating" };
  }
  if (everJob > 0) {
    return { status: "idle-healthy", reason: "ran before — idle now" };
  }
  // No recent activity AND zero jobs ever.
  if (entry.cronBacked) {
    // A registered cron — the Control Tower owns its death-detection; don't death-flag here.
    return { status: "idle-healthy", reason: "registered cron — awaiting a beat" };
  }
  if (entry.registeredAt && nowMs - Date.parse(entry.registeredAt) < NEVER_FIRED_GRACE_MS) {
    return { status: "idle-healthy", reason: "freshly registered — awaiting first run" };
  }
  return { status: "inactive", reason: "never fired — 0 jobs in all history" };
}

export async function getOrgChart(): Promise<OrgChart> {
  const [functions, goals, autonomy] = await Promise.all([getFunctions(), getGoals(), loadAutonomyMap()]);

  const admin = createAdminClient();
  const nowMs = Date.now();
  const sinceIso = new Date(nowMs - ROSTER_ACTIVE_WINDOW_MS).toISOString();

  // The set of agent_jobs kinds with recent rows — the union source (Phase 1, source 3).
  const liveKinds = new Set<string>();
  try {
    const { data } = await admin.from("agent_jobs").select("kind").gte("created_at", sinceIso).limit(5000);
    for (const r of (data ?? []) as { kind: string | null }[]) if (r.kind) liveKinds.add(r.kind);
  } catch {
    // a failed read just means no unioned lanes this tick — the registry roster still renders.
  }

  const directorSlugs = new Set(functions.map((fn) => fn.slug));
  const roster = buildRoster(directorSlugs, liveKinds);
  const statuses = await Promise.all(roster.map((e) => computeWorkerStatus(e, admin, sinceIso, nowMs)));

  const workersByFn = new Map<string, WorkerLane[]>();
  roster.forEach((e, i) => {
    const arr = workersByFn.get(e.owner) ?? [];
    arr.push({
      kind: e.kind,
      label: e.label,
      description: e.description,
      status: statuses[i].status,
      statusReason: statuses[i].reason,
      flagged: e.flagged,
      loopKind: e.loopKind,
    });
    workersByFn.set(e.owner, arr);
  });

  // Exclude the `ceo` function card — Henry is rendered as the top CEO seat (below),
  // so including it here duplicated him into the directors row.
  const directors: DirectorNode[] = functions.filter((fn) => fn.slug !== "ceo").map((fn) => ({
    slug: fn.slug,
    title: fn.title,
    summary: fn.summary,
    mandates: fn.mandates.map((m) => ({ name: m.name, metric: m.metric, specCount: m.specSlugs.length })),
    goalSlugs: fn.goalSlugs,
    workers: workersByFn.get(fn.slug) ?? [],
    status: statusFor(fn.slug, autonomy),
    live: autonomy[fn.slug]?.live ?? false,
    autonomous: autonomy[fn.slug]?.autonomous ?? false,
  }));

  return {
    ceo: {
      goals: goals.map((g) => ({
        slug: g.slug,
        title: g.title,
        pct: g.pct,
        status: g.status,
        proposedBy: g.proposedBy,
        proposedByLabel: g.proposedBy ? functionLabel(g.proposedBy) : undefined,
      })),
      // Phase 2: CEO-owned workers rendered under the CEO seat alongside the goals — the
      // founder's own agents (Eve today, via god-mode-cockpit). Pulled from the SAME roster
      // the directors' workers came from, so a lane can never be double-rendered (a worker
      // is placed under EXACTLY ONE seat — under the CEO if owner="ceo", else under its
      // owning director). This is why she is not shown under Ada.
      workers: workersByFn.get("ceo") ?? [],
    },
    directors,
  };
}
