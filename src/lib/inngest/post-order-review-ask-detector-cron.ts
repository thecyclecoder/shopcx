/**
 * Post-order review-ask detector cron — Phase 1 of
 * [[../../../docs/brain/specs/review-request-post-order-ask]].
 *
 * The trigger event: the FIRST time a given customer buys a given REVIEWABLE
 * product (`(customer_id, shopify_product_id)` new to that customer's order
 * history). Every subsequent tick sweeps orders whose ANCHOR DATE
 * (`orders.created_at`) has just crossed either the 10-day repeat-buyer
 * window or the 21-day first-time window, applies the ladder's skip
 * predicates (product not reviewable · customer already reviewed · ladder
 * already asked · neither channel reachable), and fires ONE Inngest event
 * per qualifying (workspace, customer, product) triple that Phase 2 will
 * consume through the shared draft/validate/send path.
 *
 * ⚠️ `orders.line_items[].product_id` is the SHOPIFY product id (a numeric
 * string), NOT our internal uuid. This detector joins through
 * `products.shopify_product_id` — a query that casts the value to uuid and
 * joins `products.id` silently matches nothing and would enqueue zero asks
 * while looking healthy. Pinned in the spec's ⚠️ warning + the pure test
 * suite [[./post-order-review-ask-detector-cron.selection.test]].
 *
 * ⚠️ No historical backfill. Line-item `product_id` coverage was 6-13%
 * through June 2026 and only jumped to 94-95% in July, so an older-orders
 * sweep would attribute confidently for a minority and silently miss the
 * majority. This cron is forward-only; the sliding window bounds every
 * read to orders newer than the (21d + jitter) ceiling.
 *
 * Windows — anchored on ORDER DATE, per the spec:
 *   - 10 days when the customer bought THIS product BEFORE this order.
 *   - 21 days when this product is NEW to them.
 *
 * The split is PER PRODUCT, not per customer. A customer on their twelfth
 * Superfood Tabs order who just tried Creatine Prime+ is a first-timer for
 * Creatine (21d window); their Tabs re-orders stay on the 10d cadence.
 *
 * Node-completeness (CLAUDE.md hard rule):
 *   1. Owner `cmo` (Iris's review-collection mandate) — registered in
 *      [[../control-tower/node-registry]] via the MONITORED_LOOPS row for
 *      this cron.
 *   2. Kill switch — `enforceSwitch("post-order-review-ask-detector-cron")`
 *      is the first body statement. A blocked cascade emits a `blocked_off`
 *      heartbeat + returns; the switch resolver's polarity ⇒ missing row = ON.
 *   3. Heartbeat — `emitCronHeartbeat` at the end of every tick, idle or not,
 *      so the CT watchdog can distinguish a healthy idle sweep from a stuck
 *      Inngest schedule.
 *
 * Cadence + liveness window pinned in [[../control-tower/registry]] (hourly
 * cadence × 1.2 = 72 min minimum; we use 90 min for jitter grace, matching
 * the daily-adjacent cron shapes elsewhere in the registry).
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { enforceSwitch } from "@/lib/control-tower/enforce-switch";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Repeat-buyer window — the customer has bought this product before, so
 * shipping-adjusted use time is minimal (they already have it in-house).
 * Aligns with the spec's 10-day pin. */
export const POST_ORDER_REPEAT_WINDOW_DAYS = 10;

/** First-time-for-this-product window — a newcomer needs enough shipping +
 * try-it time before they have anything honest to say. Aligns with the
 * spec's 21-day pin. */
export const POST_ORDER_FIRST_TIME_WINDOW_DAYS = 21;

/**
 * Sliding-window ceiling — the OLDEST order the sweep considers. Sized to
 * the first-time window plus one day of jitter grace so a candidate whose
 * 21st day fell overnight is still picked up on the next hourly tick.
 */
export const POST_ORDER_LOOKBACK_DAYS = POST_ORDER_FIRST_TIME_WINDOW_DAYS + 1;

/**
 * Sliding-window floor — the NEWEST order the sweep considers. Sized to
 * one day short of the repeat-buyer window so an order whose 10th day has
 * not yet arrived is not read at all. Reads shrink to the exact bounded
 * range each tick.
 */
export const POST_ORDER_LOOKAHEAD_FLOOR_DAYS = POST_ORDER_REPEAT_WINDOW_DAYS - 1;

/**
 * Per-tick read cap — bounded so a Postgres round-trip stays under a few
 * hundred rows regardless of workspace order volume. The August-2026
 * estimate is ~1,500 candidate asks per month across ~30 hourly ticks per
 * day — a per-tick cap of 200 covers a full day of trailing volume with
 * comfortable slack even if one tick misses.
 */
export const POST_ORDER_READ_CAP = 200;

/**
 * The Inngest event fired for each qualifying candidate. Phase 2 wires the
 * handler that drafts, validates, and sends through the shared review-ask
 * path. Payload carries only the primary keys — the handler re-reads
 * everything from the DB with the workspace scope.
 */
export const POST_ORDER_REVIEW_ASK_EVENT = "review/post-order.ask-due";

/**
 * A candidate line item to consider inside a sweep — the (workspace,
 * customer, product) triple plus the anchor order date. Kept as a plain
 * shape so the pure predicates below can be unit-tested without a DB.
 */
export interface PostOrderCandidate {
  workspaceId: string;
  customerId: string;
  /** Internal `products.id` (uuid) — resolved from the SHOPIFY line-item
   * product id via the `products.shopify_product_id` join. */
  productId: string;
  /** The line-item Shopify product id as it appears in `orders.line_items`
   * — kept alongside so the Phase-2 event handler can trace back to the
   * exact join key without re-reading the order. */
  shopifyProductId: string;
  /** `orders.id` — the anchor order the window is measured from. */
  orderId: string;
  /** ISO `orders.created_at` — the ORDER DATE anchor. */
  orderCreatedAt: string;
}

/**
 * Pure predicate — classify the (order, first-time flag) pair against the
 * per-product window. Returns the window label the ask lives under
 * ("first-time" | "repeat"), the due timestamp in ms, and whether that
 * timestamp is due AS OF `now`. Ready when `dueAtMs <= now`.
 *
 * Kept pure + exported so the two-window invariant is reviewable in
 * isolation without a DB. The failing state this exists to prevent: an
 * implementation that reads the 10d and 21d windows off the same "days
 * since order" branch and enqueues a first-timer at 10d (shipping-adjusted
 * they would have had it three days — the review would be dishonest).
 */
export function classifyPostOrderWindow(input: {
  orderCreatedAt: string;
  firstTimeForProduct: boolean;
  now: number;
}): { window: "first-time" | "repeat"; dueAtMs: number; ready: boolean } {
  const t = Date.parse(input.orderCreatedAt);
  const windowDays = input.firstTimeForProduct
    ? POST_ORDER_FIRST_TIME_WINDOW_DAYS
    : POST_ORDER_REPEAT_WINDOW_DAYS;
  const dueAtMs = Number.isNaN(t) ? Number.POSITIVE_INFINITY : t + windowDays * DAY_MS;
  return {
    window: input.firstTimeForProduct ? "first-time" : "repeat",
    dueAtMs,
    ready: dueAtMs <= input.now,
  };
}

/**
 * Pure predicate — is the customer reachable via either channel per the
 * spec's "SMS-subscribed → SMS, otherwise email, never to an explicit
 * unsubscribe" routing? Neither channel reachable ⇒ skip; the sender
 * would drop the ask anyway and skipping is always correct when in doubt.
 *
 * Marketing-status values in `customers`: `subscribed` | `unsubscribed` |
 * `not_subscribed` | null. Explicit `unsubscribed` on email means email
 * is off; anything else (subscribed / not_subscribed / null) is a legal
 * email recipient for a transactional-adjacent review ask.
 */
export function isPostOrderCustomerReachable(input: {
  smsMarketingStatus: string | null;
  emailMarketingStatus: string | null;
}): boolean {
  if (input.smsMarketingStatus === "subscribed") return true;
  if (input.emailMarketingStatus === "unsubscribed") return false;
  return true;
}

/**
 * Pure selector — filter a candidate list against the ladder's skip
 * predicates using the lookup sets the cron's step assembled. Returns the
 * eligible triples (bounded by `readCap`) plus deferred / per-reason skip
 * counts so operators can distinguish "no orders" from "everything
 * suppressed for a legit reason". Kept pure so the invariant is testable
 * without a DB.
 */
export function selectPostOrderReadyCandidates(input: {
  candidates: PostOrderCandidate[];
  /** (customer_id + "|" + product_id) keys the ladder already asked about
   * — `review_requests` scoped to (workspace, customer, product). */
  askedKeys: Set<string>;
  /** (customer_id + "|" + product_id) keys the customer already reviewed
   * — `product_reviews` scoped to (workspace, customer, product). */
  reviewedKeys: Set<string>;
  /** Marketing-status lookup keyed by customer_id — the reachability
   * predicate reads from here per candidate. */
  marketingByCustomer: Map<
    string,
    { sms_marketing_status: string | null; email_marketing_status: string | null }
  >;
  /** (customer_id + "|" + product_id) keys that are FIRST-TIME for the
   * customer (they've never bought this product before this order). Any
   * key NOT in this set is treated as REPEAT (they have prior orders
   * containing this product). */
  firstTimeKeys: Set<string>;
  now: number;
  readCap: number;
}): {
  ready: Array<PostOrderCandidate & { window: "first-time" | "repeat" }>;
  skipped_already_asked: number;
  skipped_already_reviewed: number;
  skipped_unreachable: number;
  skipped_not_due: number;
  deferred: number;
} {
  let skipped_already_asked = 0;
  let skipped_already_reviewed = 0;
  let skipped_unreachable = 0;
  let skipped_not_due = 0;
  const out: Array<PostOrderCandidate & { window: "first-time" | "repeat" }> = [];
  const seen = new Set<string>();
  for (const c of input.candidates) {
    const key = `${c.customerId}|${c.productId}`;
    // De-dupe within-tick so a customer with the same product across
    // multiple orders in the window is only enqueued once. The earliest
    // order in the sorted feed wins.
    if (seen.has(key)) continue;
    if (input.askedKeys.has(key)) {
      skipped_already_asked++;
      seen.add(key);
      continue;
    }
    if (input.reviewedKeys.has(key)) {
      skipped_already_reviewed++;
      seen.add(key);
      continue;
    }
    const firstTimeForProduct = input.firstTimeKeys.has(key);
    const cls = classifyPostOrderWindow({
      orderCreatedAt: c.orderCreatedAt,
      firstTimeForProduct,
      now: input.now,
    });
    if (!cls.ready) {
      skipped_not_due++;
      continue;
    }
    const mk = input.marketingByCustomer.get(c.customerId);
    if (
      !isPostOrderCustomerReachable({
        smsMarketingStatus: mk?.sms_marketing_status ?? null,
        emailMarketingStatus: mk?.email_marketing_status ?? null,
      })
    ) {
      skipped_unreachable++;
      seen.add(key);
      continue;
    }
    seen.add(key);
    out.push({ ...c, window: cls.window });
  }
  const ready = out.slice(0, input.readCap);
  return {
    ready,
    skipped_already_asked,
    skipped_already_reviewed,
    skipped_unreachable,
    skipped_not_due,
    deferred: Math.max(0, out.length - ready.length),
  };
}

export const postOrderReviewAskDetectorCron = inngest.createFunction(
  {
    id: "post-order-review-ask-detector-cron",
    name: "Post-order review-ask detector — hourly sweep for first-purchase-of-a-reviewable-product",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "0 * * * *" }],
  },
  async ({ step }) => {
    // Node-completeness rule #2: enforceSwitch as the FIRST body statement.
    // A blocked cascade returns immediately after writing the blocked_off
    // heartbeat via the resolver so the CT tile renders AMBER instead of RED.
    if ((await enforceSwitch("post-order-review-ask-detector-cron")).ok === "blocked_off") {
      return { skipped: "blocked_off" };
    }

    const admin = createAdminClient();
    const now = Date.now();
    const lookbackFloor = new Date(now - POST_ORDER_LOOKBACK_DAYS * DAY_MS).toISOString();
    const lookaheadCeiling = new Date(
      now - POST_ORDER_LOOKAHEAD_FLOOR_DAYS * DAY_MS,
    ).toISOString();

    const result = await step.run("enqueue-post-order-asks", async () => {
      // Fetch orders whose ORDER DATE sits inside the [21d+jitter, 10d-1]
      // sliding window — the exact strip where a 10d-repeat or a 21d-
      // first-time candidate can become due on this tick. Bound the read
      // by POST_ORDER_READ_CAP so a Postgres round-trip stays fast even
      // during volume spikes.
      const { data: orders } = await admin
        .from("orders")
        .select("id, workspace_id, customer_id, created_at, line_items")
        .not("customer_id", "is", null)
        .gte("created_at", lookbackFloor)
        .lte("created_at", lookaheadCeiling)
        .order("created_at", { ascending: true })
        .limit(POST_ORDER_READ_CAP * 4);
      const orderRows = (orders || []) as Array<{
        id: string;
        workspace_id: string;
        customer_id: string | null;
        created_at: string | null;
        line_items: unknown;
      }>;
      if (!orderRows.length)
        return {
          candidates: 0,
          eligible: 0,
          enqueued: 0,
          deferred: 0,
          skipped_already_asked: 0,
          skipped_already_reviewed: 0,
          skipped_unreachable: 0,
          skipped_not_due: 0,
          skipped_no_shopify_id: 0,
        };

      // Extract the (order, shopify_product_id) pairs from every order's
      // line_items JSONB. A line without a product_id (or one shaped as
      // anything other than a non-empty string) is silently skipped —
      // Shipping Protection lines historically carried a Shopify numeric
      // id here, so a string form is expected even for add-ons; the
      // reviewable filter downstream is what excludes them.
      let skipped_no_shopify_id = 0;
      type Pair = {
        workspaceId: string;
        customerId: string;
        orderId: string;
        orderCreatedAt: string;
        shopifyProductId: string;
      };
      const pairs: Pair[] = [];
      for (const o of orderRows) {
        if (!o.customer_id || !o.created_at) continue;
        const items = Array.isArray(o.line_items) ? o.line_items : [];
        for (const raw of items) {
          const li = raw as { product_id?: unknown } | null | undefined;
          const pid = li?.product_id;
          if (typeof pid !== "string" || pid.length === 0) {
            skipped_no_shopify_id++;
            continue;
          }
          pairs.push({
            workspaceId: o.workspace_id,
            customerId: o.customer_id,
            orderId: o.id,
            orderCreatedAt: o.created_at,
            shopifyProductId: pid,
          });
        }
      }
      if (!pairs.length)
        return {
          candidates: 0,
          eligible: 0,
          enqueued: 0,
          deferred: 0,
          skipped_already_asked: 0,
          skipped_already_reviewed: 0,
          skipped_unreachable: 0,
          skipped_not_due: 0,
          skipped_no_shopify_id,
        };

      // ⚠️ THE JOIN. `products.shopify_product_id` is text, matches the
      // string form of `line_items[].product_id`. A UUID cast on either
      // side matches NOTHING (the spec's ⚠️ warning) — the join key is
      // read verbatim, per-workspace, filtered to reviewable=true so
      // Shipping Protection / Mystery Item / free-gift SKUs never reach
      // downstream even if they somehow slipped past a line-item filter.
      const workspaceIds = Array.from(new Set(pairs.map((p) => p.workspaceId)));
      const shopifyIds = Array.from(new Set(pairs.map((p) => p.shopifyProductId)));
      const { data: prods } = await admin
        .from("products")
        .select("id, workspace_id, shopify_product_id, reviewable")
        .in("workspace_id", workspaceIds)
        .in("shopify_product_id", shopifyIds)
        .eq("reviewable", true);
      const productByKey = new Map<string, string>();
      for (const p of (prods || []) as Array<{
        id: string;
        workspace_id: string;
        shopify_product_id: string;
        reviewable: boolean;
      }>) {
        productByKey.set(`${p.workspace_id}|${p.shopify_product_id}`, p.id);
      }

      // Resolve each pair to its internal product uuid; drop the pair if
      // no reviewable product joined. The dropped count is not surfaced —
      // it's the common case (a workspace has many non-reviewable add-on
      // lines) and the reviewable-only join above is the actual guard.
      const candidates: PostOrderCandidate[] = [];
      for (const p of pairs) {
        const productId = productByKey.get(`${p.workspaceId}|${p.shopifyProductId}`);
        if (!productId) continue;
        candidates.push({
          workspaceId: p.workspaceId,
          customerId: p.customerId,
          productId,
          shopifyProductId: p.shopifyProductId,
          orderId: p.orderId,
          orderCreatedAt: p.orderCreatedAt,
        });
      }
      if (!candidates.length)
        return {
          candidates: 0,
          eligible: 0,
          enqueued: 0,
          deferred: 0,
          skipped_already_asked: 0,
          skipped_already_reviewed: 0,
          skipped_unreachable: 0,
          skipped_not_due: 0,
          skipped_no_shopify_id,
        };

      // Ladder skip — the customer already has a review_requests row for
      // (workspace, customer, product). Both triggers (ticket + post-
      // order) write here so neither can double-ask the same customer
      // about the same product (spec Phase 2's "one ladder" invariant).
      const customerIds = Array.from(new Set(candidates.map((c) => c.customerId)));
      const productIds = Array.from(new Set(candidates.map((c) => c.productId)));
      const askedKeys = new Set<string>();
      {
        const { data: asked } = await admin
          .from("review_requests")
          .select("customer_id, product_id")
          .in("customer_id", customerIds)
          .in("product_id", productIds);
        for (const r of (asked || []) as Array<{
          customer_id: string;
          product_id: string;
        }>) {
          askedKeys.add(`${r.customer_id}|${r.product_id}`);
        }
      }

      // Already-reviewed skip — the customer already left a
      // product_reviews row for this product. Same customer + product
      // shape as the ladder read above.
      const reviewedKeys = new Set<string>();
      {
        const { data: reviewed } = await admin
          .from("product_reviews")
          .select("customer_id, product_id")
          .in("customer_id", customerIds)
          .in("product_id", productIds);
        for (const r of (reviewed || []) as Array<{
          customer_id: string;
          product_id: string;
        }>) {
          reviewedKeys.add(`${r.customer_id}|${r.product_id}`);
        }
      }

      // Marketing status per customer — reachability predicate reads from
      // here. Neither channel reachable ⇒ skip; the sender would drop the
      // ask anyway.
      const marketingByCustomer = new Map<
        string,
        { sms_marketing_status: string | null; email_marketing_status: string | null }
      >();
      {
        const { data: custs } = await admin
          .from("customers")
          .select("id, sms_marketing_status, email_marketing_status")
          .in("id", customerIds);
        for (const c of (custs || []) as Array<{
          id: string;
          sms_marketing_status: string | null;
          email_marketing_status: string | null;
        }>) {
          marketingByCustomer.set(c.id, {
            sms_marketing_status: c.sms_marketing_status ?? null,
            email_marketing_status: c.email_marketing_status ?? null,
          });
        }
      }

      // First-time-for-product per (customer, product). The spec's split
      // is PER PRODUCT: bought THIS product before → 10d; new to them →
      // 21d. We ask each candidate: does the customer have an EARLIER
      // order (created_at < this candidate's anchor date) that also
      // contained this shopify_product_id? Fetch ALL prior orders for
      // the candidate customers in ONE read and iterate their line_items
      // in memory — same shape as the pair extraction above, but scoped
      // to `created_at < now-21d-1d` so we only need to prove
      // pre-existence, not enumerate.
      const firstTimeKeys = new Set<string>();
      {
        const earliestAnchor = candidates.reduce(
          (min, c) => (c.orderCreatedAt < min ? c.orderCreatedAt : min),
          candidates[0].orderCreatedAt,
        );
        const { data: priorOrders } = await admin
          .from("orders")
          .select("customer_id, line_items")
          .in("customer_id", customerIds)
          .lt("created_at", earliestAnchor);
        const priorByCustomer = new Map<string, Set<string>>();
        for (const o of (priorOrders || []) as Array<{
          customer_id: string | null;
          line_items: unknown;
        }>) {
          if (!o.customer_id) continue;
          const items = Array.isArray(o.line_items) ? o.line_items : [];
          let bag = priorByCustomer.get(o.customer_id);
          if (!bag) {
            bag = new Set<string>();
            priorByCustomer.set(o.customer_id, bag);
          }
          for (const raw of items) {
            const li = raw as { product_id?: unknown } | null | undefined;
            const pid = li?.product_id;
            if (typeof pid === "string" && pid.length > 0) bag.add(pid);
          }
        }
        for (const c of candidates) {
          const bag = priorByCustomer.get(c.customerId);
          const boughtBefore = !!bag && bag.has(c.shopifyProductId);
          if (!boughtBefore) {
            firstTimeKeys.add(`${c.customerId}|${c.productId}`);
          }
        }
      }

      const {
        ready,
        skipped_already_asked,
        skipped_already_reviewed,
        skipped_unreachable,
        skipped_not_due,
        deferred,
      } = selectPostOrderReadyCandidates({
        candidates,
        askedKeys,
        reviewedKeys,
        marketingByCustomer,
        firstTimeKeys,
        now,
        readCap: POST_ORDER_READ_CAP,
      });

      // Fan-out ONE Inngest event per ready candidate. Phase 2 wires the
      // handler that drafts, validates, and sends through the shared
      // review-ask path (`insertReviewRequestRow` + the canary-held
      // pending ticket_message queue). No handler yet ⇒ Inngest logs and
      // drops the event; Phase 1's contract is the detector + join +
      // control-tower registration only.
      let enqueued = 0;
      for (const r of ready) {
        try {
          await inngest.send({
            name: POST_ORDER_REVIEW_ASK_EVENT,
            data: {
              workspace_id: r.workspaceId,
              customer_id: r.customerId,
              product_id: r.productId,
              shopify_product_id: r.shopifyProductId,
              order_id: r.orderId,
              order_created_at: r.orderCreatedAt,
              window: r.window,
            },
          });
          enqueued++;
        } catch (e) {
          console.warn(
            `[post-order-review-ask-detector] fan-out failed for customer=${r.customerId.slice(0, 8)} product=${r.productId.slice(0, 8)}:`,
            e instanceof Error ? e.message : e,
          );
        }
      }

      return {
        candidates: candidates.length,
        eligible: ready.length + deferred,
        enqueued,
        deferred,
        skipped_already_asked,
        skipped_already_reviewed,
        skipped_unreachable,
        skipped_not_due,
        skipped_no_shopify_id,
      };
    });

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("post-order-review-ask-detector-cron", {
        ok: true,
        produced: result,
      });
    });

    return result;
  },
);
