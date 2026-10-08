/**
 * Migration verification monitor.
 *
 * After an Appstle→internal migration, we run a checklist per sub and record it
 * in [[../tables/migration_audits]]. North star: after `status='passed'`, the sub
 * is guaranteed to bill on its next renewal. A `failed` row is a renewal at risk.
 *
 * Flow: the migration calls recordMigrationAudit() (pending row + the captured
 * pre-migration charge), then verifyMigration() runs inline. On failure it stays
 * pending and the migration-audit-retry Inngest loop re-verifies up to MAX_RETRIES
 * times before flagging `failed` for manual review.
 *
 * See docs/brain/specs/appstle-pricing-heal-and-migration-monitor.md § Phase 3.
 */
import { createAdminClient } from "@/lib/supabase/admin";

const MAX_RETRIES = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Per-line tolerance for the pricing-sanity check (rounding drift across lines). */
const PRICE_TOLERANCE_CENTS = 2;

export interface AuditCheck { key: string; ok: boolean; detail?: string }

export interface RecordAuditInput {
  workspaceId: string;
  subscriptionId: string;
  appstleContractId: string;   // the OLD numeric Appstle contract id (pre-flip)
  internalContractId: string;  // the new internal-* id
  preMigrationChargeCents: number;
  isRecovery?: boolean;
  /**
   * Lines the migration couldn't map to an internal variant and DROPPED (out of
   * stock / discontinued / no internal product). Logged once into `notes` so the
   * drop is auditable; never overwritten by re-verify. A paid drop is separately
   * escalated by the migration caller.
   */
  droppedLines?: Array<{ title: string; shopifyVariantId: string; sku: string | null; priceCents: number; quantity: number; paid: boolean }>;
  /**
   * The product lines the sub carried at migration (variant + quantity) — the item set the
   * captured `preMigrationChargeCents` prices. Stored as a `migrated_items` note so a later
   * re-verify can tell "the customer changed their box" from "the price is wrong".
   */
  migratedItems?: Array<{ variant_id: string; quantity: number }>;
  /**
   * Lines deliberately left off the migrated sub: an excluded product (MIGRATION_EXCLUDED_PRODUCT_IDS
   * in migrate-to-internal — e.g. ACV Gummies, no stock) or an Appstle one-time promo line.
   * Logged once into `notes`; no page.
   */
  excludedLines?: Array<{ title: string; productId: string; variantId: string; priceCents: number; quantity: number; reason: "excluded_product" | "one_time_promo" }>;
}

/** Create the pending audit row at migration time. Returns its id. */
export async function recordMigrationAudit(input: RecordAuditInput): Promise<string | null> {
  const admin = createAdminClient();
  const row: Record<string, unknown> = {
    workspace_id: input.workspaceId,
    subscription_id: input.subscriptionId,
    appstle_contract_id: input.appstleContractId,
    internal_contract_id: input.internalContractId,
    pre_migration_charge_cents: input.preMigrationChargeCents,
    is_recovery: !!input.isRecovery,
    status: "pending",
  };
  // Record dropped-unmappable / policy-excluded notes (column defaults to [] when none).
  const notes: Array<Record<string, unknown>> = [];
  if (input.droppedLines?.length) notes.push({ type: "dropped_unmappable_items", items: input.droppedLines });
  if (input.excludedLines?.length) notes.push({ type: "excluded_product_items", items: input.excludedLines });
  if (input.migratedItems) notes.push({ type: "migrated_items", items: input.migratedItems });
  if (notes.length) row.notes = notes;
  const { data, error } = await admin
    .from("migration_audits")
    .insert(row)
    .select("id")
    .single();
  if (error) { console.error("[migration-audit] record failed:", error.message); return null; }
  return data.id as string;
}

/**
 * Run the checklist for one audit row and update its status.
 * passed → all required checks ok. Otherwise retry_count++; pending until
 * MAX_RETRIES, then failed (flag for review).
 */
type Sub = Record<string, unknown>;

async function loadSub(admin: ReturnType<typeof createAdminClient>, subscriptionId: string): Promise<Sub | null> {
  const { data } = await admin
    .from("subscriptions")
    .select("id, is_internal, status, shopify_contract_id, items, customer_id, payment_method_id, delivery_price_cents, shipping_protection_added, shipping_protection_amount_cents, last_payment_status")
    .eq("id", subscriptionId)
    .maybeSingle();
  return (data as Sub) || null;
}

/**
 * Judge the recovery migration's `immediate_charge` outcome against SETTLED
 * subscription state, NOT the pre-retry `renewal` transaction. The old
 * check read the last `renewal` inline the instant the audit row was
 * created — which is the same instant the deterministic order-now retry
 * (`commerce.order_now.retry_after_migrate`) fires — and always saw the
 * OLD failed renewal, so 10/10 measured failures on 2026-08-28 were
 * false positives whose subs had actually just been paid (ground truth:
 * audit `ecf8e8fc` / sub `549c234d` / Denise Butler — audit created
 * `03:21:27.99`, order SHOPCX229 paid $64.96 at `03:21:32.92`, sub reads
 * `last_payment_status='succeeded'`).
 *
 * Passes when EITHER the subscription's `last_payment_status='succeeded'`
 * OR an [[../tables/orders]] row for this subscription with
 * `financial_status in ('paid','partially_refunded')` was created after
 * the migration timestamp (`migration_audits.created_at`). Fails when
 * neither is true — the audit row's existing MAX_RETRIES=3 budget, re-driven
 * by [[../inngest/migration-audit-retry]] every 10 min, carries the wait
 * so the retry gets a chance to settle. Do NOT sleep inline.
 *
 * Exported so the ship-time backfill for historical false failures
 * ([[../../scripts/_backfill-migration-audit-immediate-charge-false-failures]])
 * uses the SAME predicate the live check does — no drift.
 */
export async function reverifyImmediateCharge(
  admin: ReturnType<typeof createAdminClient>,
  input: {
    workspaceId: string;
    subscriptionId: string;
    /** `migration_audits.created_at` — the cutoff for the "paid order landed AFTER migration" test. */
    migratedAt: string;
    /** Current `subscriptions.last_payment_status` read alongside the sub. */
    lastPaymentStatus: string | null;
  },
): Promise<{ ok: boolean; detail: string }> {
  type PaidOrder = { id: string; order_number: string | null; financial_status: string | null };
  const succeededOnSub = input.lastPaymentStatus === "succeeded";
  let paidOrder: PaidOrder | null = null;
  if (!succeededOnSub && input.migratedAt) {
    const { data: order } = await admin
      .from("orders")
      .select("id, order_number, financial_status")
      .eq("workspace_id", input.workspaceId)
      .eq("subscription_id", input.subscriptionId)
      .gte("created_at", input.migratedAt)
      .in("financial_status", ["paid", "partially_refunded"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    paidOrder = (order as PaidOrder | null) ?? null;
  }
  const ok = succeededOnSub || !!paidOrder;
  const orderTag = paidOrder ? (paidOrder.order_number ?? paidOrder.id) : "";
  const detail = ok
    ? succeededOnSub
      ? `settled: last_payment_status=succeeded${orderTag ? ` + order ${orderTag}` : ""}`
      : `settled: paid order ${orderTag}`
    : `unsettled: last_payment_status=${input.lastPaymentStatus ?? "null"}, no paid order since ${input.migratedAt || "?"}`;
  return { ok, detail };
}

/** Canonical multiset key for a product item set (variant × quantity), order-insensitive. */
export function itemSetKey(items: ReadonlyArray<{ variant_id?: unknown; quantity?: unknown }>): string {
  const m = new Map<string, number>();
  for (const i of items) {
    const v = String(i.variant_id || "");
    if (!v) continue;
    m.set(v, (m.get(v) || 0) + Number(i.quantity || 1));
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([v, q]) => `${v}x${q}`).join(",");
}

/**
 * Pure verdict for `pricing_preserved`. Two legitimate shapes used to false-fail forever:
 *
 *  A. **Moved to the standard rate.** Appstle billed ABOVE our standard subscriber price (no S&S
 *     ever applied, or a base set before a catalog price drop) and every product line now prices
 *     off the plain catalog (no override / no baked lock). That is the CEO rule of 2026-08-02:
 *     apply standard S&S, never grandfather the HIGHER price. The engine can't reproduce the old
 *     price (base ≤ MSRP invariant) and shouldn't, so `pre > engine` here is correct, not a defect.
 *     Still FAILS when we'd charge MORE than Appstle, or less on a locked (grandfathered) line.
 *  B. **The customer changed their items after migration.** The captured baseline prices the
 *     migrated item set; once the box changes, comparing to it is meaningless → skip, with a note.
 */
export function judgePricingPreserved(input: {
  pre: number;
  noBreakCents: number;
  tol: number;
  /** Every product line is on the catalog price (no price_override_cents / baked price_cents). */
  allProductLinesStandard: boolean;
  itemsChangedSinceMigration: boolean;
}): { ok: boolean; reason: "match" | "no_baseline" | "items_changed" | "moved_to_standard_rate" | "mismatch" } {
  const { pre, noBreakCents, tol } = input;
  if (pre <= 0) return { ok: true, reason: "no_baseline" };
  if (Math.abs(noBreakCents - pre) <= tol) return { ok: true, reason: "match" };
  if (input.itemsChangedSinceMigration) return { ok: true, reason: "items_changed" };
  if (noBreakCents < pre && input.allProductLinesStandard) return { ok: true, reason: "moved_to_standard_rate" };
  return { ok: false, reason: "mismatch" };
}

/** Did the customer change this sub's items after the audit was created? */
async function itemsChangedSinceMigration(
  admin: ReturnType<typeof createAdminClient>,
  audit: Record<string, unknown>,
  sub: Sub,
): Promise<boolean> {
  const productItems = ((Array.isArray(sub.items) ? sub.items : []) as Array<Record<string, unknown>>)
    .filter((i) => !i.is_gift && !String(i.title || "").toLowerCase().includes("shipping protection"));
  const notes = (Array.isArray(audit.notes) ? audit.notes : []) as Array<{ type?: string; items?: Array<{ variant_id: string; quantity: number }> }>;
  const snap = notes.find((n) => n?.type === "migrated_items");
  if (snap?.items) return itemSetKey(snap.items) !== itemSetKey(productItems);
  // Audits recorded before the snapshot existed: fall back to the portal item-change events,
  // which carry the sub's (internal) contract id.
  if (!audit.created_at || !sub.shopify_contract_id) return false;
  const { count } = await admin
    .from("customer_events")
    .select("id", { count: "exact", head: true })
    .in("event_type", ["portal.items.swapped", "portal.items.removed", "portal.items.added", "subscription.items.removed"])
    .eq("properties->>shopify_contract_id", String(sub.shopify_contract_id))
    .gte("created_at", String(audit.created_at));
  return (count ?? 0) > 0;
}

/** Run the full checklist against the current sub state. */
async function runChecks(admin: ReturnType<typeof createAdminClient>, audit: Record<string, unknown>, sub: Sub): Promise<AuditCheck[]> {
  const checks: AuditCheck[] = [];
  const push = (key: string, ok: boolean, detail?: string) => checks.push({ key, ok, detail });

  const isLive = ["active", "paused"].includes(String(sub.status));

  push("is_internal", sub.is_internal === true);
  const cid = String(sub.shopify_contract_id || "");
  push("internal_contract_id", cid.startsWith("internal-"), cid);
  const items = (Array.isArray(sub.items) ? sub.items : []) as Array<Record<string, unknown>>;
  const badItems = items.filter((i) => {
    const isProt = String(i.title || "").toLowerCase().includes("shipping protection");
    return !isProt && !UUID_RE.test(String(i.variant_id || ""));
  });
  push("items_on_uuids", badItems.length === 0, badItems.length ? `${badItems.length} item(s) not UUID` : undefined);

  await verifyAppstleCancelled(admin, audit.workspace_id as string, String(audit.appstle_contract_id || ""), push);

  try {
    const { resolveSubscriptionPricing } = await import("@/lib/pricing");
    const pricing = await resolveSubscriptionPricing(audit.workspace_id as string, sub);
    const engineCents = pricing.product_subtotal_cents;
    const pre = Number(audit.pre_migration_charge_cents || 0);
    const tol = Math.max(PRICE_TOLERANCE_CENTS, items.length * PRICE_TOLERANCE_CENTS);

    // The Appstle baseline (`pre`) is Σ per-line currentPrice — it carries S&S but
    // NEVER our internal mix-and-match quantity break (Appstle contracts had no
    // such tier). The engine legitimately applies that break on renewal, so a
    // migrated multi-unit sub on a rule with a break prices BELOW `pre` by exactly
    // the break amount, and price_reconcile can't repair it (raising the base to
    // cancel the break would exceed MSRP, forbidden). So compare on the SAME bases
    // the engine used but WITHOUT the quantity break: reconstruct each product
    // line's S&S-only unit (base × (1 − sns), break removed) and sum. That no-break
    // subtotal is what the Appstle baseline should equal. The tolerated shortfall
    // (`pre − engine`) is thus tied to the specific catalog break the rule grants
    // for this line's qty — we do NOT blanket-accept engine < pre. A wrong/too-high
    // base still fails (no-break subtotal > pre → charged MORE), and any underpricing
    // not explained by the break still fails (no-break subtotal < pre).
    // See docs/brain/specs/migration-pricing-preserved-quantity-break.md.
    const noBreakCents = pricing.lines
      .filter((l) => l.kind === "product")
      .reduce((s, l) => s + Math.round(l.base_cents * (1 - l.sns_pct / 100)) * l.quantity, 0);
    const breakCents = noBreakCents - engineCents; // ≥ 0 — the legitimate qty-break shortfall
    const productLines = pricing.lines.filter((l) => l.kind === "product");
    const lockedItem = items.some((i) =>
      !i.is_gift && !String(i.title || "").toLowerCase().includes("shipping protection") &&
      (i.price_override_cents != null || (i.price_cents != null && Number(i.price_cents) > 0)));
    const verdict = judgePricingPreserved({
      pre,
      noBreakCents,
      tol,
      allProductLinesStandard: !lockedItem && productLines.every((l) => !l.is_grandfathered),
      itemsChangedSinceMigration:
        Math.abs(noBreakCents - pre) > tol ? await itemsChangedSinceMigration(admin, audit, sub) : false,
    });
    const why =
      verdict.reason === "items_changed" ? " — skipped: the customer changed this sub's items after migration"
      : verdict.reason === "moved_to_standard_rate" ? " — moved to the standard subscriber rate (Appstle billed above it; CEO rule 2026-08-02)"
      : "";
    push(
      "pricing_preserved",
      verdict.ok,
      `engine ${engineCents}¢ (+${breakCents}¢ qty-break = ${noBreakCents}¢ pre-break) vs pre ${pre}¢${why}`,
    );
  } catch (e) {
    push("pricing_preserved", false, e instanceof Error ? e.message : "pricing engine threw");
  }

  if (audit.is_recovery) {
    // "Billable card" — a sub with no PINNED card bills on the link-group
    // default (same fallback the renewal + sub-detail display use), so the
    // check passes when EITHER a pinned card or a default exists. This is
    // why even a cancelled-but-reactivatable sub is fine: if reactivated it
    // charges the default. It only fails when there's genuinely no card
    // anywhere in the link group.
    let hasCard = !!sub.payment_method_id;
    if (!hasCard) {
      const { linkGroupIds } = await import("@/lib/customer-links");
      const groupIds = await linkGroupIds(admin, audit.workspace_id as string, sub.customer_id as string);
      const { data: def } = await admin
        .from("customer_payment_methods").select("id")
        .eq("workspace_id", audit.workspace_id as string)
        .in("customer_id", groupIds)
        .eq("status", "active").eq("is_default", true).eq("provider", "braintree")
        .limit(1).maybeSingle();
      hasCard = !!def;
    }
    push("card_pinned", hasCard, hasCard ? (sub.payment_method_id ? "pinned" : "link-group default") : "no card in link group");

    // The immediate recovery charge only exists for a LIVE sub — a recovery
    // that ended cancelled (e.g. a superseded duplicate) never charged.
    if (isLive) {
      const settled = await reverifyImmediateCharge(admin, {
        workspaceId: audit.workspace_id as string,
        subscriptionId: sub.id as string,
        migratedAt: String(audit.created_at || ""),
        lastPaymentStatus: (sub.last_payment_status as string | null | undefined) ?? null,
      });
      push("immediate_charge", settled.ok, settled.detail);
    }
  }

  const internalLive = sub.is_internal === true && ["active", "paused"].includes(String(sub.status));
  const appstleCancelled = checks.find((c) => c.key === "appstle_cancelled")?.ok ?? false;
  push("no_double_bill", !(internalLive && !appstleCancelled), internalLive && !appstleCancelled ? "internal live but Appstle NOT cancelled" : undefined);

  return checks;
}

/**
 * Self-heal mechanically-fixable check failures. Returns true if anything was
 * changed (so the caller re-verifies). Fixes:
 *  - items_on_uuids: resolve each Shopify-id item → its catalog UUID + product_id.
 *  - appstle_cancelled / no_double_bill: cancel the lingering Appstle contract.
 * Pricing mismatches are NOT auto-fixed (need judgment) → those flag for review.
 */
async function autoHealMigration(
  admin: ReturnType<typeof createAdminClient>,
  audit: Record<string, unknown>,
  sub: Sub,
  checks: AuditCheck[],
): Promise<boolean> {
  let changed = false;
  const failed = (key: string) => checks.some((c) => c.key === key && !c.ok);

  // Fix Shopify-id items → UUIDs.
  if (failed("items_on_uuids")) {
    const items = (Array.isArray(sub.items) ? sub.items : []) as Array<Record<string, unknown>>;
    let touched = false;
    const fixed = await Promise.all(items.map(async (i) => {
      const isProt = String(i.title || "").toLowerCase().includes("shipping protection");
      if (isProt || UUID_RE.test(String(i.variant_id || ""))) return i;
      const { data: byShopId } = await admin
        .from("product_variants").select("id, product_id, title, sku")
        .eq("workspace_id", audit.workspace_id as string)
        .eq("shopify_variant_id", String(i.variant_id || "")).maybeSingle();
      // Fall back to SKU (workspace-scoped) when the Shopify variant id isn't on
      // our catalog — a migrated line can carry a Shopify id we never synced, but
      // the SKU still resolves the internal variant.
      let v = byShopId;
      if (!v && i.sku) {
        const { data: bySku } = await admin
          .from("product_variants").select("id, product_id, title, sku")
          .eq("workspace_id", audit.workspace_id as string)
          .eq("sku", String(i.sku)).maybeSingle();
        v = bySku;
      }
      if (!v) return i; // can't resolve — leave (will stay flagged)
      touched = true;
      return { ...i, variant_id: v.id, product_id: v.product_id, sku: i.sku ?? v.sku ?? undefined };
    }));
    if (touched) {
      await admin.from("subscriptions").update({ items: fixed, updated_at: new Date().toISOString() }).eq("id", sub.id as string);
      changed = true;
    }
  }

  // Cancel a lingering Appstle contract (double-bill risk).
  if ((failed("appstle_cancelled") || failed("no_double_bill")) && audit.appstle_contract_id) {
    try {
      const { subscriptionCancelAtVendorForMigration } = await import("@/lib/commerce/subscription");
      // Use the OLD appstle contract id directly (the sub row now holds internal-*). Vendor-only:
      // a customer-style cancel would also write cancel-truth / end dunning by that old id.
      const r = await subscriptionCancelAtVendorForMigration(audit.workspace_id as string, String(audit.appstle_contract_id), "appstle");
      if (r.success) changed = true;
    } catch (e) {
      console.error("[migration-audit] auto-heal cancel failed:", e instanceof Error ? e.message : e);
    }
  }

  return changed;
}

/**
 * READ-ONLY preview: run the checklist for one audit against the current sub state and return the
 * checks, WITHOUT auto-healing or writing anything (verifyMigration both heals and persists). Lets an
 * operator see what a re-verify would do — in particular whether a row would trigger an auto-heal
 * (items_on_uuids remap / an Appstle cancel) — before running it.
 */
export async function previewMigrationChecks(auditId: string): Promise<{ checks: AuditCheck[]; wouldAutoHeal: boolean } | null> {
  const admin = createAdminClient();
  const { data: audit } = await admin.from("migration_audits").select("*").eq("id", auditId).maybeSingle();
  if (!audit) return null;
  const sub = await loadSub(admin, audit.subscription_id as string);
  if (!sub) return { checks: [{ key: "subscription_exists", ok: false, detail: "subscription row gone" }], wouldAutoHeal: false };
  const checks = await runChecks(admin, audit, sub);
  const failedKey = (k: string) => checks.some((c) => c.key === k && !c.ok);
  return { checks, wouldAutoHeal: failedKey("items_on_uuids") || failedKey("appstle_cancelled") || failedKey("no_double_bill") };
}

export async function verifyMigration(auditId: string): Promise<{ status: string; checks: AuditCheck[] }> {
  const admin = createAdminClient();
  const { data: audit } = await admin.from("migration_audits").select("*").eq("id", auditId).maybeSingle();
  if (!audit) return { status: "failed", checks: [{ key: "audit_exists", ok: false, detail: "audit row not found" }] };

  let sub = await loadSub(admin, audit.subscription_id as string);
  if (!sub) return finalize(admin, audit, [{ key: "subscription_exists", ok: false, detail: "subscription row gone" }]);

  let checks = await runChecks(admin, audit, sub);
  // Self-heal fixable failures, then re-verify once.
  if (!checks.every((c) => c.ok)) {
    const healed = await autoHealMigration(admin, audit, sub, checks);
    if (healed) {
      sub = await loadSub(admin, audit.subscription_id as string);
      if (sub) checks = await runChecks(admin, audit, sub);
    }
  }
  return finalize(admin, audit, checks);
}

async function verifyAppstleCancelled(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  appstleContractId: string,
  push: (key: string, ok: boolean, detail?: string) => void,
): Promise<void> {
  if (!appstleContractId) { push("appstle_cancelled", true, "no appstle contract id"); push("cancel_reason", true, "n/a"); return; }
  try {
    const { decrypt } = await import("@/lib/crypto");
    const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", workspaceId).maybeSingle();
    if (!ws?.appstle_api_key_encrypted) { push("appstle_cancelled", true, "appstle not configured — skipped"); push("cancel_reason", true, "skipped"); return; }
    const apiKey = decrypt(ws.appstle_api_key_encrypted);
    const r = await fetch(`https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${appstleContractId}?api_key=${apiKey}`, { headers: { "X-API-Key": apiKey }, cache: "no-store" });
    if (r.status === 404) { push("appstle_cancelled", true, "contract not found (gone)"); push("cancel_reason", true, "n/a"); return; }
    const contract = await r.json().catch(() => null);
    const status = contract?.status;
    push("appstle_cancelled", status === "CANCELLED", `appstle status ${status}`);
    // 5. cancel reason — best-effort (field absent → don't fail on it).
    const reason = String(contract?.cancellationReason || contract?.cancellationFeedback || contract?.cancellationNote || "").toLowerCase();
    push("cancel_reason", reason === "" || reason.includes("migrated to shopcx"), reason || "unreadable");
  } catch (e) {
    push("appstle_cancelled", false, e instanceof Error ? e.message : "appstle fetch threw");
    push("cancel_reason", true, "skipped (fetch error)");
  }
}

async function finalize(
  admin: ReturnType<typeof createAdminClient>,
  audit: Record<string, unknown>,
  checks: AuditCheck[],
): Promise<{ status: string; checks: AuditCheck[] }> {
  const allOk = checks.every((c) => c.ok);
  const retry = Number(audit.retry_count || 0) + 1;
  const status = allOk ? "passed" : retry >= MAX_RETRIES ? "failed" : "pending";
  const lastError = allOk ? null : checks.filter((c) => !c.ok).map((c) => `${c.key}: ${c.detail || "fail"}`).join("; ");
  await admin
    .from("migration_audits")
    .update({ status, checks, retry_count: retry, last_error: lastError, updated_at: new Date().toISOString() })
    .eq("id", audit.id as string);

  // Event trigger (NOT a cron): the moment a row transitions to `failed`, hand it to the
  // migration-fix box agent to attempt the judgment fixes auto-heal punts + re-verify. Fire only on
  // the TRANSITION (prior status !== failed) so a re-audit of an already-failed row doesn't re-queue;
  // enqueue is idempotent + best-effort — it must never break verification.
  // See docs/brain/specs/migration-fix-agent.md.
  if (status === "failed" && String(audit.status) !== "failed") {
    try {
      const { enqueueMigrationFixJob } = await import("@/lib/migration-fix");
      await enqueueMigrationFixJob(admin, {
        auditId: audit.id as string,
        subscriptionId: audit.subscription_id as string,
        workspaceId: audit.workspace_id as string,
      });
    } catch (e) {
      console.error("[migration-audit] enqueue migration-fix failed:", e instanceof Error ? e.message : e);
    }
  }
  return { status, checks };
}
