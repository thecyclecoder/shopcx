// seed-spec-test-fixtures — idempotent seed for the spec-test SANDBOX fixtures
// (spec-test-deep-verification Phase 2). GATED: this WRITES prod (the service-role admin), so it runs
// ONLY on the owner's approval (the box worker has no creds otherwise). Re-runnable — every write is an
// upsert on a stable fixture id, so a second run is a no-op that also RESETS the fixtures to baseline.
//
//   npx tsx scripts/seed-spec-test-fixtures.ts
//
// What it creates, all under the ONE `is_test` workspace (SPEC_TEST_FIXTURES.workspaceId), isolated from
// real data and carrying NO external credentials (so no Amplifier/Braintree/etc. call can ever fire):
//   - the is_test workspace (is_test=true)
//   - the owner as an `owner` workspace_member (so owner-gated endpoints pass when scoped here)
//   - a comp customer with comp_role=NULL → drives the comp-renewal FAIL-CLOSED (internal-only) branch
//   - a comp subscription (comp=true, is_internal=true, active)
//   - a test ticket + a test migration_audit row
//
// Prereq: the workspaces.is_test column must exist (scripts/apply-workspaces-is-test-migration.ts).
import { createAdminClient } from "./_bootstrap";
import { SPEC_TEST_FIXTURES, resolveOwnerUserId } from "../src/lib/spec-test-sandbox";

const F = SPEC_TEST_FIXTURES;

async function main() {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  // ── 1. The is_test workspace (no external creds — every *_encrypted column left null) ──────────────
  {
    const { error } = await admin.from("workspaces").upsert(
      {
        id: F.workspaceId,
        name: F.workspaceName,
        is_test: true,
        sandbox_mode: true,
        plan: "free",
      },
      { onConflict: "id" },
    );
    if (error) throw new Error(`workspace upsert failed: ${error.message}`);
    // Belt-and-suspenders: force is_test=true even if the row pre-existed as a non-test workspace.
    await admin.from("workspaces").update({ is_test: true }).eq("id", F.workspaceId);
    console.log(`✓ workspace ${F.workspaceId} (is_test=true)`);
  }

  // ── 2. Owner membership (owner-gated endpoints check workspace_members.role='owner') ──────────────
  {
    const ownerUserId = await resolveOwnerUserId();
    if (!ownerUserId) {
      console.warn(`⚠ could not resolve owner user id for ${F.ownerEmail} — skipping membership (owner-gated POST flows will 403)`);
    } else {
      const { data: existing } = await admin
        .from("workspace_members")
        .select("id, role")
        .eq("workspace_id", F.workspaceId)
        .eq("user_id", ownerUserId)
        .maybeSingle();
      if (existing) {
        if (existing.role !== "owner") {
          await admin.from("workspace_members").update({ role: "owner" }).eq("id", existing.id);
        }
        console.log(`✓ owner membership (existing)`);
      } else {
        const { error } = await admin.from("workspace_members").insert({
          workspace_id: F.workspaceId,
          user_id: ownerUserId,
          role: "owner",
          display_name: "Spec-Test Owner",
        });
        if (error) throw new Error(`owner membership insert failed: ${error.message}`);
        console.log(`✓ owner membership (created)`);
      }
    }
  }

  // ── 3. Comp customer — comp_role NULL → fail-closed branch ────────────────────────────────────────
  {
    const { error } = await admin.from("customers").upsert(
      {
        id: F.customerFailClosedId,
        workspace_id: F.workspaceId,
        email: F.customerFailClosedEmail,
        first_name: "SpecTest",
        last_name: "FailClosed",
        is_internal: true,
        comp_role: null, // the gate the comp renewal fails closed on
        subscription_status: "active",
        updated_at: now,
      },
      { onConflict: "id" },
    );
    if (error) throw new Error(`customer upsert failed: ${error.message}`);
    // Reset to baseline (clear comp_role in case a prior happy-path experiment set it).
    await admin.from("customers").update({ comp_role: null }).eq("id", F.customerFailClosedId);
    console.log(`✓ comp customer ${F.customerFailClosedId} (comp_role=null)`);
  }

  // ── 4. Comp subscription (comp=true, is_internal=true, active) ────────────────────────────────────
  {
    const nextBilling = new Date();
    nextBilling.setUTCHours(0, 0, 0, 0); // due today — and we assert it is NOT advanced on fail-closed
    const { error } = await admin.from("subscriptions").upsert(
      {
        id: F.subscriptionCompId,
        workspace_id: F.workspaceId,
        customer_id: F.customerFailClosedId,
        shopify_contract_id: "internal-spectest-comp",
        status: "active",
        is_internal: true,
        comp: true,
        comp_note: "spec-test sandbox fixture",
        billing_interval: "day",
        billing_interval_count: 30,
        next_billing_date: nextBilling.toISOString(),
        items: [
          {
            variant_id: F.subscriptionCompId, // a sentinel ref; the fail-closed branch never resolves pricing
            product_id: F.subscriptionCompId,
            title: "Spec-Test Comp Product",
            quantity: 1,
            line_id: "spectest-line-1",
            price_override_cents: 0,
          },
        ],
        updated_at: now,
      },
      { onConflict: "id" },
    );
    if (error) throw new Error(`subscription upsert failed: ${error.message}`);
    // Reset billing baseline so the "not advanced" assertion is meaningful across re-runs.
    await admin
      .from("subscriptions")
      .update({ status: "active", comp: true, next_billing_date: nextBilling.toISOString() })
      .eq("id", F.subscriptionCompId);
    console.log(`✓ comp subscription ${F.subscriptionCompId}`);
  }

  // ── 5. Test ticket ───────────────────────────────────────────────────────────────────────────────
  {
    const { error } = await admin.from("tickets").upsert(
      {
        id: F.ticketId,
        workspace_id: F.workspaceId,
        customer_id: F.customerFailClosedId,
        channel: "email",
        status: "open",
        subject: "Spec-test sandbox fixture ticket",
        updated_at: now,
      },
      { onConflict: "id" },
    );
    if (error) throw new Error(`ticket upsert failed: ${error.message}`);
    console.log(`✓ ticket ${F.ticketId}`);
  }

  // ── 6. Test migration_audit ─────────────────────────────────────────────────────────────────────
  {
    const { error } = await admin.from("migration_audits").upsert(
      {
        id: F.migrationAuditId,
        workspace_id: F.workspaceId,
        subscription_id: F.subscriptionCompId,
        internal_contract_id: "internal-spectest-comp",
        status: "passed",
        checks: [{ key: "is_internal", ok: true, detail: "fixture" }],
        updated_at: now,
      },
      { onConflict: "id" },
    );
    if (error) throw new Error(`migration_audit upsert failed: ${error.message}`);
    console.log(`✓ migration_audit ${F.migrationAuditId}`);
  }

  console.log("\n✓ spec-test fixtures seeded (idempotent). is_test workspace:", F.workspaceId);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
