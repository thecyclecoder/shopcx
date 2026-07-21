import type { RouteHandler } from "@/lib/portal/types";
import { errText } from "@/lib/error-text";
import { jsonOk, jsonErr, findCustomer, logPortalAction, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { vaultAndMigratePaymentMethod } from "@/lib/vault-and-migrate-payment-method";

function s(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }

/**
 * updatePaymentMethod — vault a new card (from Braintree Hosted Fields in the
 * portal) as the customer's default, then sweep their Appstle subs onto our
 * internal rails (strangler migration — spec § 1c). The in-house portal
 * previously had no add/update card flow; failed-payment subs couldn't
 * self-serve a new card. The vault → save → migrate sequence lives in
 * src/lib/vault-and-migrate-payment-method.ts and is shared with the
 * add_payment_method mini-site journey (spec-add-payment-method-journey.md
 * Phase 2) so the two flows never drift.
 */
export const updatePaymentMethod: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }
  const nonce = s(payload?.paymentMethodNonce);
  const deviceData = s(payload?.deviceData) || undefined;
  if (!nonce) return jsonErr({ error: "missing_payment_method_nonce" }, 400);

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  const admin = createAdminClient();

  // Flags: a plain "add a default card" makes it default + migrates the book;
  // "add a card for one subscription" passes makeDefault:false + migrate:false so
  // it's just vaulted (the caller then pins it to that sub). `recover` is the
  // failed-payment magic-link flow: default + migrate + pin to every sub + Slack.
  const recover = payload?.recover === true;
  const makeDefault = payload?.makeDefault !== false;
  const doMigrate = payload?.migrate !== false;

  let vaulted;
  let saved;
  let migratedCount = 0;
  try {
    const result = await vaultAndMigratePaymentMethod({
      workspaceId: auth.workspaceId,
      customerId: customer.id,
      customerEmail: customer.email || "",
      customerFirstName: (customer.first_name as string | null) || null,
      customerLastName: (customer.last_name as string | null) || null,
      paymentMethodNonce: nonce,
      deviceData,
      makeDefault,
      migrate: doMigrate,
      isRecovery: recover,
    });
    vaulted = result.vaulted;
    saved = { id: result.paymentMethodId };
    migratedCount = result.migratedCount;
  } catch (e) {
    const msg = errText(e);
    if (msg === "no_braintree_customer") return jsonErr({ error: "no_braintree_customer" }, 400);
    return jsonErr({ error: "vault_failed", message: msg }, 502);
  }

  // Recovery flow: pin the new card to every active internal sub across the link
  // group (so the failed card is replaced everywhere the next renewal will charge),
  // then DM the team. Reactivating involuntarily-cancelled subs is handled per-case
  // during prep (auto-reactivating all cancelled subs risks reviving voluntary
  // cancels + duplicates), so the recovery itself only touches active/paused subs.
  let pinnedCount = 0;
  let reactivatedCount = 0;
  let chargedCount = 0;
  if (recover) {
    try {
      const { linkGroupIds } = await import("@/lib/customer-links");
      const groupIds = await linkGroupIds(admin, auth.workspaceId, customer.id);
      // Reactivate subs that DUNNING cancelled (keyed on an exhausted dunning cycle
      // — never voluntary cancels). Done before the pin query so revived subs are
      // active and get the new card pinned in the same pass.
      let reactivatedIds: string[] = [];
      try {
        const { reactivateDunningCancelledSubs } = await import("@/lib/inngest/internal-dunning");
        reactivatedIds = await reactivateDunningCancelledSubs(auth.workspaceId, groupIds);
        reactivatedCount = reactivatedIds.length;
      } catch (e) {
        console.error("[portal/payment] dunning reactivate failed (non-fatal):", e instanceof Error ? e.message : e);
      }
      const { data: subs } = await admin
        .from("subscriptions")
        .select("id")
        .eq("workspace_id", auth.workspaceId)
        .in("customer_id", groupIds)
        .eq("is_internal", true)
        .in("status", ["active", "paused"]);
      const subIds = (subs || []).map((s) => s.id as string);
      if (subIds.length) {
        await admin.from("subscriptions")
          .update({ payment_method_id: saved.id, updated_at: new Date().toISOString() })
          .in("id", subIds);
        pinnedCount = subIds.length;
      }

      // Recover the missed payment NOW: charge the new card immediately for any
      // sub that was failing (an open dunning cycle) or that we just reactivated,
      // instead of waiting for the next scheduled renewal. The internal renewal
      // pipeline charges → creates the order → closes the dunning cycle on success
      // (closeInternalDunningOnSuccess). Healthy subs (no dunning cycle) are NOT
      // charged — we only collect what was actually owed.
      try {
        const { data: openCycles } = await admin
          .from("dunning_cycles")
          .select("subscription_id")
          .eq("workspace_id", auth.workspaceId)
          .in("customer_id", groupIds)
          .in("status", ["active", "retrying", "open"]);
        const chargeSet = new Set<string>([
          ...reactivatedIds,
          ...(openCycles || []).map((c) => c.subscription_id as string).filter(Boolean),
        ]);
        // Only charge subs that are now internal + active (migrated + reactivated).
        const chargeIds = subIds.filter((id) => chargeSet.has(id)).concat(
          reactivatedIds.filter((id) => !subIds.includes(id)),
        );
        if (chargeIds.length) {
          const { inngest } = await import("@/lib/inngest/client");
          for (const subscription_id of [...new Set(chargeIds)]) {
            await inngest.send({
              name: "internal-subscription/renewal-attempt",
              data: { workspace_id: auth.workspaceId, subscription_id },
            });
          }
          chargedCount = new Set(chargeIds).size;
        }
      } catch (e) {
        console.error("[portal/payment] recover immediate-charge failed (non-fatal):", e instanceof Error ? e.message : e);
      }
    } catch (e) {
      console.error("[portal/payment] recover pin failed (non-fatal):", e instanceof Error ? e.message : e);
    }
    try {
      const { notifyPaymentRecovered } = await import("@/lib/notify-payment-recovered");
      await notifyPaymentRecovered(auth.workspaceId, {
        customerName: [customer.first_name, customer.last_name].filter(Boolean).join(" "),
        email: customer.email || "",
        brand: vaulted.cardBrand,
        last4: vaulted.last4,
        migratedCount,
        pinnedCount,
        reactivatedCount,
      });
    } catch (e) {
      console.error("[portal/payment] recover Slack notify failed (non-fatal):", e instanceof Error ? e.message : e);
    }
  }

  await logPortalAction({
    workspaceId: auth.workspaceId,
    customerId: customer.id,
    eventType: recover ? "portal.payment_method.recovered" : "portal.payment_method.updated",
    summary: `Customer ${recover ? "recovered" : "updated"} payment method via portal${migratedCount ? ` (migrated ${migratedCount} sub(s) to internal)` : ""}${pinnedCount ? ` (pinned to ${pinnedCount} sub(s))` : ""}${reactivatedCount ? ` (reactivated ${reactivatedCount} dunning-cancelled sub(s))` : ""}${chargedCount ? ` (charged ${chargedCount} sub(s) now)` : ""}`,
    properties: { last4: vaulted.last4, card_brand: vaulted.cardBrand, migrated_count: migratedCount, pinned_count: pinnedCount, reactivated_count: reactivatedCount, charged_count: chargedCount, recover },
    createNote: false,
  });

  return jsonOk({ ok: true, route, migrated_count: migratedCount, pinned_count: pinnedCount, payment_method_id: saved.id, patch: { paymentMethod: { last4: vaulted.last4, cardBrand: vaulted.cardBrand } } });
};
