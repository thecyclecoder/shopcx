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

  // A cancelled migrated sub never bills, so the billing-protection checks
  // (items on UUIDs, card pinned, immediate charge) are moot for it — only
  // the core migration facts (is_internal, internal contract id, Appstle
  // cancelled, no double-bill) matter. Without this, a correctly-cancelled
  // sub (a superseded duplicate, a voluntary cancel, a test sub) false-flags
  // on the dashboard forever. We still RECORD the billing checks for
  // visibility, but they don't fail the audit when the sub is cancelled.
  const isLive = ["active", "paused"].includes(String(sub.status));

  push("is_internal", sub.is_internal === true);
  const cid = String(sub.shopify_contract_id || "");
  push("internal_contract_id", cid.startsWith("internal-"), cid);
  const items = (Array.isArray(sub.items) ? sub.items : []) as Array<Record<string, unknown>>;
  const badItems = items.filter((i) => {
    const isProt = String(i.title || "").toLowerCase().includes("shipping protection");
    return !isProt && !UUID_RE.test(String(i.variant_id || ""));
  });
  push(
    "items_on_uuids",
    badItems.length === 0 || !isLive,
    badItems.length ? `${badItems.length} item(s) not UUID${!isLive ? " (cancelled — won't bill)" : ""}` : undefined,
  );

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

  // Recovery checks only apply to a LIVE sub — a recovery that ended
  // cancelled (e.g. a superseded duplicate) has no card or renewal by design.
  if (audit.is_recovery && isLive) {
    push("card_pinned", !!sub.payment_method_id, sub.payment_method_id ? undefined : "no pinned card");
    const { data: txn } = await admin
      .from("transactions").select("id, status").eq("subscription_id", sub.id as string)
      .eq("type", "renewal").order("created_at", { ascending: false }).limit(1).maybeSingle();
    push("immediate_charge", txn?.status === "succeeded", txn ? `last renewal ${txn.status}` : "no renewal yet");
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
      const { data: v } = await admin
        .from("product_variants").select("id, product_id, title, sku")
        .eq("shopify_variant_id", String(i.variant_id || "")).maybeSingle();
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
  return { status, checks };
}
