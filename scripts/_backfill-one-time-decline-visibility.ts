/**
 * Ship-time backfill: one-time-charge declines recorded before they were made visible.
 *
 * `failed` rows in `one_time_charges` created before 2026-09-15 landed only on their own row —
 * not on `payment_failures` (decline analytics) or `customer_events` (the timeline agents read).
 * Idempotent: skips any charge already present in payment_failures.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();

async function main() {
  const admin = (await import("../src/lib/supabase/admin")).createAdminClient();
  const { data: failed } = await admin
    .from("one_time_charges")
    .select("id, workspace_id, customer_id, shopify_contract_id, payment_method_id, amount_cents, error, reason, created_by, failed_at, billing_attempt_id, rail")
    .eq("status", "failed");
  console.log(`failed one-time charges: ${failed?.length ?? 0}`);

  for (const r of failed ?? []) {
    const key = (r.shopify_contract_id as string | null) ?? `one-time:${r.id}`;
    const { count } = await admin.from("payment_failures")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", r.workspace_id).eq("shopify_contract_id", key).eq("attempt_type", "one_time");
    if (count) { console.log(`  ${r.id} already recorded — skip`); continue; }

    const { error: pfErr } = await admin.from("payment_failures").insert({
      workspace_id: r.workspace_id, customer_id: r.customer_id, subscription_id: null,
      shopify_contract_id: key, billing_attempt_id: r.billing_attempt_id ?? null,
      payment_method_id: r.payment_method_id ?? null, payment_method_last4: null,
      error_code: null, error_message: String(r.error ?? "declined"),
      attempt_number: 1, attempt_type: "one_time", succeeded: false, result: "failed",
      created_at: r.failed_at ?? new Date().toISOString(),
    });
    if (pfErr) { console.error(`  ${r.id} payment_failures insert failed: ${pfErr.message}`); continue; }

    const { logCustomerEvent } = await import("../src/lib/customer-events");
    const amount = r.amount_cents ? `$${((r.amount_cents as number) / 100).toFixed(2)}` : "a one-time charge";
    await logCustomerEvent({
      workspaceId: String(r.workspace_id), customerId: String(r.customer_id),
      eventType: "one_time_charge.declined", source: "commerce",
      summary: `One-time charge of ${amount} was declined — ${String(r.error ?? "declined")}`,
      properties: {
        one_time_charge_id: r.id, rail: r.rail ?? null, error_message: r.error ?? null,
        amount_cents: r.amount_cents ?? null, reason: r.reason ?? null, requested_by: r.created_by ?? null,
        backfilled: true,
      },
    });
    console.log(`  ${r.id} recorded (${amount})`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
