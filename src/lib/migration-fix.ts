/**
 * migration-fix — the deterministic executor + queue plumbing behind the
 * **migration-fix box agent** ([[docs/brain/specs/migration-fix-agent.md]]).
 *
 * North star (supervisable autonomy): a `failed` [[../tables/migration_audits]] row is a renewal at
 * risk. The box session ([[../recipes/build-box-setup]] `runMigrationFixJob`) DIAGNOSES the failing
 * checks read-only and PROPOSES a typed fix plan; the owner approves on /dashboard/migrations; the
 * worker (the only component with prod creds) executes the approved plan HERE — never freestyle DB
 * writes, never a silent re-bill — then re-runs `verifyMigration`. Only a re-`passed` audit clears.
 *
 * Two entry points:
 *   - `enqueueMigrationFixJob` — called inline by [[migration-audit]] `verifyMigration` the moment a
 *     row transitions to `failed` (event-driven; there is NO migration-fix cron). Deduped against an
 *     already-active job for the same audit.
 *   - `applyMigrationFix` — runs ONE owner-approved typed fix action against prod. Idempotent.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Sane absolute ceiling on a reconciled override (Superfoods SKUs are < $200; this just blocks an
 * absurd box-computed value — the real gate is the post-fix `verifyMigration` pricing re-check). */
const MAX_OVERRIDE_CENTS = 100_000;
/** Active job statuses — an audit with one of these migration-fix jobs already in flight is not re-queued. */
const ACTIVE_JOB_STATUSES = ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume"];

/** The judgment fixes the mechanical auto-heal punts (see [[migration-audit]] `autoHealMigration`). */
export type MigrationFixKind = "price_reconcile" | "variant_backfill" | "appstle_cancel";

/** Per-fix payloads — the box computes the concrete values read-only; the worker applies them verbatim. */
export interface PriceReconcilePayload {
  /** Each grandfathered line's reconciled base, keyed by the catalog variant UUID on the sub item. */
  overrides: { variant_id: string; price_override_cents: number }[];
}
export interface VariantBackfillPayload {
  /** The missing catalog row to insert (never loosen the check — backfill the row). product_id required. */
  variant: {
    product_id: string;
    shopify_variant_id: string;
    title?: string | null;
    sku?: string | null;
    price_cents?: number | null;
    option1?: string | null;
    option2?: string | null;
    option3?: string | null;
  };
  /** Which sub item to remap onto the new UUID — matched by the lingering Shopify id and/or SKU. */
  item_match: { shopify_variant_id?: string; sku?: string };
}
export interface AppstleCancelPayload {
  /** Optional override; defaults to the audit's old `appstle_contract_id`. */
  appstle_contract_id?: string;
  reason?: string;
}

export interface MigrationFixApplyResult {
  ok: boolean;
  detail: string;
}

type AuditRow = Record<string, unknown>;

/**
 * Enqueue a `migration-fix` agent job for an audit that just flipped to `failed`. Best-effort and
 * idempotent: no-op if an active migration-fix job already exists for this audit (the integrity sweep
 * can re-fail the same row). `spec_slug` = the audit id; `instructions` = `{audit_id, subscription_id}`.
 */
export async function enqueueMigrationFixJob(
  admin: Admin,
  input: { auditId: string; subscriptionId: string; workspaceId: string },
): Promise<{ enqueued: boolean; reason?: string }> {
  // Dedupe — one active migration-fix job per audit.
  const { data: existing } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("kind", "migration-fix")
    .eq("spec_slug", input.auditId)
    .in("status", ACTIVE_JOB_STATUSES)
    .limit(1)
    .maybeSingle();
  if (existing) return { enqueued: false, reason: "active job exists" };

  const { error } = await admin.from("agent_jobs").insert({
    workspace_id: input.workspaceId,
    spec_slug: input.auditId,
    kind: "migration-fix",
    status: "queued",
    instructions: JSON.stringify({ audit_id: input.auditId, subscription_id: input.subscriptionId }),
  });
  if (error) return { enqueued: false, reason: error.message };
  return { enqueued: true };
}

async function loadSubItems(admin: Admin, subscriptionId: string): Promise<{ items: Array<Record<string, unknown>> } | null> {
  const { data } = await admin.from("subscriptions").select("id, items").eq("id", subscriptionId).maybeSingle();
  if (!data) return null;
  return { items: Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [] };
}

/**
 * Apply ONE owner-approved typed fix against prod. Idempotent where it can be. The worker calls this
 * for each `approved` action, then re-runs `verifyMigration(auditId)` — only a re-pass clears the audit.
 */
export async function applyMigrationFix(
  admin: Admin,
  audit: AuditRow,
  action: { fix_kind: MigrationFixKind; payload: unknown },
): Promise<MigrationFixApplyResult> {
  const workspaceId = String(audit.workspace_id || "");
  const subscriptionId = String(audit.subscription_id || "");

  if (action.fix_kind === "price_reconcile") {
    const payload = (action.payload || {}) as PriceReconcilePayload;
    const overrides = Array.isArray(payload.overrides) ? payload.overrides : [];
    if (!overrides.length) return { ok: false, detail: "price_reconcile: no overrides provided" };
    // Validate every override before touching the row — fail closed on an absurd value.
    for (const o of overrides) {
      if (!o || !UUID_RE.test(String(o.variant_id || ""))) return { ok: false, detail: `price_reconcile: bad variant_id ${o?.variant_id}` };
      const c = o.price_override_cents;
      if (!Number.isInteger(c) || c <= 0 || c > MAX_OVERRIDE_CENTS) return { ok: false, detail: `price_reconcile: out-of-range cents for ${o.variant_id}` };
    }
    const sub = await loadSubItems(admin, subscriptionId);
    if (!sub) return { ok: false, detail: "price_reconcile: subscription not found" };
    const byVariant = new Map(overrides.map((o) => [String(o.variant_id), o.price_override_cents]));
    let touched = 0;
    const items = sub.items.map((i) => {
      const cents = byVariant.get(String(i.variant_id || ""));
      if (cents == null) return i;
      touched++;
      return { ...i, price_override_cents: cents };
    });
    if (!touched) return { ok: false, detail: "price_reconcile: no sub item matched the override variant ids" };
    const { error } = await admin.from("subscriptions").update({ items, updated_at: new Date().toISOString() }).eq("id", subscriptionId);
    if (error) return { ok: false, detail: `price_reconcile: write failed — ${error.message}` };
    return { ok: true, detail: `price_reconcile: set price_override_cents on ${touched} line(s)` };
  }

  if (action.fix_kind === "variant_backfill") {
    const payload = (action.payload || {}) as VariantBackfillPayload;
    const v = payload.variant;
    if (!v || !UUID_RE.test(String(v.product_id || ""))) return { ok: false, detail: "variant_backfill: bad/missing product_id" };
    if (!v.shopify_variant_id) return { ok: false, detail: "variant_backfill: missing shopify_variant_id" };

    // Idempotent: reuse an existing catalog row for this Shopify id if one already exists.
    const { data: existing } = await admin
      .from("product_variants")
      .select("id, product_id")
      .eq("workspace_id", workspaceId)
      .eq("shopify_variant_id", String(v.shopify_variant_id))
      .maybeSingle();
    let variantId = existing?.id as string | undefined;
    let productId = (existing?.product_id as string | undefined) || String(v.product_id);
    if (!variantId) {
      const { data: inserted, error } = await admin
        .from("product_variants")
        .insert({
          workspace_id: workspaceId,
          product_id: String(v.product_id),
          shopify_variant_id: String(v.shopify_variant_id),
          meta_id: String(v.shopify_variant_id),
          title: v.title ?? null,
          sku: v.sku ?? null,
          price_cents: Number.isInteger(v.price_cents) ? (v.price_cents as number) : 0,
          option1: v.option1 ?? null,
          option2: v.option2 ?? null,
          option3: v.option3 ?? null,
        })
        .select("id, product_id")
        .single();
      if (error || !inserted) return { ok: false, detail: `variant_backfill: insert failed — ${error?.message || "no row"}` };
      variantId = inserted.id as string;
      productId = inserted.product_id as string;
    }

    // Remap the sub item that points at the lingering Shopify id (or matches by SKU) → the UUID row.
    const sub = await loadSubItems(admin, subscriptionId);
    if (!sub) return { ok: false, detail: "variant_backfill: subscription not found" };
    const matchShopId = String(payload.item_match?.shopify_variant_id || v.shopify_variant_id);
    const matchSku = payload.item_match?.sku ? String(payload.item_match.sku) : null;
    let remapped = 0;
    const items = sub.items.map((i) => {
      const vid = String(i.variant_id || "");
      const isMatch = vid === matchShopId || (matchSku != null && String(i.sku || "") === matchSku && !UUID_RE.test(vid));
      if (!isMatch) return i;
      remapped++;
      return { ...i, variant_id: variantId, product_id: productId, sku: i.sku ?? v.sku ?? undefined };
    });
    if (!remapped) return { ok: false, detail: `variant_backfill: row ${existing ? "reused" : "created"} but no sub item matched to remap` };
    const { error: upErr } = await admin.from("subscriptions").update({ items, updated_at: new Date().toISOString() }).eq("id", subscriptionId);
    if (upErr) return { ok: false, detail: `variant_backfill: remap write failed — ${upErr.message}` };
    return { ok: true, detail: `variant_backfill: ${existing ? "reused" : "inserted"} variant ${variantId}; remapped ${remapped} item(s)` };
  }

  if (action.fix_kind === "appstle_cancel") {
    const payload = (action.payload || {}) as AppstleCancelPayload;
    const contractId = String(payload.appstle_contract_id || audit.appstle_contract_id || "");
    if (!contractId) return { ok: false, detail: "appstle_cancel: no appstle_contract_id" };
    try {
      const { appstleSubscriptionAction } = await import("@/lib/appstle");
      const r = await appstleSubscriptionAction(workspaceId, contractId, "cancel", payload.reason || "migrated to shopcx", "ShopCX migration-fix");
      return r.success
        ? { ok: true, detail: `appstle_cancel: cancelled lingering contract ${contractId}` }
        : { ok: false, detail: `appstle_cancel: ${r.error || "cancel failed"}` };
    } catch (e) {
      return { ok: false, detail: `appstle_cancel: threw — ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  return { ok: false, detail: `unknown fix_kind: ${(action as { fix_kind?: string }).fix_kind}` };
}
