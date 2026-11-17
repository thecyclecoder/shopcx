import type { RouteHandler } from "@/lib/portal/types";
import { errText } from "@/lib/error-text";
import { jsonOk, jsonErr, findCustomer, logPortalAction, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { vaultAndMigratePaymentMethod } from "@/lib/vault-and-migrate-payment-method";
import { VaultCreateError } from "@/lib/integrations/braintree-customer";

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
    // Full lossless diagnostic stays in the server log; the public body carries the stable
    // error code only (Fix 1 of lossless-error-diagnostics-no-object-object — errText's
    // PostgREST code/details/hint output would leak DB internals to a customer-authenticated
    // portal caller). `no_braintree_customer` is a stable throw-key from the vault helper — a
    // control-flow signal — so it is safe to surface as an error code.
    //
    // Vault classification (spec-classify-portal-vault-failed-card-declines-...):
    // `vaultPaymentMethod` throws a typed [[../../integrations/braintree-customer:VaultCreateError]]
    // carrying `code='vault_declined'` on a processor decline / gateway rejection
    // (the customer's own issuer or the merchant's Braintree risk rule said no)
    // and `code='vault_error'` on anything else (SDK broken, connectivity,
    // misconfig). A DECLINE is a customer-fixable soft error — return HTTP 400
    // with `error: 'vault_declined'` + a plain-language customer `message`
    // (the raw processor text may include PCI-adjacent surface text; we surface
    // our own guidance instead). [[portal__route]]'s VALIDATION_ERRORS set
    // (which now includes `vault_declined`) stops the "portal action needs
    // help" ticket from spawning at all, and [[portal__remediation]]'s
    // dismiss branch is the belt-and-suspenders backstop for anything that
    // reaches classification via another path.
    //
    // A genuine gateway/config `vault_error` keeps returning HTTP 502
    // `{ error: 'vault_failed' }` (unchanged) so real Braintree outages still
    // surface on the human/monitor path — `[portal/payment-method-update] vault
    // failed:` is the exact log prefix that [[../control-tower/error-feed]]'s
    // marker-based decline / rejection drop filters key off, so the log line
    // stays intact regardless of classification.
    const msg = errText(e);
    console.error(`[portal/payment-method-update] vault failed: ${msg}`);
    if (msg === "no_braintree_customer") return jsonErr({ error: "no_braintree_customer" }, 400);
    if (e instanceof VaultCreateError && e.code === "vault_declined") {
      return jsonErr(
        {
          error: "vault_declined",
          message: "That card was declined. Please check the number, expiry, and CVV, or try another card.",
        },
        400,
      );
    }
    return jsonErr({ error: "vault_failed" }, 502);
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
    // Shared with the add_payment_method journey (src/lib/payment-recovery.ts) so a card fixed
    // on either surface recovers the subscription the same way.
    const { runPaymentRecovery } = await import("@/lib/payment-recovery");
    const r = await runPaymentRecovery({
      workspaceId: auth.workspaceId,
      customer: { id: customer.id, email: customer.email || "", first_name: customer.first_name as string | null, last_name: customer.last_name as string | null },
      paymentMethodId: saved.id,
      cardBrand: vaulted.cardBrand,
      last4: vaulted.last4,
      migratedCount,
      notify: "always",
      logPrefix: "[portal/payment]",
    });
    pinnedCount = r.pinnedCount;
    reactivatedCount = r.reactivatedCount;
    chargedCount = r.chargedCount;
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
