/**
 * amplifier-import-reconcile — the reliability-rail sweep for paid orders the
 * 3PL never received.
 *
 * Every 15 min. Selects `public.orders` rows with `financial_status='paid'`,
 * `amplifier_order_id IS NULL`, `shopify_order_id IS NULL` (internal `SHOPCX*`
 * orders only — Shopify-origin `SC*` rows are NEVER this rail's business and
 * match the un-imported shape forever; see `isShopifyOriginOrder`), older than
 * 10 minutes, and under the retry cap (5). Skips any order held by a non-dismissed `fraud_cases` row (the
 * `checkout` fraud-held state — the fraud-dismiss handler is the retry
 * surface, not us). For each remaining candidate, rebuilds the
 * `createAmplifierOrder` input exactly as the fraud-dismiss retry path does
 * (`src/app/api/workspaces/[id]/fraud-cases/[caseId]/route.ts` ~245-309) and
 * calls `createAmplifierOrder` — SKU-safe via #2246's `applyVariantSkus`.
 *
 * On success stamps `amplifier_order_id` + `amplifier_received_at` and clears
 * `amplifier_last_error`; on failure stamps the Phase-1 attempt/error columns
 * via `stampAmplifierImportFailure`. Compare-and-set on the success write —
 * `.eq('amplifier_order_id', null)` guards a race with a live checkout retry.
 *
 * Node completeness (CLAUDE.md hard rule) — owner=`logistics`; kill-switch
 * ancestry via the `logistics` department node (a `kill_switches.node_id='logistics'`
 * row cascades down); heartbeat emitted at end of run via `emitCronHeartbeat`;
 * registered in `MONITORED_LOOPS` (`src/lib/control-tower/registry.ts`) with a
 * 30-min liveness window that satisfies `assertRegistryInvariants`
 * (`cadenceMs * 1.2` for 15-min cadence).
 *
 * See docs/brain/inngest/amplifier-import-reconcile.md and the parent spec
 * docs/brain/specs/amplifier-import-reliability-rail.md.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAmplifierOrder, stampAmplifierImportFailure } from "@/lib/integrations/amplifier";
import { buildPackingSlipMessage } from "@/lib/packing-slip-message";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";
import { errText } from "@/lib/error-text";

const RETRY_CAP = 5;
const GRACE_MINUTES = 10;
const BATCH_LIMIT = 200;
/** Residue alert: paid + errored + not accepted within this window ⇒ CEO card. Set to a day per spec — a full business day of retries is well past any transient upstream flake. */
const STALE_ERRORED_HOURS = 24;

/**
 * Source names the reconcile rail retries. Storefront was the historical scope
 * (the fraud-dismiss retry surface covers only that), but internal subscription
 * renewals ALSO route through Amplifier via createAmplifierOrder — a nameless
 * stored address 400s the request, the order lands paid + un-imported, and
 * without this rail retrying it the order sits stuck forever (the Shannon
 * Russell / 2026-08-10 incident: 2 paid orders with amplifier_import_attempts=1
 * that never retried because the source_name gate below was storefront-only).
 * Comp renewals are $0 marker orders, not warehouse-bound, so they stay out.
 */
export const RECONCILE_ELIGIBLE_SOURCE_NAMES = new Set<string>([
  "storefront",
  "internal_subscription_renewal",
]);

/** True when a `paid` order's source_name is one the reconcile rail retries. Pure — unit-tested. */
export function isReconcileEligibleSourceName(sourceName: string | null | undefined): boolean {
  return typeof sourceName === "string" && RECONCILE_ELIGIBLE_SOURCE_NAMES.has(sourceName);
}

/**
 * True when an order is Shopify-origin (`SC*`) and therefore NEVER this rail's
 * business. Shopify orders were fulfilled through Shopify's own pipeline; they
 * carry `amplifier_order_id IS NULL` forever by design, so they match the
 * "paid but un-imported" shape without being un-imported in any real sense.
 *
 * This is the head-of-line guard. Without it the candidate selections below
 * match ~125k legacy rows, and because the per-row skip returns WITHOUT
 * stamping an attempt those rows never drain out of the set. The sweep then
 * re-fetches the same oldest BATCH_LIMIT rows from 2024 every 15 minutes,
 * skips all of them, emits a green heartbeat, and never reaches a genuinely
 * stuck internal order (SHOPCX171 / 2026-08-07 sat at queue position 3,084 —
 * unreachable, so neither the retry nor the exhaustion escalation ever fired).
 *
 * The discriminator is `shopify_order_id IS NULL`, which splits the table
 * exactly: every `SHOPCX*` order has it null, every `SC*` order has it set.
 * Same signal `src/lib/refund.ts` uses to route internal orders to Braintree.
 * Applied as a QUERY predicate at every selection site so the batch window is
 * spent on reachable work, not as a post-fetch filter. Pure — unit-tested.
 */
export function isShopifyOriginOrder(order: { shopify_order_id?: unknown }): boolean {
  return order.shopify_order_id !== null && order.shopify_order_id !== undefined;
}

/**
 * Pick the recipient's first name off a stored order shipping address. Internal
 * renewals write camelCase (`firstName` — matches the portal + checkout on
 * orders.shipping_address), while storefront legacy rows and Shopify webhook
 * imports write snake_case (`first_name`). Accept both so the packing-slip
 * greeting silently doesn't lose the name on a widened-eligibility renewal.
 * Empty string when neither is present. Pure — unit-tested.
 */
export function packingSlipFirstName(ship: { first_name?: unknown; firstName?: unknown } | null | undefined): string {
  if (!ship) return "";
  const snake = typeof ship.first_name === "string" ? ship.first_name : "";
  const camel = typeof ship.firstName === "string" ? ship.firstName : "";
  return snake || camel || "";
}

type AdminClient = ReturnType<typeof createAdminClient>;

interface CandidateRow {
  id: string;
  workspace_id: string;
  order_number: string | null;
  customer_id: string | null;
  source_name: string | null;
  email: string | null;
  shipping_address: unknown;
  billing_address: unknown;
  line_items: unknown;
  total_cents: number | null;
  created_at: string;
  amplifier_import_attempts: number | null;
  shopify_order_id: string | null;
}

interface Line {
  sku?: string | null;
  title: string;
  variant_title?: string | null;
  quantity: number;
  unit_price_cents: number;
  variant_id?: string;
  product_id?: string;
  is_gift?: boolean;
}

/**
 * True when the order has a non-dismissed fraud_cases row that names it. The
 * fraud-hold state is the fraud-dismiss handler's retry surface, not ours —
 * releasing a fraud-held order past this cron would bypass the hold.
 */
async function isFraudHeld(admin: AdminClient, workspaceId: string, orderId: string): Promise<boolean> {
  const { data } = await admin
    .from("fraud_cases")
    .select("id")
    .eq("workspace_id", workspaceId)
    .contains("order_ids", [orderId])
    .neq("status", "dismissed")
    .limit(1)
    .maybeSingle();
  return !!data;
}

/** Attempt one reconcile for one order. Returns a per-row outcome for the beat rollup. */
async function reconcileOne(
  admin: AdminClient,
  row: CandidateRow,
): Promise<"imported" | "failed" | "skipped-fraud" | "skipped-no-skus" | "skipped-non-storefront" | "skipped-shopify-origin"> {
  // Defensive — the candidate query already excludes Shopify-origin rows. A
  // non-zero count here means a selection site lost its predicate, which is
  // exactly the silent regression that stalled this rail before.
  if (isShopifyOriginOrder(row)) return "skipped-shopify-origin";
  if (!isReconcileEligibleSourceName(row.source_name)) return "skipped-non-storefront";
  if (await isFraudHeld(admin, row.workspace_id, row.id)) return "skipped-fraud";

  const ship = (row.shipping_address as { phone?: string; first_name?: string; firstName?: string } | null) || null;
  const lines = ((row.line_items as Line[]) || []).filter((l) => l && l.sku);
  if (lines.length === 0) return "skipped-no-skus";

  const distinctProducts = new Set(
    lines.filter((l) => l.product_id).map((l) => l.product_id as string),
  ).size;
  const packingSlipMessage = row.customer_id
    ? await buildPackingSlipMessage({
        workspaceId: row.workspace_id,
        customerId: row.customer_id,
        orderId: row.id,
        firstName: packingSlipFirstName(ship),
        productCount: distinctProducts,
      }).catch(() => null)
    : null;

  const res = await createAmplifierOrder({
    workspaceId: row.workspace_id,
    orderNumber: (row.order_number as string) || row.id,
    orderDate: row.created_at,
    shippingAddress: row.shipping_address as Record<string, string> | null,
    billingAddress: row.billing_address as Record<string, string> | null,
    email: (row.email as string) || "",
    phone: ship?.phone || null,
    // Mirror the fraud-dismiss retry path: send every SKU-carrying line
    // (gifts included; unit_price_cents=0 keeps them at zero-value on the
    // Amplifier pick sheet). `applyVariantSkus` inside createAmplifierOrder
    // resolves the authoritative SKU per line from `product_variants`.
    lineItems: lines.map((l) => ({
      sku: l.sku!,
      title: l.title,
      description: l.variant_title ? `${l.title} — ${l.variant_title}` : l.title,
      quantity: l.quantity,
      unit_price_cents: l.unit_price_cents,
      reference_id: l.variant_id,
    })),
    totalCents: row.total_cents || 0,
    subtotalCents: row.total_cents || 0,
    shippingCents: 0,
    taxCents: 0,
    packingSlipMessage: packingSlipMessage || undefined,
  });

  if (res.success && res.amplifier_order_id) {
    // Compare-and-set on `amplifier_order_id IS NULL` guards against a race
    // with a live checkout retry — an already-imported order can never be
    // clobbered by this sweep.
    const { data: updated } = await admin
      .from("orders")
      .update({
        amplifier_order_id: res.amplifier_order_id,
        amplifier_received_at: new Date().toISOString(),
        amplifier_last_error: null,
      })
      .eq("id", row.id)
      .eq("workspace_id", row.workspace_id)
      .is("amplifier_order_id", null)
      .select("id");
    return updated && updated.length === 1 ? "imported" : "skipped-non-storefront";
  }

  await stampAmplifierImportFailure(admin, row.id, res.error, res.details);
  return "failed";
}

/**
 * Phase 3 — CEO-inbox escalation on retry exhaustion. Called once per tick
 * AFTER the candidate loop so a row that just tipped over the cap in this
 * same tick is also caught. Idempotent per order — a matching un-dismissed
 * `dashboard_notifications` row with `type='fulfillment_alert' AND
 * metadata @> {order_id: X}` short-circuits the second insert. Mirrors the
 * refund-drift dedupe shape (`refund-settlement-reconcile.openDriftNotification`).
 *
 * Selection: `amplifier_order_id IS NULL AND amplifier_import_attempts >= RETRY_CAP`
 * — orders that exhausted retries but never made it in. A fraud-held order is
 * also skipped here (the fraud-dismiss handler owns that surface); the sweep
 * candidate loop already skips fraud-held rows, but a legacy row from before
 * this cron shipped can carry both a fraud hold and exhausted attempts.
 */
async function escalateExhaustedOrders(admin: AdminClient): Promise<{ scanned: number; opened: number; already_open: number; skipped_fraud: number }> {
  const { data: rows } = await admin
    .from("orders")
    .select("id, workspace_id, order_number, amplifier_last_error, amplifier_import_attempts")
    .is("amplifier_order_id", null)
    .is("shopify_order_id", null)
    .gte("amplifier_import_attempts", RETRY_CAP)
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT);

  let scanned = 0;
  let opened = 0;
  let alreadyOpen = 0;
  let skippedFraud = 0;
  for (const row of (rows || []) as Array<{
    id: string;
    workspace_id: string;
    order_number: string | null;
    amplifier_last_error: string | null;
    amplifier_import_attempts: number | null;
  }>) {
    scanned++;
    if (await isFraudHeld(admin, row.workspace_id, row.id)) { skippedFraud++; continue; }

    // Dedupe: an un-dismissed fulfillment_alert card for this order already
    // exists ⇒ short-circuit. Same guard shape as openDriftNotification in
    // refund-settlement-reconcile — the metadata @> {order_id: X} match is
    // the durable idempotency key across ticks.
    const { data: existing } = await admin
      .from("dashboard_notifications")
      .select("id")
      .eq("workspace_id", row.workspace_id)
      .eq("type", "fulfillment_alert")
      .eq("dismissed", false)
      .contains("metadata", { order_id: row.id })
      .limit(1)
      .maybeSingle();
    if (existing) { alreadyOpen++; continue; }

    const orderLabel = row.order_number || row.id.slice(0, 8);
    const attempts = row.amplifier_import_attempts ?? RETRY_CAP;
    const { error } = await admin.from("dashboard_notifications").insert({
      workspace_id: row.workspace_id,
      type: "fulfillment_alert",
      title: `${orderLabel} — Amplifier import failed after ${attempts} retries`,
      body: `Paid order ${orderLabel} could not be handed off to Amplifier after ${attempts} attempts. Last error: ${row.amplifier_last_error || "unknown"}. Investigate before the customer notices (unknown SKU, un-fulfillable address, or a hard Amplifier reject).`,
      link: `/dashboard/orders/${row.id}`,
      metadata: {
        kind: "amplifier_import_exhausted",
        order_id: row.id,
        order_number: row.order_number,
        attempts,
        last_error: row.amplifier_last_error,
      },
    });
    if (error) {
      console.warn(`[amplifier-import-reconcile] fulfillment_alert insert failed for order ${row.id}: ${error.message}`);
    } else {
      opened++;
    }
  }
  return { scanned, opened, already_open: alreadyOpen, skipped_fraud: skippedFraud };
}

/**
 * Residue alert: a `paid` order that has an `amplifier_last_error` and hasn't
 * been accepted within a day is CEO-visible even if it never reached the
 * exhaustion escalation. The exhaustion path (attempts ≥ RETRY_CAP) needs 5
 * retries × 15-min cadence ≈ 75 min to trip, but the 2026-08-10 Shannon
 * Russell case sat at `amplifier_import_attempts=1` for FOUR DAYS because the
 * source_name gate skipped the retry entirely — attempts never grew, and the
 * exhaustion escalation never fired. This safety-net check catches ANY
 * paid+errored order older than STALE_ERRORED_HOURS regardless of attempt
 * count. Dedupe key is the same `metadata @> {order_id: X}` un-dismissed
 * fulfillment_alert existence check the exhaustion escalation uses, so a
 * given order gets exactly one card even if both selections would match.
 */
async function escalateStaleErroredOrders(admin: AdminClient): Promise<{ scanned: number; opened: number; already_open: number; skipped_fraud: number }> {
  const staleCutoffIso = new Date(Date.now() - STALE_ERRORED_HOURS * 60 * 60_000).toISOString();
  const { data: rows } = await admin
    .from("orders")
    .select("id, workspace_id, order_number, source_name, amplifier_last_error, amplifier_import_attempts, created_at")
    .eq("financial_status", "paid")
    .is("amplifier_order_id", null)
    .is("shopify_order_id", null)
    .not("amplifier_last_error", "is", null)
    .lt("created_at", staleCutoffIso)
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT);

  let scanned = 0;
  let opened = 0;
  let alreadyOpen = 0;
  let skippedFraud = 0;
  for (const row of (rows || []) as Array<{
    id: string;
    workspace_id: string;
    order_number: string | null;
    source_name: string | null;
    amplifier_last_error: string | null;
    amplifier_import_attempts: number | null;
    created_at: string;
  }>) {
    scanned++;
    if (await isFraudHeld(admin, row.workspace_id, row.id)) { skippedFraud++; continue; }

    // Same dedupe shape as escalateExhaustedOrders — a card of either kind for
    // this order short-circuits so we never double-alert on the same stuck row.
    const { data: existing } = await admin
      .from("dashboard_notifications")
      .select("id")
      .eq("workspace_id", row.workspace_id)
      .eq("type", "fulfillment_alert")
      .eq("dismissed", false)
      .contains("metadata", { order_id: row.id })
      .limit(1)
      .maybeSingle();
    if (existing) { alreadyOpen++; continue; }

    const orderLabel = row.order_number || row.id.slice(0, 8);
    const attempts = row.amplifier_import_attempts ?? 0;
    const ageHours = Math.round((Date.now() - new Date(row.created_at).getTime()) / 3_600_000);
    const { error } = await admin.from("dashboard_notifications").insert({
      workspace_id: row.workspace_id,
      type: "fulfillment_alert",
      title: `${orderLabel} — paid ${ageHours}h with Amplifier error (${row.source_name || "unknown source"})`,
      body: `Paid order ${orderLabel} has been sitting ${ageHours}h with an Amplifier error and has not been imported. Attempts so far: ${attempts}. Last error: ${row.amplifier_last_error || "unknown"}. On 2026-08-10 two paid renewals were only discovered because one customer wrote in — investigate before the customer notices.`,
      link: `/dashboard/orders/${row.id}`,
      metadata: {
        kind: "amplifier_import_stale_errored",
        order_id: row.id,
        order_number: row.order_number,
        source_name: row.source_name,
        attempts,
        age_hours: ageHours,
        last_error: row.amplifier_last_error,
      },
    });
    if (error) {
      console.warn(`[amplifier-import-reconcile] stale-errored fulfillment_alert insert failed for order ${row.id}: ${error.message}`);
    } else {
      opened++;
    }
  }
  return { scanned, opened, already_open: alreadyOpen, skipped_fraud: skippedFraud };
}

export const amplifierImportReconcileCron = inngest.createFunction(
  {
    id: "amplifier-import-reconcile",
    name: "Amplifier import reconcile — paid-but-un-imported sweep",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "*/15 * * * *" }],
  },
  async ({ step }) => {
    const startedAt = Date.now();

    const result = await step.run("reconcile-unimported-paid-orders", async () => {
      const admin = createAdminClient();
      const graceCutoffIso = new Date(Date.now() - GRACE_MINUTES * 60_000).toISOString();

      // Bounded enumeration — the guard against the fan-out coaching mistake.
      // amplifier_order_id null + financial_status='paid' + under the retry
      // cap + past the grace window narrows to the active-work slice.
      const { data: rows } = await admin
        .from("orders")
        .select("id, workspace_id, order_number, customer_id, source_name, email, shipping_address, billing_address, line_items, total_cents, created_at, amplifier_import_attempts, shopify_order_id")
        .eq("financial_status", "paid")
        .is("amplifier_order_id", null)
        .is("shopify_order_id", null)
        .lt("created_at", graceCutoffIso)
        .lt("amplifier_import_attempts", RETRY_CAP)
        .order("created_at", { ascending: true })
        .limit(BATCH_LIMIT);

      let scanned = 0;
      let imported = 0;
      let failed = 0;
      let skippedFraud = 0;
      let skippedNoSkus = 0;
      let skippedNonStorefront = 0;
      let skippedShopifyOrigin = 0;
      for (const row of (rows || []) as CandidateRow[]) {
        scanned++;
        try {
          const outcome = await reconcileOne(admin, row);
          if (outcome === "imported") imported++;
          else if (outcome === "failed") failed++;
          else if (outcome === "skipped-fraud") skippedFraud++;
          else if (outcome === "skipped-no-skus") skippedNoSkus++;
          else if (outcome === "skipped-shopify-origin") skippedShopifyOrigin++;
          else skippedNonStorefront++;
        } catch (e) {
          console.warn(`[amplifier-import-reconcile] threw for order ${row.id}: ${errText(e)}`);
          await stampAmplifierImportFailure(admin, row.id, "reconcile_threw", errText(e));
          failed++;
        }
      }

      return {
        scanned,
        imported,
        failed,
        skipped_fraud: skippedFraud,
        skipped_no_skus: skippedNoSkus,
        skipped_non_storefront: skippedNonStorefront,
        // Expected to stay 0 — the query excludes Shopify-origin rows. A
        // non-zero value on the beat means a selection lost its predicate.
        skipped_shopify_origin: skippedShopifyOrigin,
        grace_cutoff: graceCutoffIso,
      };
    });

    // Phase 3 — CEO-inbox escalation on retry-cap exhaustion. Separate step so
    // an escalation failure does not break the sweep result above, and so an
    // Inngest retry re-runs escalation independently (the dedupe guard keeps
    // it idempotent).
    const escalation = await step.run("escalate-exhausted-orders", async () => {
      const admin = createAdminClient();
      return escalateExhaustedOrders(admin);
    });

    // Residue safety net — paid + errored + not accepted within a day catches
    // any stuck order the exhaustion path missed (e.g. attempts stalled below
    // RETRY_CAP for any reason). Dedupes against the same un-dismissed
    // fulfillment_alert card so an already-escalated order gets exactly one.
    const staleEscalation = await step.run("escalate-stale-errored-orders", async () => {
      const admin = createAdminClient();
      return escalateStaleErroredOrders(admin);
    });

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("amplifier-import-reconcile", {
        ok: true,
        produced: { ...result, escalation, stale_escalation: staleEscalation },
        detail: `${result.scanned} scanned · ${result.imported} imported · ${result.failed} failed · ${result.skipped_fraud + result.skipped_no_skus + result.skipped_non_storefront + result.skipped_shopify_origin} skipped · escalation ${escalation.opened} opened / ${escalation.already_open} dedup · stale ${staleEscalation.opened} opened / ${staleEscalation.already_open} dedup`,
        durationMs: Date.now() - startedAt,
      });
    });

    return { ...result, escalation, stale_escalation: staleEscalation };
  },
);
