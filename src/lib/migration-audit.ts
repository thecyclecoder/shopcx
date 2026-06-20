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
}

/** Create the pending audit row at migration time. Returns its id. */
export async function recordMigrationAudit(input: RecordAuditInput): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("migration_audits")
    .insert({
      workspace_id: input.workspaceId,
      subscription_id: input.subscriptionId,
      appstle_contract_id: input.appstleContractId,
      internal_contract_id: input.internalContractId,
      pre_migration_charge_cents: input.preMigrationChargeCents,
      is_recovery: !!input.isRecovery,
      status: "pending",
    })
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
    .select("id, is_internal, status, shopify_contract_id, items, customer_id, payment_method_id, delivery_price_cents, shipping_protection_added, shipping_protection_amount_cents")
    .eq("id", subscriptionId)
    .maybeSingle();
  return (data as Sub) || null;
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
    push("pricing_preserved", pre <= 0 || Math.abs(engineCents - pre) <= tol, `engine ${engineCents}¢ vs pre ${pre}¢`);
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
      const { data: txn } = await admin
        .from("transactions").select("id, status").eq("subscription_id", sub.id as string)
        .eq("type", "renewal").order("created_at", { ascending: false }).limit(1).maybeSingle();
      push("immediate_charge", txn?.status === "succeeded", txn ? `last renewal ${txn.status}` : "no renewal yet");
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
      const { appstleSubscriptionAction } = await import("@/lib/appstle");
      // Use the OLD appstle contract id directly (the sub row now holds internal-*).
      const r = await appstleSubscriptionAction(audit.workspace_id as string, String(audit.appstle_contract_id), "cancel", "migrated to shopcx", "ShopCX auto-heal");
      if (r.success) changed = true;
    } catch (e) {
      console.error("[migration-audit] auto-heal cancel failed:", e instanceof Error ? e.message : e);
    }
  }

  return changed;
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
