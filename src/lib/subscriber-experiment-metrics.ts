/**
 * Per-arm measurement for the pre-renewal-reminder 50/50 test (spec:
 * subscriber-experiment-guardrails-verdict Phase 1 · [[../../docs/brain/libraries/subscriber-experiment-metrics]]).
 *
 * The PRIMARY success metric of the M3 test is 90-day NET REVENUE PER CUSTOMER — charges minus
 * settled refunds — compared between the reminder arm (`treatment`) and the `holdout`. Nothing else
 * computes per-customer net revenue over a window today (only raw charges + refunds exist), so this
 * module is the single read-only measurement surface the guardrail evaluator (Phase 2) and the
 * verdict engine (Phase 3) both read.
 *
 * GRAIN IS THE PERSON, not the account — identical to the harness
 * ([[subscriber-experiments]]). Every customer is folded into their linked-account GROUP
 * (`customer_links.group_id`, [[../../docs/brain/tables/customer_links]]) so one real person's
 * several accounts contribute ONE net-revenue number to ONE arm. The arm for a group is read through
 * the harness SDK (`listAssignments`) — never a raw `.from` on the experiment tables (CLAUDE.md
 * raw-`.from` STOP rule, enforced by scripts/_check-subscriber-experiments-sdk-compliance.ts).
 *
 * Net revenue = Σ orders.total_cents ([[../../docs/brain/tables/orders.md]]) over the window
 *   − Σ order_refunds.amount_cents ([[../../docs/brain/tables/order_refunds.md]]) where
 *     `status ∈ ('succeeded','settled')`. Refunds in `requested`/`failed`/`reversed` are EXCLUDED —
 *     they never moved settled money, so counting them would under-report real net revenue.
 *
 * The measurement WINDOW is anchored PER GROUP on its `assigned_at` (sticky first-eligibility
 * moment): a group's window is [assigned_at, assigned_at + windowDays). This is the person-level
 * treatment exposure window the pre-registered 90-day metric is defined over, so a group assigned
 * last week and one assigned two months ago are each measured over their OWN 90 days, never a shared
 * calendar window. A group whose window has not closed yet is still included with its partial
 * in-window revenue (the verdict engine, Phase 3, is what gates on the window actually having closed
 * for the registered sample).
 *
 * PURE MEASUREMENT: this module performs NO writes. It reads orders, order_refunds, customer_links,
 * customer_events, journey_sessions, and journey_step_events directly (none are SDK-chokepoint
 * tables), and reads the experiment + assignments ONLY through the subscriber-experiments SDK.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  type ExperimentArm,
  type ExperimentAssignmentRow,
  getExperiment,
  listAssignments,
} from "@/lib/subscriber-experiments";

type Admin = ReturnType<typeof createAdminClient>;

/** Default measurement window — the pre-registered 90-day net-revenue horizon. */
export const DEFAULT_WINDOW_DAYS = 90;

/** Refund statuses that represent settled money leaving — the only ones netted out of revenue. */
export const NETTED_REFUND_STATUSES = ["succeeded", "settled"] as const;

/** customer_events types that count as a VOLUNTARY cancel (portal/self-serve + synced). */
const VOLUNTARY_CANCEL_EVENT_TYPES = [
  "subscription.cancelled",
  "portal.subscription.cancelled",
] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Chunk size for `.in(...)` filters — keeps a single IN list bounded for large arms. */
const IN_CHUNK = 500;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface ArmMetrics {
  arm: ExperimentArm;
  /** Number of assigned person-groups in this arm. */
  customerGroups: number;
  /** Σ net revenue (charges − settled refunds) across every group in the arm, in cents. */
  netRevenueCents: number;
  /** Mean net revenue per person-group, in cents (0 when the arm has no groups). */
  netRevenuePerCustomerCents: number;
  /** Fraction of groups with ≥1 voluntary cancel event in-window. */
  voluntaryCancelRate: number;
  /** Fraction of groups that skipped a next order in-window (next-order journey, M1). */
  skipRate: number;
  /** Fraction of groups that swapped or added an item in-window (next-order journey, M1). */
  swapAddOnRate: number;
  /** Mean count of DISTINCT products ordered per group in-window. */
  distinctProductsPerCustomer: number;
}

export interface ExperimentMetrics {
  experimentId: string;
  slug: string;
  windowDays: number;
  /** Upper bound of every group's measurement window (defaults to "now" at call time). */
  asOf: string;
  arms: Record<ExperimentArm, ArmMetrics>;
}

interface GroupAccumulator {
  groupId: string;
  arm: ExperimentArm;
  windowStart: number;
  windowEnd: number;
  chargesCents: number;
  refundsCents: number;
  orderIds: Set<string>;
  distinctVariants: Set<string>;
  cancelled: boolean;
  skipped: boolean;
  swappedOrAdded: boolean;
}

function emptyArm(arm: ExperimentArm): ArmMetrics {
  return {
    arm,
    customerGroups: 0,
    netRevenueCents: 0,
    netRevenuePerCustomerCents: 0,
    voluntaryCancelRate: 0,
    skipRate: 0,
    swapAddOnRate: 0,
    distinctProductsPerCustomer: 0,
  };
}

/**
 * Compute per-arm rollups for an experiment's sticky assignments.
 *
 *   1. Read the experiment + every assignment through the harness SDK (person-group grain).
 *   2. Expand each group to its linked customer ids via `customer_links.group_id`.
 *   3. Per group, net revenue = Σ orders.total_cents − Σ settled order_refunds.amount_cents over
 *      that group's own [assigned_at, assigned_at + windowDays) window.
 *   4. Secondary rates (voluntary cancel, skip, swap/add-on, distinct products) folded in from
 *      customer_events + the M1 next-order journey events, scoped to the same per-group window.
 *
 * Read-only. Returns zeroed arms when the experiment has no assignments yet.
 */
export async function computeExperimentMetrics(
  workspaceId: string,
  experimentSlug: string,
  opts: { windowDays?: number; asOf?: Date; admin?: Admin } = {},
): Promise<ExperimentMetrics> {
  const admin = opts.admin ?? createAdminClient();
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const asOf = opts.asOf ?? new Date();
  const asOfMs = asOf.getTime();

  const experiment = await getExperiment(workspaceId, experimentSlug, admin);
  const base: ExperimentMetrics = {
    experimentId: experiment?.id ?? "",
    slug: experimentSlug,
    windowDays,
    asOf: asOf.toISOString(),
    arms: { treatment: emptyArm("treatment"), holdout: emptyArm("holdout") },
  };
  if (!experiment) return base;

  const assignments = await listAssignments(workspaceId, experimentSlug, admin);
  if (assignments.length === 0) return base;

  // ── Group accumulators, each with its OWN per-group window ──
  const groups = new Map<string, GroupAccumulator>();
  for (const a of assignments) {
    const start = new Date(a.assigned_at).getTime();
    const end = Math.min(start + windowDays * MS_PER_DAY, asOfMs);
    groups.set(a.group_id, {
      groupId: a.group_id,
      arm: a.arm,
      windowStart: start,
      windowEnd: end,
      chargesCents: 0,
      refundsCents: 0,
      orderIds: new Set(),
      distinctVariants: new Set(),
      cancelled: false,
      skipped: false,
      swappedOrAdded: false,
    });
  }

  // ── Expand each group to its linked customer ids (customer_links.group_id). A singleton /
  // unlinked group's group_id IS the customer id (the harness `resolveGroupId` fallback), so any
  // group with no customer_links rows maps to itself. ──
  const customerToGroup = new Map<string, string>();
  const groupIds = [...groups.keys()];
  const linkedGroupIds = new Set<string>();
  for (const part of chunk(groupIds, IN_CHUNK)) {
    const { data } = await admin
      .from("customer_links")
      .select("group_id, customer_id")
      .eq("workspace_id", workspaceId)
      .in("group_id", part);
    for (const row of (data as { group_id: string; customer_id: string }[] | null) ?? []) {
      customerToGroup.set(row.customer_id, row.group_id);
      linkedGroupIds.add(row.group_id);
    }
  }
  // Unlinked singleton groups: group_id doubles as the customer id.
  for (const gid of groupIds) {
    if (!linkedGroupIds.has(gid)) customerToGroup.set(gid, gid);
  }
  const customerIds = [...customerToGroup.keys()];

  // ── Orders → charges + distinct products, filtered into each group's own window ──
  const orderToGroup = new Map<string, string>();
  for (const part of chunk(customerIds, IN_CHUNK)) {
    const { data } = await admin
      .from("orders")
      .select("id, customer_id, total_cents, line_items, created_at")
      .eq("workspace_id", workspaceId)
      .in("customer_id", part);
    for (const o of (data as OrderRow[] | null) ?? []) {
      const gid = customerToGroup.get(o.customer_id);
      if (!gid) continue;
      const g = groups.get(gid);
      if (!g) continue;
      const t = new Date(o.created_at).getTime();
      if (t < g.windowStart || t >= g.windowEnd) continue;
      g.chargesCents += o.total_cents ?? 0;
      g.orderIds.add(o.id);
      orderToGroup.set(o.id, gid);
      for (const li of (o.line_items as LineItem[] | null) ?? []) {
        const key = li?.variant_id ?? li?.product_id ?? li?.title;
        if (key) g.distinctVariants.add(String(key));
      }
    }
  }

  // ── Refunds for in-window orders → netted out of revenue (settled money only) ──
  const inWindowOrderIds = [...orderToGroup.keys()];
  for (const part of chunk(inWindowOrderIds, IN_CHUNK)) {
    const { data } = await admin
      .from("order_refunds")
      .select("order_id, amount_cents, status")
      .eq("workspace_id", workspaceId)
      .in("order_id", part)
      .in("status", NETTED_REFUND_STATUSES as unknown as string[]);
    for (const r of (data as RefundRow[] | null) ?? []) {
      const gid = orderToGroup.get(r.order_id);
      if (!gid) continue;
      groups.get(gid)!.refundsCents += r.amount_cents ?? 0;
    }
  }

  // ── Secondary: voluntary cancel (customer_events) ──
  for (const part of chunk(customerIds, IN_CHUNK)) {
    const { data } = await admin
      .from("customer_events")
      .select("customer_id, event_type, created_at")
      .eq("workspace_id", workspaceId)
      .in("customer_id", part)
      .in("event_type", VOLUNTARY_CANCEL_EVENT_TYPES as unknown as string[]);
    for (const e of (data as CustomerEventRow[] | null) ?? []) {
      const gid = customerToGroup.get(e.customer_id);
      if (!gid) continue;
      const g = groups.get(gid);
      if (!g) continue;
      const t = new Date(e.created_at).getTime();
      if (t >= g.windowStart && t < g.windowEnd) g.cancelled = true;
    }
  }

  // ── Secondary: skip + swap/add-on from the M1 next-order journey lifecycle events ──
  // journey_step_events are keyed by session, so resolve session → customer first.
  const sessionToGroup = new Map<string, string>();
  for (const part of chunk(customerIds, IN_CHUNK)) {
    const { data } = await admin
      .from("journey_sessions")
      .select("id, customer_id")
      .eq("workspace_id", workspaceId)
      .in("customer_id", part);
    for (const s of (data as { id: string; customer_id: string }[] | null) ?? []) {
      const gid = customerToGroup.get(s.customer_id);
      if (gid) sessionToGroup.set(s.id, gid);
    }
  }
  const sessionIds = [...sessionToGroup.keys()];
  for (const part of chunk(sessionIds, IN_CHUNK)) {
    const { data } = await admin
      .from("journey_step_events")
      .select("session_id, step_key, response_value, response_label, created_at")
      .eq("workspace_id", workspaceId)
      .eq("step_key", "lifecycle")
      .in("session_id", part);
    for (const ev of (data as StepEventRow[] | null) ?? []) {
      const gid = sessionToGroup.get(ev.session_id);
      if (!gid) continue;
      const g = groups.get(gid);
      if (!g) continue;
      const t = new Date(ev.created_at).getTime();
      if (t < g.windowStart || t >= g.windowEnd) continue;
      if (ev.response_value === "skipped") g.skipped = true;
      const label = (ev.response_label ?? "").toLowerCase();
      if (label.includes("swap") || label.includes("add")) g.swappedOrAdded = true;
    }
  }

  // ── Fold group accumulators into arm rollups ──
  const byArm: Record<ExperimentArm, GroupAccumulator[]> = { treatment: [], holdout: [] };
  for (const g of groups.values()) byArm[g.arm].push(g);

  for (const arm of ["treatment", "holdout"] as ExperimentArm[]) {
    const gs = byArm[arm];
    const n = gs.length;
    const m = emptyArm(arm);
    m.customerGroups = n;
    if (n === 0) {
      base.arms[arm] = m;
      continue;
    }
    let net = 0;
    let cancels = 0;
    let skips = 0;
    let swaps = 0;
    let distinctSum = 0;
    for (const g of gs) {
      net += g.chargesCents - g.refundsCents;
      if (g.cancelled) cancels += 1;
      if (g.skipped) skips += 1;
      if (g.swappedOrAdded) swaps += 1;
      distinctSum += g.distinctVariants.size;
    }
    m.netRevenueCents = net;
    m.netRevenuePerCustomerCents = net / n;
    m.voluntaryCancelRate = cancels / n;
    m.skipRate = skips / n;
    m.swapAddOnRate = swaps / n;
    m.distinctProductsPerCustomer = distinctSum / n;
    base.arms[arm] = m;
  }

  return base;
}

/* ------------------------------------------------------------------------------------------------
 * Row shapes for the (read-only) table selects above.
 * --------------------------------------------------------------------------------------------- */

interface OrderRow {
  id: string;
  customer_id: string;
  total_cents: number | null;
  line_items: LineItem[] | null;
  created_at: string;
}

interface LineItem {
  variant_id?: string | null;
  product_id?: string | null;
  title?: string | null;
}

interface RefundRow {
  order_id: string;
  amount_cents: number | null;
  status: string;
}

interface CustomerEventRow {
  customer_id: string;
  event_type: string;
  created_at: string;
}

interface StepEventRow {
  session_id: string;
  step_key: string;
  response_value: string | null;
  response_label: string | null;
  created_at: string;
}

/** Re-export the assignment row type for consumers that pair metrics with raw assignments. */
export type { ExperimentAssignmentRow };
