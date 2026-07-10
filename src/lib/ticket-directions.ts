/**
 * ticket-directions — the SDK Sol's first-touch box session (runTicketHandleJob) uses to write /
 * supersede / read the durable Direction artifact backing `public.ticket_directions`. One live row
 * per ticket (partial UNIQUE on `ticket_id WHERE superseded_at IS NULL`); a rare inflection calls
 * `superseDirection` then `writeDirection` — never an in-place UPDATE. Every write goes through
 * a service-role client passed in by the caller (createAdminClient in the worker). See
 * docs/brain/tables/ticket_directions.md + docs/brain/libraries/ticket-directions.md +
 * docs/brain/specs/sol-ticket-direction-artifact-and-first-touch-box-session.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient;

export type TicketDirectionPath = "playbook" | "journey" | "workflow" | "stateless" | "needs_info";

/**
 * Shape Sol writes into `ticket_directions.plan` — path-specific but pinned so the writer can
 * gate the field validity before the row lands. Phase 1 of
 * [[../specs/sol-session-chosen-playbook-selection-retire-brittle-triggers]] retires the
 * signal-based playbook matcher for the Sol cohort: playbook selection becomes a Direction
 * field (`playbook_slug`) chosen by full-context reasoning at first-touch. Extra keys are
 * preserved (path-specific ad-hoc knobs Sol may add — see the ticket-handle skill's guardrail
 * examples), but the validator below rejects a `playbook` chosen_path that omits `playbook_slug`
 * or points at a slug that does not exist in `public.playbooks` for this workspace.
 */
export interface TicketDirectionPlan {
  /** Present when `chosen_path='playbook'` — the slug of the playbook Sol chose. */
  playbook_slug?: string;
  /** Present when `chosen_path='playbook'` — order/subscription ids the playbook needs on step 0. */
  playbook_seed_context?: Record<string, unknown>;
  /**
   * Present when `chosen_path='journey'` — the slug of the [[../tables/journey_definitions]] row Sol
   * chose from the [[../libraries/cx-agent-sdk]] `listActionableOutcomes` catalog. Phase 1 of
   * [[../specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta]] — a real
   * catalog row Phase 2 will `launchJourneyForTicket`, not a prose "click below" reference.
   */
  journey_slug?: string;
  /**
   * Present when `chosen_path='workflow'` — the `trigger_tag` of the [[../tables/workflows]] row Sol
   * chose from the mechanisms catalog (workflows have no slug; `trigger_tag`, e.g. `smart:account_login`,
   * is the stable identifier the executor resolves). Validated against an `enabled` workflow in this
   * workspace before the row lands; cheap-execution APPLIES it via [[sol-direction-apply]] /
   * [[tickets-mutate]] `runWorkflow`.
   */
  workflow_tag?: string;
  /** Present when `chosen_path='stateless'` — usually `"send_stateless_reply"`. */
  action?: string;
  /** Present when `chosen_path='needs_info'` — the concrete list of missing pieces to ask for. */
  needs?: unknown[];
  /**
   * Optional across all chosen_paths — the slug of a STANDALONE journey_definitions row Sol
   * wants launched (via [[../libraries/journey-delivery]] `launchJourneyForTicket`) with NO
   * active playbook. Phase 1 of
   * [[../specs/sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend]]:
   * a move signal ('I moved', 'new address', 'changed address', 'cancel, I moved') is treated
   * as an address-update intent, and Sol sets `launch_journey_slug: 'shipping-address'` so the
   * standalone Confirm Shipping Address journey fires — its completion routes to the
   * internal-aware `update_shipping_address` handler (action-executor → commerce/subscription
   * `subscriptionUpdateShippingAddress`, which branches internal vs Appstle) with EasyPost
   * validation, actually persisting the change to the active subscription. Do NOT set this
   * when the journey should instead be a step of a playbook — a `playbook` chosen_path drives
   * the playbook itself, and its own executor decides when to launch a journey step. The
   * writer validates that the slug resolves to a live `journey_definitions` row for this
   * workspace before the Direction lands (mirrors the `playbook_slug` gate — same
   * confirming-predicate pattern).
   */
  launch_journey_slug?: string;
  [k: string]: unknown;
}

export interface TicketDirection {
  id: string;
  workspace_id: string;
  ticket_id: string;
  intent: string;
  context_summary: string;
  chosen_path: TicketDirectionPath;
  plan: TicketDirectionPlan;
  guardrails: Record<string, unknown>;
  authored_by: string;
  authored_at: string;
  superseded_at: string | null;
  /**
   * Anti-runaway re-session counter — Phase 1 of
   * [[../specs/sol-runaway-re-session-cap-guardrail]]. Zero on the first Direction; incremented
   * by the router ([[../inflection-detector]] `reSessionSol` — Phase 2) on every re-session so
   * the cap check (`>= ai_channel_config.sol_max_resessions`) can fire.
   */
  resession_count: number;
}

/**
 * Typed validation error raised by {@link writeDirection} when the input plan does not satisfy
 * the path-specific contract (playbook chose but no slug, unknown slug for the workspace, …).
 * The error carries a stable `code` so callers can render user-legible diagnostics without
 * string-matching on `message`.
 */
export class TicketDirectionPlanError extends Error {
  readonly code:
    | "playbook_slug_missing"
    | "playbook_slug_unknown"
    | "playbook_slug_not_string"
    | "journey_slug_missing"
    | "journey_slug_not_string"
    | "journey_slug_unknown"
    | "workflow_tag_missing"
    | "workflow_tag_unknown"
    | "workflow_tag_not_string";
  readonly slug?: string;
  constructor(
    code: TicketDirectionPlanError["code"],
    message: string,
    opts?: { slug?: string },
  ) {
    super(message);
    this.name = "TicketDirectionPlanError";
    this.code = code;
    this.slug = opts?.slug;
  }
}

const COLS =
  "id, workspace_id, ticket_id, intent, context_summary, chosen_path, plan, guardrails, authored_by, authored_at, superseded_at, resession_count";

/**
 * Insert one live Direction for a ticket. The DB-level partial UNIQUE
 * `(ticket_id) WHERE superseded_at IS NULL` guarantees exactly one live row per ticket —
 * a concurrent second `writeDirection` on the same ticket errors here (23505 unique_violation).
 * The caller (Sol's session) is expected to `superseDirection` first when re-authoring.
 */
export async function writeDirection(
  admin: Admin,
  input: {
    workspace_id: string;
    ticket_id: string;
    intent: string;
    context_summary: string;
    chosen_path: TicketDirectionPath;
    plan?: TicketDirectionPlan;
    guardrails?: Record<string, unknown>;
    authored_by?: string;
  },
): Promise<TicketDirection> {
  const plan: TicketDirectionPlan = input.plan ?? {};
  await validatePlanForPath(admin, input.workspace_id, input.chosen_path, plan);
  const { data, error } = await admin
    .from("ticket_directions")
    .insert({
      workspace_id: input.workspace_id,
      ticket_id: input.ticket_id,
      intent: input.intent,
      context_summary: input.context_summary,
      chosen_path: input.chosen_path,
      plan,
      guardrails: input.guardrails ?? {},
      authored_by: input.authored_by ?? "sol_box_session",
    })
    .select(COLS)
    .single();
  if (error) throw error;
  return data as TicketDirection;
}

/**
 * Path-specific plan validator — Phase 1 of
 * [[../specs/sol-session-chosen-playbook-selection-retire-brittle-triggers]] (playbook branch) and
 * Phase 1 of [[../specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta]]
 * (journey branch). When Sol commits a ticket to a `playbook` or `journey` chosen_path, she MUST
 * name the target mechanism by slug (`plan.playbook_slug` / `plan.journey_slug`); the writer
 * confirms the slug exists (and is_active for journeys) for the ticket's workspace before the row
 * lands, so downstream cheap-execution can dispatch it without re-running any deterministic
 * matcher. Applies re-assertion of the read-time precondition (learning #6 — the write's guarantee
 * is the confirming predicate, not a coarser proxy): an unknown slug bails HERE, not at the
 * executor step 0 / `launchJourneyForTicket`.
 *
 * Stateless / needs_info are shape-only (no cross-table lookup). Extra plan keys are preserved
 * (Sol may add path-specific ad-hoc context — see the ticket-handle skill), but a `playbook` or
 * `journey` chosen_path with a missing / non-string / unknown slug throws
 * {@link TicketDirectionPlanError} with the slug echoed on the exception so the caller
 * (runTicketHandleJob → the worker) can surface it verbatim in the box-session log.
 */
async function validatePlanForPath(
  admin: Admin,
  workspace_id: string,
  chosen_path: TicketDirectionPath,
  plan: TicketDirectionPlan,
): Promise<void> {
  if (chosen_path === "playbook") {
    const rawSlug = plan.playbook_slug;
    if (rawSlug === undefined || rawSlug === null) {
      throw new TicketDirectionPlanError(
        "playbook_slug_missing",
        "chosen_path='playbook' requires plan.playbook_slug",
      );
    }
    // Phase 3 of [[../../docs/brain/specs/sol-reviews-policies-and-never-bais-an-out-of-policy-outcome-full-research-session]]:
    // trim + length-check so a WHITESPACE-only slug (Sol trying to satisfy the field without
    // a real match) throws the same typed rejection an empty slug does. Sol's honest-stateless
    // rule is "no playbook match → chosen_path='stateless'"; a "   " slug is the anti-pattern
    // the rule exists to prevent, and lumping it in with playbook_slug_unknown would read as
    // "we don't have that playbook" downstream rather than the truer "you didn't pick one".
    if (typeof rawSlug !== "string" || rawSlug.trim().length === 0) {
      throw new TicketDirectionPlanError(
        "playbook_slug_not_string",
        "plan.playbook_slug must be a non-empty, non-whitespace string — no playbook match means chosen_path='stateless', never 'playbook' with an empty slug",
      );
    }
    const { data, error } = await admin
      .from("playbooks")
      .select("id")
      .eq("workspace_id", workspace_id)
      .eq("slug", rawSlug)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new TicketDirectionPlanError(
        "playbook_slug_unknown",
        `plan.playbook_slug='${rawSlug}' does not match any playbook in this workspace`,
        { slug: rawSlug },
      );
    }
  }
  if (chosen_path === "journey") {
    // Phase 1 of [[../../docs/brain/specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta]]:
    // Sol names the matched journey slug from the deterministic catalog reader
    // ([[../libraries/cx-agent-sdk]] `listActionableOutcomes`) on the Direction so Phase 2 can
    // APPLY the mechanism via launchJourneyForTicket — never a freeform "click below" reply.
    // The writer confirms the slug points at a live, is_active row in this workspace so the
    // typed rejection fires HERE (not at the executor), same "confirming predicate at the
    // action point" pattern the playbook_slug guard uses (learning #6).
    const rawSlug = plan.journey_slug;
    if (rawSlug === undefined || rawSlug === null) {
      throw new TicketDirectionPlanError(
        "journey_slug_missing",
        "chosen_path='journey' requires plan.journey_slug",
      );
    }
    if (typeof rawSlug !== "string" || rawSlug.trim().length === 0) {
      throw new TicketDirectionPlanError(
        "journey_slug_not_string",
        "plan.journey_slug must be a non-empty, non-whitespace string — no journey match means chosen_path='stateless', never 'journey' with an empty slug",
      );
    }
    const { data, error } = await admin
      .from("journey_definitions")
      .select("id")
      .eq("workspace_id", workspace_id)
      .eq("slug", rawSlug)
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new TicketDirectionPlanError(
        "journey_slug_unknown",
        `plan.journey_slug='${rawSlug}' does not match any active journey in this workspace`,
        { slug: rawSlug },
      );
    }
  }
  if (chosen_path === "workflow") {
    // Workflows have no slug — the stable identifier is `trigger_tag` (e.g. `smart:account_login`),
    // the same handle [[tickets-mutate]] `runWorkflow` resolves. Confirm it points at an `enabled`
    // workflow in this workspace so the typed rejection fires HERE, not at the executor.
    const rawTag = plan.workflow_tag;
    if (rawTag === undefined || rawTag === null) {
      throw new TicketDirectionPlanError(
        "workflow_tag_missing",
        "chosen_path='workflow' requires plan.workflow_tag",
      );
    }
    if (typeof rawTag !== "string" || rawTag.trim().length === 0) {
      throw new TicketDirectionPlanError(
        "workflow_tag_not_string",
        "plan.workflow_tag must be a non-empty, non-whitespace string — no workflow match means chosen_path='stateless', never 'workflow' with an empty tag",
      );
    }
    const { data, error } = await admin
      .from("workflows")
      .select("id")
      .eq("workspace_id", workspace_id)
      .eq("trigger_tag", rawTag)
      .eq("enabled", true)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new TicketDirectionPlanError(
        "workflow_tag_unknown",
        `plan.workflow_tag='${rawTag}' does not match any enabled workflow in this workspace`,
        { slug: rawTag },
      );
    }
  }
  // launch_journey_slug (sol-reads-moved) applies to ALL chosen_paths — a stateless reply that
  // also launches the standalone address-update journey still routes through this gate. The
  // per-path blocks above no longer early-return, so execution always reaches this gate.
  await validateLaunchJourneySlug(admin, workspace_id, plan);
}

/**
 * Journey-slug plan validator — Phase 1 of
 * [[../specs/sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend]].
 * When Sol names a standalone journey to launch (`plan.launch_journey_slug`), the writer
 * re-asserts the read-time precondition BEFORE the row lands (learning #6 — the confirming
 * predicate lives at the action point, not a coarser proxy): the slug must be a non-empty
 * string AND must resolve to an active `journey_definitions` row scoped to this workspace.
 * A missing / non-string / whitespace-only value throws `journey_slug_not_string`; a slug
 * that doesn't resolve throws `journey_slug_unknown` with the slug echoed on the exception so
 * the caller (runTicketHandleJob → the worker) can surface it verbatim in the box-session log
 * instead of letting the row land with a slug the launcher can't dispatch.
 *
 * Applies to ALL chosen_paths — a stateless reply that also launches the address-update
 * journey (Phase 1's expected shape) still routes through this gate.
 */
async function validateLaunchJourneySlug(
  admin: Admin,
  workspace_id: string,
  plan: TicketDirectionPlan,
): Promise<void> {
  if (plan.launch_journey_slug === undefined || plan.launch_journey_slug === null) return;
  const raw = plan.launch_journey_slug;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new TicketDirectionPlanError(
      "journey_slug_not_string",
      "plan.launch_journey_slug must be a non-empty, non-whitespace string — omit the field when no standalone journey should launch",
    );
  }
  const { data, error } = await admin
    .from("journey_definitions")
    .select("id")
    .eq("workspace_id", workspace_id)
    .eq("slug", raw)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new TicketDirectionPlanError(
      "journey_slug_unknown",
      `plan.launch_journey_slug='${raw}' does not match any active journey_definitions row in this workspace`,
      { slug: raw },
    );
  }
}

/**
 * Mark the currently-live Direction for `ticket_id` as superseded. Compare-and-set on
 * `superseded_at IS NULL` (per Learning #1 — a re-assertion of the read-time invariant at the
 * write): if the live row got stamped by a racing caller between read and write, we get zero rows
 * back and return `null` so the caller can bail instead of overwriting a stale timestamp. Scoped by
 * `workspace_id` when supplied so a cross-workspace ticket-id collision can't cross the boundary.
 * Returns the superseded row (or null when no live row existed / another caller won the race).
 */
export async function superseDirection(
  admin: Admin,
  ticket_id: string,
  opts?: { workspace_id?: string },
): Promise<TicketDirection | null> {
  let q = admin
    .from("ticket_directions")
    .update({ superseded_at: new Date().toISOString() })
    .eq("ticket_id", ticket_id)
    .is("superseded_at", null);
  if (opts?.workspace_id) q = q.eq("workspace_id", opts.workspace_id);
  const { data, error } = await q.select(COLS);
  if (error) throw error;
  const rows = (data ?? []) as TicketDirection[];
  return rows[0] ?? null;
}

/**
 * Read the live Direction (superseded_at IS NULL) for a ticket, or null when Sol hasn't authored
 * one yet (or the last one was superseded and not re-authored). Downstream cheap-execution turns
 * drive off `chosen_path` + `plan` + `guardrails` here instead of re-running full-context reasoning.
 */
export async function getLiveDirection(
  admin: Admin,
  ticket_id: string,
  opts?: { workspace_id?: string },
): Promise<TicketDirection | null> {
  let q = admin
    .from("ticket_directions")
    .select(COLS)
    .eq("ticket_id", ticket_id)
    .is("superseded_at", null);
  if (opts?.workspace_id) q = q.eq("workspace_id", opts.workspace_id);
  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return (data as TicketDirection | null) ?? null;
}

/**
 * Alias for {@link getLiveDirection}. The Sol cheap-execution spec (M2) names the accessor
 * `loadLiveDirection` at its Phase-2 orchestrator wire-in; keeping both names is intentional so
 * downstream call sites can read the more precise verb (`load`) at the branch point without
 * changing the M1 SDK's shipped name.
 */
export const loadLiveDirection = getLiveDirection;

/**
 * message_sent → close. Phase 1 of
 * [[../specs/sol-closes-ticket-on-resolving-reply-so-cora-grades-it]].
 *
 * Sol's first-touch box session ([[../inngest/unified-ticket-handler]] `runTicketHandleJob` in
 * scripts/builder-worker.ts) sends a resolving reply through `deliverTicketMessage` but never
 * closes the ticket — so it stays `open` and the [[ticket-analyzer]] closed-tickets-only sweep
 * never enqueues Cora to grade it. This helper is the single, shared "message_sent → close"
 * write mirroring the old handler's [[../inngest/unified-ticket-handler]] `setStatus` semantics
 * (documented rule: "message_sent → close the ticket; next inbound reopens"), so the box lane
 * and the Inngest lane close identically. NOT a parallel path — same six-field update:
 * `status='closed'`, `closed_at=now`, `updated_at=now`, and clears the escalation triple so a
 * previously-escalated-then-resolved ticket doesn't linger in the escalation view.
 *
 * Guarded by workspace_id (Learning #6 — the confirming predicate at the action point, not a
 * coarser proxy): a cross-workspace ticket id can never authorize the close. Compare-and-set on
 * `.eq('workspace_id', …).eq('id', …)`; the write is idempotent for the message_sent case (a
 * racing close from a follow-up turn is a no-op — the row is already closed).
 */
export async function closeTicketOnResolvingReply(
  admin: Admin,
  opts: { workspace_id: string; ticket_id: string },
): Promise<void> {
  const now = new Date().toISOString();
  await admin
    .from("tickets")
    .update({
      status: "closed",
      closed_at: now,
      updated_at: now,
      escalated_at: null,
      escalated_to: null,
      escalation_reason: null,
    })
    .eq("workspace_id", opts.workspace_id)
    .eq("id", opts.ticket_id);
}

/**
 * Post-execute action taxonomy for a Sol box-session turn — Phase 2 of
 * [[../specs/sol-closes-ticket-on-resolving-reply-so-cora-grades-it]].
 *
 * Mirrors the old handler's `PostExecuteAction` shape in [[../inngest/unified-ticket-handler]]
 * (documented rule: "message_sent → close; next inbound reopens"). Only `message_sent` closes;
 * `escalated` / `status_managed` / `keep_open` all LEAVE the ticket open — a launched
 * journey/playbook awaits the customer, a clarifying `needs_info` reply expects a follow-up, and
 * a `needs_human` escalation waits on the CS Director. The classifier is the single, shared
 * predicate the box lane's close decision drives from — no parallel taxonomy.
 */
export type SolBoxTurnAction = "message_sent" | "status_managed" | "keep_open" | "escalated";

/**
 * Classify a Sol box-session turn's outcome into the shared taxonomy.
 *
 *  - `chosen_path='stateless'` + `sendOk=true` → `message_sent` (a resolving reply — CLOSE).
 *  - `chosen_path='stateless'` + `sendOk=false` → `keep_open` (send failed; the reply never
 *    reached the customer, so the ticket must NOT close — a human retries via Improve).
 *  - `chosen_path='needs_info'` → `keep_open` (a clarifying question; the customer's next inbound
 *    is the resolution signal).
 *  - `chosen_path='playbook'` / `chosen_path='journey'` → `status_managed` (the mechanism owns
 *    the ticket's status from here; unified-ticket-handler's own paths decide when it closes).
 *    NOTE (2026-07-10): the box lane (`scripts/builder-worker.ts`) now CLOSES the ticket after a
 *    successful JOURNEY launch (founder directive — a delivered CTA is the whole treatment; a reply
 *    reopens it, the journey token carries state). That close is done directly in the box lane, so a
 *    `journey` outcome no longer reaches this classifier — this mapping is retained only for the
 *    non-box legacy callers + tests. Playbooks are armed reply-gated and still close via the box's
 *    every-message-closes rule.
 *
 * The `escalated` return is reserved for the caller's `needs_human` branch: Sol's box session
 * returns `status:'needs_human'` BEFORE any Direction is written, so no `chosen_path` string is
 * available at classification time — the caller stamps `escalated` from the branch itself. Kept
 * on the taxonomy so tests and future call sites share one vocabulary.
 *
 * Pure predicate — no DB access, safe to unit-test.
 */
export function classifySolBoxTurnAction(input: {
  chosen_path: string;
  send_ok: boolean;
}): SolBoxTurnAction {
  // Founder rule (2026-07-09): EVERY Sol message closes the ticket. A closed ticket reopens on the
  // customer's next inbound, and the mechanism Sol armed at first touch (playbook via
  // active_playbook_id → the sol-playbook-shortcircuit) drives from there. So the box no longer
  // leaves playbook/journey tickets open as "status_managed" — that left them dormant-and-open when
  // nothing later closed them (marty 125741eb). Only a FAILED send (nothing shipped) keeps it open.
  return input.send_ok ? "message_sent" : "keep_open";
}

/**
 * Bump `resession_count` on the live Direction for `ticket_id`. Phase 2 of
 * [[../specs/sol-runaway-re-session-cap-guardrail]] — the router (`reSessionSol`) calls this
 * BEFORE it supersedes the live row so the incremented count is captured on the row about to
 * be superseded (the durable per-ticket bounce history the cap check reads on the NEXT
 * inflection).
 *
 * Compare-and-set on the CURRENT live row: `.eq('id', direction_id)` + `.is('superseded_at', null)`
 * + workspace_id scope (per Learning #1 — re-assert the read-time preconditions in the write
 * itself). If the live row got superseded by a racing caller between the caller's read and this
 * increment, `.select('id')` returns zero rows and we return `null` so the caller can bail
 * without double-counting.
 */
/**
 * Sol-chosen playbook resolver — Phase 2 of
 * [[../specs/sol-session-chosen-playbook-selection-retire-brittle-triggers]].
 *
 * unified-ticket-handler's `routeExec` calls this BEFORE the deterministic matcher
 * (matchPlaybookScored → applyDeferThreshold → matchPlaybook). Returns non-null only when Sol's
 * live Direction names a playbook AND the ticket is not already running one AND the slug
 * resolves to a live playbook row scoped to this workspace — in that case the caller runs
 * startPlaybook(seed_context) and stamps `ticket_resolution_events.reasoning`
 * `'sol:session-chose-playbook:{slug}'`. When any of those preconditions fails (no live
 * Direction, chosen_path is stateless/needs_info, active_playbook_id already set — a follow-up
 * turn that the shortcircuit path handles — or the slug doesn't resolve), returns null and the
 * caller falls through to the existing signal-matched path (`'sol:matcher-chose-playbook:...'`).
 *
 * Guards mirror learning #2 (confirming predicate at the action point, not a coarser proxy):
 *   - Workspace scope re-asserted on both the Direction read and the playbook lookup so a
 *     cross-workspace slug or a mis-authored Direction on a foreign ticket cannot dispatch.
 *   - `active_playbook_id IS NULL` gates the START; a ticket mid-playbook stays on its existing
 *     path (the shortcircuit already covers "still running" — cf. Phase 4 of
 *     [[../specs/sol-cheap-execution-over-ticket-direction]]).
 *   - The playbook lookup uses `.maybeSingle()` — a `null` result throws no error; the caller
 *     just falls through, so a Direction that names a retired-in-DB slug degrades gracefully.
 */
export async function resolveSolChosenPlaybook(
  admin: Admin,
  workspace_id: string,
  ticket_id: string,
): Promise<{ playbook_id: string; slug: string; seed_context: Record<string, unknown> } | null> {
  const direction = await getLiveDirection(admin, ticket_id, { workspace_id });
  if (!direction) return null;
  if (direction.chosen_path !== "playbook") return null;
  const slug = direction.plan.playbook_slug;
  if (typeof slug !== "string" || slug.length === 0) return null;

  const { data: ticketRow, error: ticketErr } = await admin
    .from("tickets")
    .select("active_playbook_id")
    .eq("workspace_id", workspace_id)
    .eq("id", ticket_id)
    .maybeSingle();
  if (ticketErr) throw ticketErr;
  const activePbId = (ticketRow as { active_playbook_id: string | null } | null)?.active_playbook_id ?? null;
  if (activePbId) return null;

  const { data: pb, error: pbErr } = await admin
    .from("playbooks")
    .select("id")
    .eq("workspace_id", workspace_id)
    .eq("slug", slug)
    .maybeSingle();
  if (pbErr) throw pbErr;
  if (!pb) return null;

  const seed = direction.plan.playbook_seed_context;
  const seed_context =
    seed && typeof seed === "object" && !Array.isArray(seed) ? (seed as Record<string, unknown>) : {};

  return { playbook_id: (pb as { id: string }).id, slug, seed_context };
}

/**
 * Sol-chosen STANDALONE journey resolver — Phase 1 of
 * [[../specs/sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend]].
 *
 * The `runTicketHandleJob` worker calls this AFTER `writeDirection` succeeds to decide whether
 * the Direction Sol just authored asks for a STANDALONE journey to be launched (no active
 * playbook) — the specific move → address-update case is the wedge. Returns non-null only
 * when the live Direction names `plan.launch_journey_slug` AND the slug resolves to an active
 * `journey_definitions` row scoped to this workspace — in that case the worker calls
 * `launchJourneyForTicket` with the row (using Sol's `first_reply` as the leadIn and the
 * journey's name as the CTA label). When any of those preconditions fails (no live Direction,
 * no `launch_journey_slug`, or the slug does not resolve), returns null and the worker
 * proceeds with the normal customer-facing `first_reply` send.
 *
 * Guards mirror learning #6 (confirming predicate at the action point, not a coarser proxy):
 *   - Workspace scope re-asserted on both the Direction read and the journey lookup so a
 *     cross-workspace slug or a mis-authored Direction on a foreign ticket cannot dispatch.
 *   - The journey lookup uses `.maybeSingle()` — a `null` result throws no error; the caller
 *     just falls through, so a Direction that names an inactive/retired-in-DB slug degrades
 *     gracefully rather than exploding the worker.
 */
export async function resolveSolChosenJourney(
  admin: Admin,
  workspace_id: string,
  ticket_id: string,
): Promise<{
  journey_id: string;
  slug: string;
  name: string;
  trigger_intent: string;
} | null> {
  const direction = await getLiveDirection(admin, ticket_id, { workspace_id });
  if (!direction) return null;
  const slug = direction.plan.launch_journey_slug;
  if (typeof slug !== "string" || slug.trim().length === 0) return null;

  const { data, error } = await admin
    .from("journey_definitions")
    .select("id, name, trigger_intent")
    .eq("workspace_id", workspace_id)
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as { id: string; name: string; trigger_intent: string | null };
  return {
    journey_id: row.id,
    slug,
    name: row.name,
    trigger_intent: (row.trigger_intent ?? slug).trim() || slug,
  };
}

export async function incrementResessionCount(
  admin: Admin,
  input: { workspace_id: string; direction_id: string; from_count: number },
): Promise<number | null> {
  const { data, error } = await admin
    .from("ticket_directions")
    .update({ resession_count: input.from_count + 1 })
    .eq("id", input.direction_id)
    .eq("workspace_id", input.workspace_id)
    .is("superseded_at", null)
    .select("id");
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string }>;
  if (rows.length !== 1) return null;
  return input.from_count + 1;
}
