// seed-spec-test-fixtures — idempotent seed for the spec-test SANDBOX fixtures
// (spec-test-deep-verification Phase 2). GATED: this WRITES prod (the service-role admin), so it runs
// ONLY on the owner's approval (the box worker has no creds otherwise). Re-runnable — every write is an
// upsert on a stable fixture id, so a second run is a no-op that also RESETS the fixtures to baseline.
//
//   npx tsx scripts/seed-spec-test-fixtures.ts
//
// What it creates, all under the ONE `is_test` workspace (SPEC_TEST_FIXTURES.workspaceId), isolated from
// real data and carrying NO external credentials (so no Amplifier/Braintree/etc. call can ever fire):
//   CORE (required — the wired sandbox flows need these):
//     - the is_test workspace (is_test=true)
//     - a comp customer with comp_role=NULL → drives the comp-renewal FAIL-CLOSED (internal-only) branch
//     - a comp subscription (comp=true, is_internal=true, active)
//   OPTIONAL (best-effort — auxiliary fixtures for future bullets; a failure here only WARNS):
//     - the owner as an `owner` workspace_member (so owner-gated POST flows pass when scoped here)
//     - a test ticket + a test migration_audit row
//
// Every step prints the precise Postgres error (message/code/details/hint) on failure so a re-run is
// diagnostic. Prereq: the workspaces.is_test column must exist
// (scripts/apply-workspaces-is-test-migration.ts).
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";
import { SPEC_TEST_FIXTURES, resolveOwnerUserId } from "../src/lib/spec-test-sandbox";

const F = SPEC_TEST_FIXTURES;

type PgErr = { message?: string; code?: string; details?: string; hint?: string } | null;
function fmtErr(e: PgErr | unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const x = e as Record<string, unknown>;
    return [x.message, x.code && `code=${x.code}`, x.details && `details=${x.details}`, x.hint && `hint=${x.hint}`]
      .filter(Boolean)
      .join(" · ");
  }
  return errText(e);
}

async function main() {
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const coreFailures: string[] = [];
  const optionalFailures: string[] = [];

  // Run a labeled step; `core` failures are collected and re-thrown at the end, optional ones only warn.
  async function step(label: string, core: boolean, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      console.log(`✓ ${label}`);
    } catch (e) {
      const msg = `✗ ${label}: ${fmtErr(e)}`;
      if (core) { console.error(msg); coreFailures.push(msg); }
      else { console.warn(`⚠ ${label} (optional, skipped): ${fmtErr(e)}`); optionalFailures.push(msg); }
    }
  }

  // ── 1. CORE: the is_test workspace (no external creds — every *_encrypted column left null) ─────────
  await step(`workspace ${F.workspaceId} (is_test=true)`, true, async () => {
    const { error } = await admin.from("workspaces").upsert(
      { id: F.workspaceId, name: F.workspaceName, is_test: true, sandbox_mode: true },
      { onConflict: "id" },
    );
    if (error) throw error;
    // Belt-and-suspenders: force is_test=true even if the row pre-existed as a non-test workspace.
    const { error: upErr } = await admin.from("workspaces").update({ is_test: true }).eq("id", F.workspaceId);
    if (upErr) throw upErr;
  });

  // ── 2. CORE: comp customer — comp_role NULL → fail-closed branch ────────────────────────────────────
  await step(`comp customer ${F.customerFailClosedId} (comp_role=null)`, true, async () => {
    const { error } = await admin.from("customers").upsert(
      {
        id: F.customerFailClosedId,
        workspace_id: F.workspaceId,
        email: F.customerFailClosedEmail,
        first_name: "SpecTest",
        last_name: "FailClosed",
        is_internal: true,
        comp_role: null, // the gate the comp renewal fails closed on
        updated_at: now,
      },
      { onConflict: "id" },
    );
    if (error) throw error;
    // Reset to baseline (clear comp_role in case a prior happy-path experiment set it).
    const { error: upErr } = await admin.from("customers").update({ comp_role: null }).eq("id", F.customerFailClosedId);
    if (upErr) throw upErr;
  });

  // ── 3. CORE: comp subscription (comp=true, is_internal=true, active) ────────────────────────────────
  const nextBilling = new Date();
  nextBilling.setUTCHours(0, 0, 0, 0); // due today — and we assert it is NOT advanced on fail-closed
  await step(`comp subscription ${F.subscriptionCompId}`, true, async () => {
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
            variant_id: F.subscriptionCompId, // sentinel ref; the fail-closed branch never resolves pricing
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
    if (error) throw error;
    // Reset billing baseline so the "not advanced" assertion is meaningful across re-runs.
    const { error: upErr } = await admin
      .from("subscriptions")
      .update({ status: "active", comp: true, next_billing_date: nextBilling.toISOString() })
      .eq("id", F.subscriptionCompId);
    if (upErr) throw upErr;
  });

  // ── 4. OPTIONAL: owner membership (owner-gated endpoints check workspace_members.role='owner') ──────
  await step("owner membership", false, async () => {
    const ownerUserId = await resolveOwnerUserId();
    if (!ownerUserId) throw new Error(`could not resolve owner user id for ${F.ownerEmail}`);
    const { data: existing } = await admin
      .from("workspace_members")
      .select("id, role")
      .eq("workspace_id", F.workspaceId)
      .eq("user_id", ownerUserId)
      .maybeSingle();
    if (existing) {
      if (existing.role !== "owner") {
        const { error } = await admin.from("workspace_members").update({ role: "owner" }).eq("id", existing.id);
        if (error) throw error;
      }
      return;
    }
    const { error } = await admin.from("workspace_members").insert({
      workspace_id: F.workspaceId,
      user_id: ownerUserId,
      role: "owner",
      display_name: "Spec-Test Owner",
    });
    if (error) throw error;
  });

  // ── 5. OPTIONAL: test ticket ────────────────────────────────────────────────────────────────────────
  await step(`ticket ${F.ticketId}`, false, async () => {
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
    if (error) throw error;
  });

  // ── 6. OPTIONAL: test migration_audit ──────────────────────────────────────────────────────────────
  await step(`migration_audit ${F.migrationAuditId}`, false, async () => {
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
    if (error) throw error;
  });

  if (coreFailures.length) {
    console.error(`\n✗ CORE fixtures failed — sandbox cannot run:\n${coreFailures.join("\n")}`);
    process.exit(1);
  }
  console.log(`\n✓ spec-test CORE fixtures seeded (idempotent). is_test workspace: ${F.workspaceId}`);
  if (optionalFailures.length) {
    console.log(`(note: ${optionalFailures.length} optional fixture(s) skipped — see warnings above; the wired sandbox flows still work)`);
  }
}

main().catch((e) => {
  console.error(fmtErr(e));
  process.exit(1);
});
