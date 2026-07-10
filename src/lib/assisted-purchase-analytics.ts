/**
 * assisted-purchase-analytics — Phase 5 of
 * [[../../docs/brain/specs/checkout-stuck-defaults-to-assisted-purchase-concierge-sonnet-and-sol]].
 *
 * The pure query builder for the concierge-flow funnel slice the founder can
 * tune from: checkout-stuck tickets → assisted-purchase started (Sol authored
 * the assisted-purchase Direction, so the `add-payment-method` journey
 * launched) → order placed (the terminal `create_order` / `create_subscription`
 * playbook step returned `success:true` and set `assisted_purchase_completed=true`
 * on the playbook context). All three counts + the conversion rates + recovered
 * revenue in one row.
 *
 * The pure `buildAssistedPurchaseFunnelSql` function returns the SQL string; the
 * async `queryAssistedPurchaseFunnel` executes it against an admin client. The
 * SQL is intentionally NOT authored into a migration/RPC/view — a caller-time
 * query keeps the funnel Bindable to any date range without a schema change,
 * and pins the shape in a unit-testable pure function. Anything else this file
 * exports (row shape, defaults) is derived from the SQL so a future rewrite
 * that changes any leg surfaces here first.
 *
 * The three signal predicates:
 *   - CHECKOUT-STUCK ticket:  a `ticket_resolution_events` row whose
 *                              `reasoning='sol:inflection-drift'` AND
 *                              `chosen->>'reason'='stage1_checkout_stuck'`
 *                              (Phase-2 stamp from [[inflection-detector]]),
 *                              OR the ticket's live [[../tables/ticket_directions]]
 *                              row has `plan->>'journey_slug'='add-payment-method'`
 *                              (Phase-3 Direction blueprint).
 *   - ASSISTED-PURCHASE STARTED: the ticket has an active playbook whose slug
 *                                is one of the two session-chosen-only
 *                                assisted-purchase slugs (Phase-4 handoff), OR
 *                                its Direction plan carries
 *                                `plan.journey_slug='add-payment-method'`
 *                                (the payment_journey stage).
 *   - ORDER PLACED: the ticket's active playbook run stashed
 *                   `assisted_purchase_completed=true` on
 *                   [[../tables/tickets]] `.playbook_context` — the Phase-4
 *                   `interpretAssistedCreateResult` truthful success context.
 */
import { ASSISTED_PURCHASE_PLAYBOOK_SLUGS } from "@/lib/assisted-purchase-direction";

// ── row shape ───────────────────────────────────────────────────────────────

export interface AssistedPurchaseFunnelRow {
  /** Workspace this slice is scoped to. */
  workspace_id: string;
  /** Inclusive lower bound of the window (ISO 8601 UTC). */
  window_start: string;
  /** Exclusive upper bound of the window (ISO 8601 UTC). */
  window_end: string;
  /** Distinct tickets classified as CHECKOUT-STUCK in the window. */
  checkout_stuck_tickets: number;
  /** Subset of the above whose Direction launched the add-payment-method journey. */
  assisted_purchase_started: number;
  /** Subset of the above whose terminal playbook step returned success. */
  orders_placed: number;
  /** Sum of `assisted_purchase_result_summary` charged amounts on placed orders (integer cents). */
  recovered_revenue_cents: number;
  /** started / stuck; 0 when `checkout_stuck_tickets = 0`. */
  start_rate: number;
  /** placed / started; 0 when `assisted_purchase_started = 0`. */
  placement_rate: number;
  /** placed / stuck; 0 when `checkout_stuck_tickets = 0`. Founder-level slice. */
  end_to_end_conversion: number;
}

// ── pure SQL builder ────────────────────────────────────────────────────────

export interface AssistedPurchaseFunnelSqlInput {
  workspaceId: string;
  /** Inclusive lower bound; ISO 8601 UTC. */
  windowStart: string;
  /** Exclusive upper bound; ISO 8601 UTC. */
  windowEnd: string;
}

/**
 * Return the SQL for one funnel-slice row given a workspace + window. Pure:
 * no DB call. Placeholders `$1..$4` are `workspaceId, windowStart, windowEnd,
 * <assisted-purchase-slug-array>`; the caller binds them via `.rpc('sql', ...)`
 * or the equivalent parameterized query — never string-concatenate the values.
 *
 * The result set is exactly ONE row (the aggregation collapses to a single
 * count-per-signal + the conversion ratios).
 */
export function buildAssistedPurchaseFunnelSql(input: AssistedPurchaseFunnelSqlInput): string {
  // Values are bound via parameters ($1..$4) — the caller is responsible for
  // passing (workspaceId, windowStart, windowEnd, [oneTime, subscribeAndSave]).
  // Rendered here as a template rather than concatenated so the test can pin
  // the exact shape.
  void input;
  return `WITH
  checkout_stuck AS (
    -- A ticket is CHECKOUT-STUCK when the inflection-detector stamped a
    -- 'sol:inflection-drift' event with the Phase-2 reason 'stage1_checkout_stuck',
    -- OR the live Direction launches the Phase-3 blueprint journey.
    SELECT DISTINCT tre.ticket_id
    FROM public.ticket_resolution_events tre
    WHERE tre.workspace_id = $1
      AND tre.created_at >= $2
      AND tre.created_at < $3
      AND tre.reasoning = 'sol:inflection-drift'
      AND (tre.chosen->>'reason') = 'stage1_checkout_stuck'
    UNION
    SELECT DISTINCT td.ticket_id
    FROM public.ticket_directions td
    WHERE td.workspace_id = $1
      AND td.authored_at >= $2
      AND td.authored_at < $3
      AND td.chosen_path = 'journey'
      AND (td.plan->>'journey_slug') = 'add-payment-method'
  ),
  assisted_started AS (
    -- The ticket also has a live Direction pointing at the add-payment-method
    -- journey (payment_journey stage) OR an active assisted-purchase playbook
    -- (later stage). Either is proof the concierge flow launched.
    SELECT DISTINCT cs.ticket_id
    FROM checkout_stuck cs
    WHERE EXISTS (
      SELECT 1 FROM public.ticket_directions td
      WHERE td.workspace_id = $1
        AND td.ticket_id = cs.ticket_id
        AND td.authored_at >= $2 AND td.authored_at < $3
        AND td.chosen_path = 'journey'
        AND (td.plan->>'journey_slug') = 'add-payment-method'
    ) OR EXISTS (
      SELECT 1 FROM public.ticket_directions td
      JOIN public.playbooks p
        ON p.workspace_id = td.workspace_id
       AND p.slug = (td.plan->>'playbook_slug')
      WHERE td.workspace_id = $1
        AND td.ticket_id = cs.ticket_id
        AND td.authored_at >= $2 AND td.authored_at < $3
        AND td.chosen_path = 'playbook'
        AND p.slug = ANY ($4::text[])
    )
  ),
  orders_placed AS (
    -- The Phase-4 interpretAssistedCreateResult stashes
    -- assisted_purchase_completed=true on tickets.playbook_context ONLY after
    -- the placement handler returned success — the execute-then-confirm signal.
    SELECT DISTINCT ast.ticket_id, t.playbook_context
    FROM assisted_started ast
    JOIN public.tickets t ON t.id = ast.ticket_id
    WHERE t.workspace_id = $1
      AND (t.playbook_context->>'assisted_purchase_completed')::boolean = true
  )
SELECT
  $1::uuid AS workspace_id,
  $2::timestamptz AS window_start,
  $3::timestamptz AS window_end,
  (SELECT COUNT(*) FROM checkout_stuck)::int AS checkout_stuck_tickets,
  (SELECT COUNT(*) FROM assisted_started)::int AS assisted_purchase_started,
  (SELECT COUNT(*) FROM orders_placed)::int AS orders_placed,
  COALESCE((
    SELECT SUM(
      COALESCE(
        (regexp_match(
          COALESCE(op.playbook_context->>'assisted_purchase_result_summary', ''),
          '\\\\$([0-9]+(?:\\\\.[0-9]{2})?)'
        ))[1]::numeric * 100,
        0
      )
    )::bigint
    FROM orders_placed op
  ), 0)::bigint AS recovered_revenue_cents,
  CASE
    WHEN (SELECT COUNT(*) FROM checkout_stuck) = 0 THEN 0::numeric
    ELSE ROUND(
      ((SELECT COUNT(*) FROM assisted_started)::numeric
       / NULLIF((SELECT COUNT(*) FROM checkout_stuck)::numeric, 0))::numeric,
      4
    )
  END AS start_rate,
  CASE
    WHEN (SELECT COUNT(*) FROM assisted_started) = 0 THEN 0::numeric
    ELSE ROUND(
      ((SELECT COUNT(*) FROM orders_placed)::numeric
       / NULLIF((SELECT COUNT(*) FROM assisted_started)::numeric, 0))::numeric,
      4
    )
  END AS placement_rate,
  CASE
    WHEN (SELECT COUNT(*) FROM checkout_stuck) = 0 THEN 0::numeric
    ELSE ROUND(
      ((SELECT COUNT(*) FROM orders_placed)::numeric
       / NULLIF((SELECT COUNT(*) FROM checkout_stuck)::numeric, 0))::numeric,
      4
    )
  END AS end_to_end_conversion`;
}

/**
 * The parameter tuple `buildAssistedPurchaseFunnelSql` binds. Exported so a
 * caller (typically an analytics tile) can hand the right vector to whichever
 * parameterized-query transport it uses (`admin.rpc('sql', ...)`, a direct pg
 * driver, etc.).
 */
export function buildAssistedPurchaseFunnelParams(
  input: AssistedPurchaseFunnelSqlInput,
): [string, string, string, readonly string[]] {
  return [
    input.workspaceId,
    input.windowStart,
    input.windowEnd,
    [ASSISTED_PURCHASE_PLAYBOOK_SLUGS.oneTime, ASSISTED_PURCHASE_PLAYBOOK_SLUGS.subscribeAndSave],
  ];
}

// The async caller lives with whichever analytics tile / RPC transport wires
// this slice into a route — see [[../recipes/checkout-stuck-concierge-flow]]
// for the wire-in checklist. Keeping the pure SQL + params vector as the
// exported surface means a new transport (an RPC, a direct pg driver, an
// analytics-tile helper) can adopt it without a schema change.
