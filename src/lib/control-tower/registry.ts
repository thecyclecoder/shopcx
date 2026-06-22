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
 *   - reactive     — an EVENT-DRIVEN Inngest function (not a cron, not the box queue):
 *                  the inbound ticket handler, dunning, returns, journey-outcomes,
 *                  agent-todo-execute, chargeback. Fires on an Inngest event, so a
 *                  genuinely-idle one (no event) is GREEN — exactly the inline-agent
 *                  model. It beats once at the END of every run (loop_id = the inngest
 *                  function id, end-of-run try/finally — ok:false on throw) and is
 *                  evaluated by the SAME logic as inline-agent (liveness-when-work-exists
 *                  + error-rate). Separated only so the dashboard shows "Reactive agents"
 *                  apart from the AI inline agents. (control-tower-complete-coverage P1.)
 */

export type LoopKind = "worker" | "cron" | "agent-kind" | "inline-agent" | "reactive";

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
  {
    id: "spec-drift-reconcile",
    kind: "cron",
    label: "Spec-drift reconciler",
    description: "Per-phase emoji↔code reconciler — flips shipped phases ✅, surfaces ambiguous drift.",
    expectedCadence: "every ~30 min (20,50 * * * *)",
    livenessWindowMs: 90 * MIN,
  },

  // ── Full Inngest cron coverage (control-tower-complete-coverage spec, Phase 1) ──
  // Every remaining `inngest.createFunction` cron, registered so the dashboard shows
  // them all + the watchdog catches any that go stale. Window = cadence + grace.
  // ─ Sub-minute / minute crons (window ~10 min) ─
  { id: "deliver-pending-sends", kind: "cron", label: "Deliver pending sends", description: "Delivers due pending outbound ticket messages (the delay-then-send queue).", expectedCadence: "every minute (* * * * *)", livenessWindowMs: 10 * MIN },
  { id: "marketing-text-campaign-send-tick", kind: "cron", label: "SMS campaign send tick", description: "Drains scheduled marketing-text campaign sends.", expectedCadence: "every minute (* * * * *)", livenessWindowMs: 10 * MIN },
  { id: "meta-capi-dispatch-cron", kind: "cron", label: "Meta CAPI dispatch", description: "Dispatches queued Meta Conversions API events.", expectedCadence: "every minute (* * * * *)", livenessWindowMs: 10 * MIN },
  { id: "slack-roadmap-notify", kind: "cron", label: "Slack roadmap notify", description: "Pushes pending roadmap/build notifications to Slack.", expectedCadence: "every minute (* * * * *)", livenessWindowMs: 10 * MIN },
  // ─ Every-5-min crons (window ~20 min) ─
  { id: "today-sync", kind: "cron", label: "Today sync (Amazon + Meta)", description: "Keeps today's Amazon + Meta spend/order snapshots fresh.", expectedCadence: "every 5 min (*/5 * * * *)", livenessWindowMs: 20 * MIN },
  { id: "ticket-unsnooze", kind: "cron", label: "Ticket unsnooze", description: "Wakes snoozed tickets whose snooze window has passed.", expectedCadence: "every 5 min (*/5 * * * *)", livenessWindowMs: 20 * MIN },
  // ─ Every-10-min crons (window ~40 min) ─
  { id: "abandoned-cart-reminder", kind: "cron", label: "Abandoned-cart reminder", description: "Sends abandoned-cart reminder sends on the rolling schedule.", expectedCadence: "every 10 min (*/10 * * * *)", livenessWindowMs: 40 * MIN },
  // ─ Every-15-min crons (window ~45 min) ─
  { id: "portal-action-healer", kind: "cron", label: "Portal action healer", description: "Re-attempts failed portal actions (heal queue).", expectedCadence: "every 15 min (*/15 * * * *)", livenessWindowMs: 45 * MIN },
  { id: "ticket-csat-cron", kind: "cron", label: "Ticket CSAT survey", description: "Sends CSAT surveys for eligible recently-closed tickets.", expectedCadence: "every 15 min (*/15 * * * *)", livenessWindowMs: 45 * MIN },
  // ─ Every-30-min crons (window ~90 min) ─
  { id: "ticket-analysis-cron", kind: "cron", label: "Ticket analysis enqueue", description: "Feeds closed AI-handled tickets to the QC analyzer (analyzeTicket).", expectedCadence: "every 30 min (*/30 * * * *)", livenessWindowMs: 90 * MIN },
  // ─ Hourly crons (window ~2h) ─
  { id: "dunning-payday-retry-cron", kind: "cron", label: "Dunning payday retry", description: "Hourly retry sweep of dunning cycles whose payday-retry time has arrived.", expectedCadence: "hourly (0 * * * *)", livenessWindowMs: 2 * HOUR },
  { id: "sync-inventory", kind: "cron", label: "Inventory sync", description: "Hourly product inventory sync.", expectedCadence: "hourly (0 * * * *)", livenessWindowMs: 2 * HOUR },
  { id: "portal-auto-resume-cron", kind: "cron", label: "Portal auto-resume", description: "Resumes paused subscriptions whose pause_resume_at has passed.", expectedCadence: "hourly at :15 (15 * * * *)", livenessWindowMs: 2 * HOUR },
  // ─ Daily crons (window ~26h) ─
  { id: "amazon-daily-sync", kind: "cron", label: "Amazon daily sync", description: "Daily sync of the last 3 days of Amazon orders/spend.", expectedCadence: "daily (0 10 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "tickets-auto-archive", kind: "cron", label: "Tickets auto-archive", description: "Archives stale resolved tickets.", expectedCadence: "daily (0 9 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "auto-blog-generate", kind: "cron", label: "Auto blog generator", description: "Daily SEO blog/content generation pass.", expectedCadence: "daily (0 13 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "brain-index-refresh", kind: "cron", label: "Brain index refresh", description: "Rebuilds the docs/brain search index.", expectedCadence: "daily (0 9 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "chargeback-evidence-reminder", kind: "cron", label: "Chargeback evidence reminder", description: "Reminds about chargebacks with evidence due.", expectedCadence: "daily (0 9 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "creative-finder-daily-cron", kind: "cron", label: "Creative finder", description: "Daily creative/winning-ad discovery sweep.", expectedCadence: "daily (0 9 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "crisis-daily-campaign", kind: "cron", label: "Crisis campaign tick", description: "Advances active crisis-comms campaigns.", expectedCadence: "daily (0 14 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "demographics-enrich-batch", kind: "cron", label: "Demographics enrich batch", description: "Daily customer-demographics enrichment batch.", expectedCadence: "daily (0 6 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "daily-analysis-report-cron", kind: "cron", label: "Daily analysis report", description: "Builds the daily AI ops/analysis report.", expectedCadence: "daily (0 11 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "daily-order-snapshot", kind: "cron", label: "Daily order snapshot", description: "Pre-computes the prior day's order snapshot.", expectedCadence: "daily (0 6 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "daily-order-snapshot-self-heal", kind: "cron", label: "Order snapshot self-heal", description: "Back-fills any missing daily order snapshots.", expectedCadence: "daily (0 12 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "delivery-nightly-audit", kind: "cron", label: "Delivery nightly audit", description: "Audits shipment delivery state nightly.", expectedCadence: "daily (0 11 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "featured-review-cards", kind: "cron", label: "Featured review cards", description: "Refreshes featured-review card generation.", expectedCadence: "daily (0 11 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "fraud-nightly-scan", kind: "cron", label: "Fraud nightly scan", description: "Nightly batch fraud re-scan across recent orders.", expectedCadence: "daily (0 3 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "klaviyo-engagement-sync", kind: "cron", label: "Klaviyo engagement sync", description: "Daily Klaviyo engagement metrics sync.", expectedCadence: "daily (0 10 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "marketing-coupon-auto-disable", kind: "cron", label: "Marketing coupon auto-disable", description: "Auto-disables expired/over-budget marketing coupons.", expectedCadence: "daily (0 10 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "meta-performance-daily", kind: "cron", label: "Meta performance pipeline", description: "Daily Meta ad performance iteration pipeline.", expectedCadence: "daily (30 11 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "meta-daily-sync", kind: "cron", label: "Meta daily spend sync", description: "Daily Meta account spend rollup sync.", expectedCadence: "daily (0 11 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "monthly-revenue-snapshot", kind: "cron", label: "Revenue snapshot", description: "Pre-computes monthly revenue snapshots from daily data.", expectedCadence: "daily (0 7 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "refresh-customer-segments-cron", kind: "cron", label: "Customer segment refresh", description: "Daily recompute of customer segments.", expectedCadence: "daily (0 11 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "social-insights-sync", kind: "cron", label: "Social insights sync", description: "Daily organic-social insights/metrics sync.", expectedCadence: "daily (30 8 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "sonnet-prompt-auto-review", kind: "cron", label: "Sonnet prompt auto-review", description: "Daily auto-review of the orchestrator prompt against recent decisions.", expectedCadence: "daily (0 11 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "sync-klaviyo-reviews", kind: "cron", label: "Klaviyo reviews sync", description: "Daily product-review sync from Klaviyo.", expectedCadence: "daily (0 3 * * *)", livenessWindowMs: 26 * HOUR },
  // ─ Weekly crons (window ~8 days) ─
  { id: "demographics-snapshot-builder", kind: "cron", label: "Demographics snapshot builder", description: "Weekly customer-demographics snapshot build.", expectedCadence: "weekly Sun (0 8 * * 0)", livenessWindowMs: 8 * DAY },
  { id: "reseller-discovery-weekly", kind: "cron", label: "Reseller discovery", description: "Weekly Amazon SP-API reseller scan.", expectedCadence: "weekly Mon (0 12 * * 1)", livenessWindowMs: 8 * DAY },
  { id: "reviews/tag-cancel-relevance-cron", kind: "cron", label: "Review cancel-relevance tagging", description: "Weekly tagging of cancel-relevant reviews.", expectedCadence: "weekly Mon (0 4 * * 1)", livenessWindowMs: 8 * DAY },
  // ─ Yearly cron (window ~370 days) ─
  { id: "foundervip-followup-gate", kind: "cron", label: "FounderVIP follow-up gate", description: "Annual FounderVIP follow-up gate (fires once a year).", expectedCadence: "yearly (0 12 15 6 *)", livenessWindowMs: 370 * DAY },

  // ── Reactive event-driven Inngest agents (loop_heartbeats, loop_id = inngest fn id) ──
  // Event-driven (not crons, not the box queue). Idle = green; alerted on
  // liveness-when-work-exists / error-rate (same logic as inline-agent). Each beats once
  // at end-of-run (end-of-run try/finally — ok:false on throw). (control-tower-complete-coverage P1.)
  {
    id: "unified-ticket-handler",
    kind: "reactive",
    label: "Inbound ticket handler",
    description: "THE inbound pipeline — every customer message, all channels (unifiedTicketHandler). If it silently stops, customers go unanswered.",
    expectedCadence: "per inbound customer message",
    livenessWindowMs: 2 * HOUR,
    inlineWorkSignal: "tickets-awaiting-decision",
    errorRateThreshold: 0.5,
    minRunsForErrorRate: 5,
  },
  {
    id: "dunning-payment-failed",
    kind: "reactive",
    label: "Dunning — payment failed",
    description: "Opens/advances a dunning cycle on a failed subscription payment (card-rotation recovery + retries).",
    expectedCadence: "per failed payment event",
    livenessWindowMs: 12 * HOUR,
    errorRateThreshold: 0.5,
    minRunsForErrorRate: 5,
  },
  {
    id: "returns-process-delivery",
    kind: "reactive",
    label: "Returns — process delivery",
    description: "Processes a returned-item delivery → triggers the refund flow.",
    expectedCadence: "per return delivery event",
    livenessWindowMs: 24 * HOUR,
    errorRateThreshold: 0.5,
    minRunsForErrorRate: 5,
  },
  {
    id: "journey-session-completed",
    kind: "reactive",
    label: "Journey outcomes",
    description: "Records the outcome of a completed journey session (retention/save attribution).",
    expectedCadence: "per journey completion",
    livenessWindowMs: 12 * HOUR,
    errorRateThreshold: 0.5,
    minRunsForErrorRate: 5,
  },
  {
    id: "agent-todo-execute",
    kind: "reactive",
    label: "Agent to-do executor",
    description: "Executes an approved agent to-do action via the real orchestrator executor.",
    expectedCadence: "per approved to-do",
    livenessWindowMs: 12 * HOUR,
    errorRateThreshold: 0.5,
    minRunsForErrorRate: 5,
  },
  {
    id: "chargeback-received",
    kind: "reactive",
    label: "Chargeback received",
    description: "Handles an inbound chargeback — cancels subs, assembles evidence, notifies.",
    expectedCadence: "per chargeback event",
    livenessWindowMs: 24 * HOUR,
    errorRateThreshold: 0.5,
    minRunsForErrorRate: 5,
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
    // NO work-exists signal: delivery is SYNCHRONOUS — the agent creates the journey_session, so a
    // session existing proves it already ran (there's no "awaiting delivery" backlog; `pending` =
    // awaiting the customer, not the agent). Counting created sessions as "work awaiting" was a
    // false-positive source. Liveness here is error-rate only: when the agent DOES run, does it
    // succeed? (A "should-have-launched-but-didn't" gap lives in the upstream trigger, not here.)
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
    // Work-signal = new orders in-window. This is CORRECT (not over-broad like journey's was):
    // orders are EXTERNAL inputs, and every one fires fraud/order.check → checkOrderForFraud → a
    // beat. So "orders flowing but 0 successful screens" is a genuine silence signal. (There's no
    // per-order "screened" flag to filter on — orders has only easypost_checked_at, fraud_cases
    // exist only for flagged ones — but the all-orders count is the right liveness proxy here.)
    // The deploy-boundary false case is handled by the never-run grace in evalInlineAgent.
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
