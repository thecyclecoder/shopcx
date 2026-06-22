/**
 * Control Tower — the loop registry (control-tower spec, Phase 1).
 *
 * The single code-config source of truth for every autonomous loop the
 * control-tower-monitor watches. Each loop declares its cadence + the staleness
 * window past which silence is a violation. The monitor and the dashboard both
 * read this list — add a row here when you ship a new cron / worker / agent-kind
 * (operational-rules: "register-or-it's-incomplete").
 *
 * Three loop kinds:
 *   - worker     — the box build worker. Liveness = worker_heartbeats.last_poll_at
 *                  fresh + running_sha not behind origin/main for too long. (One row.)
 *   - cron       — an Inngest cron. Freshness = a loop_heartbeats beat (loop_id =
 *                  the inngest function id) within `livenessWindowMs`.
 *   - agent-kind — a box agent_jobs lane. NOT alerted on idle (a genuinely-idle
 *                  lane is healthy/green); alerted only when a job is STUCK
 *                  (queued/building past `stuckThresholdMs`). Its heartbeats
 *                  (loop_id = `agent:<kind>`) feed last-ran / history on the tile.
 *   - inline-agent — a server-side, event-driven AI agent that runs per-ticket /
 *                  per-order / per-journey (NOT on a queue or a cron). No fixed
 *                  cadence, so a genuinely-idle agent (no work waiting) is GREEN.
 *                  Each beats once at the END of every run (loop_id = `ai:<agent>`,
 *                  try/finally — ok:true on success, ok:false on throw). Alerted on
 *                  (a) liveness-when-work-exists — upstream work waits in the window
 *                  but 0 SUCCESSFUL beats — or (b) error-rate — errored beats over
 *                  the window past `errorRateThreshold`. (control-tower-agent-coverage spec.)
 */

export type LoopKind = "worker" | "cron" | "agent-kind" | "inline-agent";

/**
 * Phase 2 output-assertion id. Phase 1 catches "the loop went SILENT" (liveness /
 * cron-freshness / stuck-jobs). An output assertion catches the Goodhart failure
 * Phase 1 can't see: the loop RAN (fresh heartbeat, green on P1) but silently did
 * nothing or the wrong thing. The monitor runs the named read-only state-check and
 * flips the tile RED (opening a de-duped alert + paging) when it fails. Absent ⇒
 * the loop has only the Phase 1 checks. Implemented in monitor.ts → evalOutputAssertion.
 *
 *   - escalation-idle    — routine-escalated tickets wait but no triage-escalations
 *                          job was enqueued within the cadence (the 3h-ticket gap).
 *   - spec-test-persisted — the latest beat reports enqueued>0 but 0 spec-test
 *                          agent_jobs actually landed (produced-but-not-persisted).
 *   - renewal-integrity  — active internal subs are overdue (next_billing_date in
 *                          the past) — the renewal cron ran but didn't advance them.
 */
export type OutputAssertionId = "escalation-idle" | "spec-test-persisted" | "renewal-integrity";

/**
 * Inline-agent work-exists probe id (control-tower-agent-coverage spec, Phase 1). Each
 * names a READ-ONLY, INDEPENDENT upstream-demand count the monitor evaluates: "is there
 * work that should have driven this agent in its window?". The liveness-when-work-exists
 * assertion fires only when this count > 0 AND the agent had 0 successful beats in the
 * window — the exact silent-death (a QC/decision agent stopped while work piled up) the
 * cron/agent-kind checks can't see. Implemented in monitor.ts → fetchInlineAgentState.
 *
 *   - tickets-awaiting-qc       — closed AI-handled tickets never analyzed (last_analyzed_at
 *                                 null) updated within the window — what the ticket-analysis
 *                                 cron feeds analyzeTicket.
 *   - journeys-awaiting-delivery — journey_sessions created within the window (each is created
 *                                 inside launchJourneyForTicket right before delivery, so a
 *                                 created session with no successful delivery beat = silent).
 *   - orders-awaiting-fraud-screen — orders created within the window (every new order fires
 *                                 the per-order fraud screen).
 *   - tickets-awaiting-decision — inbound customer messages created within the window (every
 *                                 inbound on an AI-handled ticket fires unified-ticket-handler →
 *                                 callSonnetOrchestratorV2, so inbound traffic with 0 successful
 *                                 decision beats = the per-ticket decision agent went silent).
 */
export type InlineWorkSignalId =
  | "tickets-awaiting-qc"
  | "journeys-awaiting-delivery"
  | "orders-awaiting-fraud-screen"
  | "tickets-awaiting-decision";

/** Stable inline-agent loop ids (loop_id on loop_heartbeats; matches the registry entries). */
export const INLINE_AGENT_IDS = {
  ticketAnalyzer: "ai:ticket-analyzer",
  journeyDelivery: "ai:journey-delivery",
  fraudDetector: "ai:fraud-detector",
  orchestrator: "ai:orchestrator",
} as const;

export interface MonitoredLoop {
  /** Heartbeat loop_id: the worker box id, a cron's inngest fn id, or `agent:<kind>`. */
  id: string;
  kind: LoopKind;
  label: string;
  description: string;
  /** Human-readable cadence for the dashboard ("hourly", "every 10 min", "daily"). */
  expectedCadence: string;
  /**
   * Staleness window. For `worker` = max age of `last_poll_at`. For `cron` = max
   * age of the latest beat (cadence + grace). Unused for `agent-kind`.
   */
  livenessWindowMs?: number;
  /** worker only: running_sha may differ from the deployed SHA this long before alerting. */
  shaGraceMs?: number;
  /** agent-kind only: the agent_jobs.kind this loop maps to. */
  agentKind?: string;
  /** agent-kind only: a queued/building job older than this is "stuck" → alert. */
  stuckThresholdMs?: number;
  /**
   * Phase 2: the per-loop expected-output assertion (false-success / idle-while-work).
   * When set, the monitor runs the named state-check and flips the tile red on a
   * violation even if the loop is otherwise fresh/healthy on the Phase 1 checks.
   */
  outputAssertion?: OutputAssertionId;
  /**
   * inline-agent only: the read-only "is there work that should have triggered this agent
   * in the window?" probe. Liveness-when-work-exists fires only when this count > 0 AND the
   * agent had 0 successful beats in `livenessWindowMs` (genuinely-idle ⇒ green, no false alarm).
   */
  inlineWorkSignal?: InlineWorkSignalId;
  /** inline-agent only: errored/total beat fraction over the window that trips the error-rate alert. Default 0.5. */
  errorRateThreshold?: number;
  /** inline-agent only: minimum beats in the window before the error-rate check is meaningful (avoids 1/1 = 100%). Default 5. */
  minRunsForErrorRate?: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Singleton box id — matches scripts/builder-worker.ts WORKER_BOX_ID default. */
export const WORKER_BOX_ID = "box";

export const MONITORED_LOOPS: MonitoredLoop[] = [
  // ── The box build worker (worker_heartbeats) ──────────────────────────────
  {
    id: WORKER_BOX_ID,
    kind: "worker",
    label: "Box build worker",
    description: "The self-hosted build worker poll loop (scripts/builder-worker.ts).",
    expectedCadence: "polls every ~5s",
    livenessWindowMs: 5 * MIN,
    shaGraceMs: 30 * MIN,
  },

  // ── Inngest crons (loop_heartbeats, loop_id = inngest function id) ─────────
  {
    id: "triage-escalations-cron",
    kind: "cron",
    label: "Escalation triage enqueue",
    description: "Hourly enqueue of the box escalation-triage sweep.",
    expectedCadence: "hourly (30 * * * *)",
    livenessWindowMs: 2 * HOUR,
    outputAssertion: "escalation-idle",
  },
  {
    id: "spec-test-cron",
    kind: "cron",
    label: "Spec-test QA enqueue",
    description: "Daily enqueue of box QA over shipped-unverified specs.",
    expectedCadence: "daily (45 10 * * *)",
    livenessWindowMs: 26 * HOUR,
    outputAssertion: "spec-test-persisted",
  },
  {
    id: "migration-audit-retry-cron",
    kind: "cron",
    label: "Migration audit retry",
    description: "Re-verifies pending migration audits.",
    expectedCadence: "every 10 min (*/10 * * * *)",
    livenessWindowMs: 40 * MIN,
  },
  {
    id: "migration-integrity-sweep-cron",
    kind: "cron",
    label: "Migration integrity sweep",
    description: "Daily back-audit of never-audited internal subs.",
    expectedCadence: "daily (30 4 * * *)",
    livenessWindowMs: 26 * HOUR,
  },
  {
    id: "internal-subscription-renewal-cron",
    kind: "cron",
    label: "Internal subscription renewals",
    description: "Daily fan-out of due internal-subscription renewals.",
    expectedCadence: "daily (0 9 * * *)",
    livenessWindowMs: 26 * HOUR,
    outputAssertion: "renewal-integrity",
  },
  {
    id: "social-scheduler-plan",
    kind: "cron",
    label: "Social scheduler planner",
    description: "Daily organic-social calendar planner (rolling 7-day window).",
    expectedCadence: "daily (0 9 * * *)",
    livenessWindowMs: 26 * HOUR,
  },
  {
    id: "control-tower-monitor",
    kind: "cron",
    label: "Control Tower monitor",
    description: "The watchdog itself — so a dead monitor is visible too.",
    expectedCadence: "every 15 min (*/15 * * * *)",
    livenessWindowMs: 45 * MIN,
  },
  {
    id: "supabase-log-poll-cron",
    kind: "cron",
    label: "Supabase log poll",
    description: "Polls the Supabase Management Logs API for DB-level errors (error-feed Phase 2).",
    expectedCadence: "every 15 min (*/15 * * * *)",
    livenessWindowMs: 45 * MIN,
  },

  // ── Box agent-kind lanes (loop_heartbeats, loop_id = `agent:<kind>`) ───────
  // Idle = green. Alerted only on a STUCK job past the per-kind threshold.
  { id: "agent:build", kind: "agent-kind", agentKind: "build", label: "Agent — build", description: "Spec → PR feature builds (Max).", expectedCadence: "on demand", stuckThresholdMs: 2 * HOUR },
  { id: "agent:plan", kind: "agent-kind", agentKind: "plan", label: "Agent — plan", description: "Goal-decomposition planning passes.", expectedCadence: "on demand", stuckThresholdMs: 1 * HOUR },
  { id: "agent:fold", kind: "agent-kind", agentKind: "fold", label: "Agent — fold", description: "Spec → brain fold batches.", expectedCadence: "on demand", stuckThresholdMs: 45 * MIN },
  { id: "agent:product-seed", kind: "agent-kind", agentKind: "product-seed", label: "Agent — product seed", description: "Product none → published pipeline.", expectedCadence: "on demand", stuckThresholdMs: 90 * MIN },
  { id: "agent:spec-chat", kind: "agent-kind", agentKind: "spec-chat", label: "Agent — spec chat", description: "Roadmap authoring-chat turns.", expectedCadence: "on demand", stuckThresholdMs: 30 * MIN },
  { id: "agent:ticket-improve", kind: "agent-kind", agentKind: "ticket-improve", label: "Agent — ticket improve", description: "CX ticket-improve turns.", expectedCadence: "on demand", stuckThresholdMs: 30 * MIN },
  { id: "agent:triage-escalations", kind: "agent-kind", agentKind: "triage-escalations", label: "Agent — triage sweep", description: "Solver→skeptic→quorum escalation sweep.", expectedCadence: "hourly when work exists", stuckThresholdMs: 90 * MIN },
  { id: "agent:spec-test", kind: "agent-kind", agentKind: "spec-test", label: "Agent — spec test", description: "Non-destructive spec QA pass.", expectedCadence: "daily when work exists", stuckThresholdMs: 60 * MIN },
  { id: "agent:migration-fix", kind: "agent-kind", agentKind: "migration-fix", label: "Agent — migration fix", description: "Event-fired billing repair diagnosis.", expectedCadence: "on demand", stuckThresholdMs: 60 * MIN },
  { id: "agent:dev-ask", kind: "agent-kind", agentKind: "dev-ask", label: "Agent — dev ask", description: "Read-only developer message-center turns.", expectedCadence: "on demand", stuckThresholdMs: 30 * MIN },
  { id: "agent:pr-resolve", kind: "agent-kind", agentKind: "pr-resolve", label: "Agent — PR resolve", description: "Webhook-fired dirty-PR resolver: merge main + resolve conflicts, tsc-gate, push (or rebuild/surface).", expectedCadence: "on demand", stuckThresholdMs: 45 * MIN },

  // ── Inline event-driven AI agents (loop_heartbeats, loop_id = `ai:<agent>`) ──
  // Server-side AI agents that run per-ticket / per-order / per-journey, not on a queue or
  // cron. Each beats once at the END of every run (try/finally). No fixed cadence ⇒ a
  // genuinely-idle agent (no work waiting) is GREEN; red only on liveness-when-work-exists
  // (upstream work waits but 0 successful beats in the window) or an error-rate spike.
  {
    id: INLINE_AGENT_IDS.ticketAnalyzer,
    kind: "inline-agent",
    label: "AI ticket analyzer",
    description: "Per-ticket QC grader (analyzeTicket) — scores handled tickets, escalates ≤5 / severe types.",
    expectedCadence: "per handled ticket",
    livenessWindowMs: 2 * HOUR, // the analysis cron runs every 30m — 4 cycles of grace.
    inlineWorkSignal: "tickets-awaiting-qc",
    errorRateThreshold: 0.5,
    minRunsForErrorRate: 5,
  },
  {
    id: INLINE_AGENT_IDS.journeyDelivery,
    kind: "inline-agent",
    label: "AI journey delivery",
    description: "Delivers journeys to a ticket/portal per channel (launchJourneyForTicket).",
    expectedCadence: "per journey launch",
    livenessWindowMs: 6 * HOUR,
    inlineWorkSignal: "journeys-awaiting-delivery",
    errorRateThreshold: 0.5,
    minRunsForErrorRate: 5,
  },
  {
    id: INLINE_AGENT_IDS.fraudDetector,
    kind: "inline-agent",
    label: "AI fraud detector",
    description: "Per-order fraud QC screen (checkOrderForFraud) — rules + AI screen + ring signals.",
    expectedCadence: "per new order",
    livenessWindowMs: 6 * HOUR,
    inlineWorkSignal: "orders-awaiting-fraud-screen",
    errorRateThreshold: 0.5,
    minRunsForErrorRate: 5,
  },
  {
    // The per-ticket decision agent (callSonnetOrchestratorV2) — reply/action. One beat per run,
    // ok:false when the run threw OR returned a degraded/fallback decision (API error / parse
    // fail / no key) — "ran but produced nothing useful", the Goodhart failure the error-rate
    // assertion catches. A real model decision (incl. a model-chosen escalate) is ok:true.
    // (control-tower-agent-coverage spec, Phase 2.)
    id: INLINE_AGENT_IDS.orchestrator,
    kind: "inline-agent",
    label: "AI orchestrator",
    description: "Per-ticket decision agent (callSonnetOrchestratorV2) — picks reply/action/journey/playbook/escalate.",
    expectedCadence: "per inbound customer message",
    livenessWindowMs: 2 * HOUR,
    inlineWorkSignal: "tickets-awaiting-decision",
    errorRateThreshold: 0.5,
    minRunsForErrorRate: 5,
  },
];

/** The agent-kind heartbeat loop_id for a given agent_jobs.kind. */
export function agentLoopId(kind: string): string {
  return `agent:${kind}`;
}
