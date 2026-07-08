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
 * The org-chart function that OWNS each loop (control-tower-complete-coverage spec, Phase 3 —
 * department rollups). Every spec already declares an owner function ([[../project-management]] ·
 * the [[../functions]] org chart); we carry that to loops so the Control Tower can group them by
 * department and show a per-function rollup health tile (the CEO-glance: which org function is
 * healthy?). A loop's owner = the function that owns the system it monitors (e.g. the renewal /
 * dunning / portal crons → retention; the meta + social loops → growth/cmo; the ticket handler +
 * triage → cs; the build/spec-test/migration-fix agents + the data-infra/monitoring crons → platform).
 */
export type OwnerFunction = "platform" | "growth" | "retention" | "cs" | "cmo" | "ceo";
// `ceo` is the founder-owned lane — reserved for tools that answer DIRECTLY to the CEO seat,
// not to a director. Today: the god-mode cockpit's executive-assistant agent (Eve). Deliberately
// NOT in `OWNER_FUNCTIONS` — the CEO isn't a department that gets a rollup Health tile; she owns
// her own lane. (god-mode-becomes-ceo-executive-assistant-agent Phase 1.)

/**
 * The departments in CEO-glance order, with the rollup-tile health label the dashboard shows
 * ("Platform Health", "Growth Health", …). The Control Tower leads with these rollups (worst-of
 * each function's loops) before drilling into the individual cron/agent cards. Maps onto
 * [[../goals/ceo-mode]] — a CEO sees org-function health, then drills in.
 */
export const OWNER_FUNCTIONS: { id: OwnerFunction; label: string; healthLabel: string }[] = [
  { id: "platform", label: "Platform", healthLabel: "Platform Health" },
  { id: "growth", label: "Growth", healthLabel: "Growth Health" },
  { id: "retention", label: "Retention", healthLabel: "Retention Health" },
  { id: "cs", label: "CS", healthLabel: "CS Health" },
  { id: "cmo", label: "CMO", healthLabel: "CMO Health" },
];

/**
 * Phase 2 output-assertion id. Phase 1 catches "the loop went SILENT" (liveness /
 * cron-freshness / stuck-jobs). An output assertion catches the Goodhart failure
 * Phase 1 can't see: the loop RAN (fresh heartbeat, green on P1) but silently did
 * nothing or the wrong thing. The monitor runs the named read-only state-check and
 * flips the tile RED (opening a de-duped alert + paging) when it fails. Absent ⇒
 * the loop has only the Phase 1 checks. Implemented in monitor.ts → evalOutputAssertion.
 *
 *   - escalation-idle    — the OLDEST routine-escalated ticket has waited past the
 *                          cadence grace (keyed off its escalated_at, not the last
 *                          job's age) AND no triage-escalations job was created since
 *                          it escalated — so a healthy hourly cron isn't flagged in
 *                          the normal gap between an escalation and the next tick.
 *   - spec-test-persisted — the latest beat reports enqueued>0 but 0 spec-test
 *                          agent_jobs actually landed (produced-but-not-persisted).
 *   - renewal-integrity  — active internal subs are overdue (next_billing_date in
 *                          the past) — the renewal cron ran but didn't advance them.
 *   - renewal-outcome-distribution — the renewal cron RAN and every decline individually
 *                          "routed to dunning correctly", but the per-cycle outcome mix is
 *                          anomalous: a systemic decline/no-payment-method/comp-blocked rate
 *                          (hard floor) or a spike vs the rolling baseline (bad Braintree
 *                          creds declining everyone, a no-PM-skip spike). Aggregates the
 *                          per-sub outcome beats (RENEWAL_OUTCOME_LOOP_ID). On the renewal cron.
 *   - stuck-dunning      — a dunning_cycles row still 'retrying' more than a grace past its
 *                          next_retry_at — the retry engine ran but isn't advancing it to
 *                          recovered/exhausted. A sub correctly mid-dunning (within schedule)
 *                          is NOT flagged. On the dunning payday-retry cron.
 *   - migration-drift    — TWO axes on the same tile:
 *                          (a) a table a migration CREATES is absent from the live public schema
 *                              (a silently-skipped migration: the code references the table, every
 *                              upsert hits PGRST205), carried in `produced.missing`;
 *                          (b) a migration FILE on main whose 14-digit version isn't in the DB's
 *                              applied set (supabase_migrations.schema_migrations) — the
 *                              merged-but-unapplied case that leaves dependent code silently inert
 *                              (regression pin: 20260918120000_order_refunds_mirror merged 2026-07-06
 *                              but never applied). Carried in `produced.mergedButUnapplied`.
 *                          Detected on the BOX (where the .sql files + DB coexist) — the assertion
 *                          reads both lists and flips red on either. Box-emitted
 *                          migration-drift-check loop.
 *                          (control-tower-migration-drift-check P1;
 *                           ci-guard-migrations-applied-not-just-merged P1 added axis (b).)
 *   - segment-coverage   — the refresh-customer-segments cron RAN (fresh beat, green on P1) but
 *                          didn't actually refresh the whole book: <95% of SMS-subscribed rows have
 *                          segments_refreshed_at within 26h, OR any subscribed row's
 *                          segments_refreshed_at is older than 48h / null. Catches the exact
 *                          2026-07 whole-book-coverage regression where the PostgREST 1000-row cap
 *                          + a `.limit(2000)` truncated the cursor loop to page 1 (1000/138K
 *                          refreshed per cron, back half stayed 29d stale). Reads the LIVE
 *                          customers table each monitor tick; sample-guarded so an empty workspace
 *                          can't false-fire. (fix-segment-refresh-coverage P2.)
 */
export type OutputAssertionId =
  | "escalation-idle"
  | "spec-test-persisted"
  | "renewal-integrity"
  | "renewal-outcome-distribution"
  | "stuck-dunning"
  | "migration-drift"
  | "segment-coverage";

/**
 * Per-sub renewal outcome taxonomy (control-tower-renewal-integrity-assertions, Phase 1). Every
 * terminal path of `internal-subscription-renewal-attempt` emits ONE beat carrying its outcome
 * (loop_id = RENEWAL_OUTCOME_LOOP_ID, produced.outcome) — the only uniform channel that captures
 * SKIPS too (a no-payment-method / zero-total skip leaves no transaction row, so the DB alone is
 * blind to it). The outcome-distribution assertion aggregates these into a per-cycle breakdown +
 * spike-vs-baseline check; the renewal cron bakes the most-recently-completed cycle's breakdown
 * into its heartbeat's `produced`. (Uncaught errors aren't beat here — a sub that errored never
 * advances, so it's caught by the renewal-integrity overdue assertion instead.)
 */
export type RenewalOutcome =
  | "charged"
  | "skipped_no_payment_method"
  | "skipped_zero_total"
  | "declined_to_dunning"
  | "comp_shipped"
  | "comp_blocked"
  | "skipped_other";

/** loop_heartbeats.loop_id the per-sub renewal outcome beats are written under (kind 'reactive' so the cron/agent-kind beats RPC skips them). NOT a monitored tile — a data channel for the outcome-distribution assertion. */
export const RENEWAL_OUTCOME_LOOP_ID = "internal-subscription-renewal-outcome";

/** Outcomes that count as "anomalous" for the outcome-distribution spike/floor check (vs the benign charged / comp_shipped / zero-total / other-skip outcomes). */
export const RENEWAL_BAD_OUTCOMES: RenewalOutcome[] = [
  "skipped_no_payment_method",
  "declined_to_dunning",
  "comp_blocked",
];

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
 *                                 cron feeds analyzeTicket. Feeder-cadence grace: only counts a
 *                                 ticket once it has survived a full ticket-analysis-cron cycle
 *                                 (~30 min) still unprocessed, so a ticket closing between ticks
 *                                 isn't a false idle_while_work (ticket-analyzer-workprobe-cron-grace).
 *   - journeys-awaiting-delivery — journey_sessions created within the window (each is created
 *                                 inside launchJourneyForTicket right before delivery, so a
 *                                 created session with no successful delivery beat = silent).
 *   - orders-awaiting-fraud-screen — orders created within the window (every new order fires
 *                                 the per-order fraud screen).
 *   - tickets-awaiting-decision — inbound customer messages created within the window that DRIVE
 *                                 the handler (every such inbound fires ticket/inbound-message →
 *                                 unified-ticket-handler → callSonnetOrchestratorV2, so inbound
 *                                 traffic with 0 successful decision beats = the per-ticket decision
 *                                 agent went silent). Excludes CSAT-reopen inserts (csat:reopened
 *                                 tag), which reopen + route to a human and emit no
 *                                 ticket/inbound-message event, so they never drive a beat
 *                                 (control-tower-ticket-decision-workprobe-scope).
 */
export type InlineWorkSignalId =
  | "tickets-awaiting-qc"
  | "journeys-awaiting-delivery"
  | "orders-awaiting-fraud-screen"
  | "tickets-awaiting-decision";

/**
 * loop_heartbeats.loop_id the Auto-Ship Pipeline's auto-merge gate beats under (auto-ship-pipeline spec,
 * Phase 1 / Gate A). The gate runs INSIDE the GitHub webhook (not an Inngest fn / box lane), squash-merging
 * ready claude/* build PRs — it beats once per webhook pass (kind 'reactive', end-of-run try/finally:
 * ok:true on a clean pass / idle, ok:false on a failed merge attempt). Idle = green (event-driven, no cadence).
 */
export const AUTO_MERGE_GATE_LOOP_ID = "auto-merge-gate";

/**
 * loop_heartbeats.loop_id the Auto-Ship Pipeline's auto-FOLD gate beats under (auto-ship-pipeline spec,
 * Phase 2 / Gate B). The mirror of the auto-merge gate, one rung up: where Gate A automates the owner's
 * "merge" click on green PRs, Gate B automates the owner's "Mark verified & archive" click on all-green
 * shipped specs (agent-verdict approved · 0 human checks waiting · 0 failed · 0 regressions) → enqueue_fold.
 * NOT an Inngest fn / box lane — it runs reactively (on a spec-test completing / a human-check resolving)
 * + periodically (the spec-test cron). Beats once per pass (kind 'reactive', end-of-run try/finally:
 * ok:true on a clean pass / idle, ok:false on a failed enqueue). Idle = green (event-driven, no cadence).
 */
export const AUTO_FOLD_GATE_LOOP_ID = "auto-fold-gate";

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
  /** Phase 3: the org-chart function that owns this loop (drives the department rollups). */
  owner: OwnerFunction;
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
  /**
   * cron only: ISO timestamp of when THIS cron was added to the registry. A freshly-added
   * long-cadence cron has had no chance to fire its first scheduled tick yet, but the
   * deploy-SURVIVING watchdog-uptime reference (monitorUptimeMs) is already past its window —
   * so the deploy-independent registered_not_firing red would false-page it the moment it's
   * shipped (control-tower-registered-not-firing-newcron-grace). When set, evalCron requires
   * (now - registeredAt) > livenessWindowMs IN ADDITION to monitorUptimeMs > window before
   * firing registered_not_firing: a cron registered for less than a full window stays amber
   * ("awaiting first run"), graced just like the deploy-anchored never_fired check already
   * graces it. Unlike deployAgeMs this is a code constant, so it survives the box's
   * self-update/restart. Unset (legacy crons) ⇒ no grace (registered long ago) ⇒ old behavior.
   */
  registeredAt?: string;
  /** agent-kind only: the agent_jobs.kind this loop maps to. */
  agentKind?: string;
  /**
   * Roster-linkage (agent-roster-sync spec, Phase 1): the [[../libraries/agent-personas]] persona
   * key (personas.ts) a NON-`agent-kind` loop maps to a worker on the org view — so a personified
   * platform cron declares its persona EXPLICITLY rather than by guesswork. `control-tower-monitor`
   * (no `agentKind`) → "monitor" (Tao); both `db-health-*` crons → "db_health" (Devi). The org-chart
   * reader ([[../libraries/org-chart]] `getOrgChart`) surfaces every `personaKind` cron as a worker
   * (deduped by key, so the two db-health crons render as ONE Devi), keeping `agentKind` for the
   * queue lanes. Unset ⇒ a pure infra cron (a Control Tower tile only, not an org-view worker).
   */
  personaKind?: string;
  /** agent-kind only: a queued/building job older than this is "stuck" → alert. */
  stuckThresholdMs?: number;
  /**
   * Phase 2: the per-loop expected-output assertion (false-success / idle-while-work).
   * When set, the monitor runs the named state-check and flips the tile red on a
   * violation even if the loop is otherwise fresh/healthy on the Phase 1 checks.
   */
  outputAssertion?: OutputAssertionId;
  /**
   * Same as `outputAssertion` but for a loop that carries MORE THAN ONE expected-output
   * assertion (the renewal cron: renewal-integrity AND outcome-distribution). The monitor
   * runs each in order and flips red on the first that fails. Use this OR `outputAssertion`.
   */
  outputAssertions?: OutputAssertionId[];
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

/**
 * Cron functions that exist in code (a `createFunction` with a cron trigger in the serve
 * route) but are DELIBERATELY not given a monitored-loop tile — so the Phase 2 self-audit
 * (control-tower-complete-coverage) doesn't flag them as "unregistered loop: X". Silence is
 * never the default: each MUST carry a reason. Keep this list short — the right answer for a
 * real loop is a MONITORED_LOOPS entry, not an exemption. Keyed by the cron's inngest fn id.
 */
export const INTENTIONALLY_UNMONITORED_CRONS: Record<string, string> = {
  "slack-roadmap-notify": "intentionally unmonitored — owner-confirmed via the coverage-register agent",
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Singleton box id — matches scripts/builder-worker.ts WORKER_BOX_ID default. */
export const WORKER_BOX_ID = "box";

/**
 * loop_heartbeats.loop_id (and MONITORED_LOOPS id) of the migration-drift check
 * (control-tower-migration-drift-check P1). NOT an Inngest cron — the deployed Next runtime can't
 * read the `supabase/migrations/*.sql` files (they aren't bundled), so the parse-migrations →
 * diff-live-schema check runs on the BOX (where the repo working tree + an admin DB connection both
 * exist) and writes a `kind:'cron'` beat under this id, carrying the missing tables in `produced`.
 * The monitor's `migration-drift` output assertion reads that beat and flips the tile red on drift.
 */
export const MIGRATION_DRIFT_LOOP_ID = "migration-drift-check";

/**
 * loop_heartbeats.loop_id of the DB Health Agent's two BOX-EMITTED passes (docs/brain/specs/
 * db-health-agent.md, Phase 1). Like the migration-drift check, detection runs on the box (it reads
 * pg_stat_statements + runs EXPLAIN + reads pg_class/pg_stat_user_* via the pooler — which the
 * deployed runtime can't do) and beats here, so a DEAD agent is itself visible (cron freshness).
 *   - the FREQUENT (~hourly) slow-query root-cause pass.
 *   - the DAILY size/growth/index/bloat sweep.
 * Both are liveness tiles (green when beating) — the FINDINGS surface as deduped proposals in the DB
 * Health panel (agent_jobs kind='db_health', needs_approval), not by reddening the tile, because a
 * proposal is advisory (awaiting the owner), not a system failure.
 */
export const DB_HEALTH_SLOWQ_LOOP_ID = "db-health-slow-query";
export const DB_HEALTH_SIZE_LOOP_ID = "db-health-size-sweep";
/**
 * loop_heartbeats.loop_id of the DB Health Agent's INSTANCE-saturation pass
 * (db-health-instance-saturation-detector, Phase 1). The 2026-07-02 incident (86.8% DATABASE errors,
 * dashboards timing out) was invisible to the per-query slow-query pass because it was
 * instance-level (xact_rollback 7.43%, 883 GB temp_bytes, MEMORY 79%, `authenticated`
 * statement_timeout=8s catching queries under load). This pass reads `pg_stat_database` +
 * `pg_stat_activity` + `pg_roles.rolconfig` via the pooler, feeds them into `analyzeInstanceHealth`,
 * and beats here. Liveness tile (green when beating) — Phase 2 surfaces findings as advisory
 * proposals in the DB Health panel + lets a live instance finding redden the tile.
 */
export const DB_HEALTH_INSTANCE_LOOP_ID = "db-health-instance-saturation";

export const MONITORED_LOOPS: MonitoredLoop[] = [
  // ── The box build worker (worker_heartbeats) ──────────────────────────────
  {
    id: WORKER_BOX_ID,
    kind: "worker",
    owner: "platform",
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
    owner: "cs",
    label: "Escalation triage enqueue",
    description: "Hourly enqueue of one cs-director-call (June-review) box job per eligible escalated ticket — the primary escalation triage (june-review-replaces-solver-skeptic-quorum-triage Phase 1).",
    expectedCadence: "hourly (30 * * * *)",
    livenessWindowMs: 2 * HOUR,
    outputAssertion: "escalation-idle",
  },
  {
    id: "spec-test-cron",
    kind: "cron",
    owner: "platform",
    label: "Spec-test QA enqueue",
    description: "Daily enqueue of box QA over shipped-unverified specs.",
    expectedCadence: "daily (45 10 * * *)",
    livenessWindowMs: 26 * HOUR,
    outputAssertion: "spec-test-persisted",
  },
  {
    id: "migration-audit-retry-cron",
    kind: "cron",
    owner: "retention",
    label: "Migration audit retry",
    description: "Re-verifies pending migration audits.",
    expectedCadence: "every 10 min (*/10 * * * *)",
    livenessWindowMs: 40 * MIN,
  },
  {
    id: "migration-integrity-sweep-cron",
    kind: "cron",
    owner: "retention",
    label: "Migration integrity sweep",
    description: "Daily back-audit of never-audited internal subs.",
    expectedCadence: "daily (30 4 * * *)",
    livenessWindowMs: 26 * HOUR,
  },
  {
    id: "internal-subscription-renewal-cron",
    kind: "cron",
    owner: "retention",
    label: "Internal subscription renewals",
    description: "Daily fan-out of due internal-subscription renewals.",
    expectedCadence: "daily (0 9 * * *)",
    livenessWindowMs: 26 * HOUR,
    // renewal-integrity (overdue subs never advanced) + outcome-distribution (the cron ran +
    // each decline "routed correctly" but the per-cycle outcome mix is systemically broken / spiking).
    outputAssertions: ["renewal-integrity", "renewal-outcome-distribution"],
  },
  {
    id: "social-scheduler-plan",
    kind: "cron",
    owner: "cmo",
    label: "Social scheduler planner",
    description: "Daily organic-social calendar planner (rolling 7-day window).",
    expectedCadence: "daily (0 9 * * *)",
    livenessWindowMs: 26 * HOUR,
  },
  {
    id: "control-tower-monitor",
    kind: "cron",
    owner: "platform",
    label: "Control Tower monitor",
    description: "The watchdog itself — so a dead monitor is visible too.",
    expectedCadence: "every 15 min (*/15 * * * *)",
    livenessWindowMs: 45 * MIN,
    personaKind: "monitor", // Tao — surfaces this cron as a Platform worker on the org view (agent-roster-sync P1)
  },
  {
    id: "supabase-log-poll-cron",
    kind: "cron",
    owner: "platform",
    label: "Supabase log poll",
    description: "Polls the Supabase Management Logs API for DB-level errors (error-feed Phase 2).",
    expectedCadence: "every 15 min (*/15 * * * *)",
    livenessWindowMs: 45 * MIN,
  },
  {
    id: "spec-drift-reconcile",
    kind: "cron",
    owner: "platform",
    personaKind: "spec-drift", // Reese — surfaces under Ada in the agents roster (agent-roster-sync source 2)
    label: "Spec-drift backstop",
    description: "DB-vs-code consistency backstop — for every phase the DB marks shipped, verifies its code is actually on main; surfaces a bad/reverted merge for Ada to confirm + escalate. (Repurposed when status went 100% DB-driven.)",
    expectedCadence: "every ~30 min (20,50 * * * *)",
    livenessWindowMs: 90 * MIN,
  },
  {
    // BOX-EMITTED cron (not an Inngest fn): the deployed runtime can't read the .sql files, so the
    // parse-migrations → diff-live-schema check runs on the box and beats here (control-tower-
    // migration-drift-check P1). Freshness keeps a DEAD check visible; the migration-drift output
    // assertion reads the beat's `produced.missing` (an expected-but-absent table) and
    // `produced.mergedButUnapplied` (a migration file on main whose version isn't in the DB's
    // applied set — ci-guard-migrations-applied-not-just-merged P1) and flips red on either.
    id: MIGRATION_DRIFT_LOOP_ID,
    kind: "cron",
    owner: "platform",
    label: "Migration drift check",
    description: "Box job: (a) diffs every migration-created table against the live public schema — a missing one = a silently-skipped migration; (b) reconciles supabase/migrations/*.sql versions against supabase_migrations.schema_migrations — a merged-but-unapplied file = dependent code silently inert.",
    expectedCadence: "every ~30 min (box job)",
    livenessWindowMs: 90 * MIN,
    outputAssertion: "migration-drift",
  },
  {
    // BOX-EMITTED — the DB Health Agent's frequent slow-query root-cause pass (db-health-agent P1).
    // Reads pg_stat_statements, EXPLAINs each top offender, classifies the cause, and proposes the
    // matching fix (deduped, surfaced in the DB Health panel). Liveness only — a finding is an
    // advisory proposal, not a red tile. registeredAt graces the first-run window (newcron-grace).
    id: DB_HEALTH_SLOWQ_LOOP_ID,
    kind: "cron",
    owner: "platform",
    label: "DB Health — slow-query root-cause",
    description: "Box job: top pg_stat_statements offenders → EXPLAIN → classify cause → propose the matching fix (index/rewrite/vacuum).",
    expectedCadence: "every ~hour (box job)",
    livenessWindowMs: 2 * HOUR,
    registeredAt: "2026-06-23T00:00:00Z",
    personaKind: "db_health", // Devi — both db-health crons merge into one Devi worker on the org view (agent-roster-sync P1)
  },
  {
    // BOX-EMITTED — the DB Health Agent's instance-saturation pass (db-health-instance-saturation-detector P1).
    // Reads pg_stat_database (rollback ratio · temp spill · cache-hit) + pg_stat_activity (connection
    // utilization · statements near the `authenticated` statement_timeout ceiling) + pg_roles.rolconfig
    // (the 8s ceiling itself). Fills the blind spot the per-query slow-query pass has for the
    // 2026-07-02-class instance-level saturation. Liveness only in Phase 1 (findings ride the beat's
    // `produced` blob for the panel); Phase 2 surfaces them as advisory proposals. registeredAt graces
    // the first-run window (newcron-grace).
    id: DB_HEALTH_INSTANCE_LOOP_ID,
    kind: "cron",
    owner: "platform",
    label: "DB Health — instance saturation",
    description: "Box job: pg_stat_database + pg_stat_activity + pg_roles.rolconfig → classify instance-level saturation (statement_timeout / temp-spill / connection / cache / rollback pressure) the per-query pass can't see.",
    expectedCadence: "every ~15 min (box job)",
    livenessWindowMs: 45 * MIN,
    registeredAt: "2026-07-02T00:00:00Z",
    personaKind: "db_health", // Devi — all db-health crons merge into one Devi worker on the org view (agent-roster-sync P1)
  },
  {
    // BOX-EMITTED — the DB Health Agent's daily size/growth/index/bloat sweep (db-health-agent P1).
    // Snapshots per-table size into db_table_size_history (growth rate), flags unbounded growth /
    // missing+unused indexes / bloat, and proposes the fix. Liveness only (advisory proposals).
    id: DB_HEALTH_SIZE_LOOP_ID,
    kind: "cron",
    owner: "platform",
    label: "DB Health — size / growth / index sweep",
    description: "Box job: snapshots per-table size+stats, flags unbounded growth / missing+unused indexes / bloat, proposes the fix.",
    expectedCadence: "daily (box job)",
    livenessWindowMs: 26 * HOUR,
    registeredAt: "2026-06-23T00:00:00Z",
    personaKind: "db_health", // Devi — both db-health crons merge into one Devi worker on the org view (agent-roster-sync P1)
  },

  // ── Full Inngest cron coverage (control-tower-complete-coverage spec, Phase 1) ──
  // Every remaining `inngest.createFunction` cron, registered so the dashboard shows
  // them all + the watchdog catches any that go stale. Window = cadence + grace.
  // ─ Sub-minute / minute crons (window ~10 min) ─
  { id: "claude-status-poll-cron", kind: "cron", owner: "platform", label: "Claude status poll", description: "Polls status.claude.com for the Claude API + Claude Code components → drives the Claude-down breaker.", expectedCadence: "every minute (* * * * *)", livenessWindowMs: 10 * MIN },
  { id: "deploy-guardian-cron", kind: "cron", owner: "platform", label: "Deploy guardian", description: "Evaluates each auto-merged deploy's canary watch over its window → healthy/regressed/unsure verdict (deploy-health-rollback-guardian).", expectedCadence: "every minute (* * * * *)", livenessWindowMs: 10 * MIN, personaKind: "deploy-guardian" /* Reva — surfaces under Ada in the agents roster (agent-roster-sync source 2) */ },
  // Reva's canary-INVESTIGATION box-session (reva-box-session-causal-rollback). The deploy-guardian
  // cron above fires a kind='deploy-review' job when a canary window closes non-healthy; the job is a
  // read-only diff walk on Max → typed revert/keep verdict (builder-worker.ts runDeployReviewJob). Same
  // agent as the cron (Reva), so personaKind:'deploy-guardian' MERGES it into her one card (org-chart
  // source 2, byPersona), and agentKind:'deploy-review' REGISTERS the job kind so it stops surfacing as a
  // flagged "unregistered" worker card (org-chart source 3). Reactive + a loose window: a quiet
  // deploy-review is healthy (most deploys are fine and never trigger an investigation) — the cron's beats
  // carry Reva's liveness.
  { id: "deploy-review-agent", kind: "reactive", owner: "platform", agentKind: "deploy-review", personaKind: "deploy-guardian", label: "Deploy review", description: "Reva's box-session investigation of a non-healthy canary — read-only diff walk → typed revert/keep verdict (reva-box-session-causal-rollback).", expectedCadence: "on a non-healthy canary verdict", livenessWindowMs: 30 * DAY, registeredAt: "2026-07-08T00:00:00Z" },
  { id: "deliver-pending-sends", kind: "cron", owner: "cs", label: "Deliver pending sends", description: "Delivers due pending outbound ticket messages (the delay-then-send queue).", expectedCadence: "every minute (* * * * *)", livenessWindowMs: 10 * MIN },
  { id: "marketing-text-campaign-send-tick", kind: "cron", owner: "cmo", label: "SMS campaign send tick", description: "Drains scheduled marketing-text campaign sends.", expectedCadence: "every minute (* * * * *)", livenessWindowMs: 10 * MIN },
  { id: "meta-capi-dispatch-cron", kind: "cron", owner: "growth", label: "Meta CAPI dispatch", description: "Dispatches queued Meta Conversions API events.", expectedCadence: "every minute (* * * * *)", livenessWindowMs: 10 * MIN },
  // ─ Every-5-min crons (window ~20 min) ─
  { id: "today-sync", kind: "cron", owner: "growth", label: "Today sync (Amazon + Meta)", description: "Keeps today's Amazon + Meta spend/order snapshots fresh.", expectedCadence: "every 5 min (*/5 * * * *)", livenessWindowMs: 20 * MIN },
  { id: "ticket-unsnooze", kind: "cron", owner: "cs", label: "Ticket unsnooze", description: "Wakes snoozed tickets whose snooze window has passed.", expectedCadence: "every 5 min (*/5 * * * *)", livenessWindowMs: 20 * MIN },
  // ─ Every-10-min crons (window ~40 min) ─
  { id: "abandoned-cart-reminder", kind: "cron", owner: "cmo", label: "Abandoned-cart reminder", description: "Sends abandoned-cart reminder sends on the rolling schedule.", expectedCadence: "every 10 min (*/10 * * * *)", livenessWindowMs: 40 * MIN },
  // ─ Every-15-min crons (window ~45 min) ─
  { id: "portal-action-healer", kind: "cron", owner: "retention", label: "Portal action healer", description: "Re-attempts failed portal actions (heal queue).", expectedCadence: "every 15 min (*/15 * * * *)", livenessWindowMs: 45 * MIN },
  { id: "ticket-csat-cron", kind: "cron", owner: "cs", label: "Ticket CSAT survey", description: "Sends CSAT surveys for eligible recently-closed tickets.", expectedCadence: "every 15 min (*/15 * * * *)", livenessWindowMs: 45 * MIN },
  {
    id: "spec-review-cron",
    kind: "cron",
    owner: "platform",
    label: "spec-review-cron",
    description: "Auto-proposed monitored loop for the spec-review-cron cron (every 15 min (*/15 * * * *)). Confirm the owner-function + cadence/window.",
    expectedCadence: "every 15 min (*/15 * * * *)",
    livenessWindowMs: 1 * HOUR,
    registeredAt: "2026-06-25T15:56:34Z",
  },
  // ─ Every-30-min crons (window ~90 min) ─
  { id: "ticket-analysis-cron", kind: "cron", owner: "cs", label: "Ticket analysis enqueue", description: "Feeds closed AI-handled tickets to the QC analyzer (analyzeTicket).", expectedCadence: "every 30 min (*/30 * * * *)", livenessWindowMs: 90 * MIN },
  {
    // fleet-spend-governor spec, Phase 2: the SUPERVISOR pass on the metered-cost proxy
    // (fleet-cost). Reads each effective fleet_budgets row vs. rollupFleetCost() and
    // ESCALATES on overrun via approval-router (a live+autonomous director, else CEO inbox)
    // + a director_activity row. Loop-guarded (one open breach per lane); NEVER throttles.
    // registeredAt graces the first-tick window (newcron-grace).
    id: "fleet-spend-governor",
    kind: "cron",
    owner: "platform",
    label: "Fleet spend governor",
    description: "Reads each effective fleet_budgets row vs. the fleet-cost rollup → escalates a lane/function over its ceiling (loop-guarded, never auto-throttles).",
    expectedCadence: "every ~30 min (10,40 * * * *)",
    livenessWindowMs: 90 * MIN,
    registeredAt: "2026-06-25T00:00:00Z",
  },
  // ─ Hourly crons (window ~2h) ─
  { id: "dunning-payday-retry-cron", kind: "cron", owner: "retention", label: "Dunning payday retry", description: "Hourly retry sweep of dunning cycles whose payday-retry time has arrived.", expectedCadence: "hourly (0 * * * *)", livenessWindowMs: 2 * HOUR, outputAssertion: "stuck-dunning" },
  { id: "sync-inventory", kind: "cron", owner: "platform", label: "Inventory sync", description: "Hourly product inventory sync.", expectedCadence: "hourly (0 * * * *)", livenessWindowMs: 2 * HOUR },
  { id: "portal-auto-resume-cron", kind: "cron", owner: "retention", label: "Portal auto-resume", description: "Resumes paused subscriptions whose pause_resume_at has passed.", expectedCadence: "hourly at :15 (15 * * * *)", livenessWindowMs: 2 * HOUR },
  // ─ Daily crons (window ~26h) ─
  {
    id: "acquisition-research-cadence-cron",
    kind: "cron",
    owner: "growth",
    label: "Acquisition research cadence",
    description: "Daily re-scan of approved competitors → promote category-sweep finds + materialize ad gaps + re-analyze landers. One of Rhea's research loops.",
    expectedCadence: "daily (0 10 * * *)",
    livenessWindowMs: 26 * HOUR,
    registeredAt: "2026-06-25T14:30:03.155Z",
    personaKind: "research", // Rhea — the acquisition-research crons merge into one Rhea worker under Max/Growth
  },
  {
    // rhea-research-automation spec, Phase 1: the paced hourly claim of the top-spend unreviewed
    // research URL. Per ad-tool workspace: sync research_urls → pick top ad_count unreviewed →
    // dedup on in-flight `research` agent_jobs → enqueue ONE `research` job carrying the url id.
    // Supersedes the slice-1 stub inside acquisition-research-cadence that enqueued a research job
    // once a day. Merges under Rhea (personaKind:'research') on the Growth org view.
    id: "research-sensor-cron",
    kind: "cron",
    owner: "growth",
    label: "Research sensor",
    description: "Hourly paced claim: sync research_urls + enqueue ONE `research` job carrying the top-ad_count unreviewed URL id, dedup-gated on any in-flight `research` job (true one-at-a-time).",
    expectedCadence: "hourly (0 * * * *)",
    livenessWindowMs: 2 * HOUR,
    registeredAt: "2026-07-03T00:00:00Z",
    personaKind: "research",
  },
  { id: "amazon-daily-sync", kind: "cron", owner: "growth", label: "Amazon daily sync", description: "Daily sync of the last 3 days of Amazon orders/spend.", expectedCadence: "daily (0 10 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "tickets-auto-archive", kind: "cron", owner: "cs", label: "Tickets auto-archive", description: "Archives stale resolved tickets.", expectedCadence: "daily (0 9 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "auto-blog-generate", kind: "cron", owner: "cmo", label: "Auto blog generator", description: "Daily SEO blog/content generation pass.", expectedCadence: "daily (0 13 * * *)", livenessWindowMs: 26 * HOUR },
  // daily-digest-channel spec, Phase 1: one aggregated FYI post/day to #daily-digest (build/ship recap +
  // dunning + notable ad-perf + ops-warning counts). registeredAt graces the first-tick window (newcron-grace).
  { id: "daily-digest-cron", kind: "cron", owner: "platform", label: "Daily digest", description: "One aggregated FYI post/day to #daily-digest — build/ship recap + dunning + notable ad-perf shifts + non-critical ops-warning counts, replacing the retired per-event FYI pings.", expectedCadence: "daily (0 13 * * *)", livenessWindowMs: 26 * HOUR, registeredAt: "2026-06-23T00:00:00Z" },
  // director-loop-grading spec, Phase 1: the Platform/DevOps Director's standing cadence — a daily cron
  // enqueueing the platform-director agent_jobs kind so escorting + watching happen on a reliable beat,
  // not only on inbound approvals. registeredAt graces the first-tick window (newcron-grace).
  { id: "platform-director-cron", kind: "cron", owner: "platform", label: "Platform Director cadence", description: "Daily enqueue of the Platform/DevOps Director standing pass (escort approved goals through milestones + watch the platform), in addition to the event-driven approval processing.", expectedCadence: "daily (15 12 * * *)", livenessWindowMs: 26 * HOUR, registeredAt: "2026-06-23T00:00:00Z" },
  { id: "brain-index-refresh", kind: "cron", owner: "platform", label: "Brain index refresh", description: "Rebuilds the docs/brain search index.", expectedCadence: "daily (0 9 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "security-dep-watch", kind: "cron", owner: "platform", label: "Security dep watch", description: "Daily CVE / dependency-upgrade watch (security-dependency-agent Phase 2): enqueues the box npm-audit scan that authors an owner-gated upgrade-fix spec on a vulnerable dep — never auto-bumps.", expectedCadence: "daily (0 4 * * *)", livenessWindowMs: 26 * HOUR, registeredAt: "2026-06-24T00:00:00Z" },
  { id: "security-diff-backstop-cron", kind: "cron", owner: "platform", label: "Security diff backstop (if-due)", description: "Cheap 15-min backstop for Vault's post-merge diff security review (fix-vault-post-merge-diff-backstop-7fbde0): re-sweeps recently-merged claude/* builds and enqueues a diff-mode security review for any orphaned merge SHA. Idempotent via the 14d SHA dedup inside enqueueSecurityReviewJob.", expectedCadence: "every 15m (*/15 * * * *)", livenessWindowMs: 90 * MIN, registeredAt: "2026-07-02T00:00:00Z" },
  { id: "chargeback-evidence-reminder", kind: "cron", owner: "retention", label: "Chargeback evidence reminder", description: "Reminds about chargebacks with evidence due.", expectedCadence: "daily (0 9 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "creative-finder-daily-cron", kind: "cron", owner: "growth", label: "Creative finder", description: "Daily creative/winning-ad discovery sweep — pulls approved competitors' running ads from AdLibrary + their destination URLs. Rhea's core research loop.", expectedCadence: "daily (0 9 * * *)", livenessWindowMs: 26 * HOUR, personaKind: "research" },
  {
    id: "creative-finder-video-process",
    kind: "cron",
    owner: "growth",
    label: "Creative finder (video)",
    description: "Daily drain of the video-creative backlog the 9:00 sweep parks — downloads + frames + transcribes competitor video ads. One of Rhea's research loops.",
    expectedCadence: "daily (30 9 * * *)",
    livenessWindowMs: 26 * HOUR,
    personaKind: "research",
    registeredAt: "2026-06-24T15:00:08.171Z",
  },
  { id: "crisis-daily-campaign", kind: "cron", owner: "cmo", label: "Crisis campaign tick", description: "Advances active crisis-comms campaigns.", expectedCadence: "daily (0 14 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "demographics-enrich-batch", kind: "cron", owner: "growth", label: "Demographics enrich batch", description: "Daily customer-demographics enrichment batch.", expectedCadence: "daily (0 6 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "daily-analysis-report-cron", kind: "cron", owner: "platform", label: "Daily analysis report", description: "Builds the daily AI ops/analysis report.", expectedCadence: "daily (0 11 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "director-recap-cron", kind: "cron", owner: "platform", label: "Director EOD recap", description: "Posts the end-of-day director standup recap to the #directors board + Daily Summaries.", expectedCadence: "daily (0 23 * * *)", livenessWindowMs: 26 * HOUR },
  // cs-director-storyline-digests-to-founder-with-bidirectional-reply Phase 1 — weekly composer that
  // rolls the CS Director's cs-director-call verdicts + recurring resolution-event problem patterns
  // into ONE cs_director_digests row per (workspace, week) instead of paging on every escalation.
  { id: "cs-director-digest-composer", kind: "cron", owner: "cs", label: "CS Director storyline digest composer", description: "Weekly: composes a cs_director_digests row per workspace from recent cs-director-call verdicts + recurring ticket_resolution_events problem patterns.", expectedCadence: "weekly (0 14 * * 1)", livenessWindowMs: 8 * DAY, registeredAt: "2026-07-07T12:00:00Z" },
  { id: "daily-order-snapshot", kind: "cron", owner: "platform", label: "Daily order snapshot", description: "Pre-computes the prior day's order snapshot.", expectedCadence: "daily (0 6 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "daily-order-snapshot-self-heal", kind: "cron", owner: "platform", label: "Order snapshot self-heal", description: "Back-fills any missing daily order snapshots.", expectedCadence: "daily (0 12 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "delivery-nightly-audit", kind: "cron", owner: "retention", label: "Delivery nightly audit", description: "Audits shipment delivery state nightly.", expectedCadence: "daily (0 11 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "featured-review-cards", kind: "cron", owner: "cmo", label: "Featured review cards", description: "Refreshes featured-review card generation.", expectedCadence: "daily (0 11 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "fraud-nightly-scan", kind: "cron", owner: "platform", label: "Fraud nightly scan", description: "Nightly batch fraud re-scan across recent orders.", expectedCadence: "daily (0 3 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "klaviyo-engagement-sync", kind: "cron", owner: "cmo", label: "Klaviyo engagement sync", description: "Daily Klaviyo engagement metrics sync.", expectedCadence: "daily (0 10 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "marketing-coupon-auto-disable", kind: "cron", owner: "cmo", label: "Marketing coupon auto-disable", description: "Auto-disables expired/over-budget marketing coupons.", expectedCadence: "daily (0 10 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "meta-performance-daily", kind: "cron", owner: "growth", label: "Meta performance pipeline", description: "Daily Meta ad performance iteration pipeline.", expectedCadence: "daily (30 11 * * *)", livenessWindowMs: 26 * HOUR },
  // growth-ad-spend-rail spec, Phase 3: daily SUPERVISOR pass on the ad-DOLLAR proxy. Fans out
  // one `growth/ad-spend-governor-sweep` event per workspace with ≥1 ad_spend_budgets row; each
  // pass rolls up daily_meta_ad_spend over the rolling window vs the ceiling and ESCALATES on a
  // 2-day trend over via platform-director.escalateDiagnosisToCeo (escalationKind='ad_spend_ceiling')
  // + a growth-owned director_activity row. NEVER pauses or throttles a campaign.
  // registeredAt graces the first-tick window (newcron-grace).
  { id: "growth-ad-spend-governor-cron", kind: "cron", owner: "growth", label: "Growth ad-spend governor", description: "Daily fan-out: reads each effective ad_spend_budgets row vs the rolling daily_meta_ad_spend sum → escalates a 2-day trend over the ceiling (loop-guarded, never auto-throttles).", expectedCadence: "daily (0 12 * * *)", livenessWindowMs: 26 * HOUR, registeredAt: "2026-06-30T12:00:00Z" },
  { id: "meta-daily-sync", kind: "cron", owner: "growth", label: "Meta daily spend sync", description: "Daily Meta account spend rollup sync.", expectedCadence: "daily (0 11 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "storefront-experiments-refresh-cron", kind: "cron", owner: "growth", label: "Storefront experiments refresh", description: "Every-5-min fan-out: recomputes attribution + bandit posteriors for running storefront experiments (near-live test stats). No-ops when no running experiments.", expectedCadence: "every 5 min (*/5 * * * *)", livenessWindowMs: 15 * MIN, registeredAt: "2026-06-22T17:45:00Z" },
  { id: "storefront-lever-decay-cron", kind: "cron", owner: "growth", label: "Storefront lever decay", description: "Daily fan-out: decays lever-importance posteriors toward their prior (re-probe stale levers).", expectedCadence: "daily (0 13 * * *)", livenessWindowMs: 26 * HOUR, registeredAt: "2026-06-22T19:07:00Z" },
  {
    id: "storefront-ltv-reconcile-cron",
    kind: "cron",
    owner: "growth",
    label: "storefront-ltv-reconcile-cron",
    description: "Auto-proposed monitored loop for the storefront-ltv-reconcile-cron cron (daily (0 14 * * *)). Confirm the owner-function + cadence/window.",
    expectedCadence: "daily (0 14 * * *)",
    livenessWindowMs: 26 * HOUR,
    registeredAt: "2026-06-23T16:00:05.906Z",
  },
  {
    id: "storefront-optimizer-cron",
    kind: "cron",
    owner: "growth",
    label: "storefront-optimizer-cron",
    description: "Auto-proposed monitored loop for the storefront-optimizer-cron cron (daily (30 14 * * *)). Confirm the owner-function + cadence/window.",
    expectedCadence: "daily (30 14 * * *)",
    livenessWindowMs: 26 * HOUR,
    registeredAt: "2026-06-23T16:00:06.292Z",
  },
  { id: "monthly-revenue-snapshot", kind: "cron", owner: "platform", label: "Revenue snapshot", description: "Pre-computes monthly revenue snapshots from daily data.", expectedCadence: "daily (0 7 * * *)", livenessWindowMs: 26 * HOUR },
  // loop-heartbeats-retention spec, Phase 1: daily prune so loop_heartbeats stays small + the
  // control_tower_loop_beats RPC stays fast. registeredAt claims the registered_not_firing grace
  // (a newly-added daily cron hasn't had its first tick yet — see control-tower-registered-not-firing-new-cron-grace).
  { id: "loop-heartbeats-prune", kind: "cron", owner: "platform", label: "Loop heartbeats prune", description: "Daily batched prune of loop_heartbeats older than 3 days — keeps the table small so the Control Tower beats RPC stays fast.", expectedCadence: "daily (30 8 * * *)", livenessWindowMs: 26 * HOUR, registeredAt: "2026-06-23T00:00:00Z" },
  { id: "refresh-customer-segments-cron", kind: "cron", owner: "growth", label: "Customer segment refresh", description: "Daily recompute of customer segments.", expectedCadence: "daily (0 11 * * *)", livenessWindowMs: 26 * HOUR, outputAssertion: "segment-coverage" },
  {
    id: "refund-settlement-reconcile",
    kind: "cron",
    owner: "platform",
    label: "refund-settlement-reconcile",
    description: "Auto-proposed monitored loop for the refund-settlement-reconcile cron (daily (15 6 * * *)). Confirm the owner-function + cadence/window.",
    expectedCadence: "daily (15 6 * * *)",
    livenessWindowMs: 26 * HOUR,
    registeredAt: "2026-07-08T08:15:04.399Z",
  },
  // SMS Marketing Agent (Margo, under Iris/CMO) — daily cadence engine. personaKind surfaces it
  // as a worker under Iris on the org chart. registeredAt claims the new-cron grace (dormant until
  // sms_marketing_policy.active=true, so it fires the heartbeat but takes no send action yet).
  { id: "sms-marketing-cron", kind: "cron", owner: "cmo", label: "SMS marketing agent", description: "Daily cadence engine — on a valid send window (Sun/Mon/Thu/Sat AM, Tue PM) builds + schedules one theme's per-segment VIP/Weekend campaigns within Iris's leash. Dormant until sms_marketing_policy.active=true.", expectedCadence: "daily (0 12 * * *)", livenessWindowMs: 26 * HOUR, personaKind: "sms-marketing", registeredAt: "2026-07-04T12:00:00Z" },
  { id: "social-insights-sync", kind: "cron", owner: "cmo", label: "Social insights sync", description: "Daily organic-social insights/metrics sync.", expectedCadence: "daily (30 8 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "sonnet-prompt-auto-review", kind: "cron", owner: "cs", label: "Sonnet prompt auto-review", description: "Daily auto-review of the orchestrator prompt against recent decisions.", expectedCadence: "daily (0 11 * * *)", livenessWindowMs: 26 * HOUR },
  { id: "sync-klaviyo-reviews", kind: "cron", owner: "cmo", label: "Klaviyo reviews sync", description: "Daily product-review sync from Klaviyo.", expectedCadence: "daily (0 3 * * *)", livenessWindowMs: 26 * HOUR },
  // ─ Weekly crons (window ~8 days) ─
  { id: "demographics-snapshot-builder", kind: "cron", owner: "growth", label: "Demographics snapshot builder", description: "Weekly customer-demographics snapshot build.", expectedCadence: "weekly Sun (0 8 * * 0)", livenessWindowMs: 8 * DAY },
  { id: "reseller-discovery-weekly", kind: "cron", owner: "growth", label: "Reseller discovery", description: "Weekly Amazon SP-API reseller scan.", expectedCadence: "weekly Mon (0 12 * * 1)", livenessWindowMs: 8 * DAY },
  { id: "reviews/tag-cancel-relevance-cron", kind: "cron", owner: "retention", label: "Review cancel-relevance tagging", description: "Weekly tagging of cancel-relevant reviews.", expectedCadence: "weekly Mon (0 4 * * 1)", livenessWindowMs: 8 * DAY },
  {
    id: "playbook-compiler",
    kind: "cron",
    owner: "platform",
    label: "playbook-compiler",
    description: "Auto-proposed monitored loop for the playbook-compiler cron (weekly (0 12 * * 1)). Confirm the owner-function + cadence/window.",
    expectedCadence: "weekly (0 12 * * 1)",
    livenessWindowMs: 8 * DAY,
    registeredAt: "2026-07-08T08:15:04.473Z",
  },
  // ─ Yearly cron (window ~370 days) ─

  // ── CEO's executive-assistant agent (owner=ceo) ─────────────────────────────
  // god-mode-becomes-ceo-executive-assistant-agent Phase 1: registers Eve's lane so the
  // god-mode cockpit's activity has a home in the loop registry with a NON-Platform owner.
  // She reports to the founder (Henry), not to a director, so `owner: "ceo"` — the reason
  // OwnerFunction was widened. Phase 2 will render her under the CEO seat (workers alongside
  // the goals) with liveness derived from god_mode_sessions activity, and wire her actions
  // to the existing god-mode PIN + risk-tier approvals ([[../../docs/brain/libraries/god-mode]]).
  {
    id: "god-mode-cockpit",
    kind: "reactive",
    owner: "ceo",
    personaKind: "god-mode", // Eve — the founder's phone-to-box executive assistant
    label: "God-mode cockpit",
    description: "The CEO's executive assistant — the founder's phone-to-box cockpit for reads/diagnostics + risky writes gated on live approval + PIN. Deliberately loose window (a dormant cockpit is healthy — the founder isn't always mid-incident).",
    expectedCadence: "per founder cockpit session",
    livenessWindowMs: 30 * DAY,
    errorRateThreshold: 0.5,
    minRunsForErrorRate: 5,
    registeredAt: "2026-07-07T18:00:00Z",
  },

  // ── Reactive event-driven Inngest agents (loop_heartbeats, loop_id = inngest fn id) ──
  // Event-driven (not crons, not the box queue). Idle = green; alerted on
  // liveness-when-work-exists / error-rate (same logic as inline-agent). Each beats once
  // at end-of-run (end-of-run try/finally — ok:false on throw). (control-tower-complete-coverage P1.)
  {
    id: "slack-delivery",
    kind: "reactive",
    owner: "platform",
    label: "Slack delivery",
    description: "ONE monitor for ALL Slack comms (#alerts-critical, #daily-digest, ops + ticket notifications) — beats on every successful chat.postMessage (src/lib/slack.ts). Replaces per-channel cron monitors: a sustained delivery outage (revoked token / Slack down) stops the beats. The daily digest guarantees a beat every ~24h, so a red here means Slack genuinely isn't delivering — not that one channel was quiet.",
    expectedCadence: "every successful Slack send (≥ daily via the digest)",
    livenessWindowMs: 28 * HOUR,
  },
  {
    id: "unified-ticket-handler",
    kind: "reactive",
    owner: "cs",
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
    owner: "retention",
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
    owner: "retention",
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
    owner: "retention",
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
    owner: "cs",
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
    owner: "retention",
    label: "Chargeback received",
    description: "Handles an inbound chargeback — cancels subs, assembles evidence, notifies.",
    expectedCadence: "per chargeback event",
    livenessWindowMs: 24 * HOUR,
    errorRateThreshold: 0.5,
    minRunsForErrorRate: 5,
  },

  // ── Auto-Ship Pipeline — auto-merge gate (loop_heartbeats, loop_id = AUTO_MERGE_GATE_LOOP_ID) ──
  // Gate A (auto-ship-pipeline spec, Phase 1): the GitHub webhook squash-merges ready (mergeable +
  // all-checks-green) claude/* build PRs — the READY mirror of the dirty-PR resolver's CONFLICTING half.
  // Runs in the webhook route (not an Inngest fn / box lane), so it's a `reactive` loop: idle = green,
  // beats once per pass (ok:false on a failed merge attempt, feeding the error-rate assertion). No
  // work-exists signal (no clean upstream-demand probe) — error-rate only.
  {
    id: AUTO_MERGE_GATE_LOOP_ID,
    kind: "reactive",
    owner: "platform",
    label: "Auto-merge gate",
    description:
      "Squash-merges ready (mergeable + all-checks-green) claude/* build PRs from the GitHub webhook — serialized (one per pass), sync-aware, owner kill-switch (workspaces.auto_merge_enabled). The dirty-PR resolver's READY mirror.",
    expectedCadence: "per GitHub push/PR/check webhook",
    livenessWindowMs: 24 * HOUR,
    errorRateThreshold: 0.5,
    minRunsForErrorRate: 5,
  },

  // ── Auto-Ship Pipeline — auto-fold gate (loop_heartbeats, loop_id = AUTO_FOLD_GATE_LOOP_ID) ──
  // Gate B (auto-ship-pipeline spec, Phase 2): auto-folds fully-verified shipped specs (agent-verdict
  // approved + 0 human checks waiting/failed + 0 regressions) via enqueue_fold — the all-green mirror of
  // the owner's "Mark verified & archive" click. Runs reactively (spec-test completion / human-check
  // resolution) + periodically (the spec-test cron), so it's a `reactive` loop: idle = green, beats once
  // per pass (ok:false on a failed enqueue, feeding the error-rate assertion). No work-exists signal —
  // error-rate only (the eligible-spec set is the demand, but there's no independent upstream count probe).
  {
    id: AUTO_FOLD_GATE_LOOP_ID,
    kind: "reactive",
    owner: "platform",
    label: "Auto-fold gate",
    description:
      "Auto-folds fully-verified shipped specs (agent-verdict approved + 0 human checks waiting/failed + 0 regressions) via enqueue_fold — the all-green mirror of the owner's Mark-verified-&-archive click. Owner kill-switch (workspaces.auto_fold_enabled), coalesced into the batch fold-build.",
    expectedCadence: "per spec-test completion / human-check resolution + daily sweep",
    livenessWindowMs: 30 * HOUR,
    errorRateThreshold: 0.5,
    minRunsForErrorRate: 5,
  },

  // ── Box agent-kind lanes (loop_heartbeats, loop_id = `agent:<kind>`) ───────
  // Idle = green. Alerted only on a STUCK job past the per-kind threshold.
  { id: "agent:build", kind: "agent-kind", owner: "platform", agentKind: "build", label: "Agent — build", description: "Spec → PR feature builds (Max).", expectedCadence: "on demand", stuckThresholdMs: 2 * HOUR },
  { id: "agent:plan", kind: "agent-kind", owner: "platform", agentKind: "plan", label: "Agent — plan", description: "Goal-decomposition planning passes.", expectedCadence: "on demand", stuckThresholdMs: 1 * HOUR },
  { id: "agent:fold", kind: "agent-kind", owner: "platform", agentKind: "fold", label: "Agent — fold", description: "Spec → brain fold batches.", expectedCadence: "on demand", stuckThresholdMs: 45 * MIN },
  { id: "agent:product-seed", kind: "agent-kind", owner: "cmo", agentKind: "product-seed", label: "Agent — product seed", description: "Product none → published pipeline.", expectedCadence: "on demand", stuckThresholdMs: 90 * MIN },
  { id: "agent:spec-chat", kind: "agent-kind", owner: "platform", agentKind: "spec-chat", label: "Agent — spec chat", description: "Roadmap authoring-chat turns.", expectedCadence: "on demand", stuckThresholdMs: 30 * MIN },
  { id: "agent:ticket-improve", kind: "agent-kind", owner: "cs", agentKind: "ticket-improve", label: "Agent — ticket improve", description: "CX ticket-improve turns.", expectedCadence: "on demand", stuckThresholdMs: 30 * MIN },
  // Per-ticket QC-grader box lane (ticket-analyzer-becomes-box-agent-under-june Phase 1) — the
  // supervised agent under 💬 June (CS Director) that replaced the analyzer's direct fetch to
  // api.anthropic.com. Enqueued by ticket-analysis-cron; drained by scripts/builder-worker.ts →
  // runTicketAnalyzeJob as top-level Max `claude -p` sessions. Idle = green (on demand); alerted
  // only on a stuck job past the threshold. Same owner=cs as the feeder cron.
  { id: "agent:ticket-analyze", kind: "agent-kind", owner: "cs", agentKind: "ticket-analyze", label: "Agent — ticket analyze", description: "Per-ticket QC grader (box-session under 💬 June).", expectedCadence: "when a closed AI-handled ticket is enqueued", stuckThresholdMs: 30 * MIN, registeredAt: "2026-07-07T14:00:00Z" },
  { id: "agent:triage-escalations", kind: "agent-kind", owner: "cs", agentKind: "triage-escalations", label: "Agent — triage sweep", description: "Solver→skeptic→quorum escalation sweep.", expectedCadence: "hourly when work exists", stuckThresholdMs: 90 * MIN },
  { id: "agent:prompt-review", kind: "agent-kind", owner: "cs", agentKind: "prompt-review", label: "Agent — prompt review", description: "Per-proposal sonnet_prompt auto-review — a supervised box-session agent under June (CS Director), replacing the retired direct-Opus fetch. Emits one JSON verdict; the deterministic runner applies it via applyDecision (REJECT_FLOOR + never-queue-to-humans preserved).", expectedCadence: "daily when work exists", stuckThresholdMs: 60 * MIN },
  { id: "agent:spec-test", kind: "agent-kind", owner: "platform", agentKind: "spec-test", label: "Agent — spec test", description: "Non-destructive spec QA pass.", expectedCadence: "daily when work exists", stuckThresholdMs: 60 * MIN },
  { id: "agent:migration-fix", kind: "agent-kind", owner: "retention", agentKind: "migration-fix", label: "Agent — migration fix", description: "Event-fired billing repair diagnosis.", expectedCadence: "on demand", stuckThresholdMs: 60 * MIN },
  { id: "agent:dev-ask", kind: "agent-kind", owner: "platform", agentKind: "dev-ask", label: "Agent — dev ask", description: "Read-only developer message-center turns.", expectedCadence: "on demand", stuckThresholdMs: 30 * MIN },
  { id: "agent:pr-resolve", kind: "agent-kind", owner: "platform", agentKind: "pr-resolve", label: "Agent — PR resolve", description: "Webhook-fired dirty-PR resolver: merge main + resolve conflicts, tsc-gate, push (or rebuild/surface).", expectedCadence: "on demand", stuckThresholdMs: 45 * MIN },
  { id: "agent:repair", kind: "agent-kind", owner: "platform", agentKind: "repair", label: "Agent — repair", description: "Event-fired Control Tower triage: diagnose a new error_events signature / loop_alert read-only → author a fix spec + surface for owner Build (or no-op-resolve transient / surface needs-human). The repairer is watched too.", expectedCadence: "on demand", stuckThresholdMs: 60 * MIN },
  { id: "agent:regression", kind: "agent-kind", owner: "platform", agentKind: "regression", label: "Agent — regression", description: "Event-fired the moment the spec-test agent records a regression: review it, dismiss the flaky/false ones, author a fix spec directly. Remi is watched too.", expectedCadence: "on demand", stuckThresholdMs: 60 * MIN },
  { id: "agent:security-review", kind: "agent-kind", owner: "platform", agentKind: "security-review", label: "Agent — security review", description: "The supervisor on the auto-merge proxy: every merged claude/* diff gets an autonomous security pass (injection / secret-leak / authz / RLS / unsafe admin-client) read-only → classify each finding → author a scoped fix spec + surface for owner Build (or surface needs-human), never auto-mutating. Also runs the daily npm-audit dep-watch scan. Vault is watched too.", expectedCadence: "on demand", stuckThresholdMs: 60 * MIN },
  { id: "agent:coverage-register", kind: "agent-kind", owner: "platform", agentKind: "coverage-register", label: "Agent — coverage register", description: "The coverage-gap supervisor: when the Control Tower monitor finds an unregistered loop, Cole investigates read-only → proposes register-vs-exempt (a multi-CHOICE the CEO decides), keeping the monitored-loops registry honest. Never auto-mutates the registry. Cole is watched too.", expectedCadence: "on demand", stuckThresholdMs: 60 * MIN },
  { id: "agent:spec-review", kind: "agent-kind", owner: "platform", agentKind: "spec-review", label: "Agent — spec review", description: "Vale, the quality gate ahead of the build pipeline: the moment a spec enters In Review (newly authored, or flagged back by anyone who spots an issue), she reviews it against the authoring guidelines read-only → fixes a malformed spec in place (mangled phases / missing owner+parent / blockers / DB-companion) → passes the well-formed ones to the director for the Planned/Deferred call. An in_review spec can NEVER build until it's cleared. Reactive on the in_review transition + a cron backstop. Vale is watched too.", expectedCadence: "on demand", stuckThresholdMs: 60 * MIN },
  { id: "agent:storefront-optimizer", kind: "agent-kind", owner: "growth", agentKind: "storefront-optimizer", label: "Agent — storefront optimizer", description: "Scheduled campaign loop: read funnel + lever map + LTV proxy → propose ONE atomic reversible-lever hypothesis → stand up an M1 experiment vs holdout (auto-run reversible or surface for owner Approve), or author a missing-capability spec + surface for Build. The optimizer is watched too.", expectedCadence: "daily when work exists", stuckThresholdMs: 60 * MIN },
  { id: "agent:dr-content", kind: "agent-kind", owner: "growth", agentKind: "dr-content", label: "Agent — DR content (Carrie)", description: "Direct-response content lane: on a queued lander blueprint, read our product intelligence → write intense/emotional/urgency DR copy for every block, generate the AI-appropriate imagery (Nano Banana Pro), and flag real-asset gaps (before/after, UGC, press logos) to Max → fill the content bucket to 100% before Cleo specs the build.", expectedCadence: "when a lander blueprint is queued", stuckThresholdMs: 60 * MIN },

  // ── Inline event-driven AI agents (loop_heartbeats, loop_id = `ai:<agent>`) ──
  // Server-side AI agents that run per-ticket / per-order / per-journey, not on a queue or
  // cron. Each beats once at the END of every run (try/finally). No fixed cadence ⇒ a
  // genuinely-idle agent (no work waiting) is GREEN; red only on liveness-when-work-exists
  // (upstream work waits but 0 successful beats in the window) or an error-rate spike.
  {
    id: INLINE_AGENT_IDS.ticketAnalyzer,
    kind: "inline-agent",
    owner: "cs",
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
    owner: "retention",
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
    owner: "platform",
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
    owner: "cs",
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
