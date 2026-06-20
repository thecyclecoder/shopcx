/**
 * First real comp subscription — Zach Zavala (employee).
 *
 * 1. Allowlist him: customers.comp_role='employee', comp_note='employee'.
 * 2. Migrate his Appstle contract 27852472493 → internal COMP sub (base $0),
 *    preserving items/cadence/next date (via migrateContractToInternalComp —
 *    no billable-PM requirement). His SC133080 charge is already refunded.
 *
 * Gated prod write. Run: npx tsx scripts/migrate-zach-comp-subscription.ts
 * See docs/brain/specs/comp-subscriptions.md.
 */
import { createAdminClient } from "./_bootstrap";
import { migrateContractToInternalComp } from "../src/lib/migrate-to-internal";

const EMAIL = "zachary@superfoodscompany.com";
const CONTRACT_ID = "27852472493";

async function main() {
  const admin = createAdminClient();

  // Resolve Zach by email (ILIKE — the case-insensitive match key).
  const { data: customer } = await admin
    .from("customers")
    .select("id, workspace_id, email, first_name, last_name, comp_role")
    .ilike("email", EMAIL)
    .maybeSingle();
  if (!customer) throw new Error(`customer not found for ${EMAIL}`);
  const workspaceId = customer.workspace_id as string;
  console.log(`Customer ${customer.first_name} ${customer.last_name} <${customer.email}> (${customer.id}) in ws ${workspaceId}`);

  // 1. Allowlist (owner-gated action): set the comp role.
  const { error: roleErr } = await admin
    .from("customers")
    .update({ comp_role: "employee", comp_note: "employee", updated_at: new Date().toISOString() })
    .eq("id", customer.id);
  if (roleErr) throw new Error(`comp_role update failed: ${roleErr.message}`);
  console.log("✓ comp_role=employee set");

  // Sanity: the contract belongs to this customer (and isn't already migrated).
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, customer_id, is_internal, comp, status, shopify_contract_id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", CONTRACT_ID)
    .maybeSingle();
  if (!sub) throw new Error(`subscription not found for contract ${CONTRACT_ID}`);
  console.log(`Sub ${sub.id} — is_internal=${sub.is_internal} comp=${sub.comp} status=${sub.status}`);

  // 2. Migrate Appstle → internal comp.
  const res = await migrateContractToInternalComp(workspaceId, CONTRACT_ID, { compNote: "employee" });
  if (!res.ok) throw new Error(`comp migration failed: ${res.error}`);
  console.log(`✓ Migrated → internal comp sub ${res.subId} (${res.internalContractId})`);

  // Verify final state.
  const { data: after } = await admin
    .from("subscriptions")
    .select("id, is_internal, comp, comp_note, status, next_billing_date, items, billing_interval, billing_interval_count, shopify_contract_id")
    .eq("id", res.subId!)
    .single();
  console.log("Final sub state:", JSON.stringify(after, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
